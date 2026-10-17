import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { isUsableStickerDescription } from "./sticker-label.js";

export class QqStickerStore {
  constructor({ filePath, libraryDir, oneBot, fileManager, maxPromptItems = 24, clock = () => new Date() } = {}) {
    this.filePath = resolve(filePath);
    this.libraryDir = resolve(libraryDir);
    this.oneBot = oneBot;
    this.fileManager = fileManager;
    this.maxPromptItems = Math.max(1, Number(maxPromptItems) || 24);
    this.clock = clock;
    this.state = { version: 4, updatedAt: null, candidates: {}, stickers: {}, excluded: {}, garbagePaths: [] };
    this.operationChain = Promise.resolve();
    this.favoriteDetails = [];
    this.favoriteDetailsFetchedAt = 0;
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await mkdir(this.libraryDir, { recursive: true });
    await mkdir(join(this.libraryDir, "pending"), { recursive: true });
    await mkdir(join(this.libraryDir, "blacklist"), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filePath, "utf8"));
      if (loaded?.stickers && typeof loaded.stickers === "object") {
        this.state = normalizeState(loaded);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.save();
    await this.cleanupPrunedFiles();
  }

  collectFromMessage(message, { contextMessages = [] } = {}) {
    return this.enqueue(async () => {
      const collected = [];
      let changed = false;
      for (const image of message?.images || []) {
        if (!image?.isSticker || !image.localPath || image.context === "quoted") continue;
        const entry = await this.collectOne(image, message, contextMessages);
        image.stickerId = entry.id;
        image.stickerExcluded = entry.labelStatus === "excluded";
        image.stickerLabel = image.stickerExcluded ? "已排除，不再收录" : entry.usage || "待 AI 看图标注";
        image.stickerNeedsReview = !image.stickerExcluded && entry.labelStatus !== "ready";
        image.stickerCandidate = image.stickerNeedsReview;
        // An excluded repeat is already handled, not a new collection event or
        // an AI labeling request. Keep its incoming image for the main chat.
        if (!image.stickerExcluded) collected.push(structuredClone(entry));
        changed = true;
      }
      if (changed) await this.save();
      return collected;
    });
  }

