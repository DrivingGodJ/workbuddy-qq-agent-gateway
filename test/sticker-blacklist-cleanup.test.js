import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QqStickerStore } from "../src/qq/sticker-store.js";

const now = "2026-10-18T08:00:00.000Z";
const emojiId = "abcdef0123456789abcdef0123456789";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "crc-sticker-blacklist-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let favorites = 0;
  const options = {
    filePath: join(root, "stickers.json"), libraryDir: join(root, "library"),
    oneBot: { async fetchCustomFaceDetails() { return []; } },
    fileManager: { async addCustomFace() { favorites++; return { emojiId: "test-favorite" }; } },
    clock: () => new Date(now)
  };
  const manager = new QqStickerStore(options);
  await manager.init();
  const source = join(root, "message.gif");
  await writeFile(source, "original-sticker");
  const message = (image = {}) => ({
    groupId: "group-a", senderId: "member", messageId: "incoming-1",
    images: [{ localPath: source, isSticker: true, mimeType: "image/gif", ...image }]
  });
  async function admit(image = {}) {
    const [candidate] = await manager.collectFromMessage(message(image));
    const [entry] = await manager.applyLabels([{ id: candidate.id, usage: "适合夸张表达震惊和无语时使用" }]);
    return entry;
  }
  return { root, manager, options, source, message, admit, favorites: () => favorites };
}

test("blacklist cleanup removes only archived copies, preserves metadata, and is idempotent", async (t) => {
  const f = await fixture(t), excluded = await f.admit({ emojiId });
  await f.manager.deleteSticker(excluded.id);
  const alias = join(f.root, "alternate.gif");
  await writeFile(alias, "alternate-sticker-encoding");
  await f.manager.collectFromMessage(f.message({ localPath: alias, emojiId }));
  const before = structuredClone(f.manager.state.excluded[excluded.id]);
  const activeSource = join(f.root, "active.gif");
  await writeFile(activeSource, "active-sticker");
  const active = await f.admit({ localPath: activeSource });
  const pendingSource = join(f.root, "pending.gif");
  await writeFile(pendingSource, "pending-sticker");
  const [candidate] = await f.manager.collectFromMessage(f.message({ localPath: pendingSource }));
  const size = (await stat(excluded.localPath)).size;

  assert.deepEqual(await f.manager.cleanExcludedFiles(), { cleanedCount: 1, freedBytes: size, pendingFiles: 0 });
  await assert.rejects(stat(excluded.localPath), { code: "ENOENT" });
  for (const path of [f.source, alias, active.localPath, candidate.localPath, pendingSource]) assert.ok(await stat(path));
  const after = f.manager.state.excluded[excluded.id];
  for (const key of ["id", "sha256s", "md5s", "marketEmojiIds", "reason", "excludedAt", "lastSeenAt", "receiveCount"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.filesCleanedAt, now);
  const visible = f.manager.publicState().excludedItems.find((entry) => entry.id === excluded.id);
  assert.equal(visible.usage, excluded.usage);
  assert.equal(visible.hasPreview, false);
  assert.equal(visible.canRestore, false);
  assert.equal(f.manager.imageAsset(excluded.id), null);
  assert.equal(f.manager.publicState().ready, 1);
  assert.equal(f.manager.publicState().awaitingAi, 1);
  assert.deepEqual(await f.manager.cleanExcludedFiles(), { cleanedCount: 0, freedBytes: 0, pendingFiles: 0 });
});

test("cleaned exclusions survive restart and repeat/native-alias arrivals never recreate a copy or AI work", async (t) => {
  const f = await fixture(t), entry = await f.admit({ emojiId });
  await f.manager.deleteSticker(entry.id);
  await f.manager.cleanExcludedFiles();
  const restored = new QqStickerStore(f.options);
  await restored.init();
  const alternate = join(f.root, "alternate.gif");
  await writeFile(alternate, "changed-native-sticker-encoding");
  for (const image of [{}, { localPath: alternate, emojiId }, { localPath: alternate }]) {
    const message = f.message(image);
    assert.deepEqual(await restored.collectFromMessage(message), []);
    assert.equal(message.images[0].stickerExcluded, true);
    assert.deepEqual(restored.labelRequests([message], { includeInProgress: true }), []);
    assert.equal(restored.imageAsset(entry.id), null);
  }
  assert.equal(restored.state.excluded[entry.id].filesCleanedAt, now);
  assert.equal(restored.state.excluded[entry.id].sha256s.length, 2);
  assert.equal(restored.publicState().awaitingAi, 0);
  assert.equal(f.favorites(), 1);
  assert.deepEqual(await readdir(join(restored.libraryDir, "blacklist")), []);
  await assert.rejects(stat(entry.localPath), { code: "ENOENT" });
  assert.equal(await readFile(f.source, "utf8"), "original-sticker");
  assert.equal(await readFile(alternate, "utf8"), "changed-native-sticker-encoding");
});

test("restoring a cleaned exclusion only unblocks it until the next received image is freshly admitted", async (t) => {
  const f = await fixture(t), entry = await f.admit({ emojiId });
  await f.manager.deleteSticker(entry.id);
  await f.manager.cleanExcludedFiles();
  assert.deepEqual(await f.manager.restoreExcluded(entry.id), { id: entry.id, restored: false, awaitingNewArrival: true });
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.equal(f.manager.publicState().ready, 0);
  assert.equal(f.manager.imageAsset(entry.id), null);
  const restored = new QqStickerStore(f.options);
  await restored.init();
  const message = f.message({ emojiId });
  const [candidate] = await restored.collectFromMessage(message);
  assert.equal(candidate.labelStatus, "awaiting_ai");
  assert.equal(candidate.usage, "");
  assert.equal(message.images[0].stickerExcluded, false);
  assert.equal(restored.labelRequests([message]).length, 1);
  assert.equal(f.favorites(), 1, "unblocking does not re-add a QQ favorite until fresh labeling succeeds");
});

test("restoring an intact archive refreshes QQ favorites and never reuses a stale cached favorite ID", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  const archive = f.manager.state.excluded[entry.id].archivedSticker;
  assert.equal(archive.favoriteStatus, "added");
  assert.equal(archive.favoriteEmojiId, "test-favorite");
  f.manager.favoriteDetails = [{ md5: archive.md5, emoji_id: "test-favorite" }];
  f.manager.favoriteDetailsFetchedAt = Date.now();
  let refreshes = 0, uploads = 0;
  f.options.oneBot.fetchCustomFaceDetails = async () => { refreshes++; return []; };
  f.options.fileManager.addCustomFace = async (restored) => {
    uploads++;
    assert.equal(restored.localPath, entry.localPath);
    assert.equal(restored.favoriteEmojiId, null);
    return { emojiId: "new-favorite" };
  };
  assert.deepEqual(await f.manager.restoreExcluded(entry.id), { id: entry.id, restored: true, awaitingNewArrival: false });
  assert.equal(refreshes, 1, "a fresh QQ list overrides the still-valid local cache");
  assert.equal(uploads, 1, "the deleted QQ favorite is re-uploaded from the intact archive");
  assert.equal(f.manager.state.stickers[entry.id].favoriteStatus, "added");
  assert.equal(f.manager.state.stickers[entry.id].favoriteEmojiId, "new-favorite");
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.equal(restored.state.stickers[entry.id].favoriteEmojiId, "new-favorite");
});

