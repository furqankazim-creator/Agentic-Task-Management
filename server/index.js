import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { aiEnabled, aiStatus, aiTriage, aiDraft } from "./ai.js";
import { CONFIG_KEYS, configHints, testChannel, resetTransport, channelStatus, verifyMetaSignature, checkVerifyToken, checkWebsiteKey, parseMetaPayload, sendWhatsApp, sendMessenger, sendFacebookComment, subscribePage, registerMetaWebhooks, fetchFacebookInbox, sendEmail } from "./integrations.js";
import crypto from "crypto";
import { hashPassword, checkPassword, makeToken, readToken, newSecret } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch { /* no .env file: Groq stays off */ }
const DATA_DIR = process.env.DATA_DIR || __dirname; // DATA_DIR lets tests run on a throw-away copy of the data
const DATA_FILE = path.join(DATA_DIR, "tasks.json");
const TEAM_FILE = path.join(DATA_DIR, "team.json");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
export const SOURCES = ["Facebook", "Instagram", "Website", "WhatsApp", "Email", "LinkedIn"];
export const PIPELINES = ["Collect", "Process", "Review", "Do", "Done"];
export const STATES = ["Ready", "Running", "Blocked", "Suspended"];
export const TYPES = ["Bug", "Feature", "Support", "DevOps", "SEO", "Marketing", "Sales", "Finance", "General"];
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
  Facebook: ["Facebook message: user says the mobile app crashes when uploading a photo", "Facebook comment: customer asks if we build custom CRM software"],
  Instagram: ["Instagram DM: user asks how much a business website costs", "Instagram comment: customer asks if we build mobile apps"],
  Website: ["Website form: new client wants a quote for an e-commerce platform", "Website live chat: visitor reports the contact page throws an error"],
  WhatsApp: ["WhatsApp: client says the login API returns 500 errors in production", "WhatsApp: client wants a progress update on the dashboard feature"],
  Email: ["Email: client asks to add SSO login to their portal", "Email: Google Search Console flagged duplicate title tags on the blog"],
  LinkedIn: ["LinkedIn: reply to a partnership message from a digital agency", "LinkedIn: recruiter-style lead asks about hiring a dev team for 3 months"],
};

const DEFAULT_PASSWORD = "welcome123";
const DEFAULT_SLA = { urgent: 60, high: 240, medium: 1440, low: 4320 }; // minutes to first response
const DEFAULT_TEAM = [
  { id: "M1", name: "Irfan Nawaz", username: "irfan", email: "irfan@taskmanager.local", phone: "", role: "Senior Developer", access: "member", department: "Engineering", capacity: 6, color: "#3b82f6" },
  { id: "M2", name: "Hasnain Hadi", username: "hasnain", email: "hasnain@taskmanager.local", phone: "", role: "Developer", access: "member", department: "Engineering", capacity: 5, color: "#10b981" },
  { id: "M3", name: "Zahoor Jamali", username: "zahoor", email: "zahoor@taskmanager.local", phone: "", role: "Developer", access: "member", department: "Engineering", capacity: 5, color: "#8b5cf6" },
  { id: "M4", name: "Ahmed Massror", username: "ahmed", email: "ahmed@taskmanager.local", phone: "", role: "CEO", access: "admin", department: "Marketing", capacity: 5, color: "#f59e0b" },
  { id: "M5", name: "Akhter", username: "akhter", email: "akhter@taskmanager.local", phone: "", role: "Marketing", access: "member", department: "Marketing", capacity: 6, color: "#ec4899" },
];
function loadStore() {
  try {
    if (fs.existsSync(TEAM_FILE)) {
      const st = JSON.parse(fs.readFileSync(TEAM_FILE, "utf8"));
      if (Array.isArray(st.team) && st.team.length && st.credentials && st.secret) { st.team.forEach((m) => { m.email ||= `${m.username}@taskmanager.local`; m.phone ||= ""; }); return { ...st, sla: { ...DEFAULT_SLA, ...(st.sla || {}) } }; }
    }
  } catch { /* fall through to defaults */ }
  const st = { team: DEFAULT_TEAM, credentials: Object.fromEntries(DEFAULT_TEAM.map((m) => [m.id, hashPassword(DEFAULT_PASSWORD)])), secret: newSecret(), sla: DEFAULT_SLA };
  try { fs.writeFileSync(TEAM_FILE, JSON.stringify(st, null, 2)); } catch { /* in-memory still works */ }
  return st;
}
const store = loadStore();

let idCounter = 113;
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
const view = (t) => ({ ...t, lifecycle: lifecycleOf(t), sla: slaOf(t), escalated: Boolean(t.escalatedAt), conv: t.contact ? convSummary(inbox.convs[t.contact.convId || t.contact.key]) : null });
const addHistory = (t, step, by = "System", note = "") => { (t.history ||= []).push({ step, at: now(), by, note }); };

