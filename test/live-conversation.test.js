import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { createLiveConversationTools, prepareLiveConversationPrompt } from "../src/qq/live-conversation.js";
import { toPublicGroupState } from "../src/groups/group-state.js";

async function fixture(t, oneBot = null) {
  const directory = await mkdtemp(join(tmpdir(), "crc-live-qq-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "sessions.json");
  const store = new SessionStore({ filePath });
  await store.init({ allowedGroups: ["12345"] });
  const sent = [];
  const bot = oneBot || {
    async sendGroupMessage(_target, text) { sent.push(["text", text]); return { ok: true, status: 200 }; },
    async sendGroupFace(_target, id) { sent.push(["face", id]); return { ok: true, status: 200 }; }
  };
  const append = async (id, text) => store.appendMessage({
    groupId: "12345", messageId: id, senderId: "67890", senderName: "同学",
    text, trust: "UNTRUSTED", displayTime: "10:00", timestamp: "2026-09-22T02:00:00.000Z"
  });
  const first = await append("m1", "第一句");
  await store.requestTrigger("12345", "mention", { ...first, trust: "OWNER" });
  await store.beginWork("12345");
  const context = createLiveConversationTools({
    store, targetId: "12345", targetType: "group", oneBot: bot,
    trigger: { reason: "mention", messageId: "m1", trust: "OWNER" },
    triggerMessages: [first], security: { allowQqFiles: true, allowedFileRoots: null },
    initialImageSequence: first.sequence, renderMessages: (messages) => messages.map((message) => message.text).join("\n"),
    pokeSenderId: "67890", allowedPokeUserIds: ["67890"]
  });
  const active = { turnId: "test-turn", onDelta: () => {} };
  return { store, context, active, sent, append, filePath };
}

test("live QQ conversation sends multiple messages but clears only after end, preserving later arrivals", async (t) => {
  const { store, context, active, sent, append } = await fixture(t);
  const displayed = [];
  active.onDelta = (_delta, text) => displayed.push(text);
  assert.match((await context.liveTool("read_messages", {}, active)).content[0].text, /第一句/);
  assert.equal((await context.liveTool("send_message", { text: "第一次回复" }, active)).isError, false);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  await append("m2", "第二句");
  assert.match((await context.liveTool("read_messages", {}, active)).content[0].text, /第二句/);
  assert.equal((await context.liveTool("send_message", { text: "第二次回复" }, active)).isError, false);
  assert.equal(store.snapshot("12345").pendingMessages.length, 2);
  await append("m3", "回复后才到的新消息");
  await context.liveTool("end_conversation", {}, active);
  const removed = await store.completeLiveConversation("12345", { turnId: "test-turn", lastReadSequence: context.lastReadSequence });
  assert.deepEqual(removed.map((message) => message.messageId), ["m1", "m2"]);
  assert.deepEqual(store.snapshot("12345").pendingMessages.map((message) => message.messageId), ["m3"]);
  assert.equal(store.snapshot("12345").lastCompletedReply.text, "第二次回复");
  assert.deepEqual(sent.map((item) => item[1]), ["第一次回复", "第二次回复"]);
  assert.equal(displayed.at(-1), "第一次回复\n\n第二次回复");
});

test("initial prefetch uses the same bounded reader without clearing pending or consuming later messages", async (t) => {
  const { store, context, active, sent, append } = await fixture(t);
  const prepared = await prepareLiveConversationPrompt(context, "【当前任务】自然回复");
  assert.match(prepared, /网关预读取结果/);
  assert.match(prepared, /第一句/);
  assert.ok(prepared.endsWith("【当前任务】自然回复"));
  assert.equal(context.readCalled, true);
  assert.equal(context.lastReadSequence, 1);
  assert.equal(context.actionCount, 0);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  await append("m2", "启动后新增");
  assert.equal(await prepareLiveConversationPrompt(context, "重试任务"), "重试任务");
  await context.liveTool("send_message", { text: "直接回复首批" }, active);
  const removed = await store.completeLiveConversation("12345", { lastReadSequence: context.lastReadSequence });
  assert.deepEqual(removed.map((message) => message.messageId), ["m1"]);
  assert.deepEqual(store.snapshot("12345").pendingMessages.map((message) => message.messageId), ["m2"]);
  assert.deepEqual(sent, [["text", "直接回复首批"]]);
});

test("group and private prefetch include unread self receipts from the panel timeline exactly once", async (t) => {
  for (const targetType of ["group", "private"]) {
    const f = await fixture(t);
    await f.store.recordLiveActionSent("12345", {
      kind: "message", summary: "已经处理的旧回复", observedSequence: 1, messageId: "701"
    });
    await f.store.completeLiveConversation("12345", { lastReadSequence: 1 });
    await f.store.recordStandaloneActionSent("12345", {
      kind: "message", summary: "面板上的上一次完整回答", messageId: "702"
    });
    const pending = await f.append("m2", "面板上的待处理消息");
    await f.store.requestTrigger("12345", "mention", pending);
    await f.store.beginWork("12345");
    const view = toPublicGroupState(f.store.snapshot("12345"));
    const context = createLiveConversationTools({
      store: f.store, targetId: "12345", targetType, oneBot: {},
      trigger: { reason: "mention", trust: "UNTRUSTED" }, triggerMessages: [pending],
      security: {}, initialImageSequence: pending.sequence,
      renderMessages: (messages) => messages.map((message) => message.text).join("\n")
    });
    const prepared = await prepareLiveConversationPrompt(context, "本轮权限");
    assert.ok(prepared.includes(view.lastCompletedReply.text));
    for (const message of view.pendingMessages) assert.ok(prepared.includes(message.text));
    assert.ok(view.messageTimeline.some((message) => message.isSelf && message.text === "已经处理的旧回复"));
    assert.match(prepared, /已经处理的旧回复/);
    assert.doesNotMatch(prepared, /最近由你成功发出的消息|"tool"|"content"/);
    assert.equal(prepared.match(/面板上的上一次完整回答/g)?.length, 1);
    assert.equal(context.lastReadSequence, pending.sequence);
    assert.equal(f.store.snapshot("12345").pendingMessages.length, 1);
    await f.append("m3", "后来到达的新消息");
    const more = await context.liveTool("read_messages", {}, f.active);
    assert.match(more.content[0].text, /后来到达的新消息/);
    assert.doesNotMatch(more.content[0].text, /面板上的上一次完整回答|面板上的待处理消息|已经处理的旧回复/);
  }
});

test("prefetch includes visible sent receipts but never substitutes a hidden lastReply string", async (t) => {
  const f = await fixture(t);
  await f.store.recordLiveActionSent("12345", {
    kind: "message", summary: "未完成的已发送动作", observedSequence: 1, messageId: "703"
  });
  assert.equal(toPublicGroupState(f.store.snapshot("12345")).lastCompletedReply, null);
  f.store.ensureGroup("12345").lastReply = "hidden legacy lastReply";
  const prepared = await prepareLiveConversationPrompt(f.context, "任务");
  assert.match(prepared, /第一句/);
  assert.match(prepared, /未完成的已发送动作/);
  assert.doesNotMatch(prepared, /hidden legacy lastReply|上一次完整回答|最近由你成功发出的消息/);
});

test("group and private MCP sends preserve AI punctuation, line breaks and emoji", async (t) => {
  const expected = "先这样，等等😂\n再说,行吗👍🏽";
  const group = await fixture(t);
  await group.context.liveTool("read_messages", {}, group.active);
  assert.equal((await group.context.liveTool("send_message", { text: expected }, group.active)).isError, false);
  assert.deepEqual(group.sent, [["text", expected]]);

  const privateSends = [];
  const privateSession = await fixture(t);
  const privateContext = createLiveConversationTools({
    store: privateSession.store, targetId: "12345", targetType: "private",
    oneBot: { async sendPrivateMessage(_target, text) {
      privateSends.push(text);
      return { ok: true, status: 200 };
    } },
    trigger: { reason: "mention", messageId: "m1", trust: "OWNER" },
    triggerMessages: [], security: { allowQqFiles: false, allowedFileRoots: [] },
    initialImageSequence: 1, renderMessages: (messages) => messages.map((message) => message.text).join("\n")
  });
  await privateContext.liveTool("read_messages", {}, privateSession.active);
  assert.equal((await privateContext.liveTool("send_message", { text: expected }, privateSession.active)).isError, false);
  assert.deepEqual(privateSends, [expected]);
});

test("prefetch honors pagination and subsequent MCP reads still return later pages", async (t) => {
  const { store, context, active, append } = await fixture(t);
  for (let n = 2; n <= 43; n++) await append(`m${n}`, `批次消息${n}`);
  const prepared = await prepareLiveConversationPrompt(context, "任务");
  assert.match(prepared, /还有未读取的消息/);
  assert.equal(context.lastReadSequence, 40);
  assert.equal(store.snapshot("12345").pendingMessages.length, 43);
  const more = await context.liveTool("read_messages", {}, active);
  assert.match(more.content[0].text, /批次消息41/);
  assert.doesNotMatch(more.content[0].text, /批次消息40/);
  assert.equal(context.lastReadSequence, 43);
});

test("prefetch stops on reader failure and leaves source-only and non-live contexts alone", async (t) => {
  const { store, context } = await fixture(t);
  await store.setReplyEnabled("12345", false);
  await assert.rejects(() => prepareLiveConversationPrompt(context, "任务"), /REPLY|回复|关闭|停止/);
  assert.equal(context.readCalled, false);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  const source = { requireSourceRead: true, sourceReadCalled: false };
  assert.equal(await prepareLiveConversationPrompt(source, "通知任务"), "通知任务");
  assert.equal(source.sourceReadCalled, false);
  assert.equal(await prepareLiveConversationPrompt(null, "普通任务"), "普通任务");
});

test("the conversation cannot end before reading its pending messages", async (t) => {
  const { context, active } = await fixture(t);
  assert.equal((await context.liveTool("end_conversation", {}, active)).isError, true);
  assert.equal(context.ended, false);
});

test("ordinary chat explains scheduled Space tool misuse without consuming messages or blocking recovery", async (t) => {
  const { context, active, store } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  const wrong = await context.liveTool("submit_qzone_decisions", { actions: [{ type: "comment" }] }, active);
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /用 read_qzone_feeds.*用 engage_qzone_feed/);
  assert.match((await context.liveTool("read_qzone_feed_batch", {}, active)).content[0].text, /旧版动态读取工具已停用/);
  assert.match((await context.liveTool("propose_qzone_post", { content: "测试" }, active)).content[0].text, /post_qzone/);
  assert.equal(context.failed, false);
  assert.equal(context.actionCount, 0);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
});

test("native QQ mentions preserve their original position and are not sent as plain text", async (t) => {
  const requests = [];
  const f = await fixture(t, {
    getGroupMemberInfo: async (group, user) => { assert.equal(group, "12345"); return { user_id: Number(user) }; },
    sendGroupSegments: async (_group, message) => { requests.push(message); return { ok: true }; },
    sendGroupMessage: async () => { throw new Error("must use native segments"); }
  });
  await f.context.liveTool("read_messages", {}, f.active);
  const result = await f.context.liveTool("send_message", { segments: [
    { type: "text", text: "看这里 " }, { type: "at", user_id: "67890" }, { type: "text", text: " 你来一下" }
  ] }, f.active);
  assert.equal(result.isError, false);
  assert.deepEqual(requests[0], [
    { type: "text", data: { text: "看这里 " } }, { type: "at", data: { qq: "67890" } }, { type: "text", data: { text: " 你来一下" } }
  ]);
  assert.equal(f.store.snapshot("12345").pendingMessages.length, 1);
  assert.equal(f.context.actionCount, 1);
});

test("every text send independently chooses an explicit quote, never the wake message by default", async (t) => {
  const sends = [];
  const f = await fixture(t, {
    sendGroupMessage: async (_group, text, options) => { sends.push({ text, options }); return { ok: true }; }
  });
  await f.append("321", "第二条");
  await f.context.liveTool("read_messages", {}, f.active);
  assert.equal((await f.context.liveTool("send_message", { text: "普通发言" }, f.active)).isError, false);
  assert.equal((await f.context.liveTool("send_message", { text: "针对第二条", reply_to_message_id: "321" }, f.active)).isError, false);
  assert.equal((await f.context.liveTool("send_message", { text: "又是普通发言" }, f.active)).isError, false);
  assert.deepEqual(sends.map((item) => item.options.replyToMessageId), [null, "321", null]);
  assert.equal((await f.context.liveTool("send_message", { text: "不能猜引用", reply_to_message_id: "999" }, f.active)).isError, true);
  await f.store.recallMessage("12345", "321");
  assert.equal((await f.context.liveTool("send_message", { text: "不能引已撤回", reply_to_message_id: "321" }, f.active)).isError, true);
});

test("recall_message only retracts confirmed self messages in this conversation and preserves pending if last reply is retracted", async (t) => {
  const deleted = [];
  const f = await fixture(t, {
    sendGroupMessage: async () => ({ ok: true, body: { data: { message_id: 777 } } }),
    deleteMessage: async (id) => { deleted.push(id); return { ok: true }; }
  });
  await f.context.liveTool("read_messages", {}, f.active);
  assert.equal((await f.context.liveTool("recall_message", { message_id: "777" }, f.active)).isError, true);
  const sent = await f.context.liveTool("send_message", { text: "可以撤回" }, f.active);
  assert.match(sent.content[0].text, /777/);
  assert.equal((await f.context.liveTool("recall_message", { message_id: "888" }, f.active)).isError, true);
  assert.equal((await f.context.liveTool("recall_message", { message_id: "777" }, f.active)).isError, false);
  assert.deepEqual(deleted, ["777"]);
  assert.equal(f.store.getSentMessage("12345", "777"), null);
  assert.equal((await f.context.liveTool("recall_message", { message_id: "777" }, f.active)).isError, true);
  await f.context.liveTool("end_conversation", {}, f.active);
  await f.append("after-recall", "撤回后新到、尚未读取的消息");
  await f.store.completeLiveConversation("12345", { lastReadSequence: f.context.lastReadSequence });
  assert.equal(f.store.snapshot("12345").pendingMessages.length, 1);
  assert.equal(f.store.snapshot("12345").pendingMessages[0].messageId, "after-recall");
  assert.equal(f.store.snapshot("12345").lastCompletedReply, null);
});

test("an incoming recall removes pending text, persists a tombstone and stops a turn that read it", async (t) => {
  const f = await fixture(t);
  await f.append("123", "随后撤回");
  await f.context.liveTool("read_messages", {}, f.active);
  const result = await f.store.recallMessage("12345", "123");
  assert.equal(result.wasProcessing, true);
  assert.deepEqual(f.store.snapshot("12345").pendingMessages.map((item) => item.messageId), ["m1"]);
  assert.equal((await f.context.liveTool("send_message", { text: "不应继续" }, f.active)).isError, true);
  assert.equal(await f.append("123", "延迟到达的副本"), null);
  await f.store.failWork("12345", new Error("取消了含撤回消息的回复"));
  assert.equal(f.store.snapshot("12345").lastError, null);
  assert.equal(f.store.snapshot("12345").pendingTrigger, null);
  const restarted = new SessionStore({ filePath: f.filePath });
  await restarted.init({ allowedGroups: ["12345"] });
  assert.equal(restarted.isRecalled("12345", "123"), true);
});

test("recalling a quoted message redacts its quoted text and image even when the original is no longer pending", async (t) => {
  const f = await fixture(t);
  await f.store.appendMessage({
    groupId: "12345", messageId: "456", senderId: "67890", text: "引用说明", replyToMessageId: "123",
    quotedMessage: { messageId: "123", text: "已撤回的内容" }, images: [{ context: "quoted", localPath: "/tmp/quote.jpg" }]
  });
  await f.context.liveTool("read_messages", {}, f.active);
  await f.store.markLiveReadSequence("12345", f.store.snapshot("12345").pendingMessages.at(-1).sequence);
  const recalled = await f.store.recallMessage("12345", "123");
  assert.deepEqual(recalled.removedMessages, []);
  assert.deepEqual(recalled.removedImages.map((image) => image.localPath), ["/tmp/quote.jpg"]);
  assert.equal(recalled.wasProcessing, true);
  const quoted = f.store.snapshot("12345").pendingMessages.find((item) => item.messageId === "456");
  assert.equal(quoted.quotedMessage, null);
  assert.deepEqual(quoted.images, []);
});

test("at-only replies work but unknown members, all, private mentions and unread calls are denied", async (t) => {
  const sent = [];
  const f = await fixture(t, {
    getGroupMemberInfo: async (_group, user) => user === "67890" ? { user_id: 67890 } : null,
    sendGroupSegments: async (_group, message) => { sent.push(message); return { ok: true }; }
  });
  const call = (segments) => f.context.liveTool("send_message", { segments }, f.active);
  assert.equal((await call([{ type: "at", user_id: "67890" }])).isError, true);
  await f.context.liveTool("read_messages", {}, f.active);
  assert.equal((await call([{ type: "at", user_id: "all" }])).isError, true);
  assert.equal((await call([{ type: "at", user_id: "99999" }])).isError, true);
  assert.equal(f.context.failed, false);
  assert.equal((await call([{ type: "at", user_id: "67890" }])).isError, false);
  assert.equal(sent[0].at(-1).type, "at");
  f.context.targetType = "private";
  assert.equal((await call([{ type: "at", user_id: "67890" }])).isError, true);
  assert.equal(sent.length, 1);
});

test("live resources cannot bypass the reader or obtain unread later messages", async (t) => {
  const f = await fixture(t, { getForwardMessages: async () => [{ user_id: 67890, message: [{ type: "text", data: { text: "合并正文" } }] }] });
  const first = f.store.snapshot("12345").pendingMessages[0];
  // The real store append path persists these references alongside pending.
  await f.store.appendMessage({ ...first, messageId: "m-forward", attachments: [{ type: "forward", fileId: "known" }], text: "[合并转发]" });
  assert.equal((await f.context.liveTool("read_forward_messages", { message_id: "m-forward" }, f.active)).isError, true);
  await f.context.liveTool("read_messages", {}, f.active);
  const result = await f.context.liveTool("read_forward_messages", { message_id: "m-forward" }, f.active);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /合并正文/);
  await f.store.appendMessage({ ...first, messageId: "m-later", attachments: [{ type: "forward", fileId: "later" }] });
  assert.equal((await f.context.liveTool("read_forward_messages", { message_id: "m-later" }, f.active)).isError, true);
  assert.equal(f.store.snapshot("12345").pendingMessages.length, 3);
  assert.equal(f.context.actionCount, 0);
});