test("cleanup persists its tombstone before removing a file and rolls back if that persistence fails", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  const before = structuredClone(f.manager.state.excluded[entry.id]);
  const save = f.manager.save;
  f.manager.save = async () => { throw new Error("disk full"); };
  await assert.rejects(f.manager.cleanExcludedFiles(), /disk full/);
  f.manager.save = save;
  assert.deepEqual(f.manager.state.excluded[entry.id], before);
  assert.ok(await stat(entry.localPath));
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.equal(restored.publicState().excludedItems[0].canRestore, true);
});

test("failed file cleanup stays queued durably while suppressing new copies and resumes after restart", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  let persistedBeforeRemoval;
  f.manager.removeManagedFile = async () => {
    persistedBeforeRemoval = JSON.parse(await readFile(f.options.filePath, "utf8"));
    throw new Error("temporarily busy");
  };
  const result = await f.manager.cleanExcludedFiles();
  assert.equal(persistedBeforeRemoval.excluded[entry.id].filesCleanedAt, now);
  assert.ok(persistedBeforeRemoval.garbagePaths.includes(entry.localPath));
  assert.equal(result.freedBytes, 0);
  assert.equal(result.pendingFiles, 1);
  assert.equal(f.manager.publicState().cleanupPending, 1);
  assert.ok(await stat(entry.localPath));
  assert.deepEqual(await f.manager.collectFromMessage(f.message()), []);
  assert.equal(f.manager.imageAsset(entry.id), null);
  const restored = new QqStickerStore(f.options);
  await restored.init();
  await assert.rejects(stat(entry.localPath), { code: "ENOENT" });
  assert.equal(restored.publicState().cleanupPending, 0);
  assert.equal(restored.publicState().excludedCount, 1);
  assert.equal(restored.state.excluded[entry.id].filesCleanedAt, now);
});

test("cleanup cannot remove active or candidate files referenced by a corrupt exclusion", async (t) => {
  for (const kind of ["active", "candidate"]) {
    const f = await fixture(t), entry = await f.admit();
    await f.manager.deleteSticker(entry.id);
    const source = join(f.root, `${kind}.gif`);
    await writeFile(source, `${kind}-sticker`);
    const protectedEntry = kind === "active" ? await f.admit({ localPath: source })
      : (await f.manager.collectFromMessage(f.message({ localPath: source })))[0];
    f.manager.state.excluded[entry.id].archivedSticker.localPath = protectedEntry.localPath;
    await f.manager.save();
    await assert.rejects(f.manager.cleanExcludedFiles());
    assert.equal(await readFile(protectedEntry.localPath, "utf8"), `${kind}-sticker`);
    assert.equal(f.manager.publicState().excludedCount, 1);
    const restored = new QqStickerStore(f.options);
    await restored.init();
    assert.ok(await stat(protectedEntry.localPath));
  }
});

test("cleanup refuses outside-root paths and symlink escapes without touching unrelated files", async (t) => {
  for (const kind of ["outside", "symlink-parent", "symlink-file"]) {
    const f = await fixture(t), entry = await f.admit();
    await f.manager.deleteSticker(entry.id);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    const protectedPath = join(outside, "important.gif");
    await writeFile(protectedPath, "unrelated-original");
    let archivePath = protectedPath;
    if (kind === "symlink-parent") {
      const link = join(f.manager.libraryDir, "escaped-directory");
      await symlink(outside, link, "dir");
      archivePath = join(link, "important.gif");
    } else if (kind === "symlink-file") {
      archivePath = join(f.manager.libraryDir, "escaped-file.gif");
      await symlink(protectedPath, archivePath);
    }
    f.manager.state.excluded[entry.id].archivedSticker.localPath = archivePath;
    await f.manager.save();
    await assert.rejects(f.manager.cleanExcludedFiles());
    assert.equal(await readFile(protectedPath, "utf8"), "unrelated-original", kind);
    assert.equal(f.manager.publicState().excludedCount, 1);
    const restored = new QqStickerStore(f.options);
    await restored.init();
    assert.equal(await readFile(protectedPath, "utf8"), "unrelated-original", `${kind} after restart`);
  }
});
