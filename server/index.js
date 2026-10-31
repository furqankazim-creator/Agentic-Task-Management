import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "tasks.json");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Model (from the whiteboard)
//  A Process   : Collect -> Process -> Review -> Do -> Done      (pipeline)
//  B Lifecycle : Birth -> Record -> Unassigned/Unscheduled -> Assign / Schedule
//                -> Review -> Approve | Improve | Reject
//  C Stage     : the pipeline column a task sits in now
//  D Type      : Sales, Support, Finance ...
//  E Billing   : Billable / Unbillable, and Unbilled / Billed
//  Org ladder  : Mandate -> Office -> Project -> Organization -> Department
//  Governance  : Policy, KPI, OKR (all computed live from the tasks)
// Task execution state machine (Ready/Running/Blocked/Suspended) is unchanged.
// ---------------------------------------------------------------------------
export const SOURCES = ["Facebook", "Website", "WhatsApp", "Email", "LinkedIn"];
export const PIPELINES = ["Collect", "Process", "Review", "Do", "Done"];
export const STATES = ["Ready", "Running", "Blocked", "Suspended"];
export const TYPES = ["Sales", "Support", "Finance", "Follow-up", "Operations", "Marketing", "Product", "General"];
const PRIORITY_LIST = ["urgent", "high", "medium", "low"];

export const AGENTS = [
  { id: "scout", name: "Scout", role: "Captures & files every incoming task", verb: "Capturing", color: "#b9f22e" },
  { id: "triage", name: "Triage", role: "Scores priority, picks the owner", verb: "Triaging", color: "#f59e0b" },
  { id: "scribe", name: "Scribe", role: "Drafts replies, notes & summaries", verb: "Drafting", color: "#38bdf8" },
  { id: "runner", name: "Runner", role: "Executes the doing — sends, posts, books", verb: "Executing", color: "#f472b6" },
  { id: "hawk", name: "Hawk", role: "Watches deadlines & unblocks stalls", verb: "Monitoring", color: "#a78bfa" },
];
const STAGE_OWNER = { Collect: "Scout", Process: "Triage", Review: "Scribe", Do: "Runner", Done: "Runner" };

const SAMPLE_TITLES = {
  Facebook: ["Facebook lead: asked about wholesale pricing", "Facebook comment thread: customer asking about a return"],
  Website: ["Website form: new demo request came in", "Website live chat: visitor asked about international shipping"],
  WhatsApp: ["WhatsApp group: confirm tomorrow's delivery slots with the riders", "WhatsApp: client wants a price list update"],
  Email: ["Urgent email: send Q4 invoice to the distributor", "Email: supplier quote needs approval"],
  LinkedIn: ["LinkedIn: follow up with the retail buyer", "LinkedIn: reply to partnership message"],
};

let idCounter = 112;
const uid = () => `T-${++idCounter}`;
const dayISO = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const now = () => new Date().toISOString();

// --- Lifecycle ----------------------------------------------------------------
// A task is born and recorded the moment it exists; after that its lifecycle label
// is derived from the facts (owner, schedule, stage, review decision).
function lifecycleOf(t) {
  if (t.review?.decision === "approve") return "Approved";
  if (t.review?.decision === "reject") return "Rejected";
  if (t.review?.decision === "improve" && t.pipeline !== "Review") return "Improving";
  if (t.pipeline === "Review") return "In review";
  if (!t.agent) return "Unassigned";
  if (!t.due) return "Unscheduled";
  return "Scheduled";
}
const view = (t) => ({ ...t, lifecycle: lifecycleOf(t) });
const addHistory = (t, step, by = "System", note = "") => { (t.history ||= []).push({ step, at: now(), by, note }); };

function newTask(fields) {
  const t = {
    id: uid(), pipeline: "Collect", state: "Ready", progress: 10, agent: null, due: null, dueTime: "", dueLabel: "",
    category: "General", department: "Sales", project: "Q4 Wholesale Push", billable: true, billing: "Unbilled",
    review: null, revisions: 0, nextStep: "Decide next step, then move it to the next stage.",
    createdAt: now(), history: [], ...fields,
  };
  addHistory(t, "Birth", "Scout");
  addHistory(t, "Recorded", "Scout");
  if (t.agent) addHistory(t, "Assigned", "Triage", `Owner: ${t.agent}`);
  if (t.due) addHistory(t, "Scheduled", "Triage", `Due ${t.due}`);
  return t;
}

