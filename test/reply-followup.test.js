import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { SessionStore, REPLY_FOLLOWUP_MS } from "../src/storage/session-store.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { GroupWorker } from "../src/groups/group-worker.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";
import { privateSandbox } from "../src/security/subscription-policy.js";
import { toPublicGroupState } from "../src/groups/group-state.js";
import { AgentTaskGate } from "../src/qq/agent-task-gate.js";
import { ConversationFollowup } from "../src/qq/conversation-followup.js";

async function fixture(t, targetType = "group", targetId = "12345") {
  const directory = await mkdtemp(join(tmpdir(), "crc-followup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T08:00:00.000Z");
  const clock = () => now;
  const filePath = join(directory, "sessions.json");
  const store = new SessionStore({ filePath, clock });
  await store.init({ allowedGroups: [targetId, "54321"] });
  const append = (id, extra = {}) => store.appendMessage({
    groupId: targetId, messageId: id, senderId: targetType === "private" ? targetId : "67890", senderName: "同学",
    text: id, trust: "UNTRUSTED", ...extra
  });
  const sent = [];
  const oneBot = {
    async sendGroupMessage(_id, text) { sent.push(text); return { ok: true }; },
    async sendPrivateMessage(_id, text) { sent.push(text); return { ok: true }; }
  };
  const active = { turnId: "test-turn", onDelta() {} };
  const context = (work) => createLiveConversationTools({
    store, targetId, targetType, oneBot,
    trigger: work.trigger, triggerMessages: work.messages,
    security: { allowQqFiles: true }, initialImageSequence: work.messages.at(-1)?.sequence || 0,
    renderMessages: (messages) => messages.map((message) => message.text).join("\n")
  });
  const first = await append("first", { mentionedBot: true });
  await store.requestTrigger(targetId, "mention", { ...first, trust: "OWNER" });
  return {
    store, append, sent, active, context, clock, filePath, targetId,
    advance(ms) { now = new Date(now.getTime() + ms); }
  };
}

async function endRound(f, work, { send = false } = {}) {
  const ctx = f.context(work);
  await ctx.liveTool("read_messages", {}, f.active);
  if (send) await ctx.liveTool("send_message", { text: "本轮回复" }, f.active);
  const ended = await ctx.liveTool("end_conversation", {}, f.active);
  assert.equal(ended.isError, false);
  await f.store.completeLiveConversation("12345", { lastReadSequence: ctx.lastReadSequence, trigger: work.trigger });
  return ctx;
}

test("every explicit end renews two minutes of observation without waking old pending", async (t) => {
  const f = await fixture(t);
  const manager = new TriggerManager({ store: f.store, clock: f.clock });
  const kicks = [];
  manager.setWorker({ async kick(id) { kicks.push(id); } });
  await endRound(f, await f.store.beginWork("12345"));
  const firstWindow = f.store.snapshot("12345").replyFollowup;
  assert.equal(Date.parse(firstWindow.expiresAt) - Date.parse(firstWindow.startedAt), REPLY_FOLLOWUP_MS);
  assert.equal(await manager.reconsiderPending("12345"), null);
  assert.equal(await f.store.beginWork("12345"), null);
  f.advance(119_999);
  const fresh = await f.append("new ordinary message");
  assert.equal(fresh.followupWake, true);
  assert.equal(f.store.snapshot("12345").pendingTrigger.trust, "UNTRUSTED");
  await manager.considerMessage(fresh);
  await pause(0);
  assert.deepEqual(kicks, ["12345"]);
  const next = await f.store.beginWork("12345");
  assert.equal(next.trigger.reason, "followup");
  assert.equal(f.store.snapshot("12345").replyFollowup, null);
  await endRound(f, next);
  const renewed = f.store.snapshot("12345").replyFollowup;
  assert.equal(Date.parse(renewed.expiresAt) - Date.parse(firstWindow.expiresAt), 119_999);
  f.advance(119_999);
  const again = await f.append("second activation");
  assert.equal(again.followupWake, true);
  await endRound(f, await f.store.beginWork("12345"));
  f.advance(120_000);
  await manager.checkPeriodic();
  assert.equal(f.store.snapshot("12345").replyFollowup, null);
  assert.equal(f.store.snapshot("12345").pendingTrigger, null);
  assert.equal(await f.store.beginWork("12345"), null);
  assert.deepEqual(f.sent, []);
});

test("arrival at the exact quiet-window deadline does not trigger a followup", async (t) => {
  const f = await fixture(t);
  await endRound(f, await f.store.beginWork("12345"));
  f.advance(REPLY_FOLLOWUP_MS);
  const fresh = await f.append("after quiet deadline");
  assert.equal(fresh.followupWake, false);
  assert.equal(f.store.snapshot("12345").replyFollowup, null);
  assert.equal(f.store.snapshot("12345").pendingTrigger, null);
  assert.deepEqual(f.store.snapshot("12345").pendingMessages.map((message) => message.text), ["after quiet deadline"]);
});

test("a burst arriving before the old model exits queues one serial round and survives cleanup", async (t) => {
  const f = await fixture(t);
  const work = await f.store.beginWork("12345");
  const ctx = f.context(work);
  await ctx.liveTool("read_messages", {}, f.active);
  await ctx.liveTool("send_message", { text: "回复最初消息" }, f.active);
  await ctx.liveTool("end_conversation", {}, f.active);
  const arrivals = [];
  for (let i = 0; i < 5; i++) arrivals.push(await f.append(`burst-${i}`));
  assert.deepEqual(arrivals.map((message) => message.followupWake), [true, false, false, false, false]);
  assert.equal(await f.store.beginWork("12345"), null);
  const removed = await f.store.completeLiveConversation("12345", { lastReadSequence: ctx.lastReadSequence });
  assert.deepEqual(removed.map((message) => message.messageId), ["first"]);
  const next = await f.store.beginWork("12345");
  assert.equal(next.trigger.reason, "followup");
  assert.deepEqual(next.messages.map((message) => message.messageId), arrivals.map((message) => message.messageId));
});

test("a late mention upgrade of an active followup cannot swallow the next visual round", async (t) => {
  for (const targetType of ["group", "private"]) {
    const f = await fixture(t, targetType);
    await endRound(f, await f.store.beginWork("12345"), { send: true });
    const mention = await f.append("wake", { mentionedBot: true });
    const work = await f.store.beginWork("12345");
    assert.equal(work.trigger.reason, "followup");
    const ctx = f.context(work);
    await ctx.liveTool("read_messages", {}, f.active);
    await ctx.liveTool("send_message", { text: "回复这次唤醒" }, f.active);
    // Intake resumes after the worker already began the same message's turn.
    await new TriggerManager({ store: f.store }).considerMessage(mention);
    assert.equal(f.store.snapshot("12345").pendingTrigger, null, targetType);
    await f.append("new image", { images: [{ localPath: "/tmp/followup-race.png" }] });
    await f.append("new text");
    await ctx.liveTool("wait_for_messages", { seconds: 1 }, f.active);
    assert.equal(ctx.deferredNewMedia, true);
    await ctx.liveTool("end_conversation", {}, f.active);
    const followup = new ConversationFollowup({ store: f.store, canRun: () => true, blocked: () => false });
    await followup.arm("12345", ctx);
    await f.store.completeLiveConversation("12345", { lastReadSequence: ctx.lastReadSequence, trigger: work.trigger });
    const next = await f.store.beginWork("12345");
    assert.equal(next?.trigger.reason, "followup", targetType);
    assert.deepEqual(next.messages.map((message) => message.messageId), ["new image", "new text"]);
  }
});

test("a newer mention already read in this turn cannot displace an unread followup", async (t) => {
  const f = await fixture(t);
  const work = await f.store.beginWork("12345");
  const ctx = f.context(work);
  await ctx.liveTool("read_messages", {}, f.active);
  const mention = await f.append("new mention", { mentionedBot: true });
  await f.store.requestTrigger("12345", "mention", mention);
  assert.equal(f.store.snapshot("12345").pendingTrigger.messageId, "new mention");
  await ctx.liveTool("read_messages", {}, f.active);
  await ctx.liveTool("send_message", { text: "已经回复新提问" }, f.active);
  await f.append("still unread");
  const followup = new ConversationFollowup({ store: f.store, canRun: () => true, blocked: () => false });
  await followup.arm("12345", ctx);
  await f.store.completeLiveConversation("12345", { lastReadSequence: ctx.lastReadSequence, trigger: work.trigger });
  const next = await f.store.beginWork("12345");
  assert.equal(next?.trigger.reason, "followup");
  assert.deepEqual(next.messages.map((message) => message.messageId), ["still unread"]);
});

test("followup status only shows waiting for a real observation window", async (t) => {
  const f = await fixture(t);
  const work = await f.store.beginWork("12345");
  const ctx = f.context(work);
  await ctx.liveTool("read_messages", {}, f.active);
  let view;
  const followup = new ConversationFollowup({ store: f.store, canRun: () => true, blocked: () => false,
    setLive: (_id, patch) => { view = patch; } });
  followup.publishWaiting("12345");
  assert.equal(view.status, "completed");
  assert.equal(view.waitUntil, null);
  await followup.arm("12345", ctx);
  followup.publishWaiting("12345");
  assert.equal(view.status, "waiting");
  assert.ok(view.waitUntil);
  await f.append("queued followup");
  followup.publishWaiting("12345");
  assert.equal(view.status, "queued");
  assert.equal(view.waitUntil, null);
});

test("scope, received time and wake flags come from the gateway rather than incoming data", async (t) => {
  const f = await fixture(t);
  await endRound(f, await f.store.beginWork("12345"));
  const other = await f.append("different target", { groupId: "54321", followupWake: true });
  assert.equal(other.followupWake, false);
  assert.equal(f.store.snapshot("12345").pendingTrigger, null);
  const same = await f.append("same target", { receivedAt: "1990-01-01", followupWake: false });
  assert.equal(same.followupWake, true);
  assert.equal(same.receivedAt, f.clock().toISOString());
  assert.equal(Object.hasOwn(f.store.snapshot("12345").pendingMessages.at(-1), "followupWake"), false);
  const idle = await f.append("no observation", { groupId: "54321", followupWake: true });
  assert.equal(idle.followupWake, false);
});

test("normal explicit mentions override followup metadata and subscription tasks retain priority", async (t) => {
  const f = await fixture(t);
  await endRound(f, await f.store.beginWork("12345"));
  const mentioned = await f.append("@老代", { mentionedBot: true });
  const manager = new TriggerManager({ store: f.store });
  await manager.considerMessage(mentioned);
  assert.equal(f.store.snapshot("12345").pendingTrigger.reason, "mention");
  await endRound(f, await f.store.beginWork("12345"));
  await f.store.requestTrigger("12345", "subscription_auto");
  const ordinary = await f.append("ordinary");
  assert.equal(ordinary.followupWake, true);
  assert.equal(f.store.snapshot("12345").pendingTrigger.reason, "subscription_auto");
});

test("an old OWNER mention is not retriggered as authorization for a fresh member followup", async (t) => {
  const f = await fixture(t);
  const work = await f.store.beginWork("12345");
  const ctx = f.context(work);
  await ctx.liveTool("read_messages", {}, f.active);
  await ctx.liveTool("end_conversation", {}, f.active);
  const fresh = await f.append("new member");
  await f.store.completeLiveConversation("12345", { lastReadSequence: ctx.lastReadSequence });
  const manager = new TriggerManager({ store: f.store });
  assert.equal(await manager.reconsiderPending("12345"), null);
  assert.equal(f.store.snapshot("12345").pendingTrigger.sequence, fresh.sequence);
  assert.equal(f.store.snapshot("12345").pendingTrigger.reason, "followup");
  assert.equal(f.store.snapshot("12345").pendingTrigger.trust, "UNTRUSTED");
});

test("failed turns, disabled replies and thread resets cancel the observation window", async (t) => {
  for (const operation of ["failure", "disable", "reset"]) {
    const f = await fixture(t);
    const ctx = f.context(await f.store.beginWork("12345"));
    await ctx.liveTool("read_messages", {}, f.active);
    await ctx.liveTool("end_conversation", {}, f.active);
    if (operation === "failure") await f.store.failWork("12345", new Error("model failed"));
    if (operation === "disable") await f.store.setReplyEnabled("12345", false);
    if (operation === "reset") await f.store.setThread("12345", "replacement-thread");
    assert.equal(f.store.snapshot("12345").replyFollowup, null, operation);
    assert.equal((await f.append("new text")).followupWake, false, operation);
  }
});

test("observation and queued followup survive restart, while expired observation is dropped", async (t) => {
  const f = await fixture(t);
  await endRound(f, await f.store.beginWork("12345"));
  const restarted = new SessionStore({ filePath: f.filePath, clock: f.clock });
  await restarted.init();
  assert.ok(restarted.snapshot("12345").replyFollowup);
  assert.equal(restarted.snapshot("12345").pendingTrigger, null);
  await restarted.appendMessage({ groupId: "12345", messageId: "queued", text: "new" });
  const again = new SessionStore({ filePath: f.filePath, clock: f.clock });
  await again.init();
  assert.equal(again.snapshot("12345").pendingTrigger.reason, "followup");
  assert.equal((await again.beginWork("12345")).messages.at(-1).messageId, "queued");
  await again.failWork("12345", new Error("test stop"));
  await f.store.save();
  f.advance(REPLY_FOLLOWUP_MS);
  const expired = new SessionStore({ filePath: f.filePath, clock: f.clock });
  await expired.init();
  assert.equal(expired.snapshot("12345").replyFollowup, null);
  assert.equal(expired.snapshot("12345").pendingTrigger, null);
});

test("private conversations use the same repeatable observation lifecycle", async (t) => {
  const f = await fixture(t, "private");
  await endRound(f, await f.store.beginWork("12345"), { send: true });
  assert.equal((await f.append("private followup")).followupWake, true);
  await endRound(f, await f.store.beginWork("12345"));
  assert.ok(f.store.snapshot("12345").replyFollowup);
  assert.deepEqual(f.sent, ["本轮回复"]);
});

test("an orphaned trigger without pending messages is retired instead of spinning a worker", async (t) => {
  const f = await fixture(t, "private");
  await f.store.beginWork(f.targetId);
  await f.store.completeAgentWork(f.targetId, { reply: "", turnId: "done", trigger: { reason: "mention" }, messages: [] });
  await f.store.requestTrigger(f.targetId, "mention", { messageId: "missing", sequence: 1, senderId: f.targetId, trust: "UNTRUSTED" });
  assert.equal(f.store.snapshot(f.targetId).pendingMessages.length, 0);
  assert.equal(await f.store.beginWork(f.targetId), null);
  assert.equal(f.store.snapshot(f.targetId).pendingTrigger, null);
});

test("real group and private workers queue followups behind the active turn and master switch", async (t) => {
  for (const Worker of [GroupWorker, PrivateWorker]) {
    const f = await fixture(t, Worker === PrivateWorker ? "private" : "group", OWNER_QQ_ID);
    const id = f.targetId;
    await f.store.setCodexConfig(id, { workingMode: "agent", permissionMode: "dangerFullAccess" });
    const manager = new TriggerManager({ store: f.store, clock: f.clock });
    let dispatch = true;
    let concurrent = 0;
    let maximumConcurrent = 0;
    let runs = 0;
    const codex = {
      supportsQqMcp: true,
      async startThread() { return "worker-thread"; },
      async resumeThread() {},
      async runTurn({ qqToolContext }) {
        const round = ++runs;
        maximumConcurrent = Math.max(maximumConcurrent, ++concurrent);
        assert.equal((await qqToolContext.liveTool("read_messages", {}, f.active)).isError, false);
        assert.equal((await qqToolContext.liveTool("end_conversation", {}, f.active)).isError, false);
        if (round === 1) {
          dispatch = false;
          await manager.considerMessage(await f.append("while previous model finishes"));
          assert.equal(concurrent, 1);
          assert.equal(f.store.snapshot(id).pendingTrigger.reason, "followup");
        }
        concurrent--;
        return { text: "", turnId: `worker-${round}`, compacted: false };
      }
    };
    const worker = new Worker({
      followupDurationMs: 1,
      store: f.store, codex, oneBot: {}, mediaManager: { async removeMessages() {} },
      triggerManager: manager, canRun: () => dispatch,
      sharedWorkspaceRoot: join(dirname(f.filePath), "shared")
    });
    manager.setWorker(worker);
    await worker.kick(id);
    assert.equal(f.store.snapshot(id).lastError, null, Worker.name);
    assert.equal(runs, 1, Worker.name);
    assert.equal(f.store.snapshot(id).pendingTrigger.reason, "followup");
    assert.deepEqual(f.store.snapshot(id).pendingMessages.map((message) => message.text), ["while previous model finishes"]);
    dispatch = true;
    await worker.kick(id);
    assert.equal(runs, 2, Worker.name);
    assert.equal(maximumConcurrent, 1, Worker.name);
    assert.equal(f.store.snapshot(id).lastError, null, Worker.name);
    assert.equal(f.store.snapshot(id).replyFollowup, null, Worker.name);
    assert.equal(f.store.snapshot(id).pendingTrigger, null);
  }
});

test("private followup permission is scoped to the actual OWNER target, never source notification tasks", () => {
  assert.equal(privateSandbox(OWNER_QQ_ID, { reason: "followup" }).turnSandbox.type, "dangerFullAccess");
  assert.equal(privateSandbox("67890", { reason: "followup", trust: "OWNER" }).turnSandbox.type, "readOnly");
  assert.equal(privateSandbox(OWNER_QQ_ID, { reason: "subscription_auto", trust: "OWNER" }).turnSandbox.type, "readOnly");
});

test("non-owner private Agent turns use scoped QQ MCP without embedding all stickers", async (t) => {
  const f = await fixture(t, "private", "12345");
  await f.store.setCodexConfig(f.targetId, { workingMode: "agent", permissionMode: "dangerFullAccess" });
  const stickerId = "st_abcdef123456";
  let seenPrompt = "";
  const codex = {
    supportsQqMcp: true,
    supportsSystemPrompt: true,
    async startThread() { return "private-read-only-thread"; },
    async runTurn({ prompt, turnSandbox, qqToolContext }) {
      seenPrompt = prompt;
      assert.equal(turnSandbox.type, "readOnly");
      assert.equal(qqToolContext.liveMode, true);
      assert.equal(qqToolContext.allowImages, false);
      assert.equal((await qqToolContext.liveTool("read_messages", {}, f.active)).isError, false);
      const reactions = await qqToolContext.liveTool("list_reactions", {}, f.active);
      assert.equal(reactions.isError, false);
      assert.match(reactions.content[0].text, new RegExp(stickerId));
      assert.equal((await qqToolContext.liveTool("end_conversation", {}, f.active)).isError, false);
      return { text: "", turnId: "private-read-only-turn", compacted: false };
    }
  };
  const worker = new PrivateWorker({
    store: f.store, codex, oneBot: {},
    mediaManager: { async removeMessages() {} },
    stickerManager: { promptCatalog: () => [{ id: stickerId, usage: "适合觉得好笑时使用" }] },
    triggerManager: new TriggerManager({ store: f.store, clock: f.clock })
  });
  await worker.runAgent(f.targetId, await f.store.beginWork(f.targetId));
  assert.match(seenPrompt, /网关预读取结果|本轮权限/);
  assert.doesNotMatch(seenPrompt, new RegExp(stickerId));
  assert.doesNotMatch(seenPrompt, /当前可用 QQ 原生表情包/);
  assert.equal(f.store.snapshot(f.targetId).lastError, null);
});

test("active wait wakes directly on new text rather than waiting out thirty seconds", async (t) => {
  const f = await fixture(t);
  const ctx = f.context(await f.store.beginWork("12345"));
  await ctx.liveTool("read_messages", {}, f.active);
  const waited = ctx.liveTool("wait_for_messages", { seconds: 30 }, f.active);
  assert.equal(f.store.messageEvents.listenerCount("12345"), 1);
  await f.append("arrived while waiting");
  const result = await Promise.race([waited, pause(150).then(() => "timeout")]);
  assert.notEqual(result, "timeout");
  assert.match(result.content[0].text, /arrived while waiting/);
  assert.equal(f.store.messageEvents.listenerCount("12345"), 0);
  assert.equal(ctx.lastReadSequence, 2);
});

test("waiting is target-scoped and listeners are cleaned on timeout, cancel and reply disable", async (t) => {
  const f = await fixture(t);
  let woke = false;
  const waiting = f.store.waitForNewMessages("12345", { afterSequence: 1, timeoutMs: 35 }).then(() => { woke = true; });
  // Emit synchronously: slow CI disk I/O must not exhaust the 35 ms timeout
  // before this assertion, which checks channel isolation rather than speed.
  f.store.messageEvents.emit("54321");
  assert.equal(woke, false);
  await waiting;
  assert.equal(f.store.messageEvents.listenerCount("12345"), 0);
  let cancelled = false;
  const cancellation = f.store.waitForNewMessages("12345", { afterSequence: 1, timeoutMs: 30_000, shouldStop: () => cancelled });
  cancelled = true;
  await Promise.race([cancellation, pause(250).then(() => assert.fail("cancellation did not wake wait"))]);
  assert.equal(f.store.messageEvents.listenerCount("12345"), 0);
  const disabled = f.store.waitForNewMessages("12345", {
    afterSequence: 1, timeoutMs: 30_000, shouldStop: () => f.store.snapshot("12345").replyEnabled === false
  });
  await f.store.setReplyEnabled("12345", false);
  await disabled;
  assert.equal(f.store.messageEvents.listenerCount("12345"), 0);
  await f.append("already waiting");
  await f.store.waitForNewMessages("12345", { afterSequence: 1, timeoutMs: 30_000 });
  assert.equal(f.store.messageEvents.listenerCount("12345"), 0);
});

test("an image arriving during active wait queues a fresh visual round when the Agent ends", async (t) => {
  const f = await fixture(t);
  const ctx = f.context(await f.store.beginWork("12345"));
  await ctx.liveTool("read_messages", {}, f.active);
  const waited = ctx.liveTool("wait_for_messages", { seconds: 30 }, f.active);
  await f.append("new visual", { images: [{ localPath: "/tmp/test-new-image.png" }] });
  const result = await waited;
  assert.match(result.content[0].text, /留给下一轮/);
  assert.equal(ctx.deferredNewMedia, true);
  assert.equal(ctx.lastReadSequence, 1);
  await ctx.liveTool("end_conversation", {}, f.active);
  assert.equal(f.store.snapshot("12345").pendingTrigger.reason, "followup");
  assert.deepEqual((await f.store.completeLiveConversation("12345", { lastReadSequence: ctx.lastReadSequence })).map((message) => message.messageId), ["first"]);
  const next = await f.store.beginWork("12345");
  const visualContext = f.context(next);
  const read = await visualContext.liveTool("read_messages", {}, f.active);
  assert.match(read.content[0].text, /new visual/);
  assert.equal(visualContext.lastReadSequence, 2);
  assert.equal(f.store.referencedImages()[0].localPath, "/tmp/test-new-image.png");
});

async function eventually(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(5);
  }
  assert.fail("expected worker transition did not occur");
}

