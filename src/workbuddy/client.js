import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { handleQqMcpTool } from "../qq/mcp-actions.js";
import { prepareLiveConversationPrompt } from "../qq/live-conversation.js";
import { TurnDiagnostics } from "./turn-diagnostics.js";

/**
 * WorkBuddy 引擎客户端
 *
 * 与 src/codex/client.js 同构：同样的 JSON-RPC over stdio、
 * 同样的公开方法（startThread / resumeThread / runTurn / interruptGroup /
 * deleteThread / activeGroups / listModels / listLoadedThreads / close），
 * 只是把对端从 `codex app-server` 换成 Python 桥 `modules/workbuddy-agent/bridge.py`。
 *
 * 之所以走「Node -> Python 桥 -> CodeBuddy Agent SDK」：
 *   1. 网关保持零依赖（SDK 只需要装在桥自己的 venv 里）
 *   2. 复用网关已有的 app-server 协议抽象，改动面最小
 *   3. Node 版 SDK 在本机 initialize 会超时（实测两版 CLI 都卡住），
 *      Python SDK 0.3.261 实测四项全通（往返 / 会话隔离 / 续接 / 中断）
 */

export class WorkBuddyResumeError extends Error {
  constructor(threadId, cause) {
    super(`Unable to resume persistent WorkBuddy session ${threadId}: ${cause?.message || cause}`);
    this.name = "WorkBuddyResumeError";
    this.code = "THREAD_RESUME_FAILED";
    this.threadId = threadId;
    this.cause = cause;
  }
}

export class WorkBuddyTurnCancelledError extends Error {
  constructor() {
    super("WorkBuddy turn was cancelled");
    this.name = "WorkBuddyTurnCancelledError";
    this.code = "CANCELLED";
  }
}

const MODULE_ROOT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "modules",
  "workbuddy-agent"
);

const DEFAULT_BRIDGE = path.join(MODULE_ROOT, "bridge.py");

/**
 * 桥进程必须跑在装了 codebuddy-agent-sdk 的解释器上，系统 python3 没有这个依赖。
 * 这里直接默认指向模块自带的 venv（存在就用），这样 launchd 环境下不必再靠
 * `config/qq-only.env` 注入 CODEX_REMOTE_CONTACT_WB_PYTHON —— 那个文件在宿主侧
 * 会以 EPERM 读取失败，导致 run-qq-only.command 的 `source` 直接退出。
 */
const DEFAULT_VENV_PYTHON = path.join(MODULE_ROOT, ".venv", "bin", "python");

/**
 * WorkBuddy 的模型命名空间和 Codex 完全不同。网关持久化的会话里可能还留着
 * gpt-5.x / o3 这类 Codex 名字（settings 层的回退只覆盖全局默认，覆盖不到每个
 * 会话自己的 codexConfig.model），直接透传会让 CLI 报「模型不可用」。
 * 识别到 Codex 名字就丢掉，交给 CLI 用默认模型。
 */
const CODEX_MODEL_PATTERN = /^(gpt-|o[0-9])/i;

function normalizeModel(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value || value === "N/A") return null;
  return CODEX_MODEL_PATTERN.test(value) ? null : value;
}

// Unknown tools are deliberately not replay-safe, including Bash and subagents.
const REPLAY_SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch", "ToolSearch",
  ...["read_messages", "read_context_messages", "read_source_messages", "read_forward_messages", "read_link",
    "list_reactions", "read_qzone_feeds", "get_group_management", "read_home_devices",
    "wait_for_messages", "end_conversation"].map((name) => `mcp__qq_gateway__${name}`)
]);

function replaySafeTool(name) {
  return REPLAY_SAFE_TOOLS.has(String(name));
}

function replaySafeTurn(active, released, toolAttempts) {
  return released === true && Array.isArray(toolAttempts)
    && toolAttempts.every((name) => typeof name === "string" && replaySafeTool(name))
    && active.toolTracking && !active.sideEffectsPossible && !active.compacting
    && !active.qqToolContext?.failed && !active.qqToolContext?.ended
    && !active.qqToolContext?.actionCount && !active.mcpActions?.length;
}

