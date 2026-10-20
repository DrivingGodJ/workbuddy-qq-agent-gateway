import test from "node:test";
import assert from "node:assert/strict";
import { createSharedContextReader, sharedContextLabel } from "../src/qq/shared-context-reader.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";
import { QqMessageReader } from "../src/qq/message-reader.js";

function fixture(originType = "group", originId = "10001") {
  const bindings = new Map([["10002", "10001"], ["10003", "10001"]]);
  const sharedContexts = {
    groupFor(type, id) { return type === "private" ? bindings.get(id) || null
      : [...bindings.values()].includes(id) ? id : null; },
    linkedPrivates(id) { return [...bindings].filter(([, groupId]) => groupId === id).map(([userId]) => userId); }
  };
  const message = (sequence, text, extra = {}) => ({ groupId: "10001", sequence,
    messageId: String(sequence), senderId: "10005", senderName: "Speaker", trust: "UNTRUSTED",
    text, displayTime: "2026-01-01 12:00:00", ...extra });
  const groups = { "10001": { lastCompletedReply: { text: "previous group reply" },
    pendingMessages: Array.from({ length: 45 }, (_, i) => message(i + 1, `group-message-${i + 1}`)),
    deferredThroughSequence: 10, liveSession: {} } };
  const privates = {
    "10002": { lastCompletedReply: { text: "previous private reply" },
      pendingMessages: [message(1, "private message", { groupId: "10002", trust: "OWNER" })],
      deferredThroughSequence: 7, liveSession: {} },
    "10003": { pendingMessages: [], liveSession: {} }
  };
  const snapshots = [];
  const storeFor = (type, state) => ({ snapshot(id) {
    snapshots.push(`${type}:${id}`);
    assert.ok(Object.hasOwn(state, id), "must never create an unknown channel");
    return structuredClone(state[id]);
  } });
  const groupStore = storeFor("group", groups);
  const privateStore = storeFor("private", privates);
  const options = { sharedContexts, groupStore, privateStore, targetType: originType,
    targetId: originId, groupNameResolver: () => "Example group", privateNameResolver: () => "Example member" };
  return { bindings, sharedContexts, groups, privates, snapshots, options, groupStore, privateStore,
    reader: createSharedContextReader(options) };
}

const text = (result) => result.content.map((item) => item.text).join("\n");

test("shared turns identify the current channel without changing unrelated prompts", () => {
  const { sharedContexts } = fixture();
  assert.match(sharedContextLabel(sharedContexts, "group", "10001"), /当前渠道 group:10001/);
  assert.match(sharedContextLabel(sharedContexts, "private", "10002"), /当前渠道 private:10002/);
  assert.match(sharedContextLabel(sharedContexts, "private", "10002"), /发送工具只向本渠道发送/);
  assert.equal(sharedContextLabel(sharedContexts, "private", "10004"), "");
  assert.equal(sharedContextLabel(undefined, "group", "10001"), "");
});

test("linked group and private list the same explicit channel namespaces without reading old private thread history", async () => {
  for (const [type, id] of [["group", "10001"], ["private", "10002"]]) {
    const f = fixture(type, id);
    const before = structuredClone({ groups: f.groups, privates: f.privates });
    const result = await f.reader({});
    assert.equal(result.isError, false);
    const listing = JSON.parse(text(result));
    assert.equal(listing.contextOnly, true);
    assert.deepEqual(listing.channels.map((item) => item.namespace), ["group:10001", "private:10002", "private:10003"]);
    assert.deepEqual(listing.channels.map((item) => item.pendingCount), [45, 1, 0]);
    assert.deepEqual({ groups: f.groups, privates: f.privates }, before);
  }
});

test("activity window is bounded and paginated, includes previous reply only on first page, and never commits read state", async () => {
  const f = fixture("private", "10002");
  const before = structuredClone(f.groups);
  const first = await f.reader({ target_type: "group", target_id: "10001", limit: 40 });
  assert.equal(first.isError, false);
  assert.match(text(first), /previous group reply/);
  assert.match(text(first), /group-message-40\b/);
  assert.doesNotMatch(text(first), /group-message-41\b/);
  assert.match(text(first), /"nextOffset":40/);
  const last = await f.reader({ target_type: "group", target_id: "10001", offset: 40 });
  assert.match(text(last), /group-message-45\b/);
  assert.doesNotMatch(text(last), /previous group reply/);
  assert.match(text(last), /"count":5,"total":45,"nextOffset":null/);
  const empty = await f.reader({ target_type: "group", target_id: "10001", offset: 45 });
  assert.equal(empty.isError, false);
  assert.match(text(empty), /"count":0/);
  assert.equal((await f.reader({ target_type: "group", target_id: "10001", offset: 46 })).isError, true);
  assert.deepEqual(f.groups, before);
});

