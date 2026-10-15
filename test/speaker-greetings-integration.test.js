import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { SessionStore } from "../src/storage/session-store.js";
import { GroupWorker } from "../src/groups/group-worker.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { AgentTaskGate } from "../src/qq/agent-task-gate.js";
import { SpeakerGreetingCoordinator } from "../src/qq/speaker-greeting-coordinator.js";
import { prepareLiveConversationPrompt } from "../src/qq/live-conversation.js";
import { OWNER_QQ_ID, THREAD_INSTRUCTIONS_REVISION } from "../src/security/policy.js";

const speakerId = "notify.xiaomi_test_l05c_play_text_a_5_3";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function eventually(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await pause(5); }
  assert.fail("expected queued worker progress did not arrive");
}

async function fixture(t, type, callbacks = {}) {
  const directory = await mkdtemp(join(tmpdir(), "crc-speaker-integration-"));
  const id = type === "private" ? OWNER_QQ_ID : "123456";
  const store = new SessionStore({ filePath: join(directory, "sessions.json") });
  await store.init({ allowedGroups: [id] });
  await store.setCodexConfig(id, { permissionMode: "workspaceWrite", homeAssistantPermission: "owner",
    speakerGreetings: { morning: true, noon: true, night: true } });
  await store.setThread(id, `persistent-${type}`, { bootstrapComplete: true, bootstrapRevision: THREAD_INSTRUCTIONS_REVISION });
  const f = { id, store, type, frames: [], spoken: [], sent: [], starts: 0, resumes: [], enabled: true,
    now: new Date("2026-10-14T07:00:00+08:00"), onTurn: null, beforeSpeak: null, gate: new AgentTaskGate() };
  const homeAssistant = { enabled: true, allowedSpeakers: new Set([speakerId]),
    async read() { return { devices: [{ entity_id: speakerId, speaker: { tool: "speak_home_speaker" } }] }; },
    async speak(args, { beforeSend }) {
      await f.beforeSpeak?.(); await beforeSend(); f.spoken.push(args.text);
      return { accepted: true, entity_id: speakerId };
    } };
  const codex = { supportsQqMcp: true, supportsSystemPrompt: true,
    async startThread() { f.starts++; return `unexpected-new-thread-${f.starts}`; },
    async resumeThread(threadId) { f.resumes.push(threadId); },
    async interruptGroup() { return false; },
    async runTurn(options) {
      const context = options.qqToolContext;
      const kind = context?.scheduledSpeakerGreeting ? "greeting" : options.prompt.includes("SPACE_ONLY") ? "space" : "chat";
      const active = { cancelRequested: false, onDelta() {} };
      const frame = { kind, options, active, pendingBefore: store.snapshot(id).pendingMessages.map((item) => item.messageId) };
      f.frames.push(frame);
      if (kind === "chat") assert.equal((await context.liveTool("read_messages", {}, active)).isError, false);
      frame.preparedPrompt = await prepareLiveConversationPrompt(context, options.prompt);
      await f.onTurn?.(frame);
      if (kind === "greeting") {
        const args = { request_message_id: context.greetingJobId, entity_id: speakerId };
        frame.readResult = await context.liveTool("read_home_devices", args, active);
        if (!frame.readResult.isError) frame.speechResult = await context.liveTool("speak_home_speaker", { ...args, text: `hello ${context.greetingJobId}` }, active);
      } else if (kind === "chat") {
        assert.equal((await context.liveTool("send_message", { text: "chat reply" }, active)).isError, false);
        await context.liveTool("end_conversation", {}, active);
      }
      frame.pendingAfter = store.snapshot(id).pendingMessages.map((item) => item.messageId);
      return { text: "", turnId: `turn-${f.frames.length}` };
    } };
  const send = async (_id, text) => { f.sent.push(text); return { ok: true, body: { data: { message_id: String(900 + f.sent.length) } } }; };
  const Worker = type === "private" ? PrivateWorker : GroupWorker;
  f.worker = new Worker({ store, codex, homeAssistant, taskGate: f.gate, canRun: () => f.enabled,
    oneBot: { sendGroupMessage: send, sendPrivateMessage: send },
    triggerManager: { async reconsiderPending() {} }, mediaManager: { async removeMessages() {} }, followupDurationMs: 1 });
  f.coordinator = new SpeakerGreetingCoordinator({ filePath: join(directory, "greetings.json"), homeAssistant,
    listTargets: [{ type, id, store, worker: f.worker }], canRun: () => f.enabled, clock: () => f.now, ...callbacks });
  await f.coordinator.init();
  t.after(async () => {
    f.coordinator.stop();
    f.enabled = false;
    await f.coordinator.drain();
    await Promise.allSettled([...f.worker.running.values(), ...f.worker.queuedChat.values(), ...f.worker.waitingChat.values()]);
    await store.saveChain;
    await rm(directory, { recursive: true, force: true });
  });
  f.append = (messageId, text) => store.appendMessage({ groupId: id, messageId, senderId: OWNER_QQ_ID, senderName: "OWNER", source: "qq", trust: "OWNER", text, images: [] });
  f.chat = async (messageId, text) => {
    const message = await f.append(messageId, text);
    await store.requestTrigger(id, "mention", message);
    return { message, running: f.worker.kick(id) };
  };
  return f;
}

