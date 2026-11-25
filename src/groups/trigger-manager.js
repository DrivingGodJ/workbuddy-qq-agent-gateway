import { DEFAULT_HUMAN_PACING, computeBurstDebounceMs } from "../qq/human-pacing.js";

export class TriggerManager {
  constructor({
    store,
    allowedGroups = null,
    periodicMinutes = 10,
    clock = () => new Date(),
    intervalMs = 30_000,
    targetType = "group",
    humanPacing = false,
    pacingConfig = DEFAULT_HUMAN_PACING,
    botNameResolver = () => ""
  } = {}) {
    this.store = store;
    this.allowedGroups = allowedGroups == null ? null : new Set(allowedGroups.map(String));
    this.removedGroups = new Set();
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.targetType = targetType;
    this.humanPacing = Boolean(humanPacing);
    this.pacingConfig = pacingConfig;
    this.botNameResolver = typeof botNameResolver === "function" ? botNameResolver : () => "";
    this.periodicMs = Math.max(1, Number(periodicMinutes) || 10) * 60_000;
    this.nextCheckAt = this.clock().getTime() + this.periodicMs;
    // Pending messages already present at startup did not arrive in this window.
    this.startupPendingSequence = new Map(this.store.listGroups().map((group) => [
      String(group.groupId), Number(group.pendingMessages.at(-1)?.sequence || 0)
    ]));
    this.worker = null;
    this.timer = null;
    this.debounceTimers = new Map();
  }

  isAllowed(groupId) {
    return !this.removedGroups.has(String(groupId)) && (this.allowedGroups == null || this.allowedGroups.has(String(groupId)));
  }

  allowGroup(groupId) {
    const id = String(groupId);
    this.removedGroups.delete(id);
    this.allowedGroups?.add(id);
    this.startupPendingSequence.set(id, Number(this.store.snapshot(id).pendingMessages.at(-1)?.sequence || 0));
  }

  disallowGroup(groupId) {
    const id = String(groupId);
    this.clearDebounce(id);
    this.removedGroups.add(id);
    this.allowedGroups?.delete(id);
    this.startupPendingSequence.delete(id);
  }

  setWorker(worker) {
    this.worker = worker;
  }

  clearDebounce(groupId) {
    const id = String(groupId);
    const existing = this.debounceTimers.get(id);
    if (existing?.timer) clearTimeout(existing.timer);
    this.debounceTimers.delete(id);
  }

  scheduleKick(groupId, { reason = "mention", message = null } = {}) {
    const id = String(groupId);
    if (!this.humanPacing || !this.worker || this.worker.running?.has(id)) {
      this.clearDebounce(id);
      this.kick(id);
      return;
    }
    const { delayMs, maxWaitMs } = computeBurstDebounceMs(message, {
      targetType: this.targetType,
      reason,
      botName: this.botNameResolver(),
      config: this.pacingConfig
    });
    if (delayMs <= 0) {
      this.clearDebounce(id);
      this.kick(id);
      return;
    }
    const nowMs = this.clock().getTime();
    const existing = this.debounceTimers.get(id);
    const firstAt = existing?.firstAt ?? nowMs;
    if (existing?.timer) clearTimeout(existing.timer);
    const waitMs = Math.min(delayMs, Math.max(0, firstAt + maxWaitMs - nowMs));
    if (waitMs <= 0) {
      this.debounceTimers.delete(id);
      this.kick(id);
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(id);
      this.kick(id);
    }, waitMs);
    timer.unref?.();
    this.debounceTimers.set(id, { timer, firstAt });
  }

  async request(groupId, reason, meta = {}) {
    if (!this.isAllowed(groupId)) return null;
    const trigger = await this.store.requestTrigger(groupId, reason, meta);
    this.scheduleKick(groupId, { reason, message: meta });
    return trigger;
  }

  async considerMessage(message) {
    if (!this.isAllowed(message.groupId)) return null;
    if (message.eventType === "poke" && message.mentionedBot) {
      return this.request(message.groupId, "poke", message);
    }
    if (message.mentionedBot) {
      return this.request(message.groupId, "mention", message);
    }
    if (message.followupWake) {
      this.scheduleKick(message.groupId, { reason: "followup", message });
      return this.store.snapshot(message.groupId).pendingTrigger;
    }
    return null;
  }

  async reconsiderPending(groupId) {
    if (!this.isAllowed(groupId)) return null;
    const group = this.store.snapshot(groupId);
    if (group.pendingMessages.length === 0) return null;
    if (Number(group.pendingMessages.at(-1)?.sequence || 0) <= Number(group.deferredThroughSequence || 0)) return null;
    // A silent end keeps old messages for context, not as fresh authorization.
    // In particular, an old OWNER mention must not replace a new member followup.
    const latestWake = [...group.pendingMessages].reverse().find((message) =>
      !message.readAt && Number(message.sequence) > Number(group.deferredThroughSequence || 0)
      && message.mentionedBot);
    if (latestWake) return this.request(groupId, latestWake.eventType === "poke" ? "poke" : "mention", latestWake);
    return null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkPeriodic().catch((error) => {
      console.warn(`Periodic QQ trigger failed: ${error.message}`);
    }), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.debounceTimers.keys()]) this.clearDebounce(id);
  }

  async checkPeriodic() {
    await this.store.expireReplyFollowups?.();
    const now = this.clock().getTime();
    if (now < this.nextCheckAt) return;
    // Advance before awaiting disk I/O so overlapping timer calls cannot fire twice.
    this.nextCheckAt += (Math.floor((now - this.nextCheckAt) / this.periodicMs) + 1) * this.periodicMs;
    for (const group of this.store.listGroups()) {
      if (!this.isAllowed(group.groupId)) continue;
      const trigger = await this.store.requestPeriodicTrigger(group.groupId, this.startupPendingSequence.get(String(group.groupId)) || 0);
      if (trigger) this.kick(group.groupId);
    }
  }

  kick(groupId) {
    if (!this.worker) return;
    queueMicrotask(() => this.worker.kick(groupId).catch((error) => {
      console.warn(`QQ group worker ${groupId} failed: ${error.message}`);
    }));
  }
}