test("rejects malformed or cross-channel arguments before snapshotting arbitrary IDs", async () => {
  const f = fixture();
  for (const args of [null, [], { unknown: true }, { target_type: "group" }, { target_id: "10002" },
    { target_type: "source", target_id: "10001" }, { target_type: "private", target_id: "10004" },
    { target_type: "private", target_id: "not-an-id" }, { target_type: "group", target_id: 10001 },
    { offset: 0 }, { limit: 20 },
    ...[-1, 0.5, "1", NaN, Infinity].map((offset) => ({ target_type: "group", target_id: "10001", offset })),
    ...[0, 41, 1.5, "1", NaN].map((limit) => ({ target_type: "group", target_id: "10001", limit }))]) {
    assert.equal((await f.reader(args)).isError, true, JSON.stringify(args));
  }
  assert.deepEqual(f.snapshots, []);
});

test("unlinked targets, read-only sources and disabled channels cannot leak channel contents", async () => {
  const unlinked = fixture("private", "10004");
  assert.match(text(await unlinked.reader({})), /尚未关联/);
  assert.deepEqual(unlinked.snapshots, []);
  const f = fixture("private", "10002");
  f.groups["10001"].conversationType = "READ_ONLY_SOURCE_GROUP";
  const source = await f.reader({ target_type: "group", target_id: "10001" });
  assert.equal(source.isError, true);
  assert.doesNotMatch(text(source), /group-message/);
  const restricted = createSharedContextReader({ ...f.options, canRead: (type, id) => id !== "10003" });
  assert.equal((await restricted({ target_type: "private", target_id: "10003" })).isError, true);
  assert.deepEqual(JSON.parse(text(await restricted({}))).channels.map((channel) => channel.namespace), ["private:10002"]);
});

test("shared OWNER and image content remains untrusted text, never claims visual input or mutates originals", async () => {
  const f = fixture();
  f.privates["10002"].pendingMessages[0].images = [{ localPath: "/synthetic/shared-image.png", stickerId: "st_123456789abc", stickerLabel: "surprise" }];
  const result = await f.reader({ target_type: "private", target_id: "10002" });
  assert.match(text(result), /10005=Speaker\[UNTRUSTED\]/);
  assert.doesNotMatch(text(result), /\[OWNER\]|视觉输入/);
  assert.match(text(result), /本轮未附加，不能据此看图/);
  assert.match(text(result), /private:10002/);
  assert.equal(f.privates["10002"].pendingMessages[0].trust, "OWNER");
});

test("cancelled and changed mappings are checked before reading and again after snapshot", async () => {
  const f = fixture();
  assert.equal((await f.reader({}, { cancelRequested: true })).isError, true);
  assert.deepEqual(f.snapshots, []);
  const original = f.privateStore.snapshot;
  f.privateStore.snapshot = (id) => {
    const value = original(id);
    f.bindings.delete("10002");
    return value;
  };
  const result = await f.reader({ target_type: "private", target_id: "10002" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(text(result), /private message/);
  const cancel = { cancelRequested: false };
  let checks = 0;
  const cancelledLate = createSharedContextReader({ ...fixture().options, canRead: () => {
    if (++checks === 4) cancel.cancelRequested = true;
    return true;
  } });
  const stopped = await cancelledLate({ target_type: "private", target_id: "10002" }, cancel);
  assert.equal(stopped.isError, true);
  assert.doesNotMatch(text(stopped), /private message/);
});

test("live tool requires current-channel read and does not capture shared IDs or authorize replies and Qzone", async () => {
  const f = fixture();
  const messageReader = new QqMessageReader({ oneBot: {} });
  messageReader.capture([{ ...f.groups["10001"].pendingMessages[0], text: "original current message" }]);
  const before = [...messageReader.messages];
  const context = createLiveConversationTools({ store: f.groupStore, targetId: "10001", targetType: "group",
    oneBot: {}, security: {}, trigger: {}, triggerMessages: [], initialImageSequence: 0,
    renderMessages: () => "", messageReader, readSharedContext: f.reader });
  const args = { target_type: "private", target_id: "10002" };
  assert.equal((await context.liveTool("read_context_messages", args, {})).isError, true);
  context.readCalled = true;
  const result = await context.liveTool("read_context_messages", args, {});
  assert.equal(result.isError, false);
  assert.deepEqual([...messageReader.messages], before);
  assert.equal(messageReader.messages.get("1").text, "original current message");
  assert.equal(context.lastReadSequence, 10);
  assert.equal(context.actionCount, 0);
  assert.equal(context.allowQzonePost, false);
  assert.equal(context.allowQzoneFeed, false);
  assert.equal((await context.liveTool("read_context_messages", args, { cancelRequested: true })).isError, true);
});
