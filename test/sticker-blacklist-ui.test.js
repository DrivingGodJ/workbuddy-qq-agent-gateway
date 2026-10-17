import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
const html = await readFile(new URL("../modules/web-console/public/client.html", import.meta.url), "utf8");

function cleanupUi({ confirm = () => true, api = async () => ({ result: {}, stickers: {} }), count = 2 } = {}) {
  let click;
  const messages = [];
  const context = {
    state: { qq: { stickers: { excludedCount: count, labeling: { model: "test" }, curation: { status: "idle" } } } },
    stickerActionSavingId: "",
    els: { cleanStickerBlacklistFilesButton: { addEventListener(type, handler) { assert.equal(type, "click"); click = handler; } } },
    window: { confirm }, api,
    setStickerGalleryActionStatus(message, tone) { messages.push({ message, tone }); },
    renderStickerGallery() {}, formatBytes: (bytes) => `${Number(bytes || 0)} B`
  };
  const start = source.indexOf('els.cleanStickerBlacklistFilesButton.addEventListener("click"');
  const end = source.indexOf('els.stickerGalleryGrid.addEventListener("input"', start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(source.slice(start, end), context);
  return { click, context, messages };
}

test("blacklist cleanup has an accessible dedicated action and distinguishes missing previews from deleted files", () => {
  assert.match(html, /id="stickerBlacklistTools"[^>]*hidden/u);
  assert.match(html, /id="cleanStickerBlacklistFilesButton"[^>]*aria-describedby="stickerBlacklistCleanupHelp"/u);
  assert.match(html, /id="stickerGalleryActionStatus"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(source, /cleanStickerBlacklistFilesButton\.setAttribute\("aria-busy"/u);
  const start = source.indexOf("function renderStickerCard(");
  const end = source.indexOf("\nfunction stickerCandidateStatus", start);
  const render = runInNewContext(`${source.slice(start, end)}\nrenderStickerCard`, {
    stickerEditingId: "", stickerActionSavingId: "", stickerImageUrl: () => "/sticker",
    escapeHtml: String, formatTime: () => "today"
  });
  const item = { id: "st_test", usage: "测试备注", hasPreview: false, canRestore: false };
  const cleaned = render({ ...item, filesCleanedAt: "2026-10-18T00:00:00Z" }, false, true);
  assert.match(cleaned, /本地文件已清理/u);
  assert.match(cleaned, /解除黑名单/u);
  assert.match(cleaned, /测试备注/u);
  assert.doesNotMatch(cleaned, /<img|恢复到表情库|会补回预览/u);
  assert.match(render(item, false, true), /旧记录暂无预览/u);
});

test("cleanup cancellation and empty blacklist never call the cleanup API", async () => {
  let calls = 0;
  const api = async () => { calls++; };
  const cancelled = cleanupUi({ confirm: (text) => {
    assert.match(text, /删除不可撤销/u);
    assert.match(text, /去重指纹和备注仍保留/u);
    assert.match(text, /QQ 收藏及群消息原图不受影响/u);
    return false;
  }, api });
  await cancelled.click();
  await cleanupUi({ count: 0, api }).click();
  assert.equal(calls, 0);
  assert.equal(cancelled.context.stickerActionSavingId, "");
});

test("cleanup prevents duplicate requests, adopts backend state and reports partial failure", async () => {
  let complete;
  let calls = 0;
  const response = new Promise((resolve) => { complete = resolve; });
  const ui = cleanupUi({ api: (path, options) => {
    calls++;
    assert.equal(path, "/api/qq/stickers/blacklist/clean-files");
    assert.equal(options.method, "POST");
    return response;
  } });
  const running = ui.click();
  assert.equal(ui.context.stickerActionSavingId, "clean-blacklist-files");
  assert.equal(ui.messages.at(-1).tone, "progress");
  await ui.click();
  assert.equal(calls, 1);
  complete({ result: { cleanedCount: 1, freedBytes: 512, pendingFiles: 1 }, stickers: { excludedCount: 2, excludedItems: [{ id: "st_test", filesCleanedAt: "today" }] } });
  await running;
  assert.equal(ui.context.stickerActionSavingId, "");
  assert.equal(ui.context.state.qq.stickers.excludedCount, 2);
  assert.equal(ui.context.state.qq.stickers.excludedItems[0].filesCleanedAt, "today");
  assert.equal(ui.context.state.qq.stickers.labeling.model, "test");
  assert.match(ui.messages.at(-1).message, /512 B.*黑名单和备注保留.*1 个文件暂未删除/u);
  assert.equal(ui.messages.at(-1).tone, "error");
});

test("cleanup success states the next-arrival recovery requirement and failure keeps current records", async () => {
  const success = cleanupUi({ api: async () => ({ result: { cleanedCount: 2, freedBytes: 2048, pendingFiles: 0 }, stickers: { excludedCount: 2 } }) });
  await success.click();
  assert.equal(success.messages.at(-1).tone, "success");
  assert.match(success.messages.at(-1).message, /先解除黑名单，再等下次收到/u);
  const failed = cleanupUi({ api: async () => { throw new Error("offline"); } });
  const before = failed.context.state.qq.stickers;
  await failed.click();
  assert.equal(failed.context.state.qq.stickers, before);
  assert.equal(failed.context.stickerActionSavingId, "");
  assert.equal(failed.messages.at(-1).tone, "error");
  assert.match(failed.messages.at(-1).message, /offline.*黑名单仍保留/u);
});