function newTask(fields) {
  const t = {
    id: uid(), pipeline: "Collect", state: "Ready", progress: 10, agent: null, assignee: null, demo: false, contact: null, comments: [], watchers: [], respondedAt: null, escalatedAt: null, escalatedTo: [], draft: "", summary: "", aiBy: "", aiReason: "", due: null, dueTime: "", dueLabel: "",
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
  if (["Review", "Do", "Done"].includes(pipeline) && !task.respondedAt && !task.contact) { task.respondedAt = now(); addHistory(task, "Responded", by, "First response recorded"); }
  if (pipeline === "Review") { task.review = null; addHistory(task, "Review", by); }
  if (from === "Review" && pipeline !== "Review" && !task.review) {
    // dragged out of Review without using the buttons: treat as an implicit decision
    const decision = pipeline === "Process" || pipeline === "Collect" ? "improve" : "approve";
    task.review = { decision, note: "Moved by hand", at: now(), by: "You" };
    addHistory(task, decision === "approve" ? "Approved" : "Improve", "You", "Moved by hand");
  }
}

// --- Workflow rules: tasks only move when a person (or a real event) moves them ------------------------
//   Collect  new, nobody has started          Process  being worked on / replying
//   Review   lead checks the work             Do       approved, being delivered       Done  closed
function pipelineRuleError(user, task, to, force) {
  const from = task.pipeline, fi = PIPELINES.indexOf(from), ti = PIPELINES.indexOf(to), lead = isLead(user);
  if (!lead) {
    if (task.assignee && task.assignee !== user.id) return "Only the assignee or a team lead can move this task.";
    const reopen = from === "Done" && to === "Process";
    if (!reopen && Math.abs(ti - fi) > 1) return `Move one stage at a time (next: ${PIPELINES[fi + Math.sign(ti - fi)]}). A team lead can skip stages.`;
    if (from === "Review" && ti > fi) return "Only a team lead can approve work out of Review — use Approve / Improve / Reject.";
  }
  if (to === "Done" && task.contact && !task.respondedAt && !force) return "No reply has been sent to the customer yet. Reply first, or close it without a reply.";
  return null;
}
// The first real reply to a customer starts the work: Collect -> Process, owned by whoever replied.
function afterReply(task, user) {
  if (!task.respondedAt) task.respondedAt = now();
  if (task.pipeline === "Collect") {
    if (!task.assignee && user) { const m = settings.team.find((x) => x.id === user.id); if (m) assignMember(task, m, user.name, true); }
    moveTo(task, "Process", user?.name || "System");
    addHistory(task, "Stage", user?.name || "System", "Collect → Process (first reply sent)");
  }
}

// --- Seed data ------------------------------------------------------------------
// [id, source, title, pipeline, state, priority, agent, progress, dayOffset|null, dueTime, dueLabel, type, notes, department, project, billable, billing, assignee, ageMinutes]
const SEED = [
  ["T-101", "Email", "Client reports the checkout page crashes on Safari after the last release", "Done", "Ready", "urgent", "Runner", 100, 0, "4:30 PM", "", "Bug", "Hotfix shipped and confirmed by the client.", "Engineering", "Client Projects", true, "Billed", "M2", 2400],
  ["T-102", "Website", "Website form: new client wants a quote for a mobile app", "Process", "Running", "high", "Triage", 45, 1, "", "", "Sales", "Requirements call to be scheduled.", "Marketing", "Client Projects", true, "Unbilled", "M5", 130],
  ["T-103", "WhatsApp", "WhatsApp: client says the login API returns 500 errors in production", "Collect", "Ready", "urgent", "Scout", 10, 0, "", "", "Bug", "Client is blocked — investigate the auth service logs first.", "Engineering", "Client Projects", true, "Unbilled", "M1", 95],
  ["T-104", "Email", "Email: enterprise client asks to add SSO login to the dashboard", "Review", "Ready", "high", "Scribe", 70, 3, "", "", "Feature", "Draft reply with an estimate is waiting for review.", "Engineering", "Client Projects", true, "Unbilled", "M1", 600],
  ["T-105", "Facebook", "Facebook comment: user says the app drains battery after the update", "Process", "Running", "medium", "Triage", 45, 2, "", "", "Support", "Collecting device details from the user.", "Engineering", "Product Roadmap", false, "Unbilled", "M3", 300],
  ["T-106", "Website", "Publish the SEO article on 'custom software development cost'", "Process", "Running", "medium", "Scribe", 50, 3, "", "", "SEO", "Outline approved; draft in progress.", "Marketing", "Growth & SEO", false, "Unbilled", "M4", 600],
  ["T-107", "LinkedIn", "LinkedIn: reply to the partnership message from a digital agency", "Collect", "Ready", "medium", "Scout", 10, null, "", "", "Sales", "Captured from LinkedIn InMail.", "Marketing", "Client Projects", true, "Unbilled", "M5", 90],
  ["T-108", "Email", "Fix the broken sitemap and robots.txt flagged by Google Search Console", "Process", "Running", "high", "Triage", 45, 1, "", "", "SEO", "Search Console shows 14 pages excluded.", "Marketing", "Growth & SEO", false, "Unbilled", "M4", 200],
  ["T-109", "Website", "Website live chat: visitor asked if we support on-premise deployment", "Review", "Ready", "medium", "Scribe", 70, 0, "", "", "Support", "Draft answer is waiting for review.", "Engineering", "Client Projects", false, "Unbilled", "M2", 120],
  ["T-110", "Email", "Run the Q4 social media campaign for the new product launch", "Do", "Running", "high", "Runner", 90, 4, "", "", "Marketing", "Posts scheduled; waiting on final creatives.", "Marketing", "Growth & SEO", false, "Unbilled", "M5", 1500],
  ["T-111", "WhatsApp", "Deploy the new build to staging for tomorrow's client demo", "Process", "Running", "high", "Runner", 45, 1, "", "", "DevOps", "CI pipeline is green; deploy scheduled.", "Engineering", "Client Projects", true, "Unbilled", "M3", 30],
  ["T-112", "Email", "Security scan flagged an outdated dependency in the client portal", "Collect", "Ready", "urgent", "Scout", 10, 0, "", "", "DevOps", "Upgrade the package and re-run the scan.", "Engineering", "Client Projects", true, "Unbilled", "M1", 25],
  ["T-113", "Email", "Send the final invoice for the CRM integration project", "Done", "Ready", "medium", "Runner", 100, null, "", "Done", "Finance", "Invoice prepared; waiting to be marked billed.", "Engineering", "Client Projects", true, "Unbilled", "M1", 3000],
];

function seedTasks() {
  idCounter = 113;
  return SEED.map(([id, source, title, pipeline, state, priority, agent, progress, day, dueTime, dueLabel, category, notes, department, project, billable, billing, assignee, ageMin]) => {
    const createdAt = new Date(Date.now() - ageMin * 60000).toISOString();
    const t = newTask({
      title, source, pipeline, state, priority, agent, progress, category, notes, department, project, billable, billing, assignee,
      due: day === null ? null : dayISO(day), dueTime, dueLabel, createdAt,
      respondedAt: ["Review", "Do", "Done"].includes(pipeline) ? new Date(Date.parse(createdAt) + 15 * 60000).toISOString() : null,
      nextStep: pipeline === "Done" ? "Nothing — task closed." : "Decide next step, then move it to the next stage.",
    });
    t.id = id; t.demo = true; t.sampleV2 = true;
    const who = DEFAULT_TEAM.find((m) => m.id === assignee);
    if (who) addHistory(t, "Team assigned", "Triage", `${who.name} (${who.role})`);
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
      if (Array.isArray(parsed) && parsed.length && parsed.every((t) => /^T-\d+$/.test(t.id) && Array.isArray(t.history) && "respondedAt" in t && "assignee" in t)) {
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
  { id: 1, text: "Scout captured 13 tasks from Facebook, WhatsApp, Email, LinkedIn and your website.", at: now() },
  { id: 2, text: "Triage scored \"WhatsApp: client says the login API returns 500 errors in production\" as urgent.", at: now() },
  { id: 3, text: "Hawk is watching SLA timers — a missed first response escalates to the team lead.", at: now() },
];
let autopilot = false; // demo only: never moves real customer tasks
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
  org: { mandate: "Ship reliable software and grow our client base", office: "Head Office", organization: "Our Software Company" },
  projects: ["Client Projects", "Product Roadmap", "Growth & SEO"],
  departments: ["Engineering", "Marketing"],
  team: store.team,
  runnerAutoSend: store.flags?.runnerAutoSend ?? true,
  sla: store.sla,
};
let activityId = 10;
const log = (text) => {
  activity.unshift({ id: ++activityId, text, at: now() });
  activity = activity.slice(0, 50);
};

// --- Team: human members tasks can be assigned to ---------------------------------
const isOpen = (t) => t.pipeline !== "Done";
const memberLoad = (m) => tasks.filter((t) => t.assignee === m.id && isOpen(t)).length;
// Best member for a task: same department first, then the one with the most spare capacity.
function pickMember(task) {
  const pool = settings.team.filter((m) => m.department === task.department);
  const list = pool.length ? pool : settings.team;
  return list.slice().sort((a, b) => memberLoad(a) / a.capacity - memberLoad(b) / b.capacity)[0] || null;
}
function saveStore() {
  try { fs.writeFileSync(TEAM_FILE, JSON.stringify({ team: settings.team, credentials: store.credentials, secret: store.secret, sla: settings.sla, flags: { runnerAutoSend: settings.runnerAutoSend } }, null, 2)); } catch { /* in-memory still works */ }
}
let notifications = [];
let notifId = 0;
let lastDeliveryError = "";
const sent = { email: 0, whatsapp: 0 };
// Outside the app: email and/or WhatsApp, only for people who have an address / phone and only when configured.
function deliverExternal(m, text) {
  const ch = channelStatus();
  if (ch.email && m.email && !m.email.endsWith(".local")) {
    sendEmail(m.email, `Task Manager: ${text.slice(0, 70)}`, `${text}\n\nOpen the Task Manager to act on it.`).then(() => { sent.email += 1; }).catch((e) => { lastDeliveryError = `email to ${m.name}: ${e.message}`; });
  }
  if (ch.whatsapp && m.phone) {
    sendWhatsApp(m.phone, `Task Manager: ${text}`).then(() => { sent.whatsapp += 1; }).catch((e) => { lastDeliveryError = `WhatsApp to ${m.name}: ${e.message}`; });
  }
}
const notify = (to, text, taskId = null) => {
  notifications.unshift({ id: ++notifId, to, text, taskId, at: now(), read: false });
  notifications = notifications.slice(0, 300);
  const m = settings.team.find((x) => x.id === to);
  if (m) deliverExternal(m, text);
};
function assignMember(task, member, by = "System", quiet = false) {
  if ((member?.id || null) === (task.assignee || null)) return false;
  task.assignee = member ? member.id : null;
  addHistory(task, member ? "Team assigned" : "Team unassigned", by, member ? `${member.name} (${member.role})` : "Team owner removed");
  log(member ? `${by} assigned "${task.title}" to ${member.name}.` : `"${task.title}" has no team owner now.`);
  if (member && member.name !== by && !quiet) notify(member.id, `${by} assigned you: ${task.title}`, task.id);
  return true;
}

// --- SLA: first-response timers, escalate to the lead when missed ---------------------
const slaMinutes = (p) => settings.sla[p] || settings.sla.medium;
const slaDueAt = (t) => new Date(Date.parse(t.createdAt) + slaMinutes(t.priority) * 60000).toISOString();
function slaOf(t) {
  const dueAt = slaDueAt(t);
  if (t.respondedAt) return { dueAt, status: Date.parse(t.respondedAt) <= Date.parse(dueAt) ? "met" : "late" };
  const total = slaMinutes(t.priority) * 60000;
  const nowMs = Date.now();
  if (nowMs > Date.parse(dueAt)) return { dueAt, status: "breached" };
  return { dueAt, status: (nowMs - Date.parse(t.createdAt)) / total >= 0.75 ? "risk" : "ok" };
}
const leadsFor = (dept) => settings.team.filter((m) => m.access === "admin" || (m.access === "lead" && m.department === dept));
let lastHawkCheck = null;
function checkSla() {
  lastHawkCheck = now();
  let changed = false;
  for (const t of tasks) {
    if (t.pipeline === "Done" || t.respondedAt) continue;
    const st = slaOf(t).status;
    if (st === "risk" && !t.slaWarnedAt) {
      t.slaWarnedAt = now(); changed = true;
      if (t.assignee) notify(t.assignee, `SLA at risk: reply soon to "${t.title}"`, t.id);
    }
    if (st === "breached" && !t.escalatedAt) {
      const leads = leadsFor(t.department);
      t.escalatedAt = now(); t.escalatedTo = leads.map((m) => m.id); changed = true;
      addHistory(t, "SLA breached", "Hawk", `${t.priority} reply was due within ${slaMinutes(t.priority)} min — escalated to ${leads.map((m) => m.name).join(", ") || "nobody"}`);
      log(`Hawk escalated "${t.title}" to ${leads.map((m) => m.name).join(", ")} — ${t.priority} SLA missed.`);
      new Set([...leads.map((m) => m.id), t.assignee].filter(Boolean)).forEach((id) =>
        notify(id, `SLA missed (${t.priority}): "${t.title}" was not answered in time`, t.id));
    }
  }
  if (changed) saveTasks(tasks);
}
setInterval(checkSla, 30000);
function teamStats() {
  const today = dayISO(0);
  return settings.team.map((m) => {
    const mine = tasks.filter((t) => t.assignee === m.id);
    const open = mine.filter(isOpen);
    return {
      ...m, open: open.length, done: mine.length - open.length,
      overdue: open.filter((t) => t.due && t.due < today).length,
      urgent: open.filter((t) => ["urgent", "high"].includes(t.priority)).length,
      load: Math.round((open.length / m.capacity) * 100),
    };
  });
}

// --- AI command parsing: plain English -> a real task -----------------------
function parseCommand(text) {
  const lower = text.toLowerCase();
  const source =
    SOURCES.find((s) => lower.includes(s.toLowerCase())) ||
    (lower.includes("fb") ? "Facebook" : lower.includes("whatsapp") || lower.includes("wa ") ? "WhatsApp" : lower.includes("mail") ? "Email" : lower.includes("linkedin") || lower.includes("linked") ? "LinkedIn" : lower.includes("web") || lower.includes("site") ? "Website" : "Website");
  const priority = /urgent|asap|immediately|outage|crash|security|data loss|production/.test(lower) ? "urgent"
    : lower.includes("important") || lower.includes("priority") || lower.includes("high") ? "high"
    : lower.includes("later") || lower.includes("low") ? "low" : "medium";
  const title = text.trim().replace(/^(please\s+)?(create|add|make)\s+(a\s+)?(task\s+)?(for\s+|to\s+)?/i, "").replace(/^./, (c) => c.toUpperCase());
  const billable = /invoice|quote|pricing|price|bill|order|demo|contract|proposal|feature|integration|estimate/i.test(text);
  const category = /deploy|server|staging|pipeline|dependency|security|outage|downtime|docker|release|ci\/cd/i.test(text) ? "DevOps"
    : /crash|bug|error|broken|exception|500|not working|fails|failing|regression|hotfix/i.test(text) ? "Bug"
    : /seo|keyword|backlink|ranking|sitemap|robots|search console|blog|article/i.test(text) ? "SEO"
    : /campaign|social media|newsletter|\bads?\b|launch|branding|content calendar/i.test(text) ? "Marketing"
    : /feature|implement|integration|sso|add support|new module|dashboard|mobile app|\bapi\b/i.test(text) ? "Feature"
    : /quote|proposal|pricing|demo|contract|partnership|lead|wholesale/i.test(text) ? "Sales"
    : /invoice|payment|balance|billing/i.test(text) ? "Finance"
    : /help|how do|support|question|asked|battery|refund|complaint/i.test(text) ? "Support" : "General";
  return { title: title || text.trim(), source, priority, billable, category };
}
const departmentFor = (category) => (["SEO", "Marketing", "Sales"].includes(category) ? "Marketing" : "Engineering");

// Groq triage when a key is set, keyword rules otherwise. Always returns a usable result.
async function triage(text, source) {
  const p = parseCommand(text);
  const base = { ...p, source: source || p.source, department: departmentFor(p.category), assigneeId: null, reason: "", draft: "", summary: "", via: "keywords" };
  const ai = await aiTriage({ text, source: base.source, types: TYPES, departments: settings.departments, team: teamStats() });
  if (!ai) return base;
  const category = ai.category || base.category;
  return {
    ...base, priority: ai.priority || base.priority, category, department: ai.department || departmentFor(category),
    billable: ai.billable ?? base.billable, assigneeId: ai.assigneeId, reason: ai.reason, draft: ai.reply, summary: ai.summary, via: "Groq",
  };
}
function applyTriage(task, r) {
  task.aiBy = r.via; task.aiReason = r.reason; task.draft = r.draft || task.draft; task.summary = r.summary || task.summary;
  addHistory(task, "Triaged", r.via === "Groq" ? "Triage (Groq AI)" : "Triage", `${r.priority} · ${r.category}${r.reason ? ` · ${r.reason}` : ""}`);
}
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
  const noTeamOwner = open.filter((t) => !t.assignee);
  const overloaded = teamStats().filter((m) => m.open > m.capacity);
  const slaBreached = open.filter((t) => slaOf(t).status === "breached");
  const slaJudged = tasks.filter((t) => ["met", "late", "breached"].includes(slaOf(t).status));
  const urgentWaiting = open.filter((t) => t.priority === "urgent" && t.pipeline === "Collect");
  const unbilledDone = billableDone.filter((t) => t.billing !== "Billed");
  const stuckReview = open.filter((t) => t.pipeline === "Review");

  const policies = [
    { id: "P1", rule: "Every open task has an owner", hint: "Unassigned tasks wait for an agent.", violations: unassigned },
    { id: "P2", rule: "Every open task has a due date or schedule", hint: "Unscheduled tasks can't be prioritised.", violations: unscheduled },
    { id: "P3", rule: "Urgent tasks never sit in Collect", hint: "Urgent work must be processed straight away.", violations: urgentWaiting },
    { id: "P6", rule: "Every task is answered within its SLA", hint: "Urgent 1h · High 4h · Medium 24h · Low 72h (editable in Settings).", violations: slaBreached },
    { id: "P5", rule: "Every open task has a team member", hint: "Assign a person so someone is accountable.", violations: noTeamOwner },
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
    { id: "sla", name: "SLA compliance (first response)", value: pct(slaJudged.filter((t) => slaOf(t).status === "met").length, slaJudged.length), target: 90, unit: "%", higherIsBetter: true },
    { id: "slabreach", name: "Open tasks past their SLA", value: slaBreached.length, target: 0, unit: "", higherIsBetter: false },
    { id: "noowner", name: "Open tasks with no team member", value: noTeamOwner.length, target: 0, unit: "", higherIsBetter: false },
    { id: "overload", name: "Overloaded team members", value: overloaded.length, target: 0, unit: "", higherIsBetter: false },
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
// --- Auth: every /api route except login & health needs a signed token ---------------
const loginFails = new Map();
const publicUser = (m) => ({ id: m.id, name: m.name, username: m.username, email: m.email, role: m.role, access: m.access, department: m.department, color: m.color });
app.post("/api/login", (req, res) => {
  const { username = "", password = "" } = req.body || {};
  const key = req.ip;
  const f = loginFails.get(key);
  if (f && f.count >= 8 && Date.now() - f.at < 15 * 60000) return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  const id = String(username).trim().toLowerCase();
  const m = settings.team.find((x) => x.username === id || x.email?.toLowerCase() === id);
  if (!m || !checkPassword(password, store.credentials[m.id])) {
    loginFails.set(key, { count: (f && Date.now() - f.at < 15 * 60000 ? f.count : 0) + 1, at: Date.now() });
    return res.status(401).json({ error: "Wrong username or password." });
  }
  loginFails.delete(key);
  log(`${m.name} signed in.`);
  res.json({ token: makeToken(store.secret, m.id), user: publicUser(m) });
});
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/webhooks/") || req.path.startsWith("/internal/")) return next();
  const id = readToken(store.secret, (req.headers.authorization || "").replace(/^Bearer /, ""));
  const user = settings.team.find((m) => m.id === id);
  if (!user) return res.status(401).json({ error: "Please sign in." });
  req.user = user; next();
});
const isLead = (u) => u.access === "admin" || u.access === "lead";
const needLead = (req, res, next) => (isLead(req.user) ? next() : res.status(403).json({ error: "Only team leads can do that." }));
const needAdmin = (req, res, next) => (req.user.access === "admin" ? next() : res.status(403).json({ error: "Only the admin can do that." }));
const canSee = (u, t) => u.access === "admin" || t.assignee === u.id || (t.watchers || []).includes(u.id) || (u.access === "lead" && t.department === u.department);
const visibleTasks = (u) => tasks.filter((t) => canSee(u, t));
const findTask = (req, res) => {
  const t = tasks.find((x) => x.id === req.params.id);
  if (!t || !canSee(req.user, t)) { res.status(404).json({ error: "Task not found" }); return null; }
  return t;
};
app.get("/api/me", (req, res) => res.json(publicUser(req.user)));
app.post("/api/me/password", (req, res) => {
  const { current = "", next = "" } = req.body || {};
  if (!checkPassword(current, store.credentials[req.user.id])) return res.status(400).json({ error: "Current password is wrong." });
  if (String(next).length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  store.credentials[req.user.id] = hashPassword(next); saveStore();
  res.json({ ok: true });
});
app.get("/api/notifications", (req, res) => res.json(notifications.filter((n) => n.to === req.user.id).slice(0, 60)));
app.post("/api/notifications/read", (req, res) => {
  const { id, convId } = req.body || {};
  notifications.forEach((n) => { if (n.to === req.user.id && (!id && !convId || n.id === id || (convId && n.convId === convId))) n.read = true; });
  res.json({ ok: true });
});
app.get("/api/ai/status", (_req, res) => res.json(aiStatus()));

app.get("/api/health", (_req, res) => res.json({ ok: true, tasks: tasks.length, autopilot }));
app.get("/api/meta", (_req, res) => res.json({ sources: SOURCES, pipelines: PIPELINES, states: STATES, agents: AGENTS, types: TYPES }));

app.get("/api/tasks", (req, res) => {
  const { source, pipeline, state, priority, q } = req.query;
  checkSla();
  let out = visibleTasks(req.user);
  if (source && source !== "All") out = out.filter((t) => t.source === source);
  if (pipeline) out = out.filter((t) => t.pipeline === pipeline);
  if (state) out = out.filter((t) => t.state === state);
  if (priority) out = out.filter((t) => t.priority === priority);
  if (q) out = out.filter((t) => (t.title + t.source + t.category).toLowerCase().includes(q.toLowerCase()));
  res.json(out.map(view));
});

app.post("/api/tasks", async (req, res) => {
  const { title, source = "Website", priority = "auto", category = "General", due, details, department, project, billable, assignee = "auto", member = "auto" } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  const text = `${title} ${details || ""}`;
  const r = await triage(text, SOURCES.includes(source) ? source : "Website");
  const finalCategory = TYPES.includes(category) && category !== "General" ? category : r.category;
  const agent = assignee === "none" ? null : AGENTS.some((a) => a.name === assignee) ? assignee : settings.autoAssign ? "Triage" : null;
  const task = newTask({
    title: title.trim(), source: SOURCES.includes(source) ? source : "Website",
    priority: PRIORITY_LIST.includes(priority) ? priority : r.priority, category: finalCategory,
    agent, due: due || null,
    department: department || (finalCategory === r.category ? r.department : departmentFor(finalCategory)), project: project || settings.projects[0],
    billable: typeof billable === "boolean" ? billable : r.billable,
    notes: details?.trim() || `Captured from ${source}.`,
  });
  applyTriage(task, r);
  // Members create work for themselves; leads/admin can route it (AI suggestion first, then workload).
  const chosen = !isLead(req.user) ? req.user
    : member === "none" ? null
    : settings.team.find((m) => m.id === member) || (settings.autoAssign ? settings.team.find((m) => m.id === r.assigneeId) || pickMember(task) : null);
  if (chosen) assignMember(task, chosen, r.via === "Groq" && member === "auto" ? "Triage (Groq AI)" : req.user.name);
  tasks.unshift(task); saveTasks(tasks);
  log(`Triage (${r.via}) scored "${task.title}" as ${task.priority} (${view(task).lifecycle.toLowerCase()}) from ${task.source}.`);
  res.status(201).json(view(task));
});

// The AI command bar: one line of English becomes a fully triaged task.
app.post("/api/command", async (req, res) => {
  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text is required" });
  const r = await triage(text, null);
  const p = { ...r, title: r.summary || r.title };
  const task = newTask({
    title: p.title, source: p.source, priority: p.priority, category: p.category, billable: p.billable,
    department: p.department, project: settings.projects[0],
    agent: "Triage", due: dayISO(1),
    notes: `Created by the AI command bar from: "${text.trim()}"`,
  });
  applyTriage(task, r);
  const chosen = !isLead(req.user) ? req.user : settings.team.find((m) => m.id === r.assigneeId) || (settings.autoAssign ? pickMember(task) : null);
  if (chosen) assignMember(task, chosen, r.via === "Groq" ? "Triage (Groq AI)" : "Triage");
  tasks.unshift(task); saveTasks(tasks);
  log(`Triage (${r.via}) filed "${task.title}" from ${task.source} · ${task.priority} · ${task.category}${task.billable ? " · billable" : ""}.`);
  res.status(201).json({ task: view(task), parsed: p, message: `Captured from ${task.source} · ${r.via === "Groq" ? "Groq AI" : "rules"} set priority: ${task.priority} · type: ${task.category}${chosen ? ` · assigned to ${chosen.name}` : ""}` });
});

// Simulate an incoming task from one channel (until real accounts are connected).
app.post("/api/ingest/:source", needLead, async (req, res) => {
  const source = req.params.source;
  if (!SOURCES.includes(source)) return res.status(400).json({ error: `Unknown source. Use one of: ${SOURCES.join(", ")}` });
  if (settings.pausedChannels.includes(source)) return res.status(400).json({ error: `${source} is paused in Settings — unpause it to capture tasks again.` });
  const titles = SAMPLE_TITLES[source];
  const title = titles[Math.floor(Math.random() * titles.length)];
  const r = await triage(title, source);
  const task = newTask({
    title, source, priority: r.priority, category: r.category, billable: r.billable, department: r.department, project: settings.projects[0],
    agent: "Scout", due: Math.random() < 0.5 ? dayISO(1) : null,
    demo: true,
    notes: `Simulated incoming task from ${source}. Connect the real ${source} account to replace this with live data.`,
  });
  applyTriage(task, r);
  const chosen = settings.team.find((m) => m.id === r.assigneeId) || (settings.autoAssign ? pickMember(task) : null);
  if (chosen) assignMember(task, chosen, r.via === "Groq" ? "Triage (Groq AI)" : "Triage");
  tasks.unshift(task); saveTasks(tasks);
  log(`Scout captured "${title}" from ${source}.`);
  res.status(201).json(view(task));
});

app.patch("/api/tasks/:id", async (req, res) => {
  let runAfter = false;
  const task = findTask(req, res);
  if (!task) return;
  if (!isLead(req.user) && req.body?.assignee !== undefined) return res.status(403).json({ error: "Only team leads can reassign tasks." });
  const { pipeline, state, title, notes, nextStep, category, priority, due, progress, department, project, billable, billing, agent, assignee, draft } = req.body || {};
  if (state && state !== task.state) {
    const err = transitionError(task, state);
    if (err) return res.status(400).json({ error: err });
    task.state = state;
    log(`${state === "Running" ? "Runner started" : state === "Blocked" ? "Hawk blocked" : state === "Suspended" ? "TaskSuspend() paused" : "TaskResume() woke"} "${task.title}" (${task.state}).`);
  }
  if (pipeline && PIPELINES.includes(pipeline) && pipeline !== task.pipeline) {
    const bad = pipelineRuleError(req.user, task, pipeline, Boolean(req.body?.force));
    if (bad) return res.status(400).json({ error: bad });
    const from = task.pipeline;
    if (from === "Collect" && !task.assignee) { const who = !isLead(req.user) ? req.user : pickMember(task); if (who) assignMember(task, who, req.user.name, true); }
    if (pipeline === "Done" && task.contact && !task.respondedAt) addHistory(task, "Closed without reply", req.user.name, String(req.body?.note || "Closed without replying to the customer"));
    moveTo(task, pipeline, req.user.name);
    if (from === "Review" && pipeline === "Do") runAfter = true;
    addHistory(task, "Stage", req.user.name, `${from} → ${pipeline}`);
    log(`${req.user.name} moved "${task.title}" from ${from} to ${pipeline}.`);
  }
  if (agent !== undefined) {
    const next = AGENTS.some((a) => a.name === agent) ? agent : null;
    if (next !== task.agent) {
      task.agent = next;
      addHistory(task, next ? "Assigned" : "Unassigned", req.user.name, next ? `Owner: ${next}` : "Owner removed");
      log(next ? `${next} was assigned "${task.title}".` : `"${task.title}" is now unassigned.`);
    }
  }
  if (assignee !== undefined) {
    const m = settings.team.find((x) => x.id === assignee) || null;
    if (assignee && !m) return res.status(400).json({ error: "Unknown team member" });
    assignMember(task, m, req.user.name);
  }
  if (due !== undefined) {
    const next = due || null;
    if (next !== task.due) {
      task.due = next; task.dueLabel = ""; task.dueTime = "";
      addHistory(task, next ? "Scheduled" : "Unscheduled", req.user.name, next ? `Due ${next}` : "Schedule removed");
    }
  }
  if (priority !== undefined && PRIORITY_LIST.includes(priority) && priority !== task.priority && !task.respondedAt) {
    addHistory(task, "Priority", req.user.name, `${task.priority} → ${priority} (SLA now ${slaMinutes(priority)} min)`);
  }
  if (title !== undefined) task.title = title;
  if (draft !== undefined) task.draft = String(draft).slice(0, 2000);
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
  if (runAfter) await runnerExecute(task, req.user.name);
  saveTasks(tasks);
  res.json(view(task));
});

// Review: Approve -> Do, Improve -> back to Process, Reject -> closed.
app.post("/api/tasks/:id/review", needLead, async (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  void 0;
  if (!task) return res.status(404).json({ error: "Task not found" });
  const { decision, note = "" } = req.body || {};
  if (!["approve", "improve", "reject"].includes(decision)) return res.status(400).json({ error: "decision must be approve, improve or reject" });
  if (task.pipeline !== "Review") return res.status(400).json({ error: "Only tasks in Review can be approved, improved or rejected." });
  task.review = { decision, note, at: now(), by: req.user.name };
  if (decision === "approve") {
    addHistory(task, "Approved", req.user.name, note);
    task.pipeline = "Do"; task.progress = 90; task.state = "Ready"; task.agent = "Runner"; task.nextStep = "Runner sends the approved reply; then mark the task done.";
    log(`${req.user.name} approved "${task.title}" — moved to Do.`);
  } else if (decision === "improve") {
    addHistory(task, "Improve", req.user.name, note);
    task.pipeline = "Process"; task.progress = 45; task.state = "Running"; task.agent = "Scribe"; task.revisions = (task.revisions || 0) + 1;
    task.nextStep = note || "Improve the draft and resubmit for review.";
    log(`${req.user.name} asked for improvements on "${task.title}" — back to Process (revision ${task.revisions}).`);
  } else {
    addHistory(task, "Rejected", req.user.name, note);
    task.pipeline = "Done"; task.progress = 100; task.state = "Ready"; task.billable = false; task.billing = "Unbilled";
    task.dueLabel = "Rejected"; task.nextStep = "Rejected — closed.";
    log(`${req.user.name} rejected "${task.title}" — closed without billing.`);
  }
  if (decision === "approve") await runnerExecute(task, req.user.name);
  saveTasks(tasks);
  res.json(view(task));
});

app.delete("/api/tasks/:id", needLead, (req, res) => {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== req.params.id || !canSee(req.user, t));
  if (tasks.length === before) return res.status(404).json({ error: "Task not found" });
  saveTasks(tasks);
  res.json({ ok: true });
});

// Re-process loop: send a Done / reviewed task back for another pass.
app.post("/api/tasks/:id/reprocess", (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  const { nextStep, notes } = req.body || {};
  task.pipeline = "Process"; task.state = "Running"; task.progress = 45; task.review = null;
  task.revisions = (task.revisions || 0) + 1;
  addHistory(task, "Improve", req.user.name, "Re-processed");
  if (nextStep) task.nextStep = nextStep;
  if (notes) task.notes = notes;
  saveTasks(tasks);
  log(`Re-process: "${task.title}" went back to Process. Next step: ${task.nextStep}`);
  res.json(view(task));
});

// Mark the first response as sent: stops the SLA timer.
app.post("/api/tasks/:id/resolve", (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  if (task.pipeline === "Done") return res.status(400).json({ error: "This task is already closed." });
  if (!isLead(req.user) && task.assignee && task.assignee !== req.user.id) return res.status(403).json({ error: "Only the assignee or a team lead can close this task." });
  const force = Boolean(req.body?.force);
  if (task.contact && !task.respondedAt && !force) return res.status(400).json({ error: "No reply has been sent to the customer yet. Reply first, or close it without a reply." });
  if (task.contact && !task.respondedAt) addHistory(task, "Closed without reply", req.user.name, String(req.body?.note || "Closed without replying to the customer"));
  const from = task.pipeline;
  moveTo(task, "Done", req.user.name);
  addHistory(task, "Resolved", req.user.name, String(req.body?.note || `${from} → Done`));
  log(`${req.user.name} resolved "${task.title}".`);
  saveTasks(tasks); res.json(view(task));
});
app.post("/api/tasks/reset-samples", needAdmin, (_req, res) => { resetDemoTasks(); res.json({ ok: true, tasks: tasks.length }); });
app.post("/api/tasks/:id/respond", (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  if (!task.respondedAt) {
    afterReply(task, req.user); addHistory(task, "Responded", req.user.name, "Reply sent to the customer");
    log(`${req.user.name} replied on "${task.title}" — SLA ${slaOf(task).status === "met" ? "met" : "closed late"}.`);
    saveTasks(tasks);
  }
  res.json(view(task));
});
// Scribe (Groq) writes or rewrites the reply draft.
app.post("/api/tasks/:id/draft", async (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  if (!aiEnabled()) return res.status(400).json({ error: "Groq is not connected. Add GROQ_API_KEY to server/.env and restart the server." });
  const reply = await aiDraft({ title: task.title, notes: task.notes, source: task.source, category: task.category, feedback: String(req.body?.feedback || "").slice(0, 300) });
  if (!reply) return res.status(502).json({ error: `Groq could not write a draft: ${aiStatus().lastError || "no answer"}` });
  task.draft = reply; addHistory(task, "Draft", "Scribe (Groq AI)", "Reply draft written");
  saveTasks(tasks); res.json(view(task));
});
// Re-run the AI triage on an existing task (priority, type, department, assignee suggestion, draft).
app.post("/api/tasks/:id/retriage", needLead, async (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  if (!aiEnabled()) return res.status(400).json({ error: "Groq is not connected. Add GROQ_API_KEY to server/.env and restart the server." });
  const r = await triage(`${task.title}. ${task.notes || ""}`, task.source);
  if (r.via !== "Groq") return res.status(502).json({ error: `Groq did not answer: ${aiStatus().lastError || "no answer"}` });
  task.priority = r.priority; task.category = r.category; task.department = r.department;
  applyTriage(task, r);
  const m = settings.team.find((x) => x.id === r.assigneeId);
  if (m) assignMember(task, m, "Triage (Groq AI)");
  saveTasks(tasks); res.json(view(task));
});

// --- Comments with @mentions ----------------------------------------------------------------
const firstName = (m) => m.name.split(/\s+/)[0].toLowerCase();
function mentionsIn(text) {
  const found = new Set();
  for (const [, tag] of text.matchAll(/@([a-z0-9._-]+)/gi)) {
    const t = tag.toLowerCase().replace(/[.]+$/, "");
    const m = settings.team.find((x) => x.username === t || firstName(x) === t);
    if (m) found.add(m.id);
  }
  return [...found];
}
function addComment(task, { by, byId = null, text, kind = "comment" }) {
  const c = { id: `C${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, by, byId, text, kind, at: now() };
  (task.comments ||= []).push(c);
  return c;
}
app.post("/api/tasks/:id/comments", (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  const text = String(req.body?.text || "").trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: "Write something first." });
  addComment(task, { by: req.user.name, byId: req.user.id, text });
  const mentioned = mentionsIn(text).filter((id) => id !== req.user.id);
  for (const id of mentioned) {
    if (!(task.watchers ||= []).includes(id)) task.watchers.push(id);
    notify(id, `${req.user.name} mentioned you on "${task.title}": ${text.slice(0, 80)}`, task.id);
  }
  if (task.assignee && task.assignee !== req.user.id && !mentioned.includes(task.assignee)) notify(task.assignee, `${req.user.name} commented on "${task.title}"`, task.id);
  saveTasks(tasks); res.json(view(task));
});

// --- Real channels: WhatsApp + Facebook Messenger (Meta) and the website form -------------------
// --- Inbox: contacts + conversations (one thread per person, all messages kept) -------------------------------
const INBOX_FILE = path.join(DATA_DIR, "conversations.json");
let inbox = { contacts: {}, convs: {} };
try { if (fs.existsSync(INBOX_FILE)) inbox = { contacts: {}, convs: {}, ...JSON.parse(fs.readFileSync(INBOX_FILE, "utf8")) }; } catch { /* start empty */ }
const saveInbox = () => { try { fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox, null, 2)); } catch { /* in-memory still works */ } };
const contactKey = (channel, ext) => `${channel}:${ext}`;
const genericName = (n) => !n || /^(Facebook|Instagram|WhatsApp) user /i.test(n);

function upsertContact({ channel, ext, name }) {
  const id = contactKey(channel, ext);
  const c = (inbox.contacts[id] ||= { id, channel, ext, name: name || `${channel} user`, firstSeen: now(), notes: "", phone: "", email: "", tags: [], messageCount: 0 });
  if (name && !genericName(name)) c.name = name;
  c.lastSeen = now();
  return c;
}
function convFor(channel, ext, kind = "chat", commentId = null) {
  const id = kind === "comment" ? `${channel}:comment:${commentId}` : `${channel}:${ext}`;
  return (inbox.convs[id] ||= { id, contactId: contactKey(channel, ext), channel, kind, commentId, messages: [], unread: 0, lastAt: now(), lastText: "", lastDir: "in", taskIds: [] });
}
function addMessage(conv, { dir, text, by, mid = null, at = null }) {
  if (mid && conv.messages.some((m) => m.mid === mid)) return null;
  const m = { id: `M${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, dir, text, by, mid, at: at ? new Date(at).toISOString() : now() };
  conv.messages.push(m);
  conv.messages.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const last = conv.messages[conv.messages.length - 1];
  conv.lastAt = last.at; conv.lastText = last.text.slice(0, 140); conv.lastDir = last.dir;
  if (dir === "in") conv.unread += 1;
  return m;
}
const findOpenTask = (conv) => tasks.find((t) => (t.contact?.convId || t.contact?.key) === conv.id && t.pipeline !== "Done");
const convSummary = (c) => (c ? { id: c.id, unread: c.unread, lastAt: c.lastAt, lastDir: c.lastDir, count: c.messages.length } : null);
const taskConv = (t) => (t.contact ? inbox.convs[t.contact.convId || t.contact.key] : null);

// One grouped notification per conversation: later messages raise its count instead of adding new rows.
function notifyConversation(task, conv, contact, preview, added = 1) {
  const people = task.assignee ? [task.assignee] : leadsFor(task.department).map((m) => m.id);
  for (const uid of new Set(people)) {
    const n = notifications.find((x) => x.to === uid && x.convId === conv.id && !x.read);
    if (n) {
      n.count = (n.count || 1) + added; n.preview = preview.slice(0, 120); n.at = now();
      notifications = [n, ...notifications.filter((x) => x !== n)];
    } else {
      notifications.unshift({ id: ++notifId, to: uid, type: "message", convId: conv.id, taskId: task.id, title: contact.name, channel: conv.channel, preview: preview.slice(0, 120), count: added, text: `New ${conv.channel} message from ${contact.name}`, at: now(), read: false });
      const m = settings.team.find((x) => x.id === uid);
      if (m) deliverExternal(m, `New ${conv.channel} message from ${contact.name}: ${preview.slice(0, 100)}`);
    }
  }
  notifications = notifications.slice(0, 300);
}

/**
 * Record customer messages in their conversation and make sure a task exists for it.
 * msgs: [{ text, mid, at }]. Returns { task, added }.
 */
async function handleInbound({ source, from, name, msgs, kind = "chat", commentId = null }) {
  if (settings.pausedChannels.includes(source)) return { task: null, added: 0 };
  const conv = convFor(source, from, kind, commentId);
  const contact = upsertContact({ channel: source, ext: from, name });
  const fresh = msgs.filter((m) => !(m.mid && (conv.messages.some((x) => x.mid === m.mid) || tasks.some((t) => t.contact?.msgIds?.includes(m.mid)))));
  if (!fresh.length) return { task: null, added: 0 };
  fresh.sort((x, y) => (x.at || 0) - (y.at || 0));
  for (const m of fresh) { addMessage(conv, { dir: "in", text: m.text, by: contact.name, mid: m.mid, at: m.at }); contact.messageCount = (contact.messageCount || 0) + 1; }
  const latest = fresh[fresh.length - 1].text;
  const open = findOpenTask(conv);
  if (open) {
    open.contact.convId = conv.id;
    (open.contact.msgIds ||= []).push(...fresh.map((m) => m.mid).filter(Boolean));
    notifyConversation(open, conv, contact, latest, fresh.length);
    saveTasks(tasks); saveInbox();
    log(`${contact.name} wrote again on "${open.title}" (${source}).`);
    return { task: open, added: fresh.length };
  }
  // new conversation (or the old ticket was closed) -> new task
  const combined = fresh.map((m) => m.text).join("\n").slice(0, 1800);
  const r = await triage(combined, source);
  const task = newTask({
    title: (r.summary || combined).slice(0, 110), source, priority: r.priority, category: r.category, billable: r.billable,
    department: r.department, project: settings.projects[0], agent: "Scout",
    notes: `${contact.name} (${source}) wrote: "${combined.slice(0, 1500)}"`,
    contact: { key: conv.id, convId: conv.id, channel: source, id: from, name: contact.name, kind, commentId, msgIds: fresh.map((m) => m.mid).filter(Boolean) },
  });
  applyTriage(task, r);
  const chosen = settings.team.find((m) => m.id === r.assigneeId) || (settings.autoAssign ? pickMember(task) : null);
  if (chosen) assignMember(task, chosen, r.via === "Groq" ? "Triage (Groq AI)" : "Triage", true); // the message notification below replaces "assigned you"
  conv.taskIds.push(task.id);
  tasks.unshift(task);
  notifyConversation(task, conv, contact, latest, fresh.length);
  saveTasks(tasks); saveInbox();
  log(`Scout captured a real ${source} ${kind === "comment" ? "comment" : "message"} from ${contact.name}: "${task.title}" (${task.priority}).`);
  return { task, added: fresh.length };
}
// Single-message entry point used by the webhooks and the website form.
async function ingestMessage({ source, from, name, text, msgId, kind = "chat", commentId = null, at = null }) {
  return (await handleInbound({ source, from, name, msgs: [{ text, mid: msgId, at: at || Date.now() }], kind, commentId })).task;
}

// One-time upgrade: tasks created before conversations existed get a thread built from what they stored.
function migrateInbox() {
  let changed = false;
  for (const t of tasks) {
    if (!t.contact || t.contact.convId) continue;
    const key = t.contact.key || contactKey(t.contact.channel, t.contact.id);
    const conv = convFor(t.contact.channel, t.contact.id, t.contact.kind || "chat", t.contact.commentId);
    const contact = upsertContact({ channel: t.contact.channel, ext: t.contact.id, name: t.contact.name });
    if (!conv.messages.length) {
      const first = /wrote: "([\s\S]*)"$/.exec(t.notes || "")?.[1];
      if (first) addMessage(conv, { dir: "in", text: first, by: contact.name, at: t.createdAt });
      for (const c of t.comments || []) if (c.kind === "customer" || c.kind === "sent") addMessage(conv, { dir: c.kind === "sent" ? "out" : "in", text: c.text, by: c.by, at: c.at });
      conv.unread = 0; contact.messageCount = conv.messages.filter((m) => m.dir === "in").length;
    }
    t.contact.convId = conv.id; t.contact.key = key;
    if (!conv.taskIds.includes(t.id)) conv.taskIds.push(t.id);
    changed = true;
  }
  if (changed) { saveInbox(); saveTasks(tasks); }
}
migrateInbox();

// Real customer tasks that Autopilot had already pushed along go back to Collect when nobody has replied.
function repairWorkflow() {
  let changed = false;
  for (const t of tasks) {
    if (!t.contact || t.wf3) continue;
    t.wf3 = true; changed = true;
    if (t.pipeline === "Done") continue;
    const conv = inbox.convs[t.contact.convId || t.contact.key];
    const replied = Boolean(conv?.messages.some((m) => m.dir === "out")) || Boolean(t.history?.some((h) => h.step === "Reply sent"));
    const target = replied ? "Process" : "Collect";
    if (t.pipeline !== target) {
      t.pipeline = target; t.state = replied ? "Running" : "Ready"; t.progress = replied ? 45 : 10; t.review = null;
      if (!replied) { t.respondedAt = null; t.escalatedAt = null; t.escalatedTo = []; delete t.slaWarnedAt; }
      t.nextStep = replied ? "Follow up with the customer, then submit for review or resolve." : "Take this inquiry, reply to the customer, then move it forward.";
      addHistory(t, "Stage", "System", `Moved back to ${target} — Autopilot had moved it without a person (workflow reset)`);
    }
  }
  if (changed) saveTasks(tasks);
}
// Sample tasks (the demo board) are replaced by a fresh copy; real tasks are kept untouched.
function resetDemoTasks() {
  const counter = idCounter;
  const fresh = seedTasks();
  idCounter = Math.max(counter, 113);
  tasks = [...tasks.filter((t) => !t.demo), ...fresh];
  saveTasks(tasks);
}
for (const t of tasks) if (t.demo === undefined) t.demo = !t.contact && (/^T-1(0[1-9]|1[0-3])$/.test(t.id) || /^Simulated incoming task/.test(t.notes || ""));
repairWorkflow();
if (tasks.some((t) => t.demo && !t.sampleV2)) resetDemoTasks();

async function sendViaChannel(conv, text) {
  const contact = inbox.contacts[conv.contactId];
  if (conv.channel === "WhatsApp") { const r = await sendWhatsApp(contact.ext, text); return r?.messages?.[0]?.id || null; }
  if (conv.channel === "Instagram") { const r = await sendMessenger(contact.ext, text); return r?.message_id || null; }
  if (conv.channel === "Facebook") { const r = await (conv.kind === "comment" ? sendFacebookComment(conv.commentId, text) : sendMessenger(contact.ext, text)); return r?.message_id || r?.id || null; }
  throw new Error(`Replying is not supported for ${conv.channel} yet — answer by email or phone.`);
}
/**
 * Runner: carries out approved work. When a task reaches Do (a lead approved it) and it came from a chat with a
 * reply that has not been sent, Runner sends the approved text on the customer's own channel.
 * It never sends anything that nobody approved, and it records every attempt in the task history.
 */
async function runnerExecute(task, by, { force = false } = {}) {
  if (!force && !settings.runnerAutoSend) return { status: "off" };
  const conv = taskConv(task);
  const text = String(task.draft || "").trim();
  if (!conv || !text || task.respondedAt) return { status: "nothing" };
  const contact = inbox.contacts[conv.contactId];
  try {
    const mid = await sendViaChannel(conv, text);
    addMessage(conv, { dir: "out", text, by: "Runner", mid }); conv.unread = 0;
    task.respondedAt = now();
    task.runner = { status: "sent", at: now(), by };
    addHistory(task, "Reply sent", "Runner", `approved by ${by} · via ${conv.channel}`);
    log(`Runner sent the approved reply to ${contact?.name || "the customer"} on ${conv.channel} (approved by ${by}).`);
    if (task.assignee && settings.team.find((m) => m.id === task.assignee)?.name !== by) notify(task.assignee, `Runner sent the approved reply for "${task.title}"`, task.id);
    saveInbox();
    return { status: "sent" };
  } catch (e) {
    task.runner = { status: "failed", at: now(), error: String(e.message).slice(0, 200), by };
    addHistory(task, "Runner failed", "Runner", String(e.message).slice(0, 160));
    log(`Runner could not send the reply for "${task.title}": ${e.message}`);
    const who = task.assignee ? [task.assignee] : leadsFor(task.department).map((m) => m.id);
    for (const id of new Set(who)) notify(id, `Runner could not send the reply for "${task.title}": ${String(e.message).slice(0, 100)}`, task.id);
    return { status: "failed" };
  }
}
app.post("/api/tasks/:id/runner", async (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  if (!isLead(req.user) && task.assignee && task.assignee !== req.user.id) return res.status(403).json({ error: "Only the assignee or a team lead can do that." });
  if (task.pipeline !== "Do") return res.status(400).json({ error: "Runner works on tasks in Do (after a lead approves them)." });
  const r = await runnerExecute(task, req.user.name, { force: true });
  saveTasks(tasks);
  if (r.status === "nothing") return res.status(400).json({ error: "Nothing to send: there is no reply text, the task is not from a chat, or the customer was already answered." });
  res.json(view(task));
});
// Real numbers for the Agents tab: what each agent has actually done.
app.get("/api/agents/activity", needLead, (_req, res) => {
  const hist = tasks.flatMap((t) => (t.history || []).map((h) => ({ ...h })));
  const latest = (arr) => arr.map((h) => h.at).filter(Boolean).sort().pop() || null;
  const real = tasks.filter((t) => !t.demo);
  const today = new Date().toISOString().slice(0, 10);
  const ai = aiStatus(), ch = channelStatus();
  const triaged = hist.filter((h) => h.step === "Triaged");
  const drafts = hist.filter((h) => h.step === "Draft");
  const sent = hist.filter((h) => h.step === "Reply sent" && h.by === "Runner");
  const escal = hist.filter((h) => h.step === "SLA breached");
  const open = tasks.filter((t) => t.pipeline !== "Done" && !t.respondedAt);
  res.json({
    scout: { capturedToday: real.filter((t) => String(t.createdAt).slice(0, 10) === today).length, capturedTotal: real.length, fromChats: real.filter((t) => t.contact).length, lastAt: latest(real.map((t) => ({ at: t.createdAt }))), channels: { facebook: ch.facebook, whatsapp: ch.whatsapp, website: ch.websiteKeySet, webhook: ch.webhookReady }, lastSync },
    triage: { total: triaged.length, byGroq: triaged.filter((h) => /Groq/.test(h.by)).length, byRules: triaged.filter((h) => !/Groq/.test(h.by)).length, lastAt: latest(triaged), groq: { enabled: ai.enabled, calls: ai.calls, failures: ai.failures, lastError: ai.lastError, lastOkAt: ai.lastOkAt } },
    scribe: { drafts: tasks.filter((t) => t.draft).length, rewrites: drafts.length, lastAt: latest(drafts) || latest(triaged), enabled: ai.enabled },
    runner: { sent: sent.length, failed: tasks.filter((t) => t.runner?.status === "failed" && t.pipeline === "Do").length, waiting: tasks.filter((t) => t.pipeline === "Do" && t.contact && t.draft && !t.respondedAt).length, enabled: settings.runnerAutoSend, lastAt: latest(sent) },
    hawk: { lastCheckAt: lastHawkCheck, atRisk: open.filter((t) => slaOf(t).status === "risk").length, breached: open.filter((t) => slaOf(t).status === "breached").length, escalations: escal.length, warnings: tasks.filter((t) => t.slaWarnedAt).length, lastAt: latest(escal) },
  });
});
function canSeeConv(u, conv) {
  if (u.access === "admin") return true;
  return conv.taskIds.some((id) => { const t = tasks.find((x) => x.id === id); return t && canSee(u, t); });
}
app.get("/api/conversations", (req, res) => {
  const list = Object.values(inbox.convs).filter((c) => canSeeConv(req.user, c)).map((c) => {
    const contact = inbox.contacts[c.contactId] || {};
    const open = findOpenTask(c) || tasks.find((t) => t.id === c.taskIds[c.taskIds.length - 1]);
    return { id: c.id, channel: c.channel, kind: c.kind, contactId: c.contactId, name: contact.name || c.contactId, lastText: c.lastText, lastAt: c.lastAt, lastDir: c.lastDir, unread: c.unread, taskId: open?.id || null, taskTitle: open?.title || "", taskOpen: open ? open.pipeline !== "Done" : false, assignee: open?.assignee || null };
  }).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  res.json(list);
});
app.get("/api/conversations/:id", (req, res) => {
  const c = inbox.convs[req.params.id];
  if (!c || !canSeeConv(req.user, c)) return res.status(404).json({ error: "Conversation not found" });
  c.unread = 0;
  notifications.forEach((n) => { if (n.to === req.user.id && n.convId === c.id) n.read = true; });
  saveInbox();
  const contact = inbox.contacts[c.contactId] || {};
  const linked = c.taskIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean).map((t) => ({ id: t.id, title: t.title, pipeline: t.pipeline, priority: t.priority, assignee: t.assignee, createdAt: t.createdAt, draft: t.draft || "", sla: slaOf(t) }));
  const others = Object.values(inbox.convs).filter((x) => x.contactId === c.contactId && x.id !== c.id).length;
  res.json({ ...c, contact: { ...contact, conversations: others + 1 }, tasks: linked });
});
app.post("/api/conversations/:id/messages", async (req, res) => {
  const c = inbox.convs[req.params.id];
  if (!c || !canSeeConv(req.user, c)) return res.status(404).json({ error: "Conversation not found" });
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: "Write a message first." });
  let mid;
  try { mid = await sendViaChannel(c, text); } catch (e) { return res.status(502).json({ error: `Could not send: ${e.message}` }); }
  addMessage(c, { dir: "out", text, by: req.user.name, mid });
  c.unread = 0;
  const open = findOpenTask(c);
  if (open) {
    afterReply(open, req.user);
    addHistory(open, "Reply sent", req.user.name, `via ${c.channel}`);
    saveTasks(tasks);
  }
  log(`${req.user.name} replied to ${inbox.contacts[c.contactId]?.name || "a customer"} on ${c.channel}.`);
  saveInbox();
  res.json({ ok: true });
});
app.get("/api/contacts", needLead, (_req, res) => {
  res.json(Object.values(inbox.contacts).map((c) => {
    const convs = Object.values(inbox.convs).filter((v) => v.contactId === c.id);
    const taskIds = convs.flatMap((v) => v.taskIds);
    return { ...c, conversations: convs.length, tasks: taskIds.length, openTasks: taskIds.filter((id) => { const t = tasks.find((x) => x.id === id); return t && t.pipeline !== "Done"; }).length, lastAt: convs.map((v) => v.lastAt).sort().pop() || c.lastSeen, convId: convs.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))[0]?.id || null };
  }).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)));
});
app.delete("/api/contacts/:id", needAdmin, (req, res) => {
  const c = inbox.contacts[req.params.id];
  if (!c) return res.status(404).json({ error: "Contact not found" });
  const gone = Object.values(inbox.convs).filter((v) => v.contactId === c.id);
  for (const v of gone) { delete inbox.convs[v.id]; notifications = notifications.filter((n) => n.convId !== v.id); }
  delete inbox.contacts[c.id];
  tasks.forEach((t) => { if (t.contact && gone.some((v) => v.id === (t.contact.convId || t.contact.key))) t.contact = null; });
  saveInbox(); saveTasks(tasks);
  log(`${req.user.name} deleted contact ${c.name} and ${gone.length} conversation${gone.length === 1 ? "" : "s"}.`);
  res.json({ ok: true });
});
app.patch("/api/contacts/:id", needLead, (req, res) => {
  const c = inbox.contacts[req.params.id];
  if (!c) return res.status(404).json({ error: "Contact not found" });
  const b = req.body || {};
  if (b.name !== undefined && String(b.name).trim()) c.name = String(b.name).trim().slice(0, 80);
  if (b.notes !== undefined) c.notes = String(b.notes).slice(0, 4000);
  if (b.phone !== undefined) c.phone = String(b.phone).replace(/[^\d+\-\s()]/g, "").slice(0, 30);
  if (b.email !== undefined) c.email = String(b.email).trim().slice(0, 120);
  if (Array.isArray(b.tags)) c.tags = b.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 10);
  saveInbox(); res.json(c);
});
// Catch-up: read the Page inbox directly, so nothing is lost if the tunnel/server was down.
let lastSync = { at: null, imported: 0, error: "" };
let syncedUntil = Date.now() - 72 * 3600000; // first run looks back 3 days
let syncing = false;
async function syncFacebookInbox() {
  if (syncing) return lastSync;
  syncing = true;
  const started = Date.now();
  try {
    const msgs = await fetchFacebookInbox(syncedUntil);
    let imported = 0;
    const byUser = new Map();
    for (const m of msgs) (byUser.get(m.userId) || byUser.set(m.userId, { name: m.userName, in: [], out: [] }).get(m.userId))[m.dir].push(m);
    for (const [userId, g] of byUser) {
      if (g.in.length) {
        const r = await handleInbound({ source: "Facebook", from: userId, name: g.name, msgs: g.in.map((m) => ({ text: m.text, mid: m.id, at: m.at })) });
        imported += r.added;
      }
      // messages your team sent straight from Facebook / Meta Business Suite
      const conv = inbox.convs[`Facebook:${userId}`];
      if (conv) for (const m of g.out) if (!tasks.some((t) => t.contact?.msgIds?.includes(m.id))) addMessage(conv, { dir: "out", text: m.text, by: "Page inbox", mid: m.id, at: m.at });
    }
    saveInbox();
    syncedUntil = started - 10 * 60000; // small overlap; duplicates are ignored by message id
    lastSync = { at: now(), imported, error: "" };
    if (imported) log(`Facebook inbox sync filed ${imported} message${imported > 1 ? "s" : ""} that the webhook had missed.`);
  } catch (e) { lastSync = { at: now(), imported: 0, error: e.message }; }
  syncing = false;
  return lastSync;
}
setInterval(() => { if (channelStatus().facebook) syncFacebookInbox(); }, 120000);
setTimeout(() => { if (channelStatus().facebook) syncFacebookInbox(); }, 8000);
app.post("/api/integrations/facebook/sync", needLead, async (_req, res) => {
  syncedUntil = Math.min(syncedUntil, Date.now() - 72 * 3600000);
  res.json(await syncFacebookInbox());
});
// Meta calls this once to verify your URL...
app.get("/api/webhooks/meta", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && checkVerifyToken(String(req.query["hub.verify_token"] || ""))) return res.status(200).send(String(req.query["hub.challenge"] || ""));
  res.sendStatus(403);
});
// ...and posts every new WhatsApp / Messenger message here.
app.post("/api/webhooks/meta", (req, res) => {
  if (!verifyMetaSignature(req.rawBody, req.headers["x-hub-signature-256"])) return res.sendStatus(401);
  res.sendStatus(200);
  const found = parseMetaPayload(req.body);
  log(`Meta webhook received (${req.body?.object || "unknown"}): ${found.length} message${found.length === 1 ? "" : "s"}${found.length ? "" : ` — nothing to file. Raw: ${JSON.stringify(req.body).slice(0, 380)}`}.`);
  for (const m of found) ingestMessage({ source: m.channel, from: m.from, name: m.name, text: m.text, msgId: m.id, kind: m.kind, commentId: m.commentId }).catch((e) => log(`Could not file a ${m.channel} message: ${e.message}`));
});
// Website contact form -> task. POST JSON with header  x-api-key: <WEBSITE_FORM_KEY>  (or  Authorization: Bearer <key>).
// Accepted fields (all optional except a message): name, email, phone, company, subject, message, budget, services (text or list).
app.post("/api/webhooks/website", async (req, res) => {
  const key = String(req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer /i, ""));
  if (!checkWebsiteKey(key)) return res.status(401).json({ error: "Bad or missing API key (send header x-api-key or Authorization: Bearer)." });
  const b = req.body || {};
  const clean = (v, n = 300) => String(Array.isArray(v) ? v.join(", ") : v ?? "").trim().slice(0, n);
  const message = clean(b.message || b.details || b.description, 2000);
  if (!message) return res.status(400).json({ error: "message is required" });
  const name = clean(b.name || b.fullName, 80) || "Website visitor";
  const email = clean(b.email, 120), phone = clean(b.phone, 40);
  const extra = [["Subject", b.subject], ["Company", b.company], ["Budget", b.budget], ["Services", b.services || b.service], ["Phone", phone], ["Email", email]]
    .map(([k, v]) => [k, clean(v, 200)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const text = `${message}${extra.length ? `\n\n${extra.join(" · ")}` : ""}`.slice(0, 2400);
  const t = await ingestMessage({ source: "Website", from: email || phone || name, name, text, msgId: crypto.randomUUID() });
  res.status(201).json({ ok: true, task: t?.id || null });
});
// Send the (edited) draft back to the customer on the channel it came from.
app.post("/api/tasks/:id/send", async (req, res) => {
  const task = findTask(req, res);
  if (!task) return;
  const text = String(req.body?.text || task.draft || "").trim();
  if (!text) return res.status(400).json({ error: "There is nothing to send — write or generate a reply first." });
  const conv = taskConv(task);
  if (!conv) return res.status(400).json({ error: "This task did not come from a connected chat, so there is nobody to send to. Copy the reply and send it yourself." });
  let mid;
  try { mid = await sendViaChannel(conv, text); } catch (e) { return res.status(502).json({ error: `Could not send: ${e.message}` }); }
  addMessage(conv, { dir: "out", text, by: req.user.name, mid }); conv.unread = 0;
  afterReply(task, req.user);
  addHistory(task, "Reply sent", req.user.name, `via ${conv.channel}`);
  log(`${req.user.name} sent a ${conv.channel} reply on "${task.title}".`);
  saveTasks(tasks); saveInbox(); res.json(view(task));
});
// Admin pastes keys in Settings -> saved to server/.env and applied immediately (no restart).
const ENV_FILE = path.join(__dirname, ".env");
function upsertEnv(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/); } catch { /* new file */ }
  for (const [k, v] of Object.entries(updates)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_FILE, lines.filter((l) => l !== "").join("\n") + "\n");
}
app.get("/api/integrations/config", needAdmin, (_req, res) => res.json(configHints()));
app.put("/api/integrations/config", needAdmin, (req, res) => {
  const updates = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!(k in CONFIG_KEYS)) continue;
    const val = String(v ?? "").trim();
    if (!val) continue; // empty = keep what is saved
    if (/[\r\n]/.test(val) || val.length > 600) return res.status(400).json({ error: `${k} has an invalid value.` });
    updates[k] = val;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "Nothing to save — fill in at least one field." });
  try { upsertEnv(updates); } catch (e) { return res.status(500).json({ error: `Could not write server/.env: ${e.message}` }); }
  Object.assign(process.env, updates); resetTransport();
  log(`${req.user.name} updated channel settings (${Object.keys(updates).join(", ")}).`);
  res.json(configHints());
});
app.post("/api/integrations/facebook/subscribe", needAdmin, async (_req, res) => {
  try { res.json({ ok: true, message: await subscribePage() }); } catch (e) { res.json({ ok: false, message: e.message }); }
});
app.post("/api/integrations/test", needAdmin, async (req, res) => {
  const which = String(req.body?.channel || "");
  try {
    if (which === "groq") {
      if (!aiEnabled()) throw new Error("Save the Groq key first.");
      const r = await aiDraft({ title: "connection test", notes: "", source: "Website", category: "General" });
      if (!r) throw new Error(aiStatus().lastError || "Groq did not answer.");
      return res.json({ ok: true, message: `Groq works (model ${aiStatus().model}).` });
    }
    res.json({ ok: true, message: await testChannel(which) });
  } catch (e) { res.json({ ok: false, message: e.message }); }
});
let publicUrl = "";
let lastRegister = null;
async function runRegister(url) {
  publicUrl = url;
  try { lastRegister = { at: now(), ...(await registerMetaWebhooks(url)) }; }
  catch (e) { lastRegister = { at: now(), error: e.message }; }
  const bad = lastRegister.results?.filter((r) => !r.ok) || [];
  log(lastRegister.error ? `Could not update Meta webhooks: ${lastRegister.error}` : `Meta webhooks now point to ${url} (${lastRegister.results.map((r) => `${r.object}: ${r.ok ? "ok" : "failed"}`).join(", ")})${bad.length ? ` — ${bad[0].note}` : ""}.`);
  return lastRegister;
}
// Called by the dev launcher (npm run dev) every time the free tunnel gets a new address.
app.post("/api/internal/register-webhooks", async (req, res) => {
  let key = process.env.INTERNAL_KEY || "";
  try { key = fs.readFileSync(path.join(__dirname, ".internal-key"), "utf8").trim() || key; } catch { /* no launcher file */ }
  if (!key || req.headers["x-internal-key"] !== key) return res.status(401).json({ error: "no" });
  res.json(await runRegister(String(req.body?.url || "")));
});
app.post("/api/integrations/meta/register", needAdmin, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!/^https:\/\/[^\s/]+$/.test(url.replace(/\/+$/, ""))) return res.status(400).json({ error: "Give the public https address, for example https://tasks.yourdomain.com" });
  res.json(await runRegister(url));
});
app.get("/api/integrations/status", needLead, (_req, res) => res.json({ ...channelStatus(), ai: aiStatus(), webhookPath: "/api/webhooks/meta", websitePath: "/api/webhooks/website", sent, lastDeliveryError, publicUrl, lastRegister, lastSync }));

