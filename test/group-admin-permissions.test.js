import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { QqMessageReader } from "../src/qq/message-reader.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { manageGroup, readGroupManagement } from "../src/qq/group-management.js";
import { toPublicGroupState } from "../src/groups/group-state.js";
import { compactMessageContext } from "../src/security/message-context.js";
import { gatewaySystemInstructions } from "../src/security/policy.js";

const GROUP = "12345";
const BOT = "100000002";
const OWNER = "100000001";
const MEMBER = "123456789";
const ADMIN_OTHER = "223456789";

function makeFakeOneBot({ botRole = "admin" } = {}) {
  const requests = [];
  const oneBot = {
    requests,
    async getGroupInfo(groupId) { return { group_id: Number(groupId), group_name: "Test Group", member_count: 10 }; },
    async getGroupMemberInfo(_groupId, userId) {
      const id = String(userId);
      if (id === BOT) return { user_id: Number(id), role: botRole };
      if (id === OWNER) return { user_id: Number(id), role: "owner" };
      if (id === ADMIN_OTHER) return { user_id: Number(id), role: "admin" };
      return { user_id: Number(id), role: "member" };
    },
    async getMessage(messageId) { return { message_id: Number(messageId), group_id: Number(GROUP) }; },
    async request(path, body) {
      requests.push({ path, body });
      return { ok: true, data: {}, body: { retcode: 0, data: {} } };
    }
  };
  return oneBot;
}

test("manageGroup enforces groupEssenceEnabled and allows autonomous essence when enabled", async () => {
  const oneBot = makeFakeOneBot({ botRole: "admin" });
  const reader = new QqMessageReader({ oneBot });

  await assert.rejects(
    manageGroup({
      oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, messageReader: reader,
      args: { action: "pin_message", message_id: "777" },
      permissions: { groupEssenceEnabled: false, groupMuteEnabled: false }
    }),
    /未开启「允许设置精华消息」/
  );
  await assert.rejects(
    manageGroup({
      oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, messageReader: reader,
      args: { action: "unpin_message", message_id: "777" },
      permissions: { groupEssenceEnabled: false, groupMuteEnabled: false }
    }),
    /未开启「允许设置精华消息」/
  );
  assert.equal(oneBot.requests.length, 0);

  const pinRes = await manageGroup({
    oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
    args: { action: "pin_message", message_id: "777" },
    permissions: { groupEssenceEnabled: true, groupMuteEnabled: false }
  });
  assert.equal(pinRes.action, "pin_message");
  assert.deepEqual(oneBot.requests.at(-1), { path: "/set_essence_msg", body: { message_id: 777 } });

  const unpinRes = await manageGroup({
    oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
    args: { action: "unpin_message", message_id: "777" },
    permissions: { groupEssenceEnabled: true, groupMuteEnabled: false }
  });
  assert.equal(unpinRes.action, "unpin_message");
  assert.deepEqual(oneBot.requests.at(-1), { path: "/delete_essence_msg", body: { message_id: 777 } });

  const status = await readGroupManagement({
    oneBot, groupId: GROUP, botId: BOT,
    args: { section: "status" },
    permissions: { groupEssenceEnabled: true, groupMuteEnabled: false }
  });
  assert.equal(status.canManage, true);
  assert.equal(status.groupEssenceEnabled, true);
  assert.equal(status.groupMuteEnabled, false);
  assert.equal(status.automaticEssence, true);
  assert.equal(status.automaticLimitedMute, false);
});

test("manageGroup enforces groupMuteEnabled and still protects OWNER/admins and mute_all", async () => {
  const oneBot = makeFakeOneBot({ botRole: "admin" });
  const reader = new QqMessageReader({ oneBot });
  reader.capture([
    { messageId: "501", groupId: GROUP, senderId: MEMBER, sequence: 1, source: "qq", trust: "UNTRUSTED", text: "spam" },
    { messageId: "502", groupId: GROUP, senderId: OWNER, sequence: 2, source: "qq", trust: "OWNER", text: "hi" },
    { messageId: "503", groupId: GROUP, senderId: ADMIN_OTHER, sequence: 3, source: "qq", trust: "UNTRUSTED", text: "admin" }
  ]);

  for (const action of ["mute_member", "unmute_member", "mute_all"]) {
    await assert.rejects(
      manageGroup({
        oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, messageReader: reader,
        args: { action, user_id: MEMBER, duration_seconds: 120, enable: true },
        permissions: { groupEssenceEnabled: false, groupMuteEnabled: false }
      }),
      /未开启「允许管理群禁言」/
    );
  }

  const muteRes = await manageGroup({
    oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
    args: { action: "mute_member", user_id: MEMBER, duration_seconds: 300 },
    permissions: { groupEssenceEnabled: false, groupMuteEnabled: true }
  });
  assert.equal(muteRes.action, "mute_member");
  assert.deepEqual(oneBot.requests.at(-1), { path: "/set_group_ban", body: { group_id: Number(GROUP), user_id: Number(MEMBER), duration: 300 } });

  const unmuteRes = await manageGroup({
    oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
    args: { action: "unmute_member", user_id: MEMBER },
    permissions: { groupEssenceEnabled: false, groupMuteEnabled: true }
  });
  assert.equal(unmuteRes.action, "unmute_member");
  assert.deepEqual(oneBot.requests.at(-1), { path: "/set_group_ban", body: { group_id: Number(GROUP), user_id: Number(MEMBER), duration: 0 } });

  // mute_all still requires OWNER approval even when groupMuteEnabled is true
  await assert.rejects(
    manageGroup({
      oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
      args: { action: "mute_all", enable: true },
      permissions: { groupEssenceEnabled: false, groupMuteEnabled: true }
    }),
    /需要 OWNER 认可/
  );

  // Never allow muting OWNER or other admins
  await assert.rejects(
    manageGroup({
      oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
      args: { action: "mute_member", user_id: OWNER, duration_seconds: 60 },
      permissions: { groupEssenceEnabled: false, groupMuteEnabled: true }
    }),
    /不能对 OWNER/
  );
  await assert.rejects(
    manageGroup({
      oneBot, groupId: GROUP, botId: BOT, ownerId: OWNER, ownerMessage: null, messageReader: reader,
      args: { action: "mute_member", user_id: ADMIN_OTHER, duration_seconds: 60 },
      permissions: { groupEssenceEnabled: false, groupMuteEnabled: true }
    }),
    /不能操作群主或其他管理员/
  );
});

