import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { SharedContexts } from "../src/qq/shared-contexts.js";
import { createSharedContextReader } from "../src/qq/shared-context-reader.js";
import { createLiveConversationTools, prepareLiveConversationPrompt } from "../src/qq/live-conversation.js";
import { compactMessageContext } from "../src/security/message-context.js";
import { toPublicGroupState } from "../src/groups/group-state.js";

const GROUP = "10001", A = "10002", B = "10003";
const text = (result) => result.content.map((item) => item.text || "").join("\n");
async function fixture(t, targetType = "group", targetId = GROUP) {
  const root = await mkdtemp(join(tmpdir(), "qq-incremental-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const groupStore = new SessionStore({ filePath: join(root, "groups.json") });
  const privateStore = new SessionStore({ filePath: join(root, "privates.json") });
  await groupStore.init({ allowedGroups: [GROUP] });
  await privateStore.init({ allowedGroups: [A, B] });
  const sharedContexts = await new SharedContexts({ filePath: join(root, "links.json"), groupStore, privateStore }).init();
  sharedContexts.setPrivateGroup(A, GROUP);
  sharedContexts.setPrivateGroup(B, GROUP);
  const sends = [];
  const oneBot = {
    async sendGroupMessage(id, body, options) { sends.push(["group", id, body, options]); return { ok: true, body: { data: { message_id: 700 + sends.length } } }; },
    async sendPrivateMessage(id, body, options) { sends.push(["private", id, body, options]); return { ok: true, body: { data: { message_id: 700 + sends.length } } }; }
  };
  const append = (type, id, messageId, body, extra = {}) => (type === "group" ? groupStore : privateStore).appendMessage({
    groupId: id, messageId, text: body, senderId: "10005", senderName: "Member", source: "qq", trust: "UNTRUSTED", ...extra
  });
  const store = targetType === "group" ? groupStore : privateStore;
  const incoming = await append(targetType, targetId, "101", "origin message");
  await store.requestTrigger(targetId, "mention", incoming);
  await store.beginWork(targetId);
  const reader = createSharedContextReader({ sharedContexts, groupStore, privateStore, targetType, targetId, oneBot });
  const events = [];
  const context = createLiveConversationTools({ store, targetId, targetType, oneBot, security: {},
    trigger: {}, triggerMessages: [incoming], initialImageSequence: incoming.sequence, readSharedContext: reader,
    onEvent: (event) => events.push(event), renderMessages: (messages) => compactMessageContext(messages).join("\n") });
  const active = { onDelta() {} };
  const call = (name, args = {}) => context.liveTool(name, args, active);
  return { root, groupStore, privateStore, sharedContexts, store, context, reader, append, sends, oneBot, active, call, events };
}

test("read acknowledgements immediately match the panel, survive failure/restart, and never repeat", async (t) => {
  const f = await fixture(t);
  assert.match(text(await f.call("read_messages")), /origin message/);
  let view = toPublicGroupState(f.store.snapshot(GROUP));
  assert.equal(view.unreadCount, 0);
  assert.ok(view.pendingMessages[0].readAt);
  assert.equal(view.pendingCount, 1, "read is not deletion or successful processing");
  assert.doesNotMatch(text(await f.call("read_messages")), /origin message/);
  assert.ok(f.events.some((event) => event.type === "messages-read"));
  await f.store.failWork(GROUP, new Error("model failure"));
  const restarted = new SessionStore({ filePath: f.store.filePath });
  await restarted.init();
  view = toPublicGroupState(restarted.snapshot(GROUP));
  assert.equal(view.pendingCount, 1);
  assert.equal(view.unreadCount, 0);
  const retry = createLiveConversationTools({ store: restarted, targetId: GROUP, targetType: "group", oneBot: {},
    security: {}, triggerMessages: [], initialImageSequence: 0, renderMessages: (messages) => messages.map((m) => m.text).join("\n") });
  assert.doesNotMatch(text(await retry.liveTool("read_messages", {}, {})), /origin message/);
});

test("incoming messages during a send and the confirmed self message share one correct incremental order", async (t) => {
  const f = await fixture(t);
  await f.call("read_messages");
  const normal = f.oneBot.sendGroupMessage;
  f.oneBot.sendGroupMessage = async (...args) => {
    await f.append("group", GROUP, "102", "arrived before send confirmation");
    return normal(...args);
  };
  await f.call("send_message", { text: "my own reply" });
  await f.append("group", GROUP, "103", "arrived after the reply");
  const result = text(await f.call("read_messages"));
  assert.ok(result.indexOf("arrived before send confirmation") < result.indexOf("my own reply"));
  assert.ok(result.indexOf("my own reply") < result.indexOf("arrived after the reply"));
  assert.match(result, /SELF 已发送/);
  assert.doesNotMatch(text(await f.call("read_messages")), /my own reply|arrived before|arrived after/);
  assert.equal(toPublicGroupState(f.store.snapshot(GROUP)).unreadCount, 0);
  assert.equal(f.store.snapshot(GROUP).pendingMessages.length, 3);
  await f.store.completeLiveConversation(GROUP, { lastReadSequence: f.context.lastReadSequence });
  assert.equal(f.store.snapshot(GROUP).outgoingMessages.length, 0);
  assert.equal(f.store.snapshot(GROUP).pendingMessages.length, 0);
});

for (const type of ["group", "private"]) {
  const target = type === "group" ? GROUP : A;
  test(`${type}: active wait immediately drains unread input and SELF in the same order as read_messages`, async (t) => {
    const f = await fixture(t, type, target);
    await f.call("read_messages");
    const method = type === "group" ? "sendGroupMessage" : "sendPrivateMessage";
    const normal = f.oneBot[method];
    f.oneBot[method] = async (...args) => {
      await f.append(type, target, "102", "arrived before send confirmation");
      return normal(...args);
    };
    await f.call("send_message", { text: "my own reply" });
    await f.append(type, target, "103", "arrived after my reply");
    f.store.waitForNewMessages = () => assert.fail("existing unread messages must never start a wait");
    const result = text(await f.call("wait_for_messages", { seconds: 120 }));
    assert.ok(result.indexOf("arrived before send confirmation") < result.indexOf("my own reply"));
    assert.ok(result.indexOf("my own reply") < result.indexOf("arrived after my reply"));
    assert.match(result, /SELF 已发送/);
    assert.doesNotMatch(result, /origin message/);
    const snapshot = f.store.snapshot(target);
    assert.equal(snapshot.pendingMessages.length, 3, "read acknowledgement is not deletion");
    assert.ok([...snapshot.pendingMessages, ...snapshot.outgoingMessages].every((m) => m.readAt));
    assert.doesNotMatch(text(await f.call("read_messages")), /my own reply|arrived before|arrived after/);
  });

  test(`${type}: SELF alone returns without waiting, then an empty unread queue actually waits`, async (t) => {
    const f = await fixture(t, type, target);
    await f.call("read_messages");
    await f.call("send_message", { text: "just sent by me" });
    let waits = 0;
    f.store.waitForNewMessages = async () => {
      waits++;
      await f.append(type, target, "104", "fresh reply while waiting");
    };
    const self = text(await f.call("wait_for_messages", { seconds: 120 }));
    assert.equal(waits, 0);
    assert.match(self, /just sent by me/);
    assert.match(self, /本批只有你已发送的消息/);
    const reply = text(await f.call("wait_for_messages", { seconds: 120 }));
    assert.equal(waits, 1);
    assert.match(reply, /fresh reply while waiting/);
    assert.doesNotMatch(reply, /just sent by me/);
  });
}

test("active wait drains existing unread pages without waiting or repeating an earlier page", async (t) => {
  const f = await fixture(t);
  await f.call("read_messages");
  for (let n = 0; n < 45; n++) await f.append("group", GROUP, String(200 + n), `unread item ${n}`);
  await f.call("send_message", { text: "self after the unread batch" });
  f.store.waitForNewMessages = () => assert.fail("unread pagination must not wait");
  const first = text(await f.call("wait_for_messages", { seconds: 30 }));
  assert.match(first, /unread item 39/);
  assert.doesNotMatch(first, /unread item 40|self after/);
  const second = text(await f.call("wait_for_messages", { seconds: 30 }));
  assert.match(second, /unread item 40/);
  assert.match(second, /self after the unread batch/);
  assert.doesNotMatch(second, /unread item 39/);
  assert.equal(toPublicGroupState(f.store.snapshot(GROUP)).unreadCount, 0);
});

test("active wait preserves the same unseen-image boundary and later SELF receipt as direct reads", async (t) => {
  const f = await fixture(t);
  await f.call("read_messages");
  await f.append("group", GROUP, "102", "before new image");
  await f.append("group", GROUP, "103", "new unseen image", { images: [{ localPath: "/synthetic/new.png" }] });
  await f.call("send_message", { text: "self after the new image" });
  f.store.waitForNewMessages = () => assert.fail("an unseen image must not start a wait");
  const result = text(await f.call("wait_for_messages", { seconds: 30 }));
  assert.match(result, /before new image/);
  assert.doesNotMatch(result, /new unseen image|self after the new image/);
  assert.match(result, /新图片未作为视觉输入/);
  assert.equal(f.context.deferredNewMedia, true);
  assert.ok(!f.store.snapshot(GROUP).pendingMessages.find((m) => m.messageId === "103").readAt);
  assert.ok(!f.store.snapshot(GROUP).outgoingMessages[0].readAt);
});

test("prefetch lists per-channel freshness without reading or clearing another private chat", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "private A text");
  const prompt = await prepareLiveConversationPrompt(f.context, "task");
  assert.match(prompt, /关联渠道新消息状态/);
  assert.doesNotMatch(prompt, /private A text/);
  assert.match(prompt, /"target_id":"10002"[^}]*"unreadCount":1,"hasNewMessages":true/);
  assert.match(prompt, /"target_id":"10003"[^}]*"unreadCount":0,"hasNewMessages":false/);
  assert.equal(f.privateStore.snapshot(A).pendingMessages[0].readAt, undefined);
});

