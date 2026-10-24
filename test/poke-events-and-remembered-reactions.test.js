import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { normalizeOneBotGroupPoke } from "../src/qq/message-normalizer.js";
import { QqMessageReader } from "../src/qq/message-reader.js";
import { createLiveConversationTools, currentOwnerManagementMessage } from "../src/qq/live-conversation.js";
import { manageGroup } from "../src/qq/group-management.js";
import { QqStickerStore } from "../src/qq/sticker-store.js";
import { compactMessageContext } from "../src/security/message-context.js";
import { messageLabel } from "../src/security/reply-reference.js";
import { toPublicGroupState } from "../src/groups/group-state.js";

const GROUP = "12345", BOT = "100000002", OWNER = "100000001", MEMBER = "123456789", OTHER = "987654321";
const text = (result) => result.content.map((item) => item.text || "").join("\n");
const poke = (targetId = OTHER, extra = {}) => normalizeOneBotGroupPoke({
  post_type: "notice", notice_type: "notify", sub_type: "poke", self_id: BOT,
  group_id: GROUP, user_id: MEMBER, target_id: targetId, notice_id: "901", ...extra
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qq-poke-reactions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(root, "groups.json") });
  await store.init({ allowedGroups: [GROUP] });
  const trigger = new TriggerManager({ store, allowedGroups: [GROUP] });
  const sends = [], lookups = [];
  const oneBot = {
    async sendGroupMessage(...args) { sends.push(args); return { ok: true }; },
    async getGroupMemberInfo(_group, id) { return { user_id: id, role: id === BOT ? "admin" : "member" }; },
    async getMessage(id) { lookups.push(id); return { message_id: id, group_id: GROUP }; },
    async request(...args) { sends.push(args); return { ok: true, body: { retcode: 0 } }; }
  };
  const start = async (stickerManager = null) => {
    const first = await store.appendMessage({ groupId: GROUP, messageId: "101", senderId: OWNER,
      text: "normal message", trust: "OWNER", source: "qq" });
    await store.requestTrigger(GROUP, "mention", first);
    await store.beginWork(GROUP);
    const reader = new QqMessageReader({ oneBot });
    const context = createLiveConversationTools({ store, targetId: GROUP, targetType: "group", oneBot,
      stickerManager, stickers: stickerManager?.promptCatalog() || [], messageReader: reader,
      security: {}, trigger: {}, triggerMessages: [first], initialImageSequence: first.sequence,
      renderMessages: (messages) => compactMessageContext(messages).join("\n") });
    const call = (name, args = {}) => context.liveTool(name, args, { onDelta() {} });
    await call("read_messages");
    return { first, reader, context, call };
  };
  return { root, store, trigger, sends, lookups, oneBot, start };
}

test("member-to-member pokes enter the message window without becoming immediate bot wake-ups", async (t) => {
  const f = await fixture(t);
  const event = await f.store.appendMessage(poke());
  assert.match(event.messageId, /^poke:/, "even a numeric notice ID is not a native message ID");
  assert.notEqual(event.messageId, poke(OTHER, { group_id: "54321" }).messageId, "notice IDs are scoped to participants and group");
  assert.notEqual(poke(OTHER, { notice_id: 0, message_id: 0, time: 1789279200 }).messageId,
    poke(OTHER, { notice_id: 0, message_id: 0, time: 1789279201 }).messageId, "placeholder zero IDs cannot swallow later pokes");
  assert.equal(event.mentionedBot, false);
  assert.equal(await f.trigger.considerMessage(event), null);
  assert.equal(await f.trigger.reconsiderPending(GROUP), null);
  const view = toPublicGroupState(f.store.snapshot(GROUP));
  assert.equal(view.pendingCount, 1);
  assert.match(view.pendingMessages[0].text, new RegExp(OTHER));
  assert.match(compactMessageContext([event]).join("\n"), /不可引用回复或设精华/);
  assert.match(messageLabel(event, String), /戳一戳事件.*不可引用回复或设精华/);
  assert.equal((await f.store.requestPeriodicTrigger(GROUP)).reason, "scheduled");
  const restarted = new SessionStore({ filePath: f.store.filePath });
  await restarted.init();
  assert.equal(restarted.snapshot(GROUP).pendingMessages[0].eventType, "poke");
});

test("a poke aimed at the bot retains the immediate poke trigger", async (t) => {
  const f = await fixture(t);
  const event = await f.store.appendMessage(poke(BOT));
  assert.equal((await f.trigger.considerMessage(event)).reason, "poke");
  assert.equal((await f.trigger.reconsiderPending(GROUP)).reason, "poke");
});

