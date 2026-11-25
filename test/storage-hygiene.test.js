import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QqMediaManager } from "../src/qq/media-manager.js";
import { SessionStore } from "../src/storage/session-store.js";
import { SubscriptionStore } from "../src/storage/subscription-store.js";
import { StorageHygieneManager } from "../src/storage/storage-hygiene.js";

test("QqMediaManager enforces 24h orphan TTL and maxTotalBytes disk cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "media-hygiene-"));
  let nowMs = 1_800_000_000_000;
  try {
    const mediaRoot = join(dir, "qq-media");
    const manager = new QqMediaManager({
      rootDir: mediaRoot,
      orphanTtlMs: 24 * 60 * 60 * 1000,
      maxTotalBytes: 2 * 1024 * 1024, // 2 MB cap
      clock: () => nowMs
    });
    await manager.init();

    const oldOrphanDir = manager.messageDir("10001", "msg-old");
    const keptSmallDir = manager.messageDir("10001", "msg-fresh-unreferenced");
    const oversizeRefDir = manager.messageDir("10001", "msg-ref-heavy");
    await mkdir(oldOrphanDir, { recursive: true });
    await mkdir(keptSmallDir, { recursive: true });
    await mkdir(oversizeRefDir, { recursive: true });

    await writeFile(join(oldOrphanDir, "image-1.jpg"), Buffer.alloc(1024, 1));
    await writeFile(join(keptSmallDir, "image-1.jpg"), Buffer.alloc(1200 * 1024, 2));
    await writeFile(join(oversizeRefDir, "image-1.jpg"), Buffer.alloc(1200 * 1024, 3));

    const past25h = new Date(nowMs - 25 * 60 * 60 * 1000);
    await utimes(oldOrphanDir, past25h, past25h);
    const past1h = new Date(nowMs - 60 * 60 * 1000);
    await utimes(keptSmallDir, past1h, past1h);

    const res = await manager.cleanupOrphans([{ localPath: join(oversizeRefDir, "image-1.jpg") }]);
    // oldOrphan removed for 24h TTL; keptSmallDir evicted to bring total under 2 MB cap; oversizeRefDir stays under cap.
    assert.equal(res.removedDirs, 2);
    assert.ok(res.remainingBytes <= 2 * 1024 * 1024);
    await assert.rejects(() => stat(oldOrphanDir));
    await assert.rejects(() => stat(keptSmallDir));
    assert.ok((await stat(join(oversizeRefDir, "image-1.jpg"))).isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageHygieneManager prunes expired idle queues, oversized logs, and temp job folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-hygiene-mgr-"));
  let now = new Date("2026-11-24T12:00:00+08:00");
  try {
    const runtimeDir = join(dir, "runtime");
    const dataDir = join(runtimeDir, "qq-only-data");
    const mediaRoot = join(runtimeDir, "qq-media");
    const stickerDir = join(runtimeDir, "qq-stickers");
    const logsDir = join(runtimeDir, "logs");
    const tempJobDir = join(runtimeDir, "sticker-label-jobs");
    const removedDir = join(dataDir, "removed-targets");
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(mediaRoot, { recursive: true }),
      mkdir(stickerDir, { recursive: true }),
      mkdir(logsDir, { recursive: true }),
      mkdir(join(tempJobDir, "stale-job"), { recursive: true }),
      mkdir(removedDir, { recursive: true })
    ]);

    let simulatedNow = new Date("2026-11-24T12:00:00+08:00");
    const mediaManager = new QqMediaManager({ rootDir: mediaRoot, clock: () => simulatedNow.getTime() });
    const sessionStore = new SessionStore({ filePath: join(dataDir, "group-sessions.json"), clock: () => simulatedNow });
    await sessionStore.init({ allowedGroups: ["10001", "10002"] });
    const subStore = new SubscriptionStore({ filePath: join(dataDir, "subscriptions.json"), clock: () => simulatedNow });
    await subStore.init();

    // Seed an old idle message in 10001 and a busy group 10002 80 hours earlier
    simulatedNow = new Date(now.getTime() - 80 * 60 * 60 * 1000);
    await sessionStore.appendMessage({
      groupId: "10001",
      messageId: "m-expired",
      senderId: "100000003",
      text: "旧未读消息",
      timestamp: simulatedNow.toISOString()
    });
    await sessionStore.appendMessage({
      groupId: "10002",
      messageId: "m-busy",
      senderId: "100000003",
      text: "处理中消息",
      timestamp: simulatedNow.toISOString()
    });
    sessionStore.state.groups["10002"].busy = true;
    simulatedNow = now;

    // Seed > 512KB oversized log + stale temp job dir
    const logFile = join(logsDir, "chat-hub.log");
    await writeFile(logFile, Buffer.alloc(600 * 1024, 65));
    await writeFile(join(tempJobDir, "stale-job", "tmp.txt"), "temp");
    const staleDate = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    await utimes(join(tempJobDir, "stale-job"), staleDate, staleDate);

    let containerCleanupCalled = false;
    const hygiene = new StorageHygieneManager({
      runtimeDir,
      dataDir,
      mediaRoot,
      stickerLibraryDir: stickerDir,
      logsDir,
      tempJobDirs: [tempJobDir],
      removedTargetsDir: removedDir,
      mediaManager,
      sessionStores: [sessionStore],
      subscriptionStore: subStore,
      fileManager: { async cleanupStaleStaging() { containerCleanupCalled = true; return { ok: true }; } },
      maxLogBytes: 300 * 1024,
      keepLogTailBytes: 100 * 1024,
      clock: () => now.getTime()
    });

    const result = await hygiene.runCleanup({ aggressive: true });
    assert.equal(result.ok, true);
    assert.equal(containerCleanupCalled, true);
    assert.equal(sessionStore.ensureGroup("10001").pendingMessages.length, 0);
    assert.equal(sessionStore.ensureGroup("10002").pendingMessages.length, 1);
    assert.ok((await stat(logFile)).size <= 256 * 1024);
    await assert.rejects(() => stat(join(tempJobDir, "stale-job")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
