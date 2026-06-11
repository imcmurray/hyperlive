// Bans/mutes are the moderator's enforcement layer — channelId-first matching
// (display names can change or be spoofed), name fallback for id-less sources,
// and self-expiring timeouts. All local: OAuth stays youtube.readonly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BANS_FILE = path.join(await mkdtemp(path.join(tmpdir(), "hl-bans-")), "bans.json");
const { loadBans, ban, unban, mute, unmute, isBanned, isMuted, listBans } =
  await import("../../packages/ingest/src/bans.js");

await loadBans();

test("channelId match wins even when the display name changes", async () => {
  await ban({ channelId: "UC123", author: "@troll" });
  assert.equal(isBanned({ channelId: "UC123", author: "@renamed" }), true);
  assert.equal(isBanned({ channelId: "UCother", author: "@innocent" }), false);
  await unban({ channelId: "UC123" });
  assert.equal(isBanned({ channelId: "UC123", author: "@troll" }), false);
});

test("name fallback matches case-insensitively for id-less sources", async () => {
  await ban({ author: "@Spammer" });
  assert.equal(isBanned({ author: "@spammer" }), true);
  assert.equal(isBanned({ author: "@spammer2" }), false); // no substring matching
  await unban({ author: "@SPAMMER" });
  assert.equal(isBanned({ author: "@spammer" }), false);
});

test("timeouts self-expire; permanent bans don't", async () => {
  await ban({ author: "@kicked", durationMs: 1 }); // expires ~immediately
  await ban({ author: "@gone" });                  // permanent
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(isBanned({ author: "@kicked" }), false);
  assert.equal(isBanned({ author: "@gone" }), true);
  assert.equal(listBans().some((b) => b.author === "@kicked"), false, "expired entry pruned");
  await unban({ author: "@gone" });
});

test("mute is a separate state from ban", async () => {
  await mute({ author: "@chatty" });
  assert.equal(isMuted({ author: "@chatty" }), true);
  assert.equal(isBanned({ author: "@chatty" }), false);
  await unmute({ author: "@chatty" });
  assert.equal(isMuted({ author: "@chatty" }), false);
});

test("ban requires an identity; double-ban is idempotent", async () => {
  assert.equal((await ban({})).ok, false);
  await ban({ author: "@dup" });
  const second = await ban({ author: "@dup" });
  assert.equal(second.already, true);
  assert.equal(listBans().filter((b) => b.author === "@dup").length, 1);
  await unban({ author: "@dup" });
});