  async collectOne(image, message, contextMessages) {
    const bytes = await readFile(image.localPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const md5 = createHash("md5").update(bytes).digest("hex");
    const marketEmojiId = normalizeMarketEmojiId(image.emojiId);
    const excluded = Object.values(this.state.excluded).find((item) => (
      item.sha256s.includes(sha256) || item.md5s.includes(md5)
      || (marketEmojiId && item.marketEmojiIds.includes(marketEmojiId))
    ));
    if (excluded) {
      excluded.receiveCount += 1;
      excluded.lastSeenAt = this.nowIso();
      // Preserve byte aliases encountered under the same native QQ emoji ID,
      // so a subsequent image-only resend also bypasses admission.
      excluded.sha256s = [...new Set([...excluded.sha256s, sha256])];
      excluded.md5s = [...new Set([...excluded.md5s, md5])];
      if (marketEmojiId) excluded.marketEmojiIds = [...new Set([...excluded.marketEmojiIds, marketEmojiId])];
      // Older fingerprint-only records had no preview. Keep a library copy on
      // the next arrival without labeling it or touching the message original.
      if (!excluded.filesCleanedAt && !excluded.archivedSticker?.localPath) {
        const localPath = join(this.libraryDir, "blacklist", `${excluded.id}${safeExtension(image.localPath, image.mimeType)}`);
        await writeFile(localPath, bytes, { mode: 0o600 });
        excluded.archivedSticker = normalizeEntry(excluded.id, {
          sha256, md5, localPath, mimeType: image.mimeType, size: bytes.length,
          marketEmojiId, qqSummary: image.summary, createdAt: excluded.excludedAt,
          lastSeenAt: excluded.lastSeenAt, usage: "", labelStatus: "needs_review"
        });
      }
      return { ...excluded, labelStatus: "excluded" };
    }
    const duplicate = [...Object.values(this.state.stickers), ...Object.values(this.state.candidates)].find((item) => (
      item.sha256 === sha256
      || (item.sha256s || []).includes(sha256)
      || normalizeMd5(item.md5) === md5
      || (item.md5s || []).includes(md5)
      || (marketEmojiId && item.marketEmojiId === marketEmojiId)
      || (marketEmojiId && (item.marketEmojiIds || []).includes(marketEmojiId))
    ));
    if (duplicate) {
      duplicate.receiveCount += 1;
      duplicate.lastSeenAt = this.nowIso();
      duplicate.lastSource = sourceInfo(message);
      return duplicate;
    }

    const id = uniqueStickerId({ ...this.state.stickers, ...this.state.candidates, ...this.state.excluded }, sha256);
    const extension = safeExtension(image.localPath, image.mimeType);
    const localPath = join(this.libraryDir, "pending", `${id}${extension}`);
    // Keep the message cache and sticker library on separate lifecycles.  The
    // bytes already read above are snapshotted into the managed candidate;
    // labeling/admission may only move or delete this copy.  The incoming
    // image remains owned by QqMediaManager and is removed with its message.
    await writeFile(localPath, bytes, { mode: 0o600 });
    const entry = {
      id,
      sha256,
      md5,
      localPath,
      mimeType: String(image.mimeType || "application/octet-stream"),
      size: Number(image.size || bytes.length),
      marketEmojiId,
      marketPackageId: Number(image.emojiPackageId || 0),
      marketKey: String(image.emojiKey || ""),
      qqSummary: cleanLabel(image.summary),
      usage: "",
      labelStatus: "awaiting_ai",
      labelSource: null,
      labelError: null,
      favoriteEmojiId: null,
      favoriteStatus: "not_added",
      favoriteError: null,
      receiveCount: 1,
      sendCount: 0,
      createdAt: this.nowIso(),
      lastSeenAt: this.nowIso(),
      lastUsedAt: null,
      lastSource: sourceInfo(message)
    };
    this.state.candidates[id] = entry;
    return entry;
  }

  async ensureFavorite(entry, { forceRefresh = false } = {}) {
    if (!entry || entry.favoriteStatus === "added") return entry;
    await this.refreshFavoriteDetails(forceRefresh);
    const existing = this.favoriteDetails.find((item) => normalizeMd5(item.md5) === normalizeMd5(entry.md5));
    if (existing?.emoji_id) {
      entry.favoriteEmojiId = String(existing.emoji_id);
      entry.favoriteStatus = "added";
      entry.favoriteError = null;
      await this.syncFavoriteDescription(entry).catch(() => {});
      return entry;
    }
    if (!this.fileManager?.addCustomFace) throw new Error("QQ native favorite staging is unavailable");
    const result = await this.fileManager.addCustomFace(entry);
    const emojiId = String(result?.emojiId || result?.emoji_id || "").trim();
    entry.favoriteEmojiId = emojiId || null;
    entry.favoriteStatus = "added";
    entry.favoriteError = null;
    this.favoriteDetailsFetchedAt = 0;
    await this.syncFavoriteDescription(entry).catch(() => {});
    return entry;
  }

  async refreshFavoriteDetails(force = false) {
    if (!this.oneBot?.fetchCustomFaceDetails) return [];
    if (!force && Date.now() - this.favoriteDetailsFetchedAt < 5 * 60 * 1000) return this.favoriteDetails;
    this.favoriteDetails = await this.oneBot.fetchCustomFaceDetails(1000);
    this.favoriteDetailsFetchedAt = Date.now();
    return this.favoriteDetails;
  }

  resolveRequests(requests = []) {
    const resolved = [];
    const seen = new Set();
    for (const request of requests) {
      const id = String(request?.id || "").trim();
      if (!id || seen.has(id)) continue;
      const entry = this.state.stickers[id];
      if (!entry || entry.labelStatus !== "ready") continue;
      seen.add(id);
      resolved.push({
        id: entry.id,
        sourcePath: entry.localPath,
        name: basename(entry.localPath),
        size: entry.size,
        mimeType: entry.mimeType,
        usage: entry.usage,
        marketEmojiId: entry.marketEmojiId,
        marketPackageId: entry.marketPackageId,
        marketKey: entry.marketKey,
        qqSummary: entry.qqSummary,
        delivered: false
      });
    }
    return resolved;
  }

  async sendSticker(targetType, targetId, sticker) {
    let result;
    if (sticker.marketEmojiId) {
      const marketFace = {
        emojiId: sticker.marketEmojiId,
        emojiPackageId: sticker.marketPackageId,
        key: sticker.marketKey,
        summary: sticker.qqSummary || sticker.usage || "表情"
      };
      result = targetType === "private"
        ? await this.oneBot.sendPrivateMarketFace(targetId, marketFace)
        : await this.oneBot.sendGroupMarketFace(targetId, marketFace);
    } else {
      result = await this.fileManager.sendSticker(targetType, targetId, sticker);
    }
    if (result?.ok) {
      await this.enqueue(async () => {
        const entry = this.state.stickers[sticker.id];
        if (!entry) return;
        entry.sendCount += 1;
        entry.lastUsedAt = this.nowIso();
        await this.save();
      });
    }
    return result;
  }

  applyLabels(labels = []) {
    return this.enqueue(async () => {
      const updated = [];
      let changed = false;
      for (const candidate of labels) {
        const id = String(candidate?.id || "");
        const usage = normalizeUsage(candidate?.usage);
        if (!isUsableStickerDescription(usage)) {
          const pending = this.state.candidates[id];
          if (pending) {
            await this.removeManagedFile(pending.localPath, { pendingOnly: true });
            delete this.state.candidates[id];
            changed = true;
          }
          continue;
        }
        let entry = this.state.stickers[id];
        if (!entry) {
          const pending = this.state.candidates[id];
          if (!pending) continue;
          const extension = safeExtension(pending.localPath, pending.mimeType);
          const admittedPath = join(this.libraryDir, `${id}${extension}`);
          if (resolve(pending.localPath) !== resolve(admittedPath)) {
            await rename(pending.localPath, admittedPath);
          }
          entry = {
            ...pending,
            localPath: admittedPath,
            usage,
            labelStatus: "ready",
            labelSource: "agent-vision",
            labelError: null,
            favoriteStatus: "pending"
          };
          delete this.state.candidates[id];
          this.state.stickers[id] = entry;
          changed = true;
        }
        entry.usage = usage;
        entry.labelStatus = "ready";
        entry.labelSource = "agent-vision";
        entry.labelError = null;
        entry.favoriteError = null;
        try {
          await this.ensureFavorite(entry);
        } catch (error) {
          entry.favoriteStatus = "failed";
          entry.favoriteError = String(error?.message || error).slice(0, 500);
        }
        await this.syncFavoriteDescription(entry).catch((error) => {
          entry.favoriteError = String(error?.message || error).slice(0, 500);
        });
        updated.push(structuredClone(entry));
        changed = true;
      }
      if (changed) await this.save();
      return updated;
    });
  }

  claimLabelRequests(messages = []) {
    return this.enqueue(async () => {
      const requests = this.labelRequests(messages);
      for (const request of requests) {
        const candidate = this.state.candidates[request.id];
        if (candidate) candidate.labelStatus = "labeling";
      }
      if (requests.length) await this.save();
      return requests;
    });
  }

  stageLabels(labels = []) {
    return this.enqueue(async () => {
      const staged = [];
      let changed = false;
      for (const label of labels) {
        const id = String(label?.id || "");
        const usage = normalizeUsage(label?.usage);
        const candidate = this.state.candidates[id];
        if (!candidate) continue;
        if (!isUsableStickerDescription(usage)) {
          await this.removeManagedFile(candidate.localPath, { pendingOnly: true });
          delete this.state.candidates[id];
          changed = true;
          continue;
        }
        candidate.usage = usage;
        candidate.labelStatus = "ready_to_commit";
        candidate.labelSource = "agent-vision";
        candidate.labelError = null;
        staged.push(structuredClone(candidate));
        changed = true;
      }
      if (changed) await this.save();
      return staged;
    });
  }

  commitStagedLabels(ids = []) {
    const wanted = new Set((ids || []).map(String));
    const labels = Object.values(this.state.candidates)
      .filter((candidate) => wanted.has(candidate.id) && candidate.labelStatus === "ready_to_commit" && normalizeUsage(candidate.usage))
      .map((candidate) => ({ id: candidate.id, usage: candidate.usage }));
    return this.applyLabels(labels);
  }

  stagedLabels(messages = []) {
    const ids = new Set((messages || []).flatMap((message) => (
      (message?.images || []).map((image) => String(image?.stickerId || "")).filter(Boolean)
    )));
    return Object.values(this.state.candidates)
      .filter((candidate) => ids.has(candidate.id) && candidate.labelStatus === "ready_to_commit" && normalizeUsage(candidate.usage))
      .map((candidate) => ({ id: candidate.id, usage: candidate.usage }));
  }

  async syncFavoriteDescription(entry) {
    if (!entry.favoriteEmojiId || !this.oneBot?.modifyCustomFace) return;
    await this.oneBot.modifyCustomFace(entry.favoriteEmojiId, `场景：${entry.usage}`.slice(0, 80));
  }

  retryPendingFavorites() {
    return this.enqueue(async () => {
      const updated = [];
      for (const entry of Object.values(this.state.stickers)) {
        if (entry.labelStatus !== "ready" || entry.favoriteStatus === "added") continue;
        try {
          await this.ensureFavorite(entry);
        } catch (error) {
          entry.favoriteStatus = "failed";
          entry.favoriteError = String(error?.message || error).slice(0, 500);
        }
        updated.push(structuredClone(entry));
      }
      if (updated.length) await this.save();
      return updated;
    });
  }

  promptCatalog() {
    return Object.values(this.state.stickers)
      .filter((entry) => entry.localPath && entry.usage && entry.labelStatus === "ready")
      .sort((a, b) => {
        const aTime = Date.parse(a.lastUsedAt || a.lastSeenAt || a.createdAt || 0) || 0;
        const bTime = Date.parse(b.lastUsedAt || b.lastSeenAt || b.createdAt || 0) || 0;
        return bTime - aTime;
      })
      .slice(0, this.maxPromptItems)
      .map((entry) => ({
        id: entry.id,
        usage: entry.usage,
        labelStatus: entry.labelStatus,
        qqSummary: entry.qqSummary || null
      }));
  }

  curationCatalog() {
    return Object.values(this.state.stickers)
      .filter((entry) => entry.localPath && entry.labelStatus === "ready" && isUsableStickerDescription(entry.usage))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({ id: entry.id, localPath: entry.localPath, usage: entry.usage, receiveCount: entry.receiveCount, sendCount: entry.sendCount }));
  }