// Move a task to another pipeline stage and keep every dependent field consistent.
function moveTo(task, pipeline, by = "Runner") {
  const from = task.pipeline;
  task.pipeline = pipeline;
  task.progress = { Collect: 10, Process: 45, Review: 70, Do: 90, Done: 100 }[pipeline];
  if (pipeline === "Process" && task.state === "Ready") task.state = "Running";
  if (pipeline === "Done") task.state = "Ready";
  if (pipeline === "Review") { task.review = null; addHistory(task, "Review", by); }
  if (from === "Review" && pipeline !== "Review" && !task.review) {
    // dragged out of Review without using the buttons: treat as an implicit decision
    const decision = pipeline === "Process" || pipeline === "Collect" ? "improve" : "approve";
    task.review = { decision, note: "Moved by hand", at: now(), by: "You" };
    addHistory(task, decision === "approve" ? "Approved" : "Improve", "You", "Moved by hand");
  }
}

// --- Seed data ------------------------------------------------------------------
// [id, source, title, pipeline, state, priority, agent, progress, dayOffset|null, dueTime, dueLabel, type, notes, department, project, billable, billing]
const SEED = [
  ["T-101", "WhatsApp", "Reply to WhatsApp client asking for a bulk quote on 500 units", "Done", "Ready", "urgent", "Runner", 100, 0, "4:30 PM", "", "Sales", "Quote sent and acknowledged by the client.", "Sales", "Q4 Wholesale Push", true, "Billed"],
  ["T-102", "Email", "Send Q4 invoice to the distributor and chase the overdue balance", "Process", "Running", "high", "Scribe", 40, 1, "10 AM", "", "Finance", "Scribe is drafting the invoice email and a polite chaser for the overdue balance.", "Sales", "Q4 Wholesale Push", true, "Unbilled"],
  ["T-103", "Facebook", "Facebook lead: wholesale pricing question from a new retailer", "Review", "Running", "high", "Scribe", 70, 0, "6 PM", "", "Sales", "Draft reply with the wholesale price tiers is waiting for review.", "Sales", "Q4 Wholesale Push", true, "Unbilled"],
  ["T-104", "LinkedIn", "LinkedIn: follow up with the retail buyer who viewed your profile", "Process", "Running", "medium", "Scout", 45, 3, "", "", "Follow-up", "Scout is warming up a short follow-up message.", "Sales", "Q4 Wholesale Push", true, "Unbilled"],
  ["T-105", "Website", "Website demo request — new form submission from a pharmacy chain", "Process", "Running", "high", "Triage", 45, 0, "", "", "Sales", "Triage is scoring the lead and picking the right owner.", "Sales", "Q4 Wholesale Push", true, "Unbilled"],
  ["T-106", "WhatsApp", "WhatsApp group: confirm tomorrow's delivery slots with the riders", "Collect", "Ready", "medium", "Scout", 10, 0, "", "Tonight", "Operations", "Captured from the riders' WhatsApp group.", "Network", "Customer Care", false, "Unbilled"],
  ["T-107", "Email", "Email: supplier asking to confirm the revised delivery schedule", "Do", "Ready", "medium", "Runner", 90, 1, "", "", "Operations", "Reply is approved and ready for Runner to send.", "Network", "Customer Care", false, "Unbilled"],
  ["T-108", "Facebook", "Facebook comment thread: customer asking about a return", "Process", "Suspended", "medium", "Hawk", 25, null, "", "Paused", "Support", "Suspended with TaskSuspend() until the customer replies.", "Network", "Customer Care", false, "Unbilled"],
  ["T-109", "LinkedIn", "LinkedIn post engagement: reply to comments on the launch post", "Do", "Running", "low", "Runner", 60, 0, "", "", "Marketing", "Runner is replying to the comments one by one.", "Sales", "Q4 Wholesale Push", false, "Unbilled"],
  ["T-110", "Website", "Website live chat: visitor asked about international shipping", "Review", "Ready", "medium", "Scribe", 70, 0, "", "", "Support", "Draft answer about international shipping is waiting for review.", "Network", "Customer Care", false, "Unbilled"],
  ["T-111", "Email", "Email newsletter feedback: 3 subscribers replied with product ideas", "Done", "Ready", "low", "Scribe", 100, null, "", "Done", "Product", "Ideas summarised and filed.", "Sales", "Customer Care", false, "Unbilled"],
  ["T-112", "WhatsApp", "WhatsApp: reorder reminder acknowledged by Maple Mart store", "Done", "Ready", "medium", "Runner", 100, null, "", "Done", "Sales", "Store acknowledged the reorder reminder.", "Sales", "Q4 Wholesale Push", true, "Unbilled"],
];

