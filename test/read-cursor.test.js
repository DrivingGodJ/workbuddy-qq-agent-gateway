import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { createLiveConversationTools, prepareLiveConversationPrompt } from "../src/qq/live-conversation.js";

async function fixture(t, targetType = "group") {
  const directory = await mkdtemp(join(tmpdir(), "qq-read-cursor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "sessions.json");
  const targetId = "12345";
  const sent = [];
  const f = { targetId, targetType, filePath, sent, active: { turnId: "cursor-turn", onDelta() {} } };
  f.restart = async () => {
    f.store = new SessionStore({ filePath });
    await f.store.init({ allowedGroups: [targetId] });
  };
  await f.restart();
  await f.store.setThread(targetId, "persistent-thread", { bootstrapComplete: true });
  f.append = async (text, extra = {}) => f.store.appendMessage({
    groupId: targetId, messageId: `m${f.store.snapshot().nextSequence}`,
    senderId: "67890", senderName: "Member", text, trust: "UNTRUSTED", ...extra
  });
  f.appendMany = async (count) => {
    for (let index = 0; index < count; index++) await f.append(`message-${f.store.snapshot().nextSequence}`);
  };
  f.context = (options = {}) => {
    const pages = [];
    const pending = f.store.snapshot(targetId).pendingMessages;
    const context = createLiveConversationTools({
      store: f.store, targetId, targetType,
      oneBot: {
        async sendGroupMessage(_id, text) { sent.push(text); return { ok: true }; },
        async sendPrivateMessage(_id, text) { sent.push(text); return { ok: true }; }
      },
      trigger: { reason: "mention", trust: "UNTRUSTED" }, triggerMessages: pending,
      security: {}, initialImageSequence: pending.at(-1)?.sequence || 0,
      renderMessages(messages) {
        pages.push(messages.map((message) => message.sequence));
        return messages.map((message) => message.text).join("\n");
      },
      ...options
    });
    return { context, pages };
  };
  f.begin = async (options = {}) => {
    const latest = f.store.snapshot(targetId).pendingMessages.at(-1);
    await f.store.requestTrigger(targetId, "mention", latest);
    assert.equal((await f.store.beginWork(targetId))?.kind, "agent");
    return f.context(options);
  };
  f.read = (context) => context.liveTool("read_messages", {}, f.active);
  f.complete = async (context, options = {}) => f.store.completeLiveConversation(targetId, {
    lastReadSequence: context.lastReadSequence, ...options
  });
  f.silentlyReadThrough = async (sequence) => {
    const { context } = await f.begin();
    while (context.lastReadSequence < sequence) assert.equal((await f.read(context)).isError, false);
    assert.equal(context.lastReadSequence, sequence);
    assert.deepEqual(await f.complete(context), []);
  };
  return f;
}

test("group and private prefetch skip committed retained pages and see a new mention after restart", async (t) => {
  for (const targetType of ["group", "private"]) {
    const f = await fixture(t, targetType);
    await f.appendMany(85);
    await f.silentlyReadThrough(85);
    assert.equal(f.store.snapshot(f.targetId).pendingMessages.length, 85);
    await f.restart();
    const newest = await f.append("newest mention", { mentionedBot: true });
    const { context, pages } = await f.begin();
    const prepared = await prepareLiveConversationPrompt(context, "current task");
    assert.deepEqual(pages, [[newest.sequence]], targetType);
    assert.match(prepared, /newest mention/);
    assert.doesNotMatch(prepared, /message-1\b|message-40\b|message-85\b/);
    assert.equal(context.lastReadSequence, 86);
    assert.equal(f.store.snapshot(f.targetId).pendingMessages.length, 86);
  }
});

test("each successful silent page advances the durable cursor without deleting pending history", async (t) => {
  const f = await fixture(t);
  await f.appendMany(85);
  for (const [first, last] of [[1, 40], [41, 80], [81, 85]]) {
    const { context, pages } = await f.begin();
    assert.equal((await f.read(context)).isError, false);
    assert.deepEqual(pages[0], Array.from({ length: last - first + 1 }, (_, index) => first + index));
    assert.deepEqual(await f.complete(context), []);
    assert.equal(f.store.snapshot(f.targetId).deferredThroughSequence, last);
    assert.equal(f.store.snapshot(f.targetId).pendingMessages.length, 85);
    await f.restart();
  }
});

test("failed and cancelled rounds replay fresh reads but not earlier successful retained pages", async (t) => {
  for (const failure of ["model", "QQ send", "cancelled", "reader", "process restart"]) {
    const f = await fixture(t);
    await f.appendMany(45);
    await f.silentlyReadThrough(45);
    await f.appendMany(45);
    const options = failure === "reader" ? { renderMessages() { throw new Error("reader failed"); } }
      : failure === "QQ send" ? { oneBot: { async sendGroupMessage() { return { ok: false, status: 503 }; } } } : {};
    const { context } = await f.begin(options);
    if (failure === "reader") await assert.rejects(() => f.read(context), /reader failed/);
    else {
      assert.equal((await f.read(context)).isError, false);
      assert.equal(context.lastReadSequence, 85);
      if (failure === "QQ send") {
        assert.equal((await context.liveTool("send_message", { text: "unsent reply" }, f.active)).isError, true);
      } else if (failure === "cancelled") {
        assert.equal((await context.liveTool("read_messages", {}, { cancelRequested: true })).isError, true);
      }
    }
    if (failure !== "process restart") await f.store.failWork(f.targetId, new Error(failure));
    assert.equal(f.store.snapshot(f.targetId).deferredThroughSequence, 45, failure);
    assert.equal(f.store.snapshot(f.targetId).pendingMessages.length, 90, failure);
    await f.restart();
    const retry = await f.begin();
    assert.equal((await f.read(retry.context)).isError, false);
    assert.deepEqual(retry.pages[0], Array.from({ length: 40 }, (_, index) => 46 + index), failure);
    assert.equal(retry.context.lastReadSequence, 85, failure);
  }
});

test("partial send consumes only its confirmed cutoff and commits later silent reads for next pagination", async (t) => {
  const f = await fixture(t);
  await f.appendMany(45);
  await f.silentlyReadThrough(45);
  await f.appendMany(40);
  const { context } = await f.begin();
  await f.read(context);
  assert.equal(context.lastReadSequence, 85);
  assert.equal((await context.liveTool("send_message", { text: "confirmed reply" }, f.active)).isError, false);
  await f.appendMany(45);
  await f.read(context);
  assert.equal(context.lastReadSequence, 125);
  const processed = await f.complete(context);
  assert.equal(processed.length, 85);
  assert.deepEqual(f.store.snapshot(f.targetId).pendingMessages.map((message) => message.sequence),
    Array.from({ length: 45 }, (_, index) => 86 + index));
  assert.equal(f.store.snapshot(f.targetId).deferredThroughSequence, 125);
  await f.restart();
  const next = await f.begin();
  await f.read(next.context);
  assert.deepEqual(next.pages[0], [126, 127, 128, 129, 130]);
  assert.deepEqual(f.sent, ["confirmed reply"]);
});

test("same-thread resume preserves read and periodic cursors while replacing the thread resets both", async (t) => {
  const f = await fixture(t);
  await f.appendMany(45);
  await f.silentlyReadThrough(45);
  await f.append("not checked yet");
  await f.store.requestPeriodicTrigger(f.targetId);
  assert.equal(f.store.snapshot(f.targetId).periodicCheckedThroughSequence, 46);
  await f.store.setThread(f.targetId, "persistent-thread", { bootstrapComplete: true });
  assert.equal(f.store.snapshot(f.targetId).deferredThroughSequence, 45);
  assert.equal(f.store.snapshot(f.targetId).periodicCheckedThroughSequence, 46);
  await f.store.setThread(f.targetId, "replacement-thread");
  assert.equal(f.store.snapshot(f.targetId).deferredThroughSequence, 0);
  assert.equal(f.store.snapshot(f.targetId).periodicCheckedThroughSequence, 0);
  const { context, pages } = await f.begin();
  await f.read(context);
  assert.equal(pages[0][0], 1);
  assert.equal(context.lastReadSequence, 40);
});

test("standalone scheduled tasks can read pending without borrowing or changing the chat cursor", async (t) => {
  const f = await fixture(t);
  await f.appendMany(45);
  await f.silentlyReadThrough(45);
  await f.append("fresh chat message");
  const before = f.store.snapshot(f.targetId);
  const { context, pages } = f.context({ scheduledTask: true });
  assert.equal(context.lastReadSequence, 0);
  await f.read(context);
  assert.deepEqual(pages[0], Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal((await context.liveTool("send_message", { text: "scheduled message" }, f.active)).isError, false);
  assert.equal((await context.liveTool("end_conversation", {}, f.active)).isError, false);
  const after = f.store.snapshot(f.targetId);
  assert.deepEqual(after.pendingMessages, before.pendingMessages);
  assert.equal(after.deferredThroughSequence, before.deferredThroughSequence);
  assert.equal(after.periodicCheckedThroughSequence, before.periodicCheckedThroughSequence);
  assert.equal(after.liveSession, null);
  const ordinary = await f.begin();
  await f.read(ordinary.context);
  assert.deepEqual(ordinary.pages[0], [46]);
});

test("a fresh image boundary remains unread across a completed page and is delivered next visual round", async (t) => {
  const f = await fixture(t);
  await f.appendMany(45);
  await f.silentlyReadThrough(45);
  await f.append("text before visual boundary");
  const { context, pages } = await f.begin();
  const image = await f.append("new image", { images: [{ localPath: "/tmp/qq-cursor-fixture.png", mimeType: "image/png" }] });
  const tail = await f.append("text after image");
  const result = await f.read(context);
  assert.equal(result.isError, false);
  assert.deepEqual(pages[0], [46]);
  assert.equal(context.deferredNewMedia, true);
  assert.equal(context.lastReadSequence, 46);
  await f.complete(context);
  await f.restart();
  const next = await f.begin();
  await f.read(next.context);
  assert.deepEqual(next.pages[0], [image.sequence, tail.sequence]);
  assert.equal(next.context.deferredNewMedia, false);
});
