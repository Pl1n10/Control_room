#!/bin/bash
###############################################################################
# nbu_morningcheck.sh — NetBackup Master Server Morning Check
# Output: key=value (one per line), parseable by dashboard tool
# Dependencies: NONE (pure bash + standard NBU binaries)
# Usage: ./nbu_morningcheck.sh > /tmp/morningcheck_$(hostname)_$(date +%Y%m%d_%H%M).txt
#
# Roberto Novara — Mauden S.r.L.
###############################################################################

set -o pipefail

# --- Config ---
NBU_BIN="/usr/openv/netbackup/bin"
NBU_ADM="${NBU_BIN}/admincmd"
HOURS_BACK=24
DAYS_BACK=3

# --- Header ---
echo "REPORT_VERSION=2"
echo "MASTER_HOSTNAME=$(hostname -s)"
echo "MASTER_FQDN=$(hostname -f 2>/dev/null || hostname)"
echo "TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S%z')"
echo "TIMESTAMP_EPOCH=$(date +%s)"
echo "NBU_VERSION=$(cat /usr/openv/netbackup/bin/version 2>/dev/null | head -1 || echo UNKNOWN)"
echo "OS_RELEASE=$(cat /etc/redhat-release 2>/dev/null || uname -sr)"

# =============================================================================
# CHECK 1: Failed / Partial jobs last 24h
# =============================================================================
echo "---SECTION=FAILED_JOBS---"

