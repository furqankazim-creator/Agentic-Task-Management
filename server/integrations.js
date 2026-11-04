// WhatsApp + Facebook Messenger (Meta Cloud API) and email (SMTP). Every function is a no-op /
// clear error when its credentials are missing, so the app runs fine without any of them.
import crypto from "crypto";
import nodemailer from "nodemailer";

const GRAPH = process.env.GRAPH_BASE || "https://graph.facebook.com/v21.0"; // GRAPH_BASE lets tests point at a fake Meta server
const env = (k) => (process.env[k] || "").trim();

export const channelStatus = () => ({
  whatsapp: Boolean(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_ID")),
  facebook: Boolean(env("FB_PAGE_TOKEN")),
  webhookReady: Boolean(env("META_VERIFY_TOKEN") && env("META_APP_SECRET")),
  verifyTokenSet: Boolean(env("META_VERIFY_TOKEN")),
  appSecretSet: Boolean(env("META_APP_SECRET")),
  email: Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS")),
  websiteKeySet: Boolean(env("WEBSITE_FORM_KEY")),
});

// --- webhook security -------------------------------------------------------------
export function verifyMetaSignature(rawBody, header) {
  const secret = env("META_APP_SECRET");
  if (!secret || !rawBody || !header?.startsWith("sha256=")) return false;
  const good = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.slice(7);
  return got.length === good.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(good));
}
export const checkVerifyToken = (t) => Boolean(env("META_VERIFY_TOKEN")) && t === env("META_VERIFY_TOKEN");
export const checkWebsiteKey = (k) => Boolean(env("WEBSITE_FORM_KEY")) && k === env("WEBSITE_FORM_KEY");

/** Turn a Meta webhook body into [{ channel, from, name, text, id }]. */
export function parseMetaPayload(body) {
  const out = [];
  if (body?.object === "whatsapp_business_account") {
    for (const entry of body.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || (m.type && m.type !== "text" ? `[${m.type} message]` : "");
        if (text) out.push({ channel: "WhatsApp", from: m.from, name: names[m.from] || m.from, text, id: m.id });
      }
    }
  } else if (body?.object === "instagram") {
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        if (ev.message && !ev.message.is_echo && ev.sender?.id && ev.sender.id !== entry.id) {
          const text = ev.message.text || (ev.message.attachments?.length ? "[attachment]" : "");
          if (text) out.push({ channel: "Instagram", from: ev.sender.id, name: `Instagram user ${String(ev.sender.id).slice(-4)}`, text, id: ev.message.mid });
        }
      }
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        if (ch.field === "comments" && v.id && v.text && v.from?.id && v.from.id !== entry.id) {
          out.push({ channel: "Instagram", kind: "comment", commentId: v.id, from: v.from.id, name: v.from.username ? `@${v.from.username}` : `Instagram user ${String(v.from.id).slice(-4)}`, text: v.text, id: v.id });
        }
      }
    }
  } else if (body?.object === "page") {
    for (const entry of body.entry || []) for (const ch of entry.changes || []) {
      // public comment on one of the Page's posts
      const v = ch.value || {};
      // chat message delivered in the "changes" shape (this is what the dashboard Test button sends)
      if (ch.field === "messages" && v.message && !v.message.is_echo && v.sender?.id && v.sender.id !== entry.id) {
        const text = v.message.text || (v.message.attachments?.length ? "[attachment]" : "");
        if (text) out.push({ channel: "Facebook", from: v.sender.id, name: `Facebook user ${String(v.sender.id).slice(-4)}`, text, id: v.message.mid });
      }
      if (ch.field === "feed" && v.item === "comment" && v.verb === "add" && v.from?.id && v.from.id !== entry.id && v.message && v.comment_id) {
        out.push({ channel: "Facebook", kind: "comment", commentId: v.comment_id, from: v.from.id, name: v.from.name || `Facebook user ${String(v.from.id).slice(-4)}`, text: v.message, id: v.comment_id });
      }
    }
    // "standby" is where Facebook delivers chats when another app (e.g. Page Inbox) is the primary receiver.
    for (const entry of body.entry || []) for (const ev of [...(entry.messaging || []), ...(entry.standby || [])]) {
      if (ev.message && !ev.message.is_echo) {
        const text = ev.message.text || (ev.message.attachments?.length ? "[attachment]" : "");
        if (text) out.push({ channel: "Facebook", from: ev.sender?.id, name: `Facebook user ${String(ev.sender?.id || "").slice(-4)}`, text, id: ev.message.mid });
      }
    }
  }
  return out.filter((m) => m.from && m.id);
}

