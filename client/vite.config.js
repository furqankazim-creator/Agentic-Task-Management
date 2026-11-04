import { defineConfig, createLogger } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = process.env.API_TARGET || "http://localhost:3001";
let lastWarn = 0;

// Drop Vite's own "http proxy error" stack traces; the handler below prints one short hint instead.
const logger = createLogger();
const baseError = logger.error;
logger.error = (msg, opts) => { if (typeof msg === "string" && msg.includes("http proxy error")) return; baseError(msg, opts); };

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: false,
        configure: (proxy) => {
          // Replace Vite's noisy per-request stack trace with one short, throttled hint,
          // and answer the browser with a clear JSON error the app can show.
          proxy.removeAllListeners("error");
          proxy.on("error", (_err, req, res) => {
            if (!req.url?.startsWith("/api/pmconnect") && Date.now() - lastWarn > 15000) {
              lastWarn = Date.now();
              console.warn("\n[api] Backend is not running on port 3001. Start it:  cd server && npm run dev   (or from the project root: npm run dev)\n");
            }
            if (res && typeof res.writeHead === "function" && !res.headersSent) {
              if (req.url?.startsWith("/api/pmconnect")) { res.writeHead(204); res.end(); return; }
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Backend server is not running. Start it with: cd server && npm run dev" }));
            }
          });
        },
      },
    },
  },
});