function seedTasks() {
  idCounter = 112;
  return SEED.map(([id, source, title, pipeline, state, priority, agent, progress, day, dueTime, dueLabel, category, notes, department, project, billable, billing], i) => {
    const t = newTask({
      title, source, pipeline, state, priority, agent, progress, category, notes, department, project, billable, billing,
      due: day === null ? null : dayISO(day), dueTime, dueLabel,
      nextStep: pipeline === "Done" ? "Nothing — task closed." : "Decide next step, then move it to the next stage.",
      createdAt: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
    });
    t.id = id;
    if (["Do", "Done"].includes(pipeline)) {
      t.review = { decision: "approve", note: "", at: t.createdAt, by: "Scribe" };
      addHistory(t, "Review", "Scribe"); addHistory(t, "Approved", "Scribe");
    } else if (pipeline === "Review") addHistory(t, "Review", "Scribe");
    return t;
  });
}

function loadTasks() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      // Files from older versions (no lifecycle history) are replaced by the new seed.
      if (Array.isArray(parsed) && parsed.length && parsed.every((t) => /^T-\d+$/.test(t.id) && Array.isArray(t.history))) {
        idCounter = Math.max(idCounter, ...parsed.map((t) => Number(t.id.slice(2))));
        return parsed;
      }
    }
  } catch { /* fall through to seed */ }
  const seeded = seedTasks();
  saveTasks(seeded);
  return seeded;
}
function saveTasks(list) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2)); } catch { /* in-memory still works */ }
}

let tasks = loadTasks();
let activity = [
  { id: 1, text: "Scout captured 12 tasks from Facebook, WhatsApp, Email, LinkedIn and your website.", at: now() },
  { id: 2, text: "Triage scored \"Reply to WhatsApp client asking for a bulk quote on 500 units\" as urgent.", at: now() },
  { id: 3, text: "Hawk is watching \"Facebook comment thread: customer asking about a return\" until the customer replies.", at: now() },
];
let autopilot = true;
let settings = {
  workspace: "Agentic Task OS",
  defaultPriority: "medium",
  autoMove: true,
  autoUnblock: true,
  autoPrioritize: true,
  autoAssign: true,
  autoApprove: false,
  notifyBlocked: true,
  pausedChannels: [],
  pausedAgents: [],
  org: { mandate: "Grow wholesale sales across every channel", office: "Head Office", organization: "Maple Trading Co." },
  projects: ["Q4 Wholesale Push", "Customer Care"],
  departments: ["Sales", "Network"],
};
let activityId = 10;
const log = (text) => {
  activity.unshift({ id: ++activityId, text, at: now() });
  activity = activity.slice(0, 50);
};

