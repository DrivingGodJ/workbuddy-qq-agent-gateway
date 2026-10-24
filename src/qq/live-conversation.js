import { setTimeout as pause } from "node:timers/promises";
import { createHash } from "node:crypto";
import { handleQqMcpTool } from "./mcp-actions.js";
import { QQ_FACE_ALIASES } from "./file-directive.js";
import { AGENT_QQ_ID, OWNER_QQ_ID, sanitizeGroupReply } from "../security/policy.js";
import { QqMessageReader, MESSAGE_READER_TOOLS } from "./message-reader.js";
import { readGroupManagement, manageGroup } from "./group-management.js";
import { conversationReadSequence, unreadConversationMessages } from "../groups/group-state.js";
import { homeAssistantRequest } from "../automation/home-assistant.js";

const PAGE_SIZE = 40;
const MAX_WAIT_MS = 8000;
const MAX_ACTIVE_WAIT_SECONDS = 30;
const SCHEDULED_QZONE_FEED_TOOLS = new Set(["read_qzone_feed_batch", "submit_qzone_decisions"]);
const SCHEDULED_QZONE_POST_TOOLS = new Set(["propose_qzone_post", "skip_qzone_post"]);

function answer(text, isError = false) {
  return { isError, content: [{ type: "text", text: String(text) }] };
}

/** Only a directly read OWNER group message in this turn may authorize management. */
export function currentOwnerManagementMessage(messageReader, groupId, ownerId, isRecalled = () => false) {
  return [...((messageReader?.directMessages || messageReader?.messages)?.values() || [])]
    .filter((message) => String(message.groupId) === String(groupId)
      && String(message.senderId) === String(ownerId) && message.trust === "OWNER"
      && message.source === "qq" && Number.isInteger(Number(message.sequence))
      && Number(message.sequence) > 0 && !isRecalled(message.messageId))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence)).at(-1) || null;
}

/** Only unread QQ messages actually captured from this target can elevate Space access. */
function currentOwnerQzoneMessages(store, messageReader, targetId) {
  const pending = new Set(store.snapshot(targetId).pendingMessages.map((message) => String(message.messageId)));
  return [...(messageReader.directMessages || messageReader.messages).values()].filter((message) =>
    pending.has(String(message.messageId)) && String(message.groupId) === String(targetId)
      && String(message.senderId) === OWNER_QQ_ID && message.trust === "OWNER"
      && message.source === "qq" && Number.isInteger(Number(message.sequence))
      && Number(message.sequence) > 0 && !store.isRecalled?.(targetId, message.messageId))
    .map((message) => ({ ...message, currentOwnerMessage: true }));
}

/** Prepare the first bounded page using the real MCP reader, not a second history. */
export async function prepareLiveConversationPrompt(context, prompt) {
  if (!context?.liveMode || !context.requireRead || context.readCalled) return prompt;
  const result = await context.liveTool("read_messages", {}, { cancelRequested: false });
  if (result?.isError || !context.readCalled) {
    const detail = result?.content?.find((item) => item.type === "text")?.text;
    throw new Error(detail || "本轮消息预读取失败；待处理消息仍保留");
  }
  return [
    "【网关预读取结果】",
    ...result.content.filter((item) => item.type === "text").map((item) => item.text),
    String(prompt || "")
  ].join("\n\n");
}

