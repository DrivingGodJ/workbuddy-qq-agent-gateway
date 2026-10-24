import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QqStickerStore, STICKER_COLLECTION_LIMIT } from "../src/qq/sticker-store.js";
import { EphemeralStickerLabeler } from "../src/qq/sticker-labeler.js";
import { buildStickerLabelPrompt, parseStickerLabelResult } from "../src/qq/sticker-label.js";
import { OneBotClient } from "../src/qq/onebot-client.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qq-sticker-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faces = [], deleted = [], added = [];
  const options = { filePath: join(root, "stickers.json"), libraryDir: join(root, "library"),
    oneBot: {
      async fetchCustomFaceDetails() { return structuredClone(faces); },
      async deleteCustomFace(id) { deleted.push(id); const index = faces.findIndex((item) => item.emoji_id === id); if (index >= 0) faces.splice(index, 1); }
    }, fileManager: { async addCustomFace(entry) { added.push(entry.id); return { emojiId: `native-${entry.id}` }; } } };
  const manager = new QqStickerStore(options);
  await manager.init();
  let serial = 0;
  const incoming = async (body = `image-${++serial}`) => {
    const path = join(root, `incoming-${++serial}.gif`);
    await writeFile(path, body);
    return { groupId: "10001", senderId: "10002", messageId: String(serial),
      images: [{ isSticker: true, mimeType: "image/gif", localPath: path }] };
  };
  return { root, manager, options, faces, deleted, added, incoming };
}

test("vision chooses keep or blacklist using plain text while the gateway owns candidate IDs", () => {
  const requests = [{ id: "st_aaaaaaaaaaaa" }, { id: "st_bbbbbbbbbbbb" }];
  assert.match(buildStickerLabelPrompt(requests), /收录：中文使用场景.*拉黑：简短中文理由/u);
  assert.deepEqual(parseStickerLabelResult("收录：适合震惊到说不出话\n拉黑：无内容的纯色占位图", requests), [
    { id: requests[0].id, usage: "适合震惊到说不出话" },
    { id: requests[1].id, usage: "无内容的纯色占位图", decision: "blacklist" }
  ]);
  assert.throws(() => parseStickerLabelResult("拉黑：", [requests[0]]));
  assert.throws(() => parseStickerLabelResult("拉黑：图片未加载无法识别内容", [requests[0]]));
});

test("110 total slots include candidates, serialize parallel intake, preserve duplicates and originals", async (t) => {
  const f = await fixture(t);
  const messages = await Promise.all(Array.from({ length: STICKER_COLLECTION_LIMIT + 4 }, () => f.incoming()));
  const collected = await Promise.all(messages.map((message) => f.manager.collectFromMessage(message)));
  assert.equal(collected.flat().length, 110);
  assert.equal(f.manager.publicState().collectionLimit, 110);
  assert.equal(f.manager.publicState().collectionFull, true);
  assert.equal(f.manager.publicState().needsReview, 110);
  assert.equal(messages.at(-1).images[0].stickerCollectionSkipped, "capacity");
  assert.equal(f.manager.publicState().excludedCount, 0, "full must never silently blacklist an unseen image");
  assert.ok(await stat(messages.at(-1).images[0].localPath));
  const repeat = await f.incoming(await readFile(messages[0].images[0].localPath, "utf8"));
  assert.equal((await f.manager.collectFromMessage(repeat))[0].id, collected[0][0].id);
  assert.equal(f.manager.publicState().needsReview, 110);
  await f.manager.discardCandidates([collected[0][0]]);
  assert.equal((await f.manager.collectFromMessage(messages.at(-1))).length, 1, "a freed reservation permits a new candidate");
});

test("AI rejection is deferred until commit, persists over restart and skips future recognition", async (t) => {
  const f = await fixture(t);
  const message = await f.incoming("meaningless-image");
  const [candidate] = await f.manager.collectFromMessage(message);
  f.faces.push({ emoji_id: "blocked-native", md5: candidate.md5 });
  let purged = false;
  const labeler = new EphemeralStickerLabeler({ stickerManager: f.manager, workspaceRoot: join(f.root, "jobs"),
    codex: { async startThread() { return "temporary-label"; }, async runTurn() { return { text: "拉黑：无意义的空白占位图" }; },
      async deleteThread() { purged = true; } } });
  await labeler.init();
  const result = await labeler.labelMessages([message], { deferCommit: true });
  assert.equal(purged, true);
  assert.equal(result.labels[0].decision, "blacklist");
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.equal(f.deleted.length, 0, "recognition may not mutate the library during a reply");
  const restored = new QqStickerStore(f.options);
  await restored.init();
  const [outcome] = await restored.commitStagedLabels([candidate.id]);
  assert.equal(outcome.labelStatus, "excluded");
  assert.equal(restored.publicState().total, 0);
  assert.equal(restored.publicState().needsReview, 0);
  assert.equal(restored.publicState().excludedItems[0].reason, "ai_rejected");
  assert.equal(restored.publicState().excludedItems[0].favoriteCleanupStatus, "absent");
  assert.deepEqual(f.deleted, ["blocked-native"]);
  assert.deepEqual(f.added, []);
  assert.ok(await stat(message.images[0].localPath));
  const repeat = await f.incoming("meaningless-image");
  assert.deepEqual(await restored.collectFromMessage(repeat), []);
  assert.equal(repeat.images[0].stickerExcluded, true);
  const final = new QqStickerStore(f.options);
  await final.init();
  assert.equal(final.publicState().excludedItems[0].reason, "ai_rejected");
});

