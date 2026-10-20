import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const OWNER = "100000001", BOT = "100000002", PRIVATE = "100000003";
const GROUP = "200000001", BUSY_GROUP = "200000002", FOREIGN = "200000003";
const projectDir = fileURLToPath(new URL("..", import.meta.url));

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function waitFor(check, message, timeout = 8000) {
  const until = Date.now() + timeout;
  do { if (await check()) return; await pause(20); } while (Date.now() < until);
  throw new Error(message);
}

test("real context-link HTTP API preserves parked sessions, enforces scope, survives restart and blocks concurrent deletion", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qq-shared-api-"));
  const runtime = join(root, "runtime"), data = join(runtime, "data"), sharedData = join(root, "shared-data");
  await Promise.all([mkdir(data, { recursive: true }), mkdir(sharedData, { recursive: true })]);
  const privatePath = join(data, "private-sessions.json"), groupPath = join(data, "group-sessions.json");
  const linksPath = join(data, "context-links.json"), forbiddenPath = join(root, "forbidden-rpc.log");
  const delayFlag = join(root, "delay-private-save"), delayEntered = join(root, "private-save-entered");
  const failMappingFlag = join(root, "fail-mapping-once");
  const config = { model: "gpt-5.6-luna", reasoningEffort: "low", contextTokenLimit: 64000,
    workingMode: "agent", permissionMode: "readOnly", calendarRemindersEnabled: false,
    homeAssistantPermission: "disabled", speakerGreetings: { morning: false, noon: false, night: false } };
  const pending = [{ groupId: PRIVATE, sequence: 5, messageId: "90001", senderId: PRIVATE,
    senderName: "Synthetic member", text: "retained private message", trust: "UNTRUSTED", images: [], attachments: [],
    timestamp: "2026-01-01T00:00:00.000Z", displayTime: "2026-01-01 08:00:00" }];
  const followupStartedAt = Date.now();
  const groupState = { version: 4, nextSequence: 10, groups: {
    [GROUP]: { groupId: GROUP, threadId: "shared-thread", codexConfig: { ...config, reasoningEffort: "high", contextTokenLimit: 100000 }, pendingMessages: [] },
    [BUSY_GROUP]: { groupId: BUSY_GROUP, threadId: "second-thread", codexConfig: config, pendingMessages: [],
      replyFollowup: { startedAt: new Date(followupStartedAt).toISOString(), expiresAt: new Date(followupStartedAt + 120000).toISOString(), afterSequence: 0 } }
  } };
  await Promise.all([
    writeFile(join(data, "settings.json"), JSON.stringify({ qq: { allowedGroups: [GROUP, BUSY_GROUP], privateAgentUsers: [PRIVATE] }, ai: config })),
    writeFile(join(data, "agent-dispatch.json"), JSON.stringify({ version: 1, enabled: false })),
    writeFile(groupPath, JSON.stringify(groupState)),
    writeFile(privatePath, JSON.stringify({ version: 4, nextSequence: 6, groups: {
      [PRIVATE]: { groupId: PRIVATE, threadId: "parked-thread", codexConfig: config, pendingMessages: pending,
        deferredThroughSequence: 5, periodicCheckedThroughSequence: 5 }
    } }))
  ]);
  const fakeCli = join(root, "fake-codex.mjs"), fakeDocker = join(root, "fake-docker.mjs"), preload = join(root, "delay-save.cjs");
  await writeFile(fakeCli, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const loaded = new Set(['shared-thread', 'parked-thread', 'second-thread']);
for await (const line of createInterface({ input: process.stdin })) {
  const q = JSON.parse(line); if (q.id == null) continue;
  let result;
  if (q.method === 'initialize') result = { userAgent: 'offline-test' };
  else if (q.method === 'model/list') result = { data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'Synthetic model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };
  else if (q.method === 'thread/loaded/list') result = { data: [...loaded] };
  else if (q.method === 'thread/resume') { loaded.add(q.params.threadId); result = { thread: { id: q.params.threadId } }; }
  else { appendFileSync(process.env.TEST_FORBIDDEN_RPC, q.method + '\\n'); process.stdout.write(JSON.stringify({id:q.id,error:{code:-32601,message:'Forbidden offline RPC'}})+'\\n'); continue; }
  process.stdout.write(JSON.stringify({ id: q.id, result }) + '\\n');
}
`, { mode: 0o755 });
  await writeFile(fakeDocker, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  await writeFile(preload, `const fs = require('node:fs');
const promises = require('node:fs/promises');
const original = promises.rename;
const originalSync = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to) === process.env.TEST_LINKS_PATH && fs.existsSync(process.env.TEST_FAIL_MAPPING)) {
    fs.unlinkSync(process.env.TEST_FAIL_MAPPING);
    throw new Error('Synthetic mapping persistence failure');
  }
  return originalSync(from, to);
};
promises.rename = async function(from, to) {
  if (String(to) === process.env.TEST_PRIVATE_PATH && fs.existsSync(process.env.TEST_DELAY_FLAG)) {
    fs.writeFileSync(process.env.TEST_DELAY_ENTERED, 'entered');
    while (fs.existsSync(process.env.TEST_DELAY_FLAG)) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return original(from, to);
};
require('node:module').syncBuiltinESMExports();
`);
  const oneBotCalls = [];
  const oneBot = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url.split("?")[0];
    oneBotCalls.push(path);
    let value;
    if (path === "/get_group_list") value = [GROUP, BUSY_GROUP, FOREIGN].map((id) => ({ group_id: Number(id), group_name: `Synthetic ${id}` }));
    else if (path === "/get_stranger_info") value = { user_id: body.user_id, nickname: "Synthetic member" };
    else if (path === "/get_login_info") value = { user_id: Number(BOT), nickname: "Synthetic bot" };
    else if (path === "/get_status") value = { online: true, good: true };
    else if (["/get_group_member_list", "/get_friend_list"].includes(path)) value = [];
    else { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `Forbidden offline OneBot action ${path}` })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: value }));
  });
  await new Promise((resolve) => oneBot.listen(0, "127.0.0.1", resolve));
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child = null, exit = null, output = "";
  const stop = async () => {
    if (!child) return;
    const running = child;
    child = null;
    if (running.exitCode == null && running.signalCode == null) running.kill("SIGTERM");
    await exit;
  };
  t.after(async () => {
    await rm(delayFlag, { force: true });
    await stop();
    oneBot.closeAllConnections();
    await new Promise((resolve) => oneBot.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const api = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: "Bearer synthetic-test-api" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const start = async () => {
    output = "";
    child = spawn(process.execPath, ["--require", preload, "src/server.js"], { cwd: projectDir,
      env: { ...process.env, CODEX_REMOTE_CONTACT_OWNER_QQ_ID: OWNER, CODEX_REMOTE_CONTACT_BOT_QQ_ID: BOT,
        CODEX_REMOTE_CONTACT_HOST: "127.0.0.1", CODEX_REMOTE_CONTACT_PORT: String(port),
        CODEX_REMOTE_CONTACT_DISABLE_AUTH: "0", CODEX_REMOTE_CONTACT_API_TOKEN: "synthetic-test-api",
        ONEBOT_ACCESS_TOKEN: "synthetic-test-onebot", ONEBOT_API_BASE: `http://127.0.0.1:${oneBot.address().port}`,
        CODEX_REMOTE_CONTACT_ENGINE: "codex", CODEX_CLI_PATH: fakeCli,
        CODEX_REMOTE_CONTACT_RUNTIME_DIR: runtime, CODEX_REMOTE_CONTACT_DATA_DIR: data,
        CODEX_REMOTE_CONTACT_SHARED_DATA_DIR: sharedData, CODEX_REMOTE_CONTACT_GROUP_WORKSPACE_ROOT: join(runtime, "group-workspaces"),
        CODEX_REMOTE_CONTACT_DOCKER_PATH: fakeDocker, CODEX_REMOTE_CONTACT_QQ_FILE_STAGING_ROOT: "/tmp/codexremotecontact-qq-files/offline-context-api",
        CODEX_REMOTE_CONTACT_CODEX_MODEL: config.model, CODEX_REMOTE_CONTACT_REASONING_EFFORT: "low",
        CODEX_REMOTE_CONTACT_HA_ENABLED: "0", CODEX_REMOTE_CONTACT_PERSONA_DIR: "",
        CODEX_REMOTE_CONTACT_QZONE_POST_SCHEDULE: "", CODEX_REMOTE_CONTACT_QQ_SCHEDULE: "",
        TEST_FORBIDDEN_RPC: forbiddenPath, TEST_PRIVATE_PATH: privatePath,
        TEST_LINKS_PATH: linksPath, TEST_FAIL_MAPPING: failMappingFlag,
        TEST_DELAY_FLAG: delayFlag, TEST_DELAY_ENTERED: delayEntered }, stdio: ["ignore", "pipe", "pipe"] });
    exit = once(child, "exit");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    await waitFor(async () => {
      if (child.exitCode != null) throw new Error(`Offline gateway exited: ${output}`);
      try { return (await api("/api/state")).status === 200; } catch { return false; }
    }, `Offline gateway did not start: ${output}`);
  };
  const postLink = (body, id = PRIVATE) => api(`/api/qq/private/${id}/context-link`, body);
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  await start();
  const before = await readFile(privatePath, "utf8");
  for (const [body, id, expected] of [
    [{ groupId: GROUP }, PRIVATE, 400], [{ acknowledgeSharedContext: true }, PRIVATE, 400],
    [{ groupId: "invalid", acknowledgeSharedContext: true }, PRIVATE, 400],
    [{ groupId: FOREIGN, acknowledgeSharedContext: true }, PRIVATE, 404],
    [{ groupId: "299999999", acknowledgeSharedContext: true }, PRIVATE, 404],
    [{ groupId: GROUP, acknowledgeSharedContext: true }, "199999999", 404]
  ]) assert.equal((await postLink(body, id)).status, expected);
  assert.equal(await readFile(privatePath, "utf8"), before);
  assert.deepEqual((await readJson(linksPath)).privateGroups, {});
  const cursorsBeforeFailedBind = (await readJson(privatePath)).groups[PRIVATE];
  assert.equal(cursorsBeforeFailedBind.deferredThroughSequence, 5);
  assert.equal(cursorsBeforeFailedBind.periodicCheckedThroughSequence, 5);
  await writeFile(failMappingFlag, "fail once");
  const failedBind = await postLink({ groupId: GROUP, acknowledgeSharedContext: true });
  assert.equal(failedBind.status, 500, JSON.stringify(failedBind.body));
  assert.match(failedBind.body.error, /Synthetic mapping persistence failure/);
  assert.equal(await exists(failMappingFlag), false, "test preload must fail the real synchronous mapping commit once");
  assert.deepEqual((await readJson(linksPath)).privateGroups, {});
  const afterFailedBind = (await readJson(privatePath)).groups[PRIVATE];
  assert.equal(afterFailedBind.deferredThroughSequence, cursorsBeforeFailedBind.deferredThroughSequence);
  assert.equal(afterFailedBind.periodicCheckedThroughSequence, cursorsBeforeFailedBind.periodicCheckedThroughSequence);
  assert.equal(afterFailedBind.threadId, "parked-thread");
  assert.deepEqual(afterFailedBind.pendingMessages, pending);
  assert.equal((await readJson(groupPath)).groups[GROUP].threadId, "shared-thread");
  const linked = await postLink({ groupId: GROUP, acknowledgeSharedContext: true });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.contextLink.groupId, GROUP);
  assert.equal(linked.body.contextLink.threadId, "shared-thread");
  assert.equal(linked.body.contextLink.parkedThreadId, "parked-thread");
  assert.deepEqual(linked.body.contextQueue.linkedPrivateIds, [PRIVATE]);
  const state = (await api("/api/state")).body;
  const view = state.qq.privateChats[PRIVATE];
  assert.equal(view.threadId, "shared-thread");
  assert.equal(view.effectiveCodexConfig.reasoningEffort, "high");
  assert.equal(view.effectiveCodexConfig.contextTokenLimit, 100000);
  const parked = (await readJson(privatePath)).groups[PRIVATE];
  assert.equal(parked.threadId, "parked-thread");
  assert.deepEqual(parked.pendingMessages, pending);
  assert.equal(parked.deferredThroughSequence, 0);
  assert.equal((await readJson(groupPath)).groups[GROUP].threadId, "shared-thread");
  for (const [path, body] of [
    [`/api/qq/private/${PRIVATE}/reset`, {}],
    [`/api/qq/private/${PRIVATE}/delete`, { confirmTargetId: PRIVATE }],
    [`/api/qq/groups/${GROUP}/delete`, { confirmTargetId: GROUP }]
  ]) assert.equal((await api(path, body)).status, 409);
  const changedPermissions = await api(`/api/qq/private/${PRIVATE}/config`, {
    permissionMode: "workspaceWrite", calendarRemindersEnabled: true, homeAssistantPermission: "owner",
    speakerGreetings: config.speakerGreetings
  });
  assert.equal(changedPermissions.status, 200, JSON.stringify(changedPermissions.body));
  assert.equal(changedPermissions.body.codexConfig.permissionMode, "workspaceWrite");
  for (const key of ["model", "reasoningEffort", "contextTokenLimit"]) assert.equal(changedPermissions.body.codexConfig[key], config[key]);
  assert.deepEqual((await readJson(groupPath)).groups[BUSY_GROUP].replyFollowup, groupState.groups[BUSY_GROUP].replyFollowup,
    "busy fixture must survive the production maximum-two-minute normalization");
  const busy = await postLink({ groupId: BUSY_GROUP, acknowledgeSharedContext: true });
  assert.equal(busy.status, 409);
  assert.equal((await readJson(linksPath)).privateGroups[PRIVATE], GROUP);
  await stop();
  await start();
  assert.equal((await api("/api/state")).body.qq.privateChats[PRIVATE].contextLink.groupId, GROUP);
  const unlinked = await postLink({ groupId: null, acknowledgeSharedContext: true });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.contextLink, null);
  const independent = (await api("/api/state")).body.qq.privateChats[PRIVATE];
  assert.equal(independent.threadId, "parked-thread");
  assert.deepEqual(independent.pendingMessages, pending);
  assert.equal(independent.effectiveCodexConfig.reasoningEffort, "low");
  assert.equal((await readJson(groupPath)).groups[GROUP].threadId, "shared-thread");
  await writeFile(delayFlag, "delay");
  const binding = postLink({ groupId: GROUP, acknowledgeSharedContext: true });
  await waitFor(() => exists(delayEntered), "test preload did not intercept private save");
  const concurrentDeletes = await Promise.all([
    api(`/api/qq/groups/${GROUP}/delete`, { confirmTargetId: GROUP }),
    api(`/api/qq/private/${PRIVATE}/delete`, { confirmTargetId: PRIVATE })
  ]);
  assert.deepEqual(concurrentDeletes.map((response) => response.status), [409, 409]);
  await rm(delayFlag);
  assert.equal((await binding).status, 200);
  assert.equal((await readJson(linksPath)).privateGroups[PRIVATE], GROUP);
  assert.equal((await readJson(privatePath)).groups[PRIVATE].threadId, "parked-thread");
  assert.equal((await readJson(groupPath)).groups[GROUP].threadId, "shared-thread");
  await stop();
  assert.equal(await exists(forbiddenPath), false, "no real or mock model turn may be started");
  assert.ok(oneBotCalls.every((path) => /^\/get_(?:group_list|stranger_info|login_info|status|group_member_list|friend_list)$/u.test(path)), JSON.stringify(oneBotCalls));
});
