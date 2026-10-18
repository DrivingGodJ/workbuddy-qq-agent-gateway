/** Shared message window for the panel and the scoped MCP reader; no hidden history. */
export function conversationReadSequence(group) {
  const sequence = Number(group.deferredThroughSequence || 0);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

export function conversationActivityWindow(group) {
  return {
    lastCompletedReply: group.lastCompletedReply || null,
    pendingMessages: group.pendingMessages || []
  };
}

export function toPublicGroupState(group, live = null, metadata = {}) {
  const liveState = live || { status: "idle", text: "", error: null };
  const waiting = liveState.status === "waiting";
  const running = liveState.status === "running" || waiting;
  const uploading = liveState.status === "uploading";
  const activity = conversationActivityWindow(group);
  return {
    groupId: group.groupId,
    replyEnabled: group.replyEnabled !== false,
    groupName: metadata.groupName || null,
    threadId: group.threadId,
    codexConfig: group.codexConfig || null,
    threadCreatedAt: group.threadCreatedAt,
    lastActivityAt: group.lastActivityAt,
    ...activity,
    pendingCount: activity.pendingMessages.length,
    busy: group.busy || waiting,
    pendingTrigger: group.pendingTrigger,
    processingUntilMessageId: group.processing?.processingUntilMessageId || null,
    processing: group.processing,
    failedDelivery: group.failedDelivery
      ? {
          failedAt: group.failedDelivery.failedAt,
          processingUntilMessageId: group.failedDelivery.processingUntilMessageId,
          trigger: group.failedDelivery.trigger,
          subscriptionIds: (group.failedDelivery.subscriptionConsumptions || []).map((item) => item.subscriptionId)
        }
      : null,
    lastError: group.lastError,
    resumeError: group.resumeError,
    activeReply: {
      running,
      waiting,
      waitUntil: waiting ? liveState.waitUntil || null : null,
      uploading,
      status: liveState.status || "idle",
      text: running || uploading ? String(liveState.text || "") : "",
      startedAt: running || uploading ? liveState.startedAt || null : null,
      updatedAt: running || uploading ? liveState.updatedAt || null : null,
      trigger: running || uploading ? liveState.trigger || null : null,
      turnId: running || uploading ? liveState.turnId || null : null,
      error: liveState.error || null
    }
  };
}