test("a keep decision still admits a favorite and blacklist cleanup only removes verified blocked contents", async (t) => {
  const f = await fixture(t);
  const message = await f.incoming();
  const [candidate] = await f.manager.collectFromMessage(message);
  await f.manager.applyLabels(parseStickerLabelResult("收录：适合惊讶时使用", [candidate]));
  assert.equal(f.added.length, 1);
  const unrelated = "f".repeat(32);
  f.faces.push({ emoji_id: "old-stale-id", md5: unrelated }, { emoji_id: "actual-blocked", md5: candidate.md5 });
  await f.manager.deleteSticker(candidate.id);
  assert.deepEqual(f.deleted, ["actual-blocked"]);
  assert.equal(f.faces[0].emoji_id, "old-stale-id");
  assert.equal(f.manager.publicState().excludedItems[0].favoriteCleanupStatus, "absent");
  assert.equal(f.manager.publicState().excludedCount, 1);
});

test("uncertain native deletion retains the blacklist and reports pending, never pretends success", async (t) => {
  const f = await fixture(t);
  const [candidate] = await f.manager.collectFromMessage(await f.incoming());
  await f.manager.applyLabels([{ id: candidate.id, usage: "适合无语时使用" }]);
  f.faces.push({ emoji_id: "blocked", md5: candidate.md5 });
  f.options.oneBot.deleteCustomFace = async () => { throw new Error("timeout"); };
  await f.manager.deleteSticker(candidate.id);
  const result = await f.manager.cleanupExcludedFavorites();
  assert.equal(result.deleted, 0);
  assert.equal(result.remaining, 1);
  assert.equal(f.manager.publicState().excludedItems[0].favoriteCleanupStatus, "pending");
  assert.match(f.manager.publicState().excludedItems[0].favoriteCleanupError, /timeout/);
  assert.equal(f.manager.publicState().total, 0);
});

test("a blacklist alias colliding with an active favorite is protected and not falsely called absent", async (t) => {
  const f = await fixture(t);
  const [candidate] = await f.manager.collectFromMessage(await f.incoming());
  await f.manager.applyLabels([{ id: candidate.id, usage: "适合开心时使用" }]);
  await f.manager.deleteSticker(candidate.id);
  f.manager.state.stickers.st_ffffffffffff = { ...candidate, id: "st_ffffffffffff", labelStatus: "ready", usage: "适合开心时使用" };
  f.faces.push({ emoji_id: "protected", md5: candidate.md5 });
  const result = await f.manager.cleanupExcludedFavorites();
  assert.equal(result.protected, 1);
  assert.equal(f.deleted.length, 0);
  assert.equal(f.manager.publicState().excludedItems[0].favoriteCleanupStatus, "protected");
});

test("a stale over-cap candidate cannot create a 111th admitted sticker", async (t) => {
  const f = await fixture(t);
  const incoming = await f.incoming();
  const [candidate] = await f.manager.collectFromMessage(incoming);
  for (let n = 0; n < 110; n++) f.manager.state.stickers[`seed-${n}`] = { labelStatus: "ready" };
  const [result] = await f.manager.applyLabels([{ id: candidate.id, usage: "适合震惊时使用" }]);
  assert.equal(result.labelStatus, "capacity_skipped");
  assert.equal(Object.keys(f.manager.state.stickers).length, 110);
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.ok(await stat(incoming.images[0].localPath));
  assert.equal(f.added.length, 0);
});

test("favorite absence requires an explicit successful, valid QQ list response", async () => {
  let body;
  const client = new OneBotClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
  for (body of [{}, { status: "ok", data: [] }, { status: "ok", retcode: 0, data: {} }]) await assert.rejects(client.fetchCustomFaceDetails(), /明确成功/);
  body = { status: "ok", retcode: 0, data: [] };
  assert.deepEqual(await client.fetchCustomFaceDetails(), []);
});
