import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { GroupWorker } from "../src/groups/group-worker.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { SharedContexts } from "../src/qq/shared-contexts.js";
import { prepareLiveConversationPrompt } from "../src/qq/live-conversation.js";

const GROUP = "200000101";
const PRIVATE = "200000102";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { groupThread = "group-thread", followupDurationMs = 1, clock = () => new Date() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "qq-shared-context-worker-"));
  const groupStore = new SessionStore({ filePath: join(directory, "groups.json"), clock });
  const privateStore = new SessionStore({ filePath: join(directory, "private.json"), clock });
  await groupStore.init({ allowedGroups: [GROUP] });
  await privateStore.init({ allowedGroups: [PRIVATE] });
  if (groupThread) await groupStore.setThread(GROUP, groupThread, { bootstrapComplete: true });
  await privateStore.setThread(PRIVATE, "private-original", { bootstrapComplete: true });
  await groupStore.setCodexConfig(GROUP, { model: "shared-model", reasoningEffort: "high", contextTokenLimit: 64000, permissionMode: "dangerFullAccess" });
  await privateStore.setCodexConfig(PRIVATE, { model: "private-model", reasoningEffort: "low", contextTokenLimit: 16000, permissionMode: "readOnly" });
  const requests = [];
  const resumes = [];
  const starts = [];
  const sends = [];
  const interrupts = [];
  const events = [];
  const gates = [];
  const notifications = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const codex = {
    supportsQqMcp: true, supportsSystemPrompt: true,
    async startThread(options) { starts.push(options); return "new-group-thread"; },
    async resumeThread(threadId, options) { resumes.push({ threadId, ...options }); },
    async interruptGroup(key) { interrupts.push(key); return false; },
    async deleteThread() { assert.fail("shared reset must not delete any thread"); },
    async runTurn(request) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const prompt = await prepareLiveConversationPrompt(request.qqToolContext, request.prompt);
        const recorded = { ...request, prompt };
        requests.push(recorded);
        if (codex.behavior) await codex.behavior(recorded);
        return { text: "NO_REPLY", turnId: `turn-${requests.length}`, compacted: false };
      } finally { inFlight--; }
    }
  };
  const oneBot = {
    async sendGroupMessage(id, text, options) { sends.push({ type: "group", id, text, options }); return { ok: true, body: { data: { message_id: String(9000 + sends.length) } } }; },
    async sendPrivateMessage(id, text, options) { sends.push({ type: "private", id, text, options }); return { ok: true, body: { data: { message_id: String(9000 + sends.length) } } }; }
  };
  const shared = await new SharedContexts({ filePath: join(directory, "shared.json"), groupStore, privateStore,
    groupWorkspace: (id) => join(directory, "workspace", id), onChange: () => notifications.push(null) }).init();
  shared.setPrivateGroup(PRIVATE, GROUP);
  const common = { codex, oneBot, mediaManager: { async removeMessages() {} }, followupDurationMs,
    onEvent: (event) => events.push(event) };
  const group = new GroupWorker({ ...common, store: groupStore, triggerManager: new TriggerManager({ store: groupStore }),
    sharedWorkspaceRoot: join(directory, "workspace"), canRun: (id) => !shared.isCancelled("group", id) });
  const privateChat = new PrivateWorker({ ...common, store: privateStore, triggerManager: new TriggerManager({ store: privateStore }),
    canRun: (id) => !shared.isCancelled("private", id) });
  group.sharedContexts = shared;
  privateChat.sharedContexts = shared;
  shared.onIdle = (type, id) => shared.settleTarget(type, id, type === "group" ? group : privateChat);
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.all([group.cancel(GROUP), privateChat.cancel(PRIVATE)]);
    await Promise.allSettled([...group.running.values(), ...privateChat.running.values()]);
    await rm(directory, { recursive: true, force: true });
  });
  const append = (type, text, extra = {}) => {
    const store = type === "group" ? groupStore : privateStore;
    return store.appendMessage({ groupId: type === "group" ? GROUP : PRIVATE,
      messageId: `${type === "group" ? 1 : 2}${store.state.nextSequence}`, senderId: "200000103", senderName: "Synthetic member",
      source: "qq", trust: "UNTRUSTED", text, mentionedBot: true, ...extra });
  };
  const trigger = async (type, text, reason = "mention", extra = {}) => {
    const message = await append(type, text, extra);
    await (type === "group" ? groupStore : privateStore).requestTrigger(type === "group" ? GROUP : PRIVATE, reason, message);
    return message;
  };
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  return { group, privateChat, shared, groupStore, privateStore, codex, requests, resumes, starts, sends, interrupts, events, notifications,
    trigger, append, gate, directory, maxInFlight: () => maxInFlight };
}

