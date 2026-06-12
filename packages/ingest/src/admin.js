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
import { ban, unban, mute, unmute, listBans, listMutes, isBanned, isMuted } from "./bans.js";
import { listAutomations, setAutomation, addCustom, updateCustom, buildPreviewDirectives } from "./automations.js";
import { listStages, getStage, addStage, updateStage, removeStage, setActive, buildApplyDirectives, setTitleDefault, featuresOf, sourceKey } from "./stages.js";
import { setActiveFeatures, activeFeatures } from "./features.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH_HTML = path.resolve(__dirname, "../../dashboard/index.html");

// ---- ingest vitals: counters provided by index.js (avoids a circular import) --
let vitalsProvider = () => ({});
export function setVitalsProvider(fn) { vitalsProvider = fn; }

// ---- replay: a mod re-runs a cooldown-skipped comment through the director --
let replayHandler = null;
export function setReplayHandler(fn) { replayHandler = fn; }

// ---- live moderation feed: ring buffer + SSE fanout ------------------------
const RING_MAX = 250;
const ring = [];
const sseClients = new Set();
let seq = 0;

// superchats awaiting an ON-AIR CALLOUT: pinned in the dashboard until the
// host clicks the ★ ("I've thanked them with my voice"). Server-side so the
// queue survives dashboard reloads and is shared between mods.
const scAwait = new Map(); // comment.id → superchat event