test("member pokes wake active waits immediately and cannot be quoted, including legacy numeric notice IDs", async (t) => {
  const f = await fixture(t);
  const live = await f.start();
  const event = await f.store.appendMessage(poke());
  await f.store.appendMessage({ ...poke(), messageId: "902" });
  f.store.waitForNewMessages = () => assert.fail("unread poke events must return immediately");
  assert.match(text(await live.call("wait_for_messages", { seconds: 30 })), /戳一戳事件/);
  for (const id of [event.messageId, "902"]) {
    assert.equal(live.context.canReplyToMessage(id), false);
    assert.equal((await live.call("send_message", { text: "no quoted notice", reply_to_message_id: id })).isError, true);
    await assert.rejects(manageGroup({ oneBot: f.oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER,
      ownerMessage: live.first, messageReader: live.reader, args: { action: "pin_message", message_id: id } }), /戳一戳是互动事件/);
    await assert.rejects(manageGroup({ oneBot: f.oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER,
      ownerMessage: live.first, messageReader: live.reader, args: { action: "unpin_message", message_id: id } }), /戳一戳是互动事件/);
  }
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.sends, []);
  assert.equal((await live.call("send_message", { text: "ordinary comment on the interaction" })).isError, false);
});

test("OWNER poke notices cannot authorize high-impact management", async (t) => {
  const f = await fixture(t);
  const event = await f.store.appendMessage(poke(OTHER, { user_id: OWNER }));
  event.trust = "OWNER";
  const reader = new QqMessageReader();
  reader.capture([event]);
  assert.equal(currentOwnerManagementMessage(reader, GROUP, OWNER), null);
  await assert.rejects(manageGroup({ oneBot: f.oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER,
    ownerMessage: event, messageReader: reader, args: { action: "publish_notice", text: "must not send" } }), /需要 OWNER 认可/);
  assert.deepEqual(f.sends, []);
});

test("member pokes participate in the automatic two-minute followup, including arrivals before arming", async (t) => {
  for (const afterArming of [false, true]) {
    const f = await fixture(t);
    const live = await f.start();
    if (afterArming) await f.store.armReplyFollowup(GROUP, { afterSequence: live.first.sequence });
    const event = await f.store.appendMessage(poke());
    if (!afterArming) await f.store.armReplyFollowup(GROUP, { afterSequence: live.first.sequence });
    assert.equal(f.store.snapshot(GROUP).pendingTrigger.reason, "followup");
    assert.equal(f.store.snapshot(GROUP).pendingTrigger.messageId, event.messageId);
    if (afterArming) assert.equal(event.followupWake, true);
  }
});

test("remembered reactions can send without lookup outside the 24-item prompt snapshot and use live validation", async (t) => {
  const f = await fixture(t);
  const manager = new QqStickerStore({ filePath: join(f.root, "stickers.json"), libraryDir: join(f.root, "library") });
  await manager.init();
  const ids = [];
  for (let n = 0; n < 30; n++) {
    const id = `st_${n.toString(16).padStart(12, "0")}`;
    ids.push(id);
    manager.state.stickers[id] = { id, labelStatus: "ready", usage: `适合测试反应 ${n}`,
      localPath: join(f.root, `${id}.png`), createdAt: new Date(2020, 0, n + 1).toISOString() };
  }
  assert.equal(manager.promptCatalog().length, 24);
  assert.equal(manager.promptCatalog({ all: true }).length, 30);
  assert.ok(!manager.promptCatalog().some((item) => item.id === ids[0]));
  const sentIds = [];
  manager.sendSticker = async (_type, _target, sticker) => { sentIds.push(sticker.id); return { ok: true }; };
  const live = await f.start(manager);
  assert.equal((await live.call("send_reaction", { sticker_id: ids[0] })).isError, false);
  assert.deepEqual(sentIds, [ids[0]], "no preceding list_reactions is needed");
  delete manager.state.stickers[ids[0]];
  assert.equal((await live.call("send_reaction", { sticker_id: ids[0] })).isError, true);
  assert.equal(live.context.failed, false, "a known-not-sent stale ID can be searched again");
  const page = JSON.parse(text(await live.call("list_reactions")));
  assert.ok(page.stickers.length <= 8, "full-library validation never dumps the full catalog into the prompt");
  assert.ok(!page.stickers.some((item) => item.id === ids[0]));
  assert.equal((await live.call("send_reaction", { sticker_id: page.stickers[0].id })).isError, false);
  assert.equal(sentIds.length, 2);
});
