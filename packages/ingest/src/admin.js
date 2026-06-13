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
import { saveJson } from "./state.js";
import { getAccessToken } from "./youtube-auth.js";
import { discoverActiveBroadcast } from "./youtube.js";
import { bill, unitsSpent } from "./quota.js";
import { ban, unban, mute, unmute, listBans, listMutes, isBanned, isMuted } from "./bans.js";
import { listAutomations, setAutomation, addCustom, updateCustom, buildPreviewDirectives } from "./automations.js";
import { listStages, getStage, addStage, updateStage, removeStage, setActive, buildApplyDirectives, setTitleDefault, featuresOf, sourceKey } from "./stages.js";
import { setActiveFeatures, activeFeatures } from "./features.js";
import { captureAsset, listAssets, getAsset, setStars, setLabel, removeAsset, markUsed } from "./assets.js";

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
// Mod actions taken AGAINST a user (ban/mute/…). These belong on the target's
// own timeline — with a timestamp, exactly like the feed — but they are not
// messages FROM the user, so they don't inflate msg counts and (per the rule
// above) never conjure a user record from nothing.
const USER_MOD_STAGES = new Set(["banned_by_mod", "muted_by_mod", "unbanned", "unmuted"]);
const USERS_MAX = 500, USER_EVENTS_MAX = 50;
const users = new Map(); // author(lower) → profile
// how long after an author's FIRST event their feed rows stay flagged "new" —
// long enough for the host to spot and call them out, short enough that a
// regular doesn't wear the badge all stream
export const NEW_USER_WINDOW_MS = 5 * 60 * 1000;

// ---- persisted first-seen ledger: author(lower) → first-seen ms ------------
// Keeps the NEW badge honest across ingest restarts: without it, a mid-stream
// restart would re-flag every regular as a first-timer. The full profiles stay
// session-scoped (they hold event history); only the first-seen time survives.
const FIRST_SEEN_FILE = process.env.FIRST_SEEN_FILE || "./state/first-seen.json";
const FIRST_SEEN_MAX = 5000; // oldest entries evicted past this
const firstSeen = new Map(); // author(lower) → ms
let firstSeenTimer = null;
export async function loadFirstSeen() {
  try {
    const j = JSON.parse(await readFile(FIRST_SEEN_FILE, "utf8"));
    for (const [k, v] of Object.entries(j || {})) if (Number.isFinite(v)) firstSeen.set(k, v);
  } catch { /* none yet */ }
  return firstSeen.size;
}
function recordFirstSeen(k, ms) {
  firstSeen.set(k, ms);
  if (firstSeen.size > FIRST_SEEN_MAX) {
    // evict the oldest tenth in one pass (sorting 5k entries every comment would hurt)
    const sorted = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]);
    for (const [kk] of sorted.slice(0, Math.ceil(FIRST_SEEN_MAX / 10))) firstSeen.delete(kk);
  }
  // debounced write — new-author bursts at stream start become one save
  clearTimeout(firstSeenTimer);
  firstSeenTimer = setTimeout(() => {
    saveJson(FIRST_SEEN_FILE, Object.fromEntries(firstSeen)).catch(() => { /* non-fatal */ });
  }, 3000);
  firstSeenTimer.unref?.(); // never keep the process alive for a pending save
}