// --- Admin: edit people --------------------------------------------------------------------
app.patch("/api/team/:id", needAdmin, (req, res) => {
  const m = settings.team.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Team member not found" });
  const b = req.body || {};
  if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: "Name cannot be empty." }); m.name = String(b.name).trim(); }
  if (b.role !== undefined) m.role = String(b.role).trim() || m.role;
  if (b.email !== undefined) {
    const e = String(b.email).trim().toLowerCase();
    if (!/^\S+@\S+$/.test(e)) return res.status(400).json({ error: "That email address does not look right." });
    if (settings.team.some((x) => x.id !== m.id && x.email?.toLowerCase() === e)) return res.status(400).json({ error: "Another person already uses that email." });
    m.email = e;
  }
  if (b.phone !== undefined) m.phone = String(b.phone).replace(/[^\d+]/g, "");
  if (b.department !== undefined && settings.departments.includes(b.department)) m.department = b.department;
  if (b.capacity !== undefined) m.capacity = Math.max(1, Number(b.capacity) || m.capacity);
  if (b.access !== undefined) {
    if (!["admin", "lead", "member"].includes(b.access)) return res.status(400).json({ error: "Unknown access level." });
    if (m.access === "admin" && b.access !== "admin" && settings.team.filter((x) => x.access === "admin").length < 2) return res.status(400).json({ error: "There must be at least one admin." });
    m.access = b.access;
  }
  saveStore(); log(`${req.user.name} updated ${m.name}'s profile.`);
  res.json(teamStats());
});
app.post("/api/team/:id/password", needAdmin, (req, res) => {
  const m = settings.team.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Team member not found" });
  if (String(req.body?.password || "").length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  store.credentials[m.id] = hashPassword(req.body.password); saveStore();
  log(`${req.user.name} reset ${m.name}'s password.`);
  res.json({ ok: true });
});

app.get("/api/stats", (req, res) => {
  const tasks = visibleTasks(req.user);
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, tasks.filter((t) => t.source === s).length]));
  const byState = Object.fromEntries(STATES.map((s) => [s, tasks.filter((t) => t.state === s).length]));
  const byPipeline = Object.fromEntries(PIPELINES.map((p) => [p, tasks.filter((t) => t.pipeline === p).length]));
  res.json({ total: tasks.length, done: byPipeline.Done || 0, bySource, byState, byPipeline, autopilot });
});

