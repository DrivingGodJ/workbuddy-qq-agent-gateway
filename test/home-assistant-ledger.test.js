import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/storage/session-store.js";

const key = "a".repeat(24);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "crc-ha-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-10-13T10:00:00.000Z");
  const clock = () => now;
  const filePath = join(directory, "sessions.json");
  const store = new SessionStore({ filePath, clock });
  await store.init({ allowedGroups: ["12345"] });
  return { store, filePath, clock, advance(ms) { now = new Date(now.getTime() + ms); } };
}

test("parallel claims permit one physical-action caller only", async (t) => {
  const { store } = await fixture(t);
  let effects = 0;
  const perform = () => store.claimHomeActionAttempt("12345", key).then(() => { effects++; });
  const results = await Promise.allSettled([perform(), perform()]);
  assert.equal(effects, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /不能重复执行/);
  assert.equal(store.snapshot("12345").homeAssistantAttempts.length, 1);
});

test("claims survive display-history truncation, normal turn completion and reload", async (t) => {
  const f = await fixture(t);
  f.store.ensureGroup("12345").codexConfig.homeAssistantPermission = "group";
  const message = await f.store.appendMessage({ groupId: "12345", messageId: "101", senderId: "100000001", source: "qq", trust: "OWNER", text: "打开台灯" });
  await f.store.requestTrigger("12345", "mention", message);
  await f.store.beginWork("12345");
  await f.store.claimHomeActionAttempt("12345", key);
  await f.store.recordLiveActionSent("12345", { kind: "home_assistant_attempt", summary: `[${key}] attempted`, chatReply: false });
  for (let i = 0; i < 31; i++) await f.store.recordLiveActionSent("12345", { kind: "reaction", summary: `reaction ${i}`, chatReply: false });
  assert.equal(f.store.snapshot("12345").liveSession.actions.length, 30);
  assert.equal(f.store.snapshot("12345").liveSession.actions.some((entry) => entry.kind === "home_assistant_attempt"), false);
  await f.store.completeLiveConversation("12345", { lastReadSequence: message.sequence });
  assert.equal(f.store.snapshot("12345").liveSession, null);
  assert.equal(f.store.snapshot("12345").pendingMessages.length, 0);
  const reloaded = new SessionStore({ filePath: f.filePath, clock: f.clock });
  await reloaded.init();
  await assert.rejects(reloaded.claimHomeActionAttempt("12345", key), /不能重复执行/);
  assert.equal(reloaded.snapshot("12345").codexConfig.homeAssistantPermission, "group");
});

test("expired claims can be reclaimed after thirty minutes, including after reload", async (t) => {
  const f = await fixture(t);
  await f.store.claimHomeActionAttempt("12345", key);
  f.advance(29 * 60_000);
  await assert.rejects(f.store.claimHomeActionAttempt("12345", key), /不能重复执行/);
  f.advance(60_000);
  const reloaded = new SessionStore({ filePath: f.filePath, clock: f.clock });
  await reloaded.init();
  assert.equal(reloaded.snapshot("12345").homeAssistantAttempts.length, 0);
  await reloaded.claimHomeActionAttempt("12345", key);
  assert.equal(reloaded.snapshot("12345").homeAssistantAttempts[0].at, f.clock().toISOString());
});

test("a failed durable save prevents effects and retains the in-memory claim", async (t) => {
  const { store } = await fixture(t);
  let saves = 0, effects = 0;
  store.save = async () => { saves++; throw new Error("ENOSPC"); };
  await assert.rejects(store.claimHomeActionAttempt("12345", key).then(() => { effects++; }), /ENOSPC/);
  await assert.rejects(store.claimHomeActionAttempt("12345", key).then(() => { effects++; }), /不能重复执行/);
  assert.equal(effects, 0);
  assert.equal(saves, 1);
  assert.equal(store.snapshot("12345").homeAssistantAttempts.length, 1);
});

test("capacity rejects new claims without dropping unexpired replay protection", async (t) => {
  const f = await fixture(t);
  const entries = Array.from({ length: 256 }, (_, index) => ({ key: index.toString(16).padStart(24, "0"), at: f.clock().toISOString() }));
  f.store.ensureGroup("12345").homeAssistantAttempts = entries;
  await f.store.save();
  const reloaded = new SessionStore({ filePath: f.filePath, clock: f.clock });
  await reloaded.init();
  await assert.rejects(reloaded.claimHomeActionAttempt("12345", key), /登记已满/);
  await assert.rejects(reloaded.claimHomeActionAttempt("12345", entries[0].key), /不能重复执行/);
  assert.equal(reloaded.snapshot("12345").homeAssistantAttempts.length, 256);
});