export class WorkBuddyClient {
  constructor({
    python,
    bridgePath = process.env.CODEX_REMOTE_CONTACT_WB_BRIDGE || DEFAULT_BRIDGE,
    cwd,
    model,
    effort,
    systemPrompt = "",
    timeoutMs = 10 * 60 * 1000,
    idleTimeoutMs = 3 * 60 * 1000,
    compactionTimeoutMs = 6 * 60 * 1000,
    recoveryDelayMs = 15_000,
    env = process.env,
    onTurnEvent = () => {},
  } = {}) {
    this.python =
      python ||
      process.env.CODEX_REMOTE_CONTACT_WB_PYTHON ||
      (existsSync(DEFAULT_VENV_PYTHON) ? DEFAULT_VENV_PYTHON : "python3");
    this.bridgePath = bridgePath;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.systemPrompt = String(systemPrompt || "").trim();
    this.timeoutMs = timeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.compactionTimeoutMs = compactionTimeoutMs;
    this.recoveryDelayMs = recoveryDelayMs;
    this.recoveries = new Map();
    this.env = env;
    this.onTurnEvent = onTurnEvent;
    this.diagnostics = new TurnDiagnostics();
    this.child = null;
    this.startPromise = null;
    this.buffer = "";
    this.stderr = "";
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.activeByThread = new Map();
    this.activeByTurn = new Map();
    this.activeByGroup = new Map();
    this.initialized = false;
    this.mcpSecret = randomBytes(32).toString("hex");
    this.mcpGateway = null;
    this.mcpEndpoint = null;
    this.supportsQqMcp = true;
    this.supportsSystemPrompt = true;
  }

