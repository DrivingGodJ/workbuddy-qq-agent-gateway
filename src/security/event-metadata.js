/** Status events are not a second copy of messages, attachments or replies. */
export function eventMetadata(event = {}) {
  return Object.fromEntries([
    "type", "groupId", "userId", "targetType", "targetId", "threadId", "turnId",
    "at", "kind", "reason", "status", "count", "model"
  ].filter((key) => ["string", "number", "boolean"].includes(typeof event[key]))
    .map((key) => [key, event[key]]));
}
