import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GroupWorker } from "../src/groups/group-worker.js";
import { GroupMemberDirectory } from "../src/qq/group-member-directory.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { SessionStore } from "../src/storage/session-store.js";

test("GroupWorker reset wipes workspace directory, member cache, old chat records, and deletes superseded thread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-group-reset-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new SessionStore({ filePath: join(root, "group-sessions.json") });
  await store.init({ allowedGroups: ["100001"] });
  await store.setThread("100001", "old-group-thread", { bootstrapComplete: true });
  await store.appendMessage({
    groupId: "100001",
    messageId: "m-old-1",
    senderId: "100000003",
    trust: "UNTRUSTED",
    text: "旧群消息",
    images: [{ localPath: "/tmp/old-img.png" }],
    timestamp: new Date().toISOString()
  });
  await store.appendMessage({
    groupId: "100001",
    messageId: "m-reset",
    senderId: "100000001",
    trust: "OWNER",
    text: "/新会话",
    timestamp: new Date().toISOString()
  });
  store.state.groups["100001"].lastReply = "旧回复";
  store.state.groups["100001"].lastCompletedReply = { text: "旧完成回复", completedAt: new Date().toISOString() };

  const groupWorkspaceRoot = join(root, "group-workspaces");
  const workspaceDir = join(groupWorkspaceRoot, "100001");
  await mkdir(join(workspaceDir, "nested"), { recursive: true });
  await writeFile(join(workspaceDir, "stale-note.txt"), "stale work", "utf8");
  await writeFile(join(workspaceDir, "nested", "artifact.md"), "old output", "utf8");

  const memberDir = new GroupMemberDirectory({ rootDir: groupWorkspaceRoot });
  await memberDir.initGroup("100001");
  await memberDir.record({ groupId: "100001", senderId: "100000003", senderName: "旧群友", source: "qq", timestamp: new Date().toISOString() });
  assert.deepEqual(memberDir.knownMemberIds("100001"), ["100000003"]);

  const events = [];
  const deletedThreads = [];
  const removedMediaMessages = [];
  const startedCwds = [];

  const agent = {
    async deleteThread(threadId, opts) {
      deletedThreads.push({ threadId, opts });
      assert.ok(existsSync(join(workspaceDir, "stale-note.txt")), "old thread should be deleted before workspace removal");
      return { deleted: true };
    },
    async startThread(opts) {
      startedCwds.push(opts.cwd);
      assert.equal(existsSync(join(workspaceDir, "stale-note.txt")), false, "workspace must be wiped before starting new thread");
      return "new-group-thread";
    },
    async runTurn() {
      return { turnId: "turn-init-1", text: "会话已初始化" };
    }
  };

  const sentMessages = [];
  const worker = new GroupWorker({
    store,
    agent,
    oneBot: {
      async sendGroupMessage(groupId, text) {
        sentMessages.push({ groupId, text });
        return { ok: true, messageId: "999" };
      }
    },
    mediaManager: {
      async removeMessages(msgs) {
        removedMediaMessages.push(...msgs.map((m) => m.messageId));
      }
    },
    fileManager: null,
    triggerManager: { async request() {} },
    groupMemberDirectory: memberDir,
    sharedWorkspaceRoot: groupWorkspaceRoot,
    onEvent: (ev) => events.push(ev)
  });

  const resetMsg = store.snapshot("100001").pendingMessages.find((m) => m.messageId === "m-reset");
  await worker.runControl("100001", { messages: [resetMsg] });

  assert.equal(deletedThreads.length, 1);
  assert.equal(deletedThreads[0].threadId, "old-group-thread");
  assert.equal(deletedThreads[0].opts.deletePersistent, true);
  assert.equal(startedCwds[0], workspaceDir);
  assert.equal(existsSync(join(workspaceDir, "stale-note.txt")), false);
  assert.equal(existsSync(join(workspaceDir, "nested")), false);
  assert.deepEqual(memberDir.knownMemberIds("100001"), []);
  const freshMembers = JSON.parse(await readFile(join(workspaceDir, "qq-members.json"), "utf8"));
  assert.deepEqual(freshMembers.members, {});

  const after = store.snapshot("100001");
  assert.equal(after.threadId, "new-group-thread");
  assert.equal(after.pendingMessages.length, 0);
  assert.equal(after.lastCompletedReply, null);
  assert.ok(removedMediaMessages.includes("m-old-1"));
  assert.ok(removedMediaMessages.includes("m-reset"));
  assert.match(sentMessages[0].text, /工作目录已重置/u);
});

test("PrivateWorker reset wipes private workspace directory, old chat records, and deletes superseded thread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-private-reset-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new SessionStore({ filePath: join(root, "private-sessions.json") });
  await store.init({ allowedGroups: ["200001"] });
  await store.setThread("200001", "old-private-thread", { bootstrapComplete: true });
  await store.appendMessage({
    groupId: "200001",
    messageId: "pm-old-1",
    senderId: "200001",
    trust: "OWNER",
    text: "旧私聊消息",
    timestamp: new Date().toISOString()
  });
  await store.appendMessage({
    groupId: "200001",
    messageId: "pm-reset",
    senderId: "200001",
    trust: "OWNER",
    text: "/新会话",
    timestamp: new Date().toISOString()
  });
  store.state.groups["200001"].lastCompletedReply = { text: "旧私聊回复", completedAt: new Date().toISOString() };

  const privateWorkspaceRoot = join(root, "private-workspaces");
  const workspaceDir = join(privateWorkspaceRoot, "200001");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "scratch.txt"), "private draft", "utf8");

  const deletedThreads = [];
  const removedMediaMessages = [];
  const startedCwds = [];

  const agent = {
    async deleteThread(threadId, opts) {
      deletedThreads.push({ threadId, opts });
      return { deleted: true };
    },
    async startThread(opts) {
      startedCwds.push(opts.cwd);
      assert.equal(existsSync(join(workspaceDir, "scratch.txt")), false, "private workspace must be cleaned before starting new thread");
      return "new-private-thread";
    },
    async runTurn() {
      return { turnId: "turn-priv-1", text: "会话已初始化" };
    }
  };

  const sentMessages = [];
  const worker = new PrivateWorker({
    store,
    agent,
    oneBot: {
      async sendPrivateMessage(userId, text) {
        sentMessages.push({ userId, text });
        return { ok: true, messageId: "888" };
      }
    },
    mediaManager: {
      async removeMessages(msgs) {
        removedMediaMessages.push(...msgs.map((m) => m.messageId));
      }
    },
    triggerManager: { async request() {} },
    workspaceRoot: privateWorkspaceRoot
  });

  const resetMsg = store.snapshot("200001").pendingMessages.find((m) => m.messageId === "pm-reset");
  await worker.runControl("200001", { messages: [resetMsg] });

  assert.equal(deletedThreads.length, 1);
  assert.equal(deletedThreads[0].threadId, "old-private-thread");
  assert.equal(deletedThreads[0].opts.deletePersistent, true);
  assert.equal(startedCwds[0], workspaceDir);
  assert.equal(existsSync(join(workspaceDir, "scratch.txt")), false);
  assert.equal(existsSync(workspaceDir), true);

  const after = store.snapshot("200001");
  assert.equal(after.threadId, "new-private-thread");
  assert.equal(after.pendingMessages.length, 0);
  assert.equal(after.lastCompletedReply, null);
  assert.ok(removedMediaMessages.includes("pm-old-1"));
  assert.ok(removedMediaMessages.includes("pm-reset"));
  assert.match(sentMessages[0].text, /私聊工作目录已重置/u);
});
