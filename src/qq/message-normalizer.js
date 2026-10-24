import { getAgentName, trustForSender } from "../security/policy.js";
import { extractUrls } from "./link-reader.js";

// QQNT PicSubType: 1=custom, 2=hot, 4=smart recommendation, 7=related recommendation.
// Types 0/3/5/6 are normal pictures, charts, space pictures, or unknown media.
const QQ_STICKER_IMAGE_SUBTYPES = new Set([1, 2, 4, 7]);

export function normalizeOneBotGroupMessage(payload, { now = () => new Date() } = {}) {
  return normalizeOneBotMessage(payload, { now, messageType: "group" });
}

export function normalizeOneBotPrivateMessage(payload, { now = () => new Date() } = {}) {
  return normalizeOneBotMessage(payload, { now, messageType: "private" });
}

export function normalizeOneBotGroupPoke(payload, { now = () => new Date() } = {}) {
  const selfId = asId(payload?.self_id);
  const senderId = asId(payload?.user_id);
  const targetId = asId(payload?.target_id);
  const groupId = asId(payload?.group_id);
  const timestamp = normalizeTimestamp(payload?.time, now);
  return {
    messageId: `poke:${groupId}:${senderId}:${targetId}:${String(payload?.notice_id || payload?.message_id || timestamp.toISOString())}`,
    groupId,
    senderId,
    senderName: String(payload?.sender?.card || payload?.sender?.nickname || senderId || "群成员").trim(),
    senderRole: normalizeSenderRole(payload?.sender?.role),
    timestamp: timestamp.toISOString(),
    displayTime: formatLocalTime(timestamp),
    text: targetId === selfId ? `戳了戳${getAgentName()}` : `戳了戳 QQ ${targetId}`,
    mentions: [],
    imageRefs: [],
    images: [],
    attachments: [],
    mentionedBot: Boolean(selfId && targetId === selfId),
    replyToMessageId: null,
    trust: trustForSender(senderId),
    source: "qq",
    rawType: "group",
    eventType: "poke",
    pokeTargetId: targetId
  };
}

function normalizeOneBotMessage(payload, { now, messageType }) {
  const segments = Array.isArray(payload?.message) ? payload.message : [];
  const selfId = asId(payload?.self_id);
  const senderId = asId(payload?.user_id);
  const groupId = messageType === "private" ? senderId : asId(payload?.group_id);
  const timestamp = normalizeTimestamp(payload?.time, now);
  const explicitlyMentionedBot = segments.some((segment) => {
    if (segment?.type !== "at") return false;
    const target = segment.data?.qq ?? segment.data?.id ?? segment.data?.uin;
    return target != null && String(target) === selfId;
  });
  const replySegment = segments.find((segment) => segment?.type === "reply");
  const mentions = extractMentions(segments, selfId);
  const renderedText = renderOneBotMessageText(segments, { selfId });
  const fallbackText = stripCqCodes(String(payload?.raw_message || ""));
  const text = renderedText.trim() || fallbackText || describeNonTextSegments(segments);
  const mentionedBot = explicitlyMentionedBot || text.includes(getAgentName());

  return {
    messageId: String(payload?.message_id ?? payload?.message_seq ?? `${groupId}:${senderId}:${timestamp.toISOString()}`),
    groupId,
    senderId,
    senderName: String(payload?.sender?.card || payload?.sender?.nickname || senderId || "群成员").trim(),
    senderRole: normalizeSenderRole(payload?.sender?.role),
    timestamp: timestamp.toISOString(),
    displayTime: formatLocalTime(timestamp),
    text,
    links: [...new Set([
      ...extractUrls(segments.length ? segments.filter((segment) => segment.type === "text").map((segment) => segment.data?.text || "").join(" ") : text),
      ...extractCardLinks(segments)
    ])],
    mentions,
    imageRefs: extractImageRefs(segments),
    images: [],
    attachments: extractAttachments(segments),
    mentionedBot,
    replyToMessageId: replySegment?.data?.id == null ? null : String(replySegment.data.id),
    trust: trustForSender(senderId),
    source: "qq",
    rawType: payload?.message_type || messageType
  };
}

export function extractMentions(segments, selfId = "") {
  return (segments || [])
    .filter((segment) => segment?.type === "at")
    .map((segment) => {
      const userId = asId(segment.data?.qq ?? segment.data?.id ?? segment.data?.uin);
      return {
        userId,
        displayName: mentionNameFromSegment(segment),
        isBot: Boolean(userId && userId === asId(selfId)),
        isAll: userId.toLowerCase() === "all"
      };
    })
    .filter((mention) => mention.userId);
}

export function renderOneBotMessageText(segments, { selfId = "", mentionNames = {} } = {}) {
  return (segments || []).map((segment) => {
    if (segment?.type === "text") return String(segment.data?.text || "");
    if (segment?.type === "forward") return "[合并转发]";
    if (segment?.type === "json") {
      const card = parseCard(segment);
      if (card?.app === "com.tencent.multimsg") return "[合并转发]";
      const { miniApp, title, description, links } = cardInfo(card);
      const label = miniApp ? "[小程序]" : links.length ? "[链接]" : "[分享卡片]";
      const summary = [title, description].filter(Boolean).join("：");
      return `${label}${summary ? ` ${summary}` : ""}${links.length ? ` ${links.join(" ")}`
        : miniApp ? "（仅有卡片信息，未提供公开网页入口）" : ""}`;
    }
    if (segment?.type !== "at") return "";
    const userId = asId(segment.data?.qq ?? segment.data?.id ?? segment.data?.uin);
    if (!userId) return "";
    if (userId === asId(selfId)) return `@${getAgentName()}（QQ ${userId}）`;
    if (userId.toLowerCase() === "all") return "@全体成员";
    const displayName = String(mentionNames[userId] || mentionNameFromSegment(segment) || "").trim();
    return displayName ? `@${displayName}（QQ ${userId}）` : `@QQ ${userId}`;
  }).join("");
}