// --- AI command parsing: plain English -> a real task -----------------------
function parseCommand(text) {
  const lower = text.toLowerCase();
  const source =
    SOURCES.find((s) => lower.includes(s.toLowerCase())) ||
    (lower.includes("fb") ? "Facebook" : lower.includes("whatsapp") || lower.includes("wa ") ? "WhatsApp" : lower.includes("mail") ? "Email" : lower.includes("linkedin") || lower.includes("linked") ? "LinkedIn" : lower.includes("web") || lower.includes("site") ? "Website" : "Website");
  const priority = lower.includes("urgent") || lower.includes("asap") || lower.includes("immediately") ? "urgent"
    : lower.includes("important") || lower.includes("priority") || lower.includes("high") ? "high"
    : lower.includes("later") || lower.includes("low") ? "low" : "medium";
  const title = text.trim().replace(/^(please\s+)?(create|add|make)\s+(a\s+)?(task\s+)?(for\s+|to\s+)?/i, "").replace(/^./, (c) => c.toUpperCase());
  const billable = /invoice|quote|pricing|price|bill|order|demo|wholesale|contract/i.test(text);
  const category = /invoice|payment|balance/i.test(text) ? "Finance" : /quote|pricing|price|demo|wholesale|lead/i.test(text) ? "Sales" : /return|refund|complaint|help/i.test(text) ? "Support" : /deliver|ship|rider|stock/i.test(text) ? "Operations" : "Follow-up";
  return { title: title || text.trim(), source, priority, billable, category };
}
const departmentFor = (category) => (["Operations", "Support"].includes(category) ? "Network" : "Sales");
const nextPipeline = (p) => PIPELINES[Math.min(PIPELINES.indexOf(p) + 1, PIPELINES.length - 1)];

function transitionError(task, to) {
  const from = task.state;
  const ok = { Ready: ["Running", "Suspended"], Running: ["Ready", "Blocked"], Blocked: ["Ready"], Suspended: ["Ready"] };
  if (from === to) return null;
  if (!ok[from]?.includes(to)) return `Cannot move from ${from} to ${to}. Allowed: ${(ok[from] || []).join(", ") || "none"}.`;
  return null;
}

// --- Governance: Policy, KPI, OKR — computed live ---------------------------------
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 100);
function governance() {
  const open = tasks.filter((t) => t.pipeline !== "Done");
  const done = tasks.filter((t) => t.pipeline === "Done");
  const billableDone = done.filter((t) => t.billable && t.review?.decision !== "reject");
  const decisions = tasks.map((t) => t.review?.decision).filter(Boolean);
  const hist = tasks.flatMap((t) => t.history || []);
  const approved = hist.filter((h) => h.step === "Approved").length;
  const judged = hist.filter((h) => ["Approved", "Improve", "Rejected"].includes(h.step)).length;
  const unassigned = open.filter((t) => !t.agent);
  const unscheduled = open.filter((t) => !t.due && !t.dueLabel);
  const urgentWaiting = open.filter((t) => t.priority === "urgent" && t.pipeline === "Collect");
  const unbilledDone = billableDone.filter((t) => t.billing !== "Billed");
  const stuckReview = open.filter((t) => t.pipeline === "Review");

  const policies = [
    { id: "P1", rule: "Every open task has an owner", hint: "Unassigned tasks wait for an agent.", violations: unassigned },
    { id: "P2", rule: "Every open task has a due date or schedule", hint: "Unscheduled tasks can't be prioritised.", violations: unscheduled },
    { id: "P3", rule: "Urgent tasks never sit in Collect", hint: "Urgent work must be processed straight away.", violations: urgentWaiting },
    { id: "P4", rule: "Finished billable work gets billed", hint: "Done + billable + still Unbilled.", violations: unbilledDone },
  ].map((p) => ({ id: p.id, rule: p.rule, hint: p.hint, ok: p.violations.length === 0, tasks: p.violations.map((t) => ({ id: t.id, title: t.title })) }));

  const completion = pct(done.length, tasks.length);
  const approvalRate = pct(approved, judged);
  const billingRate = pct(billableDone.filter((t) => t.billing === "Billed").length, billableDone.length);
  const billableShare = pct(tasks.filter((t) => t.billable).length, tasks.length);
  const hot = tasks.filter((t) => ["urgent", "high"].includes(t.priority));
  const hotDone = pct(hot.filter((t) => t.pipeline === "Done").length, hot.length);

  const kpis = [
    { id: "completion", name: "Completion rate", value: completion, target: 80, unit: "%", higherIsBetter: true },
    { id: "approval", name: "Review approval rate", value: approvalRate, target: 85, unit: "%", higherIsBetter: true },
    { id: "billing", name: "Billing rate (done & billable)", value: billingRate, target: 100, unit: "%", higherIsBetter: true },
    { id: "unassigned", name: "Unassigned open tasks", value: unassigned.length, target: 0, unit: "", higherIsBetter: false },
    { id: "review", name: "Tasks waiting in Review", value: stuckReview.length, target: 2, unit: "", higherIsBetter: false },
  ].map((k) => ({ ...k, met: k.higherIsBetter ? k.value >= k.target : k.value <= k.target }));

  const kr = (text, current, target, unit = "%", invert = false) => ({
    text, current, target, unit, progress: invert ? (current <= target ? 100 : Math.max(0, Math.round((1 - (current - target) / Math.max(1, tasks.length)) * 100))) : Math.min(100, pct(current, target)),
  });
  const okrs = [
    { id: "O1", objective: "Never keep a customer waiting", keyResults: [
      kr("Finish 100% of urgent & high tasks", hotDone, 100),
      kr("Keep unassigned open tasks at 0", unassigned.length, 0, "", true),
      kr("Keep Review queue at 2 or fewer", stuckReview.length, 2, "", true),
    ] },
    { id: "O2", objective: "Get paid for the work we do", keyResults: [
      kr("Bill every finished billable task", billingRate, 100),
      kr("Make at least 50% of work billable", billableShare, 50),
    ] },
  ];

  const countBy = (list, key) => Object.fromEntries(list.map((k) => [k, tasks.filter((t) => t[key] === k).length]));
  return {
    org: settings.org, projects: settings.projects, departments: settings.departments,
    byProject: countBy(settings.projects, "project"), byDepartment: countBy(settings.departments, "department"),
    policies, kpis, okrs, decisions: decisions.length,
  };
}

