import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataCache } from "../src/storage/metadata-cache.js";
import { OneBotClient } from "../src/qq/onebot-client.js";

test("MetadataCache persists and reloads group names, bot roles, and private display names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-metadata-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "qq-metadata-cache.json");

  const missing = new MetadataCache({ filePath });
  await missing.init();
  assert.deepEqual(missing.snapshot(), { groups: {}, privateChats: {}, updatedAt: null });

  await missing.save({
    groups: {
      "123456": { groupId: "123456", groupName: "测试群聊", botRole: "admin" },
      bad: { groupId: "bad", groupName: "ignore", botRole: "owner" }
    },
    privateChats: {
      "100000001": { displayName: "测试好友" }
    }
  });

  const reloaded = new MetadataCache({ filePath });
  await reloaded.init();
  const snap = reloaded.snapshot();
  assert.deepEqual(snap.groups, {
    "123456": { groupId: "123456", groupName: "测试群聊", botRole: "admin" }
  });
  assert.deepEqual(snap.privateChats, {
    "100000001": { displayName: "测试好友" }
  });
  assert.ok(snap.updatedAt);

  // Tolerates corrupt JSON cleanly
  await writeFile(filePath, "{corrupt json", "utf8");
  const corrupt = new MetadataCache({ filePath });
  await corrupt.init();
  assert.deepEqual(corrupt.snapshot(), { groups: {}, privateChats: {}, updatedAt: null });
});

test("OneBotClient.getFriendList calls /get_friend_list and returns normalized array", async () => {
  const calls = [];
  const oneBot = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    accessToken: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        status: "ok",
        retcode: 0,
        data: [
          { user_id: 100000001, nickname: "好友A", remark: "备注A" },
          { user_id: 100000003, nickname: "好友B", remark: "" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const friends = await oneBot.getFriendList();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3000/get_friend_list");
  assert.equal(friends.length, 2);
  assert.equal(friends[0].user_id, 100000001);
  assert.equal(friends[0].remark, "备注A");

  // Non-array fallback returns []
  const emptyClient = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok", retcode: 0, data: null }), { status: 200 })
  });
  assert.deepEqual(await emptyClient.getFriendList(), []);
});