  retainSelection(snapshot, keepIds) {
    return this.enqueue(async () => {
      const selected = new Set(keepIds);
      const current = this.curationCatalog();
      if (selected.size !== 80 || keepIds.length !== 80 || selected.size > snapshot.length
        || keepIds.some((id) => !snapshot.some((entry) => entry.id === id))) throw new Error("拒绝无效表情筛选结果");
      // A manual edit/delete while the model was working must abort, never cause
      // a stale AI decision to erase a user's newer library changes.
      if (JSON.stringify(current.map(({ id, usage, localPath }) => ({ id, usage, localPath })))
        !== JSON.stringify(snapshot.map(({ id, usage, localPath }) => ({ id, usage, localPath })))) {
        throw new Error("筛选期间表情库已被编辑；本次未删除任何表情");
      }
      const removed = current.filter((entry) => !selected.has(entry.id));
      for (const entry of removed) {
        const managedPath = resolve(entry.localPath);
        if (!managedPath.startsWith(`${this.libraryDir}${sep}`) || managedPath.startsWith(`${this.libraryDir}${sep}pending${sep}`)) {
          throw new Error("筛选删除目标不属于已入库表情目录");
        }
      }
      await this.excludeEntries(removed.map((entry) => this.state.stickers[entry.id]), "curation");
      return removed.map((entry) => entry.id);
    });
  }

