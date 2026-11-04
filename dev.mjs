// One command starts everything:  npm run dev   (from the project root)
//   api    backend on http://localhost:3001 (auto-restarts on save or crash)
//   web    website on http://localhost:5173
//   tunnel free public address so Meta (WhatsApp / Facebook / Instagram) can reach your PC.
//          Each time the tunnel gets a new address this launcher tells Meta about it automatically.
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePorts } from "./stop.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const PORT = process.env.PORT || 3001;
const children = [];
let stopping = false;

// close any old copy first, so "Port 3001 is already in use" can never happen
freePorts();
process.env.ATM_LAUNCHER = "1";

// the backend trusts this key only for the "tunnel address changed" call below
process.env.INTERNAL_KEY = crypto.randomBytes(16).toString("hex");
// also written to a file, so a backend started separately (not by this launcher) still accepts the call
try { writeFileSync(path.join(root, "server", ".internal-key"), process.env.INTERNAL_KEY); } catch { /* read-only folder */ }

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const tagLines = (tag, chunk) => String(chunk).split(/\r?\n/).filter(Boolean).map((l) => `${tag} ${l}`).join("\n") + "\n";

const portBusy = (port) => new Promise((res) => {
  const c = net.connect({ port, host: "127.0.0.1" }); c.setTimeout(1500);
  c.on("connect", () => { c.destroy(); res(true); }); c.on("timeout", () => { c.destroy(); res(false); }); c.on("error", () => res(false));
});

function supervise(name, color, cmd, args, opts = {}, onLine) {
  const start = () => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], shell: opts.shell });
    const tag = paint(color, `[${name}]`);
    let failed = false;
    p.on("error", (e) => { failed = true; console.log(`${tag} could not start: ${e.message}`); });
    const pipe = (s, out) => s.on("data", (d) => { out.write(tagLines(tag, d)); if (onLine) String(d).split(/\r?\n/).forEach((l) => l && onLine(l)); });
    pipe(p.stdout, process.stdout); pipe(p.stderr, process.stderr);
    p.on("exit", (code) => {
      if (stopping || failed) return;
      console.log(`${tag} stopped (code ${code}) — restarting in 3s…`);
      setTimeout(async function again() {
        // if you started your own copy in the meantime, don't fight it for the port — just wait
        if (opts.port && await portBusy(opts.port)) { setTimeout(again, 8000); return; }
        start();
      }, 3000);
    });
    handle.proc = p;
    children.push(p);
  };
  const handle = { proc: null };
  start();
  return handle;
}

const stop = () => { stopping = true; children.forEach((c) => { try { c.kill(); } catch { /* gone */ } }); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);

supervise("api", "36", npm, ["run", "dev"], { cwd: path.join(root, "server"), shell: isWin, port: Number(PORT) });
supervise("web", "35", npm, ["run", "dev"], { cwd: path.join(root, "client"), shell: isWin, port: 5173 });

// ---- tunnel + automatic Meta webhook update -------------------------------------------------------
const candidates = [process.env.CLOUDFLARED_PATH, "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared"].filter(Boolean);
const exe = candidates.find((p) => existsSync(p)) || "cloudflared";
let lastUrl = "";

async function registerWithBackend(url) {
  for (let i = 1; i <= 50; i++) { // new tunnel addresses can take a few minutes to become reachable
    try {
      // wait until both the tunnel address resolves and the backend answers through it
      const probe = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (probe.ok) {
        const r = await fetch(`http://localhost:${PORT}/api/internal/register-webhooks`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_KEY },
          body: JSON.stringify({ url }), signal: AbortSignal.timeout(60000),
        });
        const d = await r.json().catch(() => ({}));
        const line = d.error ? `could not update Meta: ${d.error}` : (d.results || []).map((x) => `${x.object}: ${x.ok ? "ok" : "FAILED (" + x.note + ")"}`).join(" · ");
        console.log(paint("32", "[tunnel]") + ` Meta webhooks → ${url}/api/webhooks/meta   ${line}`);
        return;
      }
    } catch { /* not reachable yet */ }
    await new Promise((r) => setTimeout(r, 6000));
    if (url !== lastUrl) return; // a newer tunnel address replaced this one
  }
  console.log(paint("33", "[tunnel]") + ` Tunnel is up at ${url} but could not reach it from here to update Meta. Run  npm run stop  then  npm run dev  to retry.`);
}

const tunnel = supervise("tunnel", "32", exe, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], { shell: false }, (line) => {
  const m = line.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/); // ignore Cloudflare's own api.trycloudflare.com in error messages
  if (m && m[0] !== lastUrl) { lastUrl = m[0]; registerWithBackend(lastUrl); }
});

// Watchdog: free tunnels sometimes drop silently (Cloudflare "Error 1033"). If the public address stops
// answering twice in a row, restart the tunnel; the new address is sent to Meta automatically.
let misses = 0;
setInterval(async () => {
  if (stopping || !lastUrl) return;
  try {
    const r = await fetch(`${lastUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(String(r.status));
    misses = 0;
  } catch {
    misses += 1;
    if (misses >= 2) {
      misses = 0; lastUrl = "";
      console.log(paint("33", "[tunnel]") + " public address stopped answering — restarting the tunnel…");
      try { tunnel.proc?.kill(); } catch { /* already gone */ }
    }
  }
}, 45000);

console.log("Starting backend (http://localhost:3001), website (http://localhost:5173) and a public tunnel… press Ctrl+C to stop everything.");
console.log("If the tunnel line fails: install cloudflared once with  winget install Cloudflare.cloudflared  (optional — only needed for WhatsApp/Facebook/Instagram).");
