export const DEFAULT_HUMAN_PACING = Object.freeze({
  shortDebounceMs: 2200,
  quickDebounceMs: 1000,
  maxDebounceMs: 5500,
  groupFollowupDebounceMs: 3500,
  groupFollowupMaxDebounceMs: 7000,
  replyMinMs: 600,
  replyMaxMs: 2200,
  replyPerCharMs: 35,
  reactionMinMs: 450,
  reactionMaxMs: 900,
  hotFollowupMs: 120_000,
  casualPrivateFollowupMs: 60_000,
  casualGroupFollowupMs: 50_000
});

const IMMEDIATE_TRIGGER_REASONS = new Set(["control", "retry", "subscription_auto", "poke"]);
const STOP_WORDS_RE = /别说话|闭嘴|别插嘴|别回了|不用回了|嫌烦|安静点|别搭话|没问你/u;
const GOODBYE_RE = /^(?:晚安|拜拜|再见|88|886|先这样|先忙了|没事了|没啥事了|好了没事|我去睡了|去睡了|先撤了|溜了|行吧没事了|好滴拜拜|好的拜拜)[！!。.~～呀啊哦呢吧]*$/u;
const QUESTION_OR_HOOK_RE = /[？?]|(?:吗|呢|行不行|要不要|怎么样|哪一个|哪种|可以吗)[！!。.~～]*$/u;

export function computeBurstDebounceMs(message, {
  targetType = "group",
  reason = "mention",
  botName = "",
  config = DEFAULT_HUMAN_PACING
} = {}) {
  if (IMMEDIATE_TRIGGER_REASONS.has(reason)) {
    return { delayMs: 0, maxWaitMs: 0 };
  }
  const text = String(message?.text || "").trim();
  const hasMedia = (message?.images?.length || 0) > 0 || (message?.attachments?.length || 0) > 0;
  const cleanName = String(botName || "").trim();
  const mentionsBotName = Boolean(cleanName && text.includes(cleanName));

  if (targetType === "group" && reason === "followup" && !message?.mentionedBot && !mentionsBotName) {
    return {
      delayMs: Math.max(0, Number(config.groupFollowupDebounceMs ?? DEFAULT_HUMAN_PACING.groupFollowupDebounceMs)),
      maxWaitMs: Math.max(0, Number(config.groupFollowupMaxDebounceMs ?? DEFAULT_HUMAN_PACING.groupFollowupMaxDebounceMs))
    };
  }

  const maxWaitMs = Math.max(0, Number(config.maxDebounceMs ?? DEFAULT_HUMAN_PACING.maxDebounceMs));
  if (hasMedia || text.length >= 40 || /[？?！!]$/.test(text)) {
    return {
      delayMs: Math.max(0, Number(config.quickDebounceMs ?? DEFAULT_HUMAN_PACING.quickDebounceMs)),
      maxWaitMs
    };
  }
  return {
    delayMs: Math.max(0, Number(config.shortDebounceMs ?? DEFAULT_HUMAN_PACING.shortDebounceMs)),
    maxWaitMs
  };
}

export function computeReplyDelayMs({ kind = "message", text = "" } = {}, {
  random = Math.random,
  config = DEFAULT_HUMAN_PACING
} = {}) {
  const rand = typeof random === "function" ? random() : 0.5;
  if (kind === "message") {
    const len = String(text || "").trim().length;
    const minMs = Math.max(0, Number(config.replyMinMs ?? DEFAULT_HUMAN_PACING.replyMinMs));
    const maxMs = Math.max(minMs, Number(config.replyMaxMs ?? DEFAULT_HUMAN_PACING.replyMaxMs));
    const perChar = Math.max(0, Number(config.replyPerCharMs ?? DEFAULT_HUMAN_PACING.replyPerCharMs));
    const base = Math.min(maxMs, minMs + len * perChar);
    const jitter = 0.85 + rand * 0.30;
    return Math.max(Math.min(400, minMs), Math.round(base * jitter));
  }
  if (["face", "sticker", "poke", "image", "file"].includes(kind)) {
    const minMs = Math.max(0, Number(config.reactionMinMs ?? DEFAULT_HUMAN_PACING.reactionMinMs));
    const maxMs = Math.max(minMs, Number(config.reactionMaxMs ?? DEFAULT_HUMAN_PACING.reactionMaxMs));
    return Math.round(minMs + rand * (maxMs - minMs));
  }
  return 0;
}