const hideContact = (u) => (m) => (u.access === "admin" || m.id === u.id ? m : { ...m, email: undefined, phone: undefined });
app.get("/api/team", (req, res) => res.json(teamStats().map(hideContact(req.user))));
app.post("/api/team", needAdmin, (req, res) => {
  const { name, role = "Team member", department, capacity = 5, access = "member", username, password, email, phone } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const user = String(username || name.trim().split(/\s+/)[0]).toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!user) return res.status(400).json({ error: "username is required" });
  if (settings.team.some((m) => m.username === user)) return res.status(400).json({ error: `Username "${user}" is already taken.` });
  if (String(password || "").length < 8) return res.status(400).json({ error: "Give a starting password of at least 8 characters." });
  const colors = ["#f59e0b", "#3b82f6", "#10b981", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6"];
  const id = `M${Math.max(0, ...settings.team.map((m) => Number(m.id.slice(1)))) + 1}`;
  settings.team.push({ id, name: name.trim(), username: user, email: String(email || `${user}@taskmanager.local`).trim().toLowerCase(), phone: String(phone || "").replace(/[^\d+]/g, ""), role: String(role).trim() || "Team member", access: ["admin", "lead", "member"].includes(access) ? access : "member", department: settings.departments.includes(department) ? department : settings.departments[0], capacity: Math.max(1, Number(capacity) || 5), color: colors[settings.team.length % colors.length] });
  store.credentials[id] = hashPassword(password); saveStore();
  log(`${name.trim()} joined the team.`);
  res.status(201).json(teamStats());
});
app.delete("/api/team/:id", needAdmin, (req, res) => {
  const m = settings.team.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Team member not found" });
  if (m.id === req.user.id) return res.status(400).json({ error: "You cannot remove yourself." });
  tasks.filter((t) => t.assignee === m.id).forEach((t) => { if (isOpen(t)) assignMember(t, null, "System"); else t.assignee = null; });
  settings.team = settings.team.filter((x) => x.id !== m.id);
  delete store.credentials[m.id]; saveStore();
  saveTasks(tasks); log(`${m.name} was removed from the team.`);
  res.json(teamStats());
});
// Smart assign: give every open task without a team owner to the best-fit member.
app.post("/api/team/auto-assign", needLead, (_req, res) => {
  if (!settings.team.length) return res.status(400).json({ error: "Add a team member first." });
  const todo = tasks.filter((t) => isOpen(t) && !t.assignee)
    .sort((a, b) => PRIORITY_LIST.indexOf(a.priority) - PRIORITY_LIST.indexOf(b.priority));
  todo.forEach((t) => assignMember(t, pickMember(t), "Triage"));
  saveTasks(tasks);
  res.json({ assigned: todo.length, message: todo.length ? `Assigned ${todo.length} task${todo.length > 1 ? "s" : ""} by department and workload.` : "Every open task already has a team owner.", team: teamStats() });
});