test("linked workers process group/private triggers FIFO with one thread/cwd but isolated readers and sends", { timeout: 1000 }, async (t) => {
  const f = await fixture(t, { groupThread: null });
  const entered = f.gate();
  const release = f.gate();
  f.codex.behavior = async (request) => {
    if (request.groupId === GROUP) { entered.resolve(); await release.promise; }
    const sent = await request.qqToolContext.liveTool("send_message", { text: `${request.groupId} acknowledged` }, {});
    assert.equal(sent.isError, false);
  };
  await f.trigger("group", "group-only-text");
  const first = f.group.kick(GROUP);
  await entered.promise;
  await f.trigger("private", "private-only-text");
  const second = f.privateChat.kick(PRIVATE);
  assert.equal(f.shared.snapshot("group", GROUP).queued[0].targetType, "private");
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.maxInFlight(), 1);
  assert.deepEqual(f.requests.map((request) => request.groupId), [GROUP, `private:${PRIVATE}`]);
  assert.match(f.requests[0].prompt, /group-only-text/u);
  assert.doesNotMatch(f.requests[0].prompt, /private-only-text/u);
  assert.match(f.requests[1].prompt, /private-only-text/u);
  assert.doesNotMatch(f.requests[1].prompt, /group-only-text/u);
  const cwd = join(f.directory, "workspace", GROUP);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].cwd, cwd);
  assert.equal(f.resumes[0].threadId, "new-group-thread");
  assert.equal(f.resumes[0].cwd, cwd);
  assert.ok(f.requests.every((request) => request.threadId === "new-group-thread" && request.cwd === cwd));
  assert.deepEqual(f.sends.map(({ type, id }) => [type, id]), [["group", GROUP], ["private", PRIVATE]]);
  for (const [store, id] of [[f.groupStore, GROUP], [f.privateStore, PRIVATE]]) {
    assert.equal(store.snapshot(id).deferredThroughSequence, 1);
    assert.equal(store.snapshot(id).pendingMessages.length, 0);
    assert.equal(store.snapshot(id).lastError, null);
  }
  assert.equal(f.privateStore.snapshot(PRIVATE).threadId, "private-original");
  assert.equal(f.requests[1].turnSandbox.type, "readOnly");
  assert.deepEqual([f.requests[1].model, f.requests[1].effort, f.requests[1].contextTokenLimit], ["shared-model", "high", 64000]);
});

test("private scheduled Qzone tasks queue on the group lane, inherit model context, and never consume private pending", { timeout: 1000 }, async (t) => {
  const f = await fixture(t);
  const entered = f.gate();
  const release = f.gate();
  f.codex.behavior = async (request) => {
    if (request.groupId === GROUP) { entered.resolve(); await release.promise; }
    else {
      const read = await request.qqToolContext.liveTool("read_messages", {}, {});
      assert.equal(read.isError, false);
      assert.match(read.content[0].text, /private-pending-kept/u);
    }
  };
  await f.append("private", "private-pending-kept", { mentionedBot: false });
  await f.trigger("group", "group-current");
  const first = f.group.kick(GROUP);
  await entered.promise;
  const scheduled = f.privateChat.createScheduledToolContext(PRIVATE, {});
  const second = f.privateChat.runQzoneSequence(PRIVATE, async (run) => run("scheduled-only-marker", { trigger: "qzone-feed", qqToolContext: scheduled }));
  assert.equal(f.shared.snapshot("private", PRIVATE).queued[0].kind, "qzone");
  const third = f.privateChat.runQzoneTurn(PRIVATE, "direct-scheduled-marker", {
    trigger: "qzone-post", qqToolContext: f.privateChat.createScheduledToolContext(PRIVATE, {})
  });
  assert.deepEqual(f.shared.snapshot("private", PRIVATE).queued.map((job) => job.kind), ["qzone", "qzone-post"]);
  release.resolve();
  await Promise.all([first, second, third]);
  const request = f.requests[1];
  assert.equal(f.maxInFlight(), 1);
  assert.equal(request.threadId, "group-thread");
  assert.equal(request.cwd, join(f.directory, "workspace", GROUP));
  assert.match(request.prompt, /scheduled-only-marker/u);
  assert.doesNotMatch(request.prompt, /group-current|private-pending-kept/u);
  assert.deepEqual([request.model, request.effort, request.contextTokenLimit], ["shared-model", "high", 64000]);
  assert.equal(request.turnSandbox.type, "readOnly");
  assert.equal(f.resumes.at(-1).permissionMode, "readOnly");
  assert.equal(f.privateStore.snapshot(PRIVATE).deferredThroughSequence, 0);
  assert.equal(f.privateStore.snapshot(PRIVATE).pendingMessages.length, 1);
  assert.equal(f.privateStore.snapshot(PRIVATE).threadId, "private-original");
  assert.equal(f.starts.length, 0);
  assert.match(f.requests[2].prompt, /direct-scheduled-marker/u);
  assert.equal(f.requests[2].threadId, "group-thread");
  assert.equal(f.requests[2].cwd, request.cwd);
});