test("explicit shared reads mark only the selected private as read and retain channel-local authorization", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "private A text", { trust: "OWNER", senderId: "100000001" });
  await f.append("private", B, "201", "private B text");
  await f.call("read_messages");
  const selected = text(await f.call("read_context_messages", { target_type: "private", target_id: A }));
  assert.match(selected, /private A text/);
  assert.doesNotMatch(selected, /\[OWNER\]|private B text/);
  assert.ok(f.privateStore.snapshot(A).pendingMessages[0].readAt);
  assert.equal(f.privateStore.snapshot(B).pendingMessages[0].readAt, undefined);
  assert.doesNotMatch(text(await f.call("read_context_messages", { target_type: "private", target_id: A })), /private A text/);
  assert.equal(f.context.canReplyToMessage("201"), false);
  assert.equal(f.context.allowQzonePost, false);
  assert.equal(f.context.allowQzoneFeed, false);
});

test("shared sending requires a selected destination and routes to exactly that private, with a local receipt", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "private A text");
  await f.append("private", B, "201", "private B text");
  const args = { target_type: "private", target_id: A, text: "reply to A", reply_to_message_id: "201" };
  assert.equal((await f.call("send_context_message", args)).isError, true);
  await f.call("read_messages");
  assert.equal((await f.call("send_context_message", args)).isError, true);
  await f.call("read_context_messages", { target_type: "private", target_id: A });
  assert.equal((await f.call("send_context_message", { ...args, target_id: B })).isError, true);
  assert.equal((await f.call("send_context_message", args)).isError, false);
  assert.deepEqual(f.sends, [["private", A, "reply to A", { replyToMessageId: "201" }]]);
  assert.equal(f.privateStore.snapshot(A).outgoingMessages[0].text, "reply to A");
  assert.equal(f.privateStore.snapshot(A).pendingMessages.length, 1);
  assert.equal(f.privateStore.snapshot(B).outgoingMessages.length, 0);
  assert.equal(f.context.actionCount, 1, "external sends forbid replaying the original task");
  const timeline = text(await f.call("read_context_messages", { target_type: "private", target_id: A }));
  assert.match(timeline, /reply to A/);
  assert.doesNotMatch(timeline, /private A text/);
});

