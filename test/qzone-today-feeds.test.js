import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { QzoneCoordinator, normalizeFeeds, parseQzoneFeedHtml } from "../src/qq/qzone-coordinator.js";
import { QzoneStore } from "../src/qq/qzone-store.js";

test("parseQzoneFeedHtml & normalizeFeeds extract text, images, likes, friend & bot comments, and drop ads", () => {
  const sampleHtml = `
    <div class="f-info">今天天气不错<br/>晚上去操场散步</div>
    <div class="f-ct">
      <div class="img-box"><img src="https://photo.store.qq.com/pic1.jpg" /><img src="https://qzonestyle.gtimg.cn/qzone/em/e1.gif" /></div>
    </div>
    <div class="f-like-list f-like _likeInfo" likeinfo="3">
      <a data-islike="1" data-likecnt="3"></a>
      <div class="user-list"><a class="item q_namecard" link="nameCard_100000002 des_100000002">老代</a></div>
    </div>
    <div class="mod-comments">
      <ul>
        <li class="comments-item bor3" data-type="commentroot" data-tid="1" data-uin="100000003" data-nick="小明">
          <div class="comments-item-bd"><div class="comments-content"><a class="nickname">小明</a>&nbsp; : 一起啊<div class="comments-op"><span class="state">18:10</span></div></div></div>
        </li>
        <li class="comments-item bor3" data-type="commentroot" data-tid="2" data-uin="100000002" data-nick="老代">
          <div class="comments-item-bd"><div class="comments-content"><a class="nickname">老代</a>&nbsp; : 顺路捎杯柠檬茶<div class="comments-op"><span class="state">18:15</span></div></div></div>
        </li>
      </ul>
    </div>
  `;

  const parsed = parseQzoneFeedHtml(sampleHtml, { agentQqId: "100000002" });
  assert.equal(parsed.bodyText, "今天天气不错 晚上去操场散步");
  assert.equal(parsed.likeCount, 3);
  assert.equal(parsed.botLiked, true);
  assert.equal(parsed.imageCount, 1);
  assert.deepEqual(parsed.imageUrls, ["https://photo.store.qq.com/pic1.jpg"]);
  assert.equal(parsed.comments.length, 2);
  assert.equal(parsed.comments[0].isBot, false);
  assert.equal(parsed.comments[0].content, "一起啊");
  assert.equal(parsed.comments[0].timeText, "18:10");
  assert.equal(parsed.comments[1].isBot, true);
  assert.equal(parsed.comments[1].content, "顺路捎杯柠檬茶");
  assert.equal(parsed.comments[1].timeText, "18:15");

  const normalized = normalizeFeeds([
    { uin: 0, key: "advertisement_outlink_0", time: 1_795_514_000, html: '<div class="f-info">广告</div>' },
    { uin: 100000001, key: "feed_1", nickname: "好友A", time: 1_795_514_400, html: sampleHtml }
  ], { agentQqId: "100000002" });

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, "100000001:feed_1");
  assert.equal(normalized[0].comments.length, 2);
  assert.equal(normalized[0].botLiked, true);
});

test("QzoneStore keeps today-only feeds & bot comments, dedupes re-scans, and prunes next day", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qzone-today-test-"));
  let currentNow = new Date("2026-11-24T13:05:00+08:00");
  try {
    const store = new QzoneStore({
      filePath: join(dir, "qzone.json"),
      clock: () => currentNow,
      agentQqId: "100000002",
      agentNameProvider: () => "老代"
    });
    await store.init();

    await store.recordScannedFeeds([
      {
        id: "100000001:tid_today",
        uin: "100000001",
        tid: "tid_today",
        nickname: "好友A",
        timeMs: Date.parse("2026-11-24T12:15:00+08:00"),
        text: "午饭真香",
        likeCount: 2,
        botLiked: false,
        imageCount: 1,
        imageUrls: ["https://photo.store.qq.com/lunch.jpg"],
        comments: []
      },
      {
        id: "100000001:tid_old",
        uin: "100000001",
        tid: "tid_old",
        nickname: "好友A",
        timeMs: Date.parse("2026-11-22T10:00:00+08:00"),
        text: "前天的动态",
        comments: []
      }
    ], { markScannedToday: false });

    await store.recordBotEngagement({
      uin: "100000001",
      tid: "tid_today",
      type: "comment",
      content: "看起来确实不错"
    });
    await store.recordBotEngagement({
      uin: "100000001",
      tid: "tid_today",
      type: "like"
    });
    await store.recordBotPost({ content: "我也刚发了一条测试动态", imageCount: 0 });

    // Re-scan where HTML now includes the bot comment — must deduplicate cleanly
    await store.recordScannedFeeds([
      {
        id: "100000001:tid_today",
        uin: "100000001",
        tid: "tid_today",
        nickname: "好友A",
        timeMs: Date.parse("2026-11-24T12:15:00+08:00"),
        text: "午饭真香",
        likeCount: 3,
        botLiked: true,
        comments: [
          { id: "c:1", uin: "100000002", nickname: "老代", content: "看起来确实不错", timeText: "13:05", isBot: true }
        ]
      }
    ], { markScannedToday: false });

    const todayState = store.publicState();
    assert.equal(todayState.todayDate, "2026-11-24");
    assert.equal(todayState.todayFeeds.length, 2);
    const commentedFeed = todayState.todayFeeds.find((item) => item.tid === "tid_today");
    assert.equal(commentedFeed.botLiked, true);
    assert.equal(commentedFeed.comments.length, 1);
    assert.equal(commentedFeed.comments[0].isBot, true);

    // Roll clock to next day in Asia/Shanghai -> stale entries auto-pruned
    currentNow = new Date("2026-11-25T00:05:00+08:00");
    await store.pruneExpired();
    const nextDayState = store.publicState();
    assert.equal(nextDayState.todayDate, "2026-11-25");
    assert.equal(nextDayState.todayFeeds.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("QzoneCoordinator.refreshTodayFeeds pulls today items and filters previous days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qzone-coord-today-"));
  const fixedNow = new Date("2026-11-24T15:00:00+08:00");
  try {
    const store = new QzoneStore({
      filePath: join(dir, "qzone.json"),
      clock: () => fixedNow,
      agentQqId: "100000002",
      agentNameProvider: () => "老代"
    });
    await store.init();
    const oneBot = new OneBotClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          retcode: 0,
          data: {
            has_more: false,
            feeds: [
              {
                uin: 100000001,
                key: "today_feed_1",
                nickname: "Owner",
                time: Math.floor(Date.parse("2026-11-24T10:30:00+08:00") / 1000),
                html: '<div class="f-info">今日第一条</div>'
              },
              {
                uin: 100000001,
                key: "yesterday_feed_1",
                nickname: "Owner",
                time: Math.floor(Date.parse("2026-11-23T23:50:00+08:00") / 1000),
                html: '<div class="f-info">昨天的动态</div>'
              }
            ]
          }
        })
      })
    });

    const coordinator = new QzoneCoordinator({
      store,
      oneBot,
      clock: () => fixedNow
    });
    const refreshed = await coordinator.refreshTodayFeeds();
    assert.equal(refreshed.todayFeeds.length, 1);
    assert.equal(refreshed.todayFeeds[0].tid, "today_feed_1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
