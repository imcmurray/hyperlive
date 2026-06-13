// chooseBroadcast is the pure selector behind discoverActiveBroadcast: which
// broadcast the ingest attaches to. The rules it must hold:
//   · an ON-AIR (active) broadcast always wins;
//   · otherwise a bound, chat-open WAITING broadcast (testing > ready) so the
//     ingest reads the waiting-room chat before Go Live;
//   · never a `created`/scheduled-only or chat-less broadcast (those would be
//     future scheduled streams we must not auto-attach to).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBroadcast } from "../../packages/ingest/src/youtube.js";

const bc = (id, status, liveChatId, scheduledStartTime) =>
  ({ id, status: { lifeCycleStatus: status }, snippet: { liveChatId, scheduledStartTime } });

test("an active (on-air) broadcast wins outright", () => {
  const r = chooseBroadcast([bc("LIVE1", "live", "chatLive")], [bc("R1", "ready", "chatReady")]);
  assert.deepEqual(r, { id: "LIVE1", liveChatId: "chatLive", status: "live" });
});

test("falls back to a ready broadcast when nothing is on air", () => {
  const r = chooseBroadcast([], [bc("R1", "ready", "chatReady")]);
  assert.deepEqual(r, { id: "R1", liveChatId: "chatReady", status: "ready" });
});

test("testing outranks ready", () => {
  const r = chooseBroadcast([], [bc("R1", "ready", "cR"), bc("T1", "testing", "cT")]);
  assert.equal(r.id, "T1");
  assert.equal(r.status, "testing");
});

test("among same status, earliest scheduledStartTime is chosen", () => {
  const r = chooseBroadcast([], [
    bc("LATE", "ready", "cLate", "2026-06-12T20:00:00Z"),
    bc("SOON", "ready", "cSoon", "2026-06-12T18:00:00Z"),
  ]);
  assert.equal(r.id, "SOON");
});

test("a created/scheduled-only broadcast is never attached to", () => {
  const r = chooseBroadcast([], [bc("C1", "created", "cCreated")]);
  assert.deepEqual(r, { id: "", liveChatId: "", status: "" });
});

test("a chat-less broadcast is skipped (active and waiting alike)", () => {
  assert.equal(chooseBroadcast([bc("L", "live", "")], []).id, ""); // no chat → not usable
  assert.equal(chooseBroadcast([], [bc("R", "ready", "")]).id, "");
});

test("empty inputs → empty result (no broadcast at all)", () => {
  assert.deepEqual(chooseBroadcast(), { id: "", liveChatId: "", status: "" });
  assert.deepEqual(chooseBroadcast([], []), { id: "", liveChatId: "", status: "" });
});