app.get("/api/governance", needLead, (_req, res) => res.json(governance()));
app.get("/api/activity", (req, res) => res.json(isLead(req.user) ? activity : []));
app.get("/api/agents", (_req, res) => res.json(AGENTS.map((a) => ({ ...a, paused: settings.pausedAgents.includes(a.id) }))));
app.patch("/api/agents/:id", needLead, (req, res) => {
  const agent = AGENTS.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const paused = Boolean(req.body?.paused);
  settings.pausedAgents = paused ? [...new Set([...settings.pausedAgents, agent.id])] : settings.pausedAgents.filter((id) => id !== agent.id);
  log(`${agent.name} ${paused ? "paused — Autopilot will skip its tasks" : "resumed"}.`);
  res.json({ ...agent, paused });
});

app.get("/api/settings", (req, res) => res.json({ ...settings, team: settings.team.map(hideContact(req.user)) }));
app.post("/api/settings", needLead, (req, res) => {
  const allowed = ["workspace", "defaultPriority", "autoMove", "autoUnblock", "autoPrioritize", "autoAssign", "autoApprove", "notifyBlocked", "pausedChannels", "pausedAgents", "org", "sla", "runnerAutoSend"];
  for (const key of allowed) if (req.body?.[key] !== undefined) settings[key] = key === "org" ? { ...settings.org, ...req.body.org }
      : key === "sla" ? Object.fromEntries(PRIORITY_LIST.map((p) => [p, Math.max(5, Number(req.body.sla[p]) || settings.sla[p])]))
      : req.body[key];
  saveStore();
  log("Settings updated.");
  res.json(settings);
});
app.post("/api/reset", needAdmin, (_req, res) => {
  tasks = seedTasks(); saveTasks(tasks);
  log("Board reset to the sample tasks.");
  res.json({ ok: true, tasks: tasks.length });
});
app.post("/api/digest", needLead, (_req, res) => {
  const blocked = tasks.filter((t) => t.state === "Blocked").length;
  const done = tasks.filter((t) => t.pipeline === "Done").length;
  const review = tasks.filter((t) => t.pipeline === "Review").length;
  const msg = `Status digest: ${tasks.length} tasks, ${done} done, ${blocked} blocked, ${review} waiting for review.`;
  log(msg);
  res.json({ message: msg });
});

