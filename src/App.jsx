import { useState, useCallback, useRef, useEffect } from "react";

// --- RTF Stripper ---
// MobaXterm salva output come RTF con markup ricco — questa funzione lo ripulisce
function stripRtf(rtf) {
  if (!rtf.trimStart().startsWith("{\\rtf")) return rtf;
  let t = rtf;
  // Rimuovi tabelle font/colore/stile (blocchi annidati)
  t = t.replace(/\{\\fonttbl[\s\S]*?\}/g, "");
  t = t.replace(/\{\\colortbl[\s\S]*?\}/g, "");
  t = t.replace(/\{\\stylesheet[\s\S]*?\}/g, "");
  t = t.replace(/\{\\info[\s\S]*?\}/g, "");
  t = t.replace(/\{\\(?:\*\\)[^}]*\}/g, "");
  // \par e \line → newline
  t = t.replace(/\\par[d]?\s?/g, "\n");
  t = t.replace(/\\line\s?/g, "\n");
  t = t.replace(/\\tab\s?/g, "\t");
  // Rimuovi control word RTF — ANCHE quando attaccati senza spazio (es. valore\cf1\highlight2)
  // Match backslash + letters + optional negative number + optional single trailing space
  // Run multiple passes to catch chained codes like \cf1\highlight2
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\\[a-z]+[-]?\d*\s?/gi, "");
  }
  // Rimuovi graffe residue
  t = t.replace(/[{}]/g, "");
  // Decode \'xx hex escapes
  t = t.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // Rimuovi unicode RTF escapes \uNNNN?
  t = t.replace(/\\u-?\d+\?/g, "");
  // Pulisci righe vuote multiple e trailing whitespace per riga
  t = t.split("\n").map(l => l.trimEnd()).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

// --- Parser ---
function parseReport(text) {
  // Auto-detect e strip RTF se necessario
  text = stripRtf(text);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const data = { _raw: {}, _sections: [], _meta: {} };
  let currentSection = "_header";

  for (const line of lines) {
    if (line === "---END---") break;
    const sectionMatch = line.match(/^---SECTION=(.+)---$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      data._sections.push(currentSection);
      continue;
    }
    const kvMatch = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2];
      data._raw[key] = val;
      if (currentSection === "_header") data._meta[key] = val;
    }
  }
  return data;
}

function getSeverity(data, section) {
  const r = data._raw;
  switch (section) {
    case "FAILED_JOBS": {
      const failed = parseInt(r.FAILED_JOBS_FAILED || "0");
      const total = parseInt(r.FAILED_JOBS_TOTAL || "0");
      if (r.FAILED_JOBS_STATUS === "ERROR") return "error";
      if (failed === 0) return "ok";
      if (total > 0 && failed / total > 0.3) return "critical";
      if (failed > 5) return "critical";
      if (failed > 0) return "warning";
      return "ok";
    }
    case "HUNG_JOBS": {
      const count = parseInt(r.HUNG_JOBS_COUNT || "0");
      if (r.HUNG_JOBS_STATUS === "ERROR") return "error";
      if (count === 0) return "ok";
      if (count >= 3) return "critical";
      return "warning";
    }
    case "DISK_POOLS": {
      if (r.DISK_POOLS_STATUS === "ERROR") return "error";
      const crit = parseInt(r.DISK_POOLS_CRITICAL || "0");
      const warn = parseInt(r.DISK_POOLS_WARNING || "0");
      if (crit > 0) return "critical";
      if (warn > 0) return "warning";
      return "ok";
    }
    case "MEDIA_SERVERS": {
      if (r.MEDIA_SERVERS_STATUS === "ERROR") return "error";
      const down = parseInt(r.MEDIA_SERVERS_DOWN || "0");
      if (down > 0) return "critical";
      return "ok";
    }
    case "CERTIFICATES": {
      if (r.CERTIFICATES_STATUS === "ERROR") return "error";
      const crit = parseInt(r.CERTIFICATES_CRITICAL || "0");
      const warn = parseInt(r.CERTIFICATES_WARNING || "0");
      if (crit > 0) return "critical";
      if (warn > 0) return "warning";
      return "ok";
    }
    case "VAULT_TAPES": {
      if (r.VAULT_TAPES_STATUS === "ERROR") return "error";
      const sev = r.VAULT_TAPES_SCRATCH_SEVERITY;
      if (sev === "CRITICAL") return "critical";
      if (sev === "WARNING") return "warning";
      return "ok";
    }
    case "DAEMON_HEALTH": {
      const down = parseInt(r.DAEMON_HEALTH_DOWN || "0");
      const cwSev = r.CLOSEWAIT_1556_SEVERITY || "OK";
      if (cwSev === "CRITICAL") return "critical";
      if (down > 0) return "critical";
      return "ok";
    }
    case "SYSTEM": {
      const mem = parseInt(r.MEMORY_USED_PCT || "0");
      const cat = parseInt(r.CATALOG_DISK_USED_PCT || "0");
      if (mem > 95 || cat > 95) return "critical";
      if (mem > 85 || cat > 85) return "warning";
      return "ok";
    }
    default: return "unknown";
  }
}

