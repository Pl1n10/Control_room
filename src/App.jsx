import { useState, useCallback, useRef } from "react";

// --- RTF Stripper ---
function stripRtf(rtf) {
  if (!rtf.trimStart().startsWith("{\\rtf")) return rtf;
  let t = rtf;
  t = t.replace(/\{\\fonttbl[\s\S]*?\}/g, "");
  t = t.replace(/\{\\colortbl[\s\S]*?\}/g, "");
  t = t.replace(/\{\\stylesheet[\s\S]*?\}/g, "");
  t = t.replace(/\{\\info[\s\S]*?\}/g, "");
  t = t.replace(/\{\\(?:\*\\)[^}]*\}/g, "");
  t = t.replace(/\\par[d]?\s?/g, "\n");
  t = t.replace(/\\line\s?/g, "\n");
  t = t.replace(/\\tab\s?/g, "\t");
  for (let i = 0; i < 3; i++) t = t.replace(/\\[a-z]+[-]?\d*\s?/gi, "");
  t = t.replace(/[{}]/g, "");
  t = t.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/\\u-?\d+\?/g, "");
  t = t.split("\n").map(l => l.trimEnd()).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

// --- Parser ---
function parseReport(text) {
  text = stripRtf(text);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const data = { _raw: {}, _sections: [], _meta: {} };
  let currentSection = "_header";
  for (const line of lines) {
    if (line === "---END---") break;
    const sectionMatch = line.match(/^---SECTION=(.+)---$/);
    if (sectionMatch) { currentSection = sectionMatch[1]; data._sections.push(currentSection); continue; }
    const kvMatch = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (kvMatch) {
      data._raw[kvMatch[1]] = kvMatch[2];
      if (currentSection === "_header") data._meta[kvMatch[1]] = kvMatch[2];
    }
  }
  return data;
}

function getSeverity(data, section) {
  const r = data._raw;
  switch (section) {
    case "FAILED_JOBS": {
      const failed = parseInt(r.FAILED_JOBS_FAILED || "0");
      if (r.FAILED_JOBS_STATUS === "ERROR") return "error";
      if (failed > 5) return "critical";
      if (failed > 0) return "warning";
      if (parseInt(r.FAILED_JOBS_SYSTEM_ERRORS || "0") > 50) return "warning";
      return "ok";
    }
    case "HUNG_JOBS": {
      const count = parseInt(r.HUNG_JOBS_COUNT || "0");
      if (r.HUNG_JOBS_STATUS === "ERROR") return "error";
      if (count === 0) return "ok";
      if (count >= 3) return "critical";
      return "warning";
    }
    case "DISK_POOLS":
      if (r.DISK_POOLS_STATUS === "ERROR") return "error";
      if (parseInt(r.DISK_POOLS_CRITICAL || "0") > 0) return "critical";
      if (parseInt(r.DISK_POOLS_WARNING || "0") > 0) return "warning";
      return "ok";
    case "MEDIA_SERVERS":
      if (r.MEDIA_SERVERS_STATUS === "ERROR") return "error";
      if (parseInt(r.MEDIA_SERVERS_DOWN || "0") > 0) return "warning";
      return "ok";
    case "CERTIFICATES":
      if (r.CERTIFICATES_STATUS === "ERROR") return "error";
      if (parseInt(r.CERTIFICATES_CRITICAL || "0") > 0) return "critical";
      if (parseInt(r.CERTIFICATES_WARNING || "0") > 0) return "warning";
      return "ok";
    case "VAULT_TAPES":
      if (r.VAULT_TAPES_STATUS === "ERROR") return "error";
      if (r.VAULT_TAPES_STATUS === "NA") return "ok";
      if (r.VAULT_TAPES_SCRATCH_SEVERITY === "CRITICAL") return "critical";
      if (r.VAULT_TAPES_SCRATCH_SEVERITY === "WARNING") return "warning";
      return "ok";
    case "DAEMON_HEALTH":
      if (r.CLOSEWAIT_1556_SEVERITY === "CRITICAL") return "critical";
      if (parseInt(r.DAEMON_HEALTH_DOWN || "0") > 0) return "critical";
      return "ok";
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
  FAILED_JOBS:"Failed Jobs", HUNG_JOBS:"Hung Jobs", DISK_POOLS:"Disk Pools",
  MEDIA_SERVERS:"Media Servers", CERTIFICATES:"Certificates", VAULT_TAPES:"Vault & Tapes",
  DAEMON_HEALTH:"Daemons", SYSTEM:"System",
};

const SEV = {
  ok:       { color: "#34d399", bg: "rgba(52,211,153,0.06)",  border: "rgba(52,211,153,0.18)",  label: "OK" },
  warning:  { color: "#fbbf24", bg: "rgba(251,191,36,0.06)",  border: "rgba(251,191,36,0.18)",  label: "WARN" },
  critical: { color: "#f87171", bg: "rgba(248,113,113,0.07)", border: "rgba(248,113,113,0.22)", label: "CRIT" },
  error:    { color: "#f87171", bg: "rgba(248,113,113,0.07)", border: "rgba(248,113,113,0.22)", label: "ERROR" },
  unknown:  { color: "#6b7280", bg: "rgba(107,114,128,0.06)", border: "rgba(107,114,128,0.15)", label: "?" },
};

function Dot({ severity, size = 8, pulse = false }) {
  const s = SEV[severity] || SEV.unknown;
  return (
    <span style={{ position:"relative", display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
      {pulse && <span style={{ position:"absolute", width:size+6, height:size+6, borderRadius:"50%", background:s.color, opacity:0, animation:"ping 1.8s ease-out infinite" }} />}
      <span style={{ width:size, height:size, borderRadius:"50%", background:s.color, flexShrink:0, display:"block" }} />
    </span>
  );
}

function Chip({ count, label, sev }) {
  const s = SEV[sev];
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:4, background:s.bg, border:`1px solid ${s.border}`, borderRadius:4, padding:"2px 7px", fontSize:10, fontFamily:"'JetBrains Mono',monospace", fontWeight:700, color:s.color, letterSpacing:"0.05em" }}>
      {count} {label}
    </span>
  );
}

