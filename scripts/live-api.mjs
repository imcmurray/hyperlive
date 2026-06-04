// JSON in / JSON out control surface, so another system can drive the live show
// programmatically. One command in, one JSON object out.
//
//   node scripts/live-api.mjs '{"cmd":"status"}'
//   node scripts/live-api.mjs '{"cmd":"enqueue","url":"https://suno.com/s/..","who":"@bot"}'
//   node scripts/live-api.mjs '{"cmd":"standby","mode":"outro"}'
//   node scripts/live-api.mjs '{"cmd":"mutate","action":"setTheme","params":{"theme":"forest"}}'
//   node scripts/live-api.mjs status            # bare word also works
//
// Covers the RUNTIME surface (read state + drive the scene/music). Container and
// ingest lifecycle stay in live.sh (boot/down/up/build/start/stop).

import { readFileSync } from "node:fs";

const BASE = process.env.CONTROL_BASE || "http://localhost:8080";
const USAGE_FILE = process.env.YT_USAGE_FILE_HOST || "state/yt-usage.json";

let req;
try { req = JSON.parse(process.argv[2] || '{"cmd":"status"}'); }
catch { req = { cmd: String(process.argv[2] || "status") }; } // allow a bare command word
const cmd = String(req.cmd || "status").toLowerCase();

const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); };
async function jget(p) { try { const r = await fetch(BASE + p); return r.ok ? await r.json() : null; } catch { return null; } }
async function jpost(p, body) {
  try {
    const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json().catch(() => ({ ok: r.ok }));
  } catch (e) { return { ok: false, error: e.message }; }
}
const usage = () => { try { return JSON.parse(readFileSync(USAGE_FILE, "utf8")); } catch { return null; } };

try {
  switch (cmd) {
    case "status": {
      const stream = await jget("/health"); // reachable ⇒ container up
      out({ ok: true, container: !!stream, stream, now: await jget("/music/status"), queue: await jget("/music/queue"), quota: usage() });
      break;
    }
    case "now":    out({ ok: true, ...(await jget("/music/status")) }); break;
    case "queue":  out({ ok: true, ...(await jget("/music/queue")) }); break;
    case "quota":  out({ ok: true, quota: usage() }); break;
    case "enqueue": out(await jpost("/music/enqueue", { link: req.url || req.link, who: req.who || "@api" })); break;
    case "skip": case "next": out(await jpost("/music/skip")); break;
    case "fade":   out(await jpost("/music/fade", { to: req.to, ms: req.ms })); break;
    case "standby": {
      const mode = req.mode || "off";
      const r = await jpost("/mutate", { action: "setStandby", params: { mode, title: req.title, subtitle: req.subtitle } });
      if (mode === "outro") await jpost("/music/fade", { to: 0, ms: 6000 });        // sign-off fade-out
      else if (mode === "off") await jpost("/music/fade", { to: 100, ms: 1800 });   // back on air
      out(r); break;
    }
    case "mutate": out(await jpost("/mutate", { action: req.action, params: req.params || {} })); break; // any allowed scene directive
    default: out({ ok: false, error: `unknown cmd: ${cmd}`, cmds: ["status", "now", "queue", "quota", "enqueue", "skip", "fade", "standby", "mutate"] });
  }
} catch (e) { out({ ok: false, error: e.message }); process.exitCode = 1; }
