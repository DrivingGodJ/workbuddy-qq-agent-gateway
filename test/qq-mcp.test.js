import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleQqMcpTool } from "../src/qq/mcp-actions.js";
import { WorkBuddyClient } from "../src/workbuddy/client.js";
import { QqMessageReader } from "../src/qq/message-reader.js";
import { buildMcpTurnPrompt, buildTurnPrompt, gatewaySystemInstructions } from "../src/security/policy.js";
import { buildPrivateTurnPrompt } from "../src/security/subscription-policy.js";

const context = {
  targetType: "group",
  allowReactions: true,
  stickers: [{ id: "st_0123456789ab", usage: "开心" }],
  allowPoke: true,
  pokeSenderId: "123456789",
  allowedPokeUserIds: ["123456789"],
  allowQzonePost: false
};

test("AUTO subscription MCP advertises only scoped read-only tools", () => {
  const server = fileURLToPath(new URL("../modules/workbuddy-agent/qq-mcp-stdio.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [server, "thread-test"], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT: "http://127.0.0.1:3789/call",
      CODEX_REMOTE_CONTACT_QQ_MCP_SECRET: "test-secret",
      CODEX_REMOTE_CONTACT_QQ_MCP_SOURCE_ONLY: "1"
    },
    timeout: 3000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()).result.tools.map((tool) => tool.name), ["read_source_messages", "read_forward_messages", "read_link"]);
});

test("normal QQ MCP advertises the same complete fixed catalog for every conversation", () => {
  const server = fileURLToPath(new URL("../modules/workbuddy-agent/qq-mcp-stdio.mjs", import.meta.url));
  const list = (threadId) => {
    const result = spawnSync(process.execPath, [server, threadId], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
      encoding: "utf8", timeout: 3000,
      env: { ...process.env, CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT: "http://127.0.0.1:3789/call",
        CODEX_REMOTE_CONTACT_QQ_MCP_SECRET: "test-secret", CODEX_REMOTE_CONTACT_QQ_MCP_SOURCE_ONLY: "0" }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()).result.tools;
  };
  const groupTools = list("group-thread");
  assert.deepEqual(groupTools, list("private-thread"));
  assert.equal(groupTools.length, 23);
  for (const name of ["send_context_message", "send_file", "send_image", "recall_message", "post_qzone", "read_qzone_feeds", "engage_qzone_feed", "get_group_management", "manage_group"]) {
    assert.ok(groupTools.some((tool) => tool.name === name));
  }
  for (const name of ["propose_qzone_post", "skip_qzone_post", "read_qzone_feed_batch", "submit_qzone_decisions"]) {
    assert.equal(groupTools.some((tool) => tool.name === name), false);
  }
  const byName = Object.fromEntries(groupTools.map((tool) => [tool.name, tool]));
  assert.equal(byName.wait_for_messages.inputSchema.properties.seconds.maximum, 120);
  assert.deepEqual(byName.read_context_messages.inputSchema.properties.target_type.enum, ["group", "private"]);
  assert.equal(byName.read_context_messages.inputSchema.properties.limit.maximum, 40);
  assert.equal(byName.read_context_messages.inputSchema.additionalProperties, false);
  assert.deepEqual(byName.send_context_message.inputSchema.required, ["target_type", "target_id", "text"]);
  assert.ok(byName.read_home_devices.inputSchema.required.includes("request_message_id"));
  assert.ok(byName.control_home_device.inputSchema.required.includes("request_message_id"));
  assert.ok(byName.speak_home_speaker.inputSchema.required.includes("request_message_id"));
  assert.equal(byName.speak_home_speaker.inputSchema.properties.text.maxLength, 500);
  assert.deepEqual(byName.send_reaction.inputSchema.oneOf, [{ required: ["face"] }, { required: ["sticker_id"] }]);
  assert.equal(byName.send_message.inputSchema.properties.reply_to_message_id.pattern, "^-?[0-9]+$");
  assert.deepEqual(byName.poke_member.inputSchema.properties.user_id.oneOf[0], { const: "sender" });
  assert.match(byName.engage_qzone_feed.description, /聊天和定时动态任务使用同一工具/);
});

