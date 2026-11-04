import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getToken, setToken } from "./api.js";
import { Inbox, Contacts, ContactAvatar, ago } from "./Inbox.jsx";

const CHANNELS = ["Facebook", "Instagram", "WhatsApp", "Email", "LinkedIn", "Website"];
const PIPELINES = ["Collect", "Process", "Review", "Do", "Done"];
const STATES = ["Ready", "Running", "Blocked", "Suspended"];
const PRIORITIES = ["urgent", "high", "medium", "low"];
const LEAD_TABS = ["Overview", "Inbox", "My tasks", "Projects", "Tasks", "Calendar", "Team", "Contacts", "Agents", "Analytics", "Organization", "Automations", "Settings"];
const MEMBER_TABS = ["My tasks", "Inbox", "Overview", "Tasks", "Calendar"];
const ago2 = (iso) => (iso ? ago(iso) : "never");
// What each agent is for, how it works, and which real numbers describe its work.
const AGENT_INFO = {
  scout: {
    stage: "Collect",
    purpose: "Make sure no inquiry is ever missed.",
    steps: [
      "Listens to Facebook, Instagram, WhatsApp and your website form.",
      "Every 2 minutes it also reads your Facebook inbox, so nothing is lost if the connection was down.",
      "Saves each message in the customer's conversation and files a task in Collect. Follow-ups from the same person go into the same conversation.",
    ],
    view: (a) => ({
      stats: [[a.capturedToday, "today"], [a.capturedTotal, "real tasks"], [a.fromChats, "from chats"]],
      last: a.lastAt, lastLabel: "Last inquiry",
      health: (a.channels.facebook || a.channels.whatsapp || a.channels.website) ? { tone: "ok", text: `Connected: ${[a.channels.facebook && "Facebook", a.channels.whatsapp && "WhatsApp", a.channels.website && "Website form"].filter(Boolean).join(", ")}` } : { tone: "warn", text: "No channel connected yet (Settings → Connect your accounts)" },
    }),
  },
  triage: {
    stage: "Collect → Process",
    purpose: "Put every task in front of the right person with the right priority.",
    steps: [
      "Reads the message with Groq AI.",
      "Sets the priority (urgent, high, medium, low), type, department and whether it is billable work.",
      "Suggests the best team member by role and current workload, and writes a clear task title.",
      "If Groq is unavailable it falls back to simple keyword rules.",
    ],
    view: (a) => ({
      stats: [[a.total, "tasks triaged"], [a.byGroq, "by Groq AI"], [a.byRules, "by rules"]],
      last: a.lastAt, lastLabel: "Last triage",
      health: a.groq.enabled ? (a.groq.lastError ? { tone: "warn", text: `Groq problem: ${a.groq.lastError.slice(0, 80)}` } : { tone: "ok", text: `Groq connected · ${a.groq.calls} calls, ${a.groq.failures} failed` }) : { tone: "warn", text: "Groq not connected — using keyword rules" },
    }),
  },
  scribe: {
    stage: "Process",
    purpose: "Save your team's writing time.",
    steps: [
      "Writes a polite reply draft, in the customer's language, for every new inquiry.",
      "You can edit the draft, or ask for a new one with “Rewrite with Groq”.",
      "It never sends anything by itself: a person approves and sends, or a lead approves and Runner sends.",
    ],
    view: (a) => ({
      stats: [[a.drafts, "tasks with a draft"], [a.rewrites, "rewrites"]],
      last: a.lastAt, lastLabel: "Last draft",
      health: a.enabled ? { tone: "ok", text: "Groq connected — drafts are written automatically" } : { tone: "warn", text: "Groq not connected — no drafts" },
    }),
  },
  runner: {
    stage: "Do",
    purpose: "Carry out approved work.",
    steps: [
      "When a team lead approves a task in Review, it moves to Do.",
      "If the task came from a chat and has an approved reply that has not been sent, Runner sends it on the same channel (Facebook, Instagram or WhatsApp) and records it in the conversation.",
      "It only ever sends text that a lead approved. If sending fails (for example the 24-hour rule), the task stays in Do with the reason and a Retry button.",
      "Switch it off to send every reply by hand from the Inbox.",
    ],
    view: (a) => ({
      stats: [[a.sent, "replies sent"], [a.waiting, "waiting to send"], [a.failed, "failed"]],
      last: a.lastAt, lastLabel: "Last sent",
      health: a.enabled ? (a.failed ? { tone: "warn", text: `${a.failed} reply could not be sent — open the task in Do to retry` } : { tone: "ok", text: "On — sends approved replies automatically" }) : { tone: "off", text: "Off — replies are sent by hand" },
    }),
  },
  hawk: {
    stage: "Every stage",
    purpose: "Make sure customers never wait too long.",
    steps: [
      "Every 30 seconds it checks each unanswered task against its reply deadline (urgent 1 h, high 4 h, medium 24 h, low 72 h; editable in Settings).",
      "At 75% of the time it warns the assignee.",
      "When the deadline passes it marks the task Escalated and notifies the team lead and the admin.",
    ],
    view: (a) => ({
      stats: [[a.atRisk, "at risk"], [a.breached, "overdue now"], [a.escalations, "escalations"]],
      last: a.lastCheckAt, lastLabel: "Last check",
      health: a.lastCheckAt && Date.now() - Date.parse(a.lastCheckAt) < 120000 ? { tone: "ok", text: "Watching — checks every 30 seconds" } : { tone: "warn", text: "Has not checked recently" },
    }),
  },
};
const STAGE_HELP = {
  Collect: "New — nobody has started on this yet.",
  Process: "Being worked on — reply to the customer and gather details.",
  Review: "Waiting for a team lead to approve, improve or reject.",
  Do: "Approved — carry it out, then mark it done.",
  Done: "Closed.",
};
const TYPES = ["Bug", "Feature", "Support", "DevOps", "SEO", "Marketing", "Sales", "Finance", "General"];
const LIFECYCLES = ["Unassigned", "Unscheduled", "Scheduled", "In review", "Approved", "Improving", "Rejected"];
const LIFE_STEPS = ["Birth", "Recorded", "Unassigned / Unscheduled", "Assigned & scheduled", "Review", "Approve · Improve · Reject"];
const OWNERS = ["Scout", "Triage", "Scribe", "Runner", "Hawk"];
const SRC = {
  Facebook: { abbr: "FB", color: "#1877f2", sub: "Page messages & leads" },
  Instagram: { abbr: "IG", color: "#c13584", sub: "DMs & comments" },
  WhatsApp: { abbr: "WA", color: "#1fb457", sub: "Chats & groups" },
  Email: { abbr: "EM", color: "#e5484d", sub: "Inbox threads" },
  LinkedIn: { abbr: "IN", color: "#0a66c2", sub: "Connections & InMail" },
  Website: { abbr: "WB", color: "#8a6d1f", sub: "Forms & live chat" },
};
const PRI_LABEL = { urgent: "URGENT", high: "HIGH", medium: "NORMAL", low: "LOW" };
const AGENT_TONE = { scout: "", triage: "", scribe: "amber", runner: "", hawk: "grey" };
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_BASE = [6, 9, 7, 11, 8, 5, 4];
const EXAMPLES = [
  "Urgent WhatsApp: client says the login API returns 500 errors in production",
  "Email: client asks to add SSO login to the dashboard",
  "Website form: new client wants a quote for a mobile app",
  "Publish the SEO article on custom software development cost",
];
const TRANSITIONS = {
  Ready: [{ to: "Running", label: "Start (Ready → Running)" }, { to: "Suspended", label: "TaskSuspend() → Suspended" }],
  Running: [{ to: "Blocked", label: "Blocking API call → Blocked" }, { to: "Ready", label: "Back to Ready" }],
  Blocked: [{ to: "Ready", label: "Event → Ready" }],
  Suspended: [{ to: "Ready", label: "TaskResume() → Ready" }],
};
const AUTOMATIONS = [
  { key: "autoMove", title: "Autopilot (demo): auto-move sample tasks", desc: "Demo only — Autopilot moves the sample tasks. Real customer tasks are never moved automatically; your team moves them." },
  { key: "autoUnblock", title: "Auto-unblock on events", desc: "Blocked tasks wake back to Ready when an event arrives." },
  { key: "autoPrioritize", title: "Auto-prioritize", desc: "Triage sets priority from the task text (urgent / high / medium / low)." },
  { key: "autoAssign", title: "Auto-assign & schedule", desc: "Triage gives every unassigned task an owner and every unscheduled task a due date." },
  { key: "runnerAutoSend", title: "Runner sends approved replies", desc: "When a team lead approves a customer reply (Review → Do), Runner sends it on the same channel. Off: you send replies by hand from the Inbox." },
  { key: "autoApprove", title: "Auto-approve reviews", desc: "Off: tasks wait in Review until you Approve, Improve or Reject. On: Autopilot approves them." },
  { key: "notifyBlocked", title: "Notify on blocked tasks", desc: "Blocked tasks are flagged in the activity feed for Hawk to watch." },
];

/* ---------- helpers ---------- */
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
function dayDiff(iso) {
  return Math.round((startOfDay(`${iso}T00:00:00`) - startOfDay(new Date())) / 86400000);
}
const weekdayOf = (iso, style = "long") => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { weekday: style });
function dueLabel(t) {
  if (t.dueLabel) return t.dueLabel;
  if (!t.due) return t.pipeline === "Done" ? "Done" : "No set time";
  const diff = dayDiff(t.due);
  const day = diff < 0 ? `${-diff}d overdue` : diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff <= 6 ? weekdayOf(t.due, "short") : t.due;
  return t.dueTime ? `${day}, ${t.dueTime}` : day;
}
function bucketOf(t) {
  if (t.pipeline === "Done") return "Done";
  if (!t.due) return "Later / no set time";
  const diff = dayDiff(t.due);
  if (diff < 0) return "Overdue";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff <= 6) return weekdayOf(t.due);
  return "Later / no set time";
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const shorten = (s, n = 38) => (s.length > n ? `${s.slice(0, n)}…` : s);
function lifeStepIndex(t) {
  if (["Approved", "Improving", "Rejected"].includes(t.lifecycle)) return 5;
  if (t.lifecycle === "In review") return 4;
  if (t.lifecycle === "Scheduled") return 3;
  return 2;
}
const fmtWhen = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const stateTag = (t) => (t.pipeline === "Done" ? "done" : t.state.toLowerCase());

