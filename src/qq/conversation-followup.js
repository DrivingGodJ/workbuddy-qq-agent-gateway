import { REPLY_FOLLOWUP_MS } from "../storage/session-store.js";
import { DEFAULT_HUMAN_PACING, computeFollowupDurationMs, waitForBurstSettle } from "./human-pacing.js";

/** Keeps the gateway worker alive without keeping a model request alive. */
export class ConversationFollowup {
  constructor({
    store,
    canRun,
    blocked,
    shouldYield = () => false,
    setLive,
    onEvent,
    targetType,
    durationMs = REPLY_FOLLOWUP_MS,
    humanPacing = false,
    pacingConfig = DEFAULT_HUMAN_PACING,
    botNameResolver = () => ""
  }) {
    Object.assign(this, {
      store,
      canRun,
      blocked,
      shouldYield,
      setLive,
      onEvent,
      targetType,
      durationMs,
      humanPacing: Boolean(humanPacing),
      pacingConfig
    });
    this.botNameResolver = typeof botNameResolver === "function" ? botNameResolver : () => "";
    this.cancelled = new Set();
  }

  start(id) { this.cancelled.delete(String(id)); }

  async arm(id, context) {
    if (this.cancelled.has(String(id))) { await this.store.cancelReplyFollowup(id); return; }
    const effectiveDuration = this.humanPacing
      ? computeFollowupDurationMs({
          targetType: this.targetType,
          triggerReason: context?.triggerReason || "mention",
          chatSendCount: context?.chatSendCount || 0,
          totalActionCount: context?.actionCount || 0,
          lastSentText: context?.lastSentText || "",
          readMessages: context?.lastReadMessages || [],
          maxDurationMs: this.durationMs,
          config: this.pacingConfig
        })
      : this.durationMs;
    await this.store.armReplyFollowup(id, { afterSequence: context.lastReadSequence, durationMs: effectiveDuration });
  }

  publishWaiting(id, patch = {}) {
    const state = this.store.snapshot(id);
    const window = state.replyFollowup;
    const observing = window && Date.parse(window.expiresAt) > this.store.clock().getTime();
    const status = this.cancelled.has(String(id)) ? "cancelled" : !this.canRun(id) ? "paused"
      : state.pendingTrigger ? "queued" : observing ? "waiting" : "completed";
    this.setLive(id, { ...patch, status, text: "", error: null, waitUntil: status === "waiting" ? window?.expiresAt || null : null });
  }

  publishQueued(id) {
    this.setLive(id, { status: "queued", text: "", waitUntil: null });
    this.onEvent({ type: "conversation-queued", targetType: this.targetType, targetId: String(id) });
  }

  async wait(id) {
    const window = this.store.snapshot(id).replyFollowup;
    if (!window) return false;
    this.publishWaiting(id);
    this.onEvent({ type: "conversation-waiting", targetType: this.targetType, targetId: String(id), waitUntil: window.expiresAt });
    const shouldStop = () => this.cancelled.has(String(id)) || !this.canRun(id) || this.blocked() || this.shouldYield(id)
      || !this.store.snapshot(id).replyFollowup || Boolean(this.store.snapshot(id).pendingTrigger)
      || this.store.clock().getTime() >= Date.parse(window.expiresAt);
    await this.store.waitForNewMessages(id, {
      afterSequence: window.afterSequence,
      timeoutMs: Math.max(0, Date.parse(window.expiresAt) - this.store.clock().getTime()), shouldStop
    });
    if (this.cancelled.has(String(id)) || !this.canRun(id)) {
      await this.store.cancelReplyFollowup(id);
      this.setLive(id, { status: this.cancelled.has(String(id)) ? "cancelled" : "paused", text: "", waitUntil: null });
      this.onEvent({ type: "conversation-stopped", targetType: this.targetType, targetId: String(id) });
      return false;
    }
    if (this.blocked()) {
      this.publishQueued(id);
      return false;
    }
    if (this.shouldYield(id)) {
      this.publishQueued(id);
      return false;
    }
    if (this.store.snapshot(id).pendingTrigger) {
      if (this.humanPacing) {
        await waitForBurstSettle({
          store: this.store,
          targetId: id,
          targetType: this.targetType,
          reason: this.store.snapshot(id).pendingTrigger?.reason || "followup",
          botName: this.botNameResolver(),
          shouldStop: () => this.cancelled.has(String(id)) || !this.canRun(id) || this.blocked() || this.shouldYield(id),
          config: this.pacingConfig,
          clock: this.store.clock
        });
        if (this.cancelled.has(String(id)) || !this.canRun(id)) {
          await this.store.cancelReplyFollowup(id);
          this.setLive(id, { status: this.cancelled.has(String(id)) ? "cancelled" : "paused", text: "", waitUntil: null });
          this.onEvent({ type: "conversation-stopped", targetType: this.targetType, targetId: String(id) });
          return false;
        }
        if (this.blocked() || this.shouldYield(id)) {
          this.publishQueued(id);
          return false;
        }
      }
      return Boolean(this.store.snapshot(id).pendingTrigger);
    }
    await this.store.cancelReplyFollowup(id);
    this.setLive(id, { status: "completed", text: "", waitUntil: null });
    this.onEvent({ type: "conversation-completed", targetType: this.targetType, targetId: String(id) });
    return false;
  }

  async cancel(id) {
    this.cancelled.add(String(id));
    await this.store.cancelReplyFollowup(id);
  }
}