function trackUser(evt) {
  const c = evt.comment;
  if (!c?.author) return;
  const k = c.author.toLowerCase();
  if (USER_MOD_STAGES.has(evt.stage)) {
    const u = users.get(k); // only annotate an existing user; never create one
    if (!u) return;
    u.events.push(evt);
    if (u.events.length > USER_EVENTS_MAX) u.events.shift();
    return;
  }
  if (!USER_STAGES.has(evt.stage)) return;
  let u = users.get(k);
  if (!u) {
    // the persisted ledger wins: an author from a previous stream (or from
    // before a mid-stream restart) is NOT a first-timer
    const firstMs = firstSeen.get(k) || Date.parse(evt.t) || Date.now();
    if (!firstSeen.has(k)) recordFirstSeen(k, firstMs);
    u = { author: c.author, channelId: "", avatar: "", first: new Date(firstMs).toISOString(), msgs: 0, stages: {}, superchats: 0, events: [] };
    users.set(k, u);
  }
  // first appearance ever (+ grace window) → the dashboard tints the row so
  // the host can welcome them
  if (Date.now() - (Date.parse(u.first) || 0) < NEW_USER_WINDOW_MS) evt.newUser = true;
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
          assetCount: listAssets().length,
        });
      }

      // ---- preflight: pre-stream go/no-go checks, run on demand from the
      // dashboard's entry modal. Verifies the whole chain end to end: streamer
      // up → OAuth refresh token actually mints a token → a live/ready broadcast
      // exists → its live chat is readable → YouTube is actually RECEIVING our
      // encoder on the bound stream + the .env key matches → Anthropic key valid
      // → quota room. Costs a few quota units per run (real API calls — the point).
      if (route === "POST /admin/preflight") {
        const checks = [];
        const add = (name, status, detail) => checks.push({ name, status, detail });

        // 1. streamer control plane (scene + encoder)
        const health = await proxyGet(`${config.controlBase}/health`);
        if (!health) {
          add("streamer", "fail", `no response from ${config.controlBase} — is the streamer container up? (live.sh start)`);
        } else {
          add("scene", health.sceneReady ? "ok" : "fail", health.sceneReady ? `ready · show ${health.showState || "?"}` : "scene page not ready");
          add("encoder", health.ffmpegUp ? "ok" : health.dryRun ? "warn" : "fail",
            health.ffmpegUp ? `ffmpeg up → ${health.ingest || "?"}${health.ffmpegRestarts ? ` (${health.ffmpegRestarts} restarts)` : ""}`
              : health.dryRun ? "dry-run — rendering but not pushing RTMP"
              : "ffmpeg DOWN — nothing is reaching YouTube");
        }

        // 2. YouTube: auth → broadcast → chat feed (youtube source only)
        if (config.source !== "youtube") {
          add("youtube", "skip", `source=${config.source} — chat comes from the simulator, no YouTube checks`);
        } else if (!config.yt.clientId || !config.yt.clientSecret || !config.yt.refreshToken) {
          add("youtube auth", "fail", "missing YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN in .env — run: node packages/ingest/src/youtube-auth.js");
        } else {
          let token = "";
          try {
            // force=true does a REAL refresh — proves the refresh token still works
            token = await getAccessToken(true);
            add("youtube auth", "ok", "refresh token valid — access token minted");
          } catch (e) {
            add("youtube auth", "fail", `token refresh failed: ${e.message} — re-run: node packages/ingest/src/youtube-auth.js, paste the new YT_REFRESH_TOKEN into .env, restart the ingest`);
          }
          if (token) {
            try {
              // recognizes a READY/TESTING broadcast (bound, chat open, waiting)
              // as well as a LIVE one — same discovery the poller uses
              const b = await discoverActiveBroadcast(token);
              const live = b.status === "live";
              if (!b.id) {
                add("broadcast", "warn", "no live or ready broadcast — create one in YouTube Studio (it's picked up the moment chat opens, before Go Live)");
              } else if (live) {
                add("broadcast", "ok", `🔴 LIVE — on air now (video ${b.id})`);
              } else {
                // set up and waiting — a pass for preflight purposes (everything
                // is in place; the operator just hasn't pressed Go Live yet)
                add("broadcast", "ok", `${(b.status || "ready").toUpperCase()} — set up & waiting; press GO LIVE in Studio to go on air (video ${b.id})`);
              }
              if (b.id) {
                if (!b.liveChatId) {
                  add("chat feed", "fail", "broadcast has no liveChatId — is chat enabled on the stream?");
                } else {
                  // one real liveChatMessages.list page — the same call the
                  // poller makes (chat is readable in ready/testing too), so a
                  // pass here means chat WILL flow
                  const cu = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
                  cu.searchParams.set("liveChatId", b.liveChatId);
                  cu.searchParams.set("part", "snippet");
                  const cr = await fetch(cu, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
                  await bill(config.yt.unitsPerCall || 5);
                  add("chat feed", cr.ok ? "ok" : "fail",
                    cr.ok ? (live ? "live chat readable — comments are flowing" : "chat readable — early comments will be picked up before Go Live")
                      : `liveChatMessages http ${cr.status}`);
                }

                // RTMP ingestion: is YouTube actually RECEIVING our encoder, on
                // the stream THIS broadcast is bound to? ("ffmpeg up" only means
                // our process runs — it can't see whether the bytes land, or
                // whether .env points at the same stream the broadcast expects.)
                try {
                  const bd = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
                  bd.searchParams.set("part", "contentDetails"); bd.searchParams.set("id", b.id);
                  const bdr = await fetch(bd, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
                  await bill(1);
                  const boundStreamId = (await bdr.json()).items?.[0]?.contentDetails?.boundStreamId || "";
                  if (!boundStreamId) {
                    add("rtmp ingestion", "fail", "broadcast isn't bound to a stream — bind a stream key in YouTube Studio");
                  } else {
                    const sd = new URL("https://www.googleapis.com/youtube/v3/liveStreams");
                    sd.searchParams.set("part", "status,cdn"); sd.searchParams.set("id", boundStreamId);
                    const sdr = await fetch(sd, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
                    await bill(1);
                    const stream = (await sdr.json()).items?.[0];
                    const ss = stream?.status?.streamStatus, hh = stream?.status?.healthStatus?.status;
                    const boundKey = stream?.cdn?.ingestionInfo?.streamName || "";
                    const tail = (k) => "…" + String(k).slice(-4);
                    if (ss === "active") {
                      add("rtmp ingestion", hh === "bad" ? "warn" : "ok",
                        `YouTube IS receiving the encoder (stream ${ss} · health ${hh || "?"})` + (live ? "" : " — but parked at READY; press GO LIVE in Studio to put it on air"));
                    } else {
                      add("rtmp ingestion", "fail",
                        `YouTube is NOT receiving data (stream ${ss || "unknown"}) — the encoder isn't reaching this broadcast's stream. Check the streamer (live.sh status) and the key below.`);
                    }
                    // key match: are we pushing where this broadcast listens?
                    const envKey = process.env.YT_STREAM_KEY || "";
                    if (!envKey) add("stream key", "warn", "YT_STREAM_KEY not set in .env — can't confirm we're feeding this broadcast's stream");
                    else if (!boundKey) add("stream key", "warn", "couldn't read the bound stream's key to compare");
                    else add("stream key", envKey === boundKey ? "ok" : "fail",
                      envKey === boundKey ? `.env key matches the bound stream (${tail(boundKey)})`
                        : `MISMATCH — .env pushes ${tail(envKey)} but this broadcast is bound to ${tail(boundKey)}. You're feeding a different stream; point YT_STREAM_KEY at this broadcast's key (or go live on the broadcast bound to ${tail(envKey)}), then restart.`);
                  }
                } catch (e) {
                  add("rtmp ingestion", "warn", `couldn't verify ingestion: ${e.message}`);
                }
              }
            } catch (e) {
              add("broadcast", "fail", `broadcast discovery failed: ${e.message}`);
            }
          }
          const spent = unitsSpent();
          add("quota", spent < config.yt.quotaLimit * 0.8 ? "ok" : spent < config.yt.quotaLimit ? "warn" : "fail",
            `${spent}/${config.yt.quotaLimit} units spent today (resets midnight Pacific)`);
        }

        // 3. Anthropic key (director / moderation / card authoring / vision gate)
        if (!config.anthropicKey) {
          add("anthropic", "warn", "no ANTHROPIC_API_KEY — AI layer off (rules director, no !card authoring, no vision gate)");
        } else {
          try {
            // GET /v1/models is free and authenticated — a cheap key check
            const ar = await fetch("https://api.anthropic.com/v1/models?limit=1", {
              headers: { "x-api-key": config.anthropicKey, "anthropic-version": "2023-06-01" },
              signal: AbortSignal.timeout(8000),
            });
            add("anthropic", ar.ok ? "ok" : "fail", ar.ok ? "API key valid" : ar.status === 401 ? "API key REJECTED (401) — check ANTHROPIC_API_KEY in .env" : `models endpoint http ${ar.status}`);
          } catch (e) {
            add("anthropic", "fail", `unreachable: ${e.message}`);
          }
        }

        // read-only config summary for the modal (env-driven — changing these
        // means editing .env and restarting via live.sh, not this dashboard)
        const summary = {
          source: config.source,
          director: config.director,
          moderationLLM: config.moderationLLM,
          holdCards: config.holdCards,
          music: config.music,
          cards: config.cards,
          votes: config.votes,
          audioMode: health?.audioMode,
          dryRun: health?.dryRun,
        };
        publishFeed({ stage: "show_control", comment: { author: "operator", text: `preflight: ${checks.filter((c) => c.status === "fail").length ? "FAIL" : "pass"}` } });
        return json(res, 200, { ok: true, checks, summary });
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

      // mod clicked a NEW badge: put a small welcome card on stage so the
      // newcomer gets called out even when the host is mid-flow. Same vetted
      // addShoutout action the director and automations use — no new surface.
      if (route === "POST /admin/callout") {
        const b = await readJson(req);
        const author = String(b.author || "").slice(0, 60).trim();
        if (!author) return json(res, 400, { ok: false, error: "author required" });
        const params = { tier: "small", who: author, text: "welcome to the stream! 👋" };
        if (typeof b.avatar === "string" && b.avatar) params.avatar = b.avatar.slice(0, 2048);
        const out = await fetch(`${config.controlBase}/mutate`, {
          method: "POST", signal: AbortSignal.timeout(8000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "addShoutout", params }),
        }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
        if (out.ok !== false) publishFeed({ stage: "automation", comment: { author: "operator", text: `welcome callout → ${author}` } });
        return json(res, out.ok === false ? 502 : 200, out.ok === false ? out : { ok: true });
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

      // edit a queued card in place: re-render the new markup off-air and update
      // this item's html + thumbnail + vision (so AIR IT airs the edited version)
      if (req.method === "POST" && /^\/admin\/pending\/[\w-]+\/update$/.test(url.pathname)) {
        const id = url.pathname.split("/")[3];
        const item = pending.get(id);
        if (!item) return json(res, 404, { ok: false, error: "no such pending item" });
        const b = await readJson(req);
        const html = String(b.html || "");
        if (!html.trim()) return json(res, 400, { ok: false, error: "html required" });
        const pv = await previewMarkup(item.kind, html, item.who);
        if (!pv.ok) return json(res, 422, { ok: false, error: pv.error || `preview failed (${pv.status})` });
        item.html = html; item.screenshot = pv.screenshot; item.vision = pv.vision;
        return json(res, 200, { ok: true, screenshot: pv.screenshot, vision: pv.vision });
      }

      if (req.method === "POST" && /^\/admin\/pending\/[\w-]+$/.test(url.pathname)) {
        const id = url.pathname.split("/").pop();
        const item = pending.get(id);
        if (!item) return json(res, 404, { ok: false, error: "no such pending item" });
        const b = await readJson(req);
        pending.delete(id);
        if (String(b.action) === "approve") {
          const out = await airApproved(item);
          // a card that actually aired becomes a reusable library asset
          if (out.ok) captureAsset({ kind: item.kind, html: item.html, who: item.who, screenshot: item.screenshot }).catch(() => {});
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

      // ---- asset library: previously-aired cards, reusable + star-rated ----
      if (route === "GET /admin/assets") {
        return json(res, 200, { ok: true, assets: listAssets() });
      }
      // star rating / rename / delete
      if (route === "POST /admin/assets") {
        const b = await readJson(req);
        const out = b.remove
          ? await removeAsset(String(b.id || ""))
          : b.label !== undefined
            ? await setLabel(String(b.id || ""), b.label)
            : await setStars(String(b.id || ""), b.stars);
        return json(res, out.ok ? 200 : 404, out);
      }
      // re-air a saved asset (its markup already passed the gate when first aired;
      // air as operator, the vision gate still re-checks when a key is present)
      if (route === "POST /admin/assets/reuse") {
        const b = await readJson(req);
        const a = getAsset(String(b.id || ""));
        if (!a) return json(res, 404, { ok: false, error: "unknown asset" });
        const out = await airApproved({ kind: a.kind, html: a.html, who: a.who });
        if (out.ok) markUsed(a.id);
        publishFeed({ stage: out.ok ? "approved" : "approve_failed", kind: a.kind, comment: { author: a.who, text: `reused: ${a.label}` }, error: out.error });
        return json(res, out.ok ? 200 : 502, out);
      }
      // raw markup of one asset, for the "tweak" → load-into-compose action
      if (route === "GET /admin/asset") {
        const a = getAsset(String(url.searchParams.get("id") || ""));
        if (!a) return json(res, 404, { ok: false, error: "unknown asset" });
        return json(res, 200, { ok: true, id: a.id, kind: a.kind, html: a.html, who: a.who });
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
