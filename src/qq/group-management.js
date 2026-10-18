import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { getAgentName } from "../security/policy.js";

const MEMBER_ID = /^\d{5,14}$/u;
const MESSAGE_ID = /^-?\d+$/u;
const INVITE_POLICIES = new Set(["disabled", "require_approval", "no_approval", "no_approval_under_100"]);
const OWNER_ONLY = new Set([
  "unmute_member", "kick_member", "kick_members", "mute_all", "set_card", "set_group_name", "set_special_title",
  "set_join_options", "set_invite_policy", "set_member_permissions", "set_new_member_history",
  "set_search", "set_portrait", "publish_notice", "delete_notice", "pin_message", "unpin_message", "set_admin"
]);
const OWNER_ROLE_ONLY = new Set(["set_admin", "set_member_permissions"]);
export const GROUP_MANAGEMENT_ACTIONS = Object.freeze(["mute_member", ...OWNER_ONLY]);
const OWNER_INTENT = {
  mute_member: /禁言|闭麦|不许.*说话/u,
  unmute_member: /解除.{0,32}禁言|取消.{0,32}禁言|解封|解禁/u,
  kick_member: /踢|移出|移除|清退/u,
  kick_members: /踢|移出|移除|清退/u,
  mute_all: /全员禁言|解除全员禁言|关闭全员禁言/u,
  set_card: /群名片|群昵称/u,
  set_group_name: /群名|群名称/u,
  set_special_title: /头衔/u,
  set_join_options: /入群|加群|验证问题/u,
  set_invite_policy: /邀请|拉人/u,
  set_member_permissions: /成员权限|成员.*(上传|建群|临时会话)/u,
  set_new_member_history: /新成员.*(历史|消息)/u,
  set_search: /群搜索|搜索群|搜到群/u,
  set_portrait: /群头像/u,
  publish_notice: /群公告|发公告|发布公告/u,
  delete_notice: /群公告|删公告|删除公告/u,
  pin_message: /精华消息|设精华/u,
  unpin_message: /精华消息|取消精华|移除精华/u,
  set_admin: /管理员|群管/u
};
const MEMBER_TARGET_ACTIONS = new Set(["unmute_member", "kick_member", "kick_members", "set_card", "set_special_title", "set_admin"]);

function deny(message) {
  const error = new Error(message);
  error.code = "GROUP_MANAGEMENT_DENIED";
  throw error;
}

function requireId(value, label) {
  const id = String(value ?? "").trim();
  if (!MEMBER_ID.test(id)) deny(`${label}必须是明确的真实 QQ 号。`);
  return id;
}

function requireText(value, label, max, { allowEmpty = false } = {}) {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || [...text].length > max) deny(`${label}长度必须在 ${allowEmpty ? 0 : 1}–${max} 字之间。`);
  return text;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") deny(`${label}必须明确为 true 或 false。`);
  return value;
}

function requireMessageId(value) {
  const id = String(value ?? "").trim();
  if (!MESSAGE_ID.test(id)) deny("请提供真实的 QQ 消息 ID。");
  return id;
}

async function explicitOwnerAuthorization(oneBot, groupId, ownerMessage, action, args) {
  const text = String(ownerMessage?.text || "");
  if (!OWNER_INTENT[action]?.test(text) || /(不要|别|不用|无需|不需要|禁止你)/u.test(text)) return false;
  if (action === "unmute_member" && /全员禁言/u.test(text)) return false;
  if (!/(请|帮我|麻烦|现在|马上|立即|把|将|设置|设为|改为|开启|关闭|取消|删除|踢出|踢掉|禁言|解除|发布|移除)/u.test(text)) return false;
  if (MEMBER_TARGET_ACTIONS.has(action)) {
    const ids = action === "kick_members" ? args.user_ids : [args.user_id];
    if (!Array.isArray(ids) || !ids.length) return false;
    if (ids.some((id) => !text.includes(String(id))
      && !(ownerMessage.mentions || []).some((mention) => String(mention.userId) === String(id)))) {
      if (action !== "unmute_member" || ids.length !== 1 || !ownerMessage.replyToMessageId) return false;
      const quoted = await oneBot.getMessage(ownerMessage.replyToMessageId).catch(() => null);
      if (String(quoted?.group_id || "") !== String(groupId)
        || String(quoted?.user_id ?? quoted?.sender?.user_id ?? "") !== String(ids[0])) return false;
    }
  }
  if (["pin_message", "unpin_message"].includes(action)) {
    const id = String(args.message_id || "");
    if (id !== String(ownerMessage.replyToMessageId || "") && !text.includes(id)) return false;
  }
  return true;
}