// --- outbound ---------------------------------------------------------------------------
async function graph(url, body, token) {
  const res = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Meta API ${res.status}`);
  return data;
}
export async function sendWhatsApp(to, text) {
  if (!channelStatus().whatsapp) throw new Error("WhatsApp is not connected (set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID in server/.env).");
  return graph(`${GRAPH}/${env("WHATSAPP_PHONE_ID")}/messages`, { messaging_product: "whatsapp", to: String(to).replace(/\D/g, ""), type: "text", text: { body: text.slice(0, 4000) } }, env("WHATSAPP_TOKEN"));
}
export async function sendFacebookComment(commentId, text) {
  if (!channelStatus().facebook) throw new Error("Facebook is not connected (set FB_PAGE_TOKEN in server/.env).");
  return graph(`${GRAPH}/${commentId}/comments`, { message: text.slice(0, 2000) }, env("FB_PAGE_TOKEN"));
}
/** Tell Facebook to send this Page's messages and comments to our webhook. */
export async function subscribePage() {
  if (!channelStatus().facebook) throw new Error("Save the Facebook Page token first.");
  try {
    const page = await graphGet("me?fields=name,id", env("FB_PAGE_TOKEN"));
    await graph(`${GRAPH}/${page.id}/subscribed_apps`, { subscribed_fields: ["messages", "feed"] }, env("FB_PAGE_TOKEN"));
    return `Page "${page.name}" now sends its messages and comments to this app.`;
  } catch (e) {
    throw new Error("This token cannot change Page subscriptions (that needs an extra permission). Do it in Meta instead: Messenger → Messenger API Settings → section 2 → Add subscriptions → tick messages (and feed) → Save.");
  }
}
export async function sendMessenger(psid, text) {
  if (!channelStatus().facebook) throw new Error("Facebook is not connected (set FB_PAGE_TOKEN in server/.env).");
  return graph(`${GRAPH}/me/messages`, { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: text.slice(0, 2000) } }, env("FB_PAGE_TOKEN"));
}

let transport;
export const resetTransport = () => { transport = undefined; };
export async function sendEmail(to, subject, text) {
  if (!channelStatus().email) throw new Error("Email is not set up (set SMTP_HOST, SMTP_USER, SMTP_PASS in server/.env).");
  transport ||= nodemailer.createTransport({ host: env("SMTP_HOST"), port: Number(env("SMTP_PORT")) || 587, secure: Number(env("SMTP_PORT")) === 465, auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") } });
  return transport.sendMail({ from: env("MAIL_FROM") || env("SMTP_USER"), to, subject, text });
}

// --- settings screen helpers: which keys exist (never their values) + live connection tests ----------
export const CONFIG_KEYS = {
  WHATSAPP_PHONE_ID: { secret: false }, WHATSAPP_TOKEN: { secret: true }, FB_PAGE_TOKEN: { secret: true },
  META_VERIFY_TOKEN: { secret: false }, META_APP_SECRET: { secret: true }, WEBSITE_FORM_KEY: { secret: true },
  SMTP_HOST: { secret: false }, SMTP_PORT: { secret: false }, SMTP_USER: { secret: false }, SMTP_PASS: { secret: true }, MAIL_FROM: { secret: false },
  GROQ_API_KEY: { secret: true },
};
export const configHints = () => Object.fromEntries(Object.entries(CONFIG_KEYS).map(([k, { secret }]) => {
  const v = env(k);
  return [k, v ? { set: true, hint: secret ? `…${v.slice(-4)}` : v } : { set: false, hint: "" }];
}));

async function graphGet(path, token) {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Meta API ${res.status}`);
  return data;
}
/** Returns a one-line success message or throws with Meta's reason. */
export async function testChannel(which) {
  if (which === "whatsapp") {
    if (!channelStatus().whatsapp) throw new Error("Save both the WhatsApp token and the Phone number ID first.");
    const d = await graphGet(`${env("WHATSAPP_PHONE_ID")}?fields=display_phone_number,verified_name`, env("WHATSAPP_TOKEN"));
    return `Connected to WhatsApp number ${d.display_phone_number || "(unknown)"}${d.verified_name ? ` — ${d.verified_name}` : ""}.`;
  }
  if (which === "facebook") {
    if (!channelStatus().facebook) throw new Error("Save the Facebook Page token first.");
    // A Messenger token may not be allowed to read the Page profile, but it can always list its conversations.
    const d = await graphGet("me/conversations?limit=1", env("FB_PAGE_TOKEN"));
    return `Facebook Page token accepted — Messenger access works${d.data?.length ? " (this Page already has conversations)" : ""}.`;
  }
  if (which === "email") {
    if (!channelStatus().email) throw new Error("Save the SMTP host, user and password first.");
    transport ||= nodemailer.createTransport({ host: env("SMTP_HOST"), port: Number(env("SMTP_PORT")) || 587, secure: Number(env("SMTP_PORT")) === 465, auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") } });
    await transport.verify();
    return "Email login works.";
  }
  throw new Error("Unknown channel.");
}

/**
 * Point Meta's webhooks (Facebook Page, Instagram, WhatsApp) at `baseUrl` using the app access token,
 * keeping any fields that are already subscribed. Meta calls the URL back to verify it, so the
 * server and tunnel must already be reachable. Returns one result line per object.
 */
export async function registerMetaWebhooks(baseUrl) {
  const secret = env("META_APP_SECRET"), verify = env("META_VERIFY_TOKEN"), anyToken = env("FB_PAGE_TOKEN") || env("WHATSAPP_TOKEN");
  if (!secret || !verify || !anyToken) throw new Error("Needs META_APP_SECRET, META_VERIFY_TOKEN and a Facebook or WhatsApp token saved first.");
  const callback = `${String(baseUrl).replace(/\/+$/, "")}/api/webhooks/meta`;
  const j = async (url, init) => { const r = await fetch(url, { signal: AbortSignal.timeout(20000), ...init }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; };
  const app = await j(`${GRAPH}/app?fields=id&access_token=${encodeURIComponent(anyToken)}`);
  if (!app.ok || !app.d.id) throw new Error(app.d.error?.message || "Could not find your Meta app from the saved token.");
  const appToken = `${app.d.id}|${secret}`;
  const cur = await j(`${GRAPH}/${app.d.id}/subscriptions?access_token=${encodeURIComponent(appToken)}`);
  const have = Object.fromEntries((cur.d.data || []).map((x) => [x.object, (x.fields || []).map((f) => f.name)]));
  const wanted = { page: ["messages", "feed"], instagram: ["messages", "comments"], whatsapp_business_account: ["messages"] };
  const out = [];
  for (const [object, must] of Object.entries(wanted)) {
    if (object === "instagram" && !have.instagram) { out.push({ object, ok: true, note: "skipped (Instagram webhook not set up in Meta yet)" }); continue; }
    const fields = [...new Set([...(have[object] || []), ...must])].join(",");
    const r = await j(`${GRAPH}/${app.d.id}/subscriptions`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ object, callback_url: callback, fields, verify_token: verify, access_token: appToken }),
    });
    out.push({ object, ok: r.ok && r.d.success !== false, note: r.ok ? "address updated" : (r.d.error?.message || "failed") });
  }
  return { appId: app.d.id, callback, results: out };
}