export function computeFollowupDurationMs({
  targetType = "group",
  triggerReason = "mention",
  chatSendCount = 0,
  totalActionCount = 0,
  lastSentText = "",
  readMessages = [],
  maxDurationMs = DEFAULT_HUMAN_PACING.hotFollowupMs,
  config = DEFAULT_HUMAN_PACING
} = {}) {
  const cap = Math.max(0, Number(maxDurationMs) || DEFAULT_HUMAN_PACING.hotFollowupMs);
  const latestUserText = String([...(readMessages || [])].reverse().find((item) => !item?.isSelf)?.text || "").trim();

  if (chatSendCount === 0 && totalActionCount === 0 && ["followup", "scheduled"].includes(triggerReason)) {
    return 0;
  }
  if (STOP_WORDS_RE.test(latestUserText)) {
    return 0;
  }
  if (latestUserText.length > 0 && latestUserText.length <= 16 && GOODBYE_RE.test(latestUserText)) {
    return 0;
  }

  const sentTrimmed = String(lastSentText || "").trim();
  const isHot = QUESTION_OR_HOOK_RE.test(sentTrimmed)
    || totalActionCount > chatSendCount
    || /[？?]/u.test(latestUserText)
    || latestUserText.length >= 20;
  if (isHot) {
    return Math.min(cap, Math.max(0, Number(config.hotFollowupMs ?? DEFAULT_HUMAN_PACING.hotFollowupMs)));
  }

  const casual = targetType === "private"
    ? Number(config.casualPrivateFollowupMs ?? DEFAULT_HUMAN_PACING.casualPrivateFollowupMs)
    : Number(config.casualGroupFollowupMs ?? DEFAULT_HUMAN_PACING.casualGroupFollowupMs);
  return Math.min(cap, Math.max(0, casual));
}

export async function waitForBurstSettle({
  store,
  targetId,
  targetType = "group",
  reason = "followup",
  botName = "",
  shouldStop = () => false,
  config = DEFAULT_HUMAN_PACING,
  clock = () => new Date()
} = {}) {
  if (!store || typeof store.waitForNewMessages !== "function") return;
  const readLatestUnread = () => {
    const snap = store.snapshot(targetId);
    const unread = (snap.pendingMessages || []).filter((message) => !message.readAt && !message.isSelf);
    return { snap, latest: unread.at(-1) || null };
  };
  let { snap, latest } = readLatestUnread();
  if (!latest || shouldStop()) return;

  let activeReason = snap.pendingTrigger?.reason || reason;
  let timing = computeBurstDebounceMs(latest, { targetType, reason: activeReason, botName, config });
  if (timing.delayMs <= 0) return;

  const firstAt = clock().getTime();
  const maxWaitMs = timing.maxWaitMs;
  let latestSequence = Number(latest.sequence || 0);

  while (!shouldStop()) {
    const elapsed = clock().getTime() - firstAt;
    const remainingCap = Math.max(0, maxWaitMs - elapsed);
    const waitMs = Math.min(timing.delayMs, remainingCap);
    if (waitMs <= 0) break;

    await store.waitForNewMessages(targetId, {
      afterSequence: latestSequence,
      timeoutMs: waitMs,
      shouldStop
    });
    if (shouldStop()) break;

    ({ snap, latest } = readLatestUnread());
    activeReason = snap.pendingTrigger?.reason || reason;
    if (IMMEDIATE_TRIGGER_REASONS.has(activeReason)) break;
    const nextSequence = Number(latest?.sequence || 0);
    if (nextSequence <= latestSequence) break;

    latestSequence = nextSequence;
    timing = computeBurstDebounceMs(latest, { targetType, reason: activeReason, botName, config });
    if (timing.delayMs <= 0) break;
  }
}