function SectionDetail({ data, section }) {
  const r = data._raw;
  const row = (label, val, sev) => {
    const color = sev ? (SEV[sev]?.color || "#94a3b8") : "#64748b";
    const bold = sev && sev !== "ok";
    return (
      <tr key={label} style={{ borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
        <td style={{ padding:"5px 12px 5px 0", color:"#475569", fontSize:11, fontFamily:"'JetBrains Mono',monospace", width:"42%", verticalAlign:"top" }}>{label}</td>
        <td style={{ padding:"5px 0", color, fontSize:11, fontFamily:"'JetBrains Mono',monospace", fontWeight:bold?600:400, wordBreak:"break-word" }}>{val||"—"}</td>
      </tr>
    );
  };
  const rows = [];
  switch (section) {
    case "FAILED_JOBS":
      rows.push(row("Total events", r.FAILED_JOBS_TOTAL));
      rows.push(row("Successful (sev 0)", r.FAILED_JOBS_SUCCESS, "ok"));
      rows.push(row("Partial (sev 8)", r.FAILED_JOBS_WARNING||r.FAILED_JOBS_PARTIAL, parseInt(r.FAILED_JOBS_WARNING||r.FAILED_JOBS_PARTIAL||"0")>0?"warning":null));
      rows.push(row("Backup failures", r.FAILED_JOBS_FAILED||"0", parseInt(r.FAILED_JOBS_FAILED)>0?"critical":"ok"));
      rows.push(row("System errors (jobid=0)", r.FAILED_JOBS_SYSTEM_ERRORS||"0", parseInt(r.FAILED_JOBS_SYSTEM_ERRORS)>50?"warning":null));
      for (let i=1;i<=5;i++) { const d=r[`FAILED_JOB_DETAIL_${i}`]; if(d) rows.push(row(`Fail #${i}`,d,"critical")); }
      for (let i=1;i<=3;i++) { const d=r[`SYSTEM_ERROR_DETAIL_${i}`]; if(d) rows.push(row(`Sys err #${i}`,d.trim(),"warning")); }
      break;
    case "HUNG_JOBS":
      rows.push(row("Hung count", r.HUNG_JOBS_COUNT||"0", parseInt(r.HUNG_JOBS_COUNT)>0?"critical":"ok"));
      for (let i=1;i<=20;i++) { const d=r[`HUNG_JOB_${i}`]; if(d) rows.push(row(`Job #${i}`,d.replace(/\|/g,"  "),"warning")); }
      break;
    case "DISK_POOLS": {
      const count=parseInt(r.DISK_POOLS_COUNT||"0");
      rows.push(row("Pools", count));
      for (let i=1;i<=count;i++) {
        const name=r[`DISK_POOL_${i}_NAME`]||`Pool ${i}`;
        const pct=r[`DISK_POOL_${i}_USED_PCT`]; const free=r[`DISK_POOL_${i}_FREE_GB`];
        const sev=(r[`DISK_POOL_${i}_SEVERITY`]||"OK").toLowerCase();
        rows.push(row(name,`${pct||"?"}% used · ${free||"?"}GB free`,sev==="ok"?"ok":sev));
      }
      break;
    }
    case "MEDIA_SERVERS": {
      const count=parseInt(r.MEDIA_SERVERS_COUNT||"0");
      const inactive=parseInt(r.MEDIA_SERVERS_DOWN||"0");
      const jobBased=r.MEDIA_SERVERS_CHECK==="job-based-24h";
      rows.push(row("Total", count));
      rows.push(row(jobBased?"Inactive (no jobs 24h)":"Down", inactive, inactive>0?"warning":"ok"));
      for (let i=1;i<=count;i++) {
        const name=r[`MEDIA_SERVER_${i}_NAME`]; const st=r[`MEDIA_SERVER_${i}_STATUS`]; const type=r[`MEDIA_SERVER_${i}_TYPE`]||"";
        if(!name) continue;
        const isSkip=st&&st.startsWith("SKIP");
        const label=type?`${name} (${type})`:name;
        const display=st==="SKIP_NDMP"?"skipped (NDMP)":st==="SKIP_MASTER"?"skipped (master)":st==="SKIP_DD"?"skipped (appliance)":st==="WARNING"?"no jobs 24h":st;
        rows.push(row(label,display,st==="UP"?"ok":isSkip?null:st==="WARNING"?"warning":"critical"));
      }
      break;
    }
    case "CERTIFICATES": {
      const count=parseInt(r.CERTIFICATES_COUNT||"0");
      for (let i=1;i<=count;i++) {
        const exp=r[`CERT_${i}_EXPIRY`]||r[`CERT_${i}_EXPIRY_RAW`]||"?";
        const days=r[`CERT_${i}_DAYS_LEFT`]; const sev=(r[`CERT_${i}_SEVERITY`]||"UNKNOWN").toLowerCase();
        rows.push(row(`Cert ${i} — ${exp}`,days?`${days}d remaining`:sev,sev==="ok"?"ok":sev==="warning"?"warning":"critical"));
      }
      if(count===0&&r.CERTIFICATES_RAW) rows.push(row("Raw",r.CERTIFICATES_RAW));
      break;
    }
    case "VAULT_TAPES":
      if (r.VAULT_TAPES_STATUS==="NA") {
        rows.push(row("Status", r.VAULT_TAPES_MSG||"No tape library — Data Domain only"));
      } else {
        rows.push(row("Total media", r.VAULT_TAPES_TOTAL));
        rows.push(row("Scratch", r.VAULT_TAPES_SCRATCH, r.VAULT_TAPES_SCRATCH_SEVERITY==="CRITICAL"?"critical":r.VAULT_TAPES_SCRATCH_SEVERITY==="WARNING"?"warning":"ok"));
        rows.push(row("Frozen", r.VAULT_TAPES_FROZEN||"0"));
        rows.push(row("Suspended", r.VAULT_TAPES_SUSPENDED||"0"));
        rows.push(row("Full", r.VAULT_TAPES_FULL||"0"));
        rows.push(row("Expired", r.VAULT_TAPES_EXPIRED||"0", parseInt(r.VAULT_TAPES_EXPIRED)>0?"warning":null));
      }
      break;
    case "DAEMON_HEALTH": {
      const daemons=["nbemm","nbpem","bprd","bpdbm","bpjobd","nbaudit","vnetd","nbjm","nbrb"];
      for (const d of daemons) {
        const st=r[`DAEMON_${d}_STATUS`]; if(!st) continue;
        const pid=r[`DAEMON_${d}_PID`]||""; const started=r[`DAEMON_${d}_STARTED`]||"";
        rows.push(row(d, st==="UP"?`UP · PID ${pid} · ${started}`:"DOWN", st==="UP"?"ok":"critical"));
      }
      rows.push(row("CLOSE-WAIT:1556", r.CLOSEWAIT_1556_COUNT||"0", parseInt(r.CLOSEWAIT_1556_COUNT)>0?"critical":"ok"));
      if (parseInt(r.CLOSEWAIT_1556_TOTAL)>0) {
        rows.push(row("  total CW", r.CLOSEWAIT_1556_TOTAL));
        rows.push(row("  harmless", r.CLOSEWAIT_1556_HARMLESS));
      }
      if (r.CLOSEWAIT_1556_PROCS) rows.push(row("  flagged procs", r.CLOSEWAIT_1556_PROCS, "critical"));
      break;
    }
    case "SYSTEM":
      rows.push(row("Uptime", r.UPTIME));
      rows.push(row("Load avg", r.LOAD_AVG));
      rows.push(row("Memory", `${r.MEMORY_USED_MB||"?"}/${r.MEMORY_TOTAL_MB||"?"}MB (${r.MEMORY_USED_PCT||"?"}%)`, parseInt(r.MEMORY_USED_PCT)>85?"warning":"ok"));
      rows.push(row("Swap", `${r.SWAP_USED_MB||"0"}/${r.SWAP_TOTAL_MB||"?"}MB`));
      rows.push(row("Catalog disk", `${r.CATALOG_DISK_USED_PCT||"?"}%`, parseInt(r.CATALOG_DISK_USED_PCT)>85?"warning":"ok"));
      rows.push(row("DB data disk", `${r.DBDATA_DISK_USED_PCT||"?"}%`, parseInt(r.DBDATA_DISK_USED_PCT)>85?"warning":"ok"));
      break;
  }
  return (
    <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid rgba(255,255,255,0.05)" }}>
      <table style={{ width:"100%", borderCollapse:"collapse" }}>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

const SECTION_ICONS_SVG = {
  FAILED_JOBS: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 4.5V7.5M7 9v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  HUNG_JOBS: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 4.5v2.8l1.8 1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  DISK_POOLS: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><ellipse cx="7" cy="4.5" rx="4.5" ry="1.8" stroke="currentColor" strokeWidth="1.2"/><path d="M2.5 4.5v5c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8v-5" stroke="currentColor" strokeWidth="1.2"/><path d="M2.5 7c0 1 2 1.8 4.5 1.8S11.5 8 11.5 7" stroke="currentColor" strokeWidth="1.2"/></svg>,
  MEDIA_SERVERS: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="2" y="3.5" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M4 7h3M4 9h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><circle cx="10" cy="9" r=".7" fill="currentColor"/></svg>,
  CERTIFICATES: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 2L2.5 4.5v3.8c0 2.2 2 4 4.5 4.4 2.5-.4 4.5-2.2 4.5-4.4V4.5L7 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M5 7l1.5 1.5L9.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  VAULT_TAPES: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><rect x="2" y="3.5" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="4.5" cy="7" r="1.3" stroke="currentColor" strokeWidth="1.1"/><circle cx="9.5" cy="7" r="1.3" stroke="currentColor" strokeWidth="1.1"/><path d="M5.8 7h2.4" stroke="currentColor" strokeWidth="1"/></svg>,
  DAEMON_HEALTH: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.2"/><path d="M7 2v1.5M7 10.5V12M2 7h1.5M10.5 7H12M3.5 3.5l1 1M9.5 9.5l1 1M3.5 10.5l1-1M9.5 4.5l1-1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
  SYSTEM: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 9.5L4.5 7l2.5 2.5L10 5.5l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><rect x="2" y="2.5" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/></svg>,
};

function SectionRow({ data, section }) {
  const [open, setOpen] = useState(false);
  const sev = getSeverity(data, section);
  const s = SEV[sev];
  const isProblem = sev === "critical" || sev === "error" || sev === "warning";
  return (
    <div onClick={() => setOpen(!open)} style={{ borderBottom:"1px solid rgba(255,255,255,0.04)", cursor:"pointer", transition:"background 0.12s" }}
      onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.02)"}
      onMouseLeave={e=>e.currentTarget.style.background=open?"rgba(255,255,255,0.02)":"transparent"}
    >
      <div style={{ display:"flex", alignItems:"center", gap:9, padding:"9px 16px" }}>
        <Dot severity={sev} size={7} pulse={sev==="critical"} />
        <span style={{ color:"#334155", display:"flex", alignItems:"center" }}>{SECTION_ICONS_SVG[section]}</span>
        <span style={{ flex:1, fontSize:12, fontWeight:500, color:isProblem?"#cbd5e1":"#64748b", letterSpacing:"0.01em" }}>{SECTION_LABELS[section]}</span>
        <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", color:s.color, fontFamily:"'JetBrains Mono',monospace", minWidth:34, textAlign:"right" }}>{s.label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color:"#1e293b", transition:"transform 0.2s", transform:open?"rotate(180deg)":"rotate(0)", flexShrink:0, marginLeft:4 }}>
          <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      {open && <div style={{ padding:"0 16px 12px" }}><SectionDetail data={data} section={section} /></div>}
    </div>
  );
}

function MasterCard({ report }) {
  const [expanded, setExpanded] = useState(false);
  const data = report.data;
  const overall = getOverallSeverity(data);
  const s = SEV[overall];
  const hostname = data._meta.MASTER_HOSTNAME || report.filename;
  const ts = data._meta.TIMESTAMP || "";
  const nbuVer = data._meta.NBU_VERSION || "";
  const osRelease = data._meta.OS_RELEASE || "";
  const sections = ["DAEMON_HEALTH","FAILED_JOBS","HUNG_JOBS","DISK_POOLS","MEDIA_SERVERS","CERTIFICATES","VAULT_TAPES","SYSTEM"];
  const counts = { ok:0, warning:0, critical:0 };
  for (const sec of sections) {
    const sv = getSeverity(data, sec);
    if (sv==="ok") counts.ok++; else if (sv==="warning") counts.warning++; else counts.critical++;
  }
  let tsDisplay = ts;
  try { const d=new Date(ts); if(!isNaN(d)) tsDisplay=d.toLocaleString("it-IT",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}); } catch {}
  return (
    <div style={{ background:"#0d1117", border:`1px solid ${expanded?s.border:"rgba(255,255,255,0.07)"}`, borderRadius:10, overflow:"hidden", transition:"border-color 0.2s" }}>
      <div style={{ height:2, background:s.color, opacity:overall==="ok"?0.25:0.75 }} />
      <div onClick={()=>setExpanded(!expanded)} style={{ padding:"14px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:12, userSelect:"none" }}>
        <div style={{ width:34, height:34, borderRadius:8, background:s.bg, border:`1px solid ${s.border}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
          <Dot severity={overall} size={10} pulse={overall==="critical"} />
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:13, color:"#f1f5f9", letterSpacing:"0.03em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{hostname}</div>
          <div style={{ fontSize:10, color:"#334155", marginTop:2, display:"flex", gap:8, flexWrap:"wrap" }}>
            {tsDisplay && <span style={{ fontFamily:"'JetBrains Mono',monospace" }}>{tsDisplay}</span>}
            {nbuVer && <><span style={{ color:"#1e293b" }}>·</span><span style={{ color:"#475569" }}>{nbuVer}</span></>}
          </div>
        </div>
        <div style={{ display:"flex", gap:5, alignItems:"center", flexShrink:0 }}>
          {counts.critical>0 && <Chip count={counts.critical} label="crit" sev="critical" />}
          {counts.warning>0 && <Chip count={counts.warning} label="warn" sev="warning" />}
          {counts.ok>0 && <Chip count={counts.ok} label="ok" sev="ok" />}
        </div>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink:0, color:"#334155", transition:"transform 0.2s", transform:expanded?"rotate(180deg)":"rotate(0)", marginLeft:4 }}>
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      {expanded && (
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.05)" }}>
          {sections.map(sec=><SectionRow key={sec} data={data} section={sec} />)}
          {osRelease && <div style={{ padding:"7px 16px", borderTop:"1px solid rgba(255,255,255,0.04)" }}><span style={{ fontSize:10, color:"#1e3a5f", fontFamily:"'JetBrains Mono',monospace" }}>{osRelease}</span></div>}
        </div>
      )}
    </div>
  );
}

function generateDemoReport(name, scenario) {
  const lines = [`REPORT_VERSION=2`,`MASTER_HOSTNAME=${name}`,`MASTER_FQDN=${name}.corp.example.com`,`TIMESTAMP=${new Date().toISOString()}`,`TIMESTAMP_EPOCH=${Math.floor(Date.now()/1000)}`,`NBU_VERSION=NetBackup 10.4.0.1`,`OS_RELEASE=Red Hat Enterprise Linux release 8.10`];
  if (scenario==="healthy") {
    lines.push("---SECTION=FAILED_JOBS---","FAILED_JOBS_STATUS=OK","FAILED_JOBS_TOTAL=142","FAILED_JOBS_SUCCESS=138","FAILED_JOBS_PARTIAL=3","FAILED_JOBS_FAILED=1","FAILED_JOB_DETAIL_1=03/17/2026 policy=FILE_DAILY client=srv-app02 sched=Full status=59");
    lines.push("---SECTION=HUNG_JOBS---","HUNG_JOBS_STATUS=OK","HUNG_JOBS_COUNT=0");
    lines.push("---SECTION=DISK_POOLS---","DISK_POOLS_STATUS=OK","DISK_POOLS_COUNT=2","DISK_POOL_1_NAME=dp_primary_01","DISK_POOL_1_TOTAL_GB=5000","DISK_POOL_1_FREE_GB=2800","DISK_POOL_1_USED_PCT=44","DISK_POOL_1_SEVERITY=OK","DISK_POOL_2_NAME=dp_secondary_01","DISK_POOL_2_TOTAL_GB=3000","DISK_POOL_2_FREE_GB=1500","DISK_POOL_2_USED_PCT=50","DISK_POOL_2_SEVERITY=OK","DISK_POOLS_WARNING=0","DISK_POOLS_CRITICAL=0");
    lines.push("---SECTION=MEDIA_SERVERS---","MEDIA_SERVERS_STATUS=OK","MEDIA_SERVERS_COUNT=3","MEDIA_SERVERS_DOWN=0","MEDIA_SERVER_1_NAME=media01","MEDIA_SERVER_1_STATUS=UP","MEDIA_SERVER_2_NAME=media02","MEDIA_SERVER_2_STATUS=UP","MEDIA_SERVER_3_NAME=media03","MEDIA_SERVER_3_STATUS=UP");
    lines.push("---SECTION=CERTIFICATES---","CERTIFICATES_STATUS=OK","CERTIFICATES_COUNT=1","CERT_1_EXPIRY=2027-01-15","CERT_1_DAYS_LEFT=308","CERT_1_SEVERITY=OK","CERTIFICATES_WARNING=0","CERTIFICATES_CRITICAL=0");
    lines.push("---SECTION=VAULT_TAPES---","VAULT_TAPES_STATUS=OK","VAULT_TAPES_TOTAL=450","VAULT_TAPES_SCRATCH=85","VAULT_TAPES_FROZEN=12","VAULT_TAPES_SUSPENDED=0","VAULT_TAPES_FULL=280","VAULT_TAPES_EXPIRED=3","VAULT_TAPES_SCRATCH_SEVERITY=OK");
    lines.push("---SECTION=DAEMON_HEALTH---","DAEMON_nbemm_STATUS=UP","DAEMON_nbemm_PID=12401","DAEMON_nbemm_STARTED=Mon Mar 17 06:00:01 2026","DAEMON_nbpem_STATUS=UP","DAEMON_nbpem_PID=12455","DAEMON_nbpem_STARTED=Mon Mar 17 06:00:05 2026","DAEMON_bprd_STATUS=UP","DAEMON_bprd_PID=12389","DAEMON_bprd_STARTED=Mon Mar 17 06:00:01 2026","DAEMON_bpdbm_STATUS=UP","DAEMON_bpdbm_PID=12350","DAEMON_bpdbm_STARTED=Mon Mar 17 06:00:00 2026","DAEMON_bpjobd_STATUS=UP","DAEMON_bpjobd_PID=12460","DAEMON_bpjobd_STARTED=Mon Mar 17 06:00:06 2026","DAEMON_nbaudit_STATUS=UP","DAEMON_nbaudit_PID=12330","DAEMON_nbaudit_STARTED=Mon Mar 17 06:00:00 2026","DAEMON_vnetd_STATUS=UP","DAEMON_vnetd_PID=12310","DAEMON_vnetd_STARTED=Mon Mar 17 06:00:00 2026","DAEMON_nbjm_STATUS=UP","DAEMON_nbjm_PID=12470","DAEMON_nbjm_STARTED=Mon Mar 17 06:00:06 2026","DAEMON_nbrb_STATUS=UP","DAEMON_nbrb_PID=12480","DAEMON_nbrb_STARTED=Mon Mar 17 06:00:06 2026","DAEMON_HEALTH_TOTAL=9","DAEMON_HEALTH_DOWN=0","CLOSEWAIT_1556_COUNT=0","CLOSEWAIT_1556_SEVERITY=OK");
    lines.push("---SECTION=SYSTEM---","UPTIME=up 45 days, 3 hours","LOAD_AVG=0.42 0.38 0.35","MEMORY_TOTAL_MB=131072","MEMORY_USED_MB=42000","MEMORY_USED_PCT=32","SWAP_TOTAL_MB=16384","SWAP_USED_MB=120","CATALOG_DISK_USED_PCT=48","DBDATA_DISK_USED_PCT=35");
  } else if (scenario==="warning") {
    lines.push("---SECTION=FAILED_JOBS---","FAILED_JOBS_STATUS=OK","FAILED_JOBS_TOTAL=98","FAILED_JOBS_SUCCESS=88","FAILED_JOBS_PARTIAL=5","FAILED_JOBS_FAILED=5");
    lines.push("---SECTION=HUNG_JOBS---","HUNG_JOBS_STATUS=OK","HUNG_JOBS_COUNT=1","HUNG_JOB_1=jobid=45021|policy=ORACLE_WEEKLY|client=oradb03|hours=28");
    lines.push("---SECTION=DISK_POOLS---","DISK_POOLS_STATUS=OK","DISK_POOLS_COUNT=1","DISK_POOL_1_NAME=dp_main","DISK_POOL_1_TOTAL_GB=4000","DISK_POOL_1_FREE_GB=600","DISK_POOL_1_USED_PCT=85","DISK_POOL_1_SEVERITY=WARNING","DISK_POOLS_WARNING=1","DISK_POOLS_CRITICAL=0");
    lines.push("---SECTION=MEDIA_SERVERS---","MEDIA_SERVERS_STATUS=OK","MEDIA_SERVERS_COUNT=2","MEDIA_SERVERS_DOWN=0","MEDIA_SERVER_1_NAME=media01","MEDIA_SERVER_1_STATUS=UP","MEDIA_SERVER_2_NAME=media02","MEDIA_SERVER_2_STATUS=UP");
    lines.push("---SECTION=CERTIFICATES---","CERTIFICATES_STATUS=OK","CERTIFICATES_COUNT=1","CERT_1_EXPIRY=2026-04-10","CERT_1_DAYS_LEFT=28","CERT_1_SEVERITY=WARNING","CERTIFICATES_WARNING=1","CERTIFICATES_CRITICAL=0");
    lines.push("---SECTION=VAULT_TAPES---","VAULT_TAPES_STATUS=OK","VAULT_TAPES_TOTAL=200","VAULT_TAPES_SCRATCH=12","VAULT_TAPES_FROZEN=5","VAULT_TAPES_SUSPENDED=2","VAULT_TAPES_FULL=150","VAULT_TAPES_EXPIRED=8","VAULT_TAPES_SCRATCH_SEVERITY=WARNING");
    lines.push("---SECTION=DAEMON_HEALTH---","DAEMON_nbemm_STATUS=UP","DAEMON_nbemm_PID=8801","DAEMON_nbemm_STARTED=Mon Mar 16 22:15:00 2026","DAEMON_nbpem_STATUS=UP","DAEMON_nbpem_PID=8855","DAEMON_nbpem_STARTED=Mon Mar 16 22:15:04 2026","DAEMON_bprd_STATUS=UP","DAEMON_bprd_PID=8789","DAEMON_bprd_STARTED=Mon Mar 16 22:15:00 2026","DAEMON_bpdbm_STATUS=UP","DAEMON_bpdbm_PID=8750","DAEMON_bpdbm_STARTED=Mon Mar 16 22:15:00 2026","DAEMON_bpjobd_STATUS=UP","DAEMON_bpjobd_PID=8860","DAEMON_bpjobd_STARTED=Mon Mar 16 22:15:05 2026","DAEMON_nbaudit_STATUS=UP","DAEMON_nbaudit_PID=8730","DAEMON_nbaudit_STARTED=Mon Mar 16 22:15:00 2026","DAEMON_vnetd_STATUS=UP","DAEMON_vnetd_PID=8710","DAEMON_vnetd_STARTED=Mon Mar 16 22:15:00 2026","DAEMON_nbjm_STATUS=UP","DAEMON_nbjm_PID=8870","DAEMON_nbjm_STARTED=Mon Mar 16 22:15:06 2026","DAEMON_nbrb_STATUS=UP","DAEMON_nbrb_PID=8880","DAEMON_nbrb_STARTED=Mon Mar 16 22:15:06 2026","DAEMON_HEALTH_TOTAL=9","DAEMON_HEALTH_DOWN=0","CLOSEWAIT_1556_COUNT=0","CLOSEWAIT_1556_SEVERITY=OK");
    lines.push("---SECTION=SYSTEM---","UPTIME=up 12 days, 8 hours","LOAD_AVG=1.85 1.42 1.20","MEMORY_TOTAL_MB=65536","MEMORY_USED_MB=55000","MEMORY_USED_PCT=84","SWAP_TOTAL_MB=8192","SWAP_USED_MB=2048","CATALOG_DISK_USED_PCT=72","DBDATA_DISK_USED_PCT=65");
  } else {
    lines.push("---SECTION=FAILED_JOBS---","FAILED_JOBS_STATUS=OK","FAILED_JOBS_TOTAL=65","FAILED_JOBS_SUCCESS=22","FAILED_JOBS_PARTIAL=8","FAILED_JOBS_FAILED=35","FAILED_JOB_DETAIL_1=03/17/2026 policy=SAP_DAILY client=sapapp01 sched=Full status=84","FAILED_JOB_DETAIL_2=03/17/2026 policy=SAP_DAILY client=sapapp02 sched=Full status=84","FAILED_JOB_DETAIL_3=03/17/2026 policy=MSSQL_PROD client=sqlprod01 sched=Full status=2074");
    lines.push("---SECTION=HUNG_JOBS---","HUNG_JOBS_STATUS=OK","HUNG_JOBS_COUNT=3","HUNG_JOB_1=jobid=78001|policy=VMWARE_DC1|client=vcenter01|hours=36","HUNG_JOB_2=jobid=78055|policy=ORACLE_PROD|client=oraprod01|hours=30","HUNG_JOB_3=jobid=78102|policy=NDMP_NAS|client=nas01|hours=26");
    lines.push("---SECTION=DISK_POOLS---","DISK_POOLS_STATUS=OK","DISK_POOLS_COUNT=2","DISK_POOL_1_NAME=dp_prod_tier1","DISK_POOL_1_TOTAL_GB=8000","DISK_POOL_1_FREE_GB=300","DISK_POOL_1_USED_PCT=96","DISK_POOL_1_SEVERITY=CRITICAL","DISK_POOL_2_NAME=dp_prod_tier2","DISK_POOL_2_TOTAL_GB=4000","DISK_POOL_2_FREE_GB=3200","DISK_POOL_2_USED_PCT=20","DISK_POOL_2_SEVERITY=OK","DISK_POOLS_WARNING=0","DISK_POOLS_CRITICAL=1");
    lines.push("---SECTION=MEDIA_SERVERS---","MEDIA_SERVERS_STATUS=OK","MEDIA_SERVERS_COUNT=4","MEDIA_SERVERS_DOWN=1","MEDIA_SERVER_1_NAME=media01","MEDIA_SERVER_1_STATUS=UP","MEDIA_SERVER_2_NAME=media02","MEDIA_SERVER_2_STATUS=DOWN","MEDIA_SERVER_3_NAME=media03","MEDIA_SERVER_3_STATUS=UP","MEDIA_SERVER_4_NAME=media04","MEDIA_SERVER_4_STATUS=UP");
    lines.push("---SECTION=CERTIFICATES---","CERTIFICATES_STATUS=OK","CERTIFICATES_COUNT=2","CERT_1_EXPIRY=2026-03-18","CERT_1_DAYS_LEFT=5","CERT_1_SEVERITY=CRITICAL","CERT_2_EXPIRY=2026-12-01","CERT_2_DAYS_LEFT=263","CERT_2_SEVERITY=OK","CERTIFICATES_WARNING=0","CERTIFICATES_CRITICAL=1");
    lines.push("---SECTION=VAULT_TAPES---","VAULT_TAPES_STATUS=OK","VAULT_TAPES_TOTAL=180","VAULT_TAPES_SCRATCH=3","VAULT_TAPES_FROZEN=20","VAULT_TAPES_SUSPENDED=5","VAULT_TAPES_FULL=140","VAULT_TAPES_EXPIRED=15","VAULT_TAPES_SCRATCH_SEVERITY=CRITICAL");
    lines.push("---SECTION=DAEMON_HEALTH---","DAEMON_nbemm_STATUS=UP","DAEMON_nbemm_PID=3509054","DAEMON_nbemm_STARTED=Sat Mar 14 03:12:00 2026","DAEMON_nbpem_STATUS=DOWN","DAEMON_bprd_STATUS=UP","DAEMON_bprd_PID=3400","DAEMON_bprd_STARTED=Sat Mar 14 03:10:00 2026","DAEMON_bpdbm_STATUS=UP","DAEMON_bpdbm_PID=3350","DAEMON_bpdbm_STARTED=Sat Mar 14 03:10:00 2026","DAEMON_bpjobd_STATUS=UP","DAEMON_bpjobd_PID=3460","DAEMON_bpjobd_STARTED=Sat Mar 14 03:10:05 2026","DAEMON_nbaudit_STATUS=UP","DAEMON_nbaudit_PID=3330","DAEMON_nbaudit_STARTED=Sat Mar 14 03:10:00 2026","DAEMON_vnetd_STATUS=UP","DAEMON_vnetd_PID=3310","DAEMON_vnetd_STARTED=Sat Mar 14 03:10:00 2026","DAEMON_nbjm_STATUS=UP","DAEMON_nbjm_PID=3470","DAEMON_nbjm_STARTED=Sat Mar 14 03:10:06 2026","DAEMON_nbrb_STATUS=UP","DAEMON_nbrb_PID=3480","DAEMON_nbrb_STARTED=Sat Mar 14 03:10:06 2026","DAEMON_HEALTH_TOTAL=9","DAEMON_HEALTH_DOWN=1","CLOSEWAIT_1556_COUNT=3","CLOSEWAIT_1556_SEVERITY=CRITICAL");
    lines.push("---SECTION=SYSTEM---","UPTIME=up 3 days, 1 hour","LOAD_AVG=4.52 3.88 3.65","MEMORY_TOTAL_MB=131072","MEMORY_USED_MB=125000","MEMORY_USED_PCT=95","SWAP_TOTAL_MB=16384","SWAP_USED_MB=12000","CATALOG_DISK_USED_PCT=91","DBDATA_DISK_USED_PCT=88");
  }
  lines.push("---END---");
  return lines.join("\n");
}

export default function App() {
  const [reports, setReports] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const handleFiles = useCallback((files) => {
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const cleanText = stripRtf(e.target.result);
        let chunks;
        if (cleanText.includes("===MASTER_REPORT===")) {
          chunks = cleanText.split("===MASTER_REPORT===").filter(c=>c.trim().length>0&&c.includes("REPORT_VERSION"));
        } else { chunks=[cleanText]; }
        const newReports = [];
        for (const chunk of chunks) {
          const data = parseReport(chunk);
          if (!data._meta.REPORT_VERSION) continue;
          newReports.push({ filename:file.name, data, text:chunk });
        }
        setReports(prev=>{
          let updated=[...prev];
          for (const nr of newReports) {
            const hn=nr.data._meta.MASTER_HOSTNAME||nr.filename;
            updated=updated.filter(r=>(r.data._meta.MASTER_HOSTNAME||r.filename)!==hn);
            updated.push(nr);
          }
          return updated.sort((a,b)=>(a.data._meta.MASTER_HOSTNAME||a.filename).localeCompare(b.data._meta.MASTER_HOSTNAME||b.filename));
        });
      };
      reader.readAsText(file);
    }
  }, []);

  const loadDemo = useCallback(() => {
    const demos=[{name:"albmasterp01",scenario:"healthy"},{name:"stlmasterp01",scenario:"critical"},{name:"cagmasterp01",scenario:"warning"},{name:"brlmasterp01",scenario:"healthy"}];
    setReports(demos.map(d=>({ filename:`${d.name}.txt`, data:parseReport(generateDemoReport(d.name,d.scenario)), text:"" })));
  }, []);

  const removeReport = useCallback((idx)=>setReports(prev=>prev.filter((_,i)=>i!==idx)), []);

  const summary={ok:0,warning:0,critical:0};
  for (const r of reports) {
    const sev=getOverallSeverity(r.data);
    if(sev==="ok") summary.ok++; else if(sev==="warning") summary.warning++; else summary.critical++;
  }

  const now=new Date().toLocaleString("it-IT",{weekday:"short",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});

  return (
    <div style={{ minHeight:"100vh", background:"#080b0f", color:"#cbd5e1", fontFamily:"'Inter',-apple-system,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
        @keyframes ping { 0%{transform:scale(1);opacity:.6} 80%,100%{transform:scale(2.4);opacity:0} }
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
      `}</style>

      {/* Topbar */}
      <div style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"0 24px", height:50, display:"flex", alignItems:"center", justifyContent:"space-between", background:"rgba(8,11,15,0.97)", backdropFilter:"blur(8px)", position:"sticky", top:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:26, height:26, border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(255,255,255,0.03)" }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="3.5" width="10" height="7" rx="1.5" stroke="#475569" strokeWidth="1.2"/>
              <path d="M4 7h3M4 9h2" stroke="#475569" strokeWidth="1" strokeLinecap="round"/>
              <circle cx="10" cy="9" r=".7" fill="#475569"/>
            </svg>
          </div>
          <span style={{ fontSize:12, fontWeight:600, color:"#64748b", letterSpacing:"0.06em", textTransform:"uppercase" }}>NBU Control Room</span>
          <span style={{ color:"#1e293b" }}>·</span>
          <span style={{ fontSize:10, color:"#1e3a5f", fontFamily:"'JetBrains Mono',monospace" }}>Mauden S.r.L.</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {reports.length>0 && (
            <>
              {summary.critical>0&&<Chip count={summary.critical} label="crit" sev="critical"/>}
              {summary.warning>0&&<Chip count={summary.warning} label="warn" sev="warning"/>}
              <Chip count={summary.ok} label="ok" sev="ok"/>
              <div style={{ width:1, height:14, background:"rgba(255,255,255,0.06)", margin:"0 2px" }}/>
            </>
          )}
          <span style={{ fontSize:10, color:"#1e3a5f", fontFamily:"'JetBrains Mono',monospace" }}>{now}</span>
          <button onClick={loadDemo} style={{ background:"transparent", border:"1px solid rgba(255,255,255,0.07)", color:"#334155", padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em", transition:"all 0.15s" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.15)";e.currentTarget.style.color="#64748b"}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.07)";e.currentTarget.style.color="#334155"}}
          >demo</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth:800, margin:"0 auto", padding:"28px 20px 60px" }}>

        {/* Dropzone */}
        <div
          onDragOver={e=>{e.preventDefault();setDragOver(true)}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files)}}
          onClick={()=>fileInputRef.current?.click()}
          style={{ border:`1px dashed ${dragOver?"rgba(99,102,241,0.4)":"rgba(255,255,255,0.07)"}`, borderRadius:8, padding:reports.length===0?"38px 24px":"11px 20px", textAlign:"center", cursor:"pointer", background:dragOver?"rgba(99,102,241,0.03)":"transparent", transition:"all 0.18s", marginBottom:16 }}
        >
          <input ref={fileInputRef} type="file" multiple accept=".txt,.log,.out,.rtf" style={{ display:"none" }} onChange={e=>{if(e.target.files.length) handleFiles(e.target.files)}}/>
          {reports.length===0 ? (
            <>
              <div style={{ marginBottom:8, opacity:.25 }}>
                <svg width="26" height="26" viewBox="0 0 28 28" fill="none" style={{ display:"inline-block" }}>
                  <path d="M14 5v12M9 12l5-7 5 7" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <rect x="3" y="18" width="22" height="7" rx="2" stroke="#94a3b8" strokeWidth="1.2"/>
                </svg>
              </div>
              <div style={{ fontSize:13, fontWeight:500, color:"#334155", marginBottom:4 }}>Trascina i file di morning check</div>
              <div style={{ fontSize:11, color:"#1e293b", fontFamily:"'JetBrains Mono',monospace" }}>.txt · .rtf · output da nbu_morningcheck.sh</div>
            </>
          ) : (
            <div style={{ fontSize:10, color:"#1e293b", fontFamily:"'JetBrains Mono',monospace" }}>+ altri file · {reports.length} master caricati</div>
          )}
        </div>

        {/* Fleet bar */}
        {reports.length>1 && (
          <div style={{ display:"flex", height:2, borderRadius:1, overflow:"hidden", marginBottom:16, gap:2 }}>
            {summary.critical>0&&<div style={{ flex:summary.critical, background:"#f87171", opacity:.7 }}/>}
            {summary.warning>0&&<div style={{ flex:summary.warning, background:"#fbbf24", opacity:.7 }}/>}
            {summary.ok>0&&<div style={{ flex:summary.ok, background:"#34d399", opacity:.25 }}/>}
          </div>
        )}

        {/* Cards */}
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {reports.map((r,idx)=>(
            <div key={(r.data._meta.MASTER_HOSTNAME||r.filename)+idx} style={{ position:"relative" }}>
              <MasterCard report={r}/>
              <button onClick={e=>{e.stopPropagation();removeReport(idx)}} style={{ position:"absolute", top:9, right:9, background:"transparent", border:"none", color:"#1e293b", fontSize:15, cursor:"pointer", width:20, height:20, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", transition:"color 0.15s", zIndex:1 }} title="Rimuovi"
                onMouseEnter={e=>e.currentTarget.style.color="#475569"}
                onMouseLeave={e=>e.currentTarget.style.color="#1e293b"}
              >×</button>
            </div>
          ))}
        </div>

        {reports.length>0&&(
          <div style={{ textAlign:"center", marginTop:40, fontSize:10, color:"#0f172a", fontFamily:"'JetBrains Mono',monospace", letterSpacing:"0.06em" }}>
            NBU Control Room · Mauden S.r.L. · {new Date().toLocaleDateString("it-IT")}
          </div>
        )}
      </div>
    </div>
  );
}