test("greetings wait for current chat, preserve later pending, and release the next chat", async (t) => {
  for (const type of ["group", "private"]) await t.test(type, async (child) => {
    const f = await fixture(child, type);
    const firstStarted = deferred(), firstEnd = deferred(), greetingStarted = deferred(), greetingEnd = deferred();
    f.onTurn = async (frame) => {
      if (frame.kind === "chat" && f.frames.length === 1) { firstStarted.resolve(); await firstEnd.promise; }
      if (frame.kind === "greeting") { greetingStarted.resolve(); await greetingEnd.promise; }
    };
    const first = await f.chat("101", "CHAT_ONLY_FIRST"); await firstStarted.promise;
    await f.coordinator.tick();
    assert.equal(f.coordinator.activityFor(type, f.id).stage, "queued");
    await f.chat("102", "CHAT_ONLY_LATER");
    firstEnd.resolve(); await greetingStarted.promise;
    assert.deepEqual(f.frames.map((frame) => frame.kind), ["chat", "greeting"]);
    assert.deepEqual(f.store.snapshot(f.id).pendingMessages.map((item) => item.messageId), ["102"]);
    greetingEnd.resolve(); await first.running; await f.coordinator.drain();
    await eventually(() => f.store.snapshot(f.id).pendingMessages.length === 0);
    await eventually(() => f.worker.running.size === 0 && f.worker.queuedChat.size === 0);
    assert.deepEqual(f.frames.map((frame) => frame.kind), ["chat", "greeting", "chat"]);
    const greeting = f.frames[1];
    assert.deepEqual(greeting.pendingBefore, ["102"]); assert.deepEqual(greeting.pendingAfter, ["102"]);
    assert.doesNotMatch(greeting.preparedPrompt, /CHAT_ONLY/);
    assert.equal(greeting.options.qqToolContext.requireRead, false);
    assert.deepEqual(greeting.options.turnSandbox, { type: "readOnly" });
    assert.equal(f.frames[0].options.turnSandbox.type, "workspaceWrite");
    assert.deepEqual(f.frames[2].options.turnSandbox, f.frames[0].options.turnSandbox, "greeting read-only permissions do not leak into the next chat");
    assert.equal(f.spoken.length, 1); assert.equal(f.sent.length, 2);
    assert.equal(f.starts, 0);
    assert.ok(f.frames.every((frame) => frame.options.threadId === `persistent-${type}`));
  });
});

test("greetings retain their queue position through maintenance and a three-minute delay", async (t) => {
  for (const type of ["group", "private"]) await t.test(type, async (child) => {
    const f = await fixture(child, type); const entered = deferred(), release = deferred();
    const maintenance = f.gate.exclusive(async () => { entered.resolve(); await release.promise; });
    await entered.promise; await f.coordinator.tick();
    await f.chat("101", "CHAT_AFTER_GREETING_ACTIVATION");
    f.now = new Date("2026-10-14T07:03:00+08:00");
    assert.equal(f.frames.length, 0);
    release.resolve(); await maintenance; await f.coordinator.drain();
    await eventually(() => f.store.snapshot(f.id).pendingMessages.length === 0);
    assert.deepEqual(f.frames.map((frame) => frame.kind), ["greeting", "chat"]);
    assert.equal(f.spoken.length, 1);
    assert.equal(f.coordinator.activityFor(type, f.id).stage, "completed");
  });
});

