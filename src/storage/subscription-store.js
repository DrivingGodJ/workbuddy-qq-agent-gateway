import { randomUUID } from "node:crypto";
import { recentNotificationReceipts } from "../security/subscription-input.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { rateLimitResumeAt } from "./session-store.js";
import { dirname } from "node:path";

export const SUBSCRIPTION_MODE = Object.freeze({ AUTO: "AUTO" });
export const SUBSCRIPTION_INTAKE = Object.freeze({ ALL: "ALL", ADMIN_ONLY: "ADMIN_ONLY" });

export class SubscriptionStore {
  constructor({ filePath, clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.state = createState();
    this.saveChain = Promise.resolve();
    this.transientRetryAt = new Map();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.filePath, "utf8")), this.clock());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const subscription of Object.values(this.state.subscriptions)) {
      subscription.state.processingUntilSequence = null;
      subscription.state.processingUntilMessageId = null;
      if (isTransientTurnCollision(subscription.state.lastError)) subscription.state.lastError = null;
      for (const collection of subscription.state.collections) {
        if (collection.status === "processing") collection.status = "collecting";
      }
    }
    for (const sourceId of Object.keys(this.state.sources)) this.garbageCollectSource(sourceId);
    await this.save();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  listSubscriptions({ targetType = null, targetId = null, sourceGroupId = null, enabled = null } = {}) {
    return Object.values(this.state.subscriptions)
      .filter((item) => targetType == null || item.targetType === targetType)
      .filter((item) => targetId == null || item.targetId === String(targetId))
      .filter((item) => sourceGroupId == null || item.sourceGroupId === String(sourceGroupId))
      .filter((item) => enabled == null || item.enabled === Boolean(enabled))
      .map((item) => this.publicSubscription(item));
  }

  sourceGroupIds() {
    return [...new Set(Object.values(this.state.subscriptions).filter((item) => item.enabled).map((item) => item.sourceGroupId))];
  }

  privateTargetIds() {
    return [...new Set(Object.values(this.state.subscriptions).filter((item) => item.enabled && item.targetType === "private").map((item) => item.targetId))];
  }

  referencedImages() {
    return Object.values(this.state.sources).flatMap((source) => source.messages.flatMap((message) => message.images || []));
  }

  isSourceRecalled(groupId, messageId) {
    return this.ensureSource(groupId).recalledMessageIds.includes(String(messageId));
  }

  async recallSourceMessage(groupId, messageId) {
    const source = this.ensureSource(groupId);
    const id = String(messageId);
    if (!id || source.recalledMessageIds.includes(id)) return { removedMessages: [], removedImages: [], activeTargets: [] };
    source.recalledMessageIds = [...source.recalledMessageIds, id].slice(-512);
    const removedMessages = [...source.messages, ...source.recentMessages].filter((message) => String(message.messageId) === id);
    const recalledSequences = new Set(removedMessages
      .map((message) => Number(message.sequence)));
    source.messages = source.messages.filter((message) => String(message.messageId) !== id);
    source.recentMessages = source.recentMessages.filter((message) => String(message.messageId) !== id);
    const removedImages = [];
    const redactedSequences = new Set();
    for (const message of [...source.messages, ...source.recentMessages]) {
      if (String(message.replyToMessageId || "") !== id && String(message.quotedMessage?.messageId || "") !== id) continue;
      message.quotedMessage = null;
      message.quoteError = "被引用消息已撤回";
      removedImages.push(...(message.images || []).filter((image) => image.context === "quoted"));
      message.images = (message.images || []).filter((image) => image.context !== "quoted");
      redactedSequences.add(Number(message.sequence));
    }
    const affectedSequences = new Set([...recalledSequences, ...redactedSequences]);
    const activeTargets = new Set();
    for (const subscription of Object.values(this.state.subscriptions)) {
      if (subscription.sourceGroupId !== String(groupId)) continue;
      const relevant = subscription.state.pendingSequences.some((sequence) => affectedSequences.has(Number(sequence)))
        || Object.values(subscription.state.contextByTrigger).some((sequences) => sequences.some((sequence) => affectedSequences.has(Number(sequence))));
      if (relevant && subscription.state.processingUntilSequence != null) activeTargets.add(targetKey(subscription.targetType, subscription.targetId));
      subscription.state.pendingSequences = subscription.state.pendingSequences.filter((sequence) => !recalledSequences.has(Number(sequence)));
      for (const [trigger, context] of Object.entries(subscription.state.contextByTrigger)) {
        if (recalledSequences.has(Number(trigger))) delete subscription.state.contextByTrigger[trigger];
        else subscription.state.contextByTrigger[trigger] = context.filter((sequence) => !recalledSequences.has(Number(sequence)));
      }
    }
    removedMessages.push(...this.garbageCollectSource(groupId));
    await this.save();
    return { removedMessages, removedImages, activeTargets: [...activeTargets] };
  }

  async upsertSubscription(input) {
    if (input.mode != null && input.mode !== SUBSCRIPTION_MODE.AUTO) {
      throw new Error("通知订阅仅支持自动处理，静默模式已移除");
    }
    const normalized = normalizeSubscription(input);
    const existing = normalized.id ? this.state.subscriptions[normalized.id] : null;
    if (normalized.id && !existing) throw new Error("Subscription does not exist");
    if (existing?.state.processingUntilSequence != null) throw new Error("Subscription is currently processing and cannot be edited");
    const duplicate = Object.values(this.state.subscriptions).find((item) =>
      item.id !== normalized.id && item.targetType === normalized.targetType && item.targetId === normalized.targetId && item.sourceGroupId === normalized.sourceGroupId
    );
    if (duplicate) throw new Error("This conversation already subscribes to that source group");

    const previousSourceGroupId = existing?.sourceGroupId || null;
    const source = this.ensureSource(normalized.sourceGroupId);
    const latestSequence = maxSourceSequence(source);
    const subscription = existing || {
      id: normalized.id || randomUUID(),
      createdAt: this.clock().toISOString(),
      state: createSubscriptionState(latestSequence)
    };
    const wasEnabled = subscription.enabled !== false;
    const previousIntakeMode = subscription.intakeMode || normalized.intakeMode;
    Object.assign(subscription, normalized, { id: subscription.id, updatedAt: this.clock().toISOString() });
    if (previousSourceGroupId && previousSourceGroupId !== normalized.sourceGroupId) resetSubscriptionAt(subscription, latestSequence);
    if (wasEnabled && !subscription.enabled) resetSubscriptionAt(subscription, latestSequence);
    if (!wasEnabled && subscription.enabled) resetSubscriptionAt(subscription, latestSequence);
    if (previousIntakeMode !== normalized.intakeMode && normalized.intakeMode === SUBSCRIPTION_INTAKE.ADMIN_ONLY) {
      const accepted = new Set(source.messages.filter((message) => acceptsMessage(subscription, message)).map((message) => message.sequence));
      subscription.state.pendingSequences = subscription.state.pendingSequences.filter((sequence) => accepted.has(sequence));
    }
    if (!usesAdminContext(subscription)) subscription.state.contextByTrigger = {};
    this.state.subscriptions[subscription.id] = subscription;
    if (usesAdminContext(subscription)) rebuildMissingContexts(subscription, source);
    const removedMessages = [
      ...this.garbageCollectSource(normalized.sourceGroupId),
      ...(previousSourceGroupId && previousSourceGroupId !== normalized.sourceGroupId ? this.garbageCollectSource(previousSourceGroupId) : [])
    ];
    await this.save();
    return { subscription: this.publicSubscription(subscription), removedMessages };
  }

  async deleteSubscription(id) {
    const subscription = this.state.subscriptions[String(id)];
    if (!subscription) return { deleted: false, removedMessages: [] };
    if (subscription.state.processingUntilSequence != null) throw new Error("Subscription is currently processing and cannot be deleted");
    delete this.state.subscriptions[subscription.id];
    const removedMessages = this.garbageCollectSource(subscription.sourceGroupId);
    await this.save();
    return { deleted: true, removedMessages };
  }

  // Called only after the target is blocked and has no active worker. An
  // archived failed-delivery claim may also be discarded by this explicit removal.
  async removeTarget(targetType, targetId) {
    const subscriptions = Object.values(this.state.subscriptions)
      .filter((item) => item.targetType === targetType && item.targetId === String(targetId));
    for (const item of subscriptions) delete this.state.subscriptions[item.id];
    const removedMessages = [...new Set(subscriptions.map((item) => item.sourceGroupId))]
      .flatMap((id) => this.garbageCollectSource(id));
    if (subscriptions.length) await this.save();
    return { count: subscriptions.length, removedMessages };
  }

  async setSourceMetadata(groupId, metadata = {}) {
    const source = this.ensureSource(groupId);
    source.groupName = String(metadata.groupName || "").trim() || source.groupName;
    await this.save();
  }

  async appendSourceMessage(message) {
    const source = this.ensureSource(message.groupId);
    if (source.recalledMessageIds.includes(String(message.messageId))) {
      return { duplicate: true, recalled: true, message: null, affectedTargets: [], removedMessages: [] };
    }
    if ([...source.messages, ...source.recentMessages].some((item) => item.messageId === String(message.messageId))) {
      return { duplicate: true, message: null, affectedTargets: [], removedMessages: [] };
    }
    const stored = { ...structuredClone(message), sequence: this.state.nextSequence++ };
    delete stored.imageRefs;
    delete stored.attachmentRefs;
    const recentBefore = source.recentMessages.slice(-10);
    source.messages.push(stored);
    source.lastActivityAt = stored.timestamp || this.clock().toISOString();
    const now = this.clock();
    const affectedTargets = new Set();

    for (const subscription of Object.values(this.state.subscriptions)) {
      if (!subscription.enabled || subscription.sourceGroupId !== source.groupId) continue;
      subscription.state.lastSeenSequence = stored.sequence;
      const openAutoAdminCollection = isOpenAutoAdminCollection(subscription, now);
      const accepted = acceptsMessage(subscription, stored) || openAutoAdminCollection;
      if (!accepted) continue;
      subscription.state.pendingSequences.push(stored.sequence);
      affectedTargets.add(targetKey(subscription.targetType, subscription.targetId));
      if (subscription.mode === SUBSCRIPTION_MODE.AUTO) appendToDebouncedCollection(subscription, stored.sequence, now);
      if (usesAdminContext(subscription) && isAdminMessage(stored) && !openAutoAdminCollection) {
        subscription.state.contextByTrigger[String(stored.sequence)] = recentBefore.map((item) => Number(item.sequence));
        for (const recent of recentBefore) ensureActiveMessage(source, recent);
      }
    }
    source.recentMessages = this.sourceNeedsRecentContext(source.groupId)
      ? [...recentBefore, toRecentMessage(stored)].slice(-10)
      : [];
    source.messages.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const removedMessages = this.garbageCollectSource(source.groupId);
    await this.save();
    return { duplicate: false, message: structuredClone(stored), affectedTargets: [...affectedTargets], removedMessages };
  }

  dueAutoTargets(now = this.clock()) {
    const timestamp = now.getTime();
    return [...new Set(Object.values(this.state.subscriptions)
      .filter((item) => item.enabled && item.mode === SUBSCRIPTION_MODE.AUTO && !item.state.lastError)
      .filter((item) => item.state.collections.some((collection) => collection.status === "collecting" && new Date(collection.deadline).getTime() <= timestamp))
      .filter((item) => (this.transientRetryAt.get(targetKey(item.targetType, item.targetId)) || 0) <= timestamp)
      .map((item) => targetKey(item.targetType, item.targetId)))];
  }

  async claimForTarget(targetType, targetId, { mode = SUBSCRIPTION_MODE.AUTO } = {}) {
    if (mode !== SUBSCRIPTION_MODE.AUTO) return [];
    const contexts = [];
    const now = this.clock().getTime();
    let changed = false;
    const subscriptions = Object.values(this.state.subscriptions)
      .filter((item) => item.enabled && item.targetType === targetType && item.targetId === String(targetId))
      .filter((item) => !mode || item.mode === mode);
    if (mode === SUBSCRIPTION_MODE.AUTO) subscriptions.sort((left, right) => {
      const dueAt = (item) => Math.min(...item.state.collections
        .filter((collection) => collection.status === "collecting" && new Date(collection.deadline).getTime() <= now)
        .map((collection) => new Date(collection.deadline).getTime()), Infinity);
      return dueAt(left) - dueAt(right) || String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || left.id.localeCompare(right.id);
    });
    for (const subscription of subscriptions) {
      if (!subscription.enabled || subscription.targetType !== targetType || subscription.targetId !== String(targetId)) continue;
      if (mode && subscription.mode !== mode) continue;
      let sequences = [];
      let collectionId = null;
      let collectionIds = [];
      {
        const collections = subscription.state.collections.filter((item) =>
          item.status === "collecting" && new Date(item.deadline).getTime() <= now
        );
        if (!collections.length) continue;
        for (const collection of collections) collection.status = "processing";
        changed = true;
        collectionIds = collections.map((collection) => collection.id);
        collectionId = collectionIds[0];
        sequences = subscription.state.pendingSequences.filter((sequence) =>
          collections.some((collection) => sequence >= collection.fromSequence && sequence <= collection.cutoffSequence)
        );
      }
      if (!sequences.length) {
        if (collectionId) {
          for (const collection of subscription.state.collections.filter((item) => collectionIds.includes(item.id))) {
            collection.status = "completed";
            collection.completedAt = this.clock().toISOString();
          }
          trimCompletedCollections(subscription);
        }
        subscription.state.processingUntilSequence = null;
        subscription.state.processingUntilMessageId = null;
        continue;
      }
      const cutoffSequence = sequences.at(-1);
      subscription.state.processingUntilSequence = cutoffSequence;
      const source = this.ensureSource(subscription.sourceGroupId);
      const messages = claimMessages(source, sequences, subscription);
      subscription.state.processingUntilMessageId = lastMessageId(messages);
      contexts.push({
        subscriptionId: subscription.id,
        targetType,
        targetId: String(targetId),
        sourceGroupId: subscription.sourceGroupId,
        sourceGroupName: source.groupName,
        mode: subscription.mode,
        intakeMode: subscription.intakeMode,
        collectionId,
        collectionIds,
        cutoffSequence,
        messages,
        notifiedFingerprints: recentNotificationReceipts(subscription.state.notifiedFingerprints, now)
      });
      // One AUTO turn is one source group. Other due sources remain collecting.
      if (mode === SUBSCRIPTION_MODE.AUTO) break;
    }
    if (contexts.length || changed) await this.save();
    return contexts;
  }

  async releaseClaims(contexts = []) {
    for (const context of contexts) {
      const subscription = this.state.subscriptions[context.subscriptionId];
      if (!subscription) continue;
      subscription.state.processingUntilSequence = null;
      subscription.state.processingUntilMessageId = null;
      for (const collection of subscription.state.collections.filter((item) => claimCollectionIds(context).includes(item.id))) {
        if (collection.status === "processing") collection.status = "collecting";
      }
    }
    if (contexts.length) await this.save();
  }

  async completeClaims(contexts = []) {
    const sourceIds = new Set();
    for (const context of contexts) {
      const subscription = this.state.subscriptions[context.subscriptionId];
      if (!subscription) continue;
      const cutoff = Number(context.cutoffSequence || 0);
      subscription.state.pendingSequences = subscription.state.pendingSequences.filter((sequence) => sequence > cutoff);
      for (const sequence of Object.keys(subscription.state.contextByTrigger)) {
        if (Number(sequence) <= cutoff) delete subscription.state.contextByTrigger[sequence];
      }
      subscription.state.lastConsumedSequence = Math.max(subscription.state.lastConsumedSequence, cutoff);
      subscription.state.lastConsumedMessageId = lastMessageId(context.messages) || subscription.state.lastConsumedMessageId;
      subscription.state.lastCompletedAt = this.clock().toISOString();
      subscription.state.processingUntilSequence = null;
      subscription.state.processingUntilMessageId = null;
      subscription.state.lastError = null;
      const now = this.clock();
      subscription.state.notifiedFingerprints = recentNotificationReceipts([
        ...(subscription.state.notifiedFingerprints || []),
        ...(context.notificationFingerprints || []).map((fingerprint) => ({ fingerprint, notifiedAt: now.toISOString() }))
      ], now.getTime());
      for (const collection of subscription.state.collections.filter((item) => claimCollectionIds(context).includes(item.id))) {
        collection.status = "completed";
        collection.completedAt = now.toISOString();
      }
      trimCompletedCollections(subscription);
      sourceIds.add(subscription.sourceGroupId);
    }
    const removedMessages = [...sourceIds].flatMap((sourceId) => this.garbageCollectSource(sourceId));
    if (contexts.length) await this.save();
    return removedMessages;
  }

  async failClaims(contexts, error) {
    const transientCollision = isTransientTurnCollision(error?.message || error);
    for (const context of contexts || []) {
      const subscription = this.state.subscriptions[context.subscriptionId];
      if (!subscription) continue;
      subscription.state.lastError = transientCollision ? null : String(error?.message || error).slice(0, 2000);
      if (transientCollision) {
        this.transientRetryAt.set(targetKey(subscription.targetType, subscription.targetId), this.clock().getTime() + 10_000);
      }
    }
    await this.releaseClaims(contexts);
  }

  async retryFailedForTarget(targetType, targetId) {
    let count = 0;
    for (const subscription of Object.values(this.state.subscriptions)) {
      if (!subscription.enabled || subscription.targetType !== targetType || subscription.targetId !== String(targetId)) continue;
      if (!subscription.state.lastError) continue;
      subscription.state.lastError = null;
      count += 1;
    }
    if (count) await this.save();
    return count;
  }

  async retryRateLimitedForTarget(targetType, targetId) {
    let count = 0;
    for (const subscription of Object.values(this.state.subscriptions)) {
      if (!subscription.enabled || subscription.targetType !== targetType || subscription.targetId !== String(targetId)) continue;
      if (!rateLimitResumeAt(subscription.state.lastError)) continue;
      subscription.state.lastError = null;
      count += 1;
    }
    if (count) await this.save();
    return count;
  }

  publicSources(metadata = {}, targetViews = {}, { dispatchEnabled = true } = {}) {
    return Object.fromEntries(this.sourceGroupIds().map((groupId) => {
      const source = this.ensureSource(groupId);
      const subscriptions = Object.values(this.state.subscriptions)
        .filter((item) => item.enabled && item.sourceGroupId === groupId);
      const referenceCounts = new Map();
      for (const subscription of subscriptions) {
        for (const sequence of neededSourceSequences(subscription)) {
          referenceCounts.set(sequence, (referenceCounts.get(sequence) || 0) + 1);
        }
      }
      const subscriberProgress = subscriptions.map((subscription) => subscriptionProgress(
        subscription, source, targetViews[targetKey(subscription.targetType, subscription.targetId)],
        { dispatchEnabled, now: this.clock().getTime() }
      ));
      const retainedSequences = new Set(source.messages.map((message) => Number(message.sequence)));
      const visibleBySequence = new Map(source.recentMessages.map((message) => [Number(message.sequence), message]));
      for (const message of source.messages) visibleBySequence.set(Number(message.sequence), message);
      const visibleMessages = [...visibleBySequence.values()]
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
        .slice(-100)
        .map((message) => ({
          ...structuredClone(message),
          retainedBySubscription: retainedSequences.has(Number(message.sequence)),
          pendingSubscriberCount: referenceCounts.get(Number(message.sequence)) || 0
        }));
      return [groupId, {
        groupId,
        groupName: metadata[groupId]?.groupName || source.groupName || null,
        lastActivityAt: source.lastActivityAt,
        retainedMessages: source.messages.slice(-100),
        retainedCount: source.messages.length,
        recentCount: source.recentMessages.length,
        visibleMessages,
        visibleCount: visibleBySequence.size,
        subscriptionCount: subscriptions.length,
        subscriberProgress,
        pendingSubscriberCount: subscriberProgress.filter((item) => item.pendingCount > 0).length,
        failedSubscriberCount: subscriberProgress.filter((item) => item.status === "failed").length,
        neverReplies: true
      }];
    }));
  }

  publicSubscription(subscription) {
    const source = this.state.sources[subscription.sourceGroupId];
    const pendingSet = new Set(subscription.state.pendingSequences);
    return {
      id: subscription.id,
      targetType: subscription.targetType,
      targetId: subscription.targetId,
      sourceGroupId: subscription.sourceGroupId,
      sourceGroupName: source?.groupName || null,
      mode: subscription.mode,
      intakeMode: subscription.intakeMode,
      collectionDelayMinutes: subscription.collectionDelayMinutes,
      enabled: subscription.enabled,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      state: {
        pendingMessages: (source?.messages || []).filter((message) => pendingSet.has(message.sequence)),
        pendingCount: subscription.state.pendingSequences.length,
        collectionStartedAt: activeCollection(subscription)?.startedAt || null,
        collectionDeadline: activeCollection(subscription)?.deadline || null,
        processingUntilMessageId: subscription.state.processingUntilMessageId,
        lastConsumedMessageId: subscription.state.lastConsumedMessageId,
        lastCompletedAt: subscription.state.lastCompletedAt,
        lastError: subscription.state.lastError
      }
    };
  }

  ensureSource(groupId) {
    const id = String(groupId || "");
    if (!id) throw new Error("Source group id is required");
    this.state.sources[id] ||= { groupId: id, groupName: null, lastActivityAt: null, messages: [], recentMessages: [], recalledMessageIds: [] };
    this.state.sources[id].recentMessages ||= [];
    this.state.sources[id].recalledMessageIds ||= [];
    return this.state.sources[id];
  }

  sourceNeedsRecentContext(groupId) {
    return Object.values(this.state.subscriptions).some((subscription) =>
      subscription.enabled && subscription.sourceGroupId === String(groupId) && usesAdminContext(subscription)
    );
  }

  garbageCollectSource(groupId) {
    const source = this.state.sources[String(groupId)];
    if (!source) return [];
    const subscriptions = Object.values(this.state.subscriptions).filter((item) => item.enabled && item.sourceGroupId === String(groupId));
    const neededSequences = new Set();
    for (const subscription of subscriptions) {
      const pending = new Set(subscription.state.pendingSequences.map(Number));
      for (const sequence of Object.keys(subscription.state.contextByTrigger)) {
        if (!pending.has(Number(sequence))) {
          delete subscription.state.contextByTrigger[sequence];
        }
      }
      for (const sequence of neededSourceSequences(subscription)) neededSequences.add(sequence);
    }
    const removed = source.messages.filter((message) => !neededSequences.has(Number(message.sequence)));
    source.messages = source.messages.filter((message) => neededSequences.has(Number(message.sequence)));
    if (!this.sourceNeedsRecentContext(groupId)) source.recentMessages = [];
    return removed;
  }

  async pruneExpiredSourceMessages({ maxPerSource = 120, maxAgeMs = 72 * 60 * 60 * 1000 } = {}) {
    const now = this.clock().getTime();
    const ageLimit = Math.max(60_000, Number(maxAgeMs) || 72 * 60 * 60 * 1000);
    const cutoff = now - ageLimit;
    const activeProtectCutoff = now - Math.min(ageLimit, 24 * 60 * 60 * 1000);
    const maxItems = Math.max(10, Math.floor(Number(maxPerSource) || 120));
    const removedMessages = [];
    let changed = false;

    for (const source of Object.values(this.state.sources)) {
      const subs = Object.values(this.state.subscriptions).filter((sub) => sub.sourceGroupId === source.groupId);
      const protectedSequences = new Set();
      for (const sub of subs) {
        if (sub.state.processingUntilSequence != null) {
          for (const seq of sub.state.pendingSequences) protectedSequences.add(Number(seq));
        }
        if (sub.enabled) {
          for (const seq of sub.state.pendingSequences) {
            const msg = source.messages.find((item) => Number(item.sequence) === Number(seq));
            const ts = Date.parse(msg?.receivedAt || msg?.timestamp || "");
            if (!Number.isFinite(ts) || ts >= activeProtectCutoff) {
              protectedSequences.add(Number(seq));
            }
          }
        }
      }

      const fresh = [];
      for (const message of source.messages) {
        const ts = Date.parse(message?.receivedAt || message?.timestamp || "");
        const expired = Number.isFinite(ts) && ts < cutoff;
        if (expired && !protectedSequences.has(Number(message.sequence))) {
          removedMessages.push(message);
          changed = true;
        } else {
          fresh.push(message);
        }
      }

      if (fresh.length > maxItems) {
        let toDrop = fresh.length - maxItems;
        const retained = [];
        for (const message of fresh) {
          if (toDrop > 0 && !protectedSequences.has(Number(message.sequence))) {
            removedMessages.push(message);
            toDrop -= 1;
            changed = true;
          } else {
            retained.push(message);
          }
        }
        source.messages = retained;
      } else if (fresh.length !== source.messages.length) {
        source.messages = fresh;
      }

      const remainingSeqs = new Set(source.messages.map((message) => Number(message.sequence)));
      for (const sub of subs) {
        const nextPending = sub.state.pendingSequences.filter((seq) => remainingSeqs.has(Number(seq)));
        if (nextPending.length !== sub.state.pendingSequences.length) {
          sub.state.pendingSequences = nextPending;
          changed = true;
        }
      }

      const nextRecent = source.recentMessages.filter((message) => {
        const ts = Date.parse(message?.receivedAt || message?.timestamp || "");
        return !Number.isFinite(ts) || ts >= cutoff;
      }).slice(-10);
      if (nextRecent.length !== source.recentMessages.length) {
        source.recentMessages = nextRecent;
        changed = true;
      }

      const gcRemoved = this.garbageCollectSource(source.groupId);
      if (gcRemoved.length > 0) {
        removedMessages.push(...gcRemoved);
        changed = true;
      }
    }

    if (changed) await this.save();
    return { removedMessages };
  }

  async save() {
    this.state.updatedAt = this.clock().toISOString();
    const body = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    this.saveChain = this.saveChain.then(async () => {
      await writeFile(tempPath, body, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    return this.saveChain;
  }
}

function neededSourceSequences(subscription) {
  const pending = new Set(subscription.state.pendingSequences.map(Number));
  const needed = new Set(pending);
  for (const sequence of pending) {
    for (const contextSequence of subscription.state.contextByTrigger[String(sequence)] || []) {
      needed.add(Number(contextSequence));
    }
  }
  return needed;
}

function subscriptionProgress(subscription, source, target, { dispatchEnabled, now }) {
  const pendingCount = subscription.state.pendingSequences.length;
  const delivery = (target?.failedDelivery?.subscriptionIds || [])
    .includes(subscription.id);
  const collectionDeadline = activeCollection(subscription)?.deadline || null;
  const hasCurrentReceipt = source.messages.some((message) =>
    Number(message.sequence) <= Number(subscription.state.lastConsumedSequence || 0)
  );
  let status = "idle";
  if (subscription.state.lastError || (delivery && !target?.activeReply?.running)) status = "failed";
  else if (delivery) status = "sending";
  else if (subscription.state.processingUntilSequence != null) status = "running";
  else if (pendingCount && (!dispatchEnabled || target?.replyEnabled === false)) status = "paused";
  else if (pendingCount && collectionDeadline && new Date(collectionDeadline).getTime() > now) status = "collecting";
  else if (pendingCount) status = "queued";
  else if (subscription.state.lastCompletedAt && (hasCurrentReceipt || source.messages.length === 0)) status = "complete";
  return {
    subscriptionId: subscription.id,
    targetType: subscription.targetType,
    targetId: subscription.targetId,
    targetName: target?.displayName || target?.groupName || null,
    mode: subscription.mode,
    status,
    pendingCount,
    collectionDeadline,
    lastCompletedAt: subscription.state.lastCompletedAt || null,
    lastError: subscription.state.lastError || (delivery && !target?.activeReply?.running ? target?.lastError || "QQ 发送尚未完成" : null)
  };
}

function createState() {
  return { version: 4, updatedAt: null, nextSequence: 1, sources: {}, subscriptions: {} };
}

function createSubscriptionState(latestSequence = 0) {
  return {
    pendingSequences: [],
    collections: [],
    lastSeenSequence: Number(latestSequence || 0),
    lastConsumedSequence: Number(latestSequence || 0),
    lastConsumedMessageId: null,
    lastCompletedAt: null,
    processingUntilSequence: null,
    processingUntilMessageId: null,
    contextByTrigger: {},
    notifiedFingerprints: [],
    lastError: null
  };
}

function normalizeState(value, now) {
  const state = { ...createState(), ...value, sources: {}, subscriptions: {} };
  state.version = 4;
  const migrationHistory = {};
  for (const [groupId, raw] of Object.entries(value?.sources || {})) {
    const messages = Array.isArray(raw.messages) ? raw.messages : [];
    const history = Array.isArray(raw.history)
      ? raw.history
      : Array.isArray(raw.recentMessages) ? raw.recentMessages : messages;
    migrationHistory[groupId] = history.map(toRecentMessage);
    state.sources[groupId] = {
      groupId,
      groupName: raw.groupName || null,
      lastActivityAt: raw.lastActivityAt || null,
      messages,
      recentMessages: (Array.isArray(raw.recentMessages) ? raw.recentMessages : history).map(toRecentMessage).slice(-10),
      recalledMessageIds: Array.isArray(raw.recalledMessageIds) ? raw.recalledMessageIds.map(String).slice(-512) : []
    };
    for (const message of [...messages, ...history]) state.nextSequence = Math.max(state.nextSequence, Number(message.sequence || 0) + 1);
  }
  for (const [id, raw] of Object.entries(value?.subscriptions || {})) {
    const normalized = normalizeSubscription({ ...raw, id });
    state.subscriptions[id] = {
      ...normalized,
      id,
      createdAt: raw.createdAt || null,
      updatedAt: raw.updatedAt || null,
      state: {
        ...createSubscriptionState(),
        ...(raw.state || {}),
        pendingSequences: Array.isArray(raw.state?.pendingSequences) ? raw.state.pendingSequences.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [],
        collections: Array.isArray(raw.state?.collections) ? raw.state.collections : [],
        lastCompletedAt: raw.state?.lastCompletedAt || (raw.state?.collections || [])
          .filter((item) => item.status === "completed" && item.completedAt)
          .map((item) => item.completedAt).sort().at(-1) || null,
        contextByTrigger: normalizeContextMap(raw.state?.contextByTrigger)
      }
    };
    // Migrate legacy background subscriptions without resetting notices,
    // cursors, context, receipts, errors or enabled state. Start a normal wait.
    if (raw.mode === "SILENT") appendCollectionForPending(state.subscriptions[id], now);
  }
  for (const subscription of Object.values(state.subscriptions)) {
    if (!usesAdminContext(subscription)) {
      subscription.state.contextByTrigger = {};
      continue;
    }
    const source = state.sources[subscription.sourceGroupId];
    if (!source) continue;
    const history = migrationHistory[subscription.sourceGroupId] || [];
    for (const triggerSequence of subscription.state.pendingSequences) {
      const triggerMessage = history.find((message) => Number(message.sequence) === Number(triggerSequence));
      if (!isAdminMessage(triggerMessage)) continue;
      const key = String(triggerSequence);
      if (!subscription.state.contextByTrigger[key]) {
        subscription.state.contextByTrigger[key] = history
          .filter((message) => Number(message.sequence) < Number(triggerSequence))
          .slice(-10)
          .map((message) => Number(message.sequence));
      }
      for (const contextSequence of subscription.state.contextByTrigger[key]) {
        const message = history.find((candidate) => Number(candidate.sequence) === Number(contextSequence));
        if (message) ensureActiveMessage(source, message);
      }
    }
    source.messages.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }
  return state;
}

function normalizeSubscription(input) {
  const targetType = input.targetType === "private" ? "private" : "group";
  const targetId = String(input.targetId || "").trim();
  const sourceGroupId = String(input.sourceGroupId || "").trim();
  if (!/^\d{5,14}$/.test(targetId)) throw new Error("Target QQ id is invalid");
  if (!/^\d{5,14}$/.test(sourceGroupId)) throw new Error("Source QQ group id is invalid");
  if (targetType === "group" && targetId === sourceGroupId) throw new Error("A source group cannot subscribe to itself");
  return {
    id: input.id ? String(input.id) : null,
    targetType,
    targetId,
    sourceGroupId,
    mode: SUBSCRIPTION_MODE.AUTO,
    intakeMode: input.intakeMode === SUBSCRIPTION_INTAKE.ADMIN_ONLY ? SUBSCRIPTION_INTAKE.ADMIN_ONLY : SUBSCRIPTION_INTAKE.ALL,
    collectionDelayMinutes: Math.min(1440, Math.max(0.1, Number(input.collectionDelayMinutes || input.delayMinutes || 10))),
    enabled: input.enabled !== false
  };
}

function appendToDebouncedCollection(subscription, sequence, now) {
  let collection = subscription.state.collections.at(-1) || null;
  if (!collection || collection.status !== "collecting" || now.getTime() >= new Date(collection.deadline).getTime()) {
    collection = {
      id: randomUUID(),
      startedAt: now.toISOString(),
      deadline: new Date(now.getTime() + subscription.collectionDelayMinutes * 60 * 1000).toISOString(),
      fromSequence: sequence,
      cutoffSequence: sequence,
      status: "collecting",
      completedAt: null
    };
    subscription.state.collections.push(collection);
  } else {
    collection.cutoffSequence = sequence;
    collection.deadline = new Date(now.getTime() + subscription.collectionDelayMinutes * 60 * 1000).toISOString();
  }
}

function appendCollectionForPending(subscription, now) {
  const sequences = subscription.state.pendingSequences;
  if (!sequences.length) return;
  const deadline = Math.max(now.getTime() + subscription.collectionDelayMinutes * 60 * 1000,
    ...subscription.state.collections.filter((item) => item.status !== "completed")
      .map((item) => Date.parse(item.deadline)).filter(Number.isFinite));
  // A single cutoff batch includes every retained legacy notice. Separate,
  // out-of-order ranges could consume unseen earlier messages on completion.
  subscription.state.collections = subscription.state.collections.filter((item) => item.status === "completed");
  subscription.state.collections.push({
    id: randomUUID(),
    startedAt: now.toISOString(),
    deadline: new Date(deadline).toISOString(),
    fromSequence: sequences[0],
    cutoffSequence: sequences.at(-1),
    status: "collecting",
    completedAt: null
  });
}

function acceptsMessage(subscription, message) {
  if (subscription.intakeMode === SUBSCRIPTION_INTAKE.ALL) return true;
  return isAdminMessage(message);
}

function isAdminMessage(message) {
  return ["owner", "admin"].includes(String(message?.senderRole || "member").toLowerCase());
}

function isOpenAutoAdminCollection(subscription, now) {
  if (subscription.mode !== SUBSCRIPTION_MODE.AUTO || subscription.intakeMode !== SUBSCRIPTION_INTAKE.ADMIN_ONLY) return false;
  const collection = subscription.state.collections.at(-1);
  return Boolean(collection?.status === "collecting" && now.getTime() < new Date(collection.deadline).getTime());
}

function activeCollection(subscription) {
  return subscription.state.collections.find((item) => ["collecting", "processing"].includes(item.status)) || null;
}

function trimCompletedCollections(subscription) {
  const unfinished = subscription.state.collections.filter((item) => item.status !== "completed");
  const completed = subscription.state.collections.filter((item) => item.status === "completed").slice(-10);
  subscription.state.collections = [...completed, ...unfinished].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function resetSubscriptionAt(subscription, sequence) {
  subscription.state = createSubscriptionState(sequence);
}

function lastMessageId(messages) {
  const trigger = [...(messages || [])].reverse().find((message) => !message.contextOnly);
  return trigger?.messageId || messages?.at(-1)?.messageId || null;
}

function claimCollectionIds(context) {
  return context.collectionIds?.length ? context.collectionIds : (context.collectionId ? [context.collectionId] : []);
}

function targetKey(type, id) {
  return `${type}:${id}`;
}

function isTransientTurnCollision(error) {
  return /目标 [^\s]+ 已有进行中的轮次|WorkBuddy thread [^\s]+ already has a running turn|QQ group [^\s]+ already has a running turn/u.test(String(error || ""));
}

function claimMessages(source, sequences, subscription) {
  const triggerSequences = new Set(sequences.map(Number));
  if (!usesAdminContext(subscription)) {
    return structuredClone(source.messages
      .filter((message) => triggerSequences.has(Number(message.sequence)))
      .map((message) => ({ ...message, contextOnly: false })));
  }

  const included = new Set(triggerSequences);
  for (const sequence of triggerSequences) {
    for (const contextSequence of subscription.state.contextByTrigger[String(sequence)] || []) included.add(Number(contextSequence));
  }
  return structuredClone(source.messages
    .filter((message) => included.has(Number(message.sequence)))
    .map((message) => ({ ...message, contextOnly: !triggerSequences.has(Number(message.sequence)) })));
}

function usesAdminContext(subscription) {
  return subscription.intakeMode === SUBSCRIPTION_INTAKE.ADMIN_ONLY;
}

function ensureActiveMessage(source, message) {
  if (!source.messages.some((candidate) => Number(candidate.sequence) === Number(message.sequence))) {
    source.messages.push(structuredClone(message));
  }
}

function rebuildMissingContexts(subscription, source) {
  for (const triggerSequence of subscription.state.pendingSequences) {
    const triggerMessage = [...source.messages, ...source.recentMessages]
      .find((message) => Number(message.sequence) === Number(triggerSequence));
    if (!isAdminMessage(triggerMessage)) continue;
    const key = String(triggerSequence);
    if (subscription.state.contextByTrigger[key]) continue;
    subscription.state.contextByTrigger[key] = source.recentMessages
      .filter((message) => Number(message.sequence) < Number(triggerSequence))
      .slice(-10)
      .map((message) => Number(message.sequence));
    for (const contextSequence of subscription.state.contextByTrigger[key]) {
      const message = source.recentMessages.find((candidate) => Number(candidate.sequence) === contextSequence);
      if (message) ensureActiveMessage(source, message);
    }
  }
  source.messages.sort((a, b) => Number(a.sequence) - Number(b.sequence));
}

function normalizeContextMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([sequence, context]) => [
    String(Number(sequence)),
    Array.isArray(context) ? [...new Set(context.map(Number).filter(Number.isFinite))].sort((a, b) => a - b) : []
  ]));
}

function maxSourceSequence(source) {
  return Math.max(0, ...source.messages.map((message) => Number(message.sequence || 0)), ...source.recentMessages.map((message) => Number(message.sequence || 0)));
}

function toRecentMessage(message) {
  const recent = structuredClone(message);
  recent.images = (recent.images || []).map((image) => ({ ...image, localPath: null }));
  recent.attachments = (recent.attachments || []).map((attachment) => ({ ...attachment, localPath: null }));
  return recent;
}