function getOverallSeverity(data) {
  const sections = ["FAILED_JOBS","HUNG_JOBS","DISK_POOLS","MEDIA_SERVERS","CERTIFICATES","VAULT_TAPES","DAEMON_HEALTH","SYSTEM"];
  let worst = "ok";
  for (const s of sections) {
    const sev = getSeverity(data, s);
    if (sev === "critical" || sev === "error") return "critical";
    if (sev === "warning") worst = "warning";
  }
  return worst;
}

const SECTION_LABELS = {
  FAILED_JOBS: "Failed Jobs",
  HUNG_JOBS: "Hung Jobs",
  DISK_POOLS: "Disk Pools",
  MEDIA_SERVERS: "Media Servers",
  CERTIFICATES: "Certificates",
  VAULT_TAPES: "Vault & Tapes",
  DAEMON_HEALTH: "Daemons",
  SYSTEM: "System",
};

const SECTION_ICONS = {
  FAILED_JOBS: "⛔",
  HUNG_JOBS: "⏳",
  DISK_POOLS: "💾",
  MEDIA_SERVERS: "🖥️",
  CERTIFICATES: "🔐",
  VAULT_TAPES: "📼",
  DAEMON_HEALTH: "⚙️",
  SYSTEM: "📊",
};

const SEV_COLORS = {
  ok: "#00ff88",
  warning: "#ffaa00",
  critical: "#ff3344",
  error: "#ff3344",
  unknown: "#666",
};

const SEV_BG = {
  ok: "rgba(0,255,136,0.06)",
  warning: "rgba(255,170,0,0.06)",
  critical: "rgba(255,51,68,0.08)",
  error: "rgba(255,51,68,0.08)",
  unknown: "rgba(100,100,100,0.06)",
};