export function publishFeed(entry) {
  const evt = { seq: ++seq, t: entry.t || new Date().toISOString(), ...entry };
  ring.push(evt);
  if (ring.length > RING_MAX) ring.shift();
  if (evt.stage === "superchat" && evt.comment?.id) {
    scAwait.set(evt.comment.id, evt);
    while (scAwait.size > 50) scAwait.delete(scAwait.keys().next().value);
  }
  trackUser(evt);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

// ---- per-user aggregates: who interacted, what they did (session-scoped) ----
// Only comment-driven stages count — operator/mod events don't create "users".
const USER_STAGES = new Set([
  "applied", "blocked", "banned", "muted", "skipped", "held", "card_held",
  "card", "card_cooldown", "music_request", "music_like", "vote", "error", "superchat",
]);
const USERS_MAX = 500, USER_EVENTS_MAX = 50;
const users = new Map(); // author(lower) → profile

function trackUser(evt) {
  const c = evt.comment;
  if (!c?.author || !USER_STAGES.has(evt.stage)) return;
  const k = c.author.toLowerCase();
  let u = users.get(k);
  if (!u) {
    u = { author: c.author, channelId: "", avatar: "", first: evt.t, msgs: 0, stages: {}, superchats: 0, events: [] };
    users.set(k, u);
  }
  if (c.channelId) u.channelId = c.channelId;
  if (c.avatar) u.avatar = c.avatar;
  if (evt.stage === "superchat") u.superchats++; // counted once per paid message (the recognition event)
  u.last = evt.t;
  u.msgs++;
  u.stages[evt.stage] = (u.stages[evt.stage] || 0) + 1;
  u.events.push(evt);
  if (u.events.length > USER_EVENTS_MAX) u.events.shift();
  if (users.size > USERS_MAX) { // evict the least-recently-seen
    let oldestK = null, oldestT = "";
    for (const [kk, uu] of users) if (!oldestK || uu.last < oldestT) { oldestK = kk; oldestT = uu.last; }
    users.delete(oldestK);
  }
}

const userSummary = (u) => ({
  author: u.author, channelId: u.channelId, avatar: u.avatar,
  first: u.first, last: u.last, msgs: u.msgs, stages: u.stages, superchats: u.superchats,
  banned: isBanned(u), muted: isMuted(u),
});

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
        const [health, music, queue] = await Promise.all([
          proxyGet(`${config.controlBase}/health`),
          proxyGet(`${config.controlBase}/music/status`),
          proxyGet(`${config.controlBase}/music/queue`),
        ]);
        const stages = listStages();
        const activeStage = getStage(stages.active);
        return json(res, 200, {
          ok: true,
          bans: listBans(),
          pending: [...pending.values()],
          health, music, queue,
          holdCards: config.holdCards,
          vitals: vitalsProvider(),
          scAwait: [...scAwait.values()],
          stage: activeStage ? { id: activeStage.id, label: activeStage.label, kind: activeStage.kind } : null,
          features: activeFeatures(),
        });
      }

      // host clicked the ★ — this superchat has been called out on stream
      if (route === "POST /admin/superchats/ack") {
        const b = await readJson(req);
        const evt = scAwait.get(String(b.id || ""));
        if (!evt) return json(res, 404, { ok: false, error: "not awaiting a callout" });
        scAwait.delete(String(b.id));
        publishFeed({ stage: "sc_ack", comment: { ...evt.comment } });
        return json(res, 200, { ok: true });
      }

      // live MJPEG monitor / off-air preview twin: stream frames through (the
      // pop-out players). Tunneled mods still only need :8090.
      if (route === "GET /admin/monitor.mjpeg" || route === "GET /admin/preview.mjpeg") {
        const upstream = url.pathname.endsWith("preview.mjpeg") ? "preview.mjpeg" : "monitor.mjpeg";
        const ctrl = new AbortController();
        req.on("close", () => ctrl.abort());
        try {
          const up = await fetch(`${config.controlBase}/${upstream}`, { signal: ctrl.signal });
          if (!up.ok || !up.body) { res.writeHead(503); return res.end(); }
          res.writeHead(200, { "content-type": up.headers.get("content-type") || "multipart/x-mixed-replace", "cache-control": "no-store" });
          for await (const chunk of up.body) {
            if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
          }
        } catch { /* viewer closed or upstream died */ }
        return res.end();
      }

      // real-time stage monitor: proxy the streamer's screenshot so a tunneled
      // moderator only needs port 8090 (YouTube's own preview runs ~30s behind —
      // useless for "kill it now" decisions)
      if (route === "GET /admin/stage.png") {
        try {
          const r = await fetch(`${config.controlBase}/screenshot`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) throw new Error(`screenshot http ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "content-length": buf.length });
          return res.end(buf);
        } catch {
          res.writeHead(503); return res.end();
        }
      }

      // ---- show + music transport: the live.sh verbs, dashboard-clickable ----
      // (container/ingest process lifecycle stays in live.sh — this server
      // can't restart its own process or drive docker)
      if (route === "POST /admin/show") {
        const b = await readJson(req);
        const action = String(b.action || "");
        const post = (path, body) => fetch(`${config.controlBase}${path}`, {
          method: "POST", signal: AbortSignal.timeout(8000),
          headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
        let out;
        if (action === "onair") out = await post("/onair", { seconds: Number(b.seconds) || 10 });
        else if (action === "outro") out = await post("/outro", {});
        else if (action === "standby") {
          const mode = ["intro", "break", "technical", "off"].includes(b.mode) ? b.mode : "off";
          out = await post("/mutate", { action: "setStandby", params: { mode } });
        } else return json(res, 400, { ok: false, error: "action must be onair|outro|standby" });
        publishFeed({ stage: "show_control", comment: { author: "operator", text: action + (b.mode ? `:${b.mode}` : "") } });
        return json(res, 200, out);
      }

      if (route === "POST /admin/music") {
        const b = await readJson(req);
        const op = String(b.op || "");
        const post = (path, body) => fetch(`${config.controlBase}/music${path}`, {
          method: "POST", signal: AbortSignal.timeout(8000),
          headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
        }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
        let out;
        if (op === "skip") out = await post("/skip");
        else if (op === "fade") out = await post("/fade", { to: Number(b.to), ms: Number(b.ms) || 3000 });
        else if (op === "mode") out = await post("/mode", { mode: b.mode === "intro" ? "intro" : "live" });
        else return json(res, 400, { ok: false, error: "op must be skip|fade|mode" });
        publishFeed({ stage: "music_control", comment: { author: "operator", text: op + (b.mode ? `:${b.mode}` : b.to !== undefined ? `→${b.to}%` : "") } });
        return json(res, 200, out);
      }

      // ---- stage source (overlay mode): operator picks the main-stage video ----
      if (route === "POST /admin/stage") {
        const b = await readJson(req);
        const kind = String(b.kind || "none").toLowerCase();
        if (!["none", "off", "clear", "youtube", "yt", "video", "image"].includes(kind)) {
          return json(res, 400, { ok: false, error: "kind must be none|youtube|video|image" });
        }
        // pass only the vetted fields; the scene re-validates id/url + builds via DOM
        const params = { kind };
        if (b.id) params.id = String(b.id).slice(0, 2048);
        if (b.url) params.url = String(b.url).slice(0, 2048);
        if (b.muted !== undefined) params.muted = !!b.muted;
        const out = await fetch(`${config.controlBase}/mutate`, {
          method: "POST", signal: AbortSignal.timeout(8000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "setStageSource", params }),
        }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
        publishFeed({ stage: "stage_source", comment: { author: "operator", text: `source → ${kind}${params.id ? `:${params.id}` : params.url ? `:${params.url}` : ""}` } });
        return json(res, 200, out);
      }

      if (route === "POST /admin/bans") {
        const b = await readJson(req);
        const action = String(b.action || "ban");
        // durationMinutes: 0/absent = permanent, else a timeout
        const durationMs = Math.max(0, Number(b.durationMinutes) || 0) * 60000;
        const who = { channelId: b.channelId, author: b.author };
        const ops = {
          ban: () => ban({ ...who, by: "dashboard", durationMs }),
          unban: () => unban(who),
          mute: () => mute({ ...who, by: "dashboard", durationMs }),
          unmute: () => unmute(who),
        };
        if (!ops[action]) return json(res, 400, { ok: false, error: "action must be ban|unban|mute|unmute" });
        const out = await ops[action]();
        const FEED_STAGE = { ban: "banned_by_mod", unban: "unbanned", mute: "muted_by_mod", unmute: "unmuted" };
        const label = durationMs ? `timeout ${Math.round(durationMs / 60000)}m` : "";
        publishFeed({ stage: FEED_STAGE[action], comment: { author: b.author || b.channelId, text: label } });
        return json(res, out.ok ? 200 : 400, out);
      }

      // ---- automations: event → pre-built animation bindings ----
      if (route === "GET /admin/automations") {
        return json(res, 200, { ok: true, ...listAutomations() });
      }
      if (route === "POST /admin/automations") {
        const b = await readJson(req);
        const out = await setAutomation(String(b.key || ""), { enabled: b.enabled, style: b.style });
        if (out.ok) publishFeed({ stage: "automation", comment: { author: "operator", text: `${b.key}: ${out.enabled ? "on" : "off"}${out.style ? " · " + out.style : ""}` } });
        return json(res, out.ok ? 200 : 400, out);
      }
      // custom automations: add / toggle / delete
      if (route === "POST /admin/automations/custom") {
        const b = await readJson(req);
        let out;
        if (b.id) out = await updateCustom(String(b.id), { enabled: b.enabled, remove: b.remove === true });
        else out = await addCustom({ label: b.label, on: b.on, action: b.action, params: b.params });
        if (out.ok) publishFeed({ stage: "automation", comment: { author: "operator", text: b.id ? `custom ${b.id} ${b.remove ? "removed" : b.enabled ? "on" : "off"}` : `custom added: ${b.on} → ${b.action}` } });
        return json(res, out.ok ? 200 : 400, out);
      }
      // preview: fire the automation with sample data — into the OFF-AIR scene
      // twin by default (zero broadcast risk); {live:true} targets the stage
      if (route === "POST /admin/automations/preview") {
        const b = await readJson(req);
        const built = buildPreviewDirectives({ key: b.key, id: b.id });
        if (!built.ok) return json(res, 400, built);
        const target = b.live === true ? `${config.controlBase}/mutate` : `${config.controlBase}/preview/mutate`;
        let fired = [];
        for (const d of built.directives) {
          const r = await fetch(target, {
            method: "POST", signal: AbortSignal.timeout(20000), // twin cold-start takes a few seconds
            headers: { "content-type": "application/json" }, body: JSON.stringify(d),
          }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
          if (r.ok === false) return json(res, 502, { ok: false, error: r.error || "preview target rejected" });
          fired.push(d.action);
        }
        return json(res, 200, { ok: true, fired: fired.join("+"), offair: b.live !== true });
      }

      // ---- stages: presets for the main video + live switching ----
      if (route === "GET /admin/stages") {
        return json(res, 200, { ok: true, ...listStages() });
      }
      // global title-animation default (per-stage settings override it)
      if (route === "POST /admin/stages/titles") {
        const b = await readJson(req);
        const out = await setTitleDefault(String(b.default || ""));
        if (out.ok) publishFeed({ stage: "stage_source", comment: { author: "operator", text: `title default → ${out.titleDefault}` } });
        return json(res, out.ok ? 200 : 400, out);
      }
      // add / edit / remove a custom stage
      if (route === "POST /admin/stages/custom") {
        const b = await readJson(req);
        const def = { label: b.label, kind: b.kind, source: b.source, url: b.url, muted: b.muted, theme: b.theme, titles: b.titles, features: b.features, headline: b.headline, kicker: b.kicker, subhead: b.subhead, ticker: b.ticker, showTicker: b.showTicker, showVibe: b.showVibe };
        let out, verb;
        if (b.remove) { out = await removeStage(String(b.id || "")); verb = out.reset ? "reset" : "removed"; }
        else if (b.id) { out = await updateStage(String(b.id), def); verb = "edited"; }
        else { out = await addStage(def); verb = "added"; }
        if (out.ok) publishFeed({ stage: "stage_source", comment: { author: "operator", text: `stage ${verb}: ${out.stage?.label || b.id}` } });
        return json(res, out.ok ? 200 : 400, out);
      }
      // apply a stage LIVE (or preview it off-air with {preview:true})
      if (route === "POST /admin/stages/apply") {
        const b = await readJson(req);
        const stage = getStage(String(b.id || ""));
        if (!stage) return json(res, 404, { ok: false, error: "unknown stage" });
        // LIVE apply: if the source is unchanged from what's already on air, skip
        // the setStageSource directive so the video DOESN'T restart — we just
        // transition titles/features/ticker. (Always re-render the source for a
        // preview; the twin needs it.) {reload:true} forces a source reload.
        const liveNow = getStage(listStages().active);
        const skipSource = b.preview !== true && b.reload !== true && sourceKey(liveNow) === sourceKey(stage);
        const directives = buildApplyDirectives(stage, { skipSource });
        const target = b.preview === true ? `${config.controlBase}/preview/mutate` : `${config.controlBase}/mutate`;
        let fired = [];
        for (const d of directives) {
          const r = await fetch(target, {
            method: "POST", signal: AbortSignal.timeout(30000), // yt-dlp resolve + twin cold-start
            headers: { "content-type": "application/json" }, body: JSON.stringify(d),
          }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
          if (r.ok === false) return json(res, 502, { ok: false, error: r.error || "stage target rejected" });
          fired.push(d.action);
        }
        // a LIVE switch also re-shapes the interaction layer to this stage's
        // features (votes/superchats/effects/welcome/popups); a preview doesn't
        if (b.preview !== true) { await setActive(stage.id); setActiveFeatures(featuresOf(stage)); }
        publishFeed({ stage: "stage_source", comment: { author: "operator", text: `${b.preview ? "preview" : "→ STAGE"}: ${stage.label}` } });
        return json(res, 200, { ok: true, applied: stage.id, fired: fired.join("+"), offair: b.preview === true });
      }

      // ---- user directory: everyone who has interacted this session ----
      if (route === "GET /admin/users") {
        const list = [...users.values()].map(userSummary)
          .sort((a, b) => (b.last || "").localeCompare(a.last || ""));
        return json(res, 200, { ok: true, users: list, mutes: listMutes() });
      }
      if (route === "GET /admin/user") {
        const u = users.get(String(url.searchParams.get("author") || "").toLowerCase());
        if (!u) return json(res, 404, { ok: false, error: "unknown user (session-scoped — restarts clear the directory)" });
        return json(res, 200, { ok: true, user: { ...userSummary(u), events: u.events } });
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

      // mod clicked a cooldown-skipped row: re-run it through the director
      // with cooldowns bypassed (intent + allowlist validation still apply)
      if (route === "POST /admin/replay") {
        if (!replayHandler) return json(res, 503, { ok: false, error: "replay not wired" });
        const b = await readJson(req);
        const c = b.comment || {};
        const comment = {
          author: String(c.author || "viewer").slice(0, 60),
          text: String(c.text || "").slice(0, 250),
          avatar: typeof c.avatar === "string" ? c.avatar : "",
          ts: Number(c.ts) || Date.now(),
        };
        if (!comment.text.trim()) return json(res, 400, { ok: false, error: "comment.text required" });
        const out = await replayHandler(comment);
        return json(res, out.ok ? 200 : 422, out);
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

  server.listen(config.adminPort, config.adminBind, () => {
    log(`[admin] dashboard → http://127.0.0.1:${config.adminPort}/  (loopback only — tunnel in for remote mods)`);
  });
  return server;
}