/**
 * Read the Page's Messenger inbox directly (no webhook needed). Returns customer messages newer than
 * `sinceMs`, oldest first: [{ channel, from, name, text, id, at }]. Used to catch up after downtime.
 */
export async function fetchFacebookInbox(sinceMs) {
  if (!channelStatus().facebook) throw new Error("Facebook is not connected.");
  const fields = "updated_time,participants,messages.limit(15){id,message,from,created_time}";
  const res = await fetch(`${GRAPH}/me/conversations?fields=${encodeURIComponent(fields)}&limit=40`, { headers: { Authorization: `Bearer ${env("FB_PAGE_TOKEN")}` }, signal: AbortSignal.timeout(20000) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error?.message || `Meta API ${res.status}`);
  const convos = d.data || [];
  // the Page is the one participant that appears in every conversation
  const seen = {};
  for (const c of convos) for (const p of c.participants?.data || []) seen[p.id] = (seen[p.id] || 0) + 1;
  const pageId = Object.entries(seen).sort((a, b) => b[1] - a[1])[0]?.[0];
  const out = [];
  for (const c of convos) {
    if (Date.parse(c.updated_time) < sinceMs) continue;
    const other = (c.participants?.data || []).find((p) => p.id !== pageId);
    if (!other) continue;
    for (const m of c.messages?.data || []) {
      if (!m.id || !m.message || Date.parse(m.created_time) < sinceMs) continue;
      const mine = m.from?.id === pageId;
      out.push({ dir: mine ? "out" : "in", userId: other.id, userName: other.name || `Facebook user ${String(other.id).slice(-4)}`, text: m.message, id: m.id, at: Date.parse(m.created_time) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