// --- Detail renderers ---
function SectionDetail({ data, section }) {
  const r = data._raw;
  const cellStyle = { padding: "4px 10px", borderBottom: "1px solid rgba(255,255,255,0.05)", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: "12px" };
  const labelStyle = { ...cellStyle, color: "#8899aa", textAlign: "right", width: "45%" };
  const valStyle = { ...cellStyle, color: "#ddeeff" };

  const row = (label, val, highlight) => (
    <tr key={label}>
      <td style={labelStyle}>{label}</td>
      <td style={{ ...valStyle, color: highlight || "#ddeeff" }}>{val}</td>
    </tr>
  );

  const rows = [];
  switch (section) {
    case "FAILED_JOBS":
      rows.push(row("Total events", r.FAILED_JOBS_TOTAL || "—"));
      rows.push(row("Successful (sev 0)", r.FAILED_JOBS_SUCCESS || "—", SEV_COLORS.ok));
      rows.push(row("Info (sev 2-4)", r.FAILED_JOBS_INFO || r.FAILED_JOBS_INFO_EVENTS || "—", "#556677"));
      rows.push(row("Warning (sev 8)", r.FAILED_JOBS_WARNING || r.FAILED_JOBS_PARTIAL || "—", parseInt(r.FAILED_JOBS_WARNING || r.FAILED_JOBS_PARTIAL || "0") > 0 ? SEV_COLORS.warning : "#ddeeff"));
      rows.push(row("Errors (sev 16+)", r.FAILED_JOBS_FAILED || "—", parseInt(r.FAILED_JOBS_FAILED) > 0 ? SEV_COLORS.critical : SEV_COLORS.ok));
      for (let i = 1; i <= 10; i++) {
        const d = r[`FAILED_JOB_DETAIL_${i}`];
        if (d) rows.push(row(`Detail ${i}`, d, "#ff8899"));
      }
      break;
    case "HUNG_JOBS":
      rows.push(row("Hung count", r.HUNG_JOBS_COUNT || "0", parseInt(r.HUNG_JOBS_COUNT) > 0 ? SEV_COLORS.critical : SEV_COLORS.ok));
      for (let i = 1; i <= 20; i++) {
        const d = r[`HUNG_JOB_${i}`];
        if (d) rows.push(row(`Hung #${i}`, d.replace(/\|/g, "  "), SEV_COLORS.warning));
      }
      break;
    case "DISK_POOLS": {
      const count = parseInt(r.DISK_POOLS_COUNT || "0");
      rows.push(row("Pools", count));
      for (let i = 1; i <= count; i++) {
        const name = r[`DISK_POOL_${i}_NAME`] || `Pool ${i}`;
        const pct = r[`DISK_POOL_${i}_USED_PCT`];
        const sev = r[`DISK_POOL_${i}_SEVERITY`] || "OK";
        const col = sev === "CRITICAL" ? SEV_COLORS.critical : sev === "WARNING" ? SEV_COLORS.warning : SEV_COLORS.ok;
        rows.push(row(name, `${pct || "?"}% used — ${r[`DISK_POOL_${i}_FREE_GB`] || "?"}GB free`, col));
      }
      break;
    }
    case "MEDIA_SERVERS": {
      const count = parseInt(r.MEDIA_SERVERS_COUNT || "0");
      rows.push(row("Total", count));
      rows.push(row("Down", r.MEDIA_SERVERS_DOWN || "0", parseInt(r.MEDIA_SERVERS_DOWN) > 0 ? SEV_COLORS.critical : SEV_COLORS.ok));
      for (let i = 1; i <= count; i++) {
        const name = r[`MEDIA_SERVER_${i}_NAME`];
        const st = r[`MEDIA_SERVER_${i}_STATUS`];
        const type = r[`MEDIA_SERVER_${i}_TYPE`] || "";
        if (!name) continue;
        const isSkip = st && st.startsWith("SKIP");
        const label = type === "NDMP" ? `${name} (NDMP)` : type === "server" || type === "cluster" ? `${name} (${type})` : name;
        const col = st === "UP" ? SEV_COLORS.ok : isSkip ? "#556677" : SEV_COLORS.critical;
        const display = st === "SKIP_NDMP" ? "skipped (NDMP appliance)" : st === "SKIP_MASTER" ? "skipped (master/cluster)" : st === "SKIP_DD" ? "skipped (appliance)" : st;
        rows.push(row(label, display, col));
      }
      break;
    }
    case "CERTIFICATES": {
      const count = parseInt(r.CERTIFICATES_COUNT || "0");
      for (let i = 1; i <= count; i++) {
        const exp = r[`CERT_${i}_EXPIRY`] || r[`CERT_${i}_EXPIRY_RAW`] || "?";
        const days = r[`CERT_${i}_DAYS_LEFT`];
        const sev = r[`CERT_${i}_SEVERITY`] || "UNKNOWN";
        const col = sev === "CRITICAL" || sev === "EXPIRED" ? SEV_COLORS.critical : sev === "WARNING" ? SEV_COLORS.warning : SEV_COLORS.ok;
        rows.push(row(`Cert ${i}`, `${exp} — ${days ? days + "d left" : sev}`, col));
      }
      if (count === 0 && r.CERTIFICATES_RAW) rows.push(row("Raw", r.CERTIFICATES_RAW));
      break;
    }
    case "VAULT_TAPES":
      rows.push(row("Total media", r.VAULT_TAPES_TOTAL || "—"));
      rows.push(row("Scratch", r.VAULT_TAPES_SCRATCH || "—", r.VAULT_TAPES_SCRATCH_SEVERITY === "CRITICAL" ? SEV_COLORS.critical : r.VAULT_TAPES_SCRATCH_SEVERITY === "WARNING" ? SEV_COLORS.warning : SEV_COLORS.ok));
      rows.push(row("Frozen", r.VAULT_TAPES_FROZEN || "0"));
      rows.push(row("Suspended", r.VAULT_TAPES_SUSPENDED || "0"));
      rows.push(row("Full", r.VAULT_TAPES_FULL || "0"));
      rows.push(row("Expired", r.VAULT_TAPES_EXPIRED || "0", parseInt(r.VAULT_TAPES_EXPIRED) > 0 ? SEV_COLORS.warning : "#ddeeff"));
      break;
    case "DAEMON_HEALTH": {
      const daemons = ["nbemm","nbpem","bprd","bpdbm","bpjobd","nbaudit","vnetd","nbjm","nbrb"];
      for (const d of daemons) {
        const st = r[`DAEMON_${d}_STATUS`];
        if (st) {
          const pid = r[`DAEMON_${d}_PID`] || "";
          const started = r[`DAEMON_${d}_STARTED`] || "";
          const col = st === "UP" ? SEV_COLORS.ok : SEV_COLORS.critical;
          rows.push(row(d, st === "UP" ? `UP (PID ${pid}) — ${started}` : "DOWN", col));
        }
      }
      rows.push(row("CLOSE-WAIT:1556 (dangerous)", r.CLOSEWAIT_1556_COUNT || "0", parseInt(r.CLOSEWAIT_1556_COUNT) > 0 ? SEV_COLORS.critical : SEV_COLORS.ok));
      const cwTotal = r.CLOSEWAIT_1556_TOTAL || "0";
      const cwHarmless = r.CLOSEWAIT_1556_HARMLESS || "0";
      if (parseInt(cwTotal) > 0) {
        rows.push(row("CLOSE-WAIT total", cwTotal, "#556677"));
        rows.push(row("  harmless (nbinlinerwdetect)", cwHarmless, "#556677"));
      }
      if (r.CLOSEWAIT_1556_PROCS) rows.push(row("  flagged processes", r.CLOSEWAIT_1556_PROCS, SEV_COLORS.critical));
      break;
    }
    case "SYSTEM":
      rows.push(row("Uptime", r.UPTIME || "—"));
      rows.push(row("Load", r.LOAD_AVG || "—"));
      rows.push(row("Memory", `${r.MEMORY_USED_MB || "?"}/${r.MEMORY_TOTAL_MB || "?"}MB (${r.MEMORY_USED_PCT || "?"}%)`, parseInt(r.MEMORY_USED_PCT) > 85 ? SEV_COLORS.warning : "#ddeeff"));
      rows.push(row("Swap", `${r.SWAP_USED_MB || "0"}/${r.SWAP_TOTAL_MB || "?"}MB`));
      rows.push(row("Catalog disk", `${r.CATALOG_DISK_USED_PCT || "?"}%`, parseInt(r.CATALOG_DISK_USED_PCT) > 85 ? SEV_COLORS.warning : "#ddeeff"));
      rows.push(row("DB data disk", `${r.DBDATA_DISK_USED_PCT || "?"}%`, parseInt(r.DBDATA_DISK_USED_PCT) > 85 ? SEV_COLORS.warning : "#ddeeff"));
      break;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "8px" }}>
      <tbody>{rows}</tbody>
    </table>
  );
}