# bperror -backstat gives us job status summary
_bperror_out=$("${NBU_ADM}/bperror" -backstat -hoursago ${HOURS_BACK} -all 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$_bperror_out" ]; then
    echo "FAILED_JOBS_STATUS=ERROR"
    echo "FAILED_JOBS_MSG=bperror command failed or returned empty"
else
    _total_lines=$(echo "$_bperror_out" | grep -cv "^$")

    # bperror -backstat -all format:
    # timestamp  type  subtype  severity  server  jobid  0  0  client  message
    # $1         $2    $3       $4        $5      $6 ...
    #
    # Severity field ($4): 0=success, 2-4=info, 8=warning, 16+=error
    # JobID field ($6): 0 = system/daemon event, >0 = actual backup job
    #
    # We split errors into:
    #   - Backup failures: severity >= 16 AND jobid > 0 (real job that failed)
    #   - System errors:   severity >= 16 AND jobid == 0 (nbpem CORBA, EMM errors, etc.)

    _sev_success=$(echo "$_bperror_out" | awk '$4 == 0' | grep -cv "^$")
    _sev_info=$(echo "$_bperror_out" | awk '$4 > 0 && $4 <= 4' | grep -cv "^$")
    _sev_warning=$(echo "$_bperror_out" | awk '$4 == 8' | grep -cv "^$")
    _sev_error_total=$(echo "$_bperror_out" | awk '$4 >= 16' | grep -cv "^$")

    # Split errors by jobid
    _backup_failures=$(echo "$_bperror_out" | awk '$4 >= 16 && $6 > 0' | grep -cv "^$")
    _system_errors=$(echo "$_bperror_out" | awk '$4 >= 16 && $6 == 0' | grep -cv "^$")

    echo "FAILED_JOBS_STATUS=OK"
    echo "FAILED_JOBS_TOTAL=${_total_lines}"
    echo "FAILED_JOBS_SUCCESS=${_sev_success}"
    echo "FAILED_JOBS_INFO=${_sev_info}"
    echo "FAILED_JOBS_WARNING=${_sev_warning}"
    echo "FAILED_JOBS_FAILED=${_backup_failures}"
    echo "FAILED_JOBS_SYSTEM_ERRORS=${_system_errors}"

    # Top 5 backup failure details (severity >= 16, jobid > 0)
    _detail_count=0
    echo "$_bperror_out" | awk '$4 >= 16 && $6 > 0' | head -5 | while IFS= read -r _line; do
        _detail_count=$(( _detail_count + 1 ))
        echo "FAILED_JOB_DETAIL_${_detail_count}=${_line}"
    done

    # Top 3 system error details (severity >= 16, jobid == 0) — deduplicated by message
    _sys_count=0
    echo "$_bperror_out" | awk '$4 >= 16 && $6 == 0' | awk '{$1=""; print}' | sort -u | head -3 | while IFS= read -r _line; do
        _sys_count=$(( _sys_count + 1 ))
        echo "SYSTEM_ERROR_DETAIL_${_sys_count}=${_line}"
    done
fi

# =============================================================================
# CHECK 2: Hung jobs (active > 24h or queued > 6h)
# =============================================================================
echo "---SECTION=HUNG_JOBS---"

_now=$(date +%s)
_hung_count=0
_hung_details=""

# bpdbjobs: col 3 = state (1=active), col 8 = start time (unix)
# Note: on NBU 10.4 bpdbjobs -report -most_columns works
_jobs_out=$("${NBU_ADM}/bpdbjobs" -report -most_columns 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "HUNG_JOBS_STATUS=ERROR"
    echo "HUNG_JOBS_MSG=bpdbjobs command failed"
else
    # Active jobs (state=1) — check if running > 24h
    while IFS=',' read -r _jobid _jobtype _state _status _policy _schedule _client _starttime _rest; do
        # Skip header or empty
        [ -z "$_jobid" ] && continue
        echo "$_jobid" | grep -q "^[0-9]" || continue

        if [ "$_state" = "1" ] && [ -n "$_starttime" ] && [ "$_starttime" -gt 0 ] 2>/dev/null; then
            _elapsed=$(( _now - _starttime ))
            _hours=$(( _elapsed / 3600 ))
            if [ "$_hours" -ge 24 ]; then
                _hung_count=$(( _hung_count + 1 ))
                echo "HUNG_JOB_${_hung_count}=jobid=${_jobid}|policy=${_policy}|client=${_client}|hours=${_hours}"
            fi
        fi

        # Queued jobs (state=0) running > 6h
        if [ "$_state" = "0" ] && [ -n "$_starttime" ] && [ "$_starttime" -gt 0 ] 2>/dev/null; then
            _elapsed=$(( _now - _starttime ))
            _hours=$(( _elapsed / 3600 ))
            if [ "$_hours" -ge 6 ]; then
                _hung_count=$(( _hung_count + 1 ))
                echo "HUNG_JOB_${_hung_count}=jobid=${_jobid}|policy=${_policy}|client=${_client}|hours=${_hours}|queued=true"
            fi
        fi
    done <<< "$_jobs_out"

    echo "HUNG_JOBS_STATUS=OK"
    echo "HUNG_JOBS_COUNT=${_hung_count}"
fi

# =============================================================================
# CHECK 3: Disk pool & storage unit capacity
# =============================================================================
echo "---SECTION=DISK_POOLS---"

_dp_count=0
_dp_warn=0
_dp_crit=0

# nbdevquery -listdp -dp shows disk pools; -stype gives type
_dp_list=$("${NBU_ADM}/nbdevquery" -listdp -U 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "DISK_POOLS_STATUS=ERROR"
    echo "DISK_POOLS_MSG=nbdevquery command failed"
else
    # Parse disk pool names
    _dp_names=$(echo "$_dp_list" | grep "^Disk Pool Name" | sed 's/Disk Pool Name *: *//')

    if [ -z "$_dp_names" ]; then
        echo "DISK_POOLS_STATUS=OK"
        echo "DISK_POOLS_COUNT=0"
        echo "DISK_POOLS_MSG=No disk pools found"
    else
        while IFS= read -r _dpname; do
            [ -z "$_dpname" ] && continue
            _dp_count=$(( _dp_count + 1 ))

            # Get detail for this pool
            _dp_detail=$("${NBU_ADM}/nbdevquery" -listdp -dp "$_dpname" -U 2>/dev/null)
            _total_cap=$(echo "$_dp_detail" | grep "Total Capacity" | head -1 | awk '{print $(NF-1)}')
            _free_cap=$(echo "$_dp_detail" | grep "Free Space" | head -1 | awk '{print $(NF-1)}')
            _used_pct=$(echo "$_dp_detail" | grep "Use%" | head -1 | awk '{print $NF}' | tr -d '%')

            # Fallback: calculate if Use% not available
            if [ -z "$_used_pct" ] && [ -n "$_total_cap" ] && [ -n "$_free_cap" ]; then
                if [ "$_total_cap" -gt 0 ] 2>/dev/null; then
                    _used=$(( _total_cap - _free_cap ))
                    _used_pct=$(( _used * 100 / _total_cap ))
                fi
            fi

            _severity="OK"
            if [ -n "$_used_pct" ]; then
                [ "$_used_pct" -ge 80 ] && _severity="WARNING" && _dp_warn=$(( _dp_warn + 1 ))
                [ "$_used_pct" -ge 95 ] && _severity="CRITICAL" && _dp_crit=$(( _dp_crit + 1 )) && _dp_warn=$(( _dp_warn - 1 ))
            fi

            echo "DISK_POOL_${_dp_count}_NAME=${_dpname}"
            echo "DISK_POOL_${_dp_count}_TOTAL_GB=${_total_cap:-UNKNOWN}"
            echo "DISK_POOL_${_dp_count}_FREE_GB=${_free_cap:-UNKNOWN}"
            echo "DISK_POOL_${_dp_count}_USED_PCT=${_used_pct:-UNKNOWN}"
            echo "DISK_POOL_${_dp_count}_SEVERITY=${_severity}"
        done <<< "$_dp_names"

        echo "DISK_POOLS_STATUS=OK"
        echo "DISK_POOLS_COUNT=${_dp_count}"
        echo "DISK_POOLS_WARNING=${_dp_warn}"
        echo "DISK_POOLS_CRITICAL=${_dp_crit}"
    fi
fi

# =============================================================================
# CHECK 4: Media server connectivity
# =============================================================================
echo "---SECTION=MEDIA_SERVERS---"

_ms_count=0
_ms_down=0

# Use non-parsable format — much cleaner: "media  hostname" / "ndmp  hostname"
_ms_raw=$("${NBU_ADM}/nbemmcmd" -listhosts -machinetype media 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$_ms_raw" ]; then
    # Fallback: bpgetconfig
    _ms_raw=$("${NBU_ADM}/bpgetconfig" -M 2>/dev/null)
    _ms_hosts=$(echo "$_ms_raw" | awk '/^SERVER/{print "media " $3}' | sort -u)
else
    # Extract "type hostname" pairs, skip header lines
    _ms_hosts=$(echo "$_ms_raw" | awk '/^(media|ndmp|server|cluster)/{print $1, $2}' | sort -u)
fi

if [ -z "$_ms_hosts" ]; then
    echo "MEDIA_SERVERS_STATUS=ERROR"
    echo "MEDIA_SERVERS_MSG=Cannot enumerate media servers"
else
    while IFS= read -r _line; do
        [ -z "$_line" ] && continue
        _type=$(echo "$_line" | awk '{print $1}')
        _ms=$(echo "$_line" | awk '{print $2}')
        [ -z "$_ms" ] && continue

        _ms_count=$(( _ms_count + 1 ))

        if [ "$_type" = "ndmp" ]; then
            # NDMP hosts are storage appliances (Data Domain, NAS) — skip bptestbpcd
            echo "MEDIA_SERVER_${_ms_count}_NAME=${_ms}"
            echo "MEDIA_SERVER_${_ms_count}_STATUS=SKIP_NDMP"
            echo "MEDIA_SERVER_${_ms_count}_TYPE=NDMP"
        elif [ "$_type" = "server" ] || [ "$_type" = "cluster" ]; then
            # Master/cluster — skip, it's ourselves
            echo "MEDIA_SERVER_${_ms_count}_NAME=${_ms}"
            echo "MEDIA_SERVER_${_ms_count}_STATUS=SKIP_MASTER"
            echo "MEDIA_SERVER_${_ms_count}_TYPE=${_type}"
        else
            # Real media server — test connectivity
            _test_result="UNKNOWN"
            timeout 5 "${NBU_BIN}/bptestbpcd" -client "$_ms" > /dev/null 2>&1
            _rc=$?
            if [ $_rc -eq 0 ]; then
                _test_result="UP"
            else
                _test_result="DOWN"
                _ms_down=$(( _ms_down + 1 ))
            fi

            echo "MEDIA_SERVER_${_ms_count}_NAME=${_ms}"
            echo "MEDIA_SERVER_${_ms_count}_STATUS=${_test_result}"
            echo "MEDIA_SERVER_${_ms_count}_TYPE=media"
        fi
    done <<< "$_ms_hosts"

    echo "MEDIA_SERVERS_STATUS=OK"
    echo "MEDIA_SERVERS_COUNT=${_ms_count}"
    echo "MEDIA_SERVERS_DOWN=${_ms_down}"
fi

# =============================================================================
# CHECK 5: Certificate expiry
# =============================================================================
echo "---SECTION=CERTIFICATES---"

_cert_warn=0
_cert_crit=0
_cert_count=0
_warn_days=30
_crit_days=7

# nbcertcmd -listCertDetails gives cert info
_cert_out=$("${NBU_BIN}/nbcertcmd" -listCertDetails 2>/dev/null)

if [ $? -ne 0 ]; then
    # Try alternative
    _cert_out=$("${NBU_BIN}/nbcertcmd" -getCertificate -detail 2>/dev/null)
fi

if [ -z "$_cert_out" ]; then
    echo "CERTIFICATES_STATUS=ERROR"
    echo "CERTIFICATES_MSG=Cannot retrieve certificate info"
else
    # Parse expiry dates — format varies, look for "Not After" or "Expiry"
    _expiry_lines=$(echo "$_cert_out" | grep -iE "not after|expiry|end date|valid to" | head -20)

    if [ -z "$_expiry_lines" ]; then
        # Try to get at least the host cert
        _host_cert_exp=$("${NBU_BIN}/nbcertcmd" -listCertDetails 2>/dev/null | grep -A2 "$(hostname)" | grep -iE "not after|expiry")
        if [ -n "$_host_cert_exp" ]; then
            _expiry_lines="$_host_cert_exp"
        else
            echo "CERTIFICATES_STATUS=OK"
            echo "CERTIFICATES_MSG=No expiry dates found in cert output"
            echo "CERTIFICATES_RAW=$(echo "$_cert_out" | head -5 | tr '\n' '|')"
        fi
    fi

    if [ -n "$_expiry_lines" ]; then
        while IFS= read -r _exp_line; do
            [ -z "$_exp_line" ] && continue
            _cert_count=$(( _cert_count + 1 ))

            # Try to extract date and convert to epoch
            _date_str=$(echo "$_exp_line" | sed 's/.*: *//' | sed 's/^ *//')
            _exp_epoch=$(date -d "$_date_str" +%s 2>/dev/null)

            if [ -n "$_exp_epoch" ]; then
                _days_left=$(( (_exp_epoch - _now) / 86400 ))
                _severity="OK"
                [ "$_days_left" -le "$_warn_days" ] && _severity="WARNING" && _cert_warn=$(( _cert_warn + 1 ))
                [ "$_days_left" -le "$_crit_days" ] && _severity="CRITICAL" && _cert_crit=$(( _cert_crit + 1 )) && _cert_warn=$(( _cert_warn - 1 ))
                [ "$_days_left" -le 0 ] && _severity="EXPIRED"

                echo "CERT_${_cert_count}_EXPIRY=${_date_str}"
                echo "CERT_${_cert_count}_DAYS_LEFT=${_days_left}"
                echo "CERT_${_cert_count}_SEVERITY=${_severity}"
            else
                echo "CERT_${_cert_count}_EXPIRY_RAW=${_exp_line}"
                echo "CERT_${_cert_count}_SEVERITY=UNKNOWN"
            fi
        done <<< "$_expiry_lines"

        echo "CERTIFICATES_STATUS=OK"
        echo "CERTIFICATES_COUNT=${_cert_count}"
        echo "CERTIFICATES_WARNING=${_cert_warn}"
        echo "CERTIFICATES_CRITICAL=${_cert_crit}"
    fi
fi

# =============================================================================
# CHECK 6: Vault / Tape status
# =============================================================================
echo "---SECTION=VAULT_TAPES---"

# Active media / scratch count
_media_out=$("${NBU_ADM}/vmquery" -a -bx 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "VAULT_TAPES_STATUS=NA"
    echo "VAULT_TAPES_MSG=No tape library configured (Data Domain only environment)"
else
    _total_media=$(echo "$_media_out" | grep -cv "^$\|^media\|^=")
    _scratch=$(echo "$_media_out" | awk '$NF ~ /[Ss]cratch/ || $4 == "---" {count++} END {print count+0}')
    _frozen=$(echo "$_media_out" | grep -ic "frozen")
    _suspended=$(echo "$_media_out" | grep -ic "suspended")
    _full=$(echo "$_media_out" | grep -ic "full")

    # Expired media
    _expired=0
    _exp_media=$("${NBU_ADM}/vmquery" -a -bx 2>/dev/null | awk '{print $6}' | grep -E "^[0-9]{2}/[0-9]{2}/[0-9]{4}$" | while read -r _edate; do
        _e_epoch=$(date -d "$_edate" +%s 2>/dev/null)
        [ -n "$_e_epoch" ] && [ "$_e_epoch" -lt "$_now" ] && echo "expired"
    done | wc -l)

    echo "VAULT_TAPES_STATUS=OK"
    echo "VAULT_TAPES_TOTAL=${_total_media}"
    echo "VAULT_TAPES_SCRATCH=${_scratch}"
    echo "VAULT_TAPES_FROZEN=${_frozen}"
    echo "VAULT_TAPES_SUSPENDED=${_suspended}"
    echo "VAULT_TAPES_FULL=${_full}"
    echo "VAULT_TAPES_EXPIRED=${_exp_media}"

    # Low scratch warning
    if [ "$_scratch" -lt 5 ] 2>/dev/null; then
        echo "VAULT_TAPES_SCRATCH_SEVERITY=CRITICAL"
    elif [ "$_scratch" -lt 20 ] 2>/dev/null; then
        echo "VAULT_TAPES_SCRATCH_SEVERITY=WARNING"
    else
        echo "VAULT_TAPES_SCRATCH_SEVERITY=OK"
    fi
fi

# =============================================================================
# CHECK 7 (bonus): NBU daemon health — from your incident context
# =============================================================================
echo "---SECTION=DAEMON_HEALTH---"

_daemons="nbemm nbpem bprd bpdbm bpjobd nbaudit vnetd nbjm nbrb"
_daemon_count=0
_daemon_down=0

for _d in $_daemons; do
    _pid=$(pgrep -x "$_d" 2>/dev/null | head -1)
    _daemon_count=$(( _daemon_count + 1 ))
    if [ -n "$_pid" ]; then
        _lstart=$(ps -p "$_pid" -o lstart= 2>/dev/null | xargs)
        echo "DAEMON_${_d}_STATUS=UP"
        echo "DAEMON_${_d}_PID=${_pid}"
        echo "DAEMON_${_d}_STARTED=${_lstart}"
    else
        echo "DAEMON_${_d}_STATUS=DOWN"
        _daemon_down=$(( _daemon_down + 1 ))
    fi
done

echo "DAEMON_HEALTH_STATUS=OK"
echo "DAEMON_HEALTH_TOTAL=${_daemon_count}"
echo "DAEMON_HEALTH_DOWN=${_daemon_down}"

# CLOSE-WAIT check (from your incident)
# nbinlinerwdetect CLOSE-WAIT on 1556 is KNOWN HARMLESS — only flag core daemons
_closewait_all=$( ss -tnp 2>/dev/null | grep 1556 | grep -i "close-wait" )
_closewait_total=$( echo "$_closewait_all" | grep -c "close-wait" 2>/dev/null )
[ -z "$_closewait_all" ] && _closewait_total=0
_closewait_harmless=$( echo "$_closewait_all" | grep -c "nbinlinerwdetec" 2>/dev/null )
[ -z "$_closewait_all" ] && _closewait_harmless=0
_closewait_dangerous=$(( _closewait_total - _closewait_harmless ))
[ "$_closewait_dangerous" -lt 0 ] && _closewait_dangerous=0

echo "CLOSEWAIT_1556_TOTAL=${_closewait_total}"
echo "CLOSEWAIT_1556_HARMLESS=${_closewait_harmless}"
echo "CLOSEWAIT_1556_COUNT=${_closewait_dangerous}"
if [ "$_closewait_dangerous" -gt 0 ]; then
    echo "CLOSEWAIT_1556_SEVERITY=CRITICAL"
    echo "CLOSEWAIT_1556_PROCS=$(echo "$_closewait_all" | grep -v "nbinlinerwdetec" | grep -oP 'users:\(\("\K[^"]+' | tr '\n' ',')"
else
    echo "CLOSEWAIT_1556_SEVERITY=OK"
fi

# System basics
echo "---SECTION=SYSTEM---"
echo "UPTIME=$(uptime -p 2>/dev/null || uptime)"
echo "LOAD_AVG=$(cat /proc/loadavg | awk '{print $1, $2, $3}')"
_mem_total=$(free -m | awk '/Mem:/{print $2}')
_mem_used=$(free -m | awk '/Mem:/{print $3}')
_mem_pct=$(( _mem_used * 100 / _mem_total ))
echo "MEMORY_TOTAL_MB=${_mem_total}"
echo "MEMORY_USED_MB=${_mem_used}"
echo "MEMORY_USED_PCT=${_mem_pct}"
_swap_total=$(free -m | awk '/Swap:/{print $2}')
_swap_used=$(free -m | awk '/Swap:/{print $3}')
echo "SWAP_TOTAL_MB=${_swap_total}"
echo "SWAP_USED_MB=${_swap_used}"

# Catalog disk usage
_catalog_pct=$(df /usr/openv/netbackup/db/ 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%')
_dbdata_pct=$(df /usr/openv/db/data/ 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%')
echo "CATALOG_DISK_USED_PCT=${_catalog_pct:-UNKNOWN}"
echo "DBDATA_DISK_USED_PCT=${_dbdata_pct:-UNKNOWN}"

echo "---END---"