  /**
   * 给桥进程准备一份「白名单」环境。
   *
   * 为什么是白名单而不是只剥 CODEBUDDY_/WORKBUDDY_/ACC_ 前缀：
   * 宿主注入的变量里有一大批不带这些前缀的，例如 CLIENT_INFO_IDE_TYPE /
   * CLIENT_INFO_PRODUCT_VERSION / CLIENT_INFO_USER_AGENT_EXTENSION / CLAUDE_SESSION_ID /
   * ELECTRON_RUN_AS_NODE。带着它们，无头 CLI 会误判自己跑在 IDE 宿主里，
   * 启动流程卡死、永不读 stdin，SDK 的 initialize 控制请求 60s/180s 都等不到回应。
   * 实测白名单化后连续 3/3 全通、每轮 6~8s。
   *
   * 代理变量默认不放行（宿主代理端口随会话轮换，长命子进程会抓到死端口）；
   * 需要的话用 WB_AGENT_ENV_KEEP=HTTP_PROXY,HTTPS_PROXY 显式放行。
   * PATH 里必须包含 node —— CLI 是 #!/usr/bin/env node 脚本。
   */
  childEnv() {
    const extra = String(this.env.WB_AGENT_ENV_KEEP || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const whitelist = new Set([
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR",
      "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING", "TZ", "PWD",
      "WB_AGENT_CLI", "WB_AGENT_ENV_KEEP", "WB_AGENT_NODE_DIR", "WB_AGENT_FULL_ACCESS_ROOTS",
      ...extra
    ]);
    const cleaned = {};
    for (const [key, value] of Object.entries(this.env)) {
      if (whitelist.has(key)) cleaned[key] = value;
    }
    const nodeDir = this.env.WB_AGENT_NODE_DIR || path.dirname(process.execPath);
    const existing = cleaned.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
    const parts = existing.split(":").filter(Boolean);
    for (const dir of [nodeDir, "/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!parts.includes(dir)) parts.unshift(dir);
    }
    cleaned.PATH = parts.join(":");
    if (this.mcpEndpoint) {
      cleaned.CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT = this.mcpEndpoint;
      cleaned.CODEX_REMOTE_CONTACT_QQ_MCP_SECRET = this.mcpSecret;
    }
    return cleaned;
  }

  async ensureMcpGateway() {
    if (this.mcpGateway) return;
    const server = createServer(async (request, response) => {
      const supplied = Buffer.from(String(request.headers["x-qq-mcp-secret"] || ""));
      const expected = Buffer.from(this.mcpSecret);
      if (request.method !== "POST" || request.url !== "/call" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(403).end();
        return;
      }
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 64_000) throw new Error("MCP request too large");
        }
        const input = JSON.parse(body);
        const active = this.activeByThread.get(String(input.threadId || ""));
        // Claim the risk before dispatch, even if the request later times out or
        // its result is lost. A missing receipt must never mean "safe to replay".
        if (active && !active.cancelRequested && !replaySafeTool(`mcp__qq_gateway__${input.name}`)) {
          active.sideEffectsPossible = true;
        }
        let result;
        if (!active || active.cancelRequested) {
          result = { isError: true, content: [{ type: "text", text: "当前 WorkBuddy 会话没有可用的 QQ 轮次。" }] };
        } else if (active.qqToolContext?.liveMode) {
          this.reportProgress(active, "tool", input.name);
          const run = () => active.qqToolContext.liveTool(input.name, input.arguments || {}, active);
          active.mcpChain = active.mcpChain.then(run, run);
          result = await active.mcpChain;
        } else if (["read_forward_messages", "read_link"].includes(input.name) && active.qqToolContext?.messageReader) {
          this.reportProgress(active, "tool", input.name);
          result = active.qqToolContext.sourceReadCalled
            ? await active.qqToolContext.messageReader.callTool(input.name, input.arguments || {}, {
                shouldStop: () => active.cancelRequested || active.qqToolContext.canRead?.() === false
              })
            : { isError: true, content: [{ type: "text", text: "请先调用 read_source_messages 读取本轮唯一通知来源。" }] };
        } else {
          if (active) this.reportProgress(active, "tool", input.name);
          result = handleQqMcpTool({ name: input.name, args: input.arguments, context: active.qqToolContext, queued: active.mcpActions });
        }
        if (active && !active.qqToolContext?.liveMode && !result.isError && input.name === "send_message") {
          const queuedMessage = active.mcpActions.find((action) => action.kind === "message");
          if (queuedMessage) active.onDelta?.(queuedMessage.text, queuedMessage.text);
        }
        if (active && !active.cancelRequested) {
          this.reportProgress(active, "waiting_model");
          this.touchTurn(active);
        }
        const payload = JSON.stringify(result);
        if (!response.destroyed && !response.writableEnded) response.writeHead(200, { "content-type": "application/json" }).end(payload);
      } catch (error) {
        if (response.headersSent && !response.writableEnded) response.destroy();
        if (!response.destroyed && !response.writableEnded && !response.headersSent) response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
          isError: true, content: [{ type: "text", text: String(error.message || error) }]
        }));
      }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      this.mcpGateway = server;
      this.mcpEndpoint = `http://127.0.0.1:${server.address().port}/call`;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async ensureProcess() {
    if (this.child && this.child.exitCode == null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    await this.ensureMcpGateway();
    this.buffer = "";
    this.stderr = "";
    this.initialized = false;
    const child = spawn(this.python, [this.bridgePath], {
      cwd: this.cwd,
      env: this.childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const message = String(chunk || "");
      this.stderr = (this.stderr + message).slice(-4000);
      const trimmed = message.trim();
      if (trimmed) console.warn(`WorkBuddy bridge: ${trimmed.slice(-2000)}`);
    });
    child.on("error", (error) => this.handleProcessFailure(error));
    child.on("close", (code, signal) => {
      this.handleProcessFailure(
        new Error(
          `WorkBuddy bridge exited${code == null ? "" : ` with ${code}`}${signal ? ` (${signal})` : ""}` +
            (this.stderr ? ` :: ${this.stderr.slice(-500)}` : "")
        )
      );
      this.child = null;
    });
    const info = await this.request("initialize", { cwd: this.cwd }, 60_000);
    this.initialized = true;
    this.bridgeInfo = info;
  }

  async startThread({
    threadId = null,
    model = this.model,
    effort = this.effort,
    contextTokenLimit = "auto",
    cwd = null,
    threadSandbox = "readOnly",
    ephemeral = false
  } = {}) {
    await this.ensureProcess();
    const response = await this.request("thread/start", {
      threadId: threadId || undefined,
      cwd: cwd || this.cwd,
      model: normalizeModel(model),
      // effort 必须在建会话时就传：桥里它是 CLI 启动参数，轮次阶段变更会触发
      // client 重建，第一轮就重建是「空回复」的来源之一
      effort: effort || null,
      contextTokenLimit,
      workingMode: "agent",
      sandbox: threadSandbox,
      ephemeral: Boolean(ephemeral),
      systemPrompt: ephemeral ? "" : this.systemPrompt,
    });
    const createdThreadId = response?.thread?.id;
    if (!createdThreadId) throw new Error("WorkBuddy bridge did not return a thread id");
    return String(createdThreadId);
  }

  setSystemPrompt(value) {
    this.systemPrompt = String(value || "").trim();
  }

  async resumeThread(threadId, {
    threadSandbox = "readOnly",
    model = this.model,
    effort = this.effort,
    contextTokenLimit = "auto",
    cwd = null
  } = {}) {
    await this.ensureProcess();
    try {
      await this.request("thread/resume", {
        threadId,
        cwd: cwd || this.cwd,
        model: normalizeModel(model),
        effort: effort || null,
        threadSandbox,
        contextTokenLimit,
        workingMode: "agent",
        systemPrompt: this.systemPrompt,
      });
    } catch (error) {
      throw new WorkBuddyResumeError(threadId, error);
    }
    return threadId;
  }

  async runTurn(request) {
    if (this.recoveries.has(String(request.threadId))
      || [...this.recoveries.values()].some((item) => item.groupId === String(request.groupId))) {
      throw new Error("WorkBuddy target already has a queued recovery");
    }
    // Read once and keep the submitted envelope for a safe reconnect. Reusing
    // only the original task would lose its prefetch once readCalled is true.
    const prepared = request.prefetchQqMessages === false ? request : {
      ...request,
      prompt: await prepareLiveConversationPrompt(request.qqToolContext, request.prompt),
      prefetchQqMessages: false,
    };
    try {
      return await this.runSingleTurn(prepared);
    } catch (error) {
      // One continuation inside the original queued job, never a new session or
      // a concurrent writer. All side-effecting/uncertain turns fail closed.
      const context = request.qqToolContext;
      if (!context || !["WORKBUDDY_IDLE_TIMEOUT", "WORKBUDDY_TRANSIENT_UPSTREAM"].includes(error.code) || !error.safeToRetry
        || context.failed || context.ended || context.canRead?.() === false) throw error;
      const key = String(request.threadId);
      const recovery = { groupId: String(request.groupId), controller: new AbortController() };
      this.recoveries.set(key, recovery);
      this.diagnostics.progress(key, "recovering");
      this.onTurnEvent({ type: "agent-recovering", groupId: recovery.groupId, threadId: key, at: new Date().toISOString() });
      try {
        await pause(this.recoveryDelayMs, undefined, { signal: recovery.controller.signal });
        if (context.canRead?.() === false || context.failed || context.ended) throw new WorkBuddyTurnCancelledError();
        return await this.runSingleTurn({ ...prepared, refreshClientBeforeTurn: true,
          recoverySignal: recovery.controller.signal });
      } catch (nextError) {
        if (recovery.controller.signal.aborted) throw new WorkBuddyTurnCancelledError();
        throw nextError;
      } finally {
        if (this.recoveries.get(key) === recovery) this.recoveries.delete(key);
      }
    }
  }

  async runSingleTurn({
    groupId, threadId, prompt, imagePaths = [], turnSandbox = { type: "readOnly" },
    model = this.model, effort = this.effort, contextTokenLimit = "auto",
    cwd = null, outputSchema = null, qqToolContext = null, onDelta = null,
    prefetchQqMessages = true, refreshClientBeforeTurn = false, turnTimeoutMs = this.timeoutMs,
    recoverySignal = null,
  }) {
    if (recoverySignal?.aborted) throw new WorkBuddyTurnCancelledError();
    await this.ensureProcess();
    if (this.activeByThread.has(String(threadId))) {
      throw new Error(`WorkBuddy thread ${threadId} already has a running turn`);
    }
    if (this.activeByGroup.has(String(groupId))) {
      throw new Error(`QQ group ${groupId} already has a running turn`);
    }
    // Avoid spending one model request merely asking for the first page. This
    // calls the same scoped reader and advances exactly the same read cutoff;
    // delivery, cleanup and subsequent autonomous MCP reads stay unchanged.
    if (prefetchQqMessages) prompt = await prepareLiveConversationPrompt(qqToolContext, prompt);
    if (recoverySignal?.aborted) throw new WorkBuddyTurnCancelledError();
    this.diagnostics.start(String(threadId), { prompt, model, groupId: String(groupId), imagePaths });
    this.onTurnEvent({ type: "agent-input", threadId: String(threadId), groupId: String(groupId) });
    const response = await this.request("turn/start", {
      threadId,
      groupId: String(groupId),
      prompt,
      imagePaths,
      model: normalizeModel(model),
      effort: effort || null,
      contextTokenLimit,
      workingMode: "agent",
      cwd,
      outputSchema,
      refreshClientBeforeTurn: Boolean(refreshClientBeforeTurn),
      sourceReadOnly: Boolean(qqToolContext?.requireSourceRead),
      systemPrompt: /^(?:sticker-(?:label|prune)|persona-style)-/u.test(String(threadId)) ? "" : this.systemPrompt,
      turnSandbox,
    }).catch((error) => {
      this.diagnostics.finish(String(threadId), error);
      this.onTurnEvent({ type: "agent-finished", groupId: String(groupId), threadId: String(threadId) });
      throw error;
    });
    const turnId = response?.turn?.id;
    if (!turnId) {
      const error = new Error("WorkBuddy bridge did not return a turn id");
      this.diagnostics.finish(String(threadId), error);
      this.onTurnEvent({ type: "agent-finished", groupId: String(groupId), threadId: String(threadId) });
      throw error;
    }
    if (recoverySignal?.aborted) {
      await this.request("turn/interrupt", { threadId, turnId }, 30_000);
      throw new WorkBuddyTurnCancelledError();
    }

    return new Promise((resolve, reject) => {
      const active = {
        groupId: String(groupId),
        threadId: String(threadId),
        turnId: String(turnId),
        text: "",
        onDelta,
        resolve,
        reject,
        compacted: false,
        compacting: false,
        compactionDeadlineAt: null,
        cancelRequested: false,
        qqToolContext,
        mcpActions: [],
        mcpChain: Promise.resolve(),
        timeout: null,
        silenceLimitMs: Math.max(1, Number(turnTimeoutMs) || this.timeoutMs),
        progressTimeout: null,
        timeoutInProgress: false,
        toolTracking: response.turn.toolTracking === true,
        sideEffectsPossible: false,
      };
      this.activeByThread.set(active.threadId, active);
      this.activeByTurn.set(active.turnId, active);
      this.activeByGroup.set(active.groupId, active);
      this.touchTurn(active);
    });
  }

  touchTurn(active) {
    if (!active || !this.activeByTurn.has(active.turnId) || active.timeoutInProgress) return;
    clearTimeout(active.progressTimeout);
    const compacting = Boolean(active.compacting);
    const normalDelay = Math.max(1, Math.min(
      Number(this.idleTimeoutMs) || 3 * 60 * 1000,
      Number(active.silenceLimitMs) || this.timeoutMs
    ));
    const delay = compacting
      ? Math.max(1, Number(active.compactionDeadlineAt) - Date.now())
      : normalDelay;
    active.progressTimeout = setTimeout(() => {
      const reason = compacting
        ? "WorkBuddy 上下文压缩超时；已中断本轮，待处理消息仍保留"
        : "WorkBuddy 长时间无进展；已中断本轮，待处理消息仍保留";
      this.timeoutTurn(active, reason)
        .catch((error) => this.finishTurn(active, error));
    }, delay);
    active.progressTimeout.unref?.();
  }

  reportProgress(active, stage, toolName = null) {
    this.diagnostics.progress(active.threadId, stage, toolName);
    this.onTurnEvent({ type: "agent-progress", groupId: active.groupId, threadId: active.threadId, stage });
  }

  async timeoutTurn(active, reason = "WorkBuddy turn timed out") {
    if (!this.activeByTurn.has(active.turnId) || active.timeoutInProgress) return;
    active.timeoutInProgress = true;
    active.timeoutReason = reason;
    clearTimeout(active.progressTimeout);
    clearTimeout(active.timeout);
    active.cancelRequested = true;
    let released = false;
    let toolAttempts = null;
    try {
      // The bridge releases its target lock before acknowledging interrupt.
      // Do not free the local writer first or an immediate retry collides with it.
      const result = await this.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 30_000);
      released = result?.ok === true && Array.isArray(result.toolAttempts);
      toolAttempts = result?.toolAttempts;
      if (result?.toolAttempts?.some((name) => !replaySafeTool(name))) active.sideEffectsPossible = true;
    } catch {
      // If the bridge cannot confirm cleanup, retire it before allowing another
      // turn. Every target's pending messages and confirmed sends remain durable.
      const child = this.child;
      if (child && child.exitCode == null) {
        await new Promise((resolve) => {
          const force = setTimeout(() => child.kill("SIGKILL"), 5000);
          const giveUp = setTimeout(resolve, 10_000);
          child.once("close", () => {
            clearTimeout(force);
            clearTimeout(giveUp);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }
    }
    const error = new Error(reason);
    error.code = active.compacting ? "WORKBUDDY_COMPACTION_TIMEOUT" : "WORKBUDDY_IDLE_TIMEOUT";
    error.safeToRetry = replaySafeTurn(active, released, toolAttempts);
    this.finishTurn(active, error);
  }

  async interruptGroup(groupId) {
    const recovery = [...this.recoveries.values()].find((item) => item.groupId === String(groupId));
    recovery?.controller.abort();
    const active = this.activeByGroup.get(String(groupId));
    if (!active) return Boolean(recovery);
    active.cancelRequested = true;
    clearTimeout(active.timeout);
    clearTimeout(active.progressTimeout);
    try {
      await this.request(
        "turn/interrupt",
        { threadId: active.threadId, turnId: active.turnId },
        15_000
      );
    } catch {
      // 桥没应答就直接收口，避免这轮永远挂着
      this.finishTurn(active, new WorkBuddyTurnCancelledError());
      return true;
    }
    setTimeout(() => {
      if (!this.activeByTurn.has(active.turnId)) return;
      this.finishTurn(active, new WorkBuddyTurnCancelledError());
    }, 8000).unref?.();
    return true;
  }

  activeGroups() {
    return [...new Set([...this.activeByGroup.keys(), ...[...this.recoveries.values()].map((item) => item.groupId)])];
  }

  async listModels() {
    await this.ensureProcess();
    const response = await this.request("model/list", {}, 30_000);
    return response?.data || [];
  }

  async listLoadedThreads() {
    await this.ensureProcess();
    const response = await this.request("thread/loaded/list", {}, 30_000);
    return (response?.data || []).map(String);
  }

  async deleteThread(threadId, { purgeProject = false, cwd = null, ephemeral = false, deletePersistent = false } = {}) {
    await this.ensureProcess();
    const id = String(threadId || "");
    if (!id) throw new Error("WorkBuddy thread id is required");
    if (this.activeByThread.has(id) || this.recoveries.has(id)) throw new Error(`WorkBuddy thread ${id} still has a running turn`);
    return this.request("thread/delete", {
      threadId: id,
      purgeProject: Boolean(purgeProject),
      cwd: cwd || undefined,
      ephemeral: Boolean(ephemeral),
      deletePersistent: Boolean(deletePersistent)
    }, 30_000);
  }

  async close() {
    for (const recovery of this.recoveries.values()) recovery.controller.abort();
    for (const active of this.activeByTurn.values()) {
      this.finishTurn(active, new Error("WorkBuddy client is shutting down"));
    }
    if (this.child && this.child.exitCode == null) {
      try {
        await this.request("shutdown", {}, 5000);
      } catch {
        // 桥没回就硬杀
      }
    }
    this.child?.kill("SIGTERM");
    this.child = null;
    this.initialized = false;
    if (this.mcpGateway) await new Promise((resolve) => this.mcpGateway.close(resolve));
    this.mcpGateway = null;
    this.mcpEndpoint = null;
  }

  request(method, params, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode != null) {
        reject(new Error("WorkBuddy bridge is not running"));
        return;
      }
      const id = this.nextRequestId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(new Error(`WorkBuddy bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(String(id), { resolve, reject, timeout });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(String(id));
        reject(error);
      }
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id != null && message.method == null) {
      const pending = this.pendingRequests.get(String(message.id));
      if (pending) {
        this.pendingRequests.delete(String(message.id));
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message || "WorkBuddy bridge request failed"));
        else pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = message.params || {};
      const active = this.activeByTurn.get(String(params.turnId || ""));
      if (!active || String(params.threadId || "") !== active.threadId) return;
      const delta = String(params.delta || "");
      if (!delta) return;
      this.reportProgress(active, "text");
      this.touchTurn(active);
      active.text += delta;
      if (!active.qqToolContext?.liveMode && !(active.mcpActions || []).some((action) => action.kind === "message")) active.onDelta?.(delta, active.text);
      return;
    }

    if (message.method === "thread/compacting") {
      const active = this.activeByThread.get(String(message.params?.threadId || ""));
      if (active) {
        if (!active.compacting || !Number.isFinite(active.compactionDeadlineAt)) {
          active.compacting = true;
          active.compactionDeadlineAt = Date.now() + Math.max(1, Number(this.compactionTimeoutMs) || 6 * 60 * 1000);
        }
        this.reportProgress(active, "compacting");
        this.touchTurn(active);
      }
      return;
    }

    if (message.method === "thread/compacted") {
      const active = this.activeByThread.get(String(message.params?.threadId || ""));
      if (active) {
        active.compacting = false;
        active.compactionDeadlineAt = null;
        active.compacted = true;
        this.reportProgress(active, "response");
        this.touchTurn(active);
      }
      return;
    }

    if (message.method === "turn/progress") {
      const params = message.params || {};
      const active = this.activeByTurn.get(String(params.turnId || ""));
      if (active && String(params.threadId || "") === active.threadId) {
        this.touchTurn(active);
        this.reportProgress(active, active.compacting ? "compacting" : params.stage || "response");
      }
      return;
    }

    if (message.method === "turn/toolAttempt") {
      const params = message.params || {};
      const active = this.activeByTurn.get(String(params.turnId || ""));
      if (active && String(params.threadId || "") === active.threadId) {
        if (!replaySafeTool(params.name)) active.sideEffectsPossible = true;
        if (!active.cancelRequested) {
          this.reportProgress(active, "tool", String(params.name || "Agent 工具"));
          this.touchTurn(active);
        }
      }
      return;
    }

    if (message.method === "turn/usage") {
      const params = message.params || {};
      const active = this.activeByTurn.get(String(params.turnId || ""));
      if (active && String(params.threadId || "") === active.threadId) {
        this.diagnostics.usage(active.threadId, params.usage);
        this.onTurnEvent({ type: "agent-usage", groupId: active.groupId, threadId: active.threadId });
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params || {};
      const turnId = String(params.turn?.id || "");
      const active = this.activeByTurn.get(turnId);
      if (!active || String(params.threadId || "") !== active.threadId) return;
      // Interrupt acknowledgement, not a late completed event, owns timeout
      // cleanup and decides whether a replay is safe.
      if (active.timeoutInProgress) return;
      if (active.cancelRequested || params.turn?.status === "interrupted") {
        this.finishTurn(active, active.timeoutReason ? new Error(active.timeoutReason) : new WorkBuddyTurnCancelledError());
        return;
      }
      const status = params.turn?.status;
      if (status && status !== "completed") {
        this.finishTurn(active, new Error(`WorkBuddy turn ${status}`));
        return;
      }
      if (active.qqToolContext?.requireRead && !active.qqToolContext.readCalled) {
        this.finishTurn(active, new Error("WorkBuddy did not read the current QQ messages; pending messages were retained"));
        return;
      }
      if (active.qqToolContext?.requireSourceRead && !active.qqToolContext.sourceReadCalled) {
        this.finishTurn(active, new Error("WorkBuddy did not read the subscribed source group through MCP; source messages were retained"));
        return;
      }
      if (active.qqToolContext?.failed) {
        this.finishTurn(active, new Error("A live QQ action failed; pending messages and delivery receipts were retained"));
        return;
      }
      const completedText = extractAgentText(params.turn);
      const queuedMessage = (active.mcpActions || []).find((action) => action.kind === "message");
      const replyText = queuedMessage ? queuedMessage.text : (active.text || completedText);
      const directives = (active.mcpActions || []).map((action) => action.directive).filter((directive) => !replyText.includes(directive));
      this.finishTurn(active, null, {
        text: [replyText, ...directives].filter(Boolean).join("\n").trim(),
        threadId: active.threadId,
        turnId: active.turnId,
        compacted: Boolean(active.compacted),
      });
      return;
    }

    if (message.method === "error") {
      const params = message.params || {};
      const turnId = String(params.turnId || "");
      const active = turnId
        ? this.activeByTurn.get(turnId)
        : this.activeByThread.get(String(params.threadId || ""));
      if (!active || String(params.threadId || "") !== active.threadId || active.timeoutInProgress) return;
      const error = new Error(active.timeoutReason || params.error?.message || "WorkBuddy bridge error");
      if (!active.cancelRequested && params.error?.code === "WORKBUDDY_TRANSIENT_UPSTREAM") {
        error.code = params.error.code;
        error.safeToRetry = replaySafeTurn(active, params.released, params.toolAttempts);
      }
      this.finishTurn(active, error);
    }
  }

  finishTurn(active, error = null, value = null) {
    if (!active || !this.activeByTurn.has(active.turnId)) return;
    clearTimeout(active.timeout);
    clearTimeout(active.progressTimeout);
    this.activeByTurn.delete(active.turnId);
    this.activeByThread.delete(active.threadId);
    this.activeByGroup.delete(active.groupId);
    this.diagnostics.finish(active.threadId, error);
    this.onTurnEvent({ type: "agent-finished", groupId: active.groupId, threadId: active.threadId });
    if (error) {
      if (active.compacted) error.contextCompacted = true;
      active.reject(error);
    }
    else active.resolve(value);
  }

  handleProcessFailure(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const active of [...this.activeByTurn.values()]) this.finishTurn(active, error);
  }
}

function extractAgentText(turn) {
  return (turn?.items || [])
    .filter((item) => item?.type === "agentMessage")
    .map((item) => String(item.text || ""))
    .join("");
}