app.post("/api/autopilot", needLead, (req, res) => {
  autopilot = Boolean(req.body?.enabled);
  log(`Autopilot ${autopilot ? "ON — agents will move tasks on their own" : "OFF — you are in control"}.`);
  res.json({ autopilot });
});

// One Autopilot tick. Order: wake a blocked task -> assign/schedule one task -> move one task forward.
// Tasks waiting in Review are only moved on when "Auto-approve reviews" is on; otherwise a human decides.
app.post("/api/autopilot/tick", needLead, (_req, res) => {
  if (!autopilot) return res.json({ moved: null, message: "Autopilot is off." });
  if (settings.autoUnblock) {
    const blocked = tasks.find((t) => t.demo && t.state === "Blocked");
    if (blocked) {
      blocked.state = "Ready"; saveTasks(tasks);
      log(`Autopilot: Event woke blocked task "${blocked.title}" back to Ready.`);
      return res.json({ moved: view(blocked), unblocked: true });
    }
  }
  if (settings.autoAssign) {
    const loose = tasks.find((t) => t.demo && t.pipeline !== "Done" && (!t.agent || (!t.due && !t.dueLabel)));
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
    t.demo && t.pipeline !== "Done" && t.agent && t.state !== "Blocked" && t.state !== "Suspended" && !pausedNames.has(t.agent) &&
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

checkSla();
const server = app.listen(PORT, () => console.log(`Agentic Task API running on http://localhost:${PORT}`));
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`
Port ${PORT} is already in use — another copy of the server is still running.
Fix: from the project root run  npm run stop  and then  npm run dev  (npm run dev also does this for you).
`);
    process.exit(1);
  }
  throw e;
});