async function checkedRequest(oneBot, path, body) {
  const result = await oneBot.request(path, body, { timeoutMs: 10_000 });
  if (!result.ok || (result.body?.retcode != null && Number(result.body.retcode) !== 0)) {
    throw new Error(result.body?.wording || `QQ ${path} 未确认成功`);
  }
  return result.data ?? result.body?.data ?? null;
}

async function currentRole(oneBot, groupId, botId) {
  const member = await oneBot.getGroupMemberInfo(groupId, botId, { noCache: true });
  if (String(member?.user_id || "") !== String(botId)) deny(`无法确认${getAgentName()}当前在本群的身份；不执行管理操作。`);
  return String(member.role || "member").toLowerCase();
}

function listPage(raw, { offset = 0, limit = 30 } = {}) {
  const start = Number(offset);
  const size = Number(limit);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(size) || size < 1 || size > 50) deny("offset 须为非负整数，limit 须在 1–50 之间。");
  const values = Array.isArray(raw) ? raw : (Array.isArray(raw?.notices) ? raw.notices : Array.isArray(raw?.messages) ? raw.messages : []);
  return { total: values.length, offset: start, limit: size, items: values.slice(start, start + size) };
}

export async function readGroupManagement({ oneBot, groupId, botId, args = {} }) {
  const section = String(args.section || "status");
  const role = await currentRole(oneBot, groupId, botId);
  if (section === "status") {
    const [info, settings] = await Promise.all([
      oneBot.getGroupInfo(groupId),
      checkedRequest(oneBot, "/get_group_admin_settings", { group_id: Number(groupId) }).catch(() => null)
    ]);
    return {
      groupId: String(groupId), groupName: info?.group_name || null, botRole: role,
      canManage: role === "admin" || role === "owner",
      automaticLimitedMute: role === "admin" || role === "owner",
      ownerAuthorizedActions: role === "admin" || role === "owner" ? [...OWNER_ONLY].filter((action) => role === "owner" || !OWNER_ROLE_ONLY.has(action)) : [],
      settings: settings ? {
        add_type: settings.add_type, member_invite_policy: settings.member_invite_policy,
        new_member_history_visible: settings.new_member_history_visible,
        no_finger_open: settings.no_finger_open, no_code_finger_open: settings.no_code_finger_open
      } : null,
      memberCount: info?.member_count ?? null,
      wholeBan: info?.group_all_shut ?? null
    };
  }
  if (role !== "admin" && role !== "owner") deny(`${getAgentName()}目前不是这个群的管理员，群管理详情不可用。`);
  const body = { group_id: Number(groupId) };
  if (section === "members") {
    const data = await checkedRequest(oneBot, "/get_group_member_list", body);
    const page = listPage(data, args);
    return { groupId: String(groupId), section, ...page, items: page.items.map(({ user_id, nickname, card, role }) => ({ userId: String(user_id), nickname, card, role })) };
  }
  const endpoints = { mutes: "/get_group_shut_list", notices: "/_get_group_notice", essence: "/get_essence_msg_list" };
  const path = endpoints[section];
  if (!path) deny("未知群管理查询；请选择 status、members、mutes、notices 或 essence。");
  const data = await checkedRequest(oneBot, path, body);
  return { groupId: String(groupId), section, ...listPage(data, args) };
}

async function ordinaryTarget(oneBot, groupId, value, { botId, ownerId, allowSelf = false, allowAdmin = false } = {}) {
  const userId = requireId(value, "目标成员");
  if (userId === String(ownerId)) deny("不能对 OWNER 执行群管理处罚或改动。");
  if (userId === String(botId) && !allowSelf) deny(`不能对${getAgentName()}自己执行此操作。`);
  const member = await oneBot.getGroupMemberInfo(groupId, userId, { noCache: true });
  if (String(member?.user_id || "") !== userId) deny("无法确认目标仍是本群成员。");
  if (userId !== String(botId) && String(member.role || "member") !== "member"
    && !(allowAdmin && String(member.role) === "admin")) deny("不能操作群主或其他管理员。");
  return userId;
}

