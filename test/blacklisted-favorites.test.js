import test from "node:test";
import assert from "node:assert/strict";
import { selectBlacklistedFavorites } from "../src/qq/blacklisted-favorites.js";

const a = "a".repeat(32);
const b = "b".repeat(32);
const c = "c".repeat(32);
const face = (emoji_id, md5) => ({ emoji_id, md5 });
const state = (excluded = {}, stickers = {}, candidates = {}) => ({ excluded, stickers, candidates });

test("native cleanup matches blacklist MD5 aliases and archived content, never stale IDs alone", () => {
  const catalog = state({
    one: { md5s: [a.toUpperCase()], archivedSticker: { favoriteEmojiId: "reused-id" } },
    two: { archivedSticker: { md5: b } },
    three: { archivedSticker: { md5s: [c] } },
    nativeOnly: { marketEmojiIds: [a], archivedSticker: { favoriteEmojiId: "no-digest" } }
  });
  assert.deepEqual(selectBlacklistedFavorites(catalog, [
    face("reused-id", "d".repeat(32)), face("no-digest", "e".repeat(32)),
    face("new-a", a), face("new-b", b.toUpperCase()), face("new-c", c)
  ]), [
    { emojiId: "new-a", md5: a }, { emojiId: "new-b", md5: b }, { emojiId: "new-c", md5: c }
  ]);
});

test("active and candidate MD5 aliases and native favorite IDs protect content from deletion", () => {
  const catalog = state({ blocked: { md5s: [a, b, c] } }, {
    current: { md5: a.toUpperCase() },
    alias: { md5s: [b] },
    native: { favoriteEmojiId: "protected-active" }
  }, {
    waiting: { md5s: [c] },
    native: { favoriteEmojiId: "protected-candidate" }
  });
  assert.deepEqual(selectBlacklistedFavorites(catalog, [
    face("a", a), face("b", b), face("c", c),
    face("protected-active", a), face("protected-candidate", b)
  ]), []);
  assert.deepEqual(selectBlacklistedFavorites(state({ blocked: { md5s: [a] } }, {
    current: { favoriteEmojiId: "held" }
  }), [face("held", a)]), []);
  assert.deepEqual(selectBlacklistedFavorites(state({ blocked: { md5s: [a] } }, {}, {
    waiting: { favoriteEmojiId: "held" }
  }), [face("held", a)]), []);
});

test("duplicate rows deduplicate but conflicting contents for one native ID are skipped", () => {
  const catalog = state({ blocked: { md5s: [a, b] } });
  assert.deepEqual(selectBlacklistedFavorites(catalog, [
    face("same", a), face("same", a.toUpperCase()),
    face("ambiguous-blocked", a), face("ambiguous-blocked", b),
    face("ambiguous-unblocked", a), face("ambiguous-unblocked", c)
  ]), [{ emojiId: "same", md5: a }]);
});

test("malformed favorite lists fail closed instead of selecting a partial deletion batch", () => {
  const catalog = state({ blocked: { md5s: [a] } });
  for (const invalid of [null, {}, undefined]) assert.throws(() => selectBlacklistedFavorites(catalog, invalid), /无效/u);
  for (const invalid of [null, {}, face("", a), face("  ", a), face(123, a), face("id", "x".repeat(32)), face("id", 123)]) {
    assert.throws(() => selectBlacklistedFavorites(catalog, [face("valid", a), invalid]), /无效/u);
  }
  assert.deepEqual(selectBlacklistedFavorites(catalog, []), []);
});