async function automaticWorker(t, Worker, options = {}) {
  const f = await fixture(t, Worker === PrivateWorker ? "private" : "group", OWNER_QQ_ID);
  const id = f.targetId;
  await f.store.setCodexConfig(id, { workingMode: "agent", permissionMode: "dangerFullAccess" });
  const manager = new TriggerManager({ store: f.store, clock: f.clock });
  let runs = 0;
  const oneBot = options.oneBot || {
    async sendGroupMessage() { return { ok: true }; },
    async sendPrivateMessage() { return { ok: true }; }
  };
  const codex = {
    supportsQqMcp: true,
    async startThread() { return "auto-worker-thread"; },
    async resumeThread() {},
    async interruptGroup() { return false; },
    async runTurn({ qqToolContext }) {
      const round = ++runs;
      await qqToolContext.liveTool("read_messages", {}, f.active);
      // Deliberately no end_conversation: normal model completion must suffice.
      if (options.duringTurn) await options.duringTurn(f, round, qqToolContext);
      return { text: "", turnId: `auto-${round}`, compacted: false };
    }
  };
  const worker = new Worker({ store: f.store, codex, oneBot, triggerManager: manager,
    mediaManager: { async removeMessages() {} }, sharedWorkspaceRoot: join(dirname(f.filePath), "shared"),
    taskGate: options.taskGate, canRun: options.canRun || (() => true) });
  manager.setWorker(worker);
  const view = () => toPublicGroupState(f.store.snapshot(id), worker.publicLiveState()[id]);
  return { ...f, id, manager, worker, view, runs: () => runs };
}

