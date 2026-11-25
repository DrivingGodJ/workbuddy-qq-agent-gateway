import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { SessionStore } from "../src/storage/session-store.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { ConversationFollowup } from "../src/qq/conversation-followup.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { QqMessageReader } from "../src/qq/message-reader.js";
import { compactMessageContext } from "../src/security/message-context.js";
import {
  computeBurstDebounceMs,
  computeFollowupDurationMs,
  computeReplyDelayMs
} from "../src/qq/human-pacing.js";

const FAST_PACING = Object.freeze({
  shortDebounceMs: 40,
  quickDebounceMs: 20,
  maxDebounceMs: 75,
  groupFollowupDebounceMs: 65,
  groupFollowupMaxDebounceMs: 110,
  replyMinMs: 25,
  replyMaxMs: 55,
  replyPerCharMs: 1,
  reactionMinMs: 20,
  reactionMaxMs: 30,
  hotFollowupMs: 120_000,
  casualPrivateFollowupMs: 60_000,
  casualGroupFollowupMs: 50_000
});

test("TriggerManager Item 1 & Item 4: merges rapid burst messages, caps wait, and keeps poke immediate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-human-debounce-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(root, "sessions.json") });
  await store.init({ allowedGroups: ["1001"] });

  const kicks = [];
  const trigger = new TriggerManager({
    store,
    allowedGroups: ["1001"],
    targetType: "group",
    humanPacing: true,
    pacingConfig: FAST_PACING,
    botNameResolver: () => "老代"
  });
  trigger.setWorker({ running: new Map(), kick: async (id) => { kicks.push(id); } });
  t.after(() => trigger.stop());

  const m1 = await store.appendMessage({ groupId: "1001", messageId: "1", senderId: "2001", text: "在吗", mentionedBot: true });
  await trigger.considerMessage(m1);
  await pause(15);
  const m2 = await store.appendMessage({ groupId: "1001", messageId: "2", senderId: "2001", text: "帮我看个事", mentionedBot: true });
  await trigger.considerMessage(m2);
  assert.equal(kicks.length, 0, "burst must wait before waking");
  await pause(65);
  assert.equal(kicks.length, 1, "burst should collapse into a single worker kick");

  // Group followup without @ or botName uses longer debounce (Item 4)
  const quiet = computeBurstDebounceMs({ text: "哈哈确实", mentionedBot: false }, {
    targetType: "group", reason: "followup", botName: "老代", config: FAST_PACING
  });
  const named = computeBurstDebounceMs({ text: "老代你觉得呢", mentionedBot: false }, {
    targetType: "group", reason: "followup", botName: "老代", config: FAST_PACING
  });
  assert.equal(quiet.delayMs, 65);
  assert.equal(named.delayMs, 40);

  // Poke trigger stays immediate
  const m3 = await store.appendMessage({ groupId: "1001", messageId: "3", senderId: "2001", eventType: "poke", mentionedBot: true, text: "poke" });
  await trigger.considerMessage(m3);
  await pause(5);
  assert.equal(kicks.length, 2, "poke should wake immediately without debounce");
});