// --- Routes ------------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true, tasks: tasks.length, autopilot }));
app.get("/api/meta", (_req, res) => res.json({ sources: SOURCES, pipelines: PIPELINES, states: STATES, agents: AGENTS, types: TYPES }));

app.get("/api/tasks", (req, res) => {
  const { source, pipeline, state, priority, q } = req.query;
  let out = [...tasks];
  if (source && source !== "All") out = out.filter((t) => t.source === source);
  if (pipeline) out = out.filter((t) => t.pipeline === pipeline);
  if (state) out = out.filter((t) => t.state === state);
  if (priority) out = out.filter((t) => t.priority === priority);
  if (q) out = out.filter((t) => (t.title + t.source + t.category).toLowerCase().includes(q.toLowerCase()));
  res.json(out.map(view));
});

app.post("/api/tasks", (req, res) => {
  const { title, source = "Website", priority = "auto", category = "General", due, details, department, project, billable, assignee = "auto" } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  const parsed = parseCommand(`${title} ${details || ""}`);
  const finalCategory = TYPES.includes(category) && category !== "General" ? category : parsed.category;
  const agent = assignee === "none" ? null : AGENTS.some((a) => a.name === assignee) ? assignee : settings.autoAssign ? "Triage" : null;
  const task = newTask({
    title: title.trim(), source: SOURCES.includes(source) ? source : "Website",
    priority: PRIORITY_LIST.includes(priority) ? priority : parsed.priority, category: finalCategory,
    agent, due: due || null,
    department: department || departmentFor(finalCategory), project: project || settings.projects[0],
    billable: typeof billable === "boolean" ? billable : parsed.billable,
    notes: details?.trim() || `Captured from ${source}.`,
  });
  tasks.unshift(task); saveTasks(tasks);
  log(`Triage scored "${task.title}" as ${task.priority} (${view(task).lifecycle.toLowerCase()}) from ${task.source}.`);
  res.status(201).json(view(task));
});

