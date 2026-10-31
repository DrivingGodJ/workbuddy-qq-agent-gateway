import { QQ_FACE_ALIASES } from "./file-directive.js";
import { searchReactions } from "./reaction-search.js";

const STICKER_ID = /^st_[a-f0-9]{12,64}$/u;
const QQ_ID = /^\d{5,14}$/u;

export function messageFormatError(message) {
  const prose = String(message).replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"\n]*"/gu, "");
  return /<\/text>\s*$/iu.test(prose) && !/<text(?:\s[^>]*)?>/iu.test(prose)
    ? "正文末尾有孤立的 </text> 内部标签，消息尚未发送。请去掉该标签后重新提交；若确实要讨论标签，请用反引号引用。不要撤回其他消息。"
    : null;
}

export function handleQqMcpTool({ name, args = {}, context, queued = [] }) {
  if (!context || typeof context !== "object") return failure("当前轮次不可调用 QQ MCP 工具。");
  if (name === "read_messages") {
    if (!context.readContent) return failure("当前轮次没有可读取的 QQ 消息快照。");
    context.readCalled = true;
    return success(context.readContent);
  }
  if (name === "read_source_messages") {
    if (!context.sourceReadContent || !context.sourceGroupId) return failure("当前轮次没有可读取的只读来源群快照。");
    if (context.canRead?.() === false) return failure("当前轮次已停止，不能继续读取通知来源。");
    context.sourceReadCalled = true;
    return success({ sourceGroupId: context.sourceGroupId, content: context.sourceReadContent });
  }
  if (name === "send_message") {
    if (!context.allowMessage) return failure("当前轮次不可提交 QQ 消息。");
    if (context.requireRead && !context.readCalled) return failure("请先调用 read_messages 读取本轮消息。");
    let segments;
    let message;
    const replyToMessageId = args.reply_to_message_id == null ? null : String(args.reply_to_message_id).trim();
    if (replyToMessageId != null && (!/^-?\d+$/u.test(replyToMessageId)
      || !context.liveMode || !context.canReplyToMessage?.(replyToMessageId))) {
      return failure("只能引用当前会话已经读取、尚未撤回的真实 QQ 消息 ID；不引用时请省略 reply_to_message_id。");
    }
    try {
      if (args.segments != null) {
        if (args.text != null) return failure("text 和 segments 请二选一。");
        if (!Array.isArray(args.segments) || !args.segments.length || args.segments.length > 100) return failure("segments 须为 1–100 个文字或 @ 消息段。");
        segments = args.segments.map((item) => {
          if (item?.type === "text" && typeof item.text === "string") return { type: "text", data: { text: item.text } };
          if (item?.type === "at" && QQ_ID.test(String(item.user_id || ""))) return { type: "at", data: { qq: String(item.user_id) } };
          throw new Error("消息段只能是 text 或 at；@ 必须使用真实的个人 QQ 号，不能 @全体。");
        });
        if (segments.some((item) => item.type === "at") && (context.targetType !== "group" || !context.liveMode)) return failure("真正的 @ 仅支持当前群聊的可写 Agent 会话，不支持私聊。");
        message = segments.map((item) => item.type === "at" ? `@QQ ${item.data.qq}` : item.data.text).join("");
      } else {
        if (typeof args.text !== "string") return failure("请提供 text，或者按原顺序提供 segments。");
        message = args.text.trim();
      }
    } catch (error) { return failure(error.message); }
    if (!message || message.length > 12_000) return failure("消息正文须为 1–12000 字。");
    // Validate the combined body so split text segments cannot leak a wrapper.
    const formatError = messageFormatError(message);
    if (formatError) return failure(formatError);
    if (/\[\[qq_[^\]]*\]\]/iu.test(message)) return failure("消息正文不能包含 QQ 动作指令；请分别使用对应的 MCP 工具。");
    if (queued.some((item) => item.kind === "message")) return failure("本轮已提交一条文字消息，请不要重复提交。");
    queued.push({ kind: "message", text: message, ...(segments ? { segments } : {}), replyToMessageId });
    return success("文字已交给当前会话网关待发送；实际发送成功后才会标记消息已处理。最终回复不要重复正文。");
  }
  if (name === "send_file" || name === "send_image") {
    if (context.requireRead && !context.readCalled) return failure("请先调用 read_messages 读取本轮消息。");
    if (name === "send_file" && (!context.allowFiles || context.targetType !== "group")) return failure("当前会话不可发送群文件。");
    if (name === "send_image" && !context.allowImages) return failure("当前会话不可发送本机图片。");
    const sourcePath = String(args.path || "").trim();
    if (!sourcePath.startsWith("/") || sourcePath.includes("\0")) return failure("请提供本机文件的绝对路径。");
    return queue(queued, name === "send_file" ? "file" : "image", `[[qq_${name === "send_file" ? "file" : "image"}:${sourcePath}]]`, 10);
  }
  if (name === "list_reactions") {
    if (!context.allowReactions) return failure("当前轮次不可读取 QQ 表情清单。");
    try { return success(searchReactions(context.stickers, Object.keys(QQ_FACE_ALIASES), args)); }
    catch (error) { return failure(error.message); }
  }
  if (name === "send_reaction") {
    if (context.requireRead && !context.readCalled) return failure("请先调用 read_messages 读取本轮消息。");
    if (!context.allowReactions) return failure("当前轮次不可发送 QQ 表情。");
    const face = String(args.face || "").trim();
    const stickerId = String(args.sticker_id || "").trim();
    if (Boolean(face) === Boolean(stickerId)) return failure("请选择一个 face 或 sticker_id，不要同时提供。");
    if (face) {
      if (!Object.hasOwn(QQ_FACE_ALIASES, face)) return failure("未知内置表情；请先调用 list_reactions。");
      return queue(queued, "face", `[[qq_face:${face}]]`, 5);
    }
    if (!STICKER_ID.test(stickerId) || !(context.stickers || []).some((item) => item.id === stickerId && item.usage)) {
      return failure("表情包不在当前真实可用清单中；请先调用 list_reactions。");
    }
    return queue(queued, "sticker", `[[qq_sticker:${stickerId}]]`, 1);
  }
  if (name === "poke_member") {
    if (context.requireRead && !context.readCalled) return failure("请先调用 read_messages 读取本轮消息。");
    if (!context.allowPoke || context.targetType !== "group") return failure("当前轮次不可戳一戳。");
    const raw = String(args.user_id || "").trim();
    const userId = raw === "sender" ? String(context.pokeSenderId || "") : raw;
    if (!QQ_ID.test(userId) || !(context.allowedPokeUserIds || []).map(String).includes(userId)) {
      return failure("只能戳当前群的本轮触发者或已知成员，不能猜测 QQ 号。");
    }
    return queue(queued, "poke", `[[qq_poke:${userId}]]`, 1);
  }
  if (name === "post_qzone") {
    if (context.requireRead && !context.readCalled) return failure("请先调用 read_messages 读取本轮消息。");
    if (!context.allowQzonePost) return failure("只有 OWNER 直接触发并授权的当前会话或绑定会话定时任务才可调用。");
    const content = String(args.content || "").trim();
    const images = args.images == null ? [] : args.images;
    if (!content || content.length > 1000) return failure("动态正文须为 1–1000 字。");
    if (!Array.isArray(images) || images.length > 9 || images.some((path) => typeof path !== "string" || !path.startsWith("/"))) {
      return failure("图片必须是最多九个本机绝对路径。");
    }
    if (context.scheduledQzonePost && images.length) return failure("定时动态只支持纯文字。");
    return queue(queued, "qzone", `[[qq_zone_post:${JSON.stringify({ content, ...(images.length ? { images } : {}) })}]]`, 1);
  }
  const toolName = String(name || "").replace(/[\r\n]/gu, " ").slice(0, 80);
  return failure(`当前轮次不支持 QQ MCP 工具 ${toolName || "（未提供名称）"}；请按本轮模式使用对应工具。`);
}

function queue(queued, kind, directive, limit) {
  if (queued.filter((item) => item.kind === kind).length >= limit) return failure("本轮该类 QQ 动作已排队，请不要重复调用。");
  queued.push({ kind, directive });
  return success("已交给网关待发送。这里只确认排队，实际发送结果以网关为准；无需在最终回复重复写特殊指令。");
}

function success(value) {
  return { isError: false, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function failure(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}
