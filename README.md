# Agentic Task OS — React + Express

The code version of the Agentic Task Management System: an AI-controlled
dashboard that collects tasks from **Facebook, Website, WhatsApp, Email and
LinkedIn**, triages them, and drives them through a pipeline and a task
state machine.

## What it does

- **Dashboard:** total / Running / Ready / Blocked / Suspended / Done KPIs,
  channel-mix bars, agent activity feed, search and per-source filters.
- **AI command bar:** type plain English, e.g.
  `Urgent WhatsApp: client wants a price list update` — the backend parses
  the channel and priority and creates a triaged task in Collect.
- **Pipeline board:** Collect → Process → Review → Do → Done, with
  drag-and-drop and click-to-move.
- **Task state machine (from your diagram):**
  Ready → Running, Running → Blocked (blocking API call),
  Blocked → Ready (Event), Ready → Suspended (TaskSuspend),
  Suspended → Ready (TaskResume). Illegal transitions are rejected by the API.
- **Re-process loop:** a task can go back to Process with
  Decide next step · Categorize · Schedule · Add notes.
- **5 AI agents:** Scout (capture), Triage (priority/category),
  Scribe (notes), Runner (moves tasks), Hawk (watches blocked tasks).
- **Autopilot:** the frontend ticks the backend every 8 seconds and the
  backend moves the oldest movable task forward. Turn it off any time.
- **Simulate incoming:** one click per channel creates a new task from
  that source. Real Facebook / WhatsApp / Email / LinkedIn accounts are
  **not** connected yet — see `server/index.js` `POST /api/ingest/:source`
  to replace the simulation with a real webhook / API call.
- **7 tabs, one live task list:** Overview (board), Tasks (filterable table
  with inline stage/state edits), Calendar (Overdue / Today / Tomorrow /
  This week / Later / Done), Agents (workload + real Pause — Autopilot
  skips paused agents), Analytics (live pipeline / state / channel /
  priority charts), Automations (toggles that really gate Autopilot, plus
  incoming-burst and status-digest actions), Settings (workspace name,
  default priority, Autopilot pace, channel pauses, board reset).

## Run it

You need Node.js 18+.

```bash
# Terminal 1 — API on http://localhost:3001
cd server
npm install
npm start

# Terminal 2 — UI on http://localhost:5173
cd client
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:3001`, so no CORS
setup is needed in development.

## API

| Method | Route | What it does |
| --- | --- | --- |
| GET | /api/health | API status + task count |
| GET | /api/meta | Sources, pipelines, states, agents |
| GET | /api/tasks?source=&pipeline=&state=&priority=&q= | List / filter tasks |
| POST | /api/tasks | Create a task |
| PATCH | /api/tasks/:id | Move pipeline, change state, edit fields |
| DELETE | /api/tasks/:id | Delete a task |
| POST | /api/tasks/:id/reprocess | Send a task back to Process |
| POST | /api/command | AI command bar: English → triaged task |
| POST | /api/ingest/:source | Simulate an incoming task from a channel |
| GET | /api/stats | Counts by source, state and pipeline |
| GET | /api/activity | Agent activity feed |
| GET | /api/agents | The 5 AI agents (with paused flag) |
| PATCH | /api/agents/:id | `{ "paused": true }` pauses / resumes an agent |
| GET / POST | /api/settings | Workspace, default priority, automation toggles, paused channels/agents |
| POST | /api/reset | Reset the board to the 10 sample tasks |
| POST | /api/digest | Generate a status digest in the activity feed |
| POST | /api/autopilot | `{ "enabled": true }` toggles Autopilot |
| POST | /api/autopilot/tick | Move one task forward (Autopilot step, honouring toggles) |

## Data

Tasks are stored in `server/tasks.json` (created on first run) and in
memory while the server runs. Delete that file to reset to the 10 sample
tasks. To move to a real database later, replace `loadTasks` / `saveTasks`
in `server/index.js` with your database calls — the API shape stays the same.

## Team logins, SLA timers and Groq AI

**Sign in** at the login screen. Starting password for everyone is `welcome123` — change it from the account menu (top right).

| Username / email | Person | Role | Sees |
|---|---|---|---|
| `irfan` / `irfan@taskmanager.local` | Irfan Nawaz | Senior Developer (member) | only their own tasks |
| `hasnain` / `hasnain@taskmanager.local` | Hasnain Hadi | Developer | only their own tasks |
| `zahoor` / `zahoor@taskmanager.local` | Zahoor Jamali | Developer | only their own tasks |
| `ahmed` / `ahmed@taskmanager.local` | Ahmed Massror | CEO (admin) | everything, manages the team |
| `akhter` / `akhter@taskmanager.local` | Akhter | Marketing (member) | only their own tasks |

Logins live in `server/team.json` (hashed passwords, git-ignored). The admin adds/removes people in the **Team** tab.

**SLA timers** — first reply due: urgent 1h · high 4h · medium 24h · low 72h (editable in Settings). Moving a task to Review/Do/Done, or clicking *Mark replied*, stops the timer. If it runs out, Hawk escalates to the department lead and the admin (in-app 🔔 notification + history entry).

**Groq AI** — copy `server/.env.example` to `server/.env`, put your key in `GROQ_API_KEY=`, restart the server. Groq then triages every new task (priority, type, department, suggested assignee) and Scribe writes the reply draft. Without a key the app falls back to keyword rules.

## Connect WhatsApp and Facebook (the simple way)

Meta (Facebook + WhatsApp) sends every new message to a **webhook** on your server. One Meta app covers both.

1. **Get a public https address** for the backend (Meta can't reach `localhost`). Easiest: install ngrok and run `ngrok http 3001`. It prints an address like `https://abc123.ngrok-free.app`.
2. **Create the Meta app:** developers.facebook.com → My Apps → Create App → type *Business*. Add the products **WhatsApp** and **Messenger**.
3. **Copy 5 values into `server/.env`** (see `.env.example`), then restart the server:
   - `META_APP_SECRET` — App settings → Basic → App secret
   - `META_VERIFY_TOKEN` — any word you invent
   - `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` — WhatsApp → API Setup (use a System User token for a permanent one)
   - `FB_PAGE_TOKEN` — Messenger → Settings → generate a token for your Facebook Page
4. **Tell Meta where to send messages.** In WhatsApp → Configuration and in Messenger → Webhooks set
   - Callback URL: `https://YOUR-ADDRESS/api/webhooks/meta`
   - Verify token: the same `META_VERIFY_TOKEN`
   - Subscribe to **messages**.
5. **Test:** send a WhatsApp message to your test number (add your own phone as a recipient in API Setup), or message your Facebook Page. A task appears within seconds, triaged by Groq, with a reply draft. Settings → *Channels & alerts* shows what is connected.
6. **Reply:** open the task, edit the draft, click **Send via WhatsApp / Facebook**. That also stops the SLA timer. Further messages from the same customer are added to the same task as comments.

Limits to know: WhatsApp only allows free-text replies within 24 hours of the customer's last message; Facebook/WhatsApp apps in *development mode* only receive messages from people added to the app — switch the app to *Live* (needs Meta app review for public use).

**Website form:** POST `{ "name", "email", "message" }` to `https://YOUR-ADDRESS/api/webhooks/website` with header `x-api-key: <WEBSITE_FORM_KEY>`.

**Alerts outside the app:** set `SMTP_*` in `.env` for email, and give people an email / phone in Team → Edit. Assignments, SLA warnings, escalations and @mentions are then sent by email (and WhatsApp, if the person has a phone and has messaged your WhatsApp number in the last 24 h).