test("program automatically keeps group and private workers running and repeatedly reconnects without an AI end tool", async (t) => {
  for (const Worker of [GroupWorker, PrivateWorker]) {
    const f = await automaticWorker(t, Worker);
    let finished = false;
    const running = f.worker.kick(f.id).then(() => { finished = true; });
    await eventually(() => f.view().activeReply.waiting);
    assert.equal(f.view().activeReply.running, true);
    assert.equal(f.view().busy, true);
    assert.equal(f.worker.running.has(f.id), true);
    assert.equal(finished, false);
    assert.equal(f.runs(), 1);
    const firstExpiry = Date.parse(f.view().activeReply.waitUntil);
    assert.equal(firstExpiry - f.clock().getTime(), 120_000);
    await pause(20);
    assert.equal(f.runs(), 1, "quiet observation must not call the model");
    f.advance(60_000);
    await f.manager.considerMessage(await f.append("new message without @"));
    await eventually(() => f.runs() === 2 && f.view().activeReply.waiting);
    assert.equal(finished, false);
    assert.equal(Date.parse(f.view().activeReply.waitUntil), firstExpiry + 60_000);
    f.advance(119_999);
    await f.manager.considerMessage(await f.append("another followup"));
    await eventually(() => f.runs() === 3 && f.view().activeReply.waiting);
    assert.equal(finished, false);
    f.advance(120_000);
    await f.store.expireReplyFollowups();
    await running;
    assert.equal(finished, true);
    assert.equal(f.worker.running.has(f.id), false);
    assert.equal(f.view().activeReply.running, false);
    assert.equal(f.view().activeReply.status, "completed");
    assert.equal(f.runs(), 3);
  }
});

