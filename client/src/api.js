const TOKEN_KEY = "atm_token";
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
export const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };

async function req(path, options = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...options,
    });
  } catch {
    throw new Error("Backend server is not reachable (connection refused)");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    setToken("");
    window.dispatchEvent(new Event("atm-logout"));
  }
  if (!res.ok) {
    // Vite's dev proxy answers 500/502/503/504 with an empty body when the backend is down (ECONNREFUSED)
    if (!data.error && [500, 502, 503, 504].includes(res.status)) {
      throw new Error("Backend server is not reachable (connection refused)");
    }
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

export const api = {
  runTask: (id) => req(`/api/tasks/${id}/runner`, { method: "POST" }),
  agentActivity: () => req("/api/agents/activity"),
  resolveTask: (id, body = {}) => req(`/api/tasks/${id}/resolve`, { method: "POST", body: JSON.stringify(body) }),
  conversations: () => req("/api/conversations"),
  conversation: (id) => req(`/api/conversations/${encodeURIComponent(id)}`),
  sendConversation: (id, text) => req(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  contacts: () => req("/api/contacts"),
  editContact: (id, body) => req(`/api/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteContact: (id) => req(`/api/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  syncFacebook: () => req("/api/integrations/facebook/sync", { method: "POST" }),
  subscribeFacebookPage: () => req("/api/integrations/facebook/subscribe", { method: "POST" }),
  channelConfig: () => req("/api/integrations/config"),
  saveChannelConfig: (body) => req("/api/integrations/config", { method: "PUT", body: JSON.stringify(body) }),
  testChannel: (channel) => req("/api/integrations/test", { method: "POST", body: JSON.stringify({ channel }) }),
  comment: (id, text) => req(`/api/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ text }) }),
  send: (id, text) => req(`/api/tasks/${id}/send`, { method: "POST", body: JSON.stringify({ text }) }),
  integrations: () => req("/api/integrations/status"),
  editMember: (id, body) => req(`/api/team/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  setMemberPassword: (id, password) => req(`/api/team/${id}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  login: (username, password) => req("/api/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  me: () => req("/api/me"),
  changePassword: (current, next) => req("/api/me/password", { method: "POST", body: JSON.stringify({ current, next }) }),
  notifications: () => req("/api/notifications"),
  readNotifications: (body = {}) => req("/api/notifications/read", { method: "POST", body: JSON.stringify(body) }),
  aiStatus: () => req("/api/ai/status"),
  respond: (id) => req(`/api/tasks/${id}/respond`, { method: "POST" }),
  draft: (id) => req(`/api/tasks/${id}/draft`, { method: "POST", body: JSON.stringify({}) }),
  retriage: (id) => req(`/api/tasks/${id}/retriage`, { method: "POST" }),
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
  team: () => req("/api/team"),
  addMember: (body) => req("/api/team", { method: "POST", body: JSON.stringify(body) }),
  removeMember: (id) => req(`/api/team/${id}`, { method: "DELETE" }),
  autoAssign: () => req("/api/team/auto-assign", { method: "POST" }),
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
  projects: () => req("/api/projects"),
  projectTypes: () => req("/api/projects/types"),
  convertToProject: (body) => req("/api/projects/convert", { method: "POST", body: JSON.stringify(body) }),
  project: (id) => req("/api/projects/" + id),
  updateProject: (id, body) => req("/api/projects/" + id, { method: "PATCH", body: JSON.stringify(body) }),
  closeProject: (id) => req("/api/projects/" + id + "/close", { method: "POST" }),
};
