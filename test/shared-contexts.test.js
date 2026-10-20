import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SharedContexts } from "../src/qq/shared-contexts.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "qq-shared-contexts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const group = { threadId: "group-original", pendingMessages: [{ sequence: 8 }], deferredThroughSequence: 7 };
  const privateChat = { threadId: "private-original", pendingMessages: [{ sequence: 5 }], deferredThroughSequence: 4 };
  const groupStore = { messageEvents: new EventEmitter(), snapshot: () => structuredClone(group) };
  const privateStore = { messageEvents: new EventEmitter(), snapshot: () => structuredClone(privateChat) };
  const args = { filePath: join(directory, "shared-contexts.json"), groupStore, privateStore,
    groupWorkspace: (id) => `/shared/group-${id}`, ...options };
  const shared = await new SharedContexts(args).init();
  return { shared, args, group, privateChat, directory };
}

test("shared mapping is atomic, survives restart, and never changes either conversation", async (t) => {
  const { shared, args, group, privateChat, directory } = await fixture(t);
  const before = structuredClone({ group, privateChat });
  assert.equal(shared.snapshot("private", "101"), null);
  assert.equal(shared.groupFor("group", "201"), null);
  shared.setPrivateGroup("101", "201");
  shared.setPrivateGroup("102", "201");
  assert.deepEqual(shared.linkedPrivates("201"), ["101", "102"]);
  assert.equal(shared.groupFor("private", "101"), "201");
  assert.equal(shared.groupFor("group", "201"), "201");
  assert.deepEqual(shared.contextFor("private", "101"), { groupId: "201", group, cwd: "/shared/group-201" });
  assert.equal(shared.contextFor("group", "201"), null);
  const restarted = await new SharedContexts(args).init();
  assert.deepEqual(restarted.snapshot("private", "101"), shared.snapshot("private", "101"));
  restarted.setPrivateGroup("101", null);
  assert.equal(restarted.contextFor("private", "101"), null);
  assert.deepEqual({ group, privateChat }, before);
  assert.deepEqual(JSON.parse(await readFile(args.filePath, "utf8")), { version: 1, privateGroups: { "102": "201" } });
  assert.deepEqual(await readdir(directory), ["shared-contexts.json"]);
  assert.equal((await stat(args.filePath)).mode & 0o777, 0o600);
  for (const value of ["../201", "abc", "", "0", "-3", "1.2", "1e9"]) {
    assert.throws(() => shared.setPrivateGroup("101", value), /numeric id/u);
    assert.throws(() => shared.setPrivateGroup(value, "201"), /numeric id/u);
  }
});

test("group and linked private jobs share FIFO and synchronously expose queue and yield state", async (t) => {
  const idle = [];
  let changes = 0;
  const { shared, args } = await fixture(t, { onIdle: (type, id) => idle.push([type, id]), onChange: () => { changes++; } });
  shared.setPrivateGroup("101", "201");
  shared.setPrivateGroup("102", "201");
  let groupWakes = 0;
  let privateWakes = 0;
  args.groupStore.messageEvents.on("201", () => { groupWakes++; });
  args.privateStore.messageEvents.on("101", () => { privateWakes++; });
  const hold = deferred();
  const calls = [];
  const first = shared.run("group", "201", "chat", async () => { calls.push("group"); await hold.promise; return "first"; });
  const second = shared.run("private", "101", "chat", () => { calls.push("private-101"); return "second"; });
  const third = shared.run("private", "102", "qzone", () => { calls.push("private-102"); return "third"; });
  assert.equal(shared.busy("private", "102"), true);
  assert.equal(shared.shouldYield("group", "201"), true);
  assert.deepEqual(shared.snapshot("private", "101"), {
    groupId: "201", linkedPrivateIds: ["101", "102"],
    active: { targetType: "group", targetId: "201", kind: "chat" },
    queued: [{ targetType: "private", targetId: "101", kind: "chat" }, { targetType: "private", targetId: "102", kind: "qzone" }]
  });
  assert.equal(groupWakes, 3);
  assert.equal(privateWakes, 3);
  assert.throws(() => shared.setPrivateGroup("101", null), { code: "BUSY" });
  assert.throws(() => shared.setPrivateGroup("103", "201"), { code: "BUSY" });
  hold.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
  assert.deepEqual(calls, ["group", "private-101", "private-102"]);
  assert.deepEqual(idle, [["group", "201"], ["private", "101"], ["private", "102"]]);
  assert.equal(shared.busy("group", "201"), false);
  assert.equal(shared.shouldYield("private", "101"), false);
  assert.ok(changes >= 8);
});

test("chat jobs deduplicate both active and queued, but other job kinds do not", async (t) => {
  const { shared } = await fixture(t);
  shared.setPrivateGroup("101", "201");
  const hold = deferred();
  let count = 0;
  const first = shared.run("group", "201", "chat", () => hold.promise);
  assert.equal(shared.run("group", "201", "chat", () => { throw new Error("duplicate active"); }), first);
  const next = shared.run("private", "101", "chat", () => { count++; });
  assert.equal(shared.run("private", "101", "chat", () => { throw new Error("duplicate queued"); }), next);
  const other1 = shared.run("private", "101", "qzone", () => { count++; });
  const other2 = shared.run("private", "101", "qzone", () => { count++; });
  assert.notEqual(other1, other2);
  hold.resolve();
  await Promise.all([first, next, other1, other2]);
  assert.equal(count, 3);
});

