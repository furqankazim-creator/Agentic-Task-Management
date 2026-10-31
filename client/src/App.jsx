import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

const CHANNELS = ["Facebook", "WhatsApp", "Email", "LinkedIn", "Website"];
const PIPELINES = ["Collect", "Process", "Review", "Do", "Done"];
const STATES = ["Ready", "Running", "Blocked", "Suspended"];
const PRIORITIES = ["urgent", "high", "medium", "low"];
const TABS = ["Overview", "Tasks", "Calendar", "Agents", "Analytics", "Organization", "Automations", "Settings"];
const TYPES = ["Sales", "Support", "Finance", "Follow-up", "Operations", "Marketing", "Product", "General"];
const LIFECYCLES = ["Unassigned", "Unscheduled", "Scheduled", "In review", "Approved", "Improving", "Rejected"];
const LIFE_STEPS = ["Birth", "Recorded", "Unassigned / Unscheduled", "Assigned & scheduled", "Review", "Approve · Improve · Reject"];
const OWNERS = ["Scout", "Triage", "Scribe", "Runner", "Hawk"];
const SRC = {
  Facebook: { abbr: "FB", color: "#1877f2", sub: "Page messages & leads" },
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
  "Urgent email: send Q4 invoice to the distributor",
  "Facebook lead asked about wholesale pricing",
  "LinkedIn: follow up with the retail buyer",
  "Website form: new demo request came in",
];
const TRANSITIONS = {
  Ready: [{ to: "Running", label: "Start (Ready → Running)" }, { to: "Suspended", label: "TaskSuspend() → Suspended" }],
  Running: [{ to: "Blocked", label: "Blocking API call → Blocked" }, { to: "Ready", label: "Back to Ready" }],
  Blocked: [{ to: "Ready", label: "Event → Ready" }],
  Suspended: [{ to: "Ready", label: "TaskResume() → Ready" }],
};
const AUTOMATIONS = [
  { key: "autoMove", title: "Auto-move tasks", desc: "Runner moves the oldest movable task forward on every Autopilot tick." },
  { key: "autoUnblock", title: "Auto-unblock on events", desc: "Blocked tasks wake back to Ready when an event arrives." },
  { key: "autoPrioritize", title: "Auto-prioritize", desc: "Triage sets priority from the task text (urgent / high / medium / low)." },
  { key: "autoAssign", title: "Auto-assign & schedule", desc: "Triage gives every unassigned task an owner and every unscheduled task a due date." },
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

/* ---------- app ---------- */
export default function App() {
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [agents, setAgents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [tab, setTab] = useState("Overview");
  const [source, setSource] = useState("All");
  const [query, setQuery] = useState("");
  const [command, setCommand] = useState("");
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
  const [form, setForm] = useState({ title: "", source: "WhatsApp", priority: "auto", category: "General", department: "Sales", assignee: "auto", due: "", billable: true, details: "" });
  const [gov, setGov] = useState(null);
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
      const [t, s, a, ag, st, g] = await Promise.all([api.tasks(), api.stats(), api.activity(), api.agents(), api.settings(), api.governance()]);
      setGov(g); setTasks(t); setStats(s); setActivity(a); setAgents(ag); setSettings(st);
      if (firstLoad.current) {
        firstLoad.current = false;
        setWorkspace(st.workspace); setDefaultPriority(st.defaultPriority); setAutopilot(Boolean(s.autopilot));
      }
      setError("");
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!autopilot) return undefined;
    autopilotRef.current = setInterval(async () => {
      try { await api.autopilotTick(); await refresh(); } catch { /* keep ticking */ }
    }, paceSec * 1000);
    return () => clearInterval(autopilotRef.current);
  }, [autopilot, paceSec, refresh]);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };

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
    try { await api.updateTask(task.id, { pipeline }); await refresh(); }
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
    try { await api.review(task.id, decision, reviewNote); showToast(`${decision === "approve" ? "Approved" : decision === "improve" ? "Sent back to improve" : "Rejected"}: ${shorten(task.title, 40)}`); setReviewNote(""); await refresh(); }
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
      setForm({ ...form, title: "", details: "", due: "" }); await refresh();
    } catch (err) { showToast(err.message); }
  };
  const newTask = () => {
    setTab("Overview");
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    setTimeout(() => formRef.current?.querySelector("input")?.focus({ preventScroll: true }), 400);
  };

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
            <span className="auto-label">Autopilot</span>
            <Switch on={autopilot} onClick={toggleAutopilot} label="Autopilot" />
            <button className="btn" onClick={newTask}>+ New task</button>
          </div>
        </div>
      </header>

      <main className="wrap">
        {error && <div className="error">Cannot reach the API ({error}). Start the server: <code>cd server &amp;&amp; npm install &amp;&amp; npm start</code></div>}

        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
              {t === "Tasks" && <span className="tab-count">{tasks.length}</span>}
              {t === "Agents" && <span className="tab-count">{agents.length}</span>}
            </button>
          ))}
        </nav>

        {tab === "Overview" && (
          <>
            <section className="hero">
              <h2>Tell it once.<em>It routes the rest.</em></h2>
              <p className="lede">
                Type a task in plain words — mention the channel (<b>WhatsApp</b>, <b>email</b>, <b>Facebook</b>, <b>LinkedIn</b>, <b>website</b>)
                and urgency (<b>urgent</b>, <b>high</b>) and the agent files it, assigns an owner and sets the priority automatically.
              </p>
              <form className="cmd-row" onSubmit={runCommand}>
                <input className="cmd-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={'Try: "Urgent — reply to the WhatsApp client asking for a bulk quote"'} />
                <button className="btn" type="submit">Send to agent →</button>
              </form>
              <div className="chips">
                {EXAMPLES.map((ex) => <button key={ex} type="button" className="chip" onClick={() => setCommand(ex)}>{ex}</button>)}
              </div>
            </section>

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
                        {items.map((t) => (
                          <article key={t.id} className="card" draggable onDragStart={(e) => e.dataTransfer.setData("task", JSON.stringify(t))} onClick={() => setSelected(t)}>
                            <p className="card-title">{t.title}</p>
                            <div className="tags"><SrcPill source={t.source} /><PriPill p={t.priority} /><StateTag t={t} />{["Unassigned", "Unscheduled", "In review", "Improving", "Rejected"].includes(t.lifecycle) && <LifeTag t={t} />}{t.pipeline === "Done" && t.billable && <BillTag t={t} />}</div>
                            <div className="card-foot">
                              <span>{dueLabel(t)}</span>
                              <span className="agent-chip">{t.agent ? <><Avatar agent={agentByName[t.agent]} size="xs" />{t.agent}</> : <em className="none">no owner</em>}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    );
                  })}
                </div>

                <section className="panel" style={{ marginTop: 22 }} ref={formRef}>
                  <h3>Add a task manually</h3>
                  <p className="sub" style={{ marginBottom: 0 }}>The AI still triages it — it suggests the agent and priority from your wording.</p>
                  <form onSubmit={addManual}>
                    <label className="field-label" htmlFor="f-title">Task title</label>
                    <input id="f-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Reply to distributor about delayed shipment" />
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
                        <label className="field-label" htmlFor="f-own">Assign to</label>
                        <select id="f-own" className="select" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
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
                </section>

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

        {tab === "Tasks" && (
          <section>
            <div className="sec-head">
              <div className="t"><h2>All tasks</h2><p>One list for everything — filter it, change a state inline, or click a row to open the full task.</p></div>
              <div className="sec-tools">
                <select className="select compact" value={tablePipeline} onChange={(e) => setTablePipeline(e.target.value)} aria-label="Stage"><option value="All">All stages</option>{PIPELINES.map((p) => <option key={p}>{p}</option>)}</select>
                <select className="select compact" value={tableState} onChange={(e) => setTableState(e.target.value)} aria-label="State"><option value="All">All states</option>{[...STATES, "Done"].map((s) => <option key={s}>{s}</option>)}</select>
                <select className="select compact" value={tableLife} onChange={(e) => setTableLife(e.target.value)} aria-label="Lifecycle"><option value="All">All lifecycles</option>{LIFECYCLES.map((l) => <option key={l}>{l}</option>)}</select>
                <select className="select compact" value={tablePriority} onChange={(e) => setTablePriority(e.target.value)} aria-label="Priority"><option value="All">All priorities</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRI_LABEL[p][0] + PRI_LABEL[p].slice(1).toLowerCase()}</option>)}</select>
                <button className="btn flat small" onClick={simulateIncoming}>Simulate incoming</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="task-table">
                <thead><tr><th>Task</th><th>Source</th><th>Stage</th><th>Lifecycle</th><th>Type</th><th>Billing</th><th>Priority</th><th>Agent</th><th>Progress</th><th>State</th></tr></thead>
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

        {tab === "Agents" && (
          <section>
            <div className="sec-head"><div className="t"><h2>AI agents</h2><p>Each agent owns a stage of the pipeline. Pause one and Autopilot skips its tasks.</p></div></div>
            <div className="agent-grid">
              {agents.map((a) => {
                const mine = tasks.filter((t) => t.agent === a.name);
                const done = mine.filter((t) => t.pipeline === "Done").length;
                const avg = mine.length ? Math.round(mine.reduce((s, t) => s + t.progress, 0) / mine.length) : 0;
                return (
                  <div key={a.id} className="agent-card">
                    <div className="ac-top">
                      <Avatar agent={a} />
                      <div><h3>{a.name}</h3><span className={`a-status ${a.paused ? "grey" : AGENT_TONE[a.id]}`}>● {a.paused ? "Paused" : a.verb}</span></div>
                    </div>
                    <p>{a.role}</p>
                    <div className="agent-stats">
                      <div><b>{mine.length - done}</b>open</div><div><b>{done}</b>done</div><div><b>{avg}%</b>avg progress</div>
                    </div>
                    <button className="btn ghost small" onClick={async () => { await api.pauseAgent(a.id, !a.paused); await refresh(); showToast(`${a.name} ${a.paused ? "resumed" : "paused"}`); }}>
                      {a.paused ? "Resume agent" : "Pause agent"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {tab === "Analytics" && (
          <section>
            <div className="sec-head"><div className="t"><h2>Analytics</h2><p>Live from your tasks.</p></div></div>
            <div className="kpis" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginTop: 0 }}>
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
              <button className="btn" onClick={() => saveSettings({ workspace, defaultPriority, org: { ...settings.org, ...orgDraft } })}>Save settings</button>
              <button className="btn danger" onClick={async () => { await api.reset(); await refresh(); showToast("Board reset to the sample tasks"); }}>Reset board</button>
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
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <div className="tags"><SrcPill source={selected.source} /><PriPill p={selected.priority} /><StateTag t={selected} /><LifeTag t={selected} /><BillTag t={selected} /></div>
            <h2>{selected.title}</h2>
            <p className="drawer-notes">{selected.notes}</p>

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

            {selected.pipeline === "Review" && (
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

            <h4>C–E · Task profile</h4>
            <div className="edit-grid">
              <label><span className="field-label">Assigned to</span>
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
            <h4>Move in pipeline</h4>
            <div className="btn-wrap">
              {PIPELINES.map((p) => <button key={p} className="btn ghost small" disabled={p === selected.pipeline} onClick={() => moveTask(selected, p)}>{p}</button>)}
            </div>

            <h4>History</h4>
            <ol className="history">
              {[...(selected.history || [])].reverse().map((h, i) => (
                <li key={i}><span className="h-step">{h.step}</span><span>{h.by}{h.note ? ` — ${h.note}` : ""}</span><span className="h-at">{fmtWhen(h.at)}</span></li>
              ))}
            </ol>

            <div className="btn-row" style={{ marginTop: 26 }}>
              <button className="btn flat small" onClick={() => reprocess(selected)}>Re-process: Decide next step · Categorize · Schedule · Add notes</button>
              <button className="btn danger small" onClick={async () => { await api.deleteTask(selected.id); setSelected(null); await refresh(); }}>Delete task</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