// --- Projects (Phase 1) ------------------------------------------------------

// --- Projects (Phase 1) ------------------------------------------------------
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

const PROJECT_TYPES = [
  { id: "website", name: "Website", questions: ["What is the goal of the website?", "Do you need a specific platform?", "Any reference sites?", "Do you need e-commerce functionality?", "Target launch date?"] },
  { id: "mobile-app", name: "Mobile app", questions: ["iOS, Android, or both?", "Core features needed?", "User authentication?", "Backend/API requirements?", "App store timeline?"] },
  { id: "custom-software", name: "Custom software or CRM", questions: ["Business process to automate?", "Users of the system?", "Integrations needed?", "Data to store?", "Compliance requirements?"] },
  { id: "seo", name: "SEO", questions: ["Target pages/keywords?", "Google Search Console access?", "Website URL?", "Competitors?", "SEO goal?"] },
  { id: "marketing-campaign", name: "Marketing campaign", questions: ["Campaign goal?", "Target audience?", "Budget?", "Duration?", "Success metrics?"] },
  { id: "maintenance", name: "Maintenance", questions: ["What needs maintenance?", "Update frequency?", "Known issues?", "Access needed?", "Support hours?"] },
];

let projects = [];
try {
  if (fs.existsSync(PROJECTS_FILE)) {
    projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  }
} catch { projects = []; }