async function checkedGroupMessage(oneBot, groupId, value) {
  const messageId = requireMessageId(value);
  const message = await oneBot.getMessage(messageId);
  if (String(message?.group_id || "") !== String(groupId)) deny("消息不属于当前群，不能操作。");
  return messageId;
}

export async function manageGroup({ oneBot, groupId, botId, ownerId, ownerMessage = null, messageReader, args = {} }) {
  const action = String(args.action || "");
  if (!GROUP_MANAGEMENT_ACTIONS.includes(action)) deny("未知或未实现的群管理操作。");
  const role = await currentRole(oneBot, groupId, botId);
  if (!["admin", "owner"].includes(role)) deny(`${getAgentName()}目前不是这个群的管理员，管理操作已自动关闭。`);
  const ownerAuthorized = await explicitOwnerAuthorization(oneBot, groupId, ownerMessage, action, args);
  if (OWNER_ONLY.has(action) && !ownerAuthorized) deny("此操作影响较大，只有 OWNER 在当前群直接明确要求才能授权；解除成员禁言请写 QQ 号、@该成员或回复该成员的消息。");
  if (OWNER_ROLE_ONLY.has(action) && role !== "owner") deny(`QQ 只允许群主执行此操作；${getAgentName()}当前只是管理员。`);
  const body = { group_id: Number(groupId) };
  let path;
  let summary;
  if (["mute_member", "unmute_member"].includes(action)) {
    const userId = await ordinaryTarget(oneBot, groupId, args.user_id, { botId, ownerId });
    let duration = action === "unmute_member" ? 0 : Number(args.duration_seconds);
    if (action === "mute_member" && (!Number.isInteger(duration) || duration < 1 || duration > (ownerAuthorized ? 2_592_000 : 600))) {
      deny(`禁言秒数必须在 1–${ownerAuthorized ? 2_592_000 : 600} 之间。`);
    }
    if (!ownerAuthorized && action === "mute_member") {
      const observed = [...((messageReader?.directMessages || messageReader?.messages)?.values() || [])].some((message) =>
        /^-?\d+$/u.test(String(message.messageId || ""))
        && Number.isInteger(Number(message.sequence)) && Number(message.sequence) > 0
        && String(message.groupId) === String(groupId) && String(message.senderId) === userId);
      if (!observed) deny("自主限时禁言只能针对本轮已读到发言的普通成员，不能凭传闻或其他群内容处罚。");
    }
    path = "/set_group_ban";
    Object.assign(body, { user_id: Number(userId), duration });
    summary = duration ? `已禁言 QQ ${userId} ${duration} 秒` : `已解除 QQ ${userId} 的禁言`;
  } else if (["kick_member", "kick_members"].includes(action)) {
    const users = action === "kick_member" ? [args.user_id] : args.user_ids;
    if (!Array.isArray(users) || !users.length || users.length > 5) deny("一次只能明确指定 1–5 名成员。");
    const ids = [];
    for (const user of users) ids.push(await ordinaryTarget(oneBot, groupId, user, { botId, ownerId }));
    if (new Set(ids).size !== ids.length) deny("目标 QQ 号不可重复。");
    await checkedRequest(oneBot, action === "kick_member" ? "/set_group_kick" : "/set_group_kick_members", {
      group_id: Number(groupId), user_id: action === "kick_member" ? Number(ids[0]) : ids.map(Number),
      reject_add_request: args.reject_add_request === true
    });
    return { action, summary: `已踢出 ${ids.map((id) => `QQ ${id}`).join("、")}`, targetUserIds: ids };
  } else if (action === "mute_all") {
    path = "/set_group_whole_ban";
    body.enable = requireBoolean(args.enable, "enable");
    summary = body.enable ? "已开启全员禁言" : "已关闭全员禁言";
  } else if (action === "set_card") {
    const userId = await ordinaryTarget(oneBot, groupId, args.user_id, { botId, ownerId, allowSelf: true });
    path = "/set_group_card";
    Object.assign(body, { user_id: Number(userId), card: requireText(args.text, "群名片", 64, { allowEmpty: true }) });
    summary = `已修改 QQ ${userId} 的群名片`;
  } else if (action === "set_group_name") {
    path = "/set_group_name";
    body.group_name = requireText(args.text, "群名", 60);
    summary = `已将群名改为 ${body.group_name}`;
  } else if (action === "set_special_title") {
    const userId = await ordinaryTarget(oneBot, groupId, args.user_id, { botId, ownerId, allowSelf: true });
    path = "/set_group_special_title";
    Object.assign(body, { user_id: Number(userId), special_title: requireText(args.text, "专属头衔", 30, { allowEmpty: true }) });
    summary = `已修改 QQ ${userId} 的专属头衔`;
  } else if (action === "set_join_options") {
    const addType = Number(args.add_type);
    if (!Number.isInteger(addType) || addType < 0 || addType > 2) deny("add_type 必须明确为 0、1 或 2；请先查看当前群设置。");
    path = "/set_group_add_option";
    body.add_type = addType;
    if (args.group_question != null) body.group_question = requireText(args.group_question, "入群问题", 100, { allowEmpty: true });
    if (args.group_answer != null) body.group_answer = requireText(args.group_answer, "入群答案", 100, { allowEmpty: true });
    summary = "已修改加群选项";
  } else if (action === "set_invite_policy") {
    if (!INVITE_POLICIES.has(String(args.policy || ""))) deny("邀请策略不在 SnowLuma 支持的选项中。");
    path = "/set_group_member_invite_policy";
    body.policy = args.policy;
    summary = `已修改成员邀请策略为 ${args.policy}`;
  } else if (action === "set_member_permissions") {
    path = "/set_group_member_permissions";
    for (const key of ["allow_member_upload_album", "allow_member_temporary_session", "allow_member_create_group"]) {
      if (args[key] != null) body[key] = requireBoolean(args[key], key);
    }
    if (Object.keys(body).length === 1) deny("至少提供一项要修改的成员权限。");
    summary = "已修改群成员权限";
  } else if (action === "set_new_member_history") {
    path = "/set_group_new_member_history_visibility";
    body.visible = requireBoolean(args.visible, "visible");
    summary = body.visible ? "已允许新成员查看历史消息" : "已禁止新成员查看历史消息";
  } else if (action === "set_search") {
    path = "/set_group_search";
    for (const key of ["no_finger_open", "no_code_finger_open"]) {
      if (args[key] != null) {
        if (![0, 1].includes(args[key])) deny(`${key} 只能为 0 或 1。`);
        body[key] = args[key];
      }
    }
    if (Object.keys(body).length === 1) deny("至少提供一项要修改的搜索设置。");
    summary = "已修改群搜索设置";
  } else if (action === "set_portrait") {
    const file = String(args.file || "");
    if (!isAbsolute(file)) deny("群头像必须是明确的本机绝对路径。");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size < 1 || info.size > 1024 * 1024) deny("群头像必须是现有且不超过 1 MB 的图片文件。");
    const bytes = await readFile(file);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!jpeg && !png) deny("群头像只接受 JPEG 或 PNG 图片。");
    path = "/set_group_portrait";
    body.file = `base64://${bytes.toString("base64")}`;
    summary = "已修改群头像";
  } else if (action === "publish_notice") {
    path = "/_send_group_notice";
    body.content = requireText(args.text, "群公告", 2000);
    body.pinned = args.pinned === true ? 1 : 0;
    body.send_to_new_members = args.send_to_new_members === true;
    body.tip_window_type = args.popup === true ? 0 : 1;
    body.confirm_required = args.confirm_required === true ? 1 : 0;
    summary = "已发布群公告";
  } else if (action === "delete_notice") {
    const id = requireText(args.notice_id, "公告 ID", 128);
    path = "/_del_group_notice";
    body.notice_id = id;
    summary = `已删除群公告 ${id}`;
  } else if (["pin_message", "unpin_message"].includes(action)) {
    const messageId = await checkedGroupMessage(oneBot, groupId, args.message_id);
    path = action === "pin_message" ? "/set_essence_msg" : "/delete_essence_msg";
    delete body.group_id;
    body.message_id = Number(messageId);
    summary = action === "pin_message" ? `已设为精华消息 ${messageId}` : `已移除精华消息 ${messageId}`;
  } else if (action === "set_admin") {
    const enable = requireBoolean(args.enable, "enable");
    const userId = await ordinaryTarget(oneBot, groupId, args.user_id, { botId, ownerId, allowAdmin: !enable });
    path = "/set_group_admin";
    Object.assign(body, { user_id: Number(userId), enable });
    summary = `${body.enable ? "已设置" : "已取消"} QQ ${userId} 的管理员身份`;
  }
  await checkedRequest(oneBot, path, body);
  return { action, summary, targetUserId: body.user_id == null ? null : String(body.user_id) };
}
