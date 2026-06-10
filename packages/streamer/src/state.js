// Atomic JSON persistence: write a temp file, then rename() over the target
// (atomic on the same filesystem) — a crash mid-write can never leave truncated
// JSON behind (the music queue and song-likes files live on a bind mount and
// survive restarts, so corruption would too).

import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export async function saveJson(file, data) {
  const tmp = file + ".tmp";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}