test("live QQ failure retains pending messages and acknowledged sends across restart", async (t) => {
  const { store, context, active, filePath } = await fixture(t, {
    async sendGroupMessage() { return { ok: true, status: 200 }; },
    async sendGroupFace() { return { ok: false, status: 503 }; }
  });
  await context.liveTool("read_messages", {}, active);
  assert.equal((await context.liveTool("send_message", { text: "已发的一句" }, active)).isError, false);
  assert.equal((await context.liveTool("send_reaction", { face: "微笑" }, active)).isError, true);
  assert.equal(context.failed, true);
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  await store.failWork("12345", new Error("delivery failed"));
  const restarted = new SessionStore({ filePath });
  await restarted.init({ allowedGroups: ["12345"] });
  assert.equal(restarted.snapshot("12345").pendingMessages.length, 1);
  assert.equal(restarted.snapshot("12345").liveSession.lastReply, "已发的一句");
  assert.equal(restarted.snapshot("12345").pendingTrigger, null);
});

test("a process restart during a live conversation retains the sent receipt and schedules recovery", async (t) => {
  const { store, context, active, filePath } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  await context.liveTool("send_message", { text: "崩溃前已送达" }, active);
  const restarted = new SessionStore({ filePath });
  await restarted.init({ allowedGroups: ["12345"] });
  const state = restarted.snapshot("12345");
  assert.deepEqual(state.pendingMessages.map((message) => message.messageId), ["m1"]);
  assert.equal(state.liveSession.lastReply, "崩溃前已送达");
  assert.equal(state.pendingTrigger.reason, "retry");
  await restarted.beginWork("12345");
  let duplicateSends = 0;
  const resumed = createLiveConversationTools({
    store: restarted, targetId: "12345", targetType: "group",
    oneBot: { async sendGroupMessage() { duplicateSends += 1; return { ok: true }; } },
    trigger: { reason: "retry" }, triggerMessages: [],
    security: { allowQqFiles: true, allowedFileRoots: null }, initialImageSequence: 1,
    renderMessages: (messages) => messages.map((message) => message.text).join("\n")
  });
  await resumed.liveTool("read_messages", {}, active);
  const repeated = await resumed.liveTool("send_message", { text: "崩溃前已送达" }, active);
  assert.match(repeated.content[0].text, /不重复发送/);
  assert.equal(duplicateSends, 0);
});

