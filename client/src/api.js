async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export const api = {
  tasks: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return req(`/api/tasks${q ? `?${q}` : ""}`);
  },
  createTask: (body) => req("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id, body) => req(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  review: (id, decision, note = "") => req(`/api/tasks/${id}/review`, { method: "POST", body: JSON.stringify({ decision, note }) }),
  governance: () => req("/api/governance"),
  deleteTask: (id) => req(`/api/tasks/${id}`, { method: "DELETE" }),
  reprocess: (id, body = {}) => req(`/api/tasks/${id}/reprocess`, { method: "POST", body: JSON.stringify(body) }),
  command: (text) => req("/api/command", { method: "POST", body: JSON.stringify({ text }) }),
  ingest: (source) => req(`/api/ingest/${encodeURIComponent(source)}`, { method: "POST" }),
  stats: () => req("/api/stats"),
  activity: () => req("/api/activity"),
  agents: () => req("/api/agents"),
  pauseAgent: (id, paused) => req(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  settings: () => req("/api/settings"),
  saveSettings: (body) => req("/api/settings", { method: "POST", body: JSON.stringify(body) }),
  reset: () => req("/api/reset", { method: "POST" }),
  digest: () => req("/api/digest", { method: "POST" }),
  ingestBurst: async (sources) => { const out = []; for (const s of sources) out.push(await req(`/api/ingest/${encodeURIComponent(s)}`, { method: "POST" })); return out; },
  autopilot: (enabled) => req("/api/autopilot", { method: "POST", body: JSON.stringify({ enabled }) }),
  autopilotTick: () => req("/api/autopilot/tick", { method: "POST" }),
};
