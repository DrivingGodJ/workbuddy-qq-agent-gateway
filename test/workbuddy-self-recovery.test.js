import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { WorkBuddyClient } from "../src/workbuddy/client.js";
import { conversationStatus } from "../modules/web-console/public/client-status.js";

const reason = "WorkBuddy 长时间无进展；已中断本轮，待处理消息仍保留";
async function until(check) {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await pause(5); }
  throw new Error("Test did not reach expected state");
}
function fixture({ tracking = true, context = {}, delay = 20 } = {}) {
  const client = new WorkBuddyClient({ recoveryDelayMs: delay, idleTimeoutMs: 10_000 });
  const starts = [];
  client.ensureProcess = async () => {};
  client.request = async (method, params) => {
    if (method === "turn/start") { starts.push(params); return { turn: { id: `turn-${starts.length}`, toolTracking: tracking } }; }
    assert.equal(method, "turn/interrupt");
    // A late interrupt event cannot reject the model promise before cleanup ACK.
    client.handleMessage({ method: "turn/completed", params: { threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted" } } });
    await pause(2);
    return { ok: true, toolAttempts: [] };
  };
  const request = { groupId: "offline-group", threadId: "offline-thread", prompt: "offline test",
    prefetchQqMessages: false, qqToolContext: { actionCount: 0, readCalled: true, ...context } };
  return { client, starts, request };
}
function complete(client, id) {
  client.handleMessage({ method: "turn/completed", params: { threadId: "offline-thread",
    turn: { id, status: "completed", items: [{ type: "agentMessage", text: "complete" }] } } });
}

test("one safe timeout resumes the same queued job and preserves the persistent thread", async () => {
  const { client, starts, request } = fixture();
  const result = client.runTurn(request);
  const first = await until(() => client.activeByTurn.get("turn-1"));
  await client.timeoutTurn(first, reason);
  await until(() => client.recoveries.has(request.threadId));
  assert.deepEqual(client.activeGroups(), [request.groupId]);
  assert.equal(client.diagnostics.snapshot(request.threadId).stage, "recovering");
  await assert.rejects(client.runTurn(request), /queued recovery/);
  await until(() => client.activeByTurn.get("turn-2"));
  assert.equal(starts[1].threadId, starts[0].threadId);
  assert.equal(starts[1].refreshClientBeforeTurn, true);
  complete(client, "turn-2");
  assert.equal((await result).text, "complete");
  assert.equal(starts.length, 2);
  assert.equal(client.recoveries.size, 0);
});

test("a second timeout cannot start a third model turn", async () => {
  const { client, starts, request } = fixture();
  const result = client.runTurn(request).catch((e) => e);
  await client.timeoutTurn(await until(() => client.activeByTurn.get("turn-1")), reason);
  await client.timeoutTurn(await until(() => client.activeByTurn.get("turn-2")), reason);
  assert.equal((await result).code, "WORKBUDDY_IDLE_TIMEOUT");
  assert.equal(starts.length, 2);
});

for (const name of ["Bash", "Write", "Agent", "mcp__qq_gateway__send_message", "mcp__qq_gateway__control_home_device", "unknown"]) {
  test(`a possibly side-effecting tool attempt (${name}) forbids replay`, async () => {
    const { client, starts, request } = fixture();
    const result = client.runTurn(request).catch((e) => e);
    const active = await until(() => client.activeByTurn.get("turn-1"));
    client.handleMessage({ method: "turn/toolAttempt", params: { threadId: request.threadId, turnId: active.turnId, name } });
    await client.timeoutTurn(active, reason);
    assert.equal((await result).safeToRetry, false);
    assert.equal(starts.length, 1);
  });
}

test("an uncertain MCP send is marked before dispatch, not only after success", async () => {
  const { client, starts, request } = fixture({ context: { liveMode: true,
    liveTool: async () => { throw new Error("offline uncertain delivery"); } } });
  const result = client.runTurn(request).catch((e) => e);
  const active = await until(() => client.activeByTurn.get("turn-1"));
  await client.ensureMcpGateway();
  try {
    const r = await fetch(client.mcpEndpoint, { method: "POST", headers: {
      "content-type": "application/json", "x-qq-mcp-secret": client.mcpSecret
    }, body: JSON.stringify({ threadId: request.threadId, name: "send_message", arguments: { text: "offline" } }) });
    assert.equal(r.status, 400);
    assert.equal(active.sideEffectsPossible, true);
    await client.timeoutTurn(active, reason);
    assert.equal((await result).safeToRetry, false);
    assert.equal(starts.length, 1);
  } finally { await client.close(); }
});

test("manual cancellation cancels the recovery wait and retains the message context", async () => {
  const { client, starts, request } = fixture({ delay: 1000 });
  const result = client.runTurn(request).catch((e) => e);
  await client.timeoutTurn(await until(() => client.activeByTurn.get("turn-1")), reason);
  await until(() => client.recoveries.has(request.threadId));
  assert.equal(await client.interruptGroup(request.groupId), true);
  assert.equal((await result).code, "CANCELLED");
  assert.equal(starts.length, 1);
  assert.equal(request.qqToolContext.readCalled, true);
});

test("disabling replies during recovery stops the second attempt", async () => {
  let enabled = true;
  const { client, starts, request } = fixture({ context: { canRead: () => enabled } });
  const result = client.runTurn(request).catch((e) => e);
  await client.timeoutTurn(await until(() => client.activeByTurn.get("turn-1")), reason);
  await until(() => client.recoveries.has(request.threadId));
  enabled = false;
  assert.equal((await result).code, "CANCELLED");
  assert.equal(starts.length, 1);
});

test("missing native-tool tracking fails closed instead of replaying", async () => {
  const { client, starts, request } = fixture({ tracking: false });
  const result = client.runTurn(request).catch((e) => e);
  await client.timeoutTurn(await until(() => client.activeByTurn.get("turn-1")), reason);
  assert.equal((await result).safeToRetry, false);
  assert.equal(starts.length, 1);
});

test("interrupt audit blocks replay even when the live tool notification was lost", async () => {
  const { client, starts, request } = fixture();
  const originalRequest = client.request;
  client.request = async (method, params) => method === "turn/interrupt"
    ? { ok: true, toolAttempts: ["Bash"] } : originalRequest(method, params);
  const result = client.runTurn(request).catch((e) => e);
  await client.timeoutTurn(await until(() => client.activeByTurn.get("turn-1")), reason);
  assert.equal((await result).safeToRetry, false);
  assert.equal(starts.length, 1);
});

test("compaction keeps its independent deadline and is not blindly replayed", async () => {
  const { client, starts, request } = fixture();
  const result = client.runTurn(request).catch((e) => e);
  const active = await until(() => client.activeByTurn.get("turn-1"));
  client.handleMessage({ method: "thread/compacting", params: { threadId: request.threadId } });
  const deadline = active.compactionDeadlineAt;
  client.handleMessage({ method: "turn/progress", params: { threadId: request.threadId, turnId: active.turnId, stage: "response" } });
  assert.equal(active.compactionDeadlineAt, deadline);
  await client.timeoutTurn(active, "WorkBuddy 上下文压缩超时");
  assert.equal((await result).code, "WORKBUDDY_COMPACTION_TIMEOUT");
  assert.equal(starts.length, 1);
});

test("status labels distinguish real preprocessing, model waiting, and one recovery", () => {
  for (const [stage, label] of [["preparing_images", "处理图片"], ["prompt_sent", "等模型"], ["waiting_model", "等模型"], ["recovering", "恢复中"]]) {
    assert.equal(conversationStatus({ activeReply: { running: true }, diagnostics: { stage, finishedAtMs: null } }).short, label);
  }
  const qzone = conversationStatus({ activeReply: { running: true }, qzoneActivity: { kind: "feed", stage: "running" },
    diagnostics: { stage: "prompt_sent", finishedAtMs: null } });
  assert.equal(qzone.short, "看动态");
  assert.match(qzone.detail, /等待模型输出/);
});