test("late unmentioned messages received before model completion immediately get another program-controlled round", async (t) => {
  const f = await automaticWorker(t, GroupWorker, { duringTurn: async (f, round) => {
    if (round === 1) await f.append("arrived while model finished");
  } });
  const run = f.worker.kick(f.id);
  await eventually(() => f.runs() === 2 && f.view().activeReply.waiting);
  assert.equal(f.store.snapshot(f.id).pendingMessages.length, 0);
  await f.worker.cancel(f.id);
  await run;
  assert.equal(f.view().activeReply.status, "cancelled");
  assert.equal(f.view().activeReply.running, false);
});

test("cancel button, master pause and per-conversation pause end the real observation without another AI call", async (t) => {
  for (const kind of ["cancel", "master", "reply"]) {
    let enabled = true;
    const f = await automaticWorker(t, GroupWorker, { canRun: () => enabled });
    const run = f.worker.kick(f.id);
    await eventually(() => f.view().activeReply.waiting);
    if (kind === "cancel") assert.equal(await f.worker.cancel(f.id), true);
    if (kind === "master") enabled = false;
    if (kind === "reply") await f.store.setReplyEnabled(f.id, false);
    await run;
    assert.equal(f.runs(), 1);
    assert.equal(f.view().activeReply.running, false);
    assert.equal(f.store.snapshot(f.id).replyFollowup, null);
    assert.equal(f.store.snapshot(f.id).pendingMessages.length, 0);
    assert.equal(f.store.messageEvents.listenerCount(f.id), 0);
  }
});