const saveProjects = () => {
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2)); } catch {}
};

const getProjectId = () => "P-" + String(Date.now()).slice(-6) + Math.floor(Math.random()*100);

app.get("/api/projects/types", (req, res) => { res.json(PROJECT_TYPES); });

app.get("/api/projects", (req, res) => {
  let out = projects;
  if (!req.user.access || req.user.access === "member") {
    out = out.filter(p => p.owner === req.user.id || (p.team||[]).includes(req.user.id));
  }
  res.json(out);
});

app.post("/api/projects/convert", needLead, (req, res) => {
  const { taskId, projectType, owner, team=[], brief={} } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "taskId required" });
  if (!projectType) return res.status(400).json({ error: "projectType required" });
  const task = tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });
  const typeInfo = PROJECT_TYPES.find(t => t.id === projectType) || { name: projectType };
  const project = {
    id: getProjectId(),
    type: projectType,
    typeName: typeInfo.name,
    title: task.title,
    status: "Kickoff",
    statusHistory: [{ status: "Kickoff", at: now(), by: req.user.name }],
    taskId: task.id,
    client: task.contact ? { name: task.contact.name, convId: task.contact.convId || task.contact.key, channel: task.contact.channel } : null,
    owner: owner || task.assignee || req.user.id,
    team: Array.isArray(team) ? team : [],
    brief: Object.assign({ goals:"", features:"", platform:"", budget:"", deadline:"", references:"", requirements: task.notes||"" }, brief),
    milestones: [],
    tasks: [],
    notes: [],
    createdAt: now(),
    createdBy: req.user.id,
    updatedAt: now(),
  };
  projects.unshift(project);
  saveProjects();
  if (task.pipeline !== "Process") {
    task.pipeline = "Process";
    task.progress = 45;
    addHistory(task, "Converted to project", req.user.name, "Project " + project.id + " created");
  }
  saveTasks(tasks);
  log(req.user.name + ' converted "' + task.title + '" to project ' + project.id + ' (' + typeInfo.name + ').');
  res.status(201).json(project);
});

app.get("/api/projects/:id", (req, res) => {
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (req.user.access === "member" && project.owner !== req.user.id && !(project.team||[]).includes(req.user.id)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  res.json(project);
});

app.patch("/api/projects/:id", (req, res) => {
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (req.user.access === "member" && project.owner !== req.user.id) {
    return res.status(403).json({ error: "Only owner can update" });
  }
  const { status, owner, team, brief, milestones, notes } = req.body || {};
  if (status && status !== project.status) {
    project.statusHistory = project.statusHistory || [];
    project.statusHistory.push({ status, at: now(), by: req.user.name });
    project.status = status;
  }
  if (owner) project.owner = owner;
  if (Array.isArray(team)) project.team = team;
  if (brief) project.brief = Object.assign({}, project.brief||{}, brief);
  if (Array.isArray(milestones)) project.milestones = milestones;
  if (notes !== undefined) project.notes = notes;
  project.updatedAt = now();
  saveProjects();
  res.json(project);
});

app.post("/api/projects/:id/close", needLead, (req, res) => {
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  project.status = "Closed";
  project.statusHistory = project.statusHistory || [];
  project.statusHistory.push({ status: "Closed", at: now(), by: req.user.name });
  project.updatedAt = now();
  saveProjects();
  log(req.user.name + " closed project " + project.id + ".");
  res.json(project);
});