// The AI command bar: one line of English becomes a fully triaged task.
app.post("/api/command", (req, res) => {
  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text is required" });
  const p = parseCommand(text);
  const task = newTask({
    title: p.title, source: p.source, priority: p.priority, category: p.category, billable: p.billable,
    department: departmentFor(p.category), project: settings.projects[0],
    agent: "Triage", due: dayISO(1),
    notes: `Created by the AI command bar from: "${text.trim()}"`,
  });
  tasks.unshift(task); saveTasks(tasks);
  log(`Triage filed "${task.title}" from ${task.source} · ${task.priority} · ${task.category}${task.billable ? " · billable" : ""}.`);
  res.status(201).json({ task: view(task), parsed: p, message: `Captured from ${task.source} · AI set priority: ${task.priority} · type: ${task.category}` });
});

// Simulate an incoming task from one channel (until real accounts are connected).
app.post("/api/ingest/:source", (req, res) => {
  const source = req.params.source;
  if (!SOURCES.includes(source)) return res.status(400).json({ error: `Unknown source. Use one of: ${SOURCES.join(", ")}` });
  if (settings.pausedChannels.includes(source)) return res.status(400).json({ error: `${source} is paused in Settings — unpause it to capture tasks again.` });
  const titles = SAMPLE_TITLES[source];
  const title = titles[Math.floor(Math.random() * titles.length)];
  const p = parseCommand(title);
  const task = newTask({
    title, source, priority: ["medium", "high", "urgent"][Math.floor(Math.random() * 3)],
    category: p.category, billable: p.billable, department: departmentFor(p.category), project: settings.projects[0],
    agent: "Scout", due: Math.random() < 0.5 ? dayISO(1) : null,
    notes: `Simulated incoming task from ${source}. Connect the real ${source} account to replace this with live data.`,
  });
  tasks.unshift(task); saveTasks(tasks);
  log(`Scout captured "${title}" from ${source}.`);
  res.status(201).json(view(task));
});

app.patch("/api/tasks/:id", (req, res) => {
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  const { pipeline, state, title, notes, nextStep, category, priority, due, progress, department, project, billable, billing, agent } = req.body || {};
  if (state && state !== task.state) {
    const err = transitionError(task, state);
    if (err) return res.status(400).json({ error: err });
    task.state = state;
    log(`${state === "Running" ? "Runner started" : state === "Blocked" ? "Hawk blocked" : state === "Suspended" ? "TaskSuspend() paused" : "TaskResume() woke"} "${task.title}" (${task.state}).`);
  }
  if (pipeline && PIPELINES.includes(pipeline) && pipeline !== task.pipeline) {
    moveTo(task, pipeline, "You");
    log(`Runner moved "${task.title}" to ${pipeline}.`);
  }
  if (agent !== undefined) {
    const next = AGENTS.some((a) => a.name === agent) ? agent : null;
    if (next !== task.agent) {
      task.agent = next;
      addHistory(task, next ? "Assigned" : "Unassigned", "You", next ? `Owner: ${next}` : "Owner removed");
      log(next ? `${next} was assigned "${task.title}".` : `"${task.title}" is now unassigned.`);
    }
  }
  if (due !== undefined) {
    const next = due || null;
    if (next !== task.due) {
      task.due = next; task.dueLabel = ""; task.dueTime = "";
      addHistory(task, next ? "Scheduled" : "Unscheduled", "You", next ? `Due ${next}` : "Schedule removed");
    }
  }
  if (title !== undefined) task.title = title;
  if (notes !== undefined) task.notes = notes;
  if (nextStep !== undefined) task.nextStep = nextStep;
  if (category !== undefined && TYPES.includes(category)) task.category = category;
  if (priority !== undefined && PRIORITY_LIST.includes(priority)) task.priority = priority;
  if (progress !== undefined) task.progress = progress;
  if (department !== undefined && settings.departments.includes(department)) task.department = department;
  if (project !== undefined && settings.projects.includes(project)) task.project = project;
  if (billable !== undefined) { task.billable = Boolean(billable); if (!task.billable) task.billing = "Unbilled"; }
  if (billing !== undefined && ["Unbilled", "Billed"].includes(billing)) {
    if (billing === "Billed" && !task.billable) return res.status(400).json({ error: "Only billable tasks can be billed." });
    if (billing !== task.billing) { task.billing = billing; log(`"${task.title}" marked ${billing.toLowerCase()}.`); }
  }
  saveTasks(tasks);
  res.json(view(task));
});

