// Stops any old copy of this app so the ports are free — including leftover "node --watch" watchers,
// which would otherwise restart a second server on the next file save and fight for the port.
//   npm run stop            stop everything (backend, website, tunnel, launcher)
//   node stop.mjs backend   used automatically by `npm run dev` inside /server
//   node stop.mjs frontend  used automatically by `npm run dev` inside /client
// Every `npm run dev` calls this first, so "Port 3001 is already in use" cannot happen.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORTS = { backend: [3001], frontend: [5173, 5174, 5175, 5176], all: [3001, 5173, 5174, 5175, 5176] };
// command lines that belong to this project (regex, PowerShell syntax)
const MATCH = {
  common: "dev\\.mjs|cloudflared.*localhost:3001",
  backend: "--watch index\\.js",
  frontend: "Agentic-Task-Management.client.node_modules",
};

export function freePorts({ mode = "all", quiet = false } = {}) {
  // the launcher (npm run dev at the root) sets this, so the commands it starts never kill their own parent
  if (process.env.ATM_LAUNCHER) return [];
  const ports = PORTS[mode] || PORTS.all;
  // only a full stop touches the launcher and its tunnel; starting just the server/website must never take the public tunnel down
  const pattern = [...(mode === "all" ? [MATCH.common] : []), ...(mode === "backend" || mode === "all" ? [MATCH.backend] : []), ...(mode === "frontend" || mode === "all" ? [MATCH.frontend] : [])].join("|");
  const mine = new Set([process.pid, process.ppid]);
  let killed = [];
  try {
    if (process.platform === "win32") {
      const ps = `
        $self = @(${[...mine].join(",")})
        $ids = @()
        $ids += Get-NetTCPConnection -State Listen -LocalPort ${ports.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }
        $ids += Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'node|cloudflared') -and ($_.CommandLine -match '${pattern}') } | ForEach-Object { $_.ProcessId }
        $ids | Where-Object { $_ -and ($self -notcontains $_) } | Sort-Object -Unique | ForEach-Object {
          try { Stop-Process -Id $_ -Force -ErrorAction Stop; $_ } catch {}
        }`;
      killed = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).split(/\s+/).filter(Boolean);
    } else {
      const pids = new Set();
      for (const port of ports) {
        try { execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).split(/\s+/).filter(Boolean).forEach((p) => pids.add(p)); } catch { /* none */ }
      }
      for (const pat of [...(mode === "all" ? ["cloudflared tunnel"] : []), ...(mode !== "frontend" ? ["--watch index.js"] : [])]) {
        try { execFileSync("pgrep", ["-f", pat], { encoding: "utf8" }).split(/\s+/).filter(Boolean).forEach((p) => pids.add(p)); } catch { /* none */ }
      }
      for (const p of pids) { if (!mine.has(Number(p))) { try { process.kill(Number(p), "SIGKILL"); killed.push(p); } catch { /* gone */ } } }
    }
  } catch (e) {
    if (!quiet) console.log("Could not check for old copies:", e.message);
  }
  if (killed.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); // let the OS release the port
  if (!quiet) console.log(killed.length ? `Stopped ${killed.length} old process${killed.length > 1 ? "es" : ""} — ready to start clean.` : "Nothing old was running — ports are free.");
  return killed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) freePorts({ mode: process.argv[2] || "all" });