test("private origins can explicitly send to the associated group, not an arbitrary group or source", async (t) => {
  const f = await fixture(t, "private", A);
  await f.append("group", GROUP, "301", "group text");
  await f.call("read_messages");
  await f.call("read_context_messages", { target_type: "group", target_id: GROUP });
  assert.equal((await f.call("send_context_message", { target_type: "group", target_id: GROUP, text: "group reply" })).isError, false);
  assert.equal((await f.call("send_context_message", { target_type: "group", target_id: "99999", text: "no" })).isError, true);
  assert.deepEqual(f.sends.map((item) => item.slice(0, 3)), [["group", GROUP, "group reply"]]);
});

test("associated-group poke events are readable but cannot be quoted through linked-channel sending", async (t) => {
  const f = await fixture(t, "private", A);
  await f.append("group", GROUP, "901", "member poked another member", { eventType: "poke", pokeTargetId: B });
  await f.call("read_messages");
  const event = text(await f.call("read_context_messages", { target_type: "group", target_id: GROUP }));
  assert.match(event, /member poked another member/);
  const blocked = await f.call("send_context_message", { target_type: "group", target_id: GROUP,
    text: "cannot quote event", reply_to_message_id: "901" });
  assert.equal(blocked.isError, true);
  assert.equal(f.sends.length, 0);
});

