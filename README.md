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