test("maintenance can drain the observation lease and resume it without a model request", async (t) => {
  const gate = new AgentTaskGate();
  const f = await automaticWorker(t, GroupWorker, { taskGate: gate });
  const run = f.worker.kick(f.id);
  await eventually(() => f.view().activeReply.waiting);
  assert.equal(gate.active, 1);
  let releaseMaintenance;
  let maintenanceStarted = false;
  const hold = new Promise((resolve) => { releaseMaintenance = resolve; });
  const maintenance = gate.exclusive(async () => { maintenanceStarted = true; await hold; });
  await eventually(() => maintenanceStarted);
  await run;
  assert.equal(f.view().activeReply.status, "queued");
  assert.equal(gate.active, 0);
  releaseMaintenance();
  await maintenance;
  await eventually(() => f.worker.running.has(f.id) && f.view().activeReply.waiting);
  assert.equal(f.runs(), 1);
  const resumed = f.worker.running.get(f.id);
  await f.worker.cancel(f.id);
  await resumed;
  assert.equal(gate.active, 0);
});

test("normal model completion cannot turn a failed QQ action into a successful observation", async (t) => {
  const f = await automaticWorker(t, GroupWorker, {
    oneBot: { async sendGroupMessage() { return { ok: false, status: 503 }; } },
    duringTurn: async (f, _round, context) => {
      assert.equal((await context.liveTool("send_message", { text: "失败消息" }, f.active)).isError, true);
    }
  });
  await f.worker.kick(f.id);
  assert.match(f.store.snapshot(f.id).lastError, /QQ 操作失败/);
  assert.equal(f.view().activeReply.running, false);
  assert.equal(f.store.snapshot(f.id).replyFollowup, null);
  assert.equal(f.store.snapshot(f.id).pendingMessages.length, 1);
});