test("createLiveConversationTools Item 2: paces 2nd+ sends, interrupts on new message, and emits hint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-human-reply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(root, "sessions.json") });
  await store.init({ allowedGroups: ["1001"] });

  const first = await store.appendMessage({ groupId: "1001", messageId: "101", senderId: "2001", text: "在吗？" });
  await store.requestTrigger("1001", "mention", first);
  await store.beginWork("1001");

  const sent = [];
  const oneBot = {
    async sendPrivateMessage(_targetId, text) {
      sent.push({ text, at: Date.now() });
      return { ok: true, body: { data: { message_id: String(sent.length) } } };
    }
  };
  const context = createLiveConversationTools({
    store,
    targetId: "1001",
    targetType: "private",
    oneBot,
    security: {},
    trigger: { reason: "mention" },
    triggerMessages: [first],
    initialImageSequence: first.sequence,
    messageReader: new QqMessageReader({ oneBot }),
    renderMessages: (messages) => compactMessageContext(messages).join("\n"),
    humanPacing: true,
    pacingConfig: { ...FAST_PACING, replyMinMs: 70, replyMaxMs: 70, replyPerCharMs: 0 },
    pacingRandom: () => 0.5
  });
  await context.liveTool("read_messages", {}, { onDelta() {} });

  const r1 = await context.liveTool("send_message", { text: "在的" }, { onDelta() {} });
  assert.equal(r1.isError, false);

  // Schedule a new incoming message 20ms into the 2nd send delay
  setTimeout(() => {
    store.appendMessage({ groupId: "1001", messageId: "102", senderId: "2001", text: "算了先别管" }).catch(() => {});
  }, 20);

  const r2Start = Date.now();
  const r2 = await context.liveTool("send_message", { text: "啥事呀" }, { onDelta() {} });
  const elapsed = Date.now() - r2Start;
  assert.equal(r2.isError, false);
  assert.ok(elapsed < 120, `expected interruptible send delay, got ${elapsed}ms`);
  assert.match(r2.content[0].text, /对方又发来新消息/);

  const deterministic = computeReplyDelayMs({ kind: "message", text: "一二三四五六七八九十" }, { random: () => 0.5 });
  assert.ok(deterministic >= 600 && deterministic <= 2200);
});

test("Item 3 & ConversationFollowup: computes adaptive followup durations and handles 0ms graceful exit", async (t) => {
  assert.equal(computeFollowupDurationMs({
    targetType: "private", triggerReason: "followup", chatSendCount: 0, totalActionCount: 0, readMessages: [{ text: "哈哈" }]
  }), 0);
  assert.equal(computeFollowupDurationMs({
    targetType: "private", triggerReason: "mention", chatSendCount: 1, lastSentText: "好吧", readMessages: [{ text: "晚安" }]
  }), 0);
  assert.equal(computeFollowupDurationMs({
    targetType: "group", triggerReason: "mention", chatSendCount: 1, lastSentText: "闭嘴行了", readMessages: [{ text: "闭嘴" }]
  }), 0);
  assert.equal(computeFollowupDurationMs({
    targetType: "private", triggerReason: "mention", chatSendCount: 1, lastSentText: "好的收到", readMessages: [{ text: "嗯嗯" }]
  }), 60_000);
  assert.equal(computeFollowupDurationMs({
    targetType: "group", triggerReason: "mention", chatSendCount: 1, lastSentText: "好的收到", readMessages: [{ text: "嗯嗯" }]
  }), 50_000);
  assert.equal(computeFollowupDurationMs({
    targetType: "private", triggerReason: "mention", chatSendCount: 1, lastSentText: "你要我顺手记日历吗？", readMessages: [{ text: "嗯" }]
  }), 120_000);

  const root = await mkdtemp(join(tmpdir(), "qq-human-followup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(root, "sessions.json") });
  await store.init({ allowedGroups: ["1001"] });

  const msg = await store.appendMessage({ groupId: "1001", messageId: "1", senderId: "2001", text: "晚安" });
  await store.requestTrigger("1001", "mention", msg);
  await store.beginWork("1001");
  await store.markMessagesRead("1001", [msg]);

  const followup = new ConversationFollowup({
    store,
    targetType: "private",
    humanPacing: true,
    pacingConfig: FAST_PACING,
    canRun: () => true,
    blocked: () => false,
    setLive() {},
    onEvent() {}
  });
  await followup.arm("1001", {
    lastReadSequence: msg.sequence,
    triggerReason: "mention",
    chatSendCount: 1,
    actionCount: 1,
    lastSentText: "晚安啦",
    lastReadMessages: [msg]
  });
  assert.equal(store.snapshot("1001").replyFollowup, null, "0ms followup must cleanly close window");
});
