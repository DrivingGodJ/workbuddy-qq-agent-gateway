import { open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export class StorageHygieneManager {
  constructor({
    runtimeDir,
    dataDir,
    mediaRoot,
    stickerLibraryDir,
    logsDir,
    tempJobDirs = [],
    removedTargetsDir = null,
    mediaManager = null,
    sessionStores = [],
    subscriptionStore = null,
    qzoneStore = null,
    fileManager = null,
    maxLogBytes = 5 * 1024 * 1024,
    keepLogTailBytes = 1024 * 1024,
    tempJobTtlMs = 2 * 60 * 60 * 1000,
    removedTargetTtlMs = 7 * 24 * 60 * 60 * 1000,
    chatQueueMaxPerTarget = 120,
    chatQueueTtlHours = 72,
    referencedMedia = () => [],
    clock = () => Date.now()
  } = {}) {
    this.runtimeDir = runtimeDir ? resolve(runtimeDir) : null;
    this.dataDir = dataDir ? resolve(dataDir) : null;
    this.mediaRoot = mediaRoot ? resolve(mediaRoot) : null;
    this.stickerLibraryDir = stickerLibraryDir ? resolve(stickerLibraryDir) : null;
    this.logsDir = logsDir ? resolve(logsDir) : null;
    this.tempJobDirs = tempJobDirs.filter(Boolean).map((p) => resolve(p));
    this.removedTargetsDir = removedTargetsDir ? resolve(removedTargetsDir) : null;
    this.mediaManager = mediaManager;
    this.sessionStores = sessionStores.filter(Boolean);
    this.subscriptionStore = subscriptionStore;
    this.qzoneStore = qzoneStore;
    this.fileManager = fileManager;
    this.maxLogBytes = Math.max(256 * 1024, Number(maxLogBytes) || 5 * 1024 * 1024);
    this.keepLogTailBytes = Math.max(64 * 1024, Math.min(this.maxLogBytes, Number(keepLogTailBytes) || 1024 * 1024));
    this.tempJobTtlMs = Math.max(60_000, Number(tempJobTtlMs) || 2 * 60 * 60 * 1000);
    this.removedTargetTtlMs = Math.max(60_000, Number(removedTargetTtlMs) || 7 * 24 * 60 * 60 * 1000);
    this.chatQueueMaxPerTarget = Math.max(10, Math.floor(Number(chatQueueMaxPerTarget) || 120));
    this.chatQueueTtlHours = Math.max(1, Math.floor(Number(chatQueueTtlHours) || 72));
    this.referencedMedia = referencedMedia;
    this.clock = clock;
    this.lastCleanupAt = null;
  }

  async inspect() {
    const venvPath = this.runtimeDir ? join(this.runtimeDir, "venv") : null;
    const tempPaths = [...this.tempJobDirs, ...(this.removedTargetsDir ? [this.removedTargetsDir] : [])];

    const [mediaBytes, stickersBytes, dataBytes, logsBytes, venvBytes, ...tempSizes] = await Promise.all([
      measurePathBytes(this.mediaRoot),
      measurePathBytes(this.stickerLibraryDir),
      measurePathBytes(this.dataDir),
      measurePathBytes(this.logsDir),
      measurePathBytes(venvPath),
      ...tempPaths.map((dir) => measurePathBytes(dir))
    ]);

    const tempJobsBytes = tempSizes.reduce((sum, n) => sum + n, 0);
    const ephemeralBytes = mediaBytes + logsBytes + tempJobsBytes;
    const totalBytes = mediaBytes + stickersBytes + dataBytes + logsBytes + tempJobsBytes + venvBytes;

    return {
      updatedAt: new Date(this.clock()).toISOString(),
      lastCleanupAt: this.lastCleanupAt,
      totalBytes,
      ephemeralBytes,
      categories: {
        media: { label: "QQ 临时图片/文件", path: this.mediaRoot, bytes: mediaBytes },
        stickers: { label: "收藏表情库", path: this.stickerLibraryDir, bytes: stickersBytes },
        data: { label: "状态与今日空间数据", path: this.dataDir, bytes: dataBytes },
        logs: { label: "网关运行日志", path: this.logsDir, bytes: logsBytes },
        tempJobs: { label: "临时识图/归档缓存", path: this.tempJobDirs[0] || this.removedTargetsDir, bytes: tempJobsBytes },
        venv: { label: "Python SDK 环境", path: venvPath, bytes: venvBytes }
      },
      policy: {
        mediaTtlHours: Math.max(1, Math.round((this.mediaManager?.orphanTtlMs || 24 * 60 * 60 * 1000) / (60 * 60 * 1000))),
        mediaMaxMb: Math.max(1, Math.round((this.mediaManager?.maxTotalBytes || 200 * 1024 * 1024) / (1024 * 1024))),
        chatQueueTtlHours: this.chatQueueTtlHours,
        chatQueueMaxPerTarget: this.chatQueueMaxPerTarget,
        qzoneRetention: "today-only",
        logMaxMb: Math.max(1, Math.round(this.maxLogBytes / (1024 * 1024)))
      }
    };
  }

  async runCleanup({ aggressive = false } = {}) {
    const before = await this.inspect();
    let removedItems = 0;

    // 1. Prune expired idle queues in sessions and subscriptions, and drop their media
    for (const store of this.sessionStores) {
      if (typeof store.pruneExpiredMessages !== "function") continue;
      const res = await store.pruneExpiredMessages({
        maxPendingPerGroup: this.chatQueueMaxPerTarget,
        maxAgeMs: this.chatQueueTtlHours * 60 * 60 * 1000
      }).catch(() => ({ removedMessages: [] }));
      if (res?.removedMessages?.length) {
        removedItems += res.removedMessages.length;
        await this.mediaManager?.removeMessages?.(res.removedMessages).catch(() => {});
      }
    }

    if (this.subscriptionStore && typeof this.subscriptionStore.pruneExpiredSourceMessages === "function") {
      const subRes = await this.subscriptionStore.pruneExpiredSourceMessages({
        maxPerSource: this.chatQueueMaxPerTarget,
        maxAgeMs: this.chatQueueTtlHours * 60 * 60 * 1000
      }).catch(() => ({ removedMessages: [] }));
      if (subRes?.removedMessages?.length) {
        removedItems += subRes.removedMessages.length;
        await this.mediaManager?.removeMessages?.(subRes.removedMessages).catch(() => {});
      }
    }

    // 2. Clean orphan media and enforce size cap
    if (this.mediaManager && typeof this.mediaManager.cleanupOrphans === "function") {
      const mediaRes = await this.mediaManager.cleanupOrphans(this.referencedMedia(), { forceOrphans: aggressive }).catch(() => null);
      if (mediaRes?.removedDirs) removedItems += mediaRes.removedDirs;
    }

    // 3. Prune yesterday/old Qzone cache
    if (this.qzoneStore && typeof this.qzoneStore.pruneExpired === "function") {
      await this.qzoneStore.pruneExpired().catch(() => {});
    }

    // 4. Clean stale temporary job folders and archived removed targets
    const tempThreshold = aggressive ? 60_000 : this.tempJobTtlMs;
    for (const dir of this.tempJobDirs) {
      removedItems += await pruneChildEntries(dir, { maxAgeMs: tempThreshold, now: this.clock() });
    }
    if (this.removedTargetsDir) {
      const archiveThreshold = aggressive ? 24 * 60 * 60 * 1000 : this.removedTargetTtlMs;
      removedItems += await pruneChildEntries(this.removedTargetsDir, { maxAgeMs: archiveThreshold, now: this.clock() });
    }

    // 5. Truncate oversized logs
    if (this.logsDir) {
      const logCap = aggressive ? Math.min(this.maxLogBytes, 1024 * 1024) : this.maxLogBytes;
      const tailSize = aggressive ? Math.min(this.keepLogTailBytes, 256 * 1024) : this.keepLogTailBytes;
      removedItems += await truncateOversizedLogs(this.logsDir, { maxBytes: logCap, keepTailBytes: tailSize });
    }

    // 6. Best-effort SnowLuma container cleanup (/app/core, crash dumps, stale staging)
    let containerCleaned = false;
    if (this.fileManager && typeof this.fileManager.cleanupStaleStaging === "function") {
      const stageRes = await this.fileManager.cleanupStaleStaging({ aggressive }).catch(() => ({ ok: false }));
      containerCleaned = Boolean(stageRes?.ok);
    }

    this.lastCleanupAt = new Date(this.clock()).toISOString();
    const after = await this.inspect();
    const freedBytes = Math.max(0, before.totalBytes - after.totalBytes);

    return {
      ok: true,
      freedBytes,
      removedItems,
      containerCleaned,
      storage: after
    };
  }
}

async function measurePathBytes(target) {
  if (!target) return 0;
  const info = await stat(target).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;

  let total = 0;
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = join(target, entry.name);
    if (entry.isDirectory()) {
      total += await measurePathBytes(child);
    } else if (entry.isFile()) {
      const childInfo = await stat(child).catch(() => null);
      if (childInfo) total += childInfo.size;
    }
  }
  return total;
}

async function pruneChildEntries(rootDir, { maxAgeMs, now }) {
  const resolvedRoot = resolve(rootDir);
  const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const child = join(resolvedRoot, entry.name);
    const info = await stat(child).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs >= maxAgeMs) {
      await rm(child, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

async function truncateOversizedLogs(logsDir, { maxBytes, keepTailBytes }) {
  const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
  let truncatedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue;
    const filePath = join(logsDir, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size <= maxBytes) continue;
    let handle = null;
    try {
      handle = await open(filePath, "r");
      const length = Math.min(keepTailBytes, info.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      await handle.close();
      handle = null;
      await writeFile(filePath, buffer);
      truncatedCount += 1;
    } catch {
      await handle?.close().catch(() => {});
    }
  }
  return truncatedCount;
}