  // Called inside the store's operation queue. Persist catalog removal,
  // fingerprints and a restorable preview together. Blacklisted copies are
  // retained until the user explicitly chooses to forget them.
  async excludeEntries(entries, reason) {
    for (const entry of entries) {
      const path = resolve(entry.localPath);
      if (path === this.libraryDir || !path.startsWith(`${this.libraryDir}${sep}`)) {
        throw new Error("排除目标不属于表情库目录");
      }
    }
    const previous = this.state;
    const removedIds = new Set(entries.map((entry) => entry.id));
    const excluded = { ...previous.excluded };
    for (const entry of entries) excluded[entry.id] = exclusionRecord(entry, reason, this.nowIso());
    this.state = { ...previous,
      stickers: Object.fromEntries(Object.entries(previous.stickers).filter(([id]) => !removedIds.has(id))),
      excluded
    };
    try { await this.save(); }
    catch (error) { this.state = previous; throw error; }
    await this.flushPrunedFiles().catch((error) => console.warn(`Excluded file cleanup will resume on recovery: ${error.message}`));
  }

  cleanupPrunedFiles() { return this.enqueue(() => this.flushPrunedFiles()); }

  cleanExcludedFiles() {
    return this.enqueue(async () => {
      const entries = Object.values(this.state.excluded);
      const paths = [...new Set(entries.map((entry) => entry.archivedSticker?.localPath).filter(Boolean).map((path) => resolve(path)))];
      const protectedPaths = new Set();
      for (const entry of [...Object.values(this.state.stickers), ...Object.values(this.state.candidates)]) {
        protectedPaths.add(resolve(entry.localPath));
        try { protectedPaths.add(await realpath(entry.localPath)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const sizes = new Map();
      // Preflight the whole batch before changing records or removing any file.
      for (const path of paths) {
        const info = await this.inspectManagedFile(path);
        if (protectedPaths.has(path) || (info && protectedPaths.has(await realpath(path)))) {
          throw new Error("黑名单文件仍被可用表情或识别任务引用，未清理");
        }
        if (info) sizes.set(path, info.size);
      }
      const previous = this.state;
      const excluded = Object.fromEntries(entries.map((entry) => {
        const { archivedSticker, ...record } = entry;
        return [entry.id, { ...record, usage: entry.usage || archivedSticker?.usage || "",
          filesCleanedAt: entry.filesCleanedAt || this.nowIso() }];
      }));
      this.state = { ...previous, excluded,
        garbagePaths: [...new Set([...(previous.garbagePaths || []), ...paths])] };
      try { await this.save(); } catch (error) { this.state = previous; throw error; }
      // Persist the no-recapture marker and retry paths before physical removal.
      await this.flushPrunedFiles();
      let cleanedCount = 0, freedBytes = 0;
      for (const [path, size] of sizes) {
        try { await lstat(path); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          cleanedCount++; freedBytes += size;
        }
      }
      return { cleanedCount, freedBytes, pendingFiles: this.state.garbagePaths.length };
    });
  }

  async flushPrunedFiles() {
    const livePaths = new Set([...Object.values(this.state.stickers), ...Object.values(this.state.candidates),
      ...Object.values(this.state.excluded).map((entry) => entry.archivedSticker).filter(Boolean)]
      .filter((entry) => entry.localPath).map((entry) => resolve(entry.localPath)));
    const remaining = [];
    for (const path of this.state.garbagePaths || []) {
      if (livePaths.has(resolve(path))) continue;
      try { await this.removeManagedFile(path); }
      catch (error) { remaining.push(path); console.warn(`Pruned sticker cleanup deferred: ${error.message}`); }
    }
    this.state.garbagePaths = remaining;
    if (remaining.length) console.warn(`${remaining.length} pruned sticker files will be cleaned on recovery`);
    await this.save();
  }

  updateUsage(id, value) {
    return this.enqueue(async () => {
      const normalizedId = String(id || "").trim();
      const entry = this.state.stickers[normalizedId];
      if (!entry) return null;
      const usage = normalizeUsage(value);
      if (usage.length < 2 || !isUsableStickerDescription(usage)) {
        throw new Error("表情备注需要是有效的中文使用场景，长度为 2–80 个字符");
      }
      entry.usage = usage;
      entry.labelStatus = "ready";
      entry.labelSource = "owner-edit";
      entry.labelError = null;
      entry.favoriteError = null;
      try {
        await this.syncFavoriteDescription(entry);
      } catch (error) {
        entry.favoriteError = String(error?.message || error).slice(0, 500);
      }
      await this.save();
      return publicStickerEntry(entry);
    });
  }

  deleteSticker(id) {
    return this.enqueue(async () => {
      const normalizedId = String(id || "").trim();
      const entry = this.state.stickers[normalizedId];
      if (!entry) return null;
      await this.excludeEntries([entry], "manual");
      return publicStickerEntry(entry);
    });
  }

  restoreExcluded(id) {
    return this.enqueue(async () => {
      const entry = this.state.excluded[String(id || "").trim()];
      if (!entry) return null;
      if (this.state.stickers[entry.id] || this.state.candidates[entry.id]) throw new Error("表情记录发生冲突，未覆盖现有表情");
      const archive = entry.archivedSticker;
      let canRestore = archive?.labelStatus === "ready" && isUsableStickerDescription(archive.usage);
      if (canRestore) {
        this.assertManagedPath(archive.localPath);
        try {
          const bytes = await readFile(archive.localPath);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const md5 = createHash("md5").update(bytes).digest("hex");
          if (!entry.sha256s.includes(sha256) && !entry.md5s.includes(md5)) throw new Error("黑名单预览指纹不匹配，未恢复表情");
        } catch (error) { if (error.code === "ENOENT") canRestore = false; else throw error; }
      }
      if (!canRestore) {
        await this.forgetEntry(entry.id);
        return { id: entry.id, restored: false, awaitingNewArrival: true };
      }
      const previous = this.state;
      const restored = { ...normalizeEntry(entry.id, archive), labelStatus: "ready",
        sha256s: entry.sha256s, md5s: entry.md5s, marketEmojiIds: entry.marketEmojiIds,
        receiveCount: (archive.receiveCount || 1) + entry.receiveCount,
        lastSeenAt: entry.lastSeenAt || archive.lastSeenAt,
        favoriteStatus: "pending", favoriteEmojiId: null, favoriteError: null };
      // QQ favorites may have been deleted independently of this local archive.
      // Re-read by digest or upload the intact local file; never reuse a stale ID.
      try { await this.ensureFavorite(restored, { forceRefresh: true }); }
      catch (error) {
        restored.favoriteStatus = "failed";
        restored.favoriteError = String(error?.message || error).slice(0, 500);
      }
      this.state = { ...previous,
        excluded: Object.fromEntries(Object.entries(previous.excluded).filter(([key]) => key !== entry.id)),
        stickers: { ...previous.stickers, [entry.id]: restored }
      };
      try { await this.save(); } catch (error) { this.state = previous; throw error; }
      return { id: entry.id, restored: true, awaitingNewArrival: false };
    });
  }

  forgetSticker(id) { return this.enqueue(() => this.forgetEntry(String(id || "").trim())); }

  // Called only within the operation queue. Forget all byte/native aliases,
  // persist first, then clean library copies; never touch QQ message originals.
  async forgetEntry(id) {
    const entry = this.state.stickers[id] || this.state.excluded[id];
    if (!entry) return null;
    const localPaths = [this.state.stickers[id]?.localPath, this.state.excluded[id]?.archivedSticker?.localPath].filter(Boolean);
    for (const localPath of localPaths) this.assertManagedPath(localPath);
    const previous = this.state;
    this.state = { ...previous,
      stickers: Object.fromEntries(Object.entries(previous.stickers).filter(([key]) => key !== id)),
      excluded: Object.fromEntries(Object.entries(previous.excluded).filter(([key]) => key !== id)),
      garbagePaths: [...new Set([...(previous.garbagePaths || []), ...localPaths])]
    };
    try { await this.save(); } catch (error) { this.state = previous; throw error; }
    await this.flushPrunedFiles().catch((error) => console.warn(`Forgotten sticker cleanup deferred: ${error.message}`));
    return { id, forgotten: true };
  }

  assertManagedPath(path) {
    const managedPath = resolve(String(path || ""));
    if (managedPath === this.libraryDir || !managedPath.startsWith(`${this.libraryDir}${sep}`)) throw new Error("表情副本不属于网关表情库，未进行操作");
  }

  publicState() {
    const entries = Object.values(this.state.stickers);
    const candidates = Object.values(this.state.candidates);
    return {
      total: entries.length,
      ready: entries.filter((entry) => entry.labelStatus === "ready").length,
      awaitingAi: candidates.filter((entry) => entry.labelStatus !== "ready_to_commit").length,
      awaitingCommit: candidates.filter((entry) => entry.labelStatus === "ready_to_commit").length,
      needsReview: candidates.length,
      favoritePending: entries.filter((entry) => entry.favoriteStatus !== "added").length,
      cleanupPending: (this.state.garbagePaths || []).length,
      excludedCount: Object.keys(this.state.excluded).length,
      excludedItems: Object.values(this.state.excluded).map((entry) => ({
        id: entry.id, reason: entry.reason, excludedAt: entry.excludedAt,
        lastSeenAt: entry.lastSeenAt, receiveCount: entry.receiveCount,
        usage: entry.usage || entry.archivedSticker?.usage || "",
        filesCleanedAt: entry.filesCleanedAt || null,
        hasPreview: Boolean(entry.archivedSticker?.localPath),
        canRestore: Boolean(entry.archivedSticker?.localPath && entry.archivedSticker.labelStatus === "ready"
          && isUsableStickerDescription(entry.archivedSticker.usage))
      })),
      items: entries.map(publicStickerEntry),
      candidates: candidates.map((entry) => ({
        id: entry.id,
        status: entry.labelStatus,
        usage: entry.labelStatus === "ready_to_commit" ? entry.usage : "",
        receiveCount: entry.receiveCount,
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
        labelError: entry.labelError || null
      }))
    };
  }

  imageAsset(id) {
    const normalizedId = String(id || "").trim();
    if (!/^st_[a-f0-9]{12,64}$/i.test(normalizedId)) return null;
    const entry = this.state.stickers[normalizedId] || this.state.candidates[normalizedId] || this.state.excluded[normalizedId]?.archivedSticker;
    if (!entry?.localPath) return null;
    const localPath = resolve(entry.localPath);
    if (localPath === this.libraryDir || !localPath.startsWith(`${this.libraryDir}${sep}`)) return null;
    return {
      id: normalizedId,
      localPath,
      mimeType: /^image\/(?:jpeg|png|gif|webp|bmp)$/i.test(entry.mimeType) ? entry.mimeType : mimeTypeForPath(localPath),
      ready: Boolean(this.state.stickers[normalizedId]),
      updatedAt: entry.lastSeenAt || entry.createdAt || this.state.updatedAt
    };
  }

  removeInvalidEntries() {
    return this.enqueue(async () => {
      const removed = [];
      for (const [id, entry] of Object.entries(this.state.stickers)) {
        if (entry.labelStatus === "ready" && isUsableStickerDescription(entry.usage)) continue;
        await this.removeManagedFile(entry.localPath);
        delete this.state.stickers[id];
        removed.push({ id, reason: "invalid-or-empty-label" });
      }
      for (const [id, entry] of Object.entries(this.state.candidates)) {
        if (entry.labelStatus !== "ready_to_commit" || isUsableStickerDescription(entry.usage)) continue;
        await this.removeManagedFile(entry.localPath, { pendingOnly: true });
        delete this.state.candidates[id];
        removed.push({ id, reason: "invalid-staged-label" });
      }
      if (removed.length) await this.save();
      return removed;
    });
  }

  labelRequests(messages = [], { includeInProgress = false } = {}) {
    const requests = [];
    const seen = new Set();
    for (const message of messages || []) {
      for (const image of message?.images || []) {
        const id = String(image?.stickerId || "");
        const candidate = this.state.candidates[id];
        if (!id || !candidate || seen.has(id) || !candidate.localPath) continue;
        if (!includeInProgress && candidate.labelStatus !== "awaiting_ai") continue;
        seen.add(id);
        requests.push({
          id,
          localPath: candidate.localPath,
          mimeType: candidate.mimeType,
          qqSummary: candidate.qqSummary || null,
          sourceText: String(message?.text || "")
        });
      }
    }
    return requests;
  }

  markLabelFailure(requests = [], error) {
    return this.enqueue(async () => {
      const message = String(error?.message || error || "AI 表情标注失败").slice(0, 500);
      let changed = false;
      for (const request of requests) {
        const candidate = this.state.candidates[String(request?.id || "")];
        if (!candidate) continue;
        candidate.labelStatus = "label_failed";
        candidate.labelError = message;
        changed = true;
      }
      if (changed) await this.save();
    });
  }

  discardCandidates(requests = []) {
    return this.enqueue(async () => {
      const discarded = [];
      const pendingRoot = resolve(this.libraryDir, "pending");
      for (const request of requests) {
        const id = String(request?.id || "");
        const candidate = this.state.candidates[id];
        if (!candidate) continue;
        const candidatePath = resolve(candidate.localPath);
        if (candidatePath === pendingRoot || !candidatePath.startsWith(`${pendingRoot}${sep}`)) {
          throw new Error(`Refusing to delete sticker candidate outside pending directory: ${id}`);
        }
        await rm(candidatePath, { force: true });
        delete this.state.candidates[id];
        discarded.push(id);
      }
      if (discarded.length) await this.save();
      return discarded;
    });
  }

  async inspectManagedFile(path, { pendingOnly = false } = {}) {
    const managedRoot = pendingOnly ? resolve(this.libraryDir, "pending") : this.libraryDir;
    const managedPath = resolve(String(path || ""));
    if (managedPath === managedRoot || !managedPath.startsWith(`${managedRoot}${sep}`)) {
      throw new Error(`Refusing to delete sticker outside managed directory: ${managedPath}`);
    }
    let info;
    try { info = await lstat(managedPath); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const root = await realpath(managedRoot), parent = await realpath(dirname(managedPath));
    if (!info.isFile() || parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error("拒绝清理符号链接、目录或表情库外的文件");
    }
    return info;
  }

  async removeManagedFile(path, options = {}) {
    if (!await this.inspectManagedFile(path, options)) return;
    const managedPath = resolve(String(path));
    await rm(managedPath, { force: true });
  }

  enqueue(operation) {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => {});
    return next;
  }

  async save() {
    this.state.updatedAt = this.nowIso();
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  nowIso() {
    return this.clock().toISOString();
  }
}

function normalizeState(value) {
  const stickers = {};
  const candidates = {};
  for (const [id, raw] of Object.entries(value.stickers || {})) {
    if (!raw?.localPath || !raw?.sha256) continue;
    const normalized = normalizeEntry(id, raw);
    if (raw.labelStatus === "ready") {
      stickers[id] = { ...normalized, usage: normalizeUsage(raw.usage), labelStatus: "ready" };
    } else {
      candidates[id] = {
        ...normalized,
        usage: "",
        labelStatus: "awaiting_ai",
        labelSource: null,
        favoriteStatus: "not_added"
      };
    }
  }
  for (const [id, raw] of Object.entries(value.candidates || {})) {
    if (!raw?.localPath || !raw?.sha256 || stickers[id]) continue;
    const stagedUsage = normalizeUsage(raw.usage);
    const readyToCommit = raw.labelStatus === "ready_to_commit" && stagedUsage;
    candidates[id] = {
      ...normalizeEntry(id, raw),
      usage: readyToCommit ? stagedUsage : "",
      labelStatus: readyToCommit ? "ready_to_commit" : "awaiting_ai",
      labelSource: readyToCommit ? "agent-vision" : null,
      favoriteStatus: "not_added"
    };
  }
  const excluded = {};
  for (const [id, raw] of Object.entries(value.excluded || {})) {
    if (!/^st_[a-f0-9]{12,64}$/i.test(id) || !raw || !["manual", "curation"].includes(raw.reason)) continue;
    const entry = {
      id,
      sha256s: validDigests(raw.sha256s, 64),
      md5s: validDigests(raw.md5s, 32),
      marketEmojiIds: validDigests(raw.marketEmojiIds, 32),
      reason: raw.reason,
      excludedAt: raw.excludedAt || null,
      lastSeenAt: raw.lastSeenAt || null,
      receiveCount: Math.max(0, Number(raw.receiveCount) || 0),
      usage: normalizeUsage(raw.usage || raw.archivedSticker?.usage),
      filesCleanedAt: typeof raw.filesCleanedAt === "string" && Number.isFinite(Date.parse(raw.filesCleanedAt)) ? raw.filesCleanedAt : null
    };
    if (!entry.filesCleanedAt && raw.archivedSticker?.localPath && raw.archivedSticker?.sha256) {
      entry.archivedSticker = normalizeEntry(id, raw.archivedSticker);
    }
    if (entry.sha256s.length || entry.md5s.length || entry.marketEmojiIds.length) excluded[id] = entry;
  }
  return { version: 4, updatedAt: value.updatedAt || null, candidates, stickers, excluded,
    garbagePaths: Array.isArray(value.garbagePaths) ? value.garbagePaths.filter((path) => typeof path === "string") : [] };
}

function validDigests(values, length) {
  const pattern = new RegExp(`^[a-f0-9]{${length}}$`, "i");
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && pattern.test(value)).map((value) => value.toLowerCase()))];
}

function exclusionRecord(entry, reason, now) {
  const record = {
    id: entry.id,
    sha256s: validDigests([entry.sha256, ...(entry.sha256s || [])], 64),
    md5s: validDigests([entry.md5, ...(entry.md5s || [])], 32),
    marketEmojiIds: validDigests([entry.marketEmojiId, ...(entry.marketEmojiIds || [])], 32),
    reason,
    excludedAt: now,
    lastSeenAt: entry.lastSeenAt || null,
    receiveCount: 0,
    archivedSticker: structuredClone(entry)
  };
  if (!record.sha256s.length && !record.md5s.length && !record.marketEmojiIds.length) {
    throw new Error("表情缺少有效指纹，未删除表情");
  }
  return record;
}

function normalizeEntry(id, raw) {
  return {
      id,
      sha256: String(raw.sha256),
      md5: String(raw.md5 || ""),
      sha256s: validDigests(raw.sha256s, 64),
      md5s: validDigests(raw.md5s, 32),
      marketEmojiIds: validDigests(raw.marketEmojiIds, 32),
      localPath: String(raw.localPath),
      mimeType: String(raw.mimeType || "application/octet-stream"),
      size: Number(raw.size || 0),
      marketEmojiId: normalizeMarketEmojiId(raw.marketEmojiId),
      marketPackageId: Number(raw.marketPackageId || 0),
      marketKey: String(raw.marketKey || ""),
      qqSummary: cleanLabel(raw.qqSummary),
      usage: normalizeUsage(raw.usage),
      labelStatus: raw.labelStatus === "ready" ? "ready" : "needs_review",
      labelSource: String(raw.labelSource || "legacy"),
      labelError: raw.labelError ? String(raw.labelError).slice(0, 500) : null,
      favoriteEmojiId: raw.favoriteEmojiId ? String(raw.favoriteEmojiId) : null,
      favoriteStatus: raw.favoriteStatus === "added" ? "added" : "pending",
      favoriteError: raw.favoriteError ? String(raw.favoriteError).slice(0, 500) : null,
      receiveCount: Math.max(1, Number(raw.receiveCount || 1)),
      sendCount: Math.max(0, Number(raw.sendCount || 0)),
      createdAt: raw.createdAt || null,
      lastSeenAt: raw.lastSeenAt || null,
      lastUsedAt: raw.lastUsedAt || null,
      lastSource: raw.lastSource || null
  };
}

function sourceInfo(message) {
  return {
    type: message?.rawType === "private" ? "private" : "group",
    id: String(message?.groupId || message?.senderId || ""),
    messageId: String(message?.messageId || ""),
    senderId: String(message?.senderId || ""),
    seenAt: message?.timestamp || null
  };
}

function uniqueStickerId(stickers, sha256) {
  for (const length of [12, 16, 24, 32, 64]) {
    const id = `st_${sha256.slice(0, length)}`;
    if (!stickers[id]) return id;
  }
  throw new Error("Unable to allocate a unique sticker id");
}

function safeExtension(path, mimeType) {
  const extension = extname(String(path || "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(extension)) return extension;
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp"
  })[String(mimeType || "").toLowerCase()] || ".img";
}

function cleanLabel(value) {
  return String(value || "").replace(/[\r\n|]+/g, " ").trim().slice(0, 80);
}

function normalizeUsage(value) {
  return String(value || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function publicStickerEntry(entry) {
  return {
    id: entry.id,
    usage: entry.usage,
    labelStatus: entry.labelStatus,
    labelSource: entry.labelSource,
    favoriteStatus: entry.favoriteStatus,
    favoriteError: entry.favoriteError || null,
    receiveCount: entry.receiveCount,
    sendCount: entry.sendCount,
    createdAt: entry.createdAt,
    lastSeenAt: entry.lastSeenAt,
    lastUsedAt: entry.lastUsedAt
  };
}

function normalizeMd5(value) {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
}

function normalizeMarketEmojiId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

function mimeTypeForPath(path) {
  return ({
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp"
  })[extname(String(path || "")).toLowerCase()] || "application/octet-stream";
}