test("disabled destinations, cancelled turns, revoked links, and foreign reply IDs fail before transport", async (t) => {
  for (const scenario of ["disabled", "cancelled", "unlinked", "foreign reply", "recalled"]) {
    const f = await fixture(t);
    await f.append("private", A, "201", "private text");
    await f.call("read_messages");
    await f.call("read_context_messages", { target_type: "private", target_id: A });
    const args = { target_type: "private", target_id: A, text: "not sent", reply_to_message_id: "201" };
    if (scenario === "disabled") await f.privateStore.setReplyEnabled(A, false);
    if (scenario === "cancelled") f.active.cancelRequested = true;
    if (scenario === "unlinked") f.sharedContexts.setPrivateGroup(A, null);
    if (scenario === "foreign reply") args.reply_to_message_id = "999";
    if (scenario === "recalled") await f.privateStore.recallMessage(A, "201");
    assert.equal((await f.call("send_context_message", args)).isError, true, scenario);
    assert.equal(f.sends.length, 0, scenario);
  }
});

test("a shared send with an uncertain transport result stops the turn without losing either pending queue", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "private text");
  await f.call("read_messages");
  await f.call("read_context_messages", { target_type: "private", target_id: A });
  f.oneBot.sendPrivateMessage = async () => { throw new Error("connection closed"); };
  assert.equal((await f.call("send_context_message", { target_type: "private", target_id: A, text: "uncertain" })).isError, true);
  assert.equal(f.context.failed, true);
  assert.equal(f.store.snapshot(GROUP).pendingMessages.length, 1);
  assert.equal(f.privateStore.snapshot(A).pendingMessages.length, 1);
  assert.equal((await f.call("send_message", { text: "do not send again" })).isError, true);
  assert.equal(f.sends.length, 0);
});

test("successful shared cleanup removes acknowledged input only and leaves later arrivals and their trigger", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "read private input");
  await f.call("read_messages");
  await f.call("read_context_messages", { target_type: "private", target_id: A });
  const later = await f.append("private", A, "202", "arrived while generating");
  await f.privateStore.requestTrigger(A, "mention", later);
  const processed = await f.context.completeSharedReads();
  assert.deepEqual(processed.map((message) => message.messageId), ["201"]);
  assert.deepEqual(f.privateStore.snapshot(A).pendingMessages.map((message) => message.messageId), ["202"]);
  assert.equal(f.privateStore.snapshot(A).pendingTrigger.messageId, "202");
  assert.equal(f.store.snapshot(GROUP).pendingMessages.length, 1, "foreign cleanup cannot finish the active origin");
});

test("read-cursor reset replays retained input for a new context and rollback restores exact acknowledgements", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "private input");
  await f.call("read_messages");
  await f.call("read_context_messages", { target_type: "private", target_id: A });
  const before = f.privateStore.snapshot(A);
  assert.ok(before.pendingMessages[0].readAt);
  await f.privateStore.resetReadCursor(A);
  assert.equal(f.privateStore.snapshot(A).pendingMessages[0].readAt, undefined);
  await f.privateStore.setReadCursor(A, before);
  assert.equal(f.privateStore.snapshot(A).pendingMessages[0].readAt, before.pendingMessages[0].readAt);
  assert.doesNotMatch(text(await f.call("read_context_messages", { target_type: "private", target_id: A })), /private input/);
});

test("self receipts alone never trigger the periodic model check", async (t) => {
  const f = await fixture(t);
  await f.call("read_messages");
  await f.call("send_message", { text: "last reply" });
  await f.store.completeLiveConversation(GROUP, { lastReadSequence: f.context.lastReadSequence });
  assert.equal(f.store.snapshot(GROUP).pendingMessages.length, 0);
  assert.equal(f.store.snapshot(GROUP).outgoingMessages.length, 1);
  assert.equal(await f.store.requestPeriodicTrigger(GROUP), null);
});

test("shared unread image boundaries preserve the image and following input for its actual visual round", async (t) => {
  const f = await fixture(t);
  await f.append("private", A, "201", "text before image");
  await f.append("private", A, "202", "unseen image", { images: [{ localPath: "/synthetic/pending.png" }] });
  await f.append("private", A, "203", "text after image");
  await f.call("read_messages");
  const result = text(await f.call("read_context_messages", { target_type: "private", target_id: A }));
  assert.match(result, /text before image/);
  assert.doesNotMatch(result, /unseen image|text after image/);
  assert.match(result, /保留图片及后续消息为未读/);
  await f.context.completeSharedReads();
  assert.deepEqual(f.privateStore.snapshot(A).pendingMessages.map((message) => message.messageId), ["202", "203"]);
  assert.ok(f.privateStore.snapshot(A).pendingMessages.every((message) => !message.readAt));
});
