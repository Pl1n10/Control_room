#!/bin/bash
###############################################################################
# nbu_morningcheck_all.sh — Run morning check on all NBU masters from jump host
#
# Usage: ./nbu_morningcheck_all.sh
# Output: single file with all reports separated by ===MASTER_REPORT===
#
# Roberto Novara — Mauden S.r.L.
###############################################################################

# --- Master list ---
MASTERS=(
    "nbumaster02"
    "albmasterp01"
    "kopmasterp01"
    "rommasterp01"
    "vubmasterp01"
    "bibmaster"
    "cibmaster"
)

# --- Config ---
SSH_TIMEOUT=30
SCRIPT_PATH="/root/controlli.sh"
MASTER_TIMEOUT=300
OUTFILE="/tmp/nbu_morningcheck_all.txt"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

_total=${#MASTERS[@]}
_current=0
_success=0
_failed=0

echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║         NBU Control Room — Fleet Morning Check          ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
printf "  ║  %-54s  ║\n" "$(date '+%Y-%m-%d %H:%M:%S')"
printf "  ║  %-54s  ║\n" "Masters: ${_total}"
printf "  ║  %-54s  ║\n" "Output:  ${OUTFILE}"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""

> "$OUTFILE"

_fleet_start=$(date +%s)

for _master in "${MASTERS[@]}"; do
    _host=$(echo "$_master" | awk -F'@' '{print $NF}')
    _short=$(echo "$_host" | awk -F'.' '{print $1}')
    _current=$(( _current + 1 ))

    echo -e "  ${CYAN}[${_current}/${_total}]${NC} ${_short}"

    printf "         ├─ SSH connect... "
    _start=$(date +%s)

    echo "===MASTER_REPORT===" >> "$OUTFILE"

    # Global timeout per master (MASTER_TIMEOUT seconds)
    _output=$(timeout ${MASTER_TIMEOUT} ssh -o ConnectTimeout=${SSH_TIMEOUT} \
                  -o StrictHostKeyChecking=no \
                  -o BatchMode=yes \
                  -o ServerAliveInterval=15 \
                  -o ServerAliveCountMax=10 \
                  "root@${_master}" \
                  "${SCRIPT_PATH}" 2>&1)
    _rc=$?
    _elapsed=$(( $(date +%s) - _start ))

    if [ $_rc -eq 0 ] && echo "$_output" | grep -q "REPORT_VERSION"; then
        echo "$_output" >> "$OUTFILE"
        _success=$(( _success + 1 ))

        # Quick stats from output
        _hostname=$(echo "$_output" | grep "^MASTER_HOSTNAME=" | cut -d= -f2)
        _nbu_ver=$(echo "$_output" | grep "^NBU_VERSION=" | cut -d= -f2)
        _daemons_down=$(echo "$_output" | grep "^DAEMON_HEALTH_DOWN=" | cut -d= -f2)
        _backup_fail=$(echo "$_output" | grep "^FAILED_JOBS_FAILED=" | cut -d= -f2)
        _sys_errors=$(echo "$_output" | grep "^FAILED_JOBS_SYSTEM_ERRORS=" | cut -d= -f2)
        _ms_down=$(echo "$_output" | grep "^MEDIA_SERVERS_DOWN=" | cut -d= -f2)
        _closewait=$(echo "$_output" | grep "^CLOSEWAIT_1556_COUNT=" | cut -d= -f2)
        _mem_pct=$(echo "$_output" | grep "^MEMORY_USED_PCT=" | cut -d= -f2)

        printf "${GREEN}OK${NC} ${DIM}(${_elapsed}s)${NC}\n"
        printf "         ├─ Host: ${_hostname:-${_short}}"
        [ -n "$_nbu_ver" ] && printf " — ${_nbu_ver}"
        echo ""

        # Color-coded issue summary
        printf "         └─ "
        _issues=0

        if [ "${_daemons_down:-0}" -gt 0 ]; then
            printf "${RED}▼${_daemons_down} daemons down${NC}  "
            _issues=$(( _issues + 1 ))
        fi
        if [ "${_closewait:-0}" -gt 0 ]; then
            printf "${RED}▼CLOSE-WAIT:${_closewait}${NC}  "
            _issues=$(( _issues + 1 ))
        fi
        if [ "${_backup_fail:-0}" -gt 0 ]; then
            printf "${RED}▼${_backup_fail} backup failures${NC}  "
            _issues=$(( _issues + 1 ))
        fi
        if [ "${_sys_errors:-0}" -gt 50 ]; then
            printf "${YELLOW}△${_sys_errors} sys errors${NC}  "
            _issues=$(( _issues + 1 ))
        fi
        if [ "${_ms_down:-0}" -gt 0 ]; then
            printf "${RED}▼${_ms_down} media down${NC}  "
            _issues=$(( _issues + 1 ))
        fi

        if [ $_issues -eq 0 ]; then
            printf "${GREEN}✓ All clear${NC}  "
            [ -n "$_mem_pct" ] && printf "${DIM}mem:${_mem_pct}%%${NC}"
        fi
        echo ""

    else
        _errmsg=$(echo "$_output" | head -1)
        [ -z "$_errmsg" ] && _errmsg="exit code ${_rc}"

        if [ $_rc -eq 255 ]; then
            _reason="SSH connection failed"
        elif [ $_rc -eq 124 ]; then
            _reason="Timeout (>${MASTER_TIMEOUT}s) — script too slow, reduce bptestbpcd checks"
        elif echo "$_output" | grep -qi "no such file\|not found\|Permission denied"; then
            _reason="Script not found — deploy controlli.sh first"
        else
            _reason="${_errmsg}"
        fi

        printf "${RED}FAIL${NC} ${DIM}(${_elapsed}s)${NC}\n"
        printf "         └─ ${RED}${_reason}${NC}\n"

        cat >> "$OUTFILE" <<EOF
REPORT_VERSION=2
MASTER_HOSTNAME=${_short}
MASTER_FQDN=${_host}
TIMESTAMP=$(date '+%Y-%m-%dT%H:%M:%S%z')
TIMESTAMP_EPOCH=$(date +%s)
NBU_VERSION=UNREACHABLE
OS_RELEASE=${_reason}
---SECTION=FAILED_JOBS---
FAILED_JOBS_STATUS=ERROR
FAILED_JOBS_MSG=${_reason}
---SECTION=HUNG_JOBS---
HUNG_JOBS_STATUS=ERROR
---SECTION=DISK_POOLS---
DISK_POOLS_STATUS=ERROR
---SECTION=MEDIA_SERVERS---
MEDIA_SERVERS_STATUS=ERROR
---SECTION=CERTIFICATES---
CERTIFICATES_STATUS=ERROR
---SECTION=VAULT_TAPES---
VAULT_TAPES_STATUS=ERROR
---SECTION=DAEMON_HEALTH---
DAEMON_HEALTH_DOWN=9
DAEMON_HEALTH_TOTAL=9
CLOSEWAIT_1556_COUNT=0
CLOSEWAIT_1556_SEVERITY=OK
---SECTION=SYSTEM---
---END---
EOF
        _failed=$(( _failed + 1 ))
    fi
    echo ""
done

_fleet_elapsed=$(( $(date +%s) - _fleet_start ))
_fleet_min=$(( _fleet_elapsed / 60 ))
_fleet_sec=$(( _fleet_elapsed % 60 ))

echo "  ╔══════════════════════════════════════════════════════════╗"
printf "  ║  Done in %dm %ds                                        ║\n" "$_fleet_min" "$_fleet_sec"
printf "  ║  ${GREEN}  ✓ ${_success} OK${NC}    ${RED}✗ ${_failed} FAILED${NC}                              ║\n"
printf "  ║  %-54s  ║\n" "Output: ${OUTFILE}"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  Sempre lo stesso file — trascinalo su:                  ║"
echo "  ║  controlroomnbu.netlify.app                              ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""

# Pulizia vecchi file timestampati (se esistono da run precedenti)
rm -f /tmp/nbu_morningcheck_all_20??????_????.txt 2>/dev/null