// Review: Approve -> Do, Improve -> back to Process, Reject -> closed.
app.post("/api/tasks/:id/review", (req, res) => {
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  const { decision, note = "" } = req.body || {};
  if (!["approve", "improve", "reject"].includes(decision)) return res.status(400).json({ error: "decision must be approve, improve or reject" });
  if (task.pipeline !== "Review") return res.status(400).json({ error: "Only tasks in Review can be approved, improved or rejected." });
  task.review = { decision, note, at: now(), by: "You" };
  if (decision === "approve") {
    addHistory(task, "Approved", "You", note);
    task.pipeline = "Do"; task.progress = 90; task.state = "Ready"; task.agent = "Runner"; task.nextStep = "Runner executes the approved work.";
    log(`You approved "${task.title}" — moved to Do.`);
  } else if (decision === "improve") {
    addHistory(task, "Improve", "You", note);
    task.pipeline = "Process"; task.progress = 45; task.state = "Running"; task.agent = "Scribe"; task.revisions = (task.revisions || 0) + 1;
    task.nextStep = note || "Improve the draft and resubmit for review.";
    log(`You asked for improvements on "${task.title}" — back to Process (revision ${task.revisions}).`);
  } else {
    addHistory(task, "Rejected", "You", note);
    task.pipeline = "Done"; task.progress = 100; task.state = "Ready"; task.billable = false; task.billing = "Unbilled";
    task.dueLabel = "Rejected"; task.nextStep = "Rejected — closed.";
    log(`You rejected "${task.title}" — closed without billing.`);
  }
  saveTasks(tasks);
  res.json(view(task));
});

app.delete("/api/tasks/:id", (req, res) => {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== req.params.id);
  if (tasks.length === before) return res.status(404).json({ error: "Task not found" });
  saveTasks(tasks);
  res.json({ ok: true });
});

// Re-process loop: send a Done / reviewed task back for another pass.
app.post("/api/tasks/:id/reprocess", (req, res) => {
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  const { nextStep, notes } = req.body || {};
  task.pipeline = "Process"; task.state = "Running"; task.progress = 45; task.review = null;
  task.revisions = (task.revisions || 0) + 1;
  addHistory(task, "Improve", "You", "Re-processed");
  if (nextStep) task.nextStep = nextStep;
  if (notes) task.notes = notes;
  saveTasks(tasks);
  log(`Re-process: "${task.title}" went back to Process. Next step: ${task.nextStep}`);
  res.json(view(task));
});

app.get("/api/stats", (_req, res) => {
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, tasks.filter((t) => t.source === s).length]));
  const byState = Object.fromEntries(STATES.map((s) => [s, tasks.filter((t) => t.state === s).length]));
  const byPipeline = Object.fromEntries(PIPELINES.map((p) => [p, tasks.filter((t) => t.pipeline === p).length]));
  res.json({ total: tasks.length, done: byPipeline.Done || 0, bySource, byState, byPipeline, autopilot });
});

app.get("/api/governance", (_req, res) => res.json(governance()));
app.get("/api/activity", (_req, res) => res.json(activity));
app.get("/api/agents", (_req, res) => res.json(AGENTS.map((a) => ({ ...a, paused: settings.pausedAgents.includes(a.id) }))));
app.patch("/api/agents/:id", (req, res) => {
  const agent = AGENTS.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const paused = Boolean(req.body?.paused);
  settings.pausedAgents = paused ? [...new Set([...settings.pausedAgents, agent.id])] : settings.pausedAgents.filter((id) => id !== agent.id);
  log(`${agent.name} ${paused ? "paused — Autopilot will skip its tasks" : "resumed"}.`);
  res.json({ ...agent, paused });
});

