# Wiring real YouTube Live chat (OAuth)

Switches the ingest from the simulator to **real viewers**: their messages,
names, avatars, `!theme:`/`!like`/Suno-link commands, and Super Chats drive the
scene. One-time setup, then it runs unattended (auto-refreshing tokens,
auto-finding your live broadcast's chat).

## One-time setup

1. **Google Cloud project** — <https://console.cloud.google.com> → create/select a project.
2. **Enable the API** — APIs & Services → Library → enable **YouTube Data API v3**.
3. **OAuth consent screen** — User type **External**; add your Google account under
   **Test users** (keeps it in "testing" — no verification needed for personal use);
   scope `…/auth/youtube.readonly`.
4. **OAuth client** — Credentials → Create credentials → OAuth client ID →
   application type **Desktop app**. Copy the **Client ID** and **Client secret**.
5. **Put them in `.env`** (gitignored) at the repo root:
   ```
   YT_CLIENT_ID=xxxx.apps.googleusercontent.com
   YT_CLIENT_SECRET=xxxx
   ```
6. **Authorize once** — from the repo root:
   ```
   node packages/ingest/src/youtube-auth.js
   ```
   It prints a URL → open it in your browser (same machine; it redirects to
   `127.0.0.1:8723`) → approve. It then prints a `YT_REFRESH_TOKEN=…` line.
   Paste that into `.env` too. (The refresh token is long-lived; you only redo
   this if you revoke access.)

## Going live

1. Start **Go Live** on YouTube (the desktop "Streaming software" path — the
   streamer container is already pushing RTMP to your key).
2. Start the chat ingest with the control script (single-instance, logs, status):
   ```
   scripts/live.sh start      # stop | restart | status | logs | queue <url> | skip
   ```
   It runs `SOURCE=youtube`, auto-discovers the active broadcast's `liveChatId`
   (waits politely if you haven't gone live yet), reacts to **new** messages
   only, and resumes from a saved cursor (`state/yt-cursor.json`) across restarts
   so nothing's missed during a bounce.

Everything downstream is unchanged — moderation, the mood engine, theme voting,
music requests/likes, Super-Chat tiers (YouTube tier 1–5 → small/medium/large).

## ⚠️ Quota — the one real limit

YouTube Data API gives **10,000 units/day** by default, and each chat poll costs
**~5 units**. At a ~5s polling cadence that's ~5 units × ~12/min ≈ **3,600/hr**,
so the default quota sustains only **~2–3 hours/day** of live polling before
`liveChatMessages.list` returns 403 *quotaExceeded*.

Options:
- Run **real chat for events** and the `SOURCE=live` simulator the rest of the time.
- **Request a quota increase** (Google Cloud → APIs & Services → Quotas) for
  sustained 24/7 — it requires a short audit form.

## Env summary (all in the gitignored `.env`)

| var | purpose |
|---|---|
| `YT_CLIENT_ID` / `YT_CLIENT_SECRET` | OAuth Desktop client |
| `YT_REFRESH_TOKEN` | from `youtube-auth.js`; mints access tokens automatically |
| `YT_LIVE_CHAT_ID` | *optional* — pin a chat id instead of auto-discovering |
| `YT_ACCESS_TOKEN` | *optional* — supply a short-lived token directly (skips refresh) |