test("choosing not to reply clears consumed messages without retriggering the same batch", async (t) => {
  const { store, context, active } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  await context.liveTool("end_conversation", {}, active);
  const removed = await store.completeLiveConversation("12345", { lastReadSequence: context.lastReadSequence });
  assert.deepEqual(removed.map((message) => message.messageId), ["m1"]);
  assert.equal(store.snapshot("12345").pendingMessages.length, 0);
  const triggers = new TriggerManager({ store, messageCount: 1 });
  assert.equal(await triggers.reconsiderPending("12345"), null);
});

test("a completed periodic turn consumes messages it read even without a QQ action", async (t) => {
  const { store, context, active } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  await context.liveTool("end_conversation", {}, active);
  const removed = await store.completeLiveConversation("12345", {
    trigger: { reason: "scheduled" },
    lastReadSequence: context.lastReadSequence,
    consumeReadWithoutReply: true
  });
  assert.deepEqual(removed.map((message) => message.messageId), ["m1"]);
  assert.equal(store.snapshot("12345").pendingMessages.length, 0);
  assert.equal(store.snapshot("12345").lastCompletedReply, null);
});

test("silent periodic completion clears only the pages actually read, not unread or later messages", async (t) => {
  const { store, context, active, append } = await fixture(t);
  for (let n = 2; n <= 42; n++) await append(`m${n}`, `批次消息${n}`);
  const firstPage = await context.liveTool("read_messages", {}, active);
  assert.match(firstPage.content[0].text, /还有未读取的消息/);
  assert.equal(context.lastReadSequence, 40);
  await append("m43", "模型读取后才到的消息");
  const removed = await store.completeLiveConversation("12345", {
    trigger: { reason: "scheduled" },
    lastReadSequence: context.lastReadSequence,
    consumeReadWithoutReply: true
  });
  assert.equal(removed.length, 40);
  assert.deepEqual(store.snapshot("12345").pendingMessages.map((item) => item.messageId), ["m41", "m42", "m43"]);
});

