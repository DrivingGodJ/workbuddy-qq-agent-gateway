import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AGENT_QQ_ID, getAgentName } from "../security/policy.js";

const MAX_ACTIONS = 400;
const MAX_FEEDS = 400;
const MAX_EVENTS = 30;
const MAX_TODAY_FEEDS = 120;
const MAX_COMMENTS_PER_FEED = 30;

export class QzoneStore {
  constructor({ filePath, clock = () => new Date(), agentQqId = AGENT_QQ_ID, agentNameProvider = getAgentName } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.agentQqId = String(agentQqId || "").trim();
    this.agentNameProvider = typeof agentNameProvider === "function" ? agentNameProvider : () => String(agentNameProvider || "小伴");
    this.state = defaultState();
    this.chain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = normalizeState(loaded);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.pruneTodayFeedsLocked();
    await this.save();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  publicState() {
    const today = shanghaiDateKey(this.clock());
    const {
      targetType, targetId, autoPostEnabled, autoEngageEnabled,
      lastPostAt, lastScanAt, lastSeenFeedId, lastSeenFeedTimeMs, lastError, events, todayFeeds
    } = this.state;
    const filteredTodayFeeds = (Array.isArray(todayFeeds) ? todayFeeds : [])
      .filter((item) => isFeedInDay(item, today))
      .slice(0, MAX_TODAY_FEEDS);
    return {
      targetType,
      targetId,
      autoPostEnabled,
      autoEngageEnabled,
      lastPostAt,
      lastScanAt,
      lastSeenFeedId,
      lastSeenFeedTimeMs,
      lastError,
      events: structuredClone(events),
      todayDate: today,
      todayFeeds: structuredClone(filteredTodayFeeds)
    };
  }

  configure({ targetType = null, targetId = null, autoPostEnabled = false, autoEngageEnabled = false }) {
    return this.enqueue(async () => {
      const nextType = targetType === "group" || targetType === "private" ? targetType : null;
      const nextId = nextType ? String(targetId || "").trim() : null;
      if (nextType && !/^\d{5,14}$/.test(nextId)) throw new Error("QQ 空间绑定会话无效");
      this.state.targetType = nextType;
      this.state.targetId = nextId;
      this.state.autoPostEnabled = Boolean(nextId && autoPostEnabled);
      this.state.autoEngageEnabled = Boolean(nextId && autoEngageEnabled);
      this.state.lastError = null;
      await this.save();
      return this.publicState();
    });
  }

  claimAction(key, kind, detail = {}) {
    return this.enqueue(async () => {
      const id = String(key || "").trim();
      if (!id || this.state.actions[id]) return false;
      this.state.actions[id] = { kind, status: "attempted", at: this.nowIso(), ...detail };
      this.trim();
      await this.save();
      return true;
    });
  }

  finishAction(key, { status = "done", message = "", detail = {} } = {}) {
    return this.enqueue(async () => {
      const action = this.state.actions[String(key || "")];
      if (!action) return null;
      action.status = status;
      action.completedAt = this.nowIso();
      action.message = String(message || "").slice(0, 500);
      Object.assign(action, detail);
      this.state.events.unshift({ kind: action.kind, status, at: action.completedAt, message: action.message });
      this.state.events = this.state.events.slice(0, MAX_EVENTS);
      if (["post", "scheduled-post"].includes(action.kind) && status === "done") this.state.lastPostAt = action.completedAt;
      if (status === "failed") this.state.lastError = action.message;
      else if (status === "done") this.state.lastError = null;
      await this.save();
      return structuredClone(action);
    });
  }

  hasAction(key) {
    return Boolean(this.state.actions[String(key || "")]);
  }

  hasFeed(key) {
    return Boolean(this.state.feeds[String(key || "")]);
  }

  markFeeds(keys = [], { newestFeed = null } = {}) {
    return this.enqueue(async () => {
      for (const key of keys) {
        const id = String(key || "").trim();
        if (id) this.state.feeds[id] = this.nowIso();
      }
      if (newestFeed?.id && Number(newestFeed.timeMs) >= Number(this.state.lastSeenFeedTimeMs || 0)) {
        this.state.lastSeenFeedId = String(newestFeed.id);
        this.state.lastSeenFeedTimeMs = Number(newestFeed.timeMs) || null;
      }
      this.state.lastScanAt = this.nowIso();
      this.pruneTodayFeedsLocked();
      this.trim();
      await this.save();
    });
  }

  recordScannedFeeds(feeds = [], { markScannedToday = true } = {}) {
    return this.enqueue(async () => {
      const today = shanghaiDateKey(this.clock());
      const nowIso = this.nowIso();
      const existingById = new Map(
        (this.state.todayFeeds || [])
          .filter((item) => isFeedInDay(item, today))
          .map((item) => [item.id, item])
      );

      for (const feed of feeds || []) {
        const id = String(feed?.id || (feed?.uin && feed?.tid ? `${feed.uin}:${feed.tid}` : "")).trim();
        if (!id) continue;
        const postDay = shanghaiDateKey(feed.timeMs);
        if (!markScannedToday && postDay !== today) continue;
        const prior = existingById.get(id);
        const merged = mergeTodayFeed(prior, {
          ...feed,
          id,
          scannedAt: nowIso,
          dayKey: today,
          isBotPost: Boolean(feed.isBotPost || (this.agentQqId && String(feed.uin) === this.agentQqId))
        }, this.agentQqId);
        existingById.set(id, merged);
      }

      this.state.todayFeeds = [...existingById.values()];
      this.pruneTodayFeedsLocked();
      await this.save();
      return this.publicState();
    });
  }

  recordBotEngagement({ uin, tid, type, content = "", feed = null } = {}) {
    return this.enqueue(async () => {
      const targetUin = String(uin || "").trim();
      const targetTid = String(tid || "").trim();
      if (!targetUin || !targetTid) return this.publicState();
      const id = `${targetUin}:${targetTid}`;
      const today = shanghaiDateKey(this.clock());
      const now = this.clock();
      const nowIso = now.toISOString();
      const existingById = new Map(
        (this.state.todayFeeds || [])
          .filter((item) => isFeedInDay(item, today))
          .map((item) => [item.id, item])
      );
      const prior = existingById.get(id);
      const base = prior
        ? { ...prior }
        : normalizeTodayFeed({
            id,
            uin: targetUin,
            tid: targetTid,
            nickname: feed?.nickname || targetUin,
            timeMs: Number(feed?.timeMs) || now.getTime(),
            text: feed?.text || "",
            imageCount: Number(feed?.imageCount || 0),
            imageUrls: Array.isArray(feed?.imageUrls) ? feed.imageUrls : [],
            likeCount: Number(feed?.likeCount || 0),
            botLiked: Boolean(feed?.botLiked),
            isBotPost: Boolean(this.agentQqId && targetUin === this.agentQqId),
            scannedAt: nowIso,
            dayKey: today,
            comments: Array.isArray(feed?.comments) ? feed.comments : []
          });
      base.dayKey = today;
      base.scannedAt = nowIso;
      if (type === "like") {
        if (!base.botLiked) {
          base.likeCount = Math.max(1, Number(base.likeCount || 0) + (base.likeCount > 0 ? 0 : 1));
        }
        base.botLiked = true;
      } else if (type === "comment") {
        const text = String(content || "").trim().slice(0, 300);
        if (text) {
          const botComment = normalizeFeedComment({
            id: `bot:${now.getTime()}`,
            uin: this.agentQqId || "bot",
            nickname: this.agentNameProvider(),
            content: text,
            timeText: shanghaiTimeHHMM(now),
            isBot: true,
            at: nowIso
          });
          base.comments = mergeFeedComments(base.comments, [botComment], this.agentQqId);
        }
      }
      existingById.set(id, base);
      this.state.todayFeeds = [...existingById.values()];
      this.pruneTodayFeedsLocked();
      await this.save();
      return this.publicState();
    });
  }

  recordBotPost({ content = "", imageCount = 0 } = {}) {
    return this.enqueue(async () => {
      const text = String(content || "").trim().slice(0, 700);
      if (!text) return this.publicState();
      const now = this.clock();
      const nowIso = now.toISOString();
      const today = shanghaiDateKey(now);
      const uin = this.agentQqId || "bot";
      const tid = `local_${now.getTime()}`;
      const entry = normalizeTodayFeed({
        id: `${uin}:${tid}`,
        uin,
        tid,
        nickname: this.agentNameProvider(),
        timeMs: now.getTime(),
        text,
        imageCount: Math.max(0, Number(imageCount) || 0),
        imageUrls: [],
        likeCount: 0,
        botLiked: false,
        isBotPost: true,
        scannedAt: nowIso,
        dayKey: today,
        comments: []
      });
      this.state.todayFeeds = [entry, ...(this.state.todayFeeds || [])];
      this.pruneTodayFeedsLocked();
      await this.save();
      return this.publicState();
    });
  }

  pruneExpired() {
    return this.enqueue(async () => {
      this.pruneTodayFeedsLocked();
      this.trim();
      await this.save();
      return this.publicState();
    });
  }

  noteError(message) {
    return this.enqueue(async () => {
      this.state.lastError = String(message || "QQ 空间任务失败").slice(0, 500);
      this.state.events.unshift({ kind: "error", status: "failed", at: this.nowIso(), message: this.state.lastError });
      this.state.events = this.state.events.slice(0, MAX_EVENTS);
      await this.save();
    });
  }

  pruneTodayFeedsLocked() {
    const today = shanghaiDateKey(this.clock());
    this.state.todayDate = today;
    const dedup = new Map();
    for (const item of this.state.todayFeeds || []) {
      const normalized = normalizeTodayFeed(item);
      if (!normalized || !isFeedInDay(normalized, today)) continue;
      const prior = dedup.get(normalized.id);
      dedup.set(normalized.id, prior ? mergeTodayFeed(prior, normalized, this.agentQqId) : normalized);
    }
    this.state.todayFeeds = [...dedup.values()]
      .sort((a, b) => (Number(b.timeMs || 0) - Number(a.timeMs || 0)))
      .slice(0, MAX_TODAY_FEEDS);
  }

  trim() {
    this.state.actions = latestEntries(this.state.actions, MAX_ACTIONS);
    this.state.feeds = latestEntries(this.state.feeds, MAX_FEEDS);
  }

  enqueue(operation) {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }

  async save() {
    this.state.updatedAt = this.nowIso();
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  nowIso() {
    return this.clock().toISOString();
  }
}

function defaultState() {
  return {
    version: 1, updatedAt: null,
    targetType: null, targetId: null,
    autoPostEnabled: false, autoEngageEnabled: false,
    lastPostAt: null, lastScanAt: null, lastSeenFeedId: null, lastSeenFeedTimeMs: null, lastError: null,
    actions: {}, feeds: {}, events: [],
    todayDate: null, todayFeeds: []
  };
}

function normalizeState(value) {
  const base = defaultState();
  const targetType = ["group", "private"].includes(value?.targetType) ? value.targetType : null;
  const targetId = targetType && /^\d{5,14}$/.test(String(value?.targetId || "")) ? String(value.targetId) : null;
  return {
    ...base,
    updatedAt: value?.updatedAt || null,
    targetType: targetId ? targetType : null,
    targetId,
    autoPostEnabled: Boolean(targetId && value?.autoPostEnabled),
    autoEngageEnabled: Boolean(targetId && value?.autoEngageEnabled),
    lastPostAt: value?.lastPostAt || null,
    lastScanAt: value?.lastScanAt || null,
    lastSeenFeedId: value?.lastSeenFeedId || null,
    lastSeenFeedTimeMs: Number(value?.lastSeenFeedTimeMs) || null,
    lastError: value?.lastError || null,
    actions: value?.actions && typeof value.actions === "object" ? latestEntries(value.actions, MAX_ACTIONS) : {},
    feeds: value?.feeds && typeof value.feeds === "object" ? latestEntries(value.feeds, MAX_FEEDS) : {},
    events: Array.isArray(value?.events) ? value.events.slice(0, MAX_EVENTS) : [],
    todayDate: typeof value?.todayDate === "string" ? value.todayDate : null,
    todayFeeds: Array.isArray(value?.todayFeeds) ? value.todayFeeds.map(normalizeTodayFeed).filter(Boolean).slice(0, MAX_TODAY_FEEDS) : []
  };
}

export function shanghaiDateKey(input) {
  const date = input instanceof Date ? input : new Date(Number(input) || input || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiTimeHHMM(input) {
  const date = input instanceof Date ? input : new Date(Number(input) || input || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}`;
}

function isFeedInDay(item, today) {
  if (!item || !today) return false;
  if (item.dayKey === today) return true;
  if (item.scannedAt && shanghaiDateKey(item.scannedAt) === today) return true;
  if (item.timeMs && shanghaiDateKey(item.timeMs) === today) return true;
  return false;
}

function normalizeFeedComment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const content = String(raw.content || "").trim().slice(0, 300);
  if (!content) return null;
  const uin = String(raw.uin || "").trim();
  const nickname = String(raw.nickname || uin || "好友").replace(/[\r\n|]/gu, " ").trim().slice(0, 60);
  const timeText = String(raw.timeText || "").trim().slice(0, 24);
  const isBot = Boolean(raw.isBot);
  const id = String(raw.id || `${uin}:${timeText}:${content.slice(0, 24)}`).slice(0, 120);
  return {
    id,
    uin,
    nickname,
    content,
    timeText,
    isBot,
    at: raw.at || null
  };
}

function commentDedupKey(comment) {
  const uin = String(comment?.uin || "").trim();
  const normalized = String(comment?.content || "").replace(/\s+/gu, " ").trim();
  return `${uin}::${normalized}`;
}

function mergeFeedComments(priorComments = [], incomingComments = [], agentQqId = "") {
  const merged = [];
  const indexByKey = new Map();
  const pushOrUpdate = (raw) => {
    const item = normalizeFeedComment(raw);
    if (!item) return;
    if (agentQqId && item.uin === agentQqId) item.isBot = true;
    const key = commentDedupKey(item);
    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      indexByKey.set(key, merged.length);
      merged.push(item);
    } else {
      const prev = merged[existingIdx];
      merged[existingIdx] = {
        ...prev,
        ...item,
        isBot: Boolean(prev.isBot || item.isBot),
        timeText: item.timeText || prev.timeText,
        at: item.at || prev.at
      };
    }
  };
  for (const item of incomingComments || []) pushOrUpdate(item);
  for (const item of priorComments || []) pushOrUpdate(item);
  return merged.slice(0, MAX_COMMENTS_PER_FEED);
}

function normalizeTodayFeed(raw) {
  if (!raw || typeof raw !== "object") return null;
  const uin = String(raw.uin || "").trim();
  const tid = String(raw.tid || "").trim();
  const id = String(raw.id || (uin && tid ? `${uin}:${tid}` : "")).trim();
  if (!id || !uin || !tid) return null;
  const timeMs = Number(raw.timeMs || 0);
  const comments = (Array.isArray(raw.comments) ? raw.comments : []).map(normalizeFeedComment).filter(Boolean).slice(0, MAX_COMMENTS_PER_FEED);
  const imageUrls = Array.isArray(raw.imageUrls)
    ? [...new Set(raw.imageUrls.map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 9)
    : [];
  const imageCount = Math.max(imageUrls.length, Math.max(0, Math.floor(Number(raw.imageCount) || 0)));
  return {
    id,
    uin,
    tid,
    nickname: String(raw.nickname || uin).replace(/[\r\n|]/gu, " ").trim().slice(0, 60),
    timeMs: Number.isFinite(timeMs) && timeMs > 0 ? timeMs : Date.now(),
    text: String(raw.text || "").slice(0, 700),
    imageCount,
    imageUrls,
    likeCount: Math.max(0, Math.floor(Number(raw.likeCount) || 0)),
    botLiked: Boolean(raw.botLiked),
    isBotPost: Boolean(raw.isBotPost),
    scannedAt: raw.scannedAt || null,
    dayKey: typeof raw.dayKey === "string" && raw.dayKey ? raw.dayKey : shanghaiDateKey(timeMs || Date.now()),
    comments
  };
}

function mergeTodayFeed(prior, incoming, agentQqId = "") {
  const next = normalizeTodayFeed(incoming);
  if (!prior) return next;
  const prev = normalizeTodayFeed(prior);
  if (!prev) return next;
  if (!next) return prev;
  const preferIncomingText = next.text && next.text.length >= prev.text.length ? next.text : (prev.text || next.text);
  const nextUrls = next.imageUrls.length ? next.imageUrls : prev.imageUrls;
  return {
    ...prev,
    ...next,
    nickname: next.nickname || prev.nickname,
    text: preferIncomingText,
    imageUrls: nextUrls,
    imageCount: Math.max(prev.imageCount, next.imageCount, nextUrls.length),
    likeCount: Math.max(prev.likeCount, next.likeCount),
    botLiked: Boolean(prev.botLiked || next.botLiked),
    isBotPost: Boolean(prev.isBotPost || next.isBotPost),
    scannedAt: next.scannedAt || prev.scannedAt,
    dayKey: next.dayKey || prev.dayKey,
    comments: mergeFeedComments(prev.comments, next.comments, agentQqId)
  };
}

function latestEntries(record, limit) {
  return Object.fromEntries(Object.entries(record).slice(-limit));
}