// --- Beacon / indicator light ---
function Beacon({ severity, size = 10 }) {
  const color = SEV_COLORS[severity] || "#666";
  const pulse = severity === "critical" || severity === "error";
  return (
    <span style={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: "50%",
      backgroundColor: color,
      boxShadow: `0 0 ${size}px ${color}`,
      animation: pulse ? "beacon-pulse 1.2s ease-in-out infinite" : "none",
      flexShrink: 0,
    }} />
  );
}

// --- Section Card ---
function SectionCard({ data, section }) {
  const [open, setOpen] = useState(false);
  const sev = getSeverity(data, section);
  const color = SEV_COLORS[sev];

  return (
    <div
      onClick={() => setOpen(!open)}
      style={{
        background: SEV_BG[sev],
        border: `1px solid ${color}22`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: "10px 14px",
        cursor: "pointer",
        transition: "all 0.15s ease",
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Beacon severity={sev} />
        <span style={{ fontSize: 15, marginRight: 4 }}>{SECTION_ICONS[section]}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 13, color: "#ccdde8", letterSpacing: "0.02em" }}>
          {SECTION_LABELS[section] || section}
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          color,
          letterSpacing: "0.08em",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        }}>
          {sev}
        </span>
        <span style={{ color: "#556", fontSize: 12, marginLeft: 4 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && <SectionDetail data={data} section={section} />}
    </div>
  );
}

