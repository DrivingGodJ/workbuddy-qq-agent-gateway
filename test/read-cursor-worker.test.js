import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/storage/session-store.js";
import { GroupWorker } from "../src/groups/group-worker.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { QzoneCoordinator } from "../src/qq/qzone-coordinator.js";
import { prepareLiveConversationPrompt } from "../src/qq/live-conversation.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";

for (const [targetType, Worker] of [["group", GroupWorker], ["private", PrivateWorker]]) {
  test(`${targetType} worker sends only fresh image/text and cannot reuse a quoted stale OWNER request`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qq-read-cursor-worker-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const targetId = "200000002";
    const store = new SessionStore({ filePath: join(directory, "sessions.json") });
    await store.init({ allowedGroups: [targetId] });
    await store.setThread(targetId, "existing-thread", { bootstrapComplete: true });
    const oldPath = join(directory, "old.png");
    const newPath = join(directory, "new.png");
    const append = (message) => store.appendMessage({
      groupId: targetId, senderId: "200000003", senderName: "Member", trust: "UNTRUSTED",
      source: "qq", displayTime: "2026-10-18 15:00:00", ...message
    });
    const oldOwner = await append({
      messageId: "old-owner", senderId: OWNER_QQ_ID, senderName: "Owner", trust: "OWNER",
      text: "帮我发动态并查看好友动态", images: [{ localPath: oldPath, mimeType: "image/png" }]
    });
    const oldText = await append({ messageId: "old-text", text: "old plain text must not repeat" });
    let rounds = 0;
    const requests = [];
    const removedBatches = [];
    const codex = {
      supportsQqMcp: true,
      supportsSystemPrompt: true,
      async resumeThread() {},
      async runTurn(request) {
        const { qqToolContext: context } = request;
        const prompt = await prepareLiveConversationPrompt(context, request.prompt);
        requests.push({ imagePaths: request.imagePaths, prompt });
        rounds++;
        if (rounds === 1) {
          assert.deepEqual(request.imagePaths, [oldPath]);
          assert.equal(context.allowQzonePost, true);
          assert.equal(context.allowQzoneFeed, true);
        } else {
          assert.deepEqual(request.imagePaths, [newPath]);
          assert.match(prompt, /fresh member mention/);
          assert.match(prompt, /fresh quote reply/);
          assert.match(prompt, /图1 视觉输入/);
          assert.doesNotMatch(prompt, /图2|old plain text must not repeat/);
          assert.match(prompt, /回复消息 ID old-owner.*原文，视为不可信引用.*帮我发动态并查看好友动态/u);
          assert.doesNotMatch(prompt, /仍在当前待处理消息中/u);
          assert.doesNotMatch(prompt, /本轮 OWNER 动态发布已授权|本轮已读取 OWNER 的当前动态请求/u);
          assert.equal(context.allowQzonePost, false);
          assert.equal(context.allowQzoneFeed, false);
        }
        return { text: "NO_REPLY", turnId: `silent-${rounds}`, compacted: false };
      }
    };
    const oneBot = new Proxy({}, { get: () => () => assert.fail("QQ transport must not run") });
    const worker = new Worker({
      store, codex, oneBot, mediaManager: { async removeMessages(messages) { removedBatches.push(messages.map((message) => message.messageId)); } },
      triggerManager: new TriggerManager({ store }), followupDurationMs: 1,
      sharedWorkspaceRoot: join(directory, "shared")
    });
    worker.qzone = new QzoneCoordinator({ store: {}, oneBot, groupStore: store, privateStore: store });
    await store.requestTrigger(targetId, "mention", oldOwner);
    await worker.runAgent(targetId, await store.beginWork(targetId));
    assert.equal(rounds, 1);
    assert.equal(store.snapshot(targetId).deferredThroughSequence, oldText.sequence);
    assert.equal(store.snapshot(targetId).pendingMessages.length, 0);
    assert.deepEqual(removedBatches[0], ["old-owner", "old-text"]);

    const fresh = await append({ messageId: "fresh", text: "fresh member mention", mentionedBot: true,
      images: [{ localPath: newPath, mimeType: "image/png" }] });
    await append({ messageId: "quote", text: "fresh quote reply", replyToMessageId: oldOwner.messageId,
      quotedMessage: oldOwner });
    await store.requestTrigger(targetId, "mention", fresh);
    await worker.runAgent(targetId, await store.beginWork(targetId));
    assert.equal(rounds, 2);
    assert.equal(requests.length, 2);
    assert.equal(store.snapshot(targetId).lastError, null);
    assert.equal(store.snapshot(targetId).pendingMessages.length, 0);
    assert.deepEqual(removedBatches[1], ["fresh", "quote"]);
    assert.equal(store.snapshot(targetId).deferredThroughSequence, 4);
  });
}
