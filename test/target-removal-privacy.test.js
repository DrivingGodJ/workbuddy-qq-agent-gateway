import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeGatewayTarget } from "../src/qq/target-removal.js";

test("removing an idle target archives only metadata and returns its media for cleanup", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "qq-target-removal-"));
  try {
    const pending = { groupId: "100000001", messageId: "1", text: "SECRET_PENDING" };
    const source = { groupId: "100000003", messageId: "2", text: "SECRET_SOURCE" };
    const conversation = {
      groupId: "100000001", threadId: "persistent-thread", codexConfig: { model: "test" }, replyEnabled: true,
      pendingMessages: [pending], recentTurns: [{ text: "SECRET_HISTORY" }], sentMessages: [{ summary: "SECRET_SENT" }],
      liveSession: { lastReply: "SECRET_LIVE" }, lastReply: "SECRET_REPLY", lastCompletedReply: { text: "SECRET_COMPLETE" },
      failedDelivery: { text: "SECRET_DELIVERY" }, lastError: "SECRET_ERROR"
    };
    let removed = false;
    let unsubscribed = false;
    let unbound = false;
    const result = await removeGatewayTarget({
      type: "group", id: conversation.groupId, archiveDir,
      targetStore: { listGroups: () => [conversation], removeConversation: async () => { removed = true; } },
      subscriptions: {
        snapshot: () => ({ subscriptions: { one: {
          id: "one", targetType: "group", targetId: conversation.groupId, sourceGroupId: "100000003", enabled: true,
          state: { pendingMessages: [source], lastError: "SECRET_SUBSCRIPTION" }
        } } }),
        removeTarget: async () => { unsubscribed = true; return { count: 1, removedMessages: [source] }; }
      },
      allowlist: { remove: async () => {}, isRemoved: () => false },
      qzoneStore: {
        snapshot: () => ({ targetType: "group", targetId: conversation.groupId, autoPostEnabled: true,
          autoEngageEnabled: false, actions: { text: "SECRET_ACTION" }, events: [{ text: "SECRET_EVENT" }] }),
        configure: async () => { unbound = true; }
      }
    });
    const raw = await readFile(result.archiveFile, "utf8");
    const archive = JSON.parse(raw);
    assert.doesNotMatch(raw, /SECRET_/u);
    assert.equal(archive.version, 2);
    assert.deepEqual(archive.conversation, {
      groupId: conversation.groupId, replyEnabled: true, codexConfig: { model: "test" }, threadId: "persistent-thread"
    });
    assert.equal(archive.subscriptions[0].sourceGroupId, "100000003");
    assert.equal(archive.qzoneBinding.autoPostEnabled, true);
    assert.deepEqual(result.removedMessages, [pending, source]);
    assert.ok(removed && unsubscribed && unbound);
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
});