export function extractImageRefs(segments) {
  return (segments || [])
    .filter((segment) => segment?.type === "image")
    .map((segment, index) => {
      const subType = Number(segment.data?.sub_type ?? segment.data?.subType ?? 0);
      const emojiId = String(segment.data?.emoji_id || "");
      return {
        index,
        file: String(segment.data?.file || ""),
        url: String(segment.data?.url || segment.data?.src || ""),
        summary: String(segment.data?.summary || ""),
        subType,
        emojiId,
        emojiPackageId: Number(segment.data?.emoji_package_id ?? segment.data?.tab_id ?? 0),
        emojiKey: String(segment.data?.key || ""),
        isSticker: Boolean(emojiId) || QQ_STICKER_IMAGE_SUBTYPES.has(subType)
      };
    });
}

export function formatLocalTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function normalizeTimestamp(value, now) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return now();
}

function extractAttachments(segments) {
  return (segments || [])
    .filter((segment) => ["file", "video", "record", "audio", "forward", "json"].includes(String(segment?.type || "")))
    .map((segment) => ({
      type: String(segment.type === "json" && parseCard(segment)?.app === "com.tencent.multimsg" ? "forward" : segment.type),
      name: String(segment.data?.name || segment.data?.file || segment.data?.id || segment.type),
      url: String(segment.data?.url || ""),
      file: String(segment.data?.file || ""),
      fileId: String(segment.type === "json" ? parseCard(segment)?.meta?.detail?.resid || ""
        : segment.data?.file_id || segment.data?.id || segment.data?.res_id || segment.data?.forward_id || ""),
      busid: segment.data?.busid == null ? null : Number(segment.data.busid),
      size: Number(segment.data?.file_size || segment.data?.size || 0),
      localPath: null
  }));
}

function parseCard(segment) {
  try {
    const raw = segment?.data?.data;
    if (typeof raw === "string" && raw.length <= 128_000) return JSON.parse(raw);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  } catch { /* Invalid cards remain untrusted attachments. */ }
  return null;
}

function extractCardLinks(segments) {
  return [...new Set((segments || []).filter((segment) => segment?.type === "json")
    .flatMap((segment) => cardInfo(parseCard(segment)).links))].slice(0, 40);
}

function cardInfo(card) {
  const miniApp = /^com\.tencent\.miniapp(?:_|$)/.test(String(card?.app || ""));
  const details = card?.meta && typeof card.meta === "object" ? Object.values(card.meta).slice(0, 60)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  const cleanText = (value) => typeof value === "string" ? value.replace(/[\s\u0000-\u001f]+/g, " ").trim().slice(0, 500) : "";
  const title = details.map((item) => cleanText(item.title)).find(Boolean) || "";
  const description = details.map((item) => cleanText(item.desc || item.description)).find(Boolean)
    || (miniApp ? cleanText(card?.prompt).replace(/^\[QQ小程序\]\s*/, "") : "");
  if (miniApp) {
    // A QQ miniapp's qqdocurl/jumpUrl is its public content entry. Preview and
    // icon URLs are assets, not pages. Only fall back to its explicit app URL.
    const preferred = details.flatMap((item) => [item.qqdocurl, item.jumpUrl, item.jump_url, item.webUrl, item.web_url])
      .filter((value) => typeof value === "string").flatMap(extractUrls);
    const fallback = details.map((item) => item.url).filter((value) => typeof value === "string")
      .flatMap((value) => extractUrls(/^m\.q\.qq\.com\//i.test(value) ? `https://${value}` : value));
    return { miniApp, title, description: description === title ? "" : description,
      links: [...new Set(preferred.length ? preferred : fallback)].slice(0, 6) };
  }
  const links = [];
  const visit = (value, depth = 0) => {
    if (depth > 6 || links.length >= 40) return;
    if (typeof value === "string") links.push(...extractUrls(value));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value).slice(0, 60)) {
      if (/^(?:preview|icon|image|img|cover|thumbnail|avatar)(?:_?url)?$/i.test(key)) continue;
      visit(item, depth + 1);
    }
  };
  visit(card);
  return { miniApp, title, description: description === title ? "" : description, links: [...new Set(links)].slice(0, 40) };
}

function normalizeSenderRole(value) {
  const role = String(value || "member").toLowerCase();
  return ["owner", "admin"].includes(role) ? role : "member";
}

function describeNonTextSegments(segments) {
  const labels = [];
  if (segments.some((segment) => segment?.type === "image")) labels.push("[图片]");
  if (segments.some((segment) => ["record", "audio"].includes(segment?.type))) labels.push("[语音]");
  if (segments.some((segment) => segment?.type === "video")) labels.push("[视频]");
  if (segments.some((segment) => segment?.type === "file")) labels.push("[文件]");
  if (segments.some((segment) => segment?.type === "forward")) labels.push("[合并转发]");
  return labels.join(" ") || "[非文字消息]";
}

function mentionNameFromSegment(segment) {
  return String(
    segment?.data?.name
    || segment?.data?.card
    || segment?.data?.nickname
    || segment?.data?.display
    || ""
  ).trim() || null;
}

function stripCqCodes(value) {
  return value.replace(/\[CQ:[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
}

function asId(value) {
  return value == null ? "" : String(value);
}