test("failed periodic turn retains every pending message even after a read", async (t) => {
  const { store, context, active, append } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  await append("m2", "读取后到达");
  await store.failWork("12345", new Error("模型调用失败"));
  assert.deepEqual(store.snapshot("12345").pendingMessages.map((item) => item.messageId), ["m1", "m2"]);
});

test("read_messages can wait for new text without rereading old content", async (t) => {
  const { context, active, append } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  setTimeout(() => append("later", "等待期间的新消息"), 15);
  const next = await context.liveTool("read_messages", { wait_ms: 200 }, active);
  assert.match(next.content[0].text, /等待期间的新消息/);
  assert.doesNotMatch(next.content[0].text, /第一句/);
});

test("the Agent can actively wait for another member before sending again", async (t) => {
  const { context, active, append } = await fixture(t);
  assert.equal((await context.liveTool("wait_for_messages", { seconds: 1 }, active)).isError, true);
  await context.liveTool("read_messages", {}, active);
  assert.equal((await context.liveTool("wait_for_messages", { seconds: 31 }, active)).isError, true);
  setTimeout(() => append("reply", "其他人接话了"), 20);
  const waited = await context.liveTool("wait_for_messages", { seconds: 1 }, active);
  assert.match(waited.content[0].text, /其他人接话了/);
  assert.equal(context.lastReadSequence, 2);
});