/* ---------- small components ---------- */
const LogoIcon = () => (
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M16 16 L7 8 M16 16 L25 8 M16 16 L16 26" />
    <circle cx="7" cy="8" r="3" fill="currentColor" stroke="none" />
    <circle cx="25" cy="8" r="3" fill="currentColor" stroke="none" />
    <circle cx="16" cy="26" r="3" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="5" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="2" fill="var(--lime)" stroke="none" />
  </svg>
);
const Switch = ({ on, onClick, label }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={onClick} />
);
const SrcPill = ({ source }) => <span className="src" style={{ background: SRC[source]?.color }}>{source}</span>;
const PriPill = ({ p }) => <span className={`pri ${p}`}>{PRI_LABEL[p] || p.toUpperCase()}</span>;
const StateTag = ({ t }) => <span className={`st ${stateTag(t)}`}>{stateTag(t)}</span>;
const LifeTag = ({ t }) => <span className={`life ${t.lifecycle.toLowerCase().replace(/\s+/g, "-")}`}>{t.lifecycle}</span>;
const BillTag = ({ t }) => (t.billable ? <span className={`bill ${t.billing === "Billed" ? "billed" : ""}`}>{t.billing === "Billed" ? "billed" : "billable"}</span> : <span className="bill off">non-billable</span>);
function Avatar({ agent, size = "" }) {
  return <span className={`avatar ${size}`} style={{ background: agent?.color || "#888" }}>{(agent?.name || "?")[0]}</span>;
}
function Activity({ text }) {
  const parts = text.split(/"([^"]+)"/);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{shorten(p)}</b> : <span key={i}>{p}</span>))}</>;
}
function Donut({ data, total }) {
  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg width="116" height="116" viewBox="0 0 116 116" style={{ flex: "none" }}>
      <g transform="rotate(-90 58 58)">
        <circle cx="58" cy="58" r={R} fill="none" stroke="#222" strokeWidth="14" />
        {data.map(([name, value]) => {
          if (!value) return null;
          const len = (value / total) * C;
          const el = <circle key={name} cx="58" cy="58" r={R} fill="none" stroke={SRC[name].color} strokeWidth="14" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
      </g>
      <text x="58" y="60" textAnchor="middle" fill="#f4f1e8" fontFamily="Poppins, sans-serif" fontWeight="700" fontSize="24">{total}</text>
      <text x="58" y="74" textAnchor="middle" fill="#9b9a92" fontFamily="Poppins, sans-serif" fontSize="7.5" letterSpacing=".6">OPEN TASKS</text>
    </svg>
  );
}
function BarChart({ title, data }) {
  const max = Math.max(1, ...data.map(([, v]) => v));
  return (
    <div className="panel">
      <h3>{title}</h3>
      <div style={{ marginTop: 14 }}>
        {data.map(([label, value]) => (
          <div key={label} className="chart-row">
            <span>{label}</span>
            <div className="chart-bar"><div style={{ width: `${(value / max) * 100}%` }} /></div>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- SLA helpers ---------- */
function slaView(t, now) {
  const s = t.sla;
  if (!s) return null;
  if (t.respondedAt) return { cls: s.status === "late" ? "late" : "met", text: s.status === "late" ? "Answered late" : "SLA met" };
  const due = Date.parse(s.dueAt), start = Date.parse(t.createdAt);
  const left = due - now;
  const fmt = (ms) => {
    const m = Math.max(1, Math.round(Math.abs(ms) / 60000));
    return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  if (left < 0) return { cls: "breached", text: `SLA missed ${fmt(left)} ago` };
  return { cls: (now - start) / (due - start) >= 0.75 ? "risk" : "ok", text: `Reply within ${fmt(left)}` };
}
const SlaTag = ({ t, now }) => {
  const v = t.pipeline === "Done" && !t.respondedAt ? null : slaView(t, now);
  return v ? <span className={`sla ${v.cls}`}>{v.text}</span> : null;
};
const PRI_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const byUrgency = (a, b) => (PRI_RANK[a.priority] - PRI_RANK[b.priority]) || ((a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : 0) || (a.createdAt < b.createdAt ? -1 : 1);

/* ---------- login ---------- */
function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { const r = await api.login(username.trim(), password); setToken(r.token); onLogin(r.user); }
    catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="logo-mark"><LogoIcon /></div>
        <h1>Agentic Task Management</h1>
        <p>Sign in to see your tasks.</p>
        <label className="field-label" htmlFor="l-user">Username or email</label>
        <input id="l-user" className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="irfan  or  irfan@taskmanager.local" />
        <label className="field-label" htmlFor="l-pass" style={{ marginTop: 12 }}>Password</label>
        <input id="l-pass" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" type="submit" disabled={busy || !username || !password} style={{ marginTop: 16, width: "100%" }}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  useEffect(() => {
    if (getToken()) api.me().then(setUser).catch(() => setToken("")).finally(() => setChecking(false));
    const out = () => setUser(null);
    window.addEventListener("atm-logout", out);
    return () => window.removeEventListener("atm-logout", out);
  }, []);
  if (checking) return <div className="loading">Signing you in…</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Dashboard key={user.id} user={user} onLogout={() => { setToken(""); setUser(null); }} />;
}

/* ---------- app ---------- */
function Dashboard({ user, onLogout }) {
  const isLead = user.access !== "member";
  const isAdmin = user.access === "admin";
  const tabs = isLead ? LEAD_TABS : MEMBER_TABS;
  const [notifs, setNotifs] = useState([]);
  const [convs, setConvs] = useState([]);
  const [selectedConv, setSelectedConv] = useState(null);
  const [drawerConv, setDrawerConv] = useState(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [ai, setAi] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [aiBusy, setAiBusy] = useState(false);
  const [slaDraft, setSlaDraft] = useState({});
  const [integ, setInteg] = useState(null);
  const [cfgHints, setCfgHints] = useState({});
  const [cfgDraft, setCfgDraft] = useState({});
  const [testRes, setTestRes] = useState({});
  const [editing, setEditing] = useState(null);
  const [commentText, setCommentText] = useState("");
  const [draftEdits, setDraftEdits] = useState({});
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [agents, setAgents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState(isLead ? "Overview" : "My tasks");
  const [source, setSource] = useState("All");
  const [query, setQuery] = useState("");
  const [command, setCommand] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [agentAct, setAgentAct] = useState(null);
  const [toast, setToast] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [autopilot, setAutopilot] = useState(false);
  const [paceSec, setPaceSec] = useState(8);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tablePipeline, setTablePipeline] = useState("All");
  const [tableState, setTableState] = useState("All");
  const [tablePriority, setTablePriority] = useState("All");
  const [workspace, setWorkspace] = useState("");
  const [defaultPriority, setDefaultPriority] = useState("medium");
  const [form, setForm] = useState({ title: "", source: "WhatsApp", priority: "auto", category: "General", department: "Engineering", assignee: "auto", member: "auto", due: "", billable: true, details: "" });
  const [gov, setGov] = useState(null);
  const [team, setTeam] = useState([]);
  const [newMember, setNewMember] = useState({ name: "", role: "", department: "Engineering", access: "member", username: "", password: "", capacity: 5 });
  const [teamFilter, setTeamFilter] = useState("All");
  const [orgDraft, setOrgDraft] = useState({});
  const [tableLife, setTableLife] = useState("All");
  const [reviewNote, setReviewNote] = useState("");
  const selected = tasks.find((t) => t.id === selectedId) || null;
  const setSelected = (t) => { setSelectedId(t ? t.id : null); setReviewNote(""); };
  const autopilotRef = useRef(null);
  const formRef = useRef(null);
  const toastTimer = useRef(null);
  const firstLoad = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [t, s, a, ag, st, g, tm, nt, aist, intg, cv] = await Promise.all([api.tasks(), api.stats(), api.activity(), api.agents(), api.settings(), isLead ? api.governance() : Promise.resolve(null), api.team(), api.notifications(), isLead ? api.aiStatus() : Promise.resolve(null), isLead ? api.integrations() : Promise.resolve(null), api.conversations()]);
      setGov(g); setTeam(tm); setNotifs(nt); setAi(aist); setInteg(intg); setConvs(cv); setAutopilot(Boolean(s.autopilot)); setTasks(t); setStats(s); setActivity(a); setAgents(ag); setSettings(st);
      if (firstLoad.current) {
        firstLoad.current = false;
        setWorkspace(st.workspace); setDefaultPriority(st.defaultPriority); setAutopilot(Boolean(s.autopilot));
      }
      setError("");
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [isLead]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (tab !== "Agents" || !isLead) return undefined;
    let alive = true;
    const load = () => api.agentActivity().then((a) => { if (alive) setAgentAct(a); }).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [tab, isLead]);
  useEffect(() => {
    if (!newOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setNewOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newOpen]);
  useEffect(() => {
    const id = selected?.contact?.convId || selected?.contact?.key;
    if (!id) { setDrawerConv(null); return undefined; }
    let alive = true;
    const load = () => api.conversation(id).then((c) => { if (alive) setDrawerConv(c); }).catch(() => { if (alive) setDrawerConv(null); });
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [selected?.id]);
  useEffect(() => {
    if (tab === "Settings" && isAdmin) api.channelConfig().then(setCfgHints).catch(() => {});
  }, [tab, isAdmin]);
  // Keep SLA countdowns ticking and pick up new tasks / escalations from teammates.
  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 30000);
    const poll = setInterval(() => refresh(), 15000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [refresh]);

  useEffect(() => {
    if (!autopilot || !isLead) return undefined;
    autopilotRef.current = setInterval(async () => {
      try { await api.autopilotTick(); await refresh(); } catch { /* keep ticking */ }
    }, paceSec * 1000);
    return () => clearInterval(autopilotRef.current);
  }, [autopilot, paceSec, refresh, isLead]);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };

  const memberById = useMemo(() => Object.fromEntries(team.map((m) => [m.id, m])), [team]);
  const agentByName = useMemo(() => Object.fromEntries(agents.map((a) => [a.name, a])), [agents]);

  const displayed = useMemo(() => tasks.filter((t) =>
    (source === "All" || t.source === source) &&
    (!query || `${t.title} ${t.source} ${t.category}`.toLowerCase().includes(query.toLowerCase()))
  ), [tasks, source, query]);

  const openTasks = useMemo(() => tasks.filter((t) => t.pipeline !== "Done"), [tasks]);
  const countBySource = useMemo(() => Object.fromEntries(CHANNELS.map((c) => [c, tasks.filter((t) => t.source === c).length])), [tasks]);
  const openBySource = useMemo(() => CHANNELS.map((c) => [c, openTasks.filter((t) => t.source === c).length]), [openTasks]);
  const doneCount = tasks.filter((t) => t.pipeline === "Done").length;
  const runningCount = tasks.filter((t) => t.state === "Running" && t.pipeline !== "Done").length;
  const blockedCount = tasks.filter((t) => t.state === "Blocked").length;
  const timeSaved = tasks.reduce((s, t) => s + (t.progress / 100) * 1.4, 0);

  const weekBars = useMemo(() => {
    const today = (new Date().getDay() + 6) % 7;
    const bars = WEEK_BASE.map((v, i) => (i === today ? v + activity.length : v));
    return { bars, max: Math.max(...bars) };
  }, [activity.length]);

  const runCommand = async (e) => {
    e?.preventDefault();
    if (!command.trim()) return;
    try { const r = await api.command(command); showToast(r.message); setCommand(""); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const moveTask = async (task, pipeline) => {
    try { await api.updateTask(task.id, { pipeline }); showToast(`${shorten(task.title, 30)} → ${pipeline}`); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const resolveTask = async (task) => {
    let force = false;
    if (task.contact && !task.respondedAt) {
      if (!window.confirm("No reply has been sent to the customer yet. Close this task anyway?")) return;
      force = true;
    }
    try { await api.resolveTask(task.id, { force }); showToast(`${shorten(task.title, 30)} → Done`); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const changeState = async (task, state) => {
    try { await api.updateTask(task.id, { state }); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const patchTask = async (task, body) => {
    try { await api.updateTask(task.id, body); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const decide = async (task, decision) => {
    try {
      const edited = draftEdits[task.id];
      if (edited !== undefined && edited !== task.draft) await api.updateTask(task.id, { draft: edited });
      await api.review(task.id, decision, reviewNote); showToast(`${decision === "approve" ? "Approved" : decision === "improve" ? "Sent back to improve" : "Rejected"}: ${shorten(task.title, 40)}`); setReviewNote(""); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const toggleAutopilot = async () => {
    const next = !autopilot; setAutopilot(next);
    try { await api.autopilot(next); showToast(next ? "Autopilot ON — agents are moving tasks" : "Autopilot OFF"); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const ingest = async (s) => {
    try { const t = await api.ingest(s); showToast(`Captured from ${s}: ${t.title}`); await refresh(); }
    catch (err) { showToast(err.message); }
  };
  const simulateIncoming = async () => {
    const open = CHANNELS.filter((c) => !settings?.pausedChannels.includes(c));
    if (!open.length) return showToast("All channels are paused in Settings.");
    await ingest(open[Math.floor(Math.random() * open.length)]);
  };
  const reprocess = async (task) => {
    try {
      await api.reprocess(task.id, { nextStep: "Decide next step · Categorize · Schedule · Add notes" });
      showToast("Re-process: task sent back to Process"); setSelected(null); await refresh();
    } catch (err) { showToast(err.message); }
  };
  const saveSettings = async (patch) => {
    try { const st = await api.saveSettings(patch); setSettings(st); await refresh(); showToast("Settings saved"); }
    catch (err) { showToast(err.message); }
  };
  const toggleChannel = (ch) => saveSettings({
    pausedChannels: settings.pausedChannels.includes(ch) ? settings.pausedChannels.filter((c) => c !== ch) : [...settings.pausedChannels, ch],
  });
  const addManual = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return showToast("Give the task a title first.");
    try {
      const t = await api.createTask({ ...form, due: form.due || undefined });
      showToast(`Triaged as ${PRI_LABEL[t.priority]} · ${t.category} · ${t.lifecycle}`);
      setForm({ ...form, title: "", details: "", due: "" }); setNewOpen(false); await refresh();
    } catch (err) { showToast(err.message); }
  };
  const newTask = () => setNewOpen(true);

  const tableRows = tasks.filter((t) =>
    (tablePipeline === "All" || t.pipeline === tablePipeline) &&
    (tableState === "All" || (t.pipeline === "Done" ? tableState === "Done" : t.state === tableState)) &&
    (tablePriority === "All" || t.priority === tablePriority) &&
    (tableLife === "All" || t.lifecycle === tableLife));

  const calendar = useMemo(() => {
    const groups = {};
    for (const t of tasks) (groups[bucketOf(t)] ||= []).push(t);
    const weekdays = Object.keys(groups).filter((k) => !["Overdue", "Today", "Tomorrow", "Later / no set time", "Done"].includes(k))
      .sort((a, b) => Math.min(...groups[a].map((t) => dayDiff(t.due))) - Math.min(...groups[b].map((t) => dayDiff(t.due))));
    const order = [...(groups.Overdue ? ["Overdue"] : []), "Today", "Tomorrow", ...weekdays, "Later / no set time", "Done"];
    return { order, groups };
  }, [tasks]);

  if (loading) return <div className="loading">Waking up your AI agents…</div>;

  const assignTo = async (task, id) => {
    try { await api.updateTask(task.id, { assignee: id || null }); await refresh(); showToast(id ? `Assigned to ${memberById[id]?.name}` : "Team owner removed"); }
    catch (err) { showToast(err.message); }
  };
  const smartAssign = async () => {
    try { const r = await api.autoAssign(); showToast(r.message); await refresh(); } catch (err) { showToast(err.message); }
  };
  const addTeamMember = async (e) => {
    e.preventDefault();
    try { await api.addMember(newMember); setNewMember({ ...newMember, name: "", role: "", username: "", email: "", password: "" }); await refresh(); showToast("Team member added"); }
    catch (err) { showToast(err.message); }
  };
  const saveCfg = async () => {
    try {
      setCfgHints(await api.saveChannelConfig(cfgDraft)); setCfgDraft({});
      showToast("Saved — now press Test connection"); await refresh();
    } catch (err) { showToast(err.message); }
  };
  const runTest = async (channel) => {
    setTestRes((r) => ({ ...r, [channel]: { busy: true } }));
    try { const r = await api.testChannel(channel); setTestRes((x) => ({ ...x, [channel]: r })); }
    catch (err) { setTestRes((x) => ({ ...x, [channel]: { ok: false, message: err.message } })); }
  };
  const unread = notifs.filter((n) => !n.read).length;
  const openBell = () => setBellOpen(!bellOpen);
  const markAllRead = async () => { try { await api.readNotifications(); await refresh(); } catch { /* ignore */ } };
  const openConversation = (id) => { setSelectedConv(id); setTab("Inbox"); };
  const openTaskById = (id) => { const t = tasks.find((x) => x.id === id); if (t) setSelected(t); else showToast("That task is no longer on the board."); };
  const openNotif = async (n) => {
    setBellOpen(false);
    try { await api.readNotifications({ id: n.id }); } catch { /* ignore */ }
    if (n.type === "message" && n.convId) openConversation(n.convId);
    else { const t = tasks.find((x) => x.id === n.taskId); if (t) setSelected(t); }
    setTimeout(refresh, 400);
  };
  const convsUnread = convs.reduce((n, c) => n + c.unread, 0);
  const respond = async (task) => {
    try { await api.respond(task.id); showToast("Marked as replied — SLA timer stopped"); await refresh(); } catch (err) { showToast(err.message); }
  };
  const aiAction = async (fn, okMsg) => {
    setAiBusy(true);
    try { await fn(); showToast(okMsg); await refresh(); } catch (err) { showToast(err.message); }
    setAiBusy(false);
  };
  const postComment = async (e) => {
    e.preventDefault();
    if (!commentText.trim() || !selected) return;
    try { await api.comment(selected.id, commentText); setCommentText(""); await refresh(); } catch (err) { showToast(err.message); }
  };
  const sendReply = async (task, text) => {
    setAiBusy(true);
    try { await api.send(task.id, text); setDraftEdits((d) => ({ ...d, [task.id]: undefined })); showToast(`Reply sent on ${task.contact.channel} — SLA timer stopped`); await refresh(); }
    catch (err) { showToast(err.message); }
    setAiBusy(false);
  };
  const saveMember = async (e) => {
    e.preventDefault();
    const { id, password, ...f } = editing;
    try {
      await api.editMember(id, { name: f.name, role: f.role, email: f.email, phone: f.phone, department: f.department, access: f.access, capacity: Number(f.capacity) });
      if (password) await api.setMemberPassword(id, password);
      setEditing(null); await refresh(); showToast("Profile saved");
    } catch (err) { showToast(err.message); }
  };
  const changePw = async (e) => {
    e.preventDefault();
    try { await api.changePassword(pw.current, pw.next); setPw({ current: "", next: "" }); setAccountOpen(false); showToast("Password changed"); }
    catch (err) { showToast(err.message); }
  };
  const myOpen = tasks.filter((t) => t.assignee === user.id && t.pipeline !== "Done").sort(byUrgency);
  const openCount = (agent) => tasks.filter((t) => t.agent === agent.name && t.pipeline !== "Done").length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap">
          <div className="brand">
            <div className="logo-mark"><LogoIcon /></div>
            <div>
              <h1>{settings?.workspace && settings.workspace !== "Agentic Task OS" ? settings.workspace : "Agentic Task Management"}</h1>
              <p>Every task from every channel — captured, triaged and driven by AI agents.</p>
            </div>
          </div>
          <div className="top-actions">
            <span className="online-pill"><span className="dot" />{agents.filter((a) => !a.paused).length} agents online</span>
            {isLead && <><span className="auto-label" title="Demo mode: only moves the sample tasks. Real customer tasks are never moved automatically.">Autopilot (demo)</span><Switch on={autopilot} onClick={toggleAutopilot} label="Autopilot" /></>}
            <button className="btn" onClick={newTask}>+ New task</button>
            <div className="bell-wrap">
              <button className="bell" onClick={openBell} aria-label="Notifications">🔔{unread > 0 && <span className="bell-count">{unread > 99 ? "99+" : unread}</span>}</button>
              {bellOpen && (
                <>
                  <div className="bell-shade" onClick={() => setBellOpen(false)} />
                  <div className="bell-pop">
                    <div className="bell-head"><h4>Notifications</h4>{unread > 0 && <button className="link-btn" onClick={markAllRead}>Mark all as read</button>}</div>
                    {notifs.length === 0 && <p className="empty" style={{ padding: 16 }}>You're all caught up.</p>}
                    {notifs.slice(0, 25).map((n) => n.type === "message" ? (
                      <button key={n.id} className={`notif msg ${n.read ? "" : "new"}`} onClick={() => openNotif(n)}>
                        <ContactAvatar name={n.title} channel={n.channel} size={38} />
                        <span className="nbody">
                          <span className="nhead"><b>{n.title}</b><small>{ago(n.at)}</small></span>
                          <span className="nprev">{n.preview}</span>
                          <span className="nmeta">{n.channel}{n.count > 1 && <em>{n.count} new messages</em>}</span>
                        </span>
                        {!n.read && <i className="udot" />}
                      </button>
                    ) : (
                      <button key={n.id} className={`notif ${n.read ? "" : "new"}`} onClick={() => openNotif(n)}>
                        <span className="nbody"><span className="nprev" style={{ color: "inherit" }}>{n.text}</span><span className="nmeta">{ago(n.at)}</span></span>
                        {!n.read && <i className="udot" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button className="user-chip" onClick={() => setAccountOpen(true)} title="Account">
              <Avatar agent={user} size="xs" /><span><b>{user.name}</b><small>{user.role}</small></span>
            </button>
          </div>
        </div>
      </header>

      <main className="wrap">
        {error && <div className="error">Cannot reach the API ({error}). Start the server: <code>cd server &amp;&amp; npm install &amp;&amp; npm start</code></div>}

        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
              {t === "Tasks" && <span className="tab-count">{tasks.length}</span>}
              {t === "My tasks" && <span className="tab-count">{myOpen.length}</span>}
              {t === "Inbox" && convsUnread > 0 && <span className="tab-count hot">{convsUnread}</span>}
              {t === "Agents" && <span className="tab-count">{agents.length}</span>}
            </button>
          ))}
        </nav>

        {tab === "Overview" && !isLead && (
          <>
            <section className="hero">
              <h2>Hi {user.name.split(" ")[0]}.<em>Here's your day.</em></h2>
              <p className="lede">{myOpen.length ? <>You have <b>{myOpen.length}</b> open task{myOpen.length > 1 ? "s" : ""}. Start with the first one below — the list is ordered by priority, then due date.</> : "Nothing is waiting on you right now."}</p>
            </section>

            <section className="kpis">
              <div className="kpi"><div className="k-label">My open tasks</div><div className="k-value">{myOpen.length}</div><div className="k-sub">{user.role}</div></div>
              <div className="kpi"><div className="k-label">Due today or overdue</div><div className="k-value">{myOpen.filter((t) => t.due && dayDiff(t.due) <= 0).length}</div><div className="k-sub">needs attention today</div></div>
              <div className="kpi"><div className="k-label">SLA at risk / missed</div><div className="k-value">{myOpen.filter((t) => ["risk", "breached"].includes(slaView(t, clock)?.cls)).length}</div><div className="k-sub">waiting for your reply</div></div>
              <div className="kpi lime"><div className="k-label">Completed by me</div><div className="k-value">{tasks.filter((t) => t.assignee === user.id && t.pipeline === "Done").length}</div><div className="k-sub">tasks finished</div></div>
            </section>

            <div className="main-grid">
              <aside className="side">
                <section className="panel">
                  <h3>My pipeline</h3>
                  <p className="sub">Where your open tasks sit right now.</p>
                  {PIPELINES.filter((st) => st !== "Done").map((st) => (
                    <div key={st} className="agent-row"><div style={{ flex: 1 }}><div className="a-head"><span className="a-name">{st}</span><span className="a-status grey">{myOpen.filter((t) => t.pipeline === st).length}</span></div></div></div>
                  ))}
                </section>
                <section className="panel">
                  <h3>Notifications</h3>
                  {notifs.length === 0 && <p className="sub">Nothing yet.</p>}
                  {notifs.slice(0, 5).map((n) => (
                    <button key={n.id} className={`notif ${n.read ? "" : "new"}`} onClick={() => { const t = tasks.find((x) => x.id === n.taskId); if (t) setSelected(t); }}><span>{n.text}</span><small>{fmtWhen(n.at)}</small></button>
                  ))}
                </section>
              </aside>

              <div>
                <section className="panel">
                  <h3>Up next</h3>
                  <p className="sub">Your three most urgent tasks.</p>
                  {myOpen.slice(0, 3).map((t, i) => (
                    <div key={t.id} className="assign-row">
                      <span className="rank">{i + 1}</span>
                      <div className="ar-main" onClick={() => setSelected(t)}>
                        <div className="t-title">{t.title}</div>
                        <div className="tags" style={{ marginTop: 6 }}><PriPill p={t.priority} /><SlaTag t={t} now={clock} />{t.escalated && <span className="sla breached">Escalated</span>}</div>
                        <div className="t-meta">{t.pipeline} · {dueLabel(t)}</div>
                      </div>
                      {!t.respondedAt && <button className="btn flat small" onClick={() => respond(t)}>Mark replied</button>}
                    </div>
                  ))}
                  {myOpen.length === 0 && <p className="empty">All clear. 🎉</p>}
                  <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => setTab("My tasks")}>See all my tasks →</button>
                </section>
              </div>
            </div>
          </>
        )}

        {tab === "Overview" && isLead && (
          <>
            <div className="sec-head">
              <div className="t"><h2>Overview</h2><p>Every channel, your team and the pipeline at a glance. Use <b>+ New task</b> to add work yourself.</p></div>
            </div>

            <section className="kpis">
              <div className="kpi"><div className="k-label">Tasks captured</div><div className="k-value">{tasks.length}</div><div className="k-sub">across all {CHANNELS.length} channels</div></div>
              <div className="kpi"><div className="k-label">Completed</div><div className="k-value">{doneCount}</div><div className="k-sub">{tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0}% of everything captured</div></div>
              <div className="kpi"><div className="k-label">Running now</div><div className="k-value">{runningCount}</div><div className="k-sub">agents actively working</div></div>
              <div className="kpi"><div className="k-label">Blocked</div><div className="k-value">{blockedCount}</div><div className="k-sub">waiting on an event or reply</div></div>
              <div className="kpi lime"><div className="k-label">AI time saved</div><div className="k-value">{timeSaved.toFixed(1)}h</div><div className="k-sub">auto-triaged &amp; auto-routed work</div></div>
            </section>

            <div className="main-grid">
              <aside className="side">
                <section className="panel">
                  <h3>Where tasks come from</h3>
                  <p className="sub">Filter the board by channel. Counts update live as tasks move.</p>
                  <button className={`channel ${source === "All" ? "active" : ""}`} onClick={() => setSource("All")}>
                    <span className="ch-icon all" style={{ background: "var(--cream)", color: "#e2ddcd" }}>ALL</span>
                    <span className="ch-body"><div className="ch-name">All channels</div><div className="ch-sub">Every source, one board</div></span>
                    <span className="ch-count">{tasks.length}</span>
                  </button>
                  {CHANNELS.map((c) => (
                    <button key={c} className={`channel ${source === c ? "active" : ""}`} onClick={() => setSource(c)}>
                      <span className="ch-icon" style={{ background: SRC[c].color }}>{SRC[c].abbr}</span>
                      <span className="ch-body">
                        <div className="ch-name">{c}</div>
                        <div className="ch-sub">{SRC[c].sub}</div>
                        <div className="ch-bar"><div style={{ width: `${tasks.length ? (countBySource[c] / tasks.length) * 100 : 0}%`, background: SRC[c].color }} /></div>
                      </span>
                      <span className="ch-count">{countBySource[c]}</span>
                    </button>
                  ))}
                </section>

                <section className="panel">
                  <h3>Team workload</h3>
                  <p className="sub">Who is carrying what right now.</p>
                  {team.map((m) => (
                    <div key={m.id} className="agent-row">
                      <Avatar agent={m} />
                      <div style={{ flex: 1 }}>
                        <div className="a-head"><span className="a-name">{m.name}</span><span className={`a-status ${m.load > 100 ? "" : "grey"}`}>{m.open}/{m.capacity}</span></div>
                        <div className="mini-bar"><div className={m.load > 100 ? "over" : m.load > 75 ? "warn" : ""} style={{ width: `${Math.min(100, m.load)}%` }} /></div>
                      </div>
                    </div>
                  ))}
                  <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setTab("Team")}>Manage team →</button>
                </section>

                <section className="panel">
                  <h3>Your AI agents</h3>
                  <p className="sub">Each agent owns a stage of the pipeline.</p>
                  {agents.map((a) => (
                    <div key={a.id} className="agent-row">
                      <Avatar agent={a} />
                      <div>
                        <div className="a-head">
                          <span className="a-name">{a.name}</span>
                          <span className={`a-status ${a.paused ? "grey" : AGENT_TONE[a.id]}`}>● {a.paused ? "Paused" : a.verb}</span>
                        </div>
                        <div className="a-desc">{a.role} · {openCount(a)} open</div>
                      </div>
                    </div>
                  ))}
                </section>

                <section className="panel">
                  <h3>Channel mix</h3>
                  <p className="sub">Share of open tasks by source.</p>
                  <div className="donut-row">
                    <Donut data={openBySource} total={openTasks.length} />
                    <div className="legend">
                      {openBySource.slice().sort((a, b) => a[1] - b[1]).map(([name, v]) => (
                        <div key={name}><i style={{ background: SRC[name].color }} /><span>{name}</span><b>{v}</b></div>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <h3>Agent actions this week</h3>
                  <p className="sub">Triages, drafts, sends &amp; follow-ups the agents completed per day.</p>
                  <div className="weekbars">
                    {weekBars.bars.map((v, i) => (
                      <div key={WEEK[i]} className="wb"><span>{v}</span><div style={{ height: `${(v / weekBars.max) * 78}%` }} /><span>{WEEK[i]}</span></div>
                    ))}
                  </div>
                </section>
              </aside>

              <div>
                <div className="pipe-head">
                  <h3>Pipeline — Collect → Process → Review → Do → Done</h3>
                  <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" />
                </div>
                <p className="flow-note">New inquiries from every channel land in <b>Collect</b>. Nothing moves by itself: <b>Start working</b> → <b>Process</b> → <b>Review</b> → <b>Do</b> → <b>Done</b>. Your first reply to a customer starts the work automatically.</p>
                <div className="board">
                  {PIPELINES.map((stage) => {
                    const items = displayed.filter((t) => t.pipeline === stage);
                    return (
                      <div key={stage} className={`column ${stage.toLowerCase()}`} onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { try { moveTask(JSON.parse(e.dataTransfer.getData("task")), stage); } catch { /* ignore stray drops */ } }}>
                        <div className="col-head">
                          <span className="col-tag">{stage}</span>
                          <span className="col-count">{items.length}</span>
                          <span className="col-arrow">{stage === "Done" ? "✓" : "→"}</span>
                        </div>
                        <p className="col-help">{STAGE_HELP[stage]}</p>
                        {items.map((t) => (
                          <article key={t.id} className={`card pri-${t.priority}`} draggable onDragStart={(e) => e.dataTransfer.setData("task", JSON.stringify(t))} onClick={() => setSelected(t)}>
                            <div className="card-top"><span className="card-id">{t.id}</span><span className="card-age">{ago(t.createdAt)}</span></div>
                            <p className="card-title">{t.title}</p>
                            <div className="tags"><SrcPill source={t.source} /><PriPill p={t.priority} /><StateTag t={t} />{["Unassigned", "Unscheduled", "In review", "Improving", "Rejected"].includes(t.lifecycle) && <LifeTag t={t} />}{t.pipeline === "Done" && t.billable && <BillTag t={t} />}<SlaTag t={t} now={clock} />{t.escalated && t.pipeline !== "Done" && <span className="sla breached">Escalated</span>}{t.conv?.unread > 0 && <span className="msg-badge">● {t.conv.unread} new</span>}</div>
                            <div className="card-foot">
                              <span>{dueLabel(t)}</span>
                              <span className="agent-chip">{t.assignee && memberById[t.assignee] ? <><Avatar agent={memberById[t.assignee]} size="xs" />{memberById[t.assignee].name.split(" ")[0]}</> : <em className="none">no assignee</em>}</span>
                            </div>
                            {stage === "Collect" && (isLead || !t.assignee || t.assignee === user.id) && (
                              <button className="card-action" onClick={(e) => { e.stopPropagation(); moveTask(t, "Process"); }}>Start working →</button>
                            )}
                          </article>
                        ))}
                      </div>
                    );
                  })}
                </div>

                <section className="panel" style={{ marginTop: 22 }}>
                  <h3>Agent activity</h3>
                  <p className="sub" style={{ marginBottom: 6 }}>Everything the agents do, as it happens in this session.</p>
                  <div className="activity">
                    {activity.map((a) => (
                      <div key={a.id} className="act">
                        <span className="act-time">{timeOf(a.at)}</span>
                        <span className="ai-badge">AI</span>
                        <span><Activity text={a.text} /></span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </>
        )}

        {tab === "Inbox" && <Inbox isLead={isLead} isAdmin={isAdmin} convs={convs} selectedId={selectedConv} setSelectedId={setSelectedConv} refresh={refresh} openTask={openTaskById} showToast={showToast} />}
        {tab === "Contacts" && isLead && <Contacts openConversation={openConversation} isAdmin={isAdmin} showToast={showToast} />}

        {tab === "My tasks" && (
          <section>
            <div className="sec-head">
              <div className="t"><h2>My tasks</h2><p>Only your work, most urgent first — priority, then due date. Reply before the SLA timer runs out.</p></div>
            </div>
            <section className="kpis">
              <div className="kpi"><div className="k-label">Open for me</div><div className="k-value">{myOpen.length}</div><div className="k-sub">assigned to {user.name.split(" ")[0]}</div></div>
              <div className="kpi"><div className="k-label">Urgent / high</div><div className="k-value">{myOpen.filter((t) => ["urgent", "high"].includes(t.priority)).length}</div><div className="k-sub">do these first</div></div>
              <div className="kpi"><div className="k-label">SLA at risk / missed</div><div className="k-value">{myOpen.filter((t) => ["risk", "breached"].includes(slaView(t, clock)?.cls)).length}</div><div className="k-sub">waiting for your reply</div></div>
              <div className="kpi"><div className="k-label">Done by me</div><div className="k-value">{tasks.filter((t) => t.assignee === user.id && t.pipeline === "Done").length}</div><div className="k-sub">completed tasks</div></div>
            </section>
            <div className="panel">
              {myOpen.map((t, i) => {
                const next = PIPELINES[PIPELINES.indexOf(t.pipeline) + 1];
                return (
                  <div key={t.id} className="assign-row">
                    <span className="rank">{i + 1}</span>
                    <div className="ar-main" onClick={() => setSelected(t)}>
                      <div className="t-title">{t.title}</div>
                      <div className="tags" style={{ marginTop: 6 }}><SrcPill source={t.source} /><PriPill p={t.priority} /><StateTag t={t} /><SlaTag t={t} now={clock} />{t.escalated && <span className="sla breached">Escalated</span>}{t.conv?.unread > 0 && <span className="msg-badge">● {t.conv.unread} new</span>}</div>
                      <div className="t-meta">{t.id} · {t.pipeline} · {dueLabel(t)} · {t.category}</div>
                    </div>
                    <div className="btn-wrap">
                      {!t.respondedAt && <button className="btn flat small" onClick={() => respond(t)}>Mark replied</button>}
                      {next && t.pipeline !== "Review" && <button className="btn ghost small" onClick={() => moveTask(t, next)}>→ {next}</button>}
                    </div>
                  </div>
                );
              })}
              {myOpen.length === 0 && <p className="empty">Nothing assigned to you right now. 🎉</p>}
            </div>
          </section>
        )}

        {tab === "Tasks" && (
          <section>
            <div className="sec-head">
              <div className="t"><h2>All tasks</h2><p>One list for everything — filter it, change a state inline, or click a row to open the full task.</p></div>
              <div className="sec-tools">
                <select className="select compact" value={tablePipeline} onChange={(e) => setTablePipeline(e.target.value)} aria-label="Stage"><option value="All">All stages</option>{PIPELINES.map((p) => <option key={p}>{p}</option>)}</select>
                <select className="select compact" value={tableState} onChange={(e) => setTableState(e.target.value)} aria-label="State"><option value="All">All states</option>{[...STATES, "Done"].map((s) => <option key={s}>{s}</option>)}</select>
                <select className="select compact" value={tableLife} onChange={(e) => setTableLife(e.target.value)} aria-label="Lifecycle"><option value="All">All lifecycles</option>{LIFECYCLES.map((l) => <option key={l}>{l}</option>)}</select>
                <select className="select compact" value={tablePriority} onChange={(e) => setTablePriority(e.target.value)} aria-label="Priority"><option value="All">All priorities</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRI_LABEL[p][0] + PRI_LABEL[p].slice(1).toLowerCase()}</option>)}</select>
                {isLead && <button className="btn flat small" onClick={simulateIncoming}>Simulate incoming</button>}
              </div>
            </div>
            <div className="table-wrap">
              <table className="task-table">
                <thead><tr><th>Task</th><th>Source</th><th>Stage</th><th>Lifecycle</th><th>Type</th><th>Billing</th><th>Priority</th><th>SLA</th><th>Assignee</th><th>Agent</th><th>Progress</th><th>State</th></tr></thead>
                <tbody>
                  {tableRows.map((t) => (
                    <tr key={t.id} className="row" onClick={() => setSelected(t)}>
                      <td><div className="t-title">{t.title}</div><div className="t-meta">{t.id} · {dueLabel(t)}</div></td>
                      <td><SrcPill source={t.source} /></td>
                      <td>{t.pipeline}</td>
                      <td><LifeTag t={t} /></td>
                      <td>{t.category}<div className="t-meta">{t.department}</div></td>
                      <td><BillTag t={t} /></td>
                      <td><PriPill p={t.priority} /></td>
                      <td><SlaTag t={t} now={clock} />{t.escalated && <span className="sla breached">Escalated</span>}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {isLead ? (
                          <select className="select compact" value={t.assignee || ""} onChange={(e) => assignTo(t, e.target.value)} aria-label="Assignee">
                            <option value="">Unassigned</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                        ) : (memberById[t.assignee]?.name || "—")}
                      </td>
                      <td>{t.agent || <em className="none">—</em>}</td>
                      <td><div className="mini-bar"><div style={{ width: `${t.progress}%` }} /></div><div className="mini-pct">{t.progress}%</div></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select className="select compact" value={t.pipeline === "Done" ? "Done" : t.state} disabled={t.pipeline === "Done"} onChange={(e) => changeState(t, e.target.value)}>
                          {t.pipeline === "Done" ? <option>Done</option> : STATES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tableRows.length === 0 && <p className="empty">No tasks match these filters.</p>}
              <p className="table-foot">{tableRows.length} of {tasks.length} tasks shown. Click a row to open the full task.</p>
            </div>
          </section>
        )}

        {tab === "Calendar" && (
          <section>
            <div className="sec-head"><div className="t"><h2>Schedule</h2><p>Tasks grouped by when they're due. Click any card to open it.</p></div></div>
            <div className="cal">
              {calendar.order.map((b) => {
                const items = calendar.groups[b] || [];
                return (
                  <div key={b} className="cal-col">
                    <h4>{b}<span>{items.length}</span></h4>
                    {items.map((t) => (
                      <div key={t.id} className="cal-card" onClick={() => setSelected(t)}>
                        <p>{t.title}</p>
                        <div className="tags"><SrcPill source={t.source} /><StateTag t={t} /><PriPill p={t.priority} /></div>
                      </div>
                    ))}
                    {!items.length && <p className="empty">Nothing here.</p>}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {tab === "Team" && (
          <section>
            <div className="sec-head">
              <div className="t"><h2>Team</h2><p>Your people. Assign tasks by hand, or let Smart assign balance work by department and spare capacity.</p></div>
              <button className="btn" onClick={smartAssign}>Smart assign {openTasks.filter((t) => !t.assignee).length} unassigned</button>
            </div>
            <div className="agent-grid">
              {team.map((m) => (
                <div key={m.id} className="agent-card member">
                  <div className="ac-top">
                    <Avatar agent={m} />
                    <div><h3>{m.name}</h3><span className="a-status grey">{m.role} · {m.department} · {m.access}</span></div>
                  </div>
                  <div className="load-row"><div className="mini-bar"><div className={m.load > 100 ? "over" : m.load > 75 ? "warn" : ""} style={{ width: `${Math.min(100, m.load)}%` }} /></div><span>{m.open}/{m.capacity} capacity</span></div>
                  <div className="agent-stats">
                    <div><b>{m.open}</b>open</div><div><b>{m.urgent}</b>urgent</div><div><b>{m.overdue}</b>overdue</div><div><b>{m.done}</b>done</div>
                  </div>
                  <div className="btn-wrap">
                    <button className="btn ghost small" hidden={!isAdmin} onClick={() => setEditing({ ...m, email: m.email || "", phone: m.phone || "", password: "" })}>Edit</button>
                    <button className="btn ghost small" onClick={() => setTeamFilter(teamFilter === m.id ? "All" : m.id)}>{teamFilter === m.id ? "Show unassigned" : "View tasks"}</button>
                    <button className="btn danger small" hidden={!isAdmin || m.id === user.id} onClick={async () => { if (window.confirm(`Remove ${m.name}? Their open tasks become unassigned.`)) { await api.removeMember(m.id); setTeamFilter("All"); await refresh(); showToast(`${m.name} removed`); } }}>Remove</button>
                  </div>
                  {m.load > 100 && <p className="warn-note">Over capacity — move something to a teammate.</p>}
                </div>
              ))}
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <h3>{teamFilter === "All" ? "Unassigned open tasks" : `Open tasks — ${memberById[teamFilter]?.name}`}</h3>
              <p className="sub">{teamFilter === "All" ? "Pick a person to hand each task over." : "Reassign any task to someone else."}</p>
              {(teamFilter === "All" ? openTasks.filter((t) => !t.assignee) : openTasks.filter((t) => t.assignee === teamFilter)).map((t) => (
                <div key={t.id} className="assign-row">
                  <div className="ar-main" onClick={() => setSelected(t)}><div className="t-title">{t.title}</div><div className="t-meta">{t.id} · {t.pipeline} · {dueLabel(t)}</div></div>
                  <PriPill p={t.priority} />
                  <select className="select compact" value={t.assignee || ""} onChange={(e) => assignTo(t, e.target.value)} aria-label="Assign to">
                    <option value="">Unassigned</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              ))}
              {(teamFilter === "All" ? openTasks.filter((t) => !t.assignee) : openTasks.filter((t) => t.assignee === teamFilter)).length === 0 && <p className="empty">Nothing here — all clear.</p>}
            </div>

            {isAdmin && <form className="panel member-form" onSubmit={addTeamMember} style={{ marginTop: 16 }}>
              <h3>Add a team member</h3>
              <div className="edit-grid">
                <label><span className="field-label">Name</span><input className="input" value={newMember.name} onChange={(e) => setNewMember({ ...newMember, name: e.target.value })} placeholder="e.g. Hina Raza" /></label>
                <label><span className="field-label">Role</span><input className="input" value={newMember.role} onChange={(e) => setNewMember({ ...newMember, role: e.target.value })} placeholder="e.g. Sales Executive" /></label>
                <label><span className="field-label">Department</span>
                  <select className="select" value={newMember.department} onChange={(e) => setNewMember({ ...newMember, department: e.target.value })}>{(settings?.departments || []).map((d) => <option key={d}>{d}</option>)}</select></label>
                <label><span className="field-label">Email</span><input type="email" className="input" value={newMember.email || ""} onChange={(e) => setNewMember({ ...newMember, email: e.target.value })} placeholder="name@company.com" /></label>
                <label><span className="field-label">Username</span><input className="input" value={newMember.username} onChange={(e) => setNewMember({ ...newMember, username: e.target.value })} placeholder="login name" /></label>
                <label><span className="field-label">Starting password (min 8)</span><input type="password" className="input" autoComplete="new-password" value={newMember.password} onChange={(e) => setNewMember({ ...newMember, password: e.target.value })} /></label>
                <label><span className="field-label">Access</span>
                  <select className="select" value={newMember.access} onChange={(e) => setNewMember({ ...newMember, access: e.target.value })}>
                    <option value="member">Member — sees only own tasks</option><option value="lead">Lead — sees department, gets escalations</option><option value="admin">Admin — sees everything</option>
                  </select></label>
                <label><span className="field-label">Capacity (open tasks)</span><input type="number" min="1" className="input" value={newMember.capacity} onChange={(e) => setNewMember({ ...newMember, capacity: e.target.value })} /></label>
              </div>
              <button className="btn" type="submit" style={{ marginTop: 12 }}>Add member</button>
            </form>}
          </section>
        )}

        {tab === "Agents" && (
          <section>
            <div className="sec-head"><div className="t"><h2>AI agents</h2><p>Five agents, each with one job. What you see below is what they have really done, updated live.</p></div></div>
            <div className="ag-flow">
              {["scout", "triage", "scribe", "runner"].map((id, i) => (
                <Fragment key={id}>{i > 0 && <span className="ag-arrow">→</span>}<span className="ag-step"><b>{agents.find((x) => x.id === id)?.name}</b><small>{AGENT_INFO[id].stage}</small></span></Fragment>
              ))}
              <span className="ag-step watch"><b>{agents.find((x) => x.id === "hawk")?.name}</b><small>watches every stage</small></span>
              <p className="ag-flow-note">A customer message arrives (Scout), gets sorted and assigned (Triage), gets a reply draft (Scribe), a lead approves it, and Runner sends it. Hawk makes sure nobody waits too long.</p>
            </div>
            <div className="ag-grid">
              {agents.map((a) => {
                const info = AGENT_INFO[a.id];
                const v = info && agentAct?.[a.id] ? info.view(agentAct[a.id]) : null;
                return (
                  <article key={a.id} className="ag-card">
                    <header className="ag-head">
                      <Avatar agent={a} />
                      <div className="ag-title"><h3>{a.name}</h3><span className="ag-stage">{info?.stage}</span></div>
                      {v && <span className={`ag-light ${v.health.tone}`} title={v.health.text} />}
                    </header>
                    <p className="ag-purpose"><b>Purpose:</b> {info?.purpose || a.role}</p>
                    <h4>How it works</h4>
                    <ol className="ag-steps">{(info?.steps || []).map((x, i) => <li key={i}>{x}</li>)}</ol>
                    <h4>Live activity</h4>
                    {v ? (
                      <>
                        <div className="ag-stats">{v.stats.map(([n, label]) => <div key={label}><b>{n}</b><span>{label}</span></div>)}</div>
                        <p className={`ag-health ${v.health.tone}`}>{v.health.text}</p>
                        <p className="ag-last">{v.lastLabel}: {ago2(v.last)}</p>
                      </>
                    ) : <p className="drawer-notes">Loading…</p>}
                    {a.id === "runner" && settings && (
                      <div className="ag-switch"><Switch on={!!settings.runnerAutoSend} label="Runner sends approved replies" onClick={() => saveSettings({ runnerAutoSend: !settings.runnerAutoSend })} /><span>{settings.runnerAutoSend ? "Runner sends approved replies" : "Runner is off — send replies by hand"}</span></div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {tab === "Analytics" && (
          <section>
            <div className="sec-head"><div className="t"><h2>Analytics</h2><p>Live from your tasks.</p></div></div>
            <div className="kpis four" style={{ marginTop: 0 }}>
              <div className="kpi"><div className="k-label">Completion</div><div className="k-value">{tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0}%</div><div className="k-sub">{doneCount} of {tasks.length} done</div></div>
              <div className="kpi"><div className="k-label">Open</div><div className="k-value">{openTasks.length}</div><div className="k-sub">still in the pipeline</div></div>
              <div className="kpi"><div className="k-label">Blocked</div><div className="k-value">{blockedCount}</div><div className="k-sub">waiting on an event</div></div>
              <div className="kpi lime"><div className="k-label">AI time saved</div><div className="k-value">{timeSaved.toFixed(1)}h</div><div className="k-sub">estimate</div></div>
            </div>
            <div className="charts-grid">
              <BarChart title="Pipeline" data={PIPELINES.map((p) => [p, tasks.filter((t) => t.pipeline === p).length])} />
              <BarChart title="State" data={STATES.map((s) => [s, tasks.filter((t) => t.state === s && t.pipeline !== "Done").length])} />
              <BarChart title="Channel" data={CHANNELS.map((c) => [c, countBySource[c]])} />
              <BarChart title="Priority" data={PRIORITIES.map((p) => [PRI_LABEL[p], tasks.filter((t) => t.priority === p).length])} />
              <BarChart title="Lifecycle" data={LIFECYCLES.map((l) => [l, tasks.filter((t) => t.lifecycle === l).length])} />
              <BarChart title="Type" data={TYPES.map((x) => [x, tasks.filter((t) => t.category === x).length]).filter(([, v]) => v)} />
              <BarChart title="Department" data={(settings?.departments || []).map((d) => [d, tasks.filter((t) => t.department === d).length])} />
              <BarChart title="Billing" data={[["Billable", tasks.filter((t) => t.billable).length], ["Unbillable", tasks.filter((t) => !t.billable).length], ["Billed", tasks.filter((t) => t.billable && t.billing === "Billed").length], ["Unbilled", tasks.filter((t) => t.billable && t.billing !== "Billed").length]]} />
            </div>
          </section>
        )}

        {tab === "Organization" && gov && (
          <section>
            <div className="sec-head"><div className="t"><h2>Organization</h2><p>Where the work sits, the rules it must follow and how it's scored — all computed live from your tasks.</p></div></div>

            <div className="ladder">
              {[
                ["Mandate", gov.org.mandate, null],
                ["Office", gov.org.office, null],
                ["Project", null, gov.projects.map((p) => [p, gov.byProject[p]])],
                ["Organization", gov.org.organization, null],
                ["Department", null, gov.departments.map((d) => [d, gov.byDepartment[d]])],
              ].map(([level, name, chips], i) => (
                <div key={level} className="rung">
                  <span className="rung-n">{i + 1}</span>
                  <div className="rung-level">{level}</div>
                  {name && <div className="rung-name">{name}</div>}
                  {chips && <div className="rung-chips">{chips.map(([n, c]) => <span key={n} className="chip-count">{n}<b>{c}</b></span>)}</div>}
                </div>
              ))}
            </div>

            <div className="gov-grid">
              <div className="panel">
                <h3>Policies</h3>
                <p className="sub">Rules every task must follow. Broken rules list the tasks to fix.</p>
                {gov.policies.map((p) => (
                  <div key={p.id} className={`policy ${p.ok ? "ok" : "bad"}`}>
                    <div className="policy-head">
                      <span className="policy-flag">{p.ok ? "✓ Compliant" : `${p.tasks.length} to fix`}</span>
                      <b>{p.rule}</b>
                    </div>
                    <div className="policy-hint">{p.hint}</div>
                    {p.tasks.map((t) => <button key={t.id} className="policy-task" onClick={() => setSelectedId(t.id)}>{t.id} · {shorten(t.title, 52)}</button>)}
                  </div>
                ))}
              </div>

              <div className="panel">
                <h3>KPIs</h3>
                <p className="sub">Measured now against a target.</p>
                {gov.kpis.map((k) => (
                  <div key={k.id} className="kpi-row">
                    <div><b>{k.name}</b><div className="policy-hint">Target {k.higherIsBetter ? "≥" : "≤"} {k.target}{k.unit}</div></div>
                    <span className={`kpi-val ${k.met ? "met" : "miss"}`}>{k.value}{k.unit}</span>
                  </div>
                ))}
              </div>

              <div className="panel">
                <h3>OKRs</h3>
                <p className="sub">Objectives and the key results that prove them.</p>
                {gov.okrs.map((o) => (
                  <div key={o.id} className="okr">
                    <div className="okr-obj"><span className="okr-tag">{o.id}</span>{o.objective}</div>
                    {o.keyResults.map((k) => (
                      <div key={k.text} className="kr">
                        <div className="kr-top"><span>{k.text}</span><b>{k.progress}%</b></div>
                        <div className="mini-bar wide"><div style={{ width: `${k.progress}%` }} /></div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {tab === "Projects" && <ProjectsTab isLead={isLead} team={team} tasks={tasks} onOpenTask={openTaskById} showToast={showToast} refresh={refresh} />}

        {tab === "Automations" && settings && (
          <section className="panel wide">
            <h3 style={{ fontSize: 22 }}>Automations</h3>
            <p className="sub">These toggles really change behaviour: Auto-move off stops Autopilot ticks from moving tasks, Auto-unblock off stops blocked tasks waking, and pausing an agent makes Autopilot skip its tasks.</p>
            {AUTOMATIONS.map((a) => (
              <div key={a.key} className="toggle-row">
                <span><strong>{a.title}</strong><small>{a.desc}</small></span>
                <Switch on={!!settings[a.key]} label={a.title} onClick={() => saveSettings({ [a.key]: !settings[a.key] })} />
              </div>
            ))}
            <div className="btn-row">
              <button className="btn" onClick={async () => { await api.ingestBurst(CHANNELS.filter((c) => !settings.pausedChannels.includes(c))); await refresh(); showToast("Incoming burst: 1 task added from each channel"); }}>Simulate an incoming burst</button>
              <button className="btn ghost" onClick={async () => { const r = await api.digest(); showToast(r.message); await refresh(); }}>Generate status digest</button>
            </div>
          </section>
        )}

        {tab === "Settings" && settings && (
          <section className="panel wide">
            <h3 style={{ fontSize: 22, marginBottom: 6 }}>Settings</h3>
            <label className="field"><span className="field-label">Workspace name</span><input className="input" value={workspace} onChange={(e) => setWorkspace(e.target.value)} /></label>
            <label className="field"><span className="field-label">AI default priority for new tasks</span>
              <select className="select" value={defaultPriority} onChange={(e) => setDefaultPriority(e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRI_LABEL[p][0] + PRI_LABEL[p].slice(1).toLowerCase()}</option>)}</select>
            </label>
            <label className="field"><span className="field-label">Autopilot pace (seconds between ticks)</span>
              <select className="select" value={paceSec} onChange={(e) => setPaceSec(Number(e.target.value))}>{[5, 8, 15, 30, 60].map((n) => <option key={n} value={n}>{n}s</option>)}</select>
            </label>
            <h3 style={{ marginTop: 26 }}>Channels &amp; alerts</h3>
            {integ && (
              <div className="conn-list">
                {[
                  ["WhatsApp (send replies)", integ.whatsapp, "WHATSAPP_TOKEN + WHATSAPP_PHONE_ID"],
                  ["Facebook Messenger (send replies)", integ.facebook, "FB_PAGE_TOKEN"],
                  ["Incoming messages webhook", integ.webhookReady, "META_VERIFY_TOKEN + META_APP_SECRET"],
                  ["Website form key", integ.websiteKeySet, "WEBSITE_FORM_KEY"],
                  ["Email alerts to the team", integ.email, "SMTP_HOST + SMTP_USER + SMTP_PASS"],
                ].map(([label, on, keys]) => (
                  <div key={label} className="conn-row"><span className={`dot-state ${on ? "on" : ""}`} /><span>{label}</span><small>{on ? "connected" : `needs ${keys}`}</small></div>
                ))}
                <p className="sub" style={{ margin: "8px 0 0" }}>Webhook URL to give Meta: <code>https://YOUR-PUBLIC-ADDRESS/api/webhooks/meta</code> (must be public https — see the README for the steps).{integ.sent && (integ.sent.email || integ.sent.whatsapp) ? ` Alerts sent: ${integ.sent.email} email, ${integ.sent.whatsapp} WhatsApp.` : ""}{integ.lastDeliveryError ? <span className="warn-note"> Last delivery error: {integ.lastDeliveryError}</span> : null}</p>
              </div>
            )}
            {isAdmin && (
              <>
                <h3 style={{ marginTop: 26 }}>Connect your accounts (API keys)</h3>
                <p className="sub" style={{ marginBottom: 6 }}>Paste a key, press <b>Save</b>, then <b>Test connection</b>. Keys are stored only on your server and are never shown again — leave a box empty to keep what is saved.</p>
                {[
                  ["whatsapp", "WhatsApp", [["WHATSAPP_PHONE_ID", "Phone number ID"], ["WHATSAPP_TOKEN", "Access token"]]],
                  ["facebook", "Facebook Page", [["FB_PAGE_TOKEN", "Page access token"]]],
                  [null, "Meta webhook (both)", [["META_VERIFY_TOKEN", "Verify token (any word you invent)"], ["META_APP_SECRET", "App secret"]]],
                  [null, "Website form", [["WEBSITE_FORM_KEY", "Form key (any long random text)"]]],
                  ["email", "Email alerts", [["SMTP_HOST", "SMTP host (Gmail: smtp.gmail.com)"], ["SMTP_PORT", "SMTP port (587)"], ["SMTP_USER", "SMTP user"], ["SMTP_PASS", "SMTP password / app password"], ["MAIL_FROM", "From name <address> (optional)"]]],
                  ["groq", "Groq AI", [["GROQ_API_KEY", "Groq API key"]]],
                ].map(([ch, title, fields]) => (
                  <div key={title} className="cfg-group">
                    <div className="cfg-head"><b>{title}</b>
                      <span className="btn-wrap">
                        {ch === "facebook" && <button type="button" className="btn flat small" onClick={async () => { try { const r = await api.syncFacebook(); setTestRes((x) => ({ ...x, facebook: r.error ? { ok: false, message: r.error } : { ok: true, message: r.imported ? `Imported ${r.imported} missed message${r.imported > 1 ? "s" : ""} into Tasks.` : "Checked your Page inbox — nothing new to import." } })); await refresh(); } catch (err) { setTestRes((x) => ({ ...x, facebook: { ok: false, message: err.message } })); } }}>Sync messages now</button>}
                        {ch === "facebook" && <button type="button" className="btn flat small" onClick={async () => { try { const r = await api.subscribeFacebookPage(); setTestRes((x) => ({ ...x, facebook: r })); } catch (err) { setTestRes((x) => ({ ...x, facebook: { ok: false, message: err.message } })); } }}>Subscribe Page</button>}
                        {ch && <button type="button" className="btn ghost small" disabled={testRes[ch]?.busy} onClick={() => runTest(ch)}>{testRes[ch]?.busy ? "Testing…" : "Test connection"}</button>}
                      </span>
                    </div>
                    {testRes[ch] && !testRes[ch].busy && <p className={`cfg-result ${testRes[ch].ok ? "ok" : "bad"}`}>{testRes[ch].ok ? "✓ " : "✗ "}{testRes[ch].message}</p>}
                    <div className="edit-grid">
                      {fields.map(([key, label]) => (
                        <label key={key}><span className="field-label">{label}</span>
                          <input className="input" type={/TOKEN|SECRET|PASS|KEY/.test(key) && key !== "META_VERIFY_TOKEN" ? "password" : "text"} autoComplete="off"
                            value={cfgDraft[key] ?? ""} onChange={(e) => setCfgDraft({ ...cfgDraft, [key]: e.target.value })}
                            placeholder={cfgHints[key]?.set ? `saved ${cfgHints[key].hint}` : "not set"} /></label>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="btn-row"><button type="button" className="btn" disabled={!Object.values(cfgDraft).some((v) => v?.trim())} onClick={saveCfg}>Save keys</button></div>
              </>
            )}
            <h3 style={{ marginTop: 26 }}>Groq AI</h3>
            <p className="sub" style={{ marginBottom: 6 }}>
              {ai?.enabled
                ? <>Connected · model <b>{ai.model}</b> · {ai.calls} calls{ai.failures ? ` · ${ai.failures} failed` : ""}{ai.lastError ? <span className="warn-note"> · last error: {ai.lastError}</span> : null}</>
                : <>Not connected — triage uses keyword rules. Add <code>GROQ_API_KEY=your_key</code> to <code>server/.env</code> and restart the server. Get a key at console.groq.com.</>}
            </p>
            <h3 style={{ marginTop: 26 }}>SLA timers (minutes to first reply)</h3>
            <p className="sub" style={{ marginBottom: 6 }}>If nobody replies in time, Hawk escalates the task to the department lead and the admin.</p>
            <div className="edit-grid">
              {PRIORITIES.map((p) => (
                <label key={p}><span className="field-label">{PRI_LABEL[p][0] + PRI_LABEL[p].slice(1).toLowerCase()}</span>
                  <input type="number" min="5" className="input" value={slaDraft[p] ?? settings.sla?.[p] ?? ""} onChange={(e) => setSlaDraft({ ...slaDraft, [p]: e.target.value })} /></label>
              ))}
            </div>
            <h3 style={{ marginTop: 26 }}>Organization</h3>
            {[["mandate", "Mandate"], ["office", "Office"], ["organization", "Organization"]].map(([k, label]) => (
              <label key={k} className="field"><span className="field-label">{label}</span><input className="input" value={orgDraft[k] ?? settings.org?.[k] ?? ""} onChange={(e) => setOrgDraft({ ...orgDraft, [k]: e.target.value })} /></label>
            ))}
            <h3 style={{ marginTop: 26 }}>Pause channels</h3>
            <p className="sub" style={{ marginBottom: 0 }}>Paused channels reject new simulated tasks until you unpause them.</p>
            {CHANNELS.map((ch) => (
              <div key={ch} className="toggle-row">
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}><span className="ch-icon" style={{ background: SRC[ch].color, width: 32, height: 32, fontSize: 11 }}>{SRC[ch].abbr}</span>{ch}</span>
                <Switch on={settings.pausedChannels.includes(ch)} label={`Pause ${ch}`} onClick={() => toggleChannel(ch)} />
              </div>
            ))}
            <div className="btn-row">
              <button className="btn" onClick={() => saveSettings({ workspace, defaultPriority, org: { ...settings.org, ...orgDraft }, sla: { ...settings.sla, ...Object.fromEntries(Object.entries(slaDraft).map(([k, v]) => [k, Number(v)])) } })}>Save settings</button>
              <button className="btn danger" hidden={!isAdmin} onClick={async () => { if (window.confirm("Reset every task to the sample tasks?")) { await api.reset(); await refresh(); showToast("Board reset to the sample tasks"); } }}>Reset board</button>
            </div>
          </section>
        )}

        <footer className="foot">
          <span>Agentic Task Management System — tasks from Facebook, WhatsApp, Email, LinkedIn &amp; your website, run by AI agents.</span>
          <span>Demo workspace · state lives in this session only</span>
        </footer>
      </main>

      {selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
            <header className="dr-head">
              <button className="close" onClick={() => setSelected(null)} aria-label="Close">✕</button>
              <div className="tags"><span className="id-chip">{selected.id}</span><SrcPill source={selected.source} /><PriPill p={selected.priority} /><StateTag t={selected} /><LifeTag t={selected} /><BillTag t={selected} /></div>
              <h2>{selected.title}</h2>
              <p className="dr-sub">Created {fmtWhen(selected.createdAt)} · via {selected.source}{selected.assignee && memberById[selected.assignee] ? ` · assigned to ${memberById[selected.assignee].name}` : " · unassigned"}</p>
              {selected.notes && <p className="drawer-notes dr-quote">{selected.notes}</p>}
            </header>
            <div className="dr-body">
              <div className="dr-main">

            {(() => {
              const st = selected.pipeline, mine = isLead || !selected.assignee || selected.assignee === user.id;
              return (
                <div className={`wf-bar wf-${st.toLowerCase()}`}>
                  <div className="wf-top"><span className="wf-stage">{st}</span><span className="wf-help">{STAGE_HELP[st]}</span></div>
                  {selected.contact && st !== "Done" && !selected.respondedAt && <p className="wf-warn">No reply has been sent to the customer yet.</p>}
                  {st === "Do" && selected.runner?.status === "sent" && <p className="wf-ok">✓ Runner sent the approved reply to the customer.</p>}
                  {st === "Do" && selected.runner?.status === "failed" && <p className="wf-warn" style={{ color: "#ff8a8a", background: "rgba(229,72,77,.12)" }}>Runner could not send the reply: {selected.runner.error}</p>}
                  {st === "Do" && !selected.contact && <p className="wf-note" style={{ display: "block", marginBottom: 8 }}>Runner has nothing to send for this task — carry out the work, then mark it done.</p>}
                  <div className="btn-wrap">
                    {st === "Collect" && mine && <button className="btn small" onClick={() => moveTask(selected, "Process")}>Start working →</button>}
                    {st === "Process" && mine && <button className="btn small" onClick={() => moveTask(selected, "Review")}>Submit for review →</button>}
                    {st === "Process" && mine && <button className="btn flat small" onClick={() => resolveTask(selected)}>Resolve &amp; close ✓</button>}
                    {st === "Do" && mine && <button className="btn small" onClick={() => resolveTask(selected)}>Mark as done ✓</button>}
                    {st === "Do" && mine && selected.contact && selected.draft && !selected.respondedAt && <button className="btn flat small" onClick={async () => { try { await api.runTask(selected.id); await refresh(); } catch (err) { showToast(err.message); } }}>{selected.runner?.status === "failed" ? "Retry: Runner sends reply" : "Runner: send approved reply now"}</button>}
                    {st === "Done" && mine && <button className="btn ghost small" onClick={() => moveTask(selected, "Process")}>Reopen</button>}
                    {st === "Review" && <span className="wf-note">{isLead ? "Use Approve / Improve / Reject below." : "Waiting for a team lead."}</span>}
                    {!mine && <span className="wf-note">Assigned to {memberById[selected.assignee]?.name || "someone else"}.</span>}
                  </div>
                </div>
              );
            })()}

            <h4>SLA · first response</h4>
            <div className={`sla-box ${slaView(selected, clock)?.cls || ""}`}>
              <div><SlaTag t={selected} now={clock} /> <small>due {fmtWhen(selected.sla.dueAt)} · {selected.priority} tasks get an answer within {settings?.sla?.[selected.priority] ?? "?"} min</small></div>
              {selected.escalated && <p className="warn-note" style={{ margin: "8px 0 0" }}>Escalated to {(selected.escalatedTo || []).map((id) => memberById[id]?.name).filter(Boolean).join(", ")} on {fmtWhen(selected.escalatedAt)}.</p>}
              {!selected.respondedAt && <button className="btn flat small" style={{ marginTop: 10 }} onClick={() => respond(selected)}>Mark as replied</button>}
            </div>

            <h4>Scribe · reply draft {selected.aiBy && <span className="ai-badge">{selected.aiBy === "Groq" ? "Groq AI" : "rules"}</span>}</h4>
            {selected.aiReason && <p className="drawer-notes" style={{ marginTop: 0 }}>AI suggestion: {selected.aiReason}</p>}
            {selected.contact && (
              <div className="conv-card">
                <div className="conv-card-head">
                  <ContactAvatar name={selected.contact.name} channel={selected.contact.channel} size={38} />
                  <div className="cc-title"><b>{selected.contact.name}</b><small>{selected.contact.channel}{selected.contact.kind === "comment" ? " · public comment" : ""}{drawerConv ? ` · ${drawerConv.messages.length} message${drawerConv.messages.length === 1 ? "" : "s"}` : ""}</small></div>
                  <button className="btn ghost small" onClick={() => { const id = selected.contact.convId || selected.contact.key; setSelected(null); openConversation(id); }}>Open conversation →</button>
                </div>
                <div className="conv-mini">
                  {(drawerConv?.messages || []).slice(-4).map((m) => (
                    <div key={m.id} className={`mini-msg ${m.dir}`}><span>{m.text}</span><small>{m.dir === "out" ? `${m.by} · ` : ""}{ago(m.at)}</small></div>
                  ))}
                  {!drawerConv && <p className="drawer-notes" style={{ margin: 0 }}>Loading conversation…</p>}
                </div>
              </div>
            )}
            {selected.draft ? <textarea className="textarea draft-edit" rows={5} value={draftEdits[selected.id] ?? selected.draft} onChange={(e) => setDraftEdits({ ...draftEdits, [selected.id]: e.target.value })} onBlur={() => { const v = draftEdits[selected.id]; if (v !== undefined && v !== selected.draft) patchTask(selected, { draft: v }); }} /> : <p className="drawer-notes">{ai?.enabled === false ? "No draft yet. Connect Groq (server/.env) and Scribe will write replies for you." : "No draft yet — ask Scribe to write one."}</p>}
            <div className="btn-wrap" style={{ marginTop: 10 }}>
              <button className="btn ghost small" disabled={aiBusy} onClick={() => aiAction(() => api.draft(selected.id), "Scribe wrote a new draft")}>{aiBusy ? "Working…" : selected.draft ? "Rewrite with Groq" : "Write draft with Groq"}</button>
              {selected.draft && <button className="btn ghost small" onClick={() => { navigator.clipboard?.writeText(draftEdits[selected.id] ?? selected.draft); showToast("Draft copied"); }}>Copy</button>}
              {selected.draft && selected.contact && ["WhatsApp", "Facebook", "Instagram"].includes(selected.contact.channel) && <button className="btn flat small" disabled={aiBusy} onClick={() => sendReply(selected, draftEdits[selected.id] ?? selected.draft)}>Send via {selected.contact.channel}</button>}
              {isLead && <button className="btn ghost small" disabled={aiBusy} onClick={() => aiAction(() => api.retriage(selected.id), "Groq re-triaged this task")}>Re-triage with Groq</button>}
            </div>

            {selected.pipeline === "Review" && !isLead && <p className="drawer-notes">Waiting for a team lead to approve, improve or reject.</p>}
            {selected.pipeline === "Review" && isLead && (
              <div className="review-box">
                <h4 style={{ marginTop: 0 }}>Review — your decision</h4>
                <textarea className="textarea" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Optional note — what should be improved, or why it's rejected…" />
                <div className="btn-wrap" style={{ marginTop: 10 }}>
                  <button className="btn flat small" onClick={() => decide(selected, "approve")}>Approve → Do</button>
                  <button className="btn ghost small" onClick={() => decide(selected, "improve")}>Improve → Process</button>
                  <button className="btn danger small" onClick={() => decide(selected, "reject")}>Reject</button>
                </div>
              </div>
            )}
            {selected.review && selected.pipeline !== "Review" && (
              <p className="drawer-notes" style={{ marginTop: 12 }}>
                Review: <b>{selected.review.decision === "approve" ? "Approved" : selected.review.decision === "improve" ? "Improve requested" : "Rejected"}</b> by {selected.review.by}{selected.review.note ? ` — “${selected.review.note}”` : ""}{selected.revisions ? ` · ${selected.revisions} revision${selected.revisions > 1 ? "s" : ""}` : ""}
              </p>
            )}

            <h4>Internal notes</h4>
            <div className="comments">
              {(selected.comments || []).filter((c) => c.kind !== "customer" && c.kind !== "sent").map((c) => (
                <div key={c.id} className={`comment ${c.kind || ""}`}>
                  <div className="c-head"><b>{c.by}</b>{c.kind === "customer" && <span className="ai-badge">customer</span>}{c.kind === "sent" && <span className="ai-badge">sent</span>}<small>{fmtWhen(c.at)}</small></div>
                  <p>{c.text}</p>
                </div>
              ))}
              {!(selected.comments || []).filter((c) => c.kind !== "customer" && c.kind !== "sent").length && <p className="drawer-notes" style={{ marginTop: 0 }}>No comments yet. Mention a teammate with @name and they get notified and can open this task.</p>}
            </div>
            <form onSubmit={postComment}>
              <textarea className="textarea" rows={2} value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Write a comment… use @name to mention someone" />
              <div className="btn-wrap" style={{ marginTop: 8 }}>
                {team.filter((m) => m.id !== user.id).map((m) => <button key={m.id} type="button" className="chip" onClick={() => setCommentText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${m.name.split(" ")[0].toLowerCase()} `)}>@{m.name.split(" ")[0]}</button>)}
                <button className="btn flat small" type="submit" disabled={!commentText.trim()}>Post comment</button>
              </div>
            </form>

              </div>
              <aside className="dr-side">
            <h4>A · Process — stage</h4>
            <div className="track">
              {PIPELINES.map((p, i) => (
                <span key={p} className={`step ${PIPELINES.indexOf(selected.pipeline) > i ? "done" : ""} ${selected.pipeline === p ? "current" : ""}`}>{p}</span>
              ))}
            </div>

            <h4>B · Lifecycle</h4>
            <div className="track">
              {LIFE_STEPS.map((label, i) => {
                const cur = lifeStepIndex(selected);
                let text = label;
                if (i === 2 && cur === 2) text = selected.lifecycle;
                if (i === 5 && cur === 5) text = { Approved: "Approve", Improving: "Improve", Rejected: "Reject" }[selected.lifecycle];
                return <span key={label} className={`step ${cur > i ? "done" : ""} ${cur === i ? "current" : ""}`}>{text}</span>;
              })}
            </div>

            <h4>C–E · Task profile</h4>
            <div className="edit-grid">
              <label><span className="field-label">Team member</span>
                <select className="select" disabled={!isLead} value={selected.assignee || ""} onChange={(e) => assignTo(selected, e.target.value)}>
                  <option value="">Unassigned</option>{team.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role} ({m.open} open)</option>)}
                </select></label>
              <label><span className="field-label">AI agent</span>
                <select className="select" value={selected.agent || ""} onChange={(e) => patchTask(selected, { agent: e.target.value || null })}>
                  <option value="">Unassigned</option>{OWNERS.map((o) => <option key={o}>{o}</option>)}
                </select></label>
              <label><span className="field-label">Scheduled (due)</span>
                <input type="date" className="input" value={selected.due || ""} onChange={(e) => patchTask(selected, { due: e.target.value })} /></label>
              <label><span className="field-label">D · Type</span>
                <select className="select" value={selected.category} onChange={(e) => patchTask(selected, { category: e.target.value })}>
                  {TYPES.map((x) => <option key={x}>{x}</option>)}
                </select></label>
              <label><span className="field-label">Priority</span>
                <select className="select" value={selected.priority} onChange={(e) => patchTask(selected, { priority: e.target.value })}>
                  {PRIORITIES.map((x) => <option key={x} value={x}>{PRI_LABEL[x][0] + PRI_LABEL[x].slice(1).toLowerCase()}</option>)}
                </select></label>
              <label><span className="field-label">Department</span>
                <select className="select" value={selected.department} onChange={(e) => patchTask(selected, { department: e.target.value })}>
                  {(settings?.departments || []).map((d) => <option key={d}>{d}</option>)}
                </select></label>
              <label><span className="field-label">Project</span>
                <select className="select" value={selected.project} onChange={(e) => patchTask(selected, { project: e.target.value })}>
                  {(settings?.projects || []).map((d) => <option key={d}>{d}</option>)}
                </select></label>
              <div><span className="field-label">E · Billable</span>
                <div className="toggle-inline" style={{ marginTop: 8 }}><Switch on={selected.billable} label="Billable" onClick={() => patchTask(selected, { billable: !selected.billable })} /><span>{selected.billable ? "Billable" : "Unbillable"}</span></div></div>
              <label><span className="field-label">Billing</span>
                <select className="select" disabled={!selected.billable} value={selected.billing} onChange={(e) => patchTask(selected, { billing: e.target.value })}>
                  <option>Unbilled</option><option>Billed</option>
                </select></label>
            </div>

            <dl className="facts">
              <dt>ID</dt><dd className="mono">{selected.id}</dd>
              <dt>Next step</dt><dd>{selected.nextStep}</dd>
              <dt>Due</dt><dd>{dueLabel(selected)}</dd>
              <dt>Progress</dt><dd>{selected.progress}%</dd>
            </dl>

            <h4>Task state machine</h4>
            <div className="state-diagram">
              {["Suspended", "Ready", "Running", "Blocked"].map((s) => <span key={s} className={selected.state === s ? "state active" : "state"}>{s}</span>)}
            </div>
            <div className="btn-wrap" style={{ marginTop: 12 }}>
              {(TRANSITIONS[selected.state] || []).map((tr) => (
                <button key={tr.to} className="btn ghost small" onClick={() => changeState(selected, tr.to)}>{tr.label}</button>
              ))}
            </div>
            {isLead && (
              <>
                <h4>Move to any stage (team lead)</h4>
                <div className="btn-wrap">
                  {PIPELINES.map((p) => <button key={p} className="btn ghost small" disabled={p === selected.pipeline} onClick={() => moveTask(selected, p)}>{p}</button>)}
                </div>
              </>
            )}

            <h4>History</h4>
            <ol className="history">
              {[...(selected.history || [])].reverse().map((h, i) => (
                <li key={i}><span className="h-step">{h.step}</span><span>{h.by}{h.note ? ` — ${h.note}` : ""}</span><span className="h-at">{fmtWhen(h.at)}</span></li>
              ))}
            </ol>

            <div className="btn-row" style={{ marginTop: 26 }}>
              <button className="btn flat small" onClick={() => reprocess(selected)}>Re-process: Decide next step · Categorize · Schedule · Add notes</button>
              <button className="btn danger small" hidden={!isLead} onClick={async () => { await api.deleteTask(selected.id); setSelected(null); await refresh(); }}>Delete task</button>
            </div>
              </aside>
            </div>
          </div>
        </div>
      )}

      {newOpen && (
        <div className="modal-backdrop" onClick={() => setNewOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="New task" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>New task</h3><button type="button" className="close-x" onClick={() => setNewOpen(false)} aria-label="Close">✕</button></div>
                  <p className="sub" style={{ marginBottom: 0 }}>The AI still triages it — it suggests the agent and priority from your wording.</p>
                  <form onSubmit={addManual}>
                    <label className="field-label" htmlFor="f-title">Task title</label>
                    <input id="f-title" className="input" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Reply to distributor about delayed shipment" />
                    <div className="two-col">
                      <div>
                        <label className="field-label" htmlFor="f-src">Came from</label>
                        <select id="f-src" className="select" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                          {CHANNELS.map((c) => <option key={c}>{c}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="field-label" htmlFor="f-pri">Priority</label>
                        <select id="f-pri" className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                          <option value="auto">Let AI decide</option>
                          {PRIORITIES.map((p) => <option key={p} value={p}>{PRI_LABEL[p][0] + PRI_LABEL[p].slice(1).toLowerCase()}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="two-col">
                      <div>
                        <label className="field-label" htmlFor="f-type">Type</label>
                        <select id="f-type" className="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                          <option value="General">Let AI decide</option>
                          {TYPES.filter((x) => x !== "General").map((x) => <option key={x}>{x}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="field-label" htmlFor="f-dep">Department</label>
                        <select id="f-dep" className="select" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
                          {(settings?.departments || ["Sales", "Network"]).map((d) => <option key={d}>{d}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="two-col">
                      <div>
                        <label className="field-label" htmlFor="f-mem">Team member</label>
                        <select id="f-mem" className="select" disabled={!isLead} value={form.member} onChange={(e) => setForm({ ...form, member: e.target.value })}>
                          <option value="auto">Best fit (department &amp; workload)</option>
                          {team.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.role}</option>)}
                          <option value="none">Leave unassigned</option>
                        </select>
                      </div>
                      <div>
                        <label className="field-label" htmlFor="f-own">AI agent</label>
                        <select id="f-own" className="select" disabled={!isLead} value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                          <option value="auto">Let AI assign</option>
                          {OWNERS.map((o) => <option key={o}>{o}</option>)}
                          <option value="none">Leave unassigned</option>
                        </select>
                      </div>
                      <div>
                        <label className="field-label" htmlFor="f-due">Schedule (due date)</label>
                        <input id="f-due" type="date" className="input" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
                      </div>
                    </div>
                    <div className="toggle-inline">
                      <Switch on={form.billable} label="Billable" onClick={() => setForm({ ...form, billable: !form.billable })} />
                      <span>{form.billable ? "Billable — counts toward invoicing" : "Unbillable — internal work"}</span>
                    </div>
                    <label className="field-label" htmlFor="f-det">Details</label>
                    <textarea id="f-det" className="textarea" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} placeholder="Anything the agent should know — names, deadlines, links…" />
                    <div className="form-actions"><button className="btn" type="submit">Add &amp; let AI triage</button></div>
                  </form>
          </div>
        </div>
      )}

      {editing && (
        <div className="drawer-backdrop" onClick={() => setEditing(null)}>
          <form className="drawer account" onClick={(e) => e.stopPropagation()} onSubmit={saveMember}>
            <button type="button" className="close" onClick={() => setEditing(null)} aria-label="Close">✕</button>
            <h2>Edit {editing.name}</h2>
            <p className="drawer-notes">Login username: <b>{editing.username}</b>. Email and phone are used for alerts (phone with country code, e.g. +923001234567).</p>
            <div className="edit-grid">
              <label><span className="field-label">Name</span><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
              <label><span className="field-label">Role</span><input className="input" value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })} /></label>
              <label><span className="field-label">Email</span><input type="email" className="input" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></label>
              <label><span className="field-label">Phone (WhatsApp)</span><input className="input" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} placeholder="+92…" /></label>
              <label><span className="field-label">Department</span>
                <select className="select" value={editing.department} onChange={(e) => setEditing({ ...editing, department: e.target.value })}>{(settings?.departments || []).map((d) => <option key={d}>{d}</option>)}</select></label>
              <label><span className="field-label">Access</span>
                <select className="select" value={editing.access} onChange={(e) => setEditing({ ...editing, access: e.target.value })}>
                  <option value="member">Member</option><option value="lead">Lead</option><option value="admin">Admin</option>
                </select></label>
              <label><span className="field-label">Capacity</span><input type="number" min="1" className="input" value={editing.capacity} onChange={(e) => setEditing({ ...editing, capacity: e.target.value })} /></label>
              <label><span className="field-label">Reset password (optional)</span><input type="password" autoComplete="new-password" className="input" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} placeholder="min 8 characters" /></label>
            </div>
            <div className="btn-row" style={{ marginTop: 18 }}>
              <button className="btn" type="submit" disabled={editing.password && editing.password.length < 8}>Save</button>
              <button className="btn ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {accountOpen && (
        <div className="drawer-backdrop" onClick={() => setAccountOpen(false)}>
          <form className="drawer account" onClick={(e) => e.stopPropagation()} onSubmit={changePw}>
            <button type="button" className="close" onClick={() => setAccountOpen(false)} aria-label="Close">✕</button>
            <h2>{user.name}</h2>
            <p className="drawer-notes">{user.role} · {user.department} · {user.access === "admin" ? "Admin (sees everything)" : user.access === "lead" ? "Lead (sees your department, gets escalations)" : "Member (sees own tasks)"}</p>
            <h4>Change password</h4>
            <label className="field-label" htmlFor="pw-cur">Current password</label>
            <input id="pw-cur" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <label className="field-label" htmlFor="pw-new" style={{ marginTop: 12 }}>New password (min 8)</label>
            <input id="pw-new" className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <div className="btn-row" style={{ marginTop: 18 }}>
              <button className="btn" type="submit" disabled={!pw.current || pw.next.length < 8}>Save password</button>
              <button className="btn ghost" type="button" onClick={onLogout}>Sign out</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

const createBlankBrief = () => ({
  goals: "",
  requirements: "",
  scope: "",
  deliverables: "",
  audience: "",
  platform: "",
  successMetrics: "",
  timeline: "",
  budget: "",
  deadline: "",
  constraints: "",
  references: "",
  notes: "",
  clientType: "",
  requirementType: "",
  scopeType: "",
  urgency: "",
  businessStage: "",
  department: "",
  contractType: "",
  pdfSummary: "",
  requiredSystems: "",
  targetUsers: "",
  teamSize: "",
  requirementFile: ""
});

const PROJECT_PLAN = {
  Kickoff: ["Confirm client brief", "Assign owner and delivery team", "Finalize scope, budget, and timeline"],
  Building: ["Run deliverables by milestone", "Track progress against requirements", "Check blockers and dependencies"],
  Review: ["Validate against scope", "Collect client approval", "Fix final feedback and iterate"],
  Delivered: ["QA final handoff", "Share delivery package", "Close project with final signoff"],
  Closed: ["Archive project record", "Document lessons learned", "Keep project as reference for future work"],
};

const briefFieldMeta = [
  { key: "clientType", label: "Client type" },
  { key: "requirementType", label: "Requirement type" },
  { key: "scopeType", label: "Scope type" },
  { key: "urgency", label: "Urgency" },
  { key: "businessStage", label: "Business stage" },
  { key: "budget", label: "Budget" },
  { key: "contractType", label: "Contract type" },
  { key: "platform", label: "Platform" },
  { key: "audience", label: "Audience" },
  { key: "targetUsers", label: "Target users" },
  { key: "teamSize", label: "Team size" },
  { key: "deadline", label: "Deadline" },
  { key: "timeline", label: "Timeline" },
  { key: "requiredSystems", label: "Required systems" },
  { key: "successMetrics", label: "Success metrics" },
  { key: "constraints", label: "Key constraints" },
  { key: "requirementFile", label: "Requirement file" },
];

function ProjectsTab({ isLead, team, tasks, onOpenTask, showToast, refresh }) {
  const [projects, setProjects] = useState([]);
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showConvert, setShowConvert] = useState(false);
  const [convertForm, setConvertForm] = useState({ taskId: "", projectType: "website", owner: "", team: [], brief: createBlankBrief() });
  const [detail, setDetail] = useState(null);
  const [detailTab, setDetailTab] = useState("overview");

  const TYPE_COLOR = { website: "#1877f2", "mobile-app": "#1fb457", "custom-software": "#8b5cf6", seo: "#f59e0b", "marketing-campaign": "#ec4899", maintenance: "#6b7280" };
  const STATUS_COLOR = { Kickoff: "#b9f22e", Building: "#3b82f6", Review: "#f59e0b", Delivered: "#10b981", Closed: "#6b7280", AtRisk: "#ef4444" };
  const clientTypes = ["Startup", "SMB", "Enterprise", "Agency", "Non-profit", "Government", "Other"];
  const requirementTypes = ["Brand Website", "Lead Generation", "E-commerce", "Mobile App", "CRM / Dashboard", "Automation", "SEO / Growth", "Marketing Campaign", "Maintenance / Support", "Other"];
  const scopeTypes = ["New build", "Redesign", "Optimization", "Migration", "Integration", "Ongoing support", "Audit / strategy", "Add-on project"];
  const urgencyLevels = ["Flexible", "Normal", "Urgent", "Launch this month", "Immediate"];
  const businessStages = ["Discovery", "Proposal stage", "Pitch ready", "Approved", "Needs redesign", "In progress"];
  const contractTypes = ["Fixed price", "Retainer", "Hourly", "Phase-based", "Subscription", "TBD"];

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api.projects(), api.projectTypes()]);
      setProjects(p); setTypes(t);
    } catch(e){ showToast(e.message); }
    setLoading(false);
  }, [showToast]);

  useEffect(()=>{ load(); }, [load]);

  const conv = async (e) => {
    e.preventDefault();
    try {
      const proj = await api.convertToProject(convertForm);
      showToast("Converted to project " + proj.id);
      setShowConvert(false);
      setConvertForm({ taskId:"", projectType:"website", owner:"", team:[], brief:createBlankBrief() });
      load(); refresh && refresh();
    } catch(e){ showToast(e.message); }
  };

  const openProject = async (id) => {
    try {
      const p = await api.project(id);
      setDetail(p); setDetailTab("overview");
    } catch(e){ showToast(e.message); }
  };

  const changeStatus = async (status) => {
    if(!detail) return;
    try {
      const p = await api.updateProject(detail.id, { status });
      setDetail(p); load();
      showToast("Status updated to " + status);
    } catch(e){ showToast(e.message); }
  };

  const closeP = async () => {
    if(!detail) return;
    if(!window.confirm("Close this project?")) return;
    try {
      const p = await api.closeProject(detail.id);
      setDetail(p); load();
      showToast("Project closed");
    } catch(e){ showToast(e.message); }
  };

  const updateBrief = async (field, value) => {
    if(!detail) return;
    try {
      const p = await api.updateProject(detail.id, { brief: { [field]: value } });
      setDetail(p);
    } catch(e){ showToast(e.message); }
  };

  const collectTasks = (tasks||[]).filter(t=>t.pipeline!=="Done");
  const counts = { total: projects.length, kickoff: projects.filter(p=>p.status==="Kickoff").length, building: projects.filter(p=>p.status==="Building").length, review: projects.filter(p=>p.status==="Review").length, delivered: projects.filter(p=>p.status==="Delivered").length, closed: projects.filter(p=>p.status==="Closed").length };

  const STATUS_META = {
    Kickoff:{label:"Kickoff",color:"#b9f22e",text:"#11140a"},
    Building:{label:"Building",color:"#3b82f6",text:"#fff"},
    Review:{label:"Review",color:"#f59e0b",text:"#fff"},
    Delivered:{label:"Delivered",color:"#10b981",text:"#fff"},
    Closed:{label:"Closed",color:"#6b7280",text:"#fff"},
    AtRisk:{label:"At Risk",color:"#ef4444",text:"#fff"},
  };
  const statusMeta = (s) => STATUS_META[s] || {label:s,color:"#6b7280",text:"#fff"};

  if(loading) return <div className="panel"><div className="sec-head"><h2>Projects</h2></div><p>Loading projects…</p></div>;

  return (
    <section className="projects-section">
      <div className="sec-head">
        <div className="t"><h2>Projects</h2><p>Convert won inquiries into delivery projects with structured briefs, owners, teams, and status tracking.</p></div>
        {isLead && <button className="btn big" onClick={()=>setShowConvert(true)}>+ Convert inquiry to project</button>}
      </div>

      {/* KPI Row */}
      <div className="kpis" style={{gridTemplateColumns:"repeat(6, 1fr)", gap:12, marginBottom:16}}>
        {[
          {label:"Total", value:counts.total, color:"#f4f1e8", note:"All projects"},
          {label:"Kickoff", value:counts.kickoff, color:"#b9f22e", note:"Approved + ready to start"},
          {label:"Building", value:counts.building, color:"#3b82f6", note:"In progress"},
          {label:"Review", value:counts.review, color:"#f59e0b", note:"Waiting on approval"},
          {label:"Delivered", value:counts.delivered, color:"#10b981", note:"Completed"},
          {label:"Closed", value:counts.closed, color:"#6b7280", note:"Finished / archived"},
        ].map(({label,value,color,note})=>(
          <div key={label} className="kpi" style={{background:color,color:color==="#f4f1e8"?"#111":"#11140a",borderColor:color,boxShadow:`3px 3px 0 ${color}`}}>
            <div className="k-label">{label}</div>
            <div className="k-note" style={{fontSize:10,opacity:0.8,letterSpacing:"0.12em",textTransform:"uppercase",marginTop:2}}>{note}</div>
            <div className="k-value">{value}</div>
          </div>
        ))}
      </div>

      {/* Projects Grid */}
      <div className="panel" style={{overflowX:"visible"}}>
        <div className="projects-grid">
          {projects.length===0 && (
            <div className="empty-state" style={{gridColumn:"1/-1",textAlign:"center",padding:40,color:"var(--muted)"}}>
              <div style={{fontSize:40,marginBottom:10}}>📦</div>
              <p>No projects yet. Convert an inquiry from Tasks when the deal is won.</p>
            </div>
          )}
          {projects.map(p=>{
            const m = statusMeta(p.status);
            const owner = team?.find(t=>t.id===p.owner);
            const tc = TYPE_COLOR[p.type]||"#9b9a92";
            const prog = p.status==="Kickoff"?10:p.status==="Building"?40:p.status==="Review"?70:p.status==="Delivered"?90:100;
            return (
              <div key={p.id} className="project-card" onClick={()=>openProject(p.id)} style={{cursor:"pointer"}}>
                <div className="pc-head">
                  <div className="pc-id">{p.id}</div>
                  <div className="pc-type" style={{background:tc,color:"#fff"}}>{p.typeName}</div>
                  <div className="pc-status" style={{background:m.color,color:m.text}}>{m.label}</div>
                </div>
                <div className="pc-title">{p.title}</div>
                <div className="pc-meta">
                  <div className="pm-item"><span className="pm-label">Client</span><span className="pm-val">{p.client?.name||"—"}</span></div>
                  <div className="pm-item"><span className="pm-label">Owner</span><span className="pm-val">{owner?owner.name:p.owner||"—"}</span></div>
                  <div className="pm-item"><span className="pm-label">Type</span><span className="pm-val">{p.typeName}</span></div>
                </div>
                <div className="pc-brief" style={{marginTop:8,fontSize:12.5,color:"var(--muted)",lineHeight:1.4}}>
                  {p.brief?.goals?(p.brief.goals.slice(0,90)+(p.brief.goals.length>90?"…":"")):"No goals captured yet"}
                </div>
                <div className="pc-progress" style={{marginTop:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--faint)",marginBottom:4}}>
                    <span>Progress</span><span>{prog}%</span>
                  </div>
                  <div className="mini-bar wide" style={{height:6}}>
                    <div style={{width:prog+"%",background:m.color,borderRadius:3}}></div>
                  </div>
                </div>
                <div className="pc-footer" style={{marginTop:10,display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--faint)"}}>
                  <span>{new Date(p.createdAt).toLocaleDateString()}</span>
                  <span>{(p.team||[]).length} team member{(p.team||[]).length===1?"":"s"}</span>
                </div>
              </div>
            );
          })}
        </div>
        {projects.length>0 && <div style={{marginTop:10,fontSize:12,color:"var(--faint)"}}>{projects.length} project{projects.length===1?"":"s"} across pipeline</div>}
      </div>

      {/* Convert Drawer */}
      {showConvert && (
        <div className="drawer-backdrop" onClick={()=>setShowConvert(false)}>
          <div className="drawer" onClick={e=>e.stopPropagation()} style={{width:"min(940px,96vw)", maxHeight:"92vh", overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <button className="close" onClick={()=>setShowConvert(false)}>×</button>
              <div style={{flex:1,textAlign:"center",paddingRight:32}}>
                <h2 style={{margin:0,fontSize:28,lineHeight:1.1}}>Convert inquiry to project</h2>
              </div>
            </div>
            <p style={{color:"var(--muted)",fontSize:13,marginBottom:20, lineHeight:1.5}}>Only convert when the deal is won. Capture the full commercial and delivery brief so the project starts with clean scope, owners, and delivery expectations.</p>
                        <form onSubmit={conv} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
              <div style={{gridColumn:"1/-1", display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
                <div>
                  <label className="field-label">Inquiry / Task</label>
                  <select className="select" value={convertForm.taskId} onChange={e=>setConvertForm({...convertForm,taskId:e.target.value})} required>
                    <option value="">Select an open inquiry</option>
                    {collectTasks.map(t=><option key={t.id} value={t.id}>{t.id} — {t.title}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Project type</label>
                  <select className="select" value={convertForm.projectType} onChange={e=>setConvertForm({...convertForm,projectType:e.target.value})}>
                    {types.map(tp=><option key={tp.id} value={tp.id}>{tp.name}</option>)}
                  </select>
                </div>
              </div>

              <div style={{gridColumn:"1/-1", display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
                <div>
                  <label className="field-label">Project lead</label>
                  <select className="select" value={convertForm.owner} onChange={e=>setConvertForm({...convertForm,owner:e.target.value})}>
                    <option value="">Auto-assign from task owner</option>
                    {team?.filter(m=>m.access!="member").map(m=><option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
                    {team?.filter(m=>m.access==="member").map(m=><option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Client type</label>
                  <select className="select" value={convertForm.brief.clientType||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,clientType:e.target.value}})}>
                    <option value="">Select client type</option>
                    {clientTypes.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>

              <div style={{gridColumn:"1/-1", display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:16}}>
                <div>
                  <label className="field-label">Requirement type</label>
                  <select className="select" value={convertForm.brief.requirementType||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,requirementType:e.target.value}})}>
                    <option value="">Select requirement</option>
                    {requirementTypes.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Scope type</label>
                  <select className="select" value={convertForm.brief.scopeType||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,scopeType:e.target.value}})}>
                    <option value="">Select scope</option>
                    {scopeTypes.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Urgency</label>
                  <select className="select" value={convertForm.brief.urgency||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,urgency:e.target.value}})}>
                    <option value="">Select urgency</option>
                    {urgencyLevels.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Business stage</label>
                  <select className="select" value={convertForm.brief.businessStage||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,businessStage:e.target.value}})}>
                    <option value="">Select stage</option>
                    {businessStages.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Budget range</label>
                  <select className="select" value={convertForm.brief.budget||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,budget:e.target.value}})}>
                    <option value="">Select budget</option>
                    <option value="Under $5k">Under $5k</option>
                    <option value="$5k - $10k">$5k - $10k</option>
                    <option value="$10k - $25k">$10k - $25k</option>
                    <option value="$25k - $50k">$25k - $50k</option>
                    <option value="$50k - $100k">$50k - $100k</option>
                    <option value="$100k+">$100k+</option>
                    <option value="TBD">TBD</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">Contract type</label>
                  <select className="select" value={convertForm.brief.contractType||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,contractType:e.target.value}})}>
                    <option value="">Select delivery model</option>
                    {contractTypes.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label className="field-label">Delivery team</label>
                <select className="select" multiple size={5} value={convertForm.team} onChange={e=>setConvertForm({...convertForm,team:Array.from(e.target.selectedOptions,o=>o.value)})}>
                  {team?.map(m=><option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
                </select>
                <p style={{fontSize:11,color:"var(--faint)",marginTop:6}}>Hold Ctrl/Cmd to select multiple team members.</p>
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <div style={{fontSize:11,textTransform:"uppercase",letterSpacing:"0.14em",color:"var(--muted)",marginBottom:8,fontWeight:700}}>Business goals</div>
                <textarea className="textarea" rows={3} value={convertForm.brief.goals||""} placeholder="What is the client trying to achieve and why does this project matter?" onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,goals:e.target.value}})} />
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <div style={{fontSize:11,textTransform:"uppercase",letterSpacing:"0.14em",color:"var(--muted)",marginBottom:8,fontWeight:700}}>Requirements from PDF / briefing</div>
                <textarea className="textarea" rows={4} value={convertForm.brief.requirements||""} placeholder="Copy the detailed requirement list from the PDF, form, or brief. Include must-have features, business logic, integrations, user flows, and approval criteria." onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,requirements:e.target.value}})} />
                <div style={{marginTop:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap", border:"1px solid var(--line-2)", borderRadius:12, background:"rgba(255,255,255,0.02)", padding:"10px 12px"}}>
                  <label htmlFor="project-requirement-file" className="btn ghost small" style={{margin:0,cursor:"pointer", display:"inline-flex", alignItems:"center", justifyContent:"center"}}>Choose File</label>
                  <input
                    id="project-requirement-file"
                    type="file"
                    accept=".pdf,.doc,.docx,.ppt,.pptx,.jpg,.jpeg,.png,.txt"
                    onChange={(e)=> {
                      const file = e.target.files?.[0];
                      setConvertForm({
                        ...convertForm,
                        brief: { ...convertForm.brief, requirementFile: file ? file.name : "", requirements: convertForm.brief.requirements || (file ? `Requirement file: ${file.name}` : "") }
                      });
                    }}
                    style={{display:"none"}}
                  />
                  <span style={{fontSize:14, color:"var(--muted)", fontWeight:500}}>{convertForm.brief.requirementFile || "No file chosen"}</span>
                </div>
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label className="field-label">Project scope / deliverables</label>
                <textarea className="textarea" rows={3} value={convertForm.brief.scope||""} placeholder="Define the full scope of work, deliverables, phases, or modules included in this engagement." onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,scope:e.target.value}})} />
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label className="field-label">Deliverables</label>
                <textarea className="textarea" rows={3} value={convertForm.brief.deliverables||""} placeholder="Example: landing page, CMS, dashboard, API, onboarding, QA, handoff package, support plan" onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,deliverables:e.target.value}})} />
              </div>

              <div>
                <label className="field-label">Target audience</label>
                <input className="input" placeholder="Internal users, customers, B2B buyers, partners" value={convertForm.brief.audience||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,audience:e.target.value}})} />
              </div>
              <div>
                <label className="field-label">Platform / channels</label>
                <input className="input" placeholder="Website, mobile app, social, WhatsApp, CRM" value={convertForm.brief.platform||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,platform:e.target.value}})} />
              </div>
              <div>
                <label className="field-label">Target users</label>
                <input className="input" placeholder="Staff, clients, admins, partners, public users" value={convertForm.brief.targetUsers||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,targetUsers:e.target.value}})} />
              </div>
              <div>
                <label className="field-label">Team size / organization</label>
                <input className="input" placeholder="e.g. 15 employees, 3 departments, 1 admin team" value={convertForm.brief.teamSize||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,teamSize:e.target.value}})} />
              </div>

              <div>
                <label className="field-label">Success metrics</label>
                <input className="input" placeholder="Example: 20% more leads, 2s page load, 90% task completion" value={convertForm.brief.successMetrics||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,successMetrics:e.target.value}})} />
              </div>
              <div>
                <label className="field-label">Timeline</label>
                <input className="input" placeholder="Example: 8 weeks, phased rollout over Q1" value={convertForm.brief.timeline||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,timeline:e.target.value}})} />
              </div>

              <div>
                <label className="field-label">Launch / deadline</label>
                <input className="input" type="date" value={convertForm.brief.deadline||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,deadline:e.target.value}})} />
              </div>
              <div>
                <label className="field-label">Key constraints</label>
                <input className="input" placeholder="Brand limits, compliance, dependencies, access needs" value={convertForm.brief.constraints||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,constraints:e.target.value}})} />
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label className="field-label">Required systems / integrations</label>
                <input className="input" placeholder="WhatsApp, Shopify, HubSpot, Stripe, CRM, ERP, payment gateway" value={convertForm.brief.requiredSystems||""} onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,requiredSystems:e.target.value}})} />
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label className="field-label">References / inspiration</label>
                <textarea className="textarea" rows={2} value={convertForm.brief.references||""} placeholder="Links, references, examples, inspiration sites, screenshots, or PDFs provided by the client." onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,references:e.target.value}})} />
              </div>

              <div style={{gridColumn:"1/-1"}}>
                <label className="field-label">Project notes</label>
                <textarea className="textarea" rows={3} value={convertForm.brief.notes||""} placeholder="Any internal notes, decision points, approvals, or handoff details for the team." onChange={e=>setConvertForm({...convertForm,brief:{...convertForm.brief,notes:e.target.value}})} />
              </div>

              <div style={{gridColumn:"1/-1",display:"flex",gap:10,justifyContent:"flex-end",marginTop:8,paddingTop:10,borderTop:"1px solid var(--line-2)"}}>
                <button className="btn ghost big" type="button" onClick={()=>setShowConvert(false)}>Cancel</button>
                <button className="btn big" type="submit">Create project</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Project Detail Drawer */}
      {detail && (
        <div className="drawer-backdrop" onClick={()=>{setDetail(null);setDetailTab("overview");}}>
          <div className="drawer" onClick={e=>e.stopPropagation()} style={{width:"min(820px,96vw)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,paddingBottom:10,borderBottom:"1px solid var(--line-2)"}}>
              <div>
                <h4 style={{margin:0,color:"var(--muted)",fontSize:11,letterSpacing:".14em",textTransform:"uppercase"}}>PROJECT</h4>
                <h1 style={{margin:"4px 0 0 0",fontSize:22}}>{detail.id}</h1>
              </div>
              <div className="btn-wrap" style={{gap:8}}>
                {detail.status!=="Closed" && <button className="btn danger small" onClick={closeP}>Close project</button>}
                {detail.taskId && <button className="btn ghost small" onClick={()=>{onOpenTask && onOpenTask(detail.taskId); setDetail(null);setDetailTab("overview");}}>Open linked inquiry</button>}
              </div>
            </div>
              <div className="facts" style={{gridTemplateColumns:"repeat(3, 1fr)",gap:"10px 20px",marginBottom:16,fontSize:13}}>
          {[
            {l:"Type",v:detail.typeName},
            {l:"Status",v:<span className="status-pill" style={{background:statusMeta(detail.status).color,color:statusMeta(detail.status).text}}>{detail.status}</span>},
            {l:"Owner",v:team?.find(m=>m.id===detail.owner)?.name||detail.owner},
            {l:"Client",v:detail.client?.name||"—"},
            {l:"Channel",v:detail.client?.channel||"—"},
            {l:"Linked inquiry",v:detail.taskId||"—"},
            {l:"Created",v:detail.createdAt?new Date(detail.createdAt).toLocaleString():"—"},
          ].map((f,i)=>(<div key={i}><dt style={{color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:".1em"}}>{f.l}</dt><dd style={{fontWeight:700}}>{f.v}</dd></div>))}
              </div>

            <div className="detail-tabs" style={{display:"flex",gap:0,borderBottom:"1px solid var(--line-2)",marginBottom:16}}>
              {["overview","brief","team","history"].map(k=>(
                <button key={k} className={`detail-tab ${detailTab===k?"active":""}`} onClick={()=>setDetailTab(k)} style={{flex:1,border:"none",background:"transparent",color:detailTab===k?"var(--ink)":"var(--muted)",padding:"10px 0",fontWeight:600,fontSize:13,borderBottom:`2px solid ${detailTab===k?"var(--lime)":"transparent"}`}}>
                  {k==="overview"?"Overview":k==="brief"?"Project Brief":k==="team"?"Team":"History"}
                </button>
              ))}
            </div>

            {detailTab==="overview" && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
                <div className="panel" style={{padding:16}}>
                  <h4 style={{margin:"0 0 10px 0",fontSize:14}}>Project status</h4>
                  <div className="btn-wrap" style={{flexDirection:"column",gap:6}}>
                    {[
                      {s:"Kickoff",l:"Start / Kickoff"},
                      {s:"Building",l:"In Building"},
                      {s:"Review",l:"Move to Review"},
                      {s:"Delivered",l:"Mark Delivered"},
                      {s:"Closed",l:"Close Project"},
                    ].map(o=>(
                      detail.status!==o.s && <button key={o.s} className="btn ghost" style={{textAlign:"left",width:"100%",padding:"10px 14px",fontSize:13}} onClick={()=>changeStatus(o.s)}>{o.l}</button>
                    ))}
                  </div>
                </div>
                <div className="panel" style={{padding:16}}>
                  <h4 style={{margin:"0 0 10px 0",fontSize:14}}>Progress</h4>
                  <div style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--faint)",marginBottom:4}}>
                      <span>Overall</span><span>{detail.status==="Kickoff"?10:detail.status==="Building"?40:detail.status==="Review"?70:detail.status==="Delivered"?90:100}%</span>
                    </div>
                    <div className="mini-bar wide" style={{height:8}}>
                      <div style={{width:(detail.status==="Kickoff"?10:detail.status==="Building"?40:detail.status==="Review"?70:detail.status==="Delivered"?90:100)+"%",background:statusMeta(detail.status).color,borderRadius:4}}></div>
                    </div>
                  </div>
                  <h4 style={{margin:"16px 0 8px 0",fontSize:13}}>Team</h4>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {[detail.owner,...(detail.team||[])].filter(Boolean).map(id=>{
                      const m = team?.find(t=>t.id===id);
                      return (
                        <span key={id} className="team-pill" style={{background:m?.color||"#3a3a3a",color:"#fff",padding:"4px 10px",borderRadius:12,fontSize:12,fontWeight:600,display:"inline-flex",alignItems:"center",gap:6}}>
                          {m?.name||id}
                          {id===detail.owner && <span style={{fontSize:10,opacity:.8}}> • lead</span>}
                        </span>
                      );
                    })}
                    {(detail.team||[]).length===0 && <span style={{fontSize:12,color:"var(--muted)"}}>No team assigned</span>}
                  </div>
                </div>

                <div className="panel" style={{padding:16, gridColumn:"1 / -1"}}>
                  <h4 style={{margin:"0 0 10px 0",fontSize:14}}>Project plan / next steps</h4>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12}}>
                    {(PROJECT_PLAN[detail.status] || PROJECT_PLAN.Kickoff).map((step, idx) => (
                      <div key={`${detail.id}-${idx}`} style={{background:"rgba(255,255,255,0.03)", border:"1px solid var(--line)", borderRadius:12, padding:12}}>
                        <div style={{fontSize:10, letterSpacing:"0.12em", textTransform:"uppercase", color:"var(--muted)", marginBottom:6}}>Step {idx + 1}</div>
                        <div style={{fontSize:14, lineHeight:1.5, fontWeight:600}}>{step}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {detailTab==="brief" && (
              <div className="panel wide" style={{padding:20}}>
                <h4 style={{margin:"0 0 12px 0",fontSize:14,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".1em"}}>Structured brief</h4>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                  {[
                    { key: "goals", label: "Goals", type: "text" },
                    { key: "requirements", label: "Requirements / features", type: "text" },
                    { key: "scope", label: "Scope", type: "text" },
                    { key: "deliverables", label: "Deliverables", type: "text" },
                    { key: "platform", label: "Platform", type: "text" },
                    { key: "budget", label: "Budget", type: "label" },
                    { key: "deadline", label: "Deadline", type: "label" },
                    { key: "references", label: "References", type: "text" },
                    { key: "notes", label: "Notes", type: "text" },
                    { key: "requirementFile", label: "Requirement file", type: "label" },
                  ].map((field) => {
                    const value = detail.brief?.[field.key];
                    const textValue = value && String(value).trim() ? String(value).trim() : "Not captured";
                    const valueColor = value && String(value).trim() ? "var(--ink)" : "var(--faint)";
                    return (
                      <div key={field.key} style={{border:1,"border-style":"solid",borderColor:"var(--line)",borderRadius:12,padding:14,background:"#141414"}}>
                        <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".1em",marginBottom:6}}>{field.label}</div>
                        <div style={{fontSize: field.type === "label" ? 16 : 14, lineHeight:1.6, color: valueColor, fontWeight: field.type === "label" ? 700 : 500}}>
                          {textValue}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{marginTop:20, display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))", gap:12}}>
                  {briefFieldMeta.map((field) => {
                    const value = detail.brief?.[field.key];
                    if (!value || !String(value).trim()) return null;
                    return (
                      <div key={`meta-${field.key}`} style={{padding:"10px 12px", border:"1px solid var(--line)", borderRadius:10, background:"rgba(255,255,255,0.02)"}}>
                        <div style={{fontSize:10, letterSpacing:"0.1em", textTransform:"uppercase", color:"var(--muted)", marginBottom:4}}>{field.label}</div>
                        <div style={{fontSize:13, fontWeight:600}}>{String(value)}</div>
                      </div>
                    );
                  })}
                </div>
                {isLead && (
                  <div style={{marginTop:20,display:"flex",gap:10,flexWrap:"wrap"}}>
                    {["goals","requirements","platform","budget","deadline","references","requirements","scope","deliverables","notes","requirementFile"].map(f=>(
                      <button key={f} className="btn ghost small" onClick={()=>{
                        const v = window.prompt("Enter "+f);
                        if(v!==null) updateBrief(f,v);
                      }} style={{fontSize:12}}>Edit {f.charAt(0).toUpperCase()+f.slice(1)}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {detailTab==="team" && (
              <div className="panel wide" style={{padding:20}}>
                <h4 style={{margin:"0 0 12px 0",fontSize:14,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".1em"}}>Project team</h4>
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {[detail.owner,...(detail.team||[])].filter(Boolean).map((id,i)=>{
                    const m = team?.find(t=>t.id===id);
                    if(!m) return null;
                    return (
                      <div key={id} className="team-row" style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:"1px solid var(--line)"}}>
                        <div className="avatar" style={{width:40,height:40,fontSize:16,background:m.color}}>{m.name[0]}</div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:700,fontSize:14}}>{m.name}</div>
                          <div style={{fontSize:12,color:"var(--muted)"}}>{m.role} · {m.department}{i===0?" (Project Owner)":""}</div>
                        </div>
                        <div className="team-load" style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--faint)"}}>{i===0?"Owner":"Member"}</div>
                      </div>
                    );
                  })}
                  {(detail.team||[]).length===0 && <p style={{color:"var(--muted)"}}>No team members assigned yet.</p>}
                </div>
              </div>
            )}

            {detailTab==="history" && (
              <div className="panel wide" style={{padding:20}}>
                <h4 style={{margin:"0 0 12px 0",fontSize:14,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".1em"}}>Status history</h4>
                <ul className="history" style={{maxHeight:"none"}}>
                  {(detail.statusHistory||[]).slice().reverse().map((h,i)=>(<li key={i} style={{display:"flex",alignItems:"center",gap:10,padding:8,fontSize:13,color:"var(--ink)"}}>
                    <span className="h-step" style={{background:statusMeta(h.status).color,color:statusMeta(h.status).text,padding:"2px 8px",borderRadius:8,fontSize:11,fontWeight:700,flexShrink:0}}>{h.status}</span>
                    <span style={{flex:1}}>{h.by}</span>
                    <span className="h-at" style={{fontSize:11,color:"var(--faint)",whiteSpace:"nowrap"}}>{h.at?new Date(h.at).toLocaleString():""}</span>
                  </li>))}
                  {(detail.statusHistory||[]).length===0 && <p style={{color:"var(--muted)"}}>No history yet.</p>}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
