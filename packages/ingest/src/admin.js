// Phase 4: the moderator/operator admin plane. A small dependency-free HTTP
// server (loopback ONLY — remote moderators come in over Tailscale/SSH, we
// don't write auth code to get wrong) that serves the dashboard UI and:
//
//   GET  /admin/feed          SSE — moderation feed (ring-buffer replay + live)
//   GET  /admin/state         bans + pending + streamer health, one poll
//   POST /admin/bans          { action:"ban"|"unban", channelId?, author? }
//   POST /admin/pending/:id   { action:"approve"|"reject" }
//   POST /admin/compose       { kind:"card"|"takeover", html, who? } → preview → queue
//   POST /admin/clear         proxy → streamer /cards/clear (kill switch)
//
// The feed comes from an IN-PROCESS ring buffer (publishFeed is called by the
// ingest's audit path), not from tailing the audit file — the file is
// persistence, the bus is the live view.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { ban, unban, listBans } from "./bans.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH_HTML = path.resolve(__dirname, "../../dashboard/index.html");

// ---- live moderation feed: ring buffer + SSE fanout ------------------------
const RING_MAX = 250;
const ring = [];
const sseClients = new Set();
let seq = 0;

export function publishFeed(entry) {
  const evt = { seq: ++seq, t: entry.t || new Date().toISOString(), ...entry };
  ring.push(evt);
  if (ring.length > RING_MAX) ring.shift();
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

// ---- hold-for-review queue --------------------------------------------------
const pending = new Map(); // id → { id, kind, who, request, html, screenshot, vision, ts }
let pendingSeq = 0;

export function enqueuePending(item) {
  const id = `p${++pendingSeq}`;
  const entry = { id, ts: Date.now(), ...item };
  pending.set(id, entry);
  publishFeed({ stage: "held", kind: item.kind, comment: { author: item.who, text: item.request || "(composed)" }, pendingId: id });
  return entry;
}

// run markup through the streamer's gate in preview mode (off-air render +
// optional vision verdict, returns the screenshot, airs nothing)
export async function previewMarkup(kind, html, who) {
  const res = await fetch(`${config.controlBase}/${kind === "takeover" ? "takeover" : "card"}`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html, who, preview: true, source: "viewer" }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.ok !== false, status: res.status, ...body };
}

async function airApproved(item) {
  // human approval is the strongest trust signal we have — air as operator
  // (the vision gate still re-checks when a key is present; defense in depth)
  const res = await fetch(`${config.controlBase}/${item.kind === "takeover" ? "takeover" : "card"}`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html: item.html, who: item.who, source: "operator" }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.ok !== false, status: res.status, error: body.error };
}

// ---- tiny http helpers ------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function readJson(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
const proxyGet = (url) => fetch(url, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);

// ---- the server -------------------------------------------------------------
export function startAdmin({ log = console.log } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /" || route === "GET /index.html") {
        const html = await readFile(DASH_HTML, "utf8").catch(() => "<h1>dashboard/index.html missing</h1>");
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(html);
      }

      if (route === "GET /admin/feed") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const evt of ring) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25000);
        req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }

      if (route === "GET /admin/state") {
        const [health, music] = await Promise.all([
          proxyGet(`${config.controlBase}/health`),
          proxyGet(`${config.controlBase}/music/status`),
        ]);
        return json(res, 200, {
          ok: true,
          bans: listBans(),
          pending: [...pending.values()],
          health, music,
          holdCards: config.holdCards,
        });
      }

      if (route === "POST /admin/bans") {
        const b = await readJson(req);
        const action = String(b.action || "ban");
        const out = action === "unban"
          ? await unban({ channelId: b.channelId, author: b.author })
          : await ban({ channelId: b.channelId, author: b.author, by: "dashboard" });
        publishFeed({ stage: action === "unban" ? "unbanned" : "banned_by_mod", comment: { author: b.author || b.channelId, text: "" } });
        return json(res, out.ok ? 200 : 400, out);
      }

      if (req.method === "POST" && /^\/admin\/pending\/[\w-]+$/.test(url.pathname)) {
        const id = url.pathname.split("/").pop();
        const item = pending.get(id);
        if (!item) return json(res, 404, { ok: false, error: "no such pending item" });
        const b = await readJson(req);
        pending.delete(id);
        if (String(b.action) === "approve") {
          const out = await airApproved(item);
          publishFeed({ stage: out.ok ? "approved" : "approve_failed", kind: item.kind, comment: { author: item.who, text: item.request || "" }, error: out.error });
          return json(res, out.ok ? 200 : 502, out);
        }
        publishFeed({ stage: "rejected_by_mod", kind: item.kind, comment: { author: item.who, text: item.request || "" } });
        return json(res, 200, { ok: true, rejected: id });
      }

      if (route === "POST /admin/compose") {
        const b = await readJson(req);
        const kind = b.kind === "takeover" ? "takeover" : "card";
        const html = String(b.html || "");
        if (!html.trim()) return json(res, 400, { ok: false, error: "html required" });
        const pv = await previewMarkup(kind, html, String(b.who || "moderator"));
        if (!pv.ok) return json(res, 422, { ok: false, error: pv.error || `preview failed (${pv.status})` });
        const entry = enqueuePending({ kind, who: String(b.who || "moderator"), request: "(composed in dashboard)", html, screenshot: pv.screenshot, vision: pv.vision });
        return json(res, 200, { ok: true, id: entry.id });
      }

      if (route === "POST /admin/clear") {
        const out = await fetch(`${config.controlBase}/cards/clear`, { method: "POST", signal: AbortSignal.timeout(5000) })
          .then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
        publishFeed({ stage: "kill_switch", comment: { author: "moderator", text: "cleared all generated content" } });
        return json(res, 200, out);
      }

      json(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e.message) });
    }
  });

  server.listen(config.adminPort, "127.0.0.1", () => {
    log(`[admin] dashboard → http://127.0.0.1:${config.adminPort}/  (loopback only — tunnel in for remote mods)`);
  });
  return server;
}