// --- Master Card ---
function MasterCard({ report }) {
  const [expanded, setExpanded] = useState(false);
  const data = report.data;
  const overall = getOverallSeverity(data);
  const color = SEV_COLORS[overall];
  const hostname = data._meta.MASTER_HOSTNAME || report.filename;
  const ts = data._meta.TIMESTAMP || "unknown";
  const nbuVer = data._meta.NBU_VERSION || "";

  const sections = ["DAEMON_HEALTH","FAILED_JOBS","HUNG_JOBS","DISK_POOLS","MEDIA_SERVERS","CERTIFICATES","VAULT_TAPES","SYSTEM"];

  // Count severities
  const counts = { ok: 0, warning: 0, critical: 0 };
  for (const s of sections) {
    const sv = getSeverity(data, s);
    if (sv === "ok") counts.ok++;
    else if (sv === "warning") counts.warning++;
    else counts.critical++;
  }

  return (
    <div style={{
      background: "linear-gradient(135deg, #0d1117 0%, #111820 100%)",
      border: `1px solid ${color}33`,
      borderRadius: 10,
      overflow: "hidden",
      transition: "all 0.2s ease",
      boxShadow: `0 0 20px ${color}11`,
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: "16px 20px",
          cursor: "pointer",
          borderBottom: expanded ? "1px solid rgba(255,255,255,0.05)" : "none",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <Beacon severity={overall} size={14} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: "#e8f0f8", letterSpacing: "0.03em" }}>
            {hostname}
          </div>
          <div style={{ fontSize: 11, color: "#556677", marginTop: 2, fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
            {ts} · NBU {nbuVer}
          </div>
        </div>
        {/* Mini severity badges */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {counts.critical > 0 && (
            <span style={{ background: "rgba(255,51,68,0.15)", color: SEV_COLORS.critical, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
              {counts.critical} CRIT
            </span>
          )}
          {counts.warning > 0 && (
            <span style={{ background: "rgba(255,170,0,0.12)", color: SEV_COLORS.warning, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
              {counts.warning} WARN
            </span>
          )}
          <span style={{ background: "rgba(0,255,136,0.08)", color: SEV_COLORS.ok, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
            {counts.ok} OK
          </span>
        </div>
        <span style={{ color: "#445", fontSize: 14 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {/* Sections */}
      {expanded && (
        <div style={{ padding: "12px 16px 16px" }}>
          {sections.map(s => <SectionCard key={s} data={data} section={s} />)}
        </div>
      )}
    </div>
  );
}

// --- Demo data generator ---
function generateDemoReport(name, scenario) {
  const lines = [
    `REPORT_VERSION=2`,
    `MASTER_HOSTNAME=${name}`,
    `MASTER_FQDN=${name}.corp.example.com`,
    `TIMESTAMP=${new Date().toISOString()}`,
    `TIMESTAMP_EPOCH=${Math.floor(Date.now()/1000)}`,
    `NBU_VERSION=NetBackup 10.4.0.1`,
    `OS_RELEASE=Red Hat Enterprise Linux release 8.10`,
  ];

  if (scenario === "healthy") {
    lines.push("---SECTION=FAILED_JOBS---", "FAILED_JOBS_STATUS=OK", "FAILED_JOBS_TOTAL=142", "FAILED_JOBS_SUCCESS=138", "FAILED_JOBS_PARTIAL=3", "FAILED_JOBS_FAILED=1");
    lines.push("---SECTION=HUNG_JOBS---", "HUNG_JOBS_STATUS=OK", "HUNG_JOBS_COUNT=0");
    lines.push("---SECTION=DISK_POOLS---", "DISK_POOLS_STATUS=OK", "DISK_POOLS_COUNT=2",
      "DISK_POOL_1_NAME=dp_primary_01", "DISK_POOL_1_TOTAL_GB=5000", "DISK_POOL_1_FREE_GB=2800", "DISK_POOL_1_USED_PCT=44", "DISK_POOL_1_SEVERITY=OK",
      "DISK_POOL_2_NAME=dp_secondary_01", "DISK_POOL_2_TOTAL_GB=3000", "DISK_POOL_2_FREE_GB=1500", "DISK_POOL_2_USED_PCT=50", "DISK_POOL_2_SEVERITY=OK",
      "DISK_POOLS_WARNING=0", "DISK_POOLS_CRITICAL=0");
    lines.push("---SECTION=MEDIA_SERVERS---", "MEDIA_SERVERS_STATUS=OK", "MEDIA_SERVERS_COUNT=3", "MEDIA_SERVERS_DOWN=0",
      "MEDIA_SERVER_1_NAME=media01", "MEDIA_SERVER_1_STATUS=UP",
      "MEDIA_SERVER_2_NAME=media02", "MEDIA_SERVER_2_STATUS=UP",
      "MEDIA_SERVER_3_NAME=media03", "MEDIA_SERVER_3_STATUS=UP");
    lines.push("---SECTION=CERTIFICATES---", "CERTIFICATES_STATUS=OK", "CERTIFICATES_COUNT=1", "CERT_1_EXPIRY=2027-01-15", "CERT_1_DAYS_LEFT=308", "CERT_1_SEVERITY=OK", "CERTIFICATES_WARNING=0", "CERTIFICATES_CRITICAL=0");
    lines.push("---SECTION=VAULT_TAPES---", "VAULT_TAPES_STATUS=OK", "VAULT_TAPES_TOTAL=450", "VAULT_TAPES_SCRATCH=85", "VAULT_TAPES_FROZEN=12", "VAULT_TAPES_SUSPENDED=0", "VAULT_TAPES_FULL=280", "VAULT_TAPES_EXPIRED=3", "VAULT_TAPES_SCRATCH_SEVERITY=OK");
    lines.push("---SECTION=DAEMON_HEALTH---",
      "DAEMON_nbemm_STATUS=UP", "DAEMON_nbemm_PID=12401", "DAEMON_nbemm_STARTED=Thu Mar 12 06:00:01 2026",
      "DAEMON_nbpem_STATUS=UP", "DAEMON_nbpem_PID=12455", "DAEMON_nbpem_STARTED=Thu Mar 12 06:00:05 2026",
      "DAEMON_bprd_STATUS=UP", "DAEMON_bprd_PID=12389", "DAEMON_bprd_STARTED=Thu Mar 12 06:00:01 2026",
      "DAEMON_bpdbm_STATUS=UP", "DAEMON_bpdbm_PID=12350", "DAEMON_bpdbm_STARTED=Thu Mar 12 06:00:00 2026",
      "DAEMON_bpjobd_STATUS=UP", "DAEMON_bpjobd_PID=12460", "DAEMON_bpjobd_STARTED=Thu Mar 12 06:00:06 2026",
      "DAEMON_nbaudit_STATUS=UP", "DAEMON_nbaudit_PID=12330", "DAEMON_nbaudit_STARTED=Thu Mar 12 06:00:00 2026",
      "DAEMON_vnetd_STATUS=UP", "DAEMON_vnetd_PID=12310", "DAEMON_vnetd_STARTED=Thu Mar 12 06:00:00 2026",
      "DAEMON_nbjm_STATUS=UP", "DAEMON_nbjm_PID=12470", "DAEMON_nbjm_STARTED=Thu Mar 12 06:00:06 2026",
      "DAEMON_nbrb_STATUS=UP", "DAEMON_nbrb_PID=12480", "DAEMON_nbrb_STARTED=Thu Mar 12 06:00:06 2026",
      "DAEMON_HEALTH_TOTAL=9", "DAEMON_HEALTH_DOWN=0", "CLOSEWAIT_1556_COUNT=0", "CLOSEWAIT_1556_SEVERITY=OK");
    lines.push("---SECTION=SYSTEM---", "UPTIME=up 45 days, 3 hours", "LOAD_AVG=0.42 0.38 0.35", "MEMORY_TOTAL_MB=131072", "MEMORY_USED_MB=42000", "MEMORY_USED_PCT=32", "SWAP_TOTAL_MB=16384", "SWAP_USED_MB=120", "CATALOG_DISK_USED_PCT=48", "DBDATA_DISK_USED_PCT=35");
  } else if (scenario === "warning") {
    lines.push("---SECTION=FAILED_JOBS---", "FAILED_JOBS_STATUS=OK", "FAILED_JOBS_TOTAL=98", "FAILED_JOBS_SUCCESS=88", "FAILED_JOBS_PARTIAL=5", "FAILED_JOBS_FAILED=5");
    lines.push("---SECTION=HUNG_JOBS---", "HUNG_JOBS_STATUS=OK", "HUNG_JOBS_COUNT=1", "HUNG_JOB_1=jobid=45021|policy=ORACLE_WEEKLY|client=oradb03|hours=28");
    lines.push("---SECTION=DISK_POOLS---", "DISK_POOLS_STATUS=OK", "DISK_POOLS_COUNT=1",
      "DISK_POOL_1_NAME=dp_main", "DISK_POOL_1_TOTAL_GB=4000", "DISK_POOL_1_FREE_GB=600", "DISK_POOL_1_USED_PCT=85", "DISK_POOL_1_SEVERITY=WARNING",
      "DISK_POOLS_WARNING=1", "DISK_POOLS_CRITICAL=0");
    lines.push("---SECTION=MEDIA_SERVERS---", "MEDIA_SERVERS_STATUS=OK", "MEDIA_SERVERS_COUNT=2", "MEDIA_SERVERS_DOWN=0",
      "MEDIA_SERVER_1_NAME=media01", "MEDIA_SERVER_1_STATUS=UP",
      "MEDIA_SERVER_2_NAME=media02", "MEDIA_SERVER_2_STATUS=UP");
    lines.push("---SECTION=CERTIFICATES---", "CERTIFICATES_STATUS=OK", "CERTIFICATES_COUNT=1", "CERT_1_EXPIRY=2026-04-10", "CERT_1_DAYS_LEFT=28", "CERT_1_SEVERITY=WARNING", "CERTIFICATES_WARNING=1", "CERTIFICATES_CRITICAL=0");
    lines.push("---SECTION=VAULT_TAPES---", "VAULT_TAPES_STATUS=OK", "VAULT_TAPES_TOTAL=200", "VAULT_TAPES_SCRATCH=12", "VAULT_TAPES_FROZEN=5", "VAULT_TAPES_SUSPENDED=2", "VAULT_TAPES_FULL=150", "VAULT_TAPES_EXPIRED=8", "VAULT_TAPES_SCRATCH_SEVERITY=WARNING");
    lines.push("---SECTION=DAEMON_HEALTH---",
      "DAEMON_nbemm_STATUS=UP", "DAEMON_nbemm_PID=8801", "DAEMON_nbemm_STARTED=Wed Mar 11 22:15:00 2026",
      "DAEMON_nbpem_STATUS=UP", "DAEMON_nbpem_PID=8855", "DAEMON_nbpem_STARTED=Wed Mar 11 22:15:04 2026",
      "DAEMON_bprd_STATUS=UP", "DAEMON_bprd_PID=8789", "DAEMON_bprd_STARTED=Wed Mar 11 22:15:00 2026",
      "DAEMON_bpdbm_STATUS=UP", "DAEMON_bpdbm_PID=8750", "DAEMON_bpdbm_STARTED=Wed Mar 11 22:15:00 2026",
      "DAEMON_bpjobd_STATUS=UP", "DAEMON_bpjobd_PID=8860", "DAEMON_bpjobd_STARTED=Wed Mar 11 22:15:05 2026",
      "DAEMON_nbaudit_STATUS=UP", "DAEMON_nbaudit_PID=8730", "DAEMON_nbaudit_STARTED=Wed Mar 11 22:15:00 2026",
      "DAEMON_vnetd_STATUS=UP", "DAEMON_vnetd_PID=8710", "DAEMON_vnetd_STARTED=Wed Mar 11 22:15:00 2026",
      "DAEMON_nbjm_STATUS=UP", "DAEMON_nbjm_PID=8870", "DAEMON_nbjm_STARTED=Wed Mar 11 22:15:06 2026",
      "DAEMON_nbrb_STATUS=UP", "DAEMON_nbrb_PID=8880", "DAEMON_nbrb_STARTED=Wed Mar 11 22:15:06 2026",
      "DAEMON_HEALTH_TOTAL=9", "DAEMON_HEALTH_DOWN=0", "CLOSEWAIT_1556_COUNT=0", "CLOSEWAIT_1556_SEVERITY=OK");
    lines.push("---SECTION=SYSTEM---", "UPTIME=up 12 days, 8 hours", "LOAD_AVG=1.85 1.42 1.20", "MEMORY_TOTAL_MB=65536", "MEMORY_USED_MB=55000", "MEMORY_USED_PCT=84", "SWAP_TOTAL_MB=8192", "SWAP_USED_MB=2048", "CATALOG_DISK_USED_PCT=72", "DBDATA_DISK_USED_PCT=65");
  } else {
    // critical
    lines.push("---SECTION=FAILED_JOBS---", "FAILED_JOBS_STATUS=OK", "FAILED_JOBS_TOTAL=65", "FAILED_JOBS_SUCCESS=22", "FAILED_JOBS_PARTIAL=8", "FAILED_JOBS_FAILED=35",
      "FAILED_JOB_DETAIL_1=03/12/2026 policy=SAP_DAILY client=sapapp01 sched=Full status=84",
      "FAILED_JOB_DETAIL_2=03/12/2026 policy=SAP_DAILY client=sapapp02 sched=Full status=84",
      "FAILED_JOB_DETAIL_3=03/12/2026 policy=MSSQL_PROD client=sqlprod01 sched=Full status=2074");
    lines.push("---SECTION=HUNG_JOBS---", "HUNG_JOBS_STATUS=OK", "HUNG_JOBS_COUNT=3",
      "HUNG_JOB_1=jobid=78001|policy=VMWARE_DC1|client=vcenter01|hours=36",
      "HUNG_JOB_2=jobid=78055|policy=ORACLE_PROD|client=oraprod01|hours=30",
      "HUNG_JOB_3=jobid=78102|policy=NDMP_NAS|client=nas01|hours=26");
    lines.push("---SECTION=DISK_POOLS---", "DISK_POOLS_STATUS=OK", "DISK_POOLS_COUNT=2",
      "DISK_POOL_1_NAME=dp_prod_tier1", "DISK_POOL_1_TOTAL_GB=8000", "DISK_POOL_1_FREE_GB=300", "DISK_POOL_1_USED_PCT=96", "DISK_POOL_1_SEVERITY=CRITICAL",
      "DISK_POOL_2_NAME=dp_prod_tier2", "DISK_POOL_2_TOTAL_GB=4000", "DISK_POOL_2_FREE_GB=3200", "DISK_POOL_2_USED_PCT=20", "DISK_POOL_2_SEVERITY=OK",
      "DISK_POOLS_WARNING=0", "DISK_POOLS_CRITICAL=1");
    lines.push("---SECTION=MEDIA_SERVERS---", "MEDIA_SERVERS_STATUS=OK", "MEDIA_SERVERS_COUNT=4", "MEDIA_SERVERS_DOWN=1",
      "MEDIA_SERVER_1_NAME=media01", "MEDIA_SERVER_1_STATUS=UP",
      "MEDIA_SERVER_2_NAME=media02", "MEDIA_SERVER_2_STATUS=DOWN",
      "MEDIA_SERVER_3_NAME=media03", "MEDIA_SERVER_3_STATUS=UP",
      "MEDIA_SERVER_4_NAME=media04", "MEDIA_SERVER_4_STATUS=UP");
    lines.push("---SECTION=CERTIFICATES---", "CERTIFICATES_STATUS=OK", "CERTIFICATES_COUNT=2",
      "CERT_1_EXPIRY=2026-03-18", "CERT_1_DAYS_LEFT=5", "CERT_1_SEVERITY=CRITICAL",
      "CERT_2_EXPIRY=2026-12-01", "CERT_2_DAYS_LEFT=263", "CERT_2_SEVERITY=OK",
      "CERTIFICATES_WARNING=0", "CERTIFICATES_CRITICAL=1");
    lines.push("---SECTION=VAULT_TAPES---", "VAULT_TAPES_STATUS=OK", "VAULT_TAPES_TOTAL=180", "VAULT_TAPES_SCRATCH=3", "VAULT_TAPES_FROZEN=20", "VAULT_TAPES_SUSPENDED=5", "VAULT_TAPES_FULL=140", "VAULT_TAPES_EXPIRED=15", "VAULT_TAPES_SCRATCH_SEVERITY=CRITICAL");
    lines.push("---SECTION=DAEMON_HEALTH---",
      "DAEMON_nbemm_STATUS=UP", "DAEMON_nbemm_PID=3509054", "DAEMON_nbemm_STARTED=Mon Mar 10 03:12:00 2026",
      "DAEMON_nbpem_STATUS=DOWN",
      "DAEMON_bprd_STATUS=UP", "DAEMON_bprd_PID=3400", "DAEMON_bprd_STARTED=Mon Mar 10 03:10:00 2026",
      "DAEMON_bpdbm_STATUS=UP", "DAEMON_bpdbm_PID=3350", "DAEMON_bpdbm_STARTED=Mon Mar 10 03:10:00 2026",
      "DAEMON_bpjobd_STATUS=UP", "DAEMON_bpjobd_PID=3460", "DAEMON_bpjobd_STARTED=Mon Mar 10 03:10:05 2026",
      "DAEMON_nbaudit_STATUS=UP", "DAEMON_nbaudit_PID=3330", "DAEMON_nbaudit_STARTED=Mon Mar 10 03:10:00 2026",
      "DAEMON_vnetd_STATUS=UP", "DAEMON_vnetd_PID=3310", "DAEMON_vnetd_STARTED=Mon Mar 10 03:10:00 2026",
      "DAEMON_nbjm_STATUS=UP", "DAEMON_nbjm_PID=3470", "DAEMON_nbjm_STARTED=Mon Mar 10 03:10:06 2026",
      "DAEMON_nbrb_STATUS=UP", "DAEMON_nbrb_PID=3480", "DAEMON_nbrb_STARTED=Mon Mar 10 03:10:06 2026",
      "DAEMON_HEALTH_TOTAL=9", "DAEMON_HEALTH_DOWN=1", "CLOSEWAIT_1556_COUNT=3", "CLOSEWAIT_1556_SEVERITY=CRITICAL");
    lines.push("---SECTION=SYSTEM---", "UPTIME=up 3 days, 1 hour", "LOAD_AVG=4.52 3.88 3.65", "MEMORY_TOTAL_MB=131072", "MEMORY_USED_MB=125000", "MEMORY_USED_PCT=95", "SWAP_TOTAL_MB=16384", "SWAP_USED_MB=12000", "CATALOG_DISK_USED_PCT=91", "DBDATA_DISK_USED_PCT=88");
  }

  lines.push("---END---");
  return lines.join("\n");
}

// --- Main App ---
export default function App() {
  const [reports, setReports] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const handleFiles = useCallback((files) => {
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const data = parseReport(text);
        const hostname = data._meta.MASTER_HOSTNAME || file.name.replace(/\.[^.]+$/, "");
        setReports(prev => {
          // Replace if same hostname exists
          const filtered = prev.filter(r => (r.data._meta.MASTER_HOSTNAME || r.filename) !== hostname);
          return [...filtered, { filename: file.name, data, text }].sort((a, b) => {
            const ha = a.data._meta.MASTER_HOSTNAME || a.filename;
            const hb = b.data._meta.MASTER_HOSTNAME || b.filename;
            return ha.localeCompare(hb);
          });
        });
      };
      reader.readAsText(file);
    }
  }, []);

  const loadDemo = useCallback(() => {
    const demos = [
      { name: "albmasterp01", scenario: "healthy" },
      { name: "stlmasterp01", scenario: "critical" },
      { name: "cagmasterp01", scenario: "warning" },
      { name: "brlmasterp01", scenario: "healthy" },
    ];
    const newReports = demos.map(d => {
      const text = generateDemoReport(d.name, d.scenario);
      return { filename: `${d.name}.txt`, data: parseReport(text), text };
    });
    setReports(newReports);
  }, []);

  const removeReport = useCallback((idx) => {
    setReports(prev => prev.filter((_, i) => i !== idx));
  }, []);

  // Overall summary
  const summary = { ok: 0, warning: 0, critical: 0 };
  for (const r of reports) {
    const sev = getOverallSeverity(r.data);
    if (sev === "ok") summary.ok++;
    else if (sev === "warning") summary.warning++;
    else summary.critical++;
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #080c10 0%, #0a1018 50%, #0c1420 100%)",
      color: "#ccdde8",
      fontFamily: "'Segoe UI', -apple-system, sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;600;700&display=swap');
        @keyframes beacon-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a1018; }
        ::-webkit-scrollbar-thumb { background: #223344; border-radius: 3px; }
      `}</style>

      {/* Scanline overlay */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
        pointerEvents: "none", zIndex: 999,
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,20,40,0.03) 2px, rgba(0,20,40,0.03) 4px)",
      }} />

      {/* Header */}
      <div style={{
        borderBottom: "1px solid rgba(0,255,136,0.1)",
        padding: "18px 28px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(0,10,20,0.6)",
        backdropFilter: "blur(10px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "linear-gradient(135deg, #00ff88 0%, #0088ff 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, fontWeight: 700, color: "#000",
          }}>N</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: "#e8f4ff", letterSpacing: "0.04em" }}>
              NBU Control Room
            </div>
            <div style={{ fontSize: 11, color: "#445566", fontFamily: "'JetBrains Mono', monospace" }}>
              NetBackup Master Fleet Dashboard
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {reports.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {summary.critical > 0 && <span style={{ background: "rgba(255,51,68,0.15)", color: SEV_COLORS.critical, padding: "4px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{summary.critical} CRIT</span>}
              {summary.warning > 0 && <span style={{ background: "rgba(255,170,0,0.12)", color: SEV_COLORS.warning, padding: "4px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{summary.warning} WARN</span>}
              <span style={{ background: "rgba(0,255,136,0.08)", color: SEV_COLORS.ok, padding: "4px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{summary.ok} OK</span>
            </div>
          )}
          <button
            onClick={loadDemo}
            style={{
              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
              color: "#8899aa", padding: "6px 14px", borderRadius: 6, cursor: "pointer",
              fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
            }}
          >Demo data</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#00ff88" : "rgba(255,255,255,0.08)"}`,
            borderRadius: 12,
            padding: reports.length === 0 ? "48px 24px" : "16px 24px",
            textAlign: "center",
            cursor: "pointer",
            background: dragOver ? "rgba(0,255,136,0.04)" : "rgba(255,255,255,0.01)",
            transition: "all 0.2s ease",
            marginBottom: 24,
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.log,.out,.rtf"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files.length) handleFiles(e.target.files); }}
          />
          {reports.length === 0 ? (
            <>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
              <div style={{ fontSize: 15, color: "#8899aa", fontWeight: 600 }}>
                Trascina qui i file di morning check
              </div>
              <div style={{ fontSize: 12, color: "#445566", marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
                Output di nbu_morningcheck.sh — .txt o .rtf da MobaXterm
              </div>
              <div style={{ fontSize: 12, color: "#334455", marginTop: 12 }}>
                oppure clicca per sfogliare · premi "Demo data" per vedere un esempio
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: "#556677" }}>
              + Trascina altri file per aggiungere master · {reports.length} master caricati
            </div>
          )}
        </div>

        {/* Master cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {reports.map((r, idx) => (
            <div key={r.filename + idx} style={{ position: "relative" }}>
              <MasterCard report={r} />
              <button
                onClick={(e) => { e.stopPropagation(); removeReport(idx); }}
                style={{
                  position: "absolute", top: 8, right: 8,
                  background: "rgba(255,255,255,0.05)", border: "none",
                  color: "#556", fontSize: 14, cursor: "pointer",
                  width: 24, height: 24, borderRadius: 4,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                title="Rimuovi"
              >×</button>
            </div>
          ))}
        </div>

        {/* Footer */}
        {reports.length > 0 && (
          <div style={{ textAlign: "center", marginTop: 32, fontSize: 11, color: "#334455", fontFamily: "'JetBrains Mono', monospace" }}>
            NBU Control Room · Mauden S.r.L. · {new Date().toLocaleDateString("it-IT")}
          </div>
        )}
      </div>
    </div>
  );
}
