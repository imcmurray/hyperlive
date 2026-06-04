// YouTube OAuth: mint short-lived access tokens from a long-lived refresh token
// (so an unattended 24/7 run never needs a human), plus a one-time interactive
// consent flow that prints the refresh token to paste into .env.
//
//   one-time setup:  node packages/ingest/src/youtube-auth.js
//   at runtime:      getAccessToken() — cached, auto-refreshed near expiry
//
// Scope is youtube.readonly (enough to list the active broadcast + read chat).

import "./load-env.js"; // must precede config.js so OAuth secrets are in process.env
import http from "node:http";
import { config } from "./config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

let cached = { token: "", exp: 0 };

export async function getAccessToken(force = false) {
  if (config.yt.accessToken) return config.yt.accessToken; // explicit override (testing)
  const now = Date.now();
  if (!force && cached.token && now < cached.exp - 60000) return cached.token;
  const { clientId, clientSecret, refreshToken } = config.yt;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("YouTube OAuth needs YT_CLIENT_ID + YT_CLIENT_SECRET + YT_REFRESH_TOKEN — run: node packages/ingest/src/youtube-auth.js");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`token refresh http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

// ---- one-time interactive consent (loopback redirect) → prints refresh token ----
async function runAuthFlow() {
  const { clientId, clientSecret } = config.yt;
  if (!clientId || !clientSecret) {
    console.error("Set YT_CLIENT_ID and YT_CLIENT_SECRET in .env first (Google Cloud → OAuth client, type 'Desktop app'). See docs/youtube-oauth.md");
    process.exit(1);
  }
  const port = Number(process.env.YT_AUTH_PORT || 8723);
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: SCOPE, access_type: "offline", prompt: "consent",
  })) authUrl.searchParams.set(k, v);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      const c = u.searchParams.get("code"), err = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif;padding:2rem"><h2>${c ? "✓ Authorized — close this tab and return to the terminal." : "Auth failed: " + err}</h2></body></html>`);
      server.close();
      c ? resolve(c) : reject(new Error(err || "no code"));
    });
    server.listen(port, "127.0.0.1", () => {
      console.log("\n1) Open this URL in your browser and authorize the Google account that owns the live stream:\n");
      console.log("   " + authUrl.toString() + "\n");
      console.log(`2) Waiting for the redirect to ${redirectUri} …`);
    });
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
  });
  const j = await res.json();
  if (!j.refresh_token) {
    console.error("\nNo refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions then retry.\n", JSON.stringify(j, null, 2));
    process.exit(1);
  }
  console.log("\n✓ Success. Add this line to your .env (gitignored), then run with SOURCE=youtube:\n");
  console.log("   YT_REFRESH_TOKEN=" + j.refresh_token + "\n");
  process.exit(0);
}

// run directly → kick off the consent flow
if (import.meta.url === `file://${process.argv[1]}`) {
  runAuthFlow().catch((e) => { console.error("auth error:", e.message); process.exit(1); });
}