test("chat activated during Space work stays ahead of a later scheduled greeting", async (t) => {
  for (const type of ["group", "private"]) await t.test(type, async (child) => {
    const f = await fixture(child, type); const entered = deferred(), release = deferred();
    f.onTurn = async (frame) => { if (frame.kind === "space") { entered.resolve(); await release.promise; } };
    const space = f.worker.runQzoneSequence(f.id, (runTurn) => runTurn("SPACE_ONLY", { trigger: "qzone-feed" }));
    await entered.promise;
    await f.chat("101", "CHAT_ACTIVATED_BEFORE_GREETING");
    assert.equal(f.worker.queuedChat.size, 1, "the earlier chat reserves its place before the later greeting");
    await f.coordinator.tick();
    release.resolve(); await space; await f.coordinator.drain();
    await eventually(() => f.store.snapshot(f.id).pendingMessages.length === 0);
    await eventually(() => f.worker.queuedChat.size === 0 && f.worker.running.size === 0);
    assert.deepEqual(f.frames.map((frame) => frame.kind), ["space", "chat", "greeting"]);
    assert.equal(f.spoken.length, 1);
    assert.equal(f.worker.qzoneReservations.size, 0);
    assert.equal(f.worker.waitingChat.size, 0);
    assert.equal(f.worker.olderChatPermits.size, 0);
  });
});

test("morning, noon and night use separate stable-thread turns without consuming unread messages", async (t) => {
  for (const type of ["group", "private"]) await t.test(type, async (child) => {
    const f = await fixture(child, type); await f.append("101", "UNREAD_CHAT_WITHOUT_TRIGGER");
    for (const time of ["07:00", "13:00", "23:30"]) {
      f.now = new Date(`2026-10-14T${time}:00+08:00`);
      await f.coordinator.tick(); await f.coordinator.drain();
    }
    assert.deepEqual(f.frames.map((frame) => frame.kind), ["greeting", "greeting", "greeting"]);
    assert.equal(new Set(f.frames.map((frame) => frame.options.qqToolContext.greetingJobId)).size, 3);
    assert.ok(f.frames.every((frame) => frame.options.threadId === `persistent-${type}` && frame.options.imagePaths.length === 0));
    for (const frame of f.frames) {
      assert.deepEqual(frame.options.turnSandbox, { type: "readOnly" });
      assert.deepEqual(frame.pendingBefore, ["101"]); assert.deepEqual(frame.pendingAfter, ["101"]);
      assert.doesNotMatch(frame.preparedPrompt, /UNREAD_CHAT_WITHOUT_TRIGGER/);
    }
    assert.equal(f.store.snapshot(f.id).pendingMessages.length, 1);
    assert.equal(f.spoken.length, 3); assert.equal(f.sent.length, 0); assert.equal(f.starts, 0);
  });
});

test("cancel, conversation reply-off and global-off stop speech before its physical send", async (t) => {
  for (const type of ["group", "private"]) for (const stop of ["cancel", "reply", "global"]) await t.test(`${type}-${stop}`, async (child) => {
    const f = await fixture(child, type); await f.append("101", "PRESERVED_WHEN_GREETING_CANCELS");
    const entered = deferred(), release = deferred();
    f.beforeSpeak = async () => { entered.resolve(); await release.promise; };
    await f.coordinator.tick(); await entered.promise;
    if (stop === "cancel") await f.coordinator.cancel(type, f.id);
    else if (stop === "reply") await f.store.setReplyEnabled(f.id, false);
    else f.enabled = false;
    release.resolve(); await f.coordinator.drain();
    assert.equal(f.spoken.length, 0); assert.equal(f.sent.length, 0);
    assert.equal(f.coordinator.activityFor(type, f.id).stage, "cancelled");
    assert.equal(f.store.snapshot(f.id).pendingMessages.length, 1);
    assert.equal(f.worker.qzoneReservations.size, 0);
  });
});

test("failing display callbacks do not lose a greeting or repeat accepted speech", async (t) => {
  const f = await fixture(t, "group", { onEvent() { throw new Error("display offline"); }, onActivityChange() { return Promise.reject(new Error("SSE unavailable")); } });
  await f.coordinator.tick(); await f.coordinator.drain();
  await f.coordinator.tick(); await f.coordinator.drain();
  assert.equal(f.spoken.length, 1);
  assert.equal(f.frames.length, 1);
  assert.equal(f.coordinator.activityFor("group", f.id).stage, "completed");
});
