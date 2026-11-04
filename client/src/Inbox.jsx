import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

/* ---------- small helpers shared with the rest of the app ---------- */
const COLORS = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6", "#ef4444", "#6366f1"];
const hue = (s) => COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
export const CH_COLOR = { Facebook: "#1877f2", Instagram: "#c13584", WhatsApp: "#1fb457", Website: "#8a6d1f", Email: "#e5484d", LinkedIn: "#0a66c2" };
const REPLYABLE = ["Facebook", "Instagram", "WhatsApp"];
const initials = (n) => String(n || "?").replace(/^@/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s) || s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
function dayLabel(iso) {
  const d = new Date(iso), t = new Date();
  const diff = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function ContactAvatar({ name, channel, size = 40 }) {
  return (
    <span className="c-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: hue(name) }}>
      {initials(name)}
      {channel && <i className="c-chan" style={{ background: CH_COLOR[channel] || "#666" }} title={channel} />}
    </span>
  );
}

/* ---------- Inbox: conversation list · chat · contact details ---------- */
export function Inbox({ isLead, isAdmin, convs, selectedId, setSelectedId, refresh, openTask, showToast }) {
  const [q, setQ] = useState("");
  const [chan, setChan] = useState("All");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [conv, setConv] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(false); // contact panel on small screens
  const [fields, setFields] = useState({ phone: "", email: "", notes: "" });
  const endRef = useRef(null);
  const lastCount = useRef(0);

  const filtered = useMemo(() => convs.filter((c) =>
    (chan === "All" || c.channel === chan) && (!unreadOnly || c.unread > 0) &&
    (!q || `${c.name} ${c.lastText} ${c.taskTitle}`.toLowerCase().includes(q.toLowerCase()))), [convs, chan, unreadOnly, q]);
  const totalUnread = convs.reduce((n, c) => n + c.unread, 0);
  const channels = useMemo(() => [...new Set(convs.map((c) => c.channel))], [convs]);

  const reload = async (id = selectedId, first = false) => {
    if (!id) return;
    try {
      const c = await api.conversation(id);
      setConv(c);
      if (first) { setFields({ phone: c.contact?.phone || "", email: c.contact?.email || "", notes: c.contact?.notes || "" }); lastCount.current = c.messages.length; refresh(); }
      else if (c.messages.length !== lastCount.current) { lastCount.current = c.messages.length; refresh(); }
    } catch (e) { if (first) showToast(e.message); }
  };
  useEffect(() => {
    if (!selectedId) { setConv(null); return undefined; }
    setConv(null); setText(""); setInfo(false);
    reload(selectedId, true);
    const t = setInterval(() => reload(selectedId, false), 8000);
    return () => clearInterval(t);
  }, [selectedId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [conv?.messages?.length, conv?.id]);
  useEffect(() => { if (!selectedId && filtered.length && window.innerWidth > 900) setSelectedId(filtered[0].id); }, [filtered.length]);

  const openT = conv?.tasks?.find((t) => t.pipeline !== "Done") || conv?.tasks?.[conv.tasks.length - 1];
  const canReply = conv && REPLYABLE.includes(conv.channel);
  const lastIn = conv && [...conv.messages].reverse().find((m) => m.dir === "in");
  const stale = canReply && lastIn && Date.now() - Date.parse(lastIn.at) > 24 * 3600 * 1000;

  const send = async () => {
    const t = text.trim();
    if (!t || busy || !conv) return;
    setBusy(true);
    try { await api.sendConversation(conv.id, t); setText(""); await reload(conv.id, false); refresh(); }
    catch (e) { showToast(e.message); }
    setBusy(false);
  };
  const aiDraft = async () => {
    if (!openT) return;
    setBusy(true);
    try { const r = await api.draft(openT.id); setText(r.draft || ""); await reload(conv.id, false); }
    catch (e) { showToast(e.message); }
    setBusy(false);
  };
  const saveField = async (k) => {
    if (!isLead || !conv || fields[k] === (conv.contact?.[k] || "")) return;
    try { await api.editContact(conv.contactId, { [k]: fields[k] }); showToast("Contact saved"); await reload(conv.id, false); }
    catch (e) { showToast(e.message); }
  };

  return (
    <section className={`inbox ${selectedId ? "has-sel" : ""} ${info ? "show-info" : ""}`}>
      {/* ---- conversation list ---- */}
      <aside className="inb-list">
        <div className="inb-head">
          <h3>Inbox {totalUnread > 0 && <span className="pill-count">{totalUnread} new</span>}</h3>
          <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or message…" />
          <div className="inb-filters">
            <button className={`chip ${chan === "All" ? "on" : ""}`} onClick={() => setChan("All")}>All</button>
            {channels.map((c) => <button key={c} className={`chip ${chan === c ? "on" : ""}`} onClick={() => setChan(c)}>{c}</button>)}
            <button className={`chip ${unreadOnly ? "on" : ""}`} onClick={() => setUnreadOnly(!unreadOnly)}>Unread</button>
          </div>
        </div>
        <div className="inb-items">
          {filtered.map((c) => (
            <button key={c.id} className={`inb-item ${selectedId === c.id ? "sel" : ""} ${c.unread ? "unread" : ""}`} onClick={() => setSelectedId(c.id)}>
              <ContactAvatar name={c.name} channel={c.channel} size={44} />
              <span className="inb-body">
                <span className="inb-top"><b>{c.name}</b><small>{ago(c.lastAt)}</small></span>
                <span className="inb-prev">{c.lastDir === "out" ? "You: " : ""}{c.lastText || "—"}</span>
                <span className="inb-meta">{c.channel}{c.taskId && <em>{c.taskOpen ? "● " : "✓ "}{c.taskId}</em>}</span>
              </span>
              {c.unread > 0 && <span className="unread-badge">{c.unread}</span>}
            </button>
          ))}
          {filtered.length === 0 && <p className="empty" style={{ padding: 18 }}>{convs.length ? "No conversations match." : "No conversations yet. When a customer messages you on Facebook or WhatsApp, it appears here."}</p>}
        </div>
      </aside>

      {/* ---- chat ---- */}
      <div className="inb-chat">
        {!conv && <div className="inb-empty"><p>{selectedId ? "Loading conversation…" : "Select a conversation"}</p></div>}
        {conv && (
          <>
            <header className="chat-head">
              <button className="back-btn" onClick={() => setSelectedId(null)} aria-label="Back to list">←</button>
              <ContactAvatar name={conv.contact?.name} channel={conv.channel} size={42} />
              <div className="chat-title">
                <b>{conv.contact?.name}</b>
                <small>{conv.channel}{conv.kind === "comment" ? " · public comment" : ""} · {conv.messages.length} message{conv.messages.length === 1 ? "" : "s"}</small>
              </div>
              {openT && <button className="task-chip" onClick={() => openTask(openT.id)} title="Open the task">{openT.pipeline === "Done" ? "✓" : "●"} {openT.id} · {openT.title.length > 34 ? `${openT.title.slice(0, 34)}…` : openT.title}</button>}
              <button className="info-btn" onClick={() => setInfo(!info)} aria-label="Contact details">ⓘ</button>
            </header>

            <div className="chat-scroll">
              {conv.messages.map((m, i) => (
                <Fragment key={m.id}>
                  {(i === 0 || dayLabel(m.at) !== dayLabel(conv.messages[i - 1].at)) && <div className="day-sep"><span>{dayLabel(m.at)}</span></div>}
                  <div className={`bubble-row ${m.dir}`}>
                    <div className="bubble">
                      {m.text}
                      <small>{m.dir === "out" ? `${m.by} · ` : ""}{timeOf(m.at)}</small>
                    </div>
                  </div>
                </Fragment>
              ))}
              <div ref={endRef} />
            </div>

            {canReply ? (
              <footer className="composer">
                {stale && <p className="warn-bar">The customer's last message is over 24 hours old. {conv.channel} may refuse a free-text reply now.</p>}
                <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply on ${conv.channel}…  (Enter to send, Shift+Enter for a new line)`}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
                <div className="composer-bar">
                  {openT?.draft && <button className="btn ghost small" onClick={() => setText(openT.draft)}>Use AI draft</button>}
                  {openT && <button className="btn ghost small" disabled={busy} onClick={aiDraft}>Write with Groq</button>}
                  <span className="grow" />
                  <button className="btn small" disabled={busy || !text.trim()} onClick={send}>{busy ? "Sending…" : `Send via ${conv.channel}`}</button>
                </div>
              </footer>
            ) : (
              <footer className="composer">
                <p className="warn-bar">Replies to {conv.channel} contacts aren't sent from here. Use their {conv.contact?.email ? `email (${conv.contact.email})` : "email or phone"}{openT?.draft ? " — an AI draft is ready:" : "."}</p>
                {openT?.draft && <div className="composer-bar"><button className="btn ghost small" onClick={() => { navigator.clipboard?.writeText(openT.draft); showToast("Draft copied"); }}>Copy AI draft</button></div>}
              </footer>
            )}
          </>
        )}
      </div>

      {/* ---- contact details ---- */}
      <aside className="inb-info">
        {conv && (
          <>
            <button className="back-btn info-close" onClick={() => setInfo(false)} aria-label="Close details">✕</button>
            <div className="info-top">
              <ContactAvatar name={conv.contact?.name} channel={conv.channel} size={72} />
              <h3>{conv.contact?.name}</h3>
              <span className="ch-tag" style={{ background: CH_COLOR[conv.channel] }}>{conv.channel}</span>
            </div>
            <dl className="info-facts">
              <dt>First contact</dt><dd>{conv.contact?.firstSeen ? new Date(conv.contact.firstSeen).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</dd>
              <dt>Last seen</dt><dd>{conv.contact?.lastSeen ? ago(conv.contact.lastSeen) : "—"}</dd>
              <dt>Messages</dt><dd>{conv.contact?.messageCount ?? conv.messages.length} from them</dd>
              <dt>Conversations</dt><dd>{conv.contact?.conversations || 1}</dd>
            </dl>
            <label className="field-label">Phone</label>
            <input className="input" value={fields.phone} disabled={!isLead} onChange={(e) => setFields({ ...fields, phone: e.target.value })} onBlur={() => saveField("phone")} placeholder={isLead ? "+92 …" : "—"} />
            <label className="field-label">Email</label>
            <input className="input" value={fields.email} disabled={!isLead} onChange={(e) => setFields({ ...fields, email: e.target.value })} onBlur={() => saveField("email")} placeholder={isLead ? "name@company.com" : "—"} />
            <label className="field-label">Notes</label>
            <textarea className="textarea" rows={4} value={fields.notes} disabled={!isLead} onChange={(e) => setFields({ ...fields, notes: e.target.value })} onBlur={() => saveField("notes")} placeholder={isLead ? "What do they need? Budget, deadline, who spoke to them…" : "—"} />
            <h4 className="info-h">Tasks from this person</h4>
            {conv.tasks.map((t) => (
              <button key={t.id} className="info-task" onClick={() => openTask(t.id)}>
                <b>{t.id}</b><span>{t.title}</span><em className={t.pipeline === "Done" ? "done" : ""}>{t.pipeline}</em>
              </button>
            ))}
            {isAdmin && <button className="btn danger small" style={{ marginTop: 16 }} onClick={async () => {
              if (!window.confirm(`Delete ${conv.contact?.name} and all their conversations? Tasks stay, but the chat history is removed.`)) return;
              try { await api.deleteContact(conv.contactId); setSelectedId(null); refresh(); showToast("Contact deleted"); } catch (e) { showToast(e.message); }
            }}>Delete contact</button>}
          </>
        )}
      </aside>
    </section>
  );
}

/* ---------- Contacts: everyone who has ever written to you ---------- */
export function Contacts({ openConversation, isAdmin, showToast }) {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const load = () => api.contacts().then(setRows).catch((e) => showToast(e.message));
  useEffect(() => { load(); }, []);
  const list = rows.filter((c) => !q || `${c.name} ${c.channel} ${c.email} ${c.phone}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section>
      <div className="sec-head">
        <div className="t"><h2>Contacts</h2><p>Everyone who has messaged you, with their history. Click a person to open their conversation.</p></div>
        <input className="search" style={{ maxWidth: 280 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts…" />
      </div>
      <div className="panel contacts-list">
        {list.map((c) => (
          <div key={c.id} className="contact-row" onClick={() => c.convId && openConversation(c.convId)}>
            <ContactAvatar name={c.name} channel={c.channel} size={44} />
            <div className="cr-main"><b>{c.name}</b><small>{c.channel}{c.email ? ` · ${c.email}` : ""}{c.phone ? ` · ${c.phone}` : ""}</small></div>
            <div className="cr-stat"><b>{c.messageCount || 0}</b><small>messages</small></div>
            <div className="cr-stat"><b>{c.openTasks}</b><small>open tasks</small></div>
            <div className="cr-stat wide"><b>{ago(c.lastAt)}</b><small>last contact</small></div>
            {isAdmin && <button className="btn danger small" onClick={async (e) => { e.stopPropagation(); if (window.confirm(`Delete ${c.name}?`)) { try { await api.deleteContact(c.id); load(); } catch (er) { showToast(er.message); } } }}>Delete</button>}
          </div>
        ))}
        {list.length === 0 && <p className="empty">{rows.length ? "No contacts match." : "No contacts yet."}</p>}
      </div>
    </section>
  );
}