test("a private-first trigger creates only the shared group thread and the later group trigger resumes it", { timeout: 1000 }, async (t) => {
  const f = await fixture(t, { groupThread: null });
  const entered = f.gate();
  const release = f.gate();
  f.codex.behavior = async (request) => {
    if (request.groupId.startsWith("private:")) { entered.resolve(); await release.promise; }
  };
  await f.trigger("private", "private-first-message");
  const first = f.privateChat.kick(PRIVATE);
  await entered.promise;
  await f.trigger("group", "group-after-private");
  const second = f.group.kick(GROUP);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.requests.map((request) => request.groupId), [`private:${PRIVATE}`, GROUP]);
  assert.equal(f.maxInFlight(), 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].cwd, join(f.directory, "workspace", GROUP));
  assert.equal(f.starts[0].permissionMode, "readOnly");
  assert.equal(f.starts[0].model, "shared-model");
  assert.equal(f.resumes[0].threadId, "new-group-thread");
  assert.equal(f.resumes[0].cwd, f.starts[0].cwd);
  assert.equal(f.groupStore.snapshot(GROUP).threadId, "new-group-thread");
  assert.equal(f.privateStore.snapshot(PRIVATE).threadId, "private-original");
  assert.doesNotMatch(f.requests[0].prompt, /group-after-private/u);
  assert.doesNotMatch(f.requests[1].prompt, /private-first-message/u);
});

test("unbinding restores the private thread and its own model settings without touching group state", { timeout: 1000 }, async (t) => {
  const f = await fixture(t);
  await f.trigger("private", "linked-round");
  await f.privateChat.kick(PRIVATE);
  const original = f.privateStore.snapshot(PRIVATE);
  assert.equal(f.requests[0].threadId, "group-thread");
  f.shared.setPrivateGroup(PRIVATE, null);
  await f.trigger("private", "independent-round");
  await f.privateChat.kick(PRIVATE);
  const request = f.requests.at(-1);
  assert.equal(request.threadId, "private-original");
  assert.deepEqual([request.model, request.effort, request.contextTokenLimit], ["private-model", "low", 16000]);
  assert.equal(request.turnSandbox.type, "readOnly");
  assert.equal(f.privateStore.snapshot(PRIVATE).threadId, original.threadId);
  assert.equal(f.groupStore.snapshot(GROUP).threadId, "group-thread");
  assert.doesNotMatch(request.prompt, /linked-round/u);
  assert.match(request.prompt, /independent-round/u);
  assert.equal(f.starts.length, 0);
});

test("two-minute followup yields immediately to another linked channel instead of holding its lane", { timeout: 1000 }, async (t) => {
  const f = await fixture(t, { followupDurationMs: 120000 });
  const waiting = f.gate();
  const startedPrivate = f.gate();
  const originalEvent = f.group.onEvent;
  f.group.followup.onEvent = (event) => { originalEvent(event); if (event.type === "conversation-waiting") waiting.resolve(); };
  f.codex.behavior = async (request) => {
    if (request.groupId.startsWith("private:")) {
      startedPrivate.resolve();
      await f.privateChat.followup.cancel(PRIVATE);
    }
  };
  await f.trigger("group", "group-followup");
  const first = f.group.kick(GROUP);
  await waiting.promise;
  await f.trigger("private", "wake-private-next");
  const second = f.privateChat.kick(PRIVATE);
  await startedPrivate.promise;
  await Promise.all([first, second]);
  assert.deepEqual(f.requests.map((request) => request.groupId), [GROUP, `private:${PRIVATE}`]);
  assert.equal(f.maxInFlight(), 1);
  assert.ok(f.groupStore.snapshot(GROUP).replyFollowup, "yield preserves the remaining group followup window");
  assert.equal(f.shared.busy("group", GROUP), false);
});