test("a fresh active-target trigger keeps its FIFO slot behind another channel and before later scheduled work", async (t) => {
  const { shared } = await fixture(t);
  shared.setPrivateGroup("101", "201");
  const hold = deferred();
  const calls = [];
  const first = shared.run("group", "201", "chat", async () => { calls.push("active group"); await hold.promise; });
  const privateA = shared.run("private", "101", "chat", () => { calls.push("private A"); });
  const groupB = shared.run("group", "201", "chat", () => { calls.push("group B"); });
  const scheduledC = shared.run("group", "201", "qzone", () => { calls.push("scheduled C"); });
  assert.notEqual(groupB, first, "a trigger arriving after private A must not merge into the yielding active group");
  assert.equal(shared.run("group", "201", "chat", () => assert.fail("queued duplicate ran")), groupB);
  assert.deepEqual(shared.snapshot("group", "201").queued, [
    { targetType: "private", targetId: "101", kind: "chat" },
    { targetType: "group", targetId: "201", kind: "chat" },
    { targetType: "group", targetId: "201", kind: "qzone" }
  ]);
  hold.resolve();
  await Promise.all([first, privateA, groupB, scheduledC]);
  assert.deepEqual(calls, ["active group", "private A", "group B", "scheduled C"]);
});

test("exceptions cannot block later jobs and queued cancellation only touches its target", async (t) => {
  const { shared } = await fixture(t);
  shared.setPrivateGroup("101", "201");
  shared.setPrivateGroup("102", "201");
  const hold = deferred();
  const calls = [];
  const first = shared.run("group", "201", "chat", async () => { await hold.promise; throw new Error("expected failure"); });
  const cancelled1 = shared.run("private", "101", "chat", () => { throw new Error("cancelled task ran"); });
  const next = shared.run("private", "102", "chat", () => { calls.push("kept"); });
  const cancelled2 = shared.run("private", "101", "qzone", () => { throw new Error("cancelled task ran"); });
  assert.equal(shared.cancelQueued("private", "101"), 2);
  assert.equal(shared.cancelQueued("private", "101"), 0);
  assert.deepEqual(shared.snapshot("group", "201").queued, [{ targetType: "private", targetId: "102", kind: "chat" }]);
  const rejects = [assert.rejects(cancelled1, { code: "CANCELLED" }), assert.rejects(cancelled2, { code: "CANCELLED" }), assert.rejects(first, /expected failure/u)];
  hold.resolve();
  await Promise.all([...rejects, next]);
  assert.deepEqual(calls, ["kept"]);
  assert.equal(shared.busy("group", "201"), false);
});

test("different shared groups and unlinked targets run concurrently", async (t) => {
  const { shared } = await fixture(t);
  shared.setPrivateGroup("101", "201");
  shared.setPrivateGroup("102", "202");
  const hold = deferred();
  const order = [];
  const held = shared.run("group", "201", "chat", () => hold.promise);
  await shared.run("private", "102", "chat", () => { order.push("other group"); });
  await shared.run("private", "103", "chat", () => { order.push("unlinked"); });
  assert.deepEqual(order, ["other group", "unlinked"]);
  assert.equal(shared.busy("group", "201"), true);
  assert.equal(shared.busy("group", "202"), false);
  assert.equal(shared.snapshot("private", "103"), null);
  hold.resolve();
  await held;
});

test("target cancellation flags only its active job, cancels its queue, and resets for later triggers", async (t) => {
  const { shared } = await fixture(t);
  shared.setPrivateGroup("101", "201");
  const hold = deferred();
  const first = shared.run("group", "201", "chat", () => hold.promise);
  const cancelled = shared.run("group", "201", "qzone", () => { throw new Error("cancelled task ran"); });
  const other = shared.run("private", "101", "chat", () => {
    assert.equal(shared.isCancelled("private", "101"), false);
    assert.equal(shared.isCancelled("group", "201"), false);
    return "other preserved";
  });
  assert.equal(shared.cancelTarget("group", "201"), 2);
  assert.equal(shared.isCancelled("group", "201"), true);
  assert.equal(shared.isCancelled("private", "101"), false);
  assert.equal(shared.cancelTarget("group", "201"), 0);
  const rejection = assert.rejects(cancelled, { code: "CANCELLED" });
  hold.resolve();
  await Promise.all([first, other, rejection]);
  assert.equal(shared.isCancelled("group", "201"), false);
  await shared.run("group", "201", "chat", () => {
    assert.equal(shared.isCancelled("group", "201"), false);
  });
});

test("snapshots cannot mutate a lane and failing observers cannot stall it", async (t) => {
  const { shared } = await fixture(t, { onChange: () => { throw new Error("observer failed"); }, onIdle: async () => { throw new Error("idle observer failed"); } });
  shared.setPrivateGroup("101", "201");
  const hold = deferred();
  const first = shared.run("group", "201", "chat", () => hold.promise);
  const next = shared.run("private", "101", "chat", () => "next");
  const snapshot = shared.snapshot("group", "201");
  snapshot.active.targetId = "999";
  snapshot.queued.length = 0;
  snapshot.linkedPrivateIds.length = 0;
  assert.equal(shared.snapshot("group", "201").active.targetId, "201");
  assert.equal(shared.snapshot("group", "201").queued.length, 1);
  assert.equal(shared.snapshot("group", "201").linkedPrivateIds.length, 1);
  hold.resolve();
  assert.deepEqual(await Promise.all([first, next]), [undefined, "next"]);
});