test("MCP transport allows a full two-minute active wait without extending ordinary calls", () => {
  const server = new URL("../modules/workbuddy-agent/qq-mcp-stdio.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    let timeoutMs;
    AbortSignal.timeout = (ms) => { timeoutMs = ms; return new AbortController().signal; };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: String(timeoutMs) }] }) });
    process.argv[2] = "thread-test";
    await import(${JSON.stringify(server)});
  `], {
    input: [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_messages", arguments: { seconds: 120 } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_messages", arguments: {} } }
    ].map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8", timeout: 3000,
    env: { ...process.env, CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT: "http://127.0.0.1:3789/call",
      CODEX_REMOTE_CONTACT_QQ_MCP_SECRET: "test-secret", CODEX_REMOTE_CONTACT_QQ_MCP_SOURCE_ONLY: "0" }
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((response) => response.result.content[0].text), ["126000", "15000"]);
});

test("stable gateway rules distinguish live MCP sends from structured AUTO and scheduled Space turns", () => {
  const rules = gatewaySystemInstructions();
  assert.match(rules, /普通聊天的 QQ 动作只通过当前可用的 qq_gateway MCP 工具/);
  assert.match(rules, /本机执行权限为只读时，仍可用获准的 QQ 工具向当前会话发文字或表情/);
  assert.match(rules, /最终文字不会代发/);
  assert.match(rules, /AUTO 订阅轮次先用 read_source_messages/);
  assert.match(rules, /由网关按结构化输出发送，不用普通聊天的 send_message/);
  assert.match(rules, /聊天和动态定时任务共用工具/);
  assert.match(rules, /定时任务.*不会预塞群聊消息，读取也不清理 pending/);
  assert.match(rules, /mcp__qq_gateway__/);
  assert.match(rules, /(?:不经|不要|不得|禁止)[^\n]*ToolSearch[^\n]*DeferExecuteTool/);
  for (const name of ["read_home_devices", "control_home_device", "speak_home_speaker"]) {
    assert.ok(rules.includes(`mcp__qq_gateway__${name}`), name);
  }
  assert.doesNotMatch(rules, /\[\[qq_/);
});

test("inline tool instructions stay in the stable system prompt rather than every chat turn", () => {
  for (const targetType of ["group", "private"]) {
    const prompt = buildMcpTurnPrompt({ targetType, sharedSystemInstructions: true });
    assert.doesNotMatch(prompt, /mcp__qq_gateway__|ToolSearch|DeferExecuteTool/);
    assert.doesNotMatch(prompt, /read_home_devices|control_home_device|speak_home_speaker/);
  }
});

test("read-only host permissions do not forbid ordinary QQ replies", () => {
  const security = { mode: "RISK_SCOPED_READ_ONLY", turnSandbox: { type: "readOnly" }, allowQqFiles: false };
  const privatePrompt = buildMcpTurnPrompt({ targetType: "private", security, sharedSystemInstructions: true });
  const readResult = buildPrivateTurnPrompt([], [], { userId: "12345", security, includeResponseInstruction: false });
  const groupPrompt = buildMcpTurnPrompt({ targetType: "group", security, sharedSystemInstructions: true });
  for (const prompt of [privatePrompt, readResult, groupPrompt]) {
    assert.match(prompt, /本机执行权限只读/);
    assert.match(prompt, /QQ 工具.*发送文字或表情/);
    assert.doesNotMatch(prompt, /不得修改外部状态/);
  }
  assert.match(privatePrompt, /不能发送本机文件、图片/);
  assert.match(privatePrompt, /私聊不能戳一戳/);
});

test("QQ MCP exposes current real reactions and queues face, sticker and current-group poke", () => {
  const queued = [];
  const call = (name, args = {}) => handleQqMcpTool({ name, args, context, queued });
  const catalog = JSON.parse(call("list_reactions").content[0].text);
  assert.equal(catalog.stickers[0].usage, "开心");
  assert.ok(catalog.faces.includes("微笑"));
  assert.equal(call("send_reaction", { face: "微笑" }).isError, false);
  assert.equal(call("send_reaction", { sticker_id: "st_0123456789ab" }).isError, false);
  assert.equal(call("poke_member", { user_id: "sender" }).isError, false);
  assert.deepEqual(queued.map((item) => item.directive), [
    "[[qq_face:微笑]]", "[[qq_sticker:st_0123456789ab]]", "[[qq_poke:123456789]]"
  ]);
  assert.equal(call("send_reaction", { sticker_id: "st_0123456789ab" }).isError, true);
});

test("QQ MCP rejects unknown sticker, cross-group poke and untrusted Qzone publishing", () => {
  const queued = [];
  const call = (name, args = {}) => handleQqMcpTool({ name, args, context, queued });
  assert.equal(call("send_reaction", { sticker_id: "st_ffffffffffff" }).isError, true);
  assert.equal(call("poke_member", { user_id: "987654321" }).isError, true);
  assert.equal(call("post_qzone", { content: "假动态" }).isError, true);
  assert.deepEqual(queued, []);
  assert.match(call("submit_qzone_decisions", { actions: [] }).content[0].text, /当前轮次不支持 QQ MCP 工具 submit_qzone_decisions/);
});

test("QQ MCP queues one OWNER post, forbids scheduled images, and denies inactive turns", () => {
  const queued = [];
  const owner = { ...context, allowQzonePost: true };
  const call = (name, args = {}, activeContext = owner) => handleQqMcpTool({ name, args, context: activeContext, queued });
  assert.equal(call("post_qzone", { content: "今晚散步" }).isError, false);
  assert.equal(queued[0].directive, '[[qq_zone_post:{"content":"今晚散步"}]]');
  assert.equal(call("post_qzone", { content: "又一条" }).isError, true);
  assert.equal(call("send_reaction", { face: "微笑" }, null).isError, true);
  assert.equal(handleQqMcpTool({ name: "post_qzone", args: { content: "有图", images: ["/tmp/test.jpg"] },
    context: { ...owner, scheduledQzonePost: true }, queued: [] }).isError, true);
});

test("QQ MCP requires the current snapshot before queuing a text reply and preserves it until completion", () => {
  const queued = [];
  const current = { ...context, allowMessage: true, requireRead: true, readContent: "[10:00] OWNER: 新消息" };
  const call = (name, args = {}) => handleQqMcpTool({ name, args, context: current, queued });
  assert.equal(call("send_message", { text: "收到" }).isError, true);
  assert.equal(call("send_reaction", { face: "微笑" }).isError, true);
  assert.equal(call("read_messages").content[0].text, "[10:00] OWNER: 新消息");
  assert.equal(call("send_message", { text: "收到" }).isError, false);
  assert.equal(call("send_message", { text: "再发一次" }).isError, true);
  assert.equal(queued[0].text, "收到");
  assert.equal(call("send_message", { text: "[[qq_poke:123456789]]" }).isError, true);
});

test("AUTO MCP exposes only its claimed source and rejects unrelated QQ actions", () => {
  const source = { sourceGroupId: "54321", sourceReadContent: "【学院群】明天开会", requireSourceRead: true, sourceReadCalled: false };
  const read = handleQqMcpTool({ name: "read_source_messages", context: source });
  assert.deepEqual(JSON.parse(read.content[0].text), { sourceGroupId: "54321", content: "【学院群】明天开会" });
  assert.equal(source.sourceReadCalled, true);
  assert.equal(handleQqMcpTool({ name: "read_messages", context: source }).isError, true);
  assert.equal(handleQqMcpTool({ name: "send_message", args: { text: "不得向来源群发" }, context: source }).isError, true);
  assert.equal(handleQqMcpTool({ name: "read_source_messages", context: {} }).isError, true);
  const stopped = { sourceGroupId: "54321", sourceReadContent: "不应读取", sourceReadCalled: false, canRead: () => false };
  assert.equal(handleQqMcpTool({ name: "read_source_messages", context: stopped }).isError, true);
  assert.equal(stopped.sourceReadCalled, false);
});

test("compact MCP prompt keeps authority outside the fetched message body", () => {
  const security = { mode: "GROUP_SESSION_FULL_ACCESS", turnSandbox: { type: "dangerFullAccess" } };
  const prompt = buildMcpTurnPrompt({ security, trigger: { reason: "mention" } });
  const snapshot = buildTurnPrompt([{ displayTime: "10:00", senderName: "测试", senderId: "123456789", text: "消息正文", trust: "UNTRUSTED" }], { security });
  assert.match(prompt, /GROUP_SESSION_FULL_ACCESS/);
  assert.doesNotMatch(prompt, /【触发方式】/);
  assert.match(prompt, /read_messages/);
  assert.match(prompt, /要说文字时必须调用 send_message/);
  assert.match(prompt, /预读取结果/);
  assert.match(prompt, /不必重复空读/);
  assert.doesNotMatch(prompt, /消息正文/);
  assert.match(snapshot, /消息正文/);
  assert.doesNotMatch(snapshot, /【触发方式】/);
  const shared = buildMcpTurnPrompt({ security, trigger: { reason: "mention" }, sharedSystemInstructions: true });
  assert.match(shared, /GROUP_SESSION_FULL_ACCESS/);
  assert.doesNotMatch(shared, /【触发方式】/);
  assert.doesNotMatch(shared, /wait_for_messages|send_message|read_messages/);
});

test("mentions and pokes remain in the message snapshot without a separate trigger label", () => {
  const messages = [
    { displayTime: "10:00", senderName: "甲", senderId: "123456789", text: "@老代 你好", trust: "UNTRUSTED" },
    { displayTime: "10:01", senderName: "乙", senderId: "987654321", text: "戳了戳老代", trust: "UNTRUSTED", eventType: "poke" }
  ];
  const prompt = buildTurnPrompt(messages, { trigger: { reason: "poke" }, includeResponseInstruction: false });
  assert.match(prompt, /@老代 你好/);
  assert.match(prompt, /戳了戳老代/);
  assert.doesNotMatch(prompt, /【触发方式】|本轮由群成员戳一戳唤醒/);
});

test("WorkBuddy prefetches live messages before starting the model and does not bypass read validation", async () => {
  const client = new WorkBuddyClient();
  client.ensureProcess = async () => {};
  let started;
  let startReceived;
  const received = new Promise((resolve) => { startReceived = resolve; });
  client.request = async (method, params) => {
    assert.equal(method, "turn/start");
    started = params;
    startReceived();
    return { turn: { id: "prefetch-turn" } };
  };
  const current = { liveMode: true, requireRead: true, readCalled: false, lastReadSequence: 0, actionCount: 0,
    async liveTool(name) {
      assert.equal(name, "read_messages");
      this.readCalled = true;
      this.lastReadSequence = 7;
      return { isError: false, content: [{ type: "text", text: "[UNTRUSTED]: 当前新消息" }] };
    } };
  const result = client.runTurn({ groupId: "test", threadId: "thread-test", prompt: "当前任务", workingMode: "ask", qqToolContext: current });
  await received;
  // request() resumes first, registering the active turn before completion.
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(started.prompt, /当前新消息/);
  assert.match(started.prompt, /网关预读取结果/);
  assert.equal(started.workingMode, "agent", "legacy callers cannot select another working mode");
  assert.equal(current.lastReadSequence, 7);
  client.handleMessage({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "prefetch-turn", status: "completed" } } });
  assert.equal((await result).text, "");

  const failed = { liveMode: true, requireRead: true, readCalled: false,
    liveTool: async () => ({ isError: true, content: [{ type: "text", text: "读取失败" }] }) };
  await assert.rejects(() => client.runTurn({ groupId: "test", threadId: "thread-test", prompt: "当前任务", qqToolContext: failed }), /读取失败/);
  assert.equal(client.activeByThread.size, 0);
});

test("WorkBuddy timeout keeps the local writer until bridge interruption is acknowledged", async () => {
  const client = new WorkBuddyClient();
  let acknowledge;
  const interrupted = new Promise((resolve) => { acknowledge = resolve; });
  client.request = async (method) => {
    assert.equal(method, "turn/interrupt");
    await interrupted;
    return { ok: true };
  };
  let rejected;
  const completed = new Promise((resolve) => { rejected = resolve; });
  const active = {
    groupId: "group-test", threadId: "thread-test", turnId: "turn-test",
    cancelRequested: false, timeout: null, reject: rejected, resolve: rejected
  };
  client.activeByThread.set(active.threadId, active);
  client.activeByTurn.set(active.turnId, active);
  client.activeByGroup.set(active.groupId, active);
  const timingOut = client.timeoutTurn(active);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.cancelRequested, true);
  assert.equal(client.activeByGroup.get(active.groupId), active);
  acknowledge();
  await timingOut;
  assert.match((await completed).message, /timed out/);
  assert.equal(client.activeByGroup.has(active.groupId), false);
});

test("WorkBuddy genuine progress keeps a long-running turn alive without a total-duration timer", async () => {
  const client = new WorkBuddyClient({ idleTimeoutMs: 1000, timeoutMs: 10_000 });
  client.ensureProcess = async () => {};
  let interrupts = 0;
  client.request = async (method) => {
    if (method === "turn/start") return { turn: { id: "active-turn" } };
    assert.equal(method, "turn/interrupt");
    interrupts++;
    return { ok: true };
  };
  const running = client.runTurn({ groupId: "active-group", threadId: "active-thread", prompt: "test", prefetchQqMessages: false });
  const rejected = assert.rejects(running, /长时间无进展.*待处理消息仍保留/);
  await new Promise((resolve) => setImmediate(resolve));
  const active = client.activeByTurn.get("active-turn");
  assert.ok(active);
  assert.equal(active.timeout, null, "there is no absolute whole-turn timeout");
  const initialWatchdog = active.progressTimeout;
  client.handleMessage({ method: "turn/progress", params: { threadId: "other-thread", turnId: "active-turn", stage: "tool" } });
  assert.equal(active.progressTimeout, initialWatchdog, "another thread cannot refresh the watchdog");
  client.handleMessage({ method: "turn/progress", params: { threadId: "active-thread", turnId: "active-turn", stage: "tool" } });
  const progressWatchdog = active.progressTimeout;
  assert.notEqual(progressWatchdog, initialWatchdog, "reasoning and tool progress refresh the watchdog");
  client.handleMessage({ method: "item/agentMessage/delta", params: {
    threadId: "active-thread", turnId: "active-turn", delta: "还在处理"
  } });
  assert.notEqual(active.progressTimeout, progressWatchdog, "generated text also refreshes the watchdog");
  assert.equal(interrupts, 0);
  await client.timeoutTurn(active, "WorkBuddy 长时间无进展；已中断本轮，待处理消息仍保留");
  await rejected;
  assert.equal(interrupts, 1);
  assert.equal(client.activeByGroup.size, 0);
});

test("WorkBuddy loopback MCP requires its private token and returns queued actions to the existing delivery parser", async () => {
  const client = new WorkBuddyClient();
  await client.ensureMcpGateway();
  try {
    const send = (secret) => fetch(client.mcpEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qq-mcp-secret": secret },
      body: JSON.stringify({ threadId: "thread-test", name: "send_reaction", arguments: { face: "微笑" } })
    });
    assert.equal((await send("not-the-secret")).status, 403);
    const answer = new Promise((resolve) => {
      const active = {
        groupId: "group-test", threadId: "thread-test", turnId: "turn-test",
        text: "", qqToolContext: context, mcpActions: [],
        timeout: null, resolve, reject: resolve
      };
      client.activeByThread.set(active.threadId, active);
      client.activeByTurn.set(active.turnId, active);
      client.activeByGroup.set(active.groupId, active);
    });
    const queued = await (await send(client.mcpSecret)).json();
    assert.equal(queued.isError, false);
    client.handleMessage({ method: "turn/completed", params: {
      threadId: "thread-test", turn: { id: "turn-test", status: "completed", items: [] }
    } });
    assert.equal((await answer).text, "[[qq_face:微笑]]");
  } finally {
    await client.close();
  }
});

test("WorkBuddy rejects an unread compact turn and uses queued text instead of model acknowledgement", async () => {
  const client = new WorkBuddyClient();
  await client.ensureMcpGateway();
  try {
    const displayed = [];
    const makeActive = (turnId) => new Promise((resolve) => {
      const active = {
        groupId: "group-test", threadId: "thread-test", turnId,
        text: "已发送，不要重复这句", qqToolContext: { ...context, allowMessage: true, requireRead: true, readContent: "[10:00] 新消息" },
        mcpActions: [], timeout: null, resolve, reject: resolve, onDelta: (_delta, current) => displayed.push(current)
      };
      client.activeByThread.set(active.threadId, active);
      client.activeByTurn.set(active.turnId, active);
      client.activeByGroup.set(active.groupId, active);
    });
    const unread = makeActive("unread-turn");
    client.handleMessage({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "unread-turn", status: "completed" } } });
    assert.match((await unread).message, /did not read/);
    const answered = makeActive("read-turn");
    const send = (name, args = {}) => fetch(client.mcpEndpoint, {
      method: "POST", headers: { "content-type": "application/json", "x-qq-mcp-secret": client.mcpSecret },
      body: JSON.stringify({ threadId: "thread-test", name, arguments: args })
    });
    assert.equal((await (await send("read_messages")).json()).isError, false);
    assert.equal((await (await send("send_message", { text: "真正发出的内容" })).json()).isError, false);
    assert.deepEqual(displayed, ["真正发出的内容"]);
    client.handleMessage({ method: "item/agentMessage/delta", params: { threadId: "thread-test", turnId: "read-turn", delta: "模型补充的话" } });
    assert.deepEqual(displayed, ["真正发出的内容"]);
    client.handleMessage({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "read-turn", status: "completed" } } });
    assert.equal((await answered).text, "真正发出的内容");
  } finally {
    await client.close();
  }
});

test("WorkBuddy rejects AUTO completion unless the source was read through MCP", async () => {
  const client = new WorkBuddyClient();
  await client.ensureMcpGateway();
  try {
    const makeActive = (turnId) => new Promise((resolve) => {
      const active = {
        groupId: "group-test", threadId: "thread-test", turnId, text: "模型声称已总结",
        qqToolContext: { sourceGroupId: "54321", sourceReadContent: "通知正文", requireSourceRead: true, sourceReadCalled: false },
        mcpActions: [], timeout: null, resolve, reject: resolve
      };
      client.activeByThread.set(active.threadId, active);
      client.activeByTurn.set(active.turnId, active);
      client.activeByGroup.set(active.groupId, active);
    });
    const complete = (turnId) => client.handleMessage({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: turnId, status: "completed" } } });
    const unread = makeActive("unread-source");
    complete("unread-source");
    assert.match((await unread).message, /did not read the subscribed source/);

    const read = makeActive("read-source");
    const response = await fetch(client.mcpEndpoint, {
      method: "POST", headers: { "content-type": "application/json", "x-qq-mcp-secret": client.mcpSecret },
      body: JSON.stringify({ threadId: "thread-test", name: "read_source_messages", arguments: {} })
    });
    assert.equal((await response.json()).isError, false);
    complete("read-source");
    assert.equal((await read).text, "模型声称已总结");
  } finally {
    await client.close();
  }
});

test("AUTO resource tools are scoped to its one source, require source read and cannot send", async () => {
  const client = new WorkBuddyClient();
  await client.ensureMcpGateway();
  try {
    const reader = new QqMessageReader({ oneBot: { getForwardMessages: async () => [{ user_id: 123456789, message: [{ type: "text", data: { text: "通知正文" } }] }] } });
    reader.capture([{ messageId: "source-1", attachments: [{ type: "forward", fileId: "known" }] }]);
    let enabled = true;
    const source = { sourceGroupId: "54321", sourceReadContent: "来源消息", requireSourceRead: true,
      sourceReadCalled: false, messageReader: reader, canRead: () => enabled };
    client.activeByThread.set("source-thread", { qqToolContext: source, mcpActions: [] });
    const send = async (name, args = {}) => (await fetch(client.mcpEndpoint, {
      method: "POST", headers: { "content-type": "application/json", "x-qq-mcp-secret": client.mcpSecret },
      body: JSON.stringify({ threadId: "source-thread", name, arguments: args })
    })).json();
    assert.equal((await send("read_forward_messages", { message_id: "source-1" })).isError, true);
    assert.equal((await send("read_source_messages")).isError, false);
    assert.equal((await send("read_forward_messages", { message_id: "source-1" })).isError, false);
    assert.equal((await send("read_forward_messages", { message_id: "another-source" })).isError, true);
    assert.equal((await send("send_message", { text: "不能往源群发" })).isError, true);
    enabled = false;
    assert.equal((await send("read_forward_messages", { message_id: "source-1" })).isError, true);
    client.activeByThread.delete("source-thread");
  } finally { await client.close(); }
});