test("an image received after turn start is held for the next visual turn", async (t) => {
  const { store, context, active } = await fixture(t);
  await context.liveTool("read_messages", {}, active);
  await store.appendMessage({
    groupId: "12345", messageId: "new-image", senderId: "67890", senderName: "同学", trust: "UNTRUSTED",
    text: "看这个图", images: [{ localPath: "/tmp/not-read.jpg", mimeType: "image/jpeg" }]
  });
  const next = await context.liveTool("read_messages", {}, active);
  assert.match(next.content[0].text, /留给下一轮/);
  assert.equal(context.lastReadSequence, 1);
  await context.liveTool("send_message", { text: "先回复此前消息" }, active);
  const removed = await store.completeLiveConversation("12345", { lastReadSequence: context.lastReadSequence });
  assert.deepEqual(removed.map((message) => message.messageId), ["m1"]);
  assert.deepEqual(store.snapshot("12345").pendingMessages.map((message) => message.messageId), ["new-image"]);
});

test("reactions, pokes, files, images and OWNER Qzone use the live path without early message cleanup", async (t) => {
  const { store, active } = await fixture(t);
  const sent = [];
  const context = createLiveConversationTools({
    store, targetId: "12345", targetType: "group",
    oneBot: {
      async sendGroupFace(_target, id) { sent.push(["face", id]); return { ok: true }; },
      async sendGroupPoke(_target, userId) { sent.push(["poke", userId]); return { ok: true }; }
    },
    fileManager: {
      async resolveRequests(requests) { return [{ sourcePath: requests[0].sourcePath, name: "demo.txt" }]; },
      async resolveImageRequests(requests) { return [{ sourcePath: requests[0].sourcePath, name: "demo.png" }]; },
      async upload() { sent.push(["file"]); return { ok: true }; },
      async sendImage() { sent.push(["image"]); return { ok: true }; }
    },
    stickerManager: {
      resolveRequests() { return [{ id: "st_0123456789ab", usage: "开心" }]; },
      async sendSticker() { sent.push(["sticker"]); return { ok: true }; }
    },
    qzone: {
      isOwnerPostTurn() { return true; },
      async executeManual() { sent.push(["qzone"]); return { notices: ["已用老代的小号发布 QQ 空间动态。"] }; }
    },
    trigger: { reason: "mention", trust: "OWNER" }, triggerMessages: [{ senderId: "67890", trust: "OWNER" }],
    security: { allowQqFiles: true, allowedFileRoots: null }, initialImageSequence: 1,
    renderMessages: (messages) => messages.map((message) => message.text).join("\n"),
    pokeSenderId: "67890", allowedPokeUserIds: ["67890"],
    stickers: [{ id: "st_0123456789ab", usage: "开心" }]
  });
  await context.liveTool("read_messages", {}, active);
  for (const [name, args] of [
    ["send_reaction", { face: "微笑" }],
    ["send_reaction", { sticker_id: "st_0123456789ab" }],
    ["poke_member", { user_id: "sender" }],
    ["send_file", { path: "/tmp/demo.txt" }],
    ["send_image", { path: "/tmp/demo.png" }],
    ["post_qzone", { content: "测试动态" }]
  ]) {
    const response = await context.liveTool(name, args, active);
    assert.equal(response.isError, false, `${name}: ${response.content[0].text}`);
  }
  assert.equal(store.snapshot("12345").pendingMessages.length, 1);
  assert.equal(store.snapshot("12345").liveSession.lastReply, "[图片：demo.png]");
  assert.deepEqual(sent.map((item) => item[0]), ["face", "sticker", "poke", "file", "image", "qzone"]);
  await context.liveTool("end_conversation", {}, active);
  await store.completeLiveConversation("12345", { lastReadSequence: context.lastReadSequence });
  assert.equal(store.snapshot("12345").pendingMessages.length, 0);
});
