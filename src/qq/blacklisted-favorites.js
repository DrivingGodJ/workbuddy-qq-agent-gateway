// Select only freshly verified QQ favorites; historical IDs never authorize deletion.
export function selectBlacklistedFavorites(state, faces) {
  if (!Array.isArray(faces)) throw new Error("QQ 收藏列表无效，未选择任何删除目标");
  const favorites = faces.map((face) => {
    const emojiId = typeof face?.emoji_id === "string" ? face.emoji_id.trim() : "";
    const md5 = validMd5(face?.md5);
    if (!emojiId || !md5) throw new Error("QQ 收藏列表包含无效标识或指纹，未选择任何删除目标");
    return { emojiId, md5 };
  });
  const active = [...Object.values(state?.stickers || {}), ...Object.values(state?.candidates || {})];
  const protectedMd5s = new Set(active.flatMap(digests));
  const protectedIds = new Set(active.map((entry) => String(entry.favoriteEmojiId || "").trim()).filter(Boolean));
  const blockedMd5s = new Set(Object.values(state?.excluded || {}).flatMap((entry) => [
    ...digests(entry), ...digests(entry.archivedSticker)
  ]));
  const byId = new Map();
  for (const face of favorites) {
    if (!byId.has(face.emojiId)) byId.set(face.emojiId, new Set());
    byId.get(face.emojiId).add(face.md5);
  }
  return [...byId].flatMap(([emojiId, md5s]) => {
    // An ID resolving to different contents is ambiguous even if both are blocked.
    if (md5s.size !== 1 || protectedIds.has(emojiId)) return [];
    const [md5] = md5s;
    return blockedMd5s.has(md5) && !protectedMd5s.has(md5) ? [{ emojiId, md5 }] : [];
  });
}

function validMd5(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/iu.test(value) ? value.toLowerCase() : "";
}

function digests(entry) {
  return [entry?.md5, ...(Array.isArray(entry?.md5s) ? entry.md5s : [])].map(validMd5).filter(Boolean);
}