/** The scope and callback never leave the Node gateway process. */
export function createLiveConversationTools({
  store, targetId, targetType, oneBot, fileManager, stickerManager, qzone, homeAssistant = null,
  trigger, triggerMessages, security, initialImageSequence, renderMessages,
  pokeSenderId = null, allowedPokeUserIds = [], stickers = [], canRun = () => true,
  readOnlyContextMessages = [], messageReader = new QqMessageReader({ oneBot }), onEvent = () => {},
  scheduledTask = false, qzoneActions = null, readSharedContext = null
}) {
  const context = {
    liveMode: true,
    canRead: () => canRun() && !context.failed && !context.ended,
    targetType,
    allowMessage: true,
    allowFiles: targetType === "group" && Boolean(security.allowQqFiles),
    allowImages: Boolean(security.allowQqFiles),
    allowReactions: true,
    allowPoke: targetType === "group",
    allowQzonePost: scheduledTask && Boolean(qzoneActions) || Boolean(qzone?.isOwnerAutonomousTurn?.(triggerMessages, trigger, targetType, targetId)
      || qzone?.isOwnerPostTurn(triggerMessages, trigger, targetType, targetId)),
    allowQzoneFeed: scheduledTask && Boolean(qzoneActions) || Boolean(qzone?.isOwnerFeedTurn?.(triggerMessages, trigger, targetType, targetId)),
    stickers, pokeSenderId, allowedPokeUserIds,
    canReplyToMessage: (messageId) => {
      const message = messageReader.messages.get(String(messageId));
      return Boolean(message && String(message.groupId) === String(targetId)
        && !store.isRecalled?.(targetId, messageId));
    },
    requireRead: !scheduledTask,
    scheduledTask,
    scheduledQzonePost: scheduledTask,
    qzoneReadCalled: false,
    readCalled: false,
    // Read acknowledgements live on the shared message state, independently
    // of the successful-processing cutoff retained here for cleanup.
    lastReadSequence: scheduledTask ? 0 : Math.max(conversationReadSequence(store.snapshot(targetId)),
      Number(store.snapshot(targetId).liveSession?.lastReadSequence || 0)),
    actionCount: 0,
    managementActionCount: (store.snapshot(targetId).liveSession?.actions || [])
      .filter((item) => item.kind === "group_management").length,
    qzoneActionCount: (store.snapshot(targetId).liveSession?.actions || [])
      .filter((item) => item.kind === "qzone_engagement").length,
    displayedActions: [],
    ended: false,
    deferredNewMedia: false,
    failed: false
  };
  const recoveredMessages = (store.snapshot(targetId).liveSession?.actions || [])
    .filter((item) => item.kind === "message" && !item.recalledAt)
    .map((item) => `${Number(item.observedSequence || 0)}:${String(item.summary || "")}`);
  const qzoneFeeds = new Map();
  const homeReadIds = new Set();
  const homeAttempts = new Set();
  context.completeSharedReads = () => readSharedContext?.complete?.() || [];

  const currentQzoneMessages = () => [...(triggerMessages || []),
    ...currentOwnerQzoneMessages(store, messageReader, targetId)];
  const refreshQzonePermissions = () => {
    if (scheduledTask) return;
    const messages = currentQzoneMessages();
    context.allowQzonePost = Boolean(qzone?.isOwnerAutonomousTurn?.(messages, trigger, targetType, targetId)
      || qzone?.isOwnerPostTurn(messages, trigger, targetType, targetId));
    context.allowQzoneFeed = Boolean(qzone?.isOwnerFeedTurn?.(messages, trigger, targetType, targetId));
  };

  context.liveTool = async (name, args = {}, active) => {
    if (active?.cancelRequested || !canRun()) return answer("本轮已停止或回复开关已关闭，不能再操作 QQ。", true);
    if (context.failed) return answer("本轮发送状态有误，已停止操作；待处理消息仍保留。", true);
    if (context.ended && name !== "end_conversation") return answer("本轮对话已经结束，不能再读取或发送。", true);
    if (name === "read_context_messages") {
      if (!context.readCalled) return answer("请先读取当前会话消息，再查看关联渠道上下文。", true);
      if (!readSharedContext) return answer("当前会话尚未关联共享上下文；不能读取其他渠道。");
      return readSharedContext(args, active);
    }
    if (name === "send_context_message") {
      if (!context.readCalled) return answer("请先读取当前会话，再选择关联渠道发送。", true);
      if (!readSharedContext?.send) return answer("当前没有可发送的关联渠道。", true);
      const result = await readSharedContext.send(args, active);
      if (result.deliveryUncertain) context.failed = true;
      if (!result.isError) {
        context.actionCount += 1;
        context.displayedActions.push(`[已发送到关联渠道 ${args.target_type}:${args.target_id}]`);
        try { active?.onDelta?.("", context.displayedActions.join("\n\n")); } catch { /* delivery is already confirmed */ }
      }
      return result;
    }
    if (["read_home_devices", "control_home_device", "speak_home_speaker"].includes(name)) {
      if (!context.readCalled) return answer("请先读取当前会话消息，再使用家居工具。", true);
      try {
        if (!homeAssistant) throw new Error("智能家居尚未配置。");
        const authorization = () => {
          if (active?.cancelRequested || context.ended || context.failed || !canRun()) throw new Error("本轮已停止，未发送家居指令。");
          store.assertReplyEnabled(targetId);
          return homeAssistantRequest({ store, messageReader, targetId, targetType, ownerId: OWNER_QQ_ID,
            messageId: args.request_message_id, scheduledTask });
        };
        const requestMessage = authorization();
        if (name === "read_home_devices") {
          const result = await homeAssistant.read(args);
          authorization();
          for (const device of result.devices) homeReadIds.add(device.entity_id);
          return answer(JSON.stringify(result));
        }
        if (!homeReadIds.has(args.entity_id)) throw new Error("先用 read_home_devices 查询真实设备、可用服务和参数，不能猜实体 ID。");
        const actionKey = createHash("sha256").update(JSON.stringify([
          targetType, targetId, requestMessage.messageId, name, args.entity_id, args.service || "speak",
          name === "speak_home_speaker" ? (typeof args.text === "string" ? args.text.trim() : args.text) : Object.entries(args.data || {}).sort(([a], [b]) => a.localeCompare(b))
        ])).digest("hex").slice(0, 24);
        const prior = (store.snapshot(targetId).liveSession?.actions || []).some((item) =>
          item.kind === "home_assistant_attempt" && String(item.summary).startsWith(`[${actionKey}] `));
        if (prior || homeAttempts.has(actionKey)) throw new Error("相同家居请求此前已经尝试；即使曾中断或超时，也不能自动重复执行。请查询状态或等待新的明确请求。");
        const beforeSend = async () => {
          authorization();
          if (homeAttempts.has(actionKey)) throw new Error("相同家居动作已登记，禁止并行重复执行。");
          homeAttempts.add(actionKey);
          // Durable attempt BEFORE physical effects: a crash must not repeat a toggle or IR command.
          await store.claimHomeActionAttempt(targetId, actionKey);
          await store.recordLiveActionSent(targetId, { kind: "home_assistant_attempt",
            summary: `[${actionKey}] ${args.entity_id}/${args.service || "speak"} 已登记，执行结果以工具回执为准`,
            observedSequence: context.lastReadSequence, chatReply: false });
          authorization();
        };
        const result = name === "speak_home_speaker"
          ? await homeAssistant.speak(args, { requestText: requestMessage.text, beforeSend })
          : await homeAssistant.control(args, { ownerText: requestMessage.text, beforeSend });
        context.actionCount += 1;
        const summary = name === "speak_home_speaker" ? "[小爱音箱：播报指令已接受]"
          : `[智能家居：${result.entity_id}/${result.service} 指令已接受]`;
        context.displayedActions.push(summary);
        try { onEvent({ type: "home-assistant-action", targetType, targetId, entityId: args.entity_id,
          service: args.service, at: new Date().toISOString() }); active?.onDelta?.("", context.displayedActions.join("\n\n")); }
        catch { /* an accepted physical command must never be repeated because display failed */ }
        return answer(JSON.stringify(result));
      } catch (error) {
        const code = error.code || "HOME_ASSISTANT_REQUEST_FAILED";
        const category = code === "HOME_ASSISTANT_PERMISSION_DENIED" ? "permission"
          : code === "HOME_ASSISTANT_OFFLINE" ? "network"
          : code === "HOME_ASSISTANT_UNCERTAIN" ? "uncertain" : "request";
        return answer(JSON.stringify({ error: { code, category, message: error.message },
          note: category === "network" ? "此次读取未能连通 HA；如实说明连接失败。"
            : category === "uncertain" ? "物理操作结果未知，不要自动重试。"
            : "这是授权、请求或参数检查未通过，不能说成 HA 连接失败；按实际原因说明。" }), true);
      }
    }
    if (SCHEDULED_QZONE_FEED_TOOLS.has(name)) {
      return answer("旧版动态读取工具已停用。请用 read_qzone_feeds 读取，再按需用 engage_qzone_feed 点赞或评论。", true);
    }
    if (SCHEDULED_QZONE_POST_TOOLS.has(name)) {
      return answer("旧版动态发布提议工具已停用。需要发布时用 post_qzone；不想发布可直接结束轮次。", true);
    }
    if (MESSAGE_READER_TOOLS.has(name)) {
      if (!context.readCalled) return answer("请先读取当前会话的消息，再展开转发或打开链接。", true);
      return messageReader.callTool(name, args, { shouldStop: () => active?.cancelRequested || !canRun() });
    }
    if (name === "end_conversation") {
      if (!scheduledTask && !context.readCalled) return answer("请先调用 read_messages 读取当前消息，再决定结束。", true);
      if (!scheduledTask && !context.ended) await store.armReplyFollowup(targetId, {
        deferredImageAfterSequence: context.deferredNewMedia ? context.lastReadSequence : null
      });
      context.ended = true;
      return answer(scheduledTask
        ? "本次定时模型轮次已结束；读取过的聊天消息仍留在原来的待处理队列，后续任务继续按顺序执行。"
        : "本轮结束；网关观察两分钟，有新消息会重新唤醒你自行判断是否回复，安静两分钟才退出。请直接结束模型轮次，不再输出发送正文。");
    }
    if (name === "read_messages" || name === "wait_for_messages") {
      const activeWait = name === "wait_for_messages";
      if (activeWait && !context.readCalled) return answer("请先调用 read_messages 读取当前消息，再主动等待新消息。", true);
      const requestedWait = activeWait ? Number(args.seconds) * 1000 : Number(args.wait_ms ?? 0);
      if (activeWait && (!Number.isInteger(Number(args.seconds)) || Number(args.seconds) < 1 || Number(args.seconds) > MAX_ACTIVE_WAIT_SECONDS)) {
        return answer(`seconds 必须在 1–${MAX_ACTIVE_WAIT_SECONDS} 之间；需要更久可以再次等待。`, true);
      }
      if (!activeWait && (!Number.isInteger(requestedWait) || requestedWait < 0 || requestedWait > MAX_WAIT_MS)) {
        return answer(`wait_ms 必须在 0–${MAX_WAIT_MS} 之间。`, true);
      }
      const deadline = Date.now() + requestedWait;
      let snapshot;
      do {
        if (active?.cancelRequested || !canRun()) return answer("本轮已停止或回复开关已关闭。", true);
        store.assertReplyEnabled(targetId);
        snapshot = store.snapshot(targetId);
        // Both tools drain the same unread timeline (including SELF) before waiting.
        if (!context.readCalled || unreadConversationMessages(snapshot).length) break;
        if (Date.now() >= deadline) break;
        if (store.waitForNewMessages) await store.waitForNewMessages(targetId, {
          afterSequence: context.lastReadSequence, timeoutMs: deadline - Date.now(),
          shouldStop: () => active?.cancelRequested || !canRun() || store.snapshot(targetId).replyEnabled === false
        });
        else await pause(Math.min(250, deadline - Date.now()));
      } while (true);
      const fresh = unreadConversationMessages(snapshot);
      const firstBlockedMedia = fresh.findIndex((message) =>
        Number(message.sequence) > initialImageSequence && (message.images || []).some((image) => image.localPath)
      );
      const readable = (firstBlockedMedia < 0 ? fresh : fresh.slice(0, firstBlockedMedia)).slice(0, PAGE_SIZE);
      const first = !context.readCalled;
      if (firstBlockedMedia >= 0) context.deferredNewMedia = true;
      const activeMessages = [...messageReader.messages.values(), ...readable];
      const output = renderMessages(readable, { first, snapshot, activeMessages });
      if (active?.cancelRequested || !canRun()) return answer("本轮已停止，消息未标记已读。", true);
      messageReader.capture(readable.filter((message) => !message.isSelf));
      if (first) messageReader.capture(readOnlyContextMessages);
      if (readable.length) {
        await store.markMessagesRead?.(targetId, readable);
        try { onEvent({ type: "messages-read", targetType, targetId, at: new Date().toISOString() }); } catch { /* acknowledgement is already durable */ }
        context.lastReadSequence = Math.max(context.lastReadSequence,
          Number(readable.filter((message) => !message.isSelf).at(-1)?.sequence || 0));
        if (!scheduledTask) await store.markLiveReadSequence(targetId, context.lastReadSequence);
        for (const message of readable) {
          const id = String(message.senderId || "");
          if (/^\d{5,14}$/.test(id) && !context.allowedPokeUserIds.includes(id)) context.allowedPokeUserIds.push(id);
        }
      }
      context.readCalled = true;
      const notes = [];
      if (!scheduledTask) {
        refreshQzonePermissions();
        if (trigger?.trust !== "OWNER" && (context.allowQzoneFeed || context.allowQzonePost)) {
          notes.push(`本轮已读取 OWNER 的当前动态请求：${[
            context.allowQzoneFeed ? "read_qzone_feeds、engage_qzone_feed" : null,
            context.allowQzonePost ? "post_qzone" : null
          ].filter(Boolean).join("；")} 可由网关单独核验使用；群聊文件执行权限标签不限制这些 QQ 动态工具。`);
        }
      }
      if (firstBlockedMedia >= 0 && readable.length === 0) notes.push("有新图片在本轮启动后到达，尚未作为视觉输入提供；请结束本轮，图片和其后的消息会保留给下一轮。");
      else if (firstBlockedMedia >= 0) notes.push("后面还有新图片未作为视觉输入提供；请结束本轮，图片和其后的消息会保留给下一轮。");
      else if (fresh.length > readable.length) notes.push("还有未读取的消息；请再次调用 read_messages。");
      if (!readable.length && firstBlockedMedia < 0) notes.push("目前没有新消息；可以继续等待，也可以结束本轮。");
      if (readable.length && readable.every((message) => message.isSelf)) notes.push("本批只有你已发送的消息，用于确认时间顺序，不需要回复自己。");
      if (first && readSharedContext) {
        const status = await readSharedContext({}, active);
        if (!status.isError) notes.push(`【关联渠道新消息状态】\n${status.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")}`);
      }
      if (scheduledTask) notes.push("这是定时任务按需读取：已标记已读，不重复返回；未标记处理完成，不清理 pending。");
      return answer([output, ...notes].filter(Boolean).join("\n\n"));
    }
    if (name === "recall_message") {
      if (!context.readCalled) return answer("请先调用 read_messages 确认当前会话。", true);
      const messageId = String(args.message_id || "").trim();
      if (!/^-?\d+$/u.test(messageId) || !store.getSentMessage(targetId, messageId)) {
        return answer("只能撤回当前会话中由机器人成功发出、尚未撤回的消息 ID。", true);
      }
      try {
        store.assertReplyEnabled(targetId);
        const result = await oneBot.deleteMessage(messageId);
        if (!result?.ok) throw new Error("QQ 未确认撤回成功");
        await store.markSentMessageRecalled(targetId, messageId);
        context.actionCount += 1;
        context.displayedActions.push(`[已撤回消息 ${messageId}]`);
        try { active.onDelta?.("", context.displayedActions.join("\n\n")); } catch { /* recall already succeeded */ }
        return answer(`消息 ${messageId} 已从 QQ 撤回。`);
      } catch (error) {
        context.failed = true;
        return answer(`撤回状态未能确认：${error.message}。不要立即重复操作。`, true);
      }
    }
    if (name === "read_qzone_feeds" || name === "engage_qzone_feed") {
      if (!scheduledTask && !context.readCalled) return answer("请先读取当前 QQ 会话消息。", true);
      refreshQzonePermissions();
      if (!context.allowQzoneFeed || !qzone) return answer("好友动态仅限 OWNER 本轮真实消息明确要求，或 OWNER 直接唤醒的可写会话。", true);
      try {
        store.assertReplyEnabled(targetId);
        if (name === "read_qzone_feeds") {
          const page = scheduledTask
          ? await qzoneActions.readFeeds({ pageNum: args.page_num ?? 1, count: args.count ?? 12 })
            : await qzone.readManualFeeds({ targetType, targetId, messages: currentQzoneMessages(),
              trigger, pageNum: args.page_num ?? 1, count: args.count ?? 12 });
          if (page.pageNum > 1 && page.feeds.length && page.feeds.every((feed) => qzoneFeeds.has(feed.id))) {
            return answer("SnowLuma 这一页与已读动态完全重复，深翻页暂不可用；未推进定时巡检断点。", true);
          }
          for (const feed of page.feeds) qzoneFeeds.set(feed.id, feed);
          if (scheduledTask) context.qzoneReadCalled = true;
          return answer(JSON.stringify({ pageNum: page.pageNum, hasMore: page.hasMore,
            note: scheduledTask ? "仅可操作本轮真实读到的动态；聊天 pending 不会因本次读取而清理。"
              : "仅当前轮可点赞或评论这些真实动态；普通翻阅不推进定时巡检断点。第 2 页以后可能不可靠。",
            feeds: page.feeds.map(({ uin, tid, nickname, timeMs, text }) => ({ uin, tid, nickname,
              time: new Date(timeMs).toISOString(), text })) }));
        }
        const feed = qzoneFeeds.get(`${String(args.uin || "")}:${String(args.tid || "")}`);
        if (!feed) return answer("只能操作本轮 read_qzone_feeds 真正读到的动态，不能猜测 uin 或 tid。", true);
        const result = scheduledTask
          ? await qzoneActions.engageFeed({ feed, type: args.type, content: args.content })
          : await qzone.engageManualFeed({ targetType, targetId, messages: currentQzoneMessages(),
            trigger, feed, type: args.type, content: args.content });
        if (result.status === "unavailable") return answer("这条动态已删除或无法访问，网关已记下，不会再对它重复点赞或评论。");
        if (result.status !== "done") return answer(`这条动态的同类操作此前已尝试（${result.priorStatus}），本轮不重复发送；请在 QQ 空间核对。`);
        const summary = `[QQ 空间${result.action === "like" ? "已点赞" : "已评论"}：${result.uin}/${result.tid}]`;
        if (!scheduledTask) await store.recordLiveActionSent(targetId, { kind: "qzone_engagement", summary,
          observedSequence: context.lastReadSequence, chatReply: false });
        context.actionCount += 1;
        context.qzoneActionCount += 1;
        context.displayedActions.push(summary);
        try { active?.onDelta?.("", context.displayedActions.join("\n\n")); } catch { /* confirmed action already persisted */ }
        return answer(`${summary}，QQ 已确认执行。`);
      } catch (error) {
        if (name === "engage_qzone_feed" && error.code !== "QZONE_DENIED") context.failed = true;
        return answer(`好友动态操作未执行或状态未能确认：${error.message}${context.failed ? "。请停止本轮，不要盲目重试。" : ""}`, true);
      }
    }
    if (name === "get_group_management" || name === "manage_group") {
      if (targetType !== "group") return answer("群管理工具仅限当前可写群聊。", true);
      if (scheduledTask && name === "manage_group") return answer("定时动态任务不能代替 OWNER 的当前聊天授权执行群管理；请等待相应 QQ 聊天轮次。", true);
      if (!context.readCalled) return answer("请先读取当前群消息，再使用群管理工具。", true);
      try {
        store.assertReplyEnabled(targetId);
        if (name === "get_group_management") {
          const result = await readGroupManagement({ oneBot, groupId: targetId, botId: AGENT_QQ_ID, args });
          return answer(JSON.stringify(result));
        }
        const ownerMessage = currentOwnerManagementMessage(messageReader, targetId, OWNER_QQ_ID,
          (messageId) => store.isRecalled?.(targetId, messageId));
        const actionKey = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
        const alreadyDone = (store.snapshot(targetId).liveSession?.actions || []).some((item) =>
          item.kind === "group_management" && Number(item.observedSequence) === context.lastReadSequence
          && String(item.summary).startsWith(`[${actionKey}] `));
        if (alreadyDone) return answer("这项完全相同的群管理操作在此前中断的轮次里已由 QQ 确认执行，本轮不重复操作。");
        const result = await manageGroup({
          oneBot, groupId: targetId, botId: AGENT_QQ_ID, ownerId: OWNER_QQ_ID,
          ownerMessage, messageReader, args
        });
        await store.recordLiveActionSent(targetId, {
          kind: "group_management", summary: `[${actionKey}] ${result.summary}`,
          observedSequence: context.lastReadSequence, chatReply: false
        });
        context.actionCount += 1;
        context.managementActionCount += 1;
        context.displayedActions.push(`[群管理：${result.summary}]`);
        try { onEvent({ type: "group-management", groupId: targetId, action: result.action,
          summary: result.summary, ownerAuthorized: Boolean(ownerMessage), at: new Date().toISOString() }); }
        catch { /* successful QQ action and durable receipt take precedence over event display */ }
        try { active?.onDelta?.("", context.displayedActions.join("\n\n")); } catch { /* action already succeeded */ }
        return answer(`${result.summary}。QQ 已确认执行。`);
      } catch (error) {
        if (name === "manage_group" && error.code !== "GROUP_MANAGEMENT_DENIED") context.failed = true;
        return answer(`群管理操作未执行或状态未能确认：${error.message}${context.failed ? "。请停止本轮，不要盲目重试。" : ""}`, true);
      }
    }
    if (name === "post_qzone") refreshQzonePermissions();
    const queued = [];
    const validated = handleQqMcpTool({ name, args, context, queued });
    if (validated.isError || !queued.length) return validated;
    const action = queued[0];
    try {
      if (active?.cancelRequested || !canRun()) return answer("本轮已停止或回复开关已关闭。", true);
      store.assertReplyEnabled(targetId);
      let summary = "";
      let chatReply = true;
      let sent;
      if (action.kind === "message") {
        const segments = action.segments?.map((item) => item.type === "text"
          ? { type: "text", data: { text: /^\s*$/.test(item.data.text) ? item.data.text
              : `${/^\s*/.exec(item.data.text)[0]}${sanitizeGroupReply(item.data.text)}${/\s*$/.exec(item.data.text)[0]}` } }
          : item);
        if (segments?.some((item) => item.type === "at")) {
          for (const userId of new Set(segments.filter((item) => item.type === "at").map((item) => item.data.qq))) {
            let member;
            try { member = await oneBot.getGroupMemberInfo(targetId, userId); } catch { /* deny an unknown target */ }
            if (!member || String(member.user_id) !== userId) return answer(`QQ ${userId} 未确认是当前群成员，未发送 @；请核对真实 QQ 号。`, true);
          }
        }
        summary = segments ? segments.map((item) => item.type === "at" ? `@QQ ${item.data.qq}` : item.data.text).join("") : sanitizeGroupReply(action.text);
        if (!summary) return answer("正文经过安全过滤后为空，请修改内容。", true);
        if (recoveredMessages.includes(`${context.lastReadSequence}:${summary.slice(0, 500)}`)) {
          return answer("这条文字在先前中断的轮次里已确认送达 QQ，本轮不重复发送。可继续读取消息或结束对话。");
        }
        const replyToMessageId = action.replyToMessageId;
        if (active?.cancelRequested || !canRun()) return answer("本轮已停止或回复开关已关闭。", true);
        sent = targetType === "group" && segments
          ? await oneBot.sendGroupSegments(targetId, [
              ...(replyToMessageId != null && !String(replyToMessageId).startsWith("codex-ui-")
                ? [{ type: "reply", data: { id: String(replyToMessageId) } }] : []),
              ...segments
            ]) : targetType === "group"
          ? await oneBot.sendGroupMessage(targetId, summary, {
              replyToMessageId
            })
          : await oneBot.sendPrivateMessage(targetId, summary, { replyToMessageId });
      } else if (action.kind === "face") {
        summary = `[QQ 表情：${args.face}]`;
        sent = targetType === "group"
          ? await oneBot.sendGroupFace(targetId, QQ_FACE_ALIASES[args.face])
          : await oneBot.sendPrivateFace(targetId, QQ_FACE_ALIASES[args.face]);
      } else if (action.kind === "sticker") {
        if (!stickerManager) throw new Error("QQ 原生表情管理器不可用");
        const sticker = stickerManager.resolveRequests([{ id: args.sticker_id }])[0];
        if (!sticker) throw new Error("表情包已不在可用清单中");
        summary = `[QQ 表情包：${sticker.usage || sticker.id}]`;
        sent = await stickerManager.sendSticker(targetType, targetId, sticker);
      } else if (action.kind === "poke") {
        const userId = args.user_id === "sender" ? context.pokeSenderId : String(args.user_id);
        summary = `[戳了戳 ${userId}]`;
        sent = await oneBot.sendGroupPoke(targetId, userId);
      } else if (action.kind === "file") {
        if (!fileManager) throw new Error("QQ 文件发送器不可用");
        const file = (await fileManager.resolveRequests([{ sourcePath: args.path }], { allowedRoots: security.allowedFileRoots }))[0];
        summary = `[文件：${file.name}]`;
        sent = await fileManager.upload(targetId, file);
      } else if (action.kind === "image") {
        if (!fileManager) throw new Error("QQ 图片发送器不可用");
        const image = (await fileManager.resolveImageRequests([{ sourcePath: args.path }], { allowedRoots: security.allowedFileRoots }))[0];
        summary = `[图片：${image.name}]`;
        sent = await fileManager.sendImage(targetType, targetId, image);
      } else if (action.kind === "qzone") {
        if (!qzone) throw new Error("QQ 空间不可用");
        if (scheduledTask) await qzoneActions.post({ content: args.content, images: args.images });
        else {
          const result = await qzone.executeManual({
            targetType, targetId, trigger, messages: currentQzoneMessages(),
            turnId: active.turnId, text: action.directive, allowAutonomousOwnerPost: true
          });
          if (!result.notices?.some((notice) => notice.includes("的小号发布 QQ 空间动态"))) {
            throw new Error(result.notices?.join("；") || "QQ 空间发布未确认");
          }
        }
        summary = "[已发布 QQ 空间动态]";
        chatReply = false;
        sent = { ok: true };
      } else {
        return answer("未知的 QQ 动作。", true);
      }
      if (!sent?.ok) throw new Error(`QQ ${action.kind} 发送失败：HTTP ${sent?.status || "unknown"}`);
      const receipt = { kind: action.kind, summary, chatReply,
        messageId: sent.body?.data?.message_id ?? sent.body?.data?.messageId ?? null };
      if (scheduledTask) await store.recordStandaloneActionSent(targetId, receipt);
      else await store.recordLiveActionSent(targetId, { ...receipt, observedSequence: context.lastReadSequence });
      context.actionCount += 1;
      context.displayedActions.push(summary);
      try { active.onDelta?.(summary, context.displayedActions.join("\n\n")); } catch { /* QQ delivery already succeeded. */ }
      const sentId = sent.body?.data?.message_id ?? sent.body?.data?.messageId;
      return answer(`${summary} 已成功交给 QQ${sentId == null ? "" : `，消息 ID：${sentId}`}。可以继续读取或回复；结束时调用 end_conversation。`);
    } catch (error) {
      context.failed = true;
      return answer(`本轮动作未能确认：${error.message}。请结束本轮，不要立即重试；待处理消息保持不变。`, true);
    }
  };
  return context;
}
