import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";

const groupId = "123456789";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qq-session-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(root, "sessions.json") });
  await store.init({ allowedGroups: [groupId] });
  await store.setThread(groupId, "same-persistent-workbuddy-thread");
  const append = (messageId) => store.appendMessage({ groupId, messageId, text: `message ${messageId}` });
  const begin = async () => {
    await store.requestTrigger(groupId, "mention");
    return store.beginWork(groupId);
  };
  return { store, append, begin };
}

test("successful live silence consumes only read input without copying history", async (t) => {
  const { store, append, begin } = await fixture(t);
  const first = await append("1");
  await begin();
  const second = await append("2");
  await store.markLiveReadSequence(groupId, second.sequence);
  const unread = await append("3");
  const processed = await store.completeLiveConversation(groupId, { lastReadSequence: second.sequence });
  assert.deepEqual(processed.map((message) => message.messageId), [first.messageId, second.messageId]);
  const state = store.snapshot(groupId);
  assert.deepEqual(state.pendingMessages.map((message) => message.messageId), [unread.messageId]);
  assert.deepEqual(state.recentTurns, []);
  assert.equal(state.threadId, "same-persistent-workbuddy-thread");
});

test("successful live reply consumes later-read silence and retains only the panel reply and recall IDs", async (t) => {
  const { store, append, begin } = await fixture(t);
  const first = await append("1");
  await begin();
  await store.recordLiveActionSent(groupId, { kind: "message", summary: "one panel reply", observedSequence: first.sequence, messageId: "42" });
  const second = await append("2");
  await store.completeLiveConversation(groupId, { lastReadSequence: second.sequence });
  const state = store.snapshot(groupId);
  assert.deepEqual(state.pendingMessages, []);
  assert.deepEqual(state.recentTurns, []);
  assert.equal(state.lastCompletedReply.text, "one panel reply");
  assert.equal(state.sentMessages[0].messageId, "42");
  assert.equal(Object.hasOwn(state.sentMessages[0], "summary"), false);
  assert.equal(await store.markSentMessageRecalled(groupId, "42"), true);
  assert.equal(store.getSentMessage(groupId, "42"), null);
});

test("failure and restart preserve unprocessed input and delivery recovery but drop legacy transcript copies", async (t) => {
  const { store, append, begin } = await fixture(t);
  const first = await append("1");
  await begin();
  await store.markLiveReadSequence(groupId, first.sequence);
  await store.recordLiveActionSent(groupId, { kind: "message", summary: "already sent", observedSequence: first.sequence, messageId: "42" });
  await store.failWork(groupId, new Error("interrupted"));
  store.ensureGroup(groupId).recentTurns = [{ messages: [{ text: "old transcript" }], reply: "old reply" }];
  store.ensureGroup(groupId).sentMessages[0].summary = "legacy duplicate text";
  await store.save();
  const restored = new SessionStore({ filePath: store.filePath });
  await restored.init();
  const state = restored.snapshot(groupId);
  assert.equal(state.pendingMessages[0].messageId, first.messageId);
  assert.equal(state.liveSession.actions[0].summary, "already sent");
  assert.equal(state.threadId, "same-persistent-workbuddy-thread");
  assert.deepEqual(state.recentTurns, []);
  assert.equal(Object.hasOwn(state.sentMessages[0], "summary"), false);
  const serialized = await readFile(store.filePath, "utf8");
  assert.equal(serialized.includes("old transcript"), false);
  assert.equal(serialized.includes("legacy duplicate text"), false);
});

test("legacy completed and delivered batches no longer create transcript caches", async (t) => {
  const { store, append, begin } = await fixture(t);
  await append("1");
  await begin();
  await store.completeAgentWork(groupId, { reply: "first panel reply" });
  await append("2");
  await begin();
  await store.prepareDeliveryWork(groupId, { reply: "second panel reply" });
  await store.completeDeliveryWork(groupId);
  const state = store.snapshot(groupId);
  assert.deepEqual(state.pendingMessages, []);
  assert.deepEqual(state.recentTurns, []);
  assert.equal(state.lastCompletedReply.text, "second panel reply");
});