app.get("/api/settings", (_req, res) => res.json(settings));
app.post("/api/settings", (req, res) => {
  const allowed = ["workspace", "defaultPriority", "autoMove", "autoUnblock", "autoPrioritize", "autoAssign", "autoApprove", "notifyBlocked", "pausedChannels", "pausedAgents", "org"];
  for (const key of allowed) if (req.body?.[key] !== undefined) settings[key] = key === "org" ? { ...settings.org, ...req.body.org } : req.body[key];
  log("Settings updated.");
  res.json(settings);
});
app.post("/api/reset", (_req, res) => {
  tasks = seedTasks(); saveTasks(tasks);
  log("Board reset to the sample tasks.");
  res.json({ ok: true, tasks: tasks.length });
});
app.post("/api/digest", (_req, res) => {
  const blocked = tasks.filter((t) => t.state === "Blocked").length;
  const done = tasks.filter((t) => t.pipeline === "Done").length;
  const review = tasks.filter((t) => t.pipeline === "Review").length;
  const msg = `Status digest: ${tasks.length} tasks, ${done} done, ${blocked} blocked, ${review} waiting for review.`;
  log(msg);
  res.json({ message: msg });
});

app.post("/api/autopilot", (req, res) => {
  autopilot = Boolean(req.body?.enabled);
  log(`Autopilot ${autopilot ? "ON — agents will move tasks on their own" : "OFF — you are in control"}.`);
  res.json({ autopilot });
});

// One Autopilot tick. Order: wake a blocked task -> assign/schedule one task -> move one task forward.
// Tasks waiting in Review are only moved on when "Auto-approve reviews" is on; otherwise a human decides.
app.post("/api/autopilot/tick", (_req, res) => {
  if (settings.autoUnblock) {
    const blocked = tasks.find((t) => t.state === "Blocked");
    if (blocked) {
      blocked.state = "Ready"; saveTasks(tasks);
      log(`Autopilot: Event woke blocked task "${blocked.title}" back to Ready.`);
      return res.json({ moved: view(blocked), unblocked: true });
    }
  }
  if (settings.autoAssign) {
    const loose = tasks.find((t) => t.pipeline !== "Done" && (!t.agent || (!t.due && !t.dueLabel)));
    if (loose) {
      if (!loose.agent) {
        loose.agent = STAGE_OWNER[loose.pipeline];
        addHistory(loose, "Assigned", "Triage", `Owner: ${loose.agent}`);
        log(`Triage assigned "${loose.title}" to ${loose.agent}.`);
      } else {
        loose.due = dayISO(1);
        addHistory(loose, "Scheduled", "Triage", `Due ${loose.due}`);
        log(`Triage scheduled "${loose.title}" for tomorrow.`);
      }
      saveTasks(tasks);
      return res.json({ moved: view(loose), assigned: true });
    }
  }
  if (!settings.autoMove) return res.json({ moved: null, message: "Auto-move is off in Automations." });
  const pausedNames = new Set(AGENTS.filter((a) => settings.pausedAgents.includes(a.id)).map((a) => a.name));
  const task = tasks.find((t) =>
    t.pipeline !== "Done" && t.agent && t.state !== "Blocked" && t.state !== "Suspended" && !pausedNames.has(t.agent) &&
    (t.pipeline !== "Review" || settings.autoApprove));
  if (!task) return res.json({ moved: null, message: "Nothing to move right now." });
  const from = task.agent;
  if (task.pipeline === "Review") {
    task.review = { decision: "approve", note: "Auto-approved", at: now(), by: "Autopilot" };
    addHistory(task, "Approved", "Autopilot", "Auto-approved");
  }
  moveTo(task, nextPipeline(task.pipeline), from);
  if (task.pipeline === "Review") task.agent = "Scribe";
  if (task.pipeline === "Do" || task.pipeline === "Done") task.agent = "Runner";
  if (task.pipeline === "Done") task.nextStep = "Nothing — task closed.";
  saveTasks(tasks);
  if (task.pipeline === "Process") log(`${from} picked up "${task.title}" — now running.`);
  else if (task.pipeline === "Review") log(`Scribe drafted "${task.title}" — waiting for your review.`);
  else if (task.pipeline === "Do") log(`Scribe's draft for "${task.title}" passed review — moved to Do.`);
  else log(`Runner finished "${task.title}" ✓ — ${task.source} task closed.`);
  res.json({ moved: view(task) });
});

app.listen(PORT, () => console.log(`Agentic Task API running on http://localhost:${PORT}`));
