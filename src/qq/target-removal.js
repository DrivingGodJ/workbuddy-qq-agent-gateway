import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function targetBusyForRemoval(worker, conversation, qzoneActivity = null) {
  const id = String(conversation?.groupId || "");
  return Boolean(conversation?.busy || conversation?.processing || qzoneActivity
    || worker?.running?.has(id) || worker?.waitingChat?.has(id) || worker?.qzoneReservations?.has(id)
    || worker?.stickerLabels?.recognitionQueues?.has(id) || worker?.stickerLabels?.hasCommitBarrier?.(id));
}

/** The durable allowlist tombstone is committed first. Interrupted cleanup is
 * replayed on startup, so OWNER defaults/subscriptions cannot resurrect a target.
 * No QQ leave/delete-friend API or persistent WorkBuddy deletion is used.
 */
export async function removeGatewayTarget({ type, id, targetStore, subscriptions, allowlist, archiveDir,
  onDisabled = () => {}, qzoneStore = null }) {
  if (!["group", "private"].includes(type) || !/^\d{5,14}$/u.test(String(id))) throw new Error("Invalid QQ target");
  id = String(id);
  const conversation = targetStore.listGroups().find((item) => item.groupId === id);
  if (conversation?.busy || conversation?.processing) throw new Error("会话仍有进行中的任务，请先终止或等待完成");
  if (!conversation && !allowlist.isRemoved(type, id)) throw new Error("Unknown Agent conversation");
  let archiveFile = null;
  if (conversation) {
    await mkdir(archiveDir, {recursive:true,mode:0o700});
    archiveFile = join(archiveDir, `${type}-${id}-${randomUUID()}.json`);
    const selectedSubscriptions = Object.values(subscriptions.snapshot().subscriptions || {})
      .filter((item) => item.targetType === type && item.targetId === id)
      .map((item) => metadataFields(item, ["id", "targetType", "targetId", "sourceGroupId", "mode", "intakeMode", "collectionDelayMinutes", "enabled", "createdAt", "updatedAt"]));
    const binding = qzoneStore?.snapshot();
    await writeFile(archiveFile, JSON.stringify({version:2,removedAt:new Date().toISOString(),type,id,
      conversation:metadataFields(conversation, ["groupId", "replyEnabled", "replyRevision", "codexConfig", "threadId", "threadCreatedAt", "lastActivityAt", "bootstrapComplete", "bootstrapRevision", "migratedFromLegacy"]),
      subscriptions:selectedSubscriptions,
      qzoneBinding:binding?.targetType === type && binding.targetId === id
        ? metadataFields(binding, ["targetType", "targetId", "autoPostEnabled", "autoEngageEnabled"]) : null},null,2), {mode:0o600,flag:"wx"});
  }
  await allowlist.remove(type, id);
  onDisabled(type, id);
  const removedSubscriptions = await subscriptions.removeTarget(type, id);
  await targetStore.removeConversation(id);
  const binding = qzoneStore?.snapshot();
  if (binding?.targetType === type && binding.targetId === id) await qzoneStore.configure({});
  return {removed:true,archiveFile,threadId:conversation?.threadId || null,
    subscriptionCount:removedSubscriptions.count,
    removedMessages:[...(conversation?.pendingMessages || []), ...(removedSubscriptions.removedMessages || [])]};
}

function metadataFields(value, fields) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}