test("cancelling a queued private reply leaves the active group run untouched", { timeout: 1000 }, async (t) => {
  const f = await fixture(t);
  const entered = f.gate();
  const release = f.gate();
  f.codex.behavior = async () => { entered.resolve(); await release.promise; };
  await f.trigger("group", "group-continues");
  const first = f.group.kick(GROUP);
  await entered.promise;
  await f.trigger("private", "private-still-unread");
  const second = f.privateChat.kick(PRIVATE);
  const rejected = assert.rejects(second, { code: "CANCELLED" });
  await f.privateChat.cancel(PRIVATE);
  assert.equal(f.shared.snapshot("group", GROUP).active.targetType, "group");
  assert.equal(f.shared.isCancelled("group", GROUP), false);
  assert.deepEqual(f.interrupts, [`private:${PRIVATE}`]);
  release.resolve();
  await Promise.all([first, rejected]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.privateStore.snapshot(PRIVATE).deferredThroughSequence, 0);
  assert.equal(f.privateStore.snapshot(PRIVATE).pendingMessages.length, 1);
});

test("linked private reset explains shared context without starting or deleting a thread", { timeout: 1000 }, async (t) => {
  const f = await fixture(t);
  await f.trigger("private", "/新会话", "control", { trust: "OWNER" });
  await f.privateChat.kick(PRIVATE);
  assert.equal(f.requests.length, 0);
  assert.equal(f.starts.length, 0);
  assert.equal(f.resumes.length, 0);
  assert.equal(f.privateStore.snapshot(PRIVATE).threadId, "private-original");
  assert.equal(f.groupStore.snapshot(GROUP).threadId, "group-thread");
  assert.deepEqual(f.sends.map(({ type, id }) => [type, id]), [["private", PRIVATE]]);
  assert.match(f.sends[0].text, /共享群聊上下文.*解除关联/u);
  assert.equal(f.privateStore.snapshot(PRIVATE).pendingMessages.length, 0);
});

test("independent followup windows settle without requeue ping-pong and expire without extra model rounds", { timeout: 1000 }, async (t) => {
  let now = Date.now();
  const f = await fixture(t, { followupDurationMs: 120000, clock: () => new Date(now) });
  const entered = f.gate();
  const release = f.gate();
  let queuedObserver;
  f.codex.behavior = async (request) => {
    if (request.groupId === GROUP) { entered.resolve(); await release.promise; }
    else queuedObserver = f.shared.run("group", GROUP, "observer", () => {});
  };
  await f.trigger("group", "group-first-window");
  const groupRun = f.group.kick(GROUP);
  await entered.promise;
  await f.trigger("private", "private-second-window");
  const privateRun = f.privateChat.kick(PRIVATE);
  release.resolve();
  await Promise.all([groupRun, privateRun]);
  await queuedObserver;
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 2);
  assert.equal(f.shared.busy("group", GROUP), false);
  assert.equal(f.group.live.get(GROUP).status, "waiting");
  assert.equal(f.privateChat.live.get(PRIVATE).status, "waiting");
  assert.ok(f.groupStore.snapshot(GROUP).replyFollowup);
  assert.ok(f.privateStore.snapshot(PRIVATE).replyFollowup);
  const notifications = f.notifications.length;
  for (let iteration = 0; iteration < 10; iteration++) {
    f.shared.settleTarget("group", GROUP, f.group);
    f.shared.settleTarget("private", PRIVATE, f.privateChat);
  }
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 2);
  assert.equal(f.notifications.length, notifications);
  assert.equal(f.shared.busy("group", GROUP), false);

  now += 120001;
  await Promise.all([f.groupStore.expireReplyFollowups(), f.privateStore.expireReplyFollowups()]);
  f.shared.settleTarget("group", GROUP, f.group);
  f.shared.settleTarget("private", PRIVATE, f.privateChat);
  assert.equal(f.group.live.get(GROUP).status, "completed");
  assert.equal(f.privateChat.live.get(PRIVATE).status, "completed");
  assert.equal(f.notifications.length, notifications + 2);
  f.shared.settleTarget("group", GROUP, f.group);
  f.shared.settleTarget("private", PRIVATE, f.privateChat);
  assert.equal(f.notifications.length, notifications + 2);
  assert.equal(f.requests.length, 2);

  const nextRound = f.gate();
  f.codex.behavior = async () => { await f.privateChat.followup.cancel(PRIVATE); nextRound.resolve(); };
  await f.trigger("private", "fresh-pending-restarts-only-private");
  f.shared.settleTarget("private", PRIVATE, f.privateChat);
  await nextRound.promise;
  await f.privateChat.running.get(PRIVATE);
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].groupId, `private:${PRIVATE}`);
  assert.match(f.requests[2].prompt, /fresh-pending-restarts-only-private/u);
  assert.doesNotMatch(f.requests[2].prompt, /group-first-window|private-second-window/u);
  assert.equal(f.shared.busy("group", GROUP), false);
});
