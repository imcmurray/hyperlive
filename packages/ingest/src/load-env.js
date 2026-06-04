// Minimal .env loader (no dependency). The ingest runs on the host (not in the
// streamer container, which gets .env via docker-compose), so import THIS first
// — before config.js — so process.env is populated for OAuth secrets etc.
// Existing env vars win, so `SOURCE=youtube node …` still overrides the file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  for (const line of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    }
  }
} catch {
  /* no .env file — rely on the ambient environment */
}
