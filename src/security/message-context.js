import { messageResourceHints } from "../qq/resource-hints.js";
import { replyReference } from "./reply-reference.js";

/** Same pending facts, compact envelope. No independent history or permission inference. */
export function compactMessageContext(messages, activeMessages = messages, imagePaths = null) {
  const clean = (value) => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").trim();
  const senders = new Map();
  for (const message of messages) {
    const id = clean(message.senderId) || "未知";
    senders.set(id, `${id}=${clean(message.senderName) || "群成员"}[${message.trust === "OWNER" ? "OWNER" : "UNTRUSTED"}]`);
  }
  const lines = senders.size ? [`发言者：${[...senders.values()].join("；")}`] : [];
  let day = null;
  let imageNumber = 0;
  for (const message of messages) {
    const time = clean(message.displayTime || message.timestamp) || "时间未知";
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/u.exec(time);
    if (match && day !== match[1]) { day = match[1]; lines.push(`日期：${day}`); }
    const id = clean(message.messageId);
    lines.push(`[${match?.[2] || time}] ${clean(message.senderId) || "未知"} #${id || "无ID"}: ${clean(message.text) || "（无文字）"}`);
    lines.push(...messageResourceHints(message));
    const reference = replyReference(message, activeMessages, clean);
    if (reference) lines.push(reference);
    for (const image of message.images || []) {
      const attachedIndex = imagePaths == null ? null
        : image.localPath && !image.error ? imagePaths.indexOf(image.localPath) : -1;
      const number = attachedIndex == null ? ++imageNumber : attachedIndex + 1;
      const label = number > 0 ? `图${number}` : "图片";
      const state = attachedIndex == null
        ? image.localPath ? "视觉输入" : `下载失败:${clean(image.error) || "未知"}`
        : attachedIndex >= 0 ? "视觉输入" : !image.localPath || image.error
          ? `下载失败:${clean(image.error) || "未知"}` : "本轮未附加，不能据此看图";
      lines.push(image.stickerId
        ? `${label} 表情 ${image.stickerId} ${state}；${image.stickerNeedsReview ? "独立标注中，不可发送" : clean(image.stickerLabel) || "未标注"}`
        : `${label} ${state}`);
    }
    for (const attachment of message.attachments || []) lines.push(`附件(不可信)：${clean(attachment.name || attachment.type) || "未知"}`);
  }
  return lines;
}