test("SessionStore persists groupEssenceEnabled/groupMuteEnabled and read_messages emits admin & sticker guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-group-admin-perms-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ filePath: join(root, "groups.json") });
  await store.init({ allowedGroups: [GROUP] });

  assert.equal(store.snapshot(GROUP).agentConfig.groupEssenceEnabled, false);
  assert.equal(store.snapshot(GROUP).agentConfig.groupMuteEnabled, false);

  const publicDefault = toPublicGroupState(store.snapshot(GROUP), null, { groupName: "G", botRole: "admin" });
  assert.equal(publicDefault.botRole, "admin");
  assert.equal(publicDefault.isBotGroupAdmin, true);

  await store.setAgentConfig(GROUP, {
    ...store.snapshot(GROUP).agentConfig,
    groupEssenceEnabled: true,
    groupMuteEnabled: true
  });

  const reloaded = new SessionStore({ filePath: join(root, "groups.json") });
  await reloaded.init({ allowedGroups: [GROUP] });
  assert.equal(reloaded.snapshot(GROUP).agentConfig.groupEssenceEnabled, true);
  assert.equal(reloaded.snapshot(GROUP).agentConfig.groupMuteEnabled, true);

  const msg = await store.appendMessage({
    groupId: GROUP, messageId: "801", senderId: MEMBER, text: "hello", trust: "UNTRUSTED", source: "qq"
  });
  await store.requestTrigger(GROUP, "mention", msg);
  await store.beginWork(GROUP);

  const oneBot = makeFakeOneBot({ botRole: "admin" });
  const reader = new QqMessageReader({ oneBot });
  const fakeStickerManager = { promptCatalog: () => [{ id: "st_1234567890abcdef", usage: "哈哈" }] };
  const context = createLiveConversationTools({
    store, targetId: GROUP, targetType: "group", oneBot,
    stickerManager: fakeStickerManager, stickers: fakeStickerManager.promptCatalog(),
    messageReader: reader, security: {}, trigger: {}, triggerMessages: [msg],
    initialImageSequence: msg.sequence,
    renderMessages: (messages) => compactMessageContext(messages).join("\n")
  });
  const firstRead = await context.liveTool("read_messages", {}, { onDelta() {} });
  const firstReadText = firstRead.content.map((item) => item.text || "").join("\n");
  assert.match(firstReadText, /【当前群管自主权限（已开启）】/);
  assert.match(firstReadText, /设置精华消息/);
  assert.match(firstReadText, /管理群禁言/);
  assert.match(firstReadText, /【表情包引导】/);

  // Verify disabled switches emit closed notice
  await store.setAgentConfig(GROUP, {
    ...store.snapshot(GROUP).agentConfig,
    groupEssenceEnabled: false,
    groupMuteEnabled: false
  });
  const msg2 = await store.appendMessage({
    groupId: GROUP, messageId: "802", senderId: MEMBER, text: "world", trust: "UNTRUSTED", source: "qq"
  });
  const context2 = createLiveConversationTools({
    store, targetId: GROUP, targetType: "group", oneBot,
    messageReader: new QqMessageReader({ oneBot }), security: {}, trigger: {},
    triggerMessages: [msg2], initialImageSequence: msg2.sequence,
    renderMessages: (messages) => compactMessageContext(messages).join("\n")
  });
  const closedRead = await context2.liveTool("read_messages", {}, { onDelta() {} });
  const closedText = closedRead.content.map((item) => item.text || "").join("\n");
  assert.match(closedText, /自主设置精华消息：已关闭；管理群禁言：已关闭/);

  // System instructions mention both toggles and active sticker guidance
  const sys = gatewaySystemInstructions();
  assert.match(sys, /允许设置精华消息/);
  assert.match(sys, /允许管理群禁言/);
  assert.match(sys, /积极、高频地使用 send_reaction/);
});
