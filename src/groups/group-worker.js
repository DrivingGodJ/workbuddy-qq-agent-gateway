import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  baseThreadInstructions,
  buildMcpTurnPrompt,
  buildTurnPrompt,
  constrainConversationSecurity,
  parseOwnerControlCommand,
  requireAgentReply,
  sandboxForTrigger,
  sanitizeGroupReply,
  THREAD_INSTRUCTIONS_REVISION
} from "../security/policy.js";
import { parseQqDeliveryDirectives } from "../qq/file-directive.js";
import { createLiveConversationTools } from "../qq/live-conversation.js";
import { sharedContextLabel } from "../qq/shared-context-reader.js";
import { conversationReadSequence } from "./group-state.js";
import { runConversationTurn } from "../qq/conversation-turn.js";
import { QqMessageReader } from "../qq/message-reader.js";
import { ConversationFollowup } from "../qq/conversation-followup.js";
import { StickerLabelCoordinator } from "../qq/sticker-label-coordinator.js";
import { markNotifiedClaims, optimizeSubscriptionInput, uniqueImagePaths } from "../security/subscription-input.js";
import {
  autoSubscriptionOutputSchema,
  buildAutoSubscriptionPrompt,
  formatAutomationConfirmations,
  formatSubscriptionContexts
} from "../security/subscription-policy.js";

export class GroupWorker {
  constructor({
    store, codex, oneBot, mediaManager, fileManager, stickerManager = null, stickerLabeler = null, triggerManager,
    subscriptionStore = null, automationClient = null, homeAssistant = null, persona = null, targetNameResolver = () => null,
    knownMemberIds = () => [],
    sharedWorkspaceRoot = null, taskGate = null, canRun = () => true, onEvent = () => {}, followupDurationMs
  } = {}) {
    this.store = store;
    this.codex = codex;
    this.oneBot = oneBot;
    this.mediaManager = mediaManager;
    this.fileManager = fileManager;
    this.stickerManager = stickerManager;
    this.stickerLabeler = stickerLabeler;
    this.triggerManager = triggerManager;
    this.subscriptionStore = subscriptionStore;
    this.automationClient = automationClient;
    this.homeAssistant = homeAssistant;
    this.persona = persona;
    this.targetNameResolver = targetNameResolver;
    this.knownMemberIds = knownMemberIds;
    this.sharedWorkspaceRoot = sharedWorkspaceRoot ? resolve(sharedWorkspaceRoot) : null;
    this.canRun = (id) => canRun(id) && this.store.snapshot(id).replyEnabled !== false;
    this.onEvent = onEvent;
    this.taskGate = taskGate;
    this.qzone = null;
    this.running = new Map();
    this.qzoneReservations = new Map();
    this.queuedChat = new Map();
    this.waitingChat = new Map();
    this.olderChatPermits = new Set();
    this.live = new Map();
    this.followup = new ConversationFollowup({ store, targetType: "group", durationMs: followupDurationMs,
      canRun: (id) => this.canRun(id), blocked: () => Boolean(this.taskGate?.blocked),
      shouldYield: (id) => this.qzoneReservations.has(String(id)) || this.sharedContexts?.shouldYield("group", id),
      setLive: (id, patch) => this.setLive(id, patch), onEvent });
    this.stickerLabels = new StickerLabelCoordinator({
      targetType: "group",
      store: this.store,
      stickerManager: this.stickerManager,
      stickerLabeler: this.stickerLabeler,
      taskGate,
      canRun: (id) => this.canRun(id),
      getActiveReply: (id) => this.running.get(String(id)) || null,
      afterCommit: async (id) => {
        if (!this.canRun(id)) return;
        if (this.store.snapshot(id).pendingTrigger || this.store.snapshot(id).replyFollowup) this.kick(id);
        else await this.triggerManager.reconsiderPending(id);
      },
      onEvent: this.onEvent
    });
  }

  kick(groupId) {
    if (!this.canRun(String(groupId))) return Promise.resolve();
    if (this.sharedContexts?.groupFor("group", groupId)) {
      return this.sharedContexts.run("group", groupId, "chat", () => this.kickLocal(groupId));
    }
    return this.kickLocal(groupId);
  }

  kickLocal(groupId) {
    const id = String(groupId);
    if (!this.canRun(id)) return Promise.resolve();
    if (this.store.rateLimitUntil(id) > Date.now()) return Promise.resolve();
    if (this.qzoneReservations.has(id) && !this.olderChatPermits.has(id)) {
      if (!this.store.snapshot(id).pendingTrigger) return this.qzoneReservations.get(id);
      return this.queueChatBehindReservation(id);
    }
    if (this.running.has(id)) return this.running.get(id);
    if (this.taskGate?.blocked) {
      if (this.waitingChat.has(id)) return this.waitingChat.get(id);
      const waiting = this.taskGate.wait().then(() => this.kickLocal(id)).finally(() => {
        if (this.waitingChat.get(id) === waiting) this.waitingChat.delete(id);
      });
      this.waitingChat.set(id, waiting);
      return waiting;
    }
    const stickerCommit = this.stickerLabels.waitForCommit(id);
    if (stickerCommit) {
      if (this.waitingChat.has(id)) return this.waitingChat.get(id);
      const waiting = stickerCommit.finally(() => this.kickLocal(id)).finally(() => {
        if (this.waitingChat.get(id) === waiting) this.waitingChat.delete(id);
      });
      this.waitingChat.set(id, waiting);
      return waiting;
    }
    const release = this.taskGate?.tryEnter();
    this.followup.start(id);
    const run = this.runLoop(id).finally(() => {
      this.running.delete(id);
      release?.();
      if (this.canRun(id) && this.store.snapshot(id).pendingTrigger) queueMicrotask(() => this.kick(id));
      else if (this.canRun(id) && this.store.snapshot(id).replyFollowup && this.taskGate?.blocked) {
        this.taskGate.wait().then(() => this.kick(id)).catch(() => {});
      }
    });
    this.running.set(id, run);
    return run;
  }

  queueChatBehindReservation(id) {
    if (this.queuedChat.has(id)) return this.queuedChat.get(id);
    const previous = this.qzoneReservations.get(id);
    let release;
    const reservation = new Promise((resolve) => { release = resolve; });
    this.qzoneReservations.set(id, reservation);
    const waiting = previous.then(() => {
      // Without a later job, normal chat keeps its two-minute followup window.
      if (this.qzoneReservations.get(id) === reservation) this.qzoneReservations.delete(id);
      else this.olderChatPermits.add(id);
      return this.kickLocal(id);
    }).finally(() => {
      this.olderChatPermits.delete(id);
      if (this.queuedChat.get(id) === waiting) this.queuedChat.delete(id);
      if (this.qzoneReservations.get(id) === reservation) this.qzoneReservations.delete(id);
      release();
    });
    this.queuedChat.set(id, waiting);
    return waiting;
  }

  async refreshInstructions(groupId) {
    if (this.sharedContexts?.groupFor("group", groupId)) {
      return this.sharedContexts.run("group", groupId, "instructions", () => this.refreshInstructionsLocal(groupId));
    }
    return this.refreshInstructionsLocal(groupId);
  }

  async refreshInstructionsLocal(groupId) {
    const id = String(groupId);
    const active = this.running.get(id);
    if (active) await active;
    if (this.running.has(id)) return this.refreshInstructionsLocal(id);
    if (this.taskGate?.blocked) { await this.taskGate.wait(); return this.refreshInstructionsLocal(id); }
    const release = this.taskGate?.tryEnter();
    const run = this.runInstructionRefresh(id).finally(() => {
      this.running.delete(id);
      release?.();
      if (this.canRun(id) && this.store.snapshot(id).pendingTrigger) queueMicrotask(() => this.kick(id));
    });
    this.running.set(id, run);
    return run;
  }

  async runQzoneTurn(groupId, prompt, { trigger = "qzone", qqToolContext = null } = {}) {
    if (this.sharedContexts?.groupFor("group", groupId)) {
      return this.sharedContexts.run("group", groupId, trigger, () => this.runQzoneTurnLocal(groupId, prompt, { trigger, qqToolContext }));
    }
    return this.runQzoneTurnLocal(groupId, prompt, { trigger, qqToolContext });
  }

  async runQzoneTurnLocal(groupId, prompt, { trigger = "qzone", qqToolContext = null } = {}) {
    const id = String(groupId);
    if (!this.canRun(id)) throw new Error("当前群会话或 Agent 总开关已关闭");
    const reservation = this.qzoneReservations.get(id);
    if (reservation) {
      await reservation;
      return this.runQzoneTurnLocal(id, prompt, { trigger, qqToolContext });
    }
    const active = this.running.get(id);
    if (active) await active.catch(() => {});
    if (this.running.has(id) || this.qzoneReservations.has(id)) return this.runQzoneTurnLocal(id, prompt, { trigger, qqToolContext });
    const committing = this.stickerLabels.waitForCommit(id);
    if (committing) {
      await committing;
      return this.runQzoneTurnLocal(id, prompt, { trigger, qqToolContext });
    }
    if (this.taskGate?.blocked) { await this.taskGate.wait(); return this.runQzoneTurnLocal(id, prompt, { trigger, qqToolContext }); }
    const release = this.taskGate?.tryEnter();
    const run = this.performQzoneTurn(id, prompt, trigger, qqToolContext).finally(() => {
      this.running.delete(id);
      release?.();
      if (this.canRun(id) && this.store.snapshot(id).pendingTrigger) queueMicrotask(() => this.kick(id));
    });
    this.running.set(id, run);
    return run;
  }

  async runQzoneSequence(groupId, task) {
    if (this.sharedContexts?.groupFor("group", groupId)) {
      return this.sharedContexts.run("group", groupId, "qzone", () => this.runQzoneSequenceLocal(groupId, task));
    }
    return this.runQzoneSequenceLocal(groupId, task);
  }

  async runQzoneSequenceLocal(groupId, task) {
    const id = String(groupId);
    const previous = this.qzoneReservations.get(id);
    if (!previous && !this.running.has(id) && this.store.snapshot(id).pendingTrigger) this.kick(id);
    const olderChat = previous ? null : this.waitingChat.get(id);
    if (olderChat) this.olderChatPermits.add(id);
    let releaseGate;
    let release;
    const reservation = new Promise((resolve) => { release = resolve; });
    // Reserve at activation, including while maintenance holds the global gate.
    this.qzoneReservations.set(id, reservation);
    this.store.messageEvents?.emit(id);
    try {
      if (previous) await previous;
      if (olderChat) await olderChat.catch(() => {});
      if (this.taskGate) {
        while (!(releaseGate = this.taskGate.tryEnter())) await this.taskGate.wait();
      }
      const active = this.running.get(id);
      if (active) await active.catch(() => {});
      const committing = this.stickerLabels.waitForCommit(id);
      if (committing) await committing;
      if (!this.canRun(id)) throw new Error("当前群会话或 Agent 总开关已关闭");
      if (this.store.rateLimitUntil(id) > Date.now()) throw new Error("模型额度暂不可用，QQ 空间任务已跳过本轮");
      return await task((prompt, { trigger = "qzone-feed", qqToolContext = null } = {}) =>
        this.performQzoneTurn(id, prompt, trigger, qqToolContext));
    } finally {
      this.olderChatPermits.delete(id);
      if (this.qzoneReservations.get(id) === reservation) {
        this.qzoneReservations.delete(id);
        if (this.canRun(id) && (this.store.snapshot(id).pendingTrigger || this.store.snapshot(id).replyFollowup)) {
          queueMicrotask(() => this.kick(id));
        }
      }
      release();
      releaseGate?.();
    }
  }

  async performQzoneTurn(groupId, prompt, trigger, qqToolContext = null) {
    let group = this.store.snapshot(groupId);
    const workspaceDir = this.workspaceDirFor(groupId);
    if (workspaceDir) await mkdir(workspaceDir, { recursive: true });
    const options = optionsForConversation(group);
    const scheduledSandbox = trigger === "speaker-greeting" ? "readOnly" : qqToolContext && this.codex?.supportsQqMcp
      ? options.permissionMode
      : "readOnly";
    let threadId = group.threadId;
    if (!threadId) {
      threadId = await this.codex.startThread({ ...options, cwd: workspaceDir, workingMode: "agent", threadSandbox: scheduledSandbox });
      await this.store.setThread(groupId, threadId, { bootstrapComplete: false });
      group = this.store.snapshot(groupId);
    } else {
      await this.codex.resumeThread(threadId, { ...options, cwd: workspaceDir, workingMode: "agent", threadSandbox: scheduledSandbox });
    }
    const includeBase = !group.bootstrapComplete || group.bootstrapRevision !== THREAD_INSTRUCTIONS_REVISION;
    let qzonePrompt = [
      sharedContextLabel(this.sharedContexts, "group", groupId),
      ...(includeBase && !this.codex.supportsSystemPrompt ? [`本持久会话固定说明：\n${baseThreadInstructions()}`] : []),
      prompt
    ].filter(Boolean).join("\n\n");
    if (this.persona) {
      try {
        const personaPrompt = this.codex.supportsSystemPrompt
          ? this.persona.systemPromptForClient?.() : (this.persona.systemPrompt?.() || this.persona.systemPromptForClient?.());
        if (typeof this.codex.setSystemPrompt === "function") this.codex.setSystemPrompt(personaPrompt);
        else qzonePrompt = [personaPrompt, qzonePrompt].filter(Boolean).join("\n\n");
      } catch (error) {
        this.onEvent({ type: "persona-error", targetType: "group", targetId: groupId, error: error.message, at: new Date().toISOString() });
      }
    }
    this.setLive(groupId, { status: "running", threadId, trigger, text: trigger === "speaker-greeting" ? "正在准备小爱问好…" : "正在处理 QQ 空间任务…", startedAt: new Date().toISOString(), error: null });
    try {
      const result = await this.codex.runTurn({
        groupId, threadId, prompt: qzonePrompt,
        imagePaths: [], model: options.model, effort: options.effort,
        contextTokenLimit: options.contextTokenLimit, workingMode: "agent", cwd: workspaceDir,
        qqToolContext: qqToolContext || (trigger === "qzone-post" ? { targetType: "group", allowQzonePost: true, scheduledQzonePost: true } : null),
        turnSandbox: { type: scheduledSandbox }
      });
      if (result.compacted) await this.store.markBootstrapRequired(groupId);
      else await this.store.markBootstrapComplete(groupId, THREAD_INSTRUCTIONS_REVISION);
      this.setLive(groupId, { status: "idle", threadId, trigger: null, text: "", error: null });
      return result;
    } catch (error) {
      if (error?.contextCompacted) await this.store.markBootstrapRequired(groupId).catch(() => {});
      this.setLive(groupId, { status: "error", threadId, trigger: null, text: "", error: error.message });
      throw error;
    }
  }

  createScheduledToolContext(groupId, qzoneActions) {
    const group = this.store.snapshot(groupId);
    const trigger = { reason: "qzone_scheduled", trust: "SYSTEM" };
    const security = constrainConversationSecurity(
      sandboxForTrigger(trigger, { workspaceDir: this.workspaceDirFor(groupId) }), optionsForConversation(group)
    );
    return createLiveConversationTools({
      store: this.store, targetId: groupId, targetType: "group", oneBot: this.oneBot,
      fileManager: this.fileManager, stickerManager: this.stickerManager, qzone: this.qzone,
      trigger, triggerMessages: [], security, scheduledTask: true, qzoneActions,
      initialImageSequence: Number(group.pendingMessages.at(-1)?.sequence || 0),
      stickers: this.stickerManager?.promptCatalog() || [],
      canRun: () => this.canRun(groupId), onEvent: this.onEvent,
      readSharedContext: this.readSharedContextFor?.("group", groupId),
      renderMessages: (messages, { snapshot }) => buildTurnPrompt(messages, {
        trigger, security, includeResponseInstruction: false, activeMessages: snapshot.pendingMessages,
        compact: true, includePermissionNotice: false
      })
    });
  }

  async runInstructionRefresh(groupId) {
    const group = this.store.snapshot(groupId);
    if (!group.threadId) return { groupId, status: "skipped", reason: "no-thread" };
    const workspaceDir = this.workspaceDirFor(groupId);
    if (workspaceDir) await mkdir(workspaceDir, { recursive: true });
    const codexOptions = optionsForConversation(group);
    const cwd = workspaceDir || undefined;
    this.setLive(groupId, {
      status: "running",
      threadId: group.threadId,
      trigger: "instruction_refresh",
      text: "正在无声刷新固定说明…",
      startedAt: new Date().toISOString(),
      error: null
    });
    this.onEvent({ type: "instruction-refresh-started", groupId, threadId: group.threadId, at: new Date().toISOString() });
    try {
      await this.codex.resumeThread(group.threadId, {
        ...codexOptions,
        cwd,
        workingMode: "agent",
        threadSandbox: "read-only"
      });
      const promptLines = [
        "本持久会话固定说明（人工无声刷新）：",
        baseThreadInstructions(),
        "",
        "以上固定说明是当前最新版本，替代旧版本。只读取说明；以后仅使用 qq_gateway.list_reactions 或网关随当前轮提供的真实表情 ID，不发送 QQ 内容，也不要执行其他外部操作。",
      ];
      promptLines.push("成功加载后只回复 CONTEXT_READY；调用失败只回复 CONTEXT_MISSING。");
      const prompt = promptLines.join("\n");
      let result = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        result = await this.codex.runTurn({
          groupId,
          threadId: group.threadId,
          prompt,
          imagePaths: [],
          model: codexOptions.model,
          effort: codexOptions.effort,
          contextTokenLimit: codexOptions.contextTokenLimit,
          workingMode: "agent",
          cwd,
          turnSandbox: { type: "readOnly" }
        });
        if (!result.compacted) break;
      }
      if (result?.compacted) throw new Error("Context compacted twice while refreshing fixed instructions");
      if (!/\bCONTEXT_READY\b/.test(String(result?.text || ""))) {
        throw new Error(`Instruction refresh verification failed: ${String(result?.text || "empty reply").slice(0, 200)}`);
      }
      await this.store.markBootstrapComplete(groupId, THREAD_INSTRUCTIONS_REVISION);
      this.setLive(groupId, { status: "idle", threadId: group.threadId, trigger: null, text: "", error: null });
      const refreshed = { groupId, threadId: group.threadId, status: "refreshed", revision: THREAD_INSTRUCTIONS_REVISION };
      this.onEvent({ type: "instruction-refresh-completed", ...refreshed, at: new Date().toISOString() });
      return refreshed;
    } catch (error) {
      await this.store.markBootstrapRequired(groupId).catch(() => {});
      this.setLive(groupId, { status: "error", threadId: group.threadId, trigger: null, text: "", error: error.message });
      this.onEvent({ type: "instruction-refresh-error", groupId, threadId: group.threadId, error: error.message, at: new Date().toISOString() });
      throw error;
    }
  }

  async runLoop(groupId) {
    let processed = false;
    for (;;) {
      if (!this.canRun(groupId)) {
        if (this.store.snapshot(groupId).replyFollowup) await this.followup.cancel(groupId);
        this.setLive(groupId, { status: "paused", text: "", waitUntil: null });
        return;
      }
      if (this.followup.cancelled.has(String(groupId))) return;
      if (processed && this.sharedContexts?.shouldYield("group", groupId)) return;
      if (this.taskGate?.blocked) {
        if (this.store.snapshot(groupId).replyFollowup) this.followup.publishQueued(groupId);
        return;
      }
      if (this.qzoneReservations.has(String(groupId)) && !this.olderChatPermits.delete(String(groupId))) return;
      if (this.stickerLabels.hasCommitBarrier(groupId)) {
        if (this.store.snapshot(groupId).replyFollowup) this.followup.publishQueued(groupId);
        return;
      }
      const work = await this.store.beginWork(groupId);
      if (!work) {
        if (await this.followup.wait(groupId)) continue;
        return;
      }
      try {
        if (work.kind === "control") await this.runControl(groupId, work);
        else if (work.kind === "delivery") await this.retryDelivery(groupId, work);
        else await this.runAgent(groupId, work);
      } catch (error) {
        const recalled = this.store.snapshot(groupId).processing?.invalidatedByRecall === true;
        await this.store.failWork(groupId, error, error.delivery ? { delivery: error.delivery } : {});
        if (recalled || error.code === "RECALLED_INPUT") {
          this.setLive(groupId, { status: "cancelled", error: null });
          this.onEvent({ type: "recall-cancelled", groupId, at: new Date().toISOString() });
          return;
        }
        if (this.store.snapshot(groupId).replyEnabled === false || error.code === "REPLY_DISABLED") {
          this.setLive(groupId, { status: "paused", error: null });
          return;
        }
        this.setLive(groupId, { status: error.code === "CANCELLED" ? "cancelled" : "error", error: error.message });
        this.onEvent({ type: "error", groupId, error: error.message, at: new Date().toISOString() });
        return;
      }
      if (this.stickerLabels.hasCommitBarrier(groupId)) {
        if (this.store.snapshot(groupId).replyFollowup) this.followup.publishQueued(groupId);
        return;
      }
      if (this.subscriptionStore?.dueAutoTargets().includes(`group:${groupId}`)) {
        await this.triggerManager.request(groupId, "subscription_auto", {});
      }
      await this.triggerManager.reconsiderPending(groupId);
      processed = true;
    }
  }

  labelStickers(groupId, messages) {
    return this.stickerLabels.schedule(groupId, messages);
  }

  recoverStickerLabels(groupId) {
    return this.stickerLabels.recover(groupId);
  }

  async runAgent(groupId, work) {
    this.store.assertReplyEnabled(groupId);
    const autoSubscriptionTurn = work.trigger.reason === "subscription_auto";
    const subscriptionContexts = autoSubscriptionTurn && this.subscriptionStore
      ? await this.subscriptionStore.claimForTarget("group", groupId, { mode: "AUTO" })
      : [];
    let deliveryPrepared = false;
    let claimsCompleted = false;
    try {
    const optimizedContexts = autoSubscriptionTurn ? optimizeSubscriptionInput(subscriptionContexts, { now: this.subscriptionStore?.clock().getTime() }) : subscriptionContexts;
    const inputContexts = autoSubscriptionTurn && !optimizedContexts.length && subscriptionContexts.length
      ? subscriptionContexts : optimizedContexts;
    if (autoSubscriptionTurn && inputContexts.length === 0) {
      const removed = this.subscriptionStore ? await this.subscriptionStore.completeClaims(subscriptionContexts) : [];
      claimsCompleted = true;
      const processed = await this.store.completeAgentWork(groupId, { reply: "", turnId: null, trigger: work.trigger, messages: work.messages });
      await this.mediaManager.removeMessages([...processed, ...removed]);
      this.setLive(groupId, { status: "idle", text: "", error: null });
      return;
    }
    let group = this.store.snapshot(groupId);
    let threadId = group.threadId;
    const workspaceDir = this.workspaceDirFor(groupId);
    if (workspaceDir) await mkdir(workspaceDir, { recursive: true });
    const codexOptions = optionsForConversation(group);
    const sourceViaMcp = autoSubscriptionTurn && this.codex.supportsQqMcp === true;
    const turnOptions = codexOptions;
    const security = constrainConversationSecurity(
      sandboxForTrigger(work.trigger, { workspaceDir }),
      codexOptions
    );
    const threadCwd = workspaceDir || security.cwd;

    if (!threadId) {
      threadId = await this.codex.startThread({ ...turnOptions, cwd: threadCwd, threadSandbox: security.threadSandbox });
      await this.store.setThread(groupId, threadId, { bootstrapComplete: false });
      group = this.store.snapshot(groupId);
      this.onEvent({ type: "thread-created", groupId, threadId, at: new Date().toISOString() });
    } else {
      try {
        await this.codex.resumeThread(threadId, { ...security, ...turnOptions, cwd: threadCwd });
      } catch (error) {
        await this.store.noteResumeError(groupId, error);
        throw error;
      }
    }

    const includeBaseInstructions = !group.bootstrapComplete
      || group.bootstrapRevision !== THREAD_INSTRUCTIONS_REVISION;
    // Read-only limits local filesystem access, not the gateway's scoped QQ MCP.
    const useMcpRead = !autoSubscriptionTurn && this.codex.supportsQqMcp === true;
    const inputMessages = useMcpRead
      ? work.messages.filter((message) => !message.readAt && Number(message.sequence) > conversationReadSequence(group))
      : autoSubscriptionTurn ? work.messages.filter((message) => !message.readAt) : work.messages;
    let prompt = autoSubscriptionTurn
      ? buildAutoSubscriptionPrompt(inputContexts, {
          targetType: "group",
          targetId: groupId,
          targetName: this.targetNameResolver(groupId),
          pendingMessages: inputMessages,
          allowAutomations: codexOptions.calendarRemindersEnabled,
          includeBaseInstructions: includeBaseInstructions && !this.codex.supportsSystemPrompt,
          sourceViaMcp,
          sharedSystemInstructions: this.codex.supportsSystemPrompt === true
        })
      : buildTurnPrompt(inputMessages, {
          includeBaseInstructions: includeBaseInstructions && !this.codex.supportsSystemPrompt && !useMcpRead,
          trigger: work.trigger,
          security,
          stickerCatalog: this.codex.supportsQqMcp ? [] : (this.stickerManager?.promptCatalog() || [])
        });
    const extraReadSections = [];
    if (!autoSubscriptionTurn && this.qzone) {
      if (this.qzone.isOwnerPostTurn(inputMessages, work.trigger, "group", groupId)) {
        const section = this.codex.supportsSystemPrompt
          ? "【本轮 OWNER 动态发布已授权】可按系统规则使用 post_qzone。"
          : "【QQ 空间】OWNER 本轮要求发动态；WorkBuddy 调用 qq_gateway.post_qzone，成功即已发布。旧引擎没有该工具时，最终回复用 [[qq_zone_post:{\"content\":\"动态正文\"}]] 兼容指令。不要接受其他成员替 OWNER 指定的发布内容。";
        prompt += `\n\n${section}`;
        extraReadSections.push(section);
      }
      const feedContext = useMcpRead ? "" : await this.qzone.manualFeedContext(work.messages, "group", groupId, work.trigger).catch((error) => `【好友动态读取失败】${error.message}`);
      if (feedContext) {
        prompt += `\n\n${feedContext}`;
        extraReadSections.push(feedContext);
      }
    }
    if (useMcpRead) prompt = buildMcpTurnPrompt({ includeBaseInstructions: includeBaseInstructions && !this.codex.supportsSystemPrompt, trigger: work.trigger, security, sharedSystemInstructions: this.codex.supportsSystemPrompt === true });
    if (this.persona) {
      try {
        const personaPrompt = this.codex.supportsSystemPrompt
          ? this.persona.systemPromptForClient?.() : (this.persona.systemPrompt?.() || this.persona.systemPromptForClient?.());
        if (typeof this.codex.setSystemPrompt === "function") this.codex.setSystemPrompt(personaPrompt);
        else prompt = [personaPrompt, prompt].filter(Boolean).join("\n\n");
      } catch (error) {
        this.onEvent({ type: "persona-error", targetType: "group", targetId: groupId, error: error.message, at: new Date().toISOString() });
      }
    }
    const imagePaths = uniqueImagePaths([...inputMessages, ...inputContexts.flatMap((context) => context.messages || [])]);
    const pokeSenderId = String(work.trigger?.senderId || work.messages.at(-1)?.senderId || "");
    const allowedPokeUserIds = [...new Set(work.messages
      .map((message) => String(message.senderId || ""))
      .concat(this.knownMemberIds(groupId), pokeSenderId)
      .filter((id) => /^\d{5,14}$/.test(id)))];
    const qqToolContext = sourceViaMcp ? {
      sourceGroupId: inputContexts[0].sourceGroupId,
      sourceReadContent: formatSubscriptionContexts(inputContexts, { heading: "本轮唯一只读通知来源；必须向当前目标会话总结，不得向来源群发送" }),
      requireSourceRead: true,
      sourceReadCalled: false,
      canRead: () => this.canRun(groupId),
      messageReader: new QqMessageReader({ oneBot: this.oneBot })
    } : useMcpRead ? createLiveConversationTools({
      store: this.store, targetId: groupId, targetType: "group", oneBot: this.oneBot,
      fileManager: this.fileManager, stickerManager: this.stickerManager, qzone: this.qzone,
      homeAssistant: this.homeAssistant,
      readSharedContext: this.readSharedContextFor?.("group", groupId),
      onEvent: this.onEvent,
      canRun: () => this.canRun(groupId),
      trigger: work.trigger, triggerMessages: inputMessages, security,
      initialImageSequence: Number(work.messages.at(-1)?.sequence || 0),
      pokeSenderId, allowedPokeUserIds, stickers: this.stickerManager?.promptCatalog() || [],
      readOnlyContextMessages: inputContexts.flatMap((context) => context.messages || []),
      renderMessages: (messages, { first, activeMessages }) => [
        first ? sharedContextLabel(this.sharedContexts, "group", groupId) : "",
        buildTurnPrompt(messages, { trigger: work.trigger, security, stickerCatalog: [], includeResponseInstruction: false,
          activeMessages, imagePaths, compact: true, includePermissionNotice: false }),
        ...(first ? extraReadSections : [])
      ].filter(Boolean).join("\n\n")
    }) : !autoSubscriptionTurn ? {
      targetType: "group",
      allowMessage: true,
      allowReactions: true,
      stickers: this.stickerManager?.promptCatalog() || [],
      allowPoke: true,
      pokeSenderId,
      allowedPokeUserIds,
      allowQzonePost: Boolean(this.qzone?.isOwnerPostTurn(work.messages, work.trigger, "group", groupId))
    } : null;
    if (sourceViaMcp) qqToolContext.messageReader.capture(inputContexts[0].messages || []);
    this.setLive(groupId, {
      status: "running",
      threadId,
      turnId: null,
      trigger: work.trigger.reason,
      text: "",
      startedAt: new Date().toISOString(),
      error: null
    });
    this.onEvent({ type: "turn-started", groupId, threadId, trigger: work.trigger.reason, at: new Date().toISOString() });

    this.store.assertReplyEnabled(groupId);
    if (autoSubscriptionTurn && inputMessages.length) await this.store.markMessagesRead(groupId, inputMessages);
    const turnRequest = {
      groupId,
      threadId,
      prompt,
      imagePaths,
      model: codexOptions.model,
      effort: codexOptions.effort,
      contextTokenLimit: codexOptions.contextTokenLimit,
      workingMode: turnOptions.workingMode,
      cwd: threadCwd,
      outputSchema: autoSubscriptionTurn ? autoSubscriptionOutputSchema() : null,
      qqToolContext,
      turnSandbox: security.turnSandbox,
      onDelta: (delta, text) => {
        const visibleText = autoSubscriptionTurn ? "正在整理订阅通知…" : text;
        this.setLive(groupId, { status: "running", threadId, text: visibleText, updatedAt: new Date().toISOString() });
        this.onEvent({ type: "delta", groupId, threadId, delta: autoSubscriptionTurn ? "" : delta, text: visibleText, at: new Date().toISOString() });
      }
    };
    const autoTurn = await runConversationTurn({ codex: this.codex, request: turnRequest,
      autoSubscription: autoSubscriptionTurn ? { contexts: inputContexts, targetType: "group", targetId: groupId,
        pendingMessages: inputMessages, allowAutomations: codexOptions.calendarRemindersEnabled,
        sourceReadContext: sourceViaMcp ? qqToolContext : null } : null,
      onRecovery: () => this.onEvent({ type: "send-tool-recovery", groupId, threadId, at: new Date().toISOString() })
    });
    const result = autoTurn.result;
    this.store.assertReplyEnabled(groupId);
    if (useMcpRead) {
      if (qqToolContext.failed) throw new Error("本轮 QQ 操作失败；待处理消息仍保留");
      if (!qqToolContext.readCalled) throw new Error("Agent 本轮未读取消息；待处理消息仍保留");
      const live = this.store.snapshot(groupId).liveSession;
      const removedSourceMessages = this.subscriptionStore
        ? await this.subscriptionStore.completeClaims(subscriptionContexts) : [];
      claimsCompleted = true;
      await this.followup.arm(groupId, qqToolContext);
      const processed = await this.store.completeLiveConversation(groupId, {
        turnId: result.turnId, trigger: work.trigger,
        bootstrapComplete: !result.compacted, bootstrapRevision: THREAD_INSTRUCTIONS_REVISION,
        lastReadSequence: qqToolContext.lastReadSequence
      });
      const sharedProcessed = await qqToolContext.completeSharedReads?.() || [];
      await this.mediaManager.removeMessages([...processed, ...sharedProcessed, ...removedSourceMessages]);
      this.followup.publishWaiting(groupId, { threadId, turnId: result.turnId });
      this.onEvent({ type: "turn-completed", groupId, threadId, turnId: result.turnId, reply: live?.lastReply || "", at: new Date().toISOString() });
      return;
    }
    let resultText = autoSubscriptionTurn ? String(result.text || "").trim() : requireAgentReply(result.text);
    let qzoneNotices = [];
    if (!autoSubscriptionTurn && this.qzone) {
      const qzone = await this.qzone.executeManual({ targetType: "group", targetId: groupId, trigger: work.trigger, messages: work.messages, turnId: result.turnId, text: resultText });
      resultText = qzone.text;
      qzoneNotices = qzone.notices;
    }
    let files = [];
    let images = [];
    let faces = [];
    let stickers = [];
    let pokes = [];
    let silent = false;
    let reply = "";
    let displayReply = "";
    let automationResults = [];
    if (autoSubscriptionTurn) {
      const autoResult = autoTurn.autoResult;
      for (const action of autoResult.actions) {
        this.store.assertReplyEnabled(groupId);
        if (!this.automationClient) throw new Error("Calendar/Reminders automation is unavailable");
        const sourceName = subscriptionContexts.find((context) => context.sourceGroupId === action.sourceGroupId)?.sourceGroupName;
        automationResults.push(await this.automationClient.execute(action, {
          sourceGroupId: action.sourceGroupId,
          sourceGroupName: sourceName
        }));
      }
      const notification = autoResult.reply;
      const confirmation = formatAutomationConfirmations(autoResult.actions, automationResults);
      const text = [notification, confirmation].filter(Boolean).join("\n\n");
      reply = text ? sanitizeGroupReply(text) : "";
      displayReply = reply;
    } else {
      const parsed = parseQqDeliveryDirectives(resultText, {
        allowFiles: security.allowQqFiles,
        allowImages: security.allowQqFiles,
        allowFaces: true,
        allowStickers: Boolean(this.stickerManager),
        allowPokes: true,
        allowSilent: work.trigger.reason === "poke",
        pokeSenderId,
        allowedPokeUserIds
      });
      const restrictionNotices = [];
      try {
        files = await this.fileManager.resolveRequests(parsed.files, { allowedRoots: security.allowedFileRoots });
      } catch (error) {
        if (error?.code !== "QQ_FILE_OUTSIDE_ALLOWED_ROOT") throw error;
        files = [];
        restrictionNotices.push("这个文件不在当前群共享工作区内，普通成员不能读取或发送；请让 OWNER 亲自触发后再试。");
      }
      try {
        images = parsed.images.length
          ? await this.fileManager.resolveImageRequests(parsed.images, { allowedRoots: security.allowedFileRoots })
          : [];
      } catch (error) {
        if (error?.code === "QQ_IMAGE_OUTSIDE_ALLOWED_ROOT") {
          images = [];
          restrictionNotices.push("这张图片不在当前群允许访问的目录内，不能发送；请让 OWNER 亲自触发或先放入本群共享工作区。");
        } else if (error?.code === "QQ_IMAGE_UNSUPPORTED_FORMAT") {
          images = [];
          restrictionNotices.push("这张图片的格式暂不支持；请使用 JPG、PNG、GIF、WebP 或 BMP。");
        } else {
          throw error;
        }
      }
      faces = parsed.faces;
      stickers = this.stickerManager ? this.stickerManager.resolveRequests(parsed.stickers) : [];
      pokes = parsed.pokes;
      silent = parsed.silent;
      const replyText = parsed.text;
      reply = sanitizeGroupReply([replyText, ...restrictionNotices, ...qzoneNotices].filter(Boolean).join("\n\n"));
      displayReply = reply || deliverySummary({ files, images, faces, stickers, pokes });
    }

    this.store.assertReplyEnabled(groupId);
    if (!reply && files.length === 0 && images.length === 0 && faces.length === 0 && stickers.length === 0 && pokes.length === 0) {
      if (!autoSubscriptionTurn && !silent) requireAgentReply("");
      const removedSourceMessages = this.subscriptionStore
        ? await this.subscriptionStore.completeClaims(subscriptionContexts)
        : [];
      claimsCompleted = true;
      const processed = await this.store.completeAgentWork(groupId, {
        reply: "", turnId: result.turnId, trigger: work.trigger, messages: work.messages,
        bootstrapComplete: !result.compacted,
        bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
      });
      await this.mediaManager.removeMessages([...processed, ...removedSourceMessages]);
      this.setLive(groupId, { status: "completed", threadId, turnId: result.turnId, text: "", error: null });
      this.onEvent({ type: "subscription-auto-completed", groupId, notified: false, automationResults, at: new Date().toISOString() });
      return;
    }
    if (autoSubscriptionTurn && reply) markNotifiedClaims(subscriptionContexts, inputContexts);
    await this.store.prepareDeliveryWork(groupId, {
      reply,
      displayReply,
      turnId: result.turnId,
      trigger: work.trigger,
      files,
      images,
      faces,
      stickers,
      pokes,
      subscriptionConsumptions: subscriptionContexts,
      bootstrapComplete: !result.compacted,
      bootstrapRevision: THREAD_INSTRUCTIONS_REVISION,
      replyToMessageId: null
    });
    deliveryPrepared = true;

    await this.deliverPrepared(groupId);
    claimsCompleted = true;
    this.setLive(groupId, {
      status: "completed",
      threadId,
      turnId: result.turnId,
      trigger: work.trigger.reason,
      text: reply,
      updatedAt: new Date().toISOString(),
      error: null
    });
    this.onEvent({
      type: "turn-completed",
      groupId,
      threadId,
      turnId: result.turnId,
      reply: displayReply,
      files: files.map((file) => ({ name: file.name, size: file.size })),
      images: images.map((image) => ({ name: image.name, size: image.size, mimeType: image.mimeType })),
      faces: faces.map((face) => ({ id: face.id, name: face.name })),
      stickers: stickers.map((sticker) => ({ id: sticker.id, usage: sticker.usage })),
      pokes: pokes.map((poke) => ({ userId: poke.userId })),
      at: new Date().toISOString()
    });
    } catch (error) {
      if (error?.contextCompacted) await this.store.markBootstrapRequired(groupId).catch(() => {});
      if (!deliveryPrepared && !claimsCompleted && this.subscriptionStore && subscriptionContexts.length) {
        if (this.store.snapshot(groupId).replyEnabled === false || this.store.snapshot(groupId).processing?.invalidatedByRecall || ["REPLY_DISABLED", "RECALLED_INPUT"].includes(error.code)) await this.subscriptionStore.releaseClaims(subscriptionContexts).catch(() => {});
        else await this.subscriptionStore.failClaims(subscriptionContexts, error).catch(() => {});
      }
      throw error;
    }
  }

  async retryDelivery(groupId, work) {
    const delivery = await this.deliverPrepared(groupId, work.delivery);
    this.setLive(groupId, {
      status: "completed",
      text: delivery.displayReply || delivery.reply,
      threadId: this.store.snapshot(groupId).threadId,
      trigger: "retry",
      updatedAt: new Date().toISOString(),
      error: null
    });
    this.onEvent({ type: "delivery-completed", groupId, reply: delivery.displayReply || delivery.reply, at: new Date().toISOString() });
  }

  async deliverPrepared(groupId, fallbackDelivery = null) {
    try {
      let delivery = this.store.snapshot(groupId).failedDelivery || fallbackDelivery;
      this.store.assertReplyEnabled(groupId);
      if (!delivery) throw new Error("Prepared QQ delivery state is missing");

      if (!delivery.textSent && delivery.reply) {
        const send = await this.oneBot.sendGroupMessage(groupId, delivery.reply, {
          replyToMessageId: delivery.replyToMessageId || null
        });
        if (!send.ok) throw new Error(`QQ reply delivery failed with HTTP ${send.status}`);
        delivery = await this.store.markDeliveryTextSent(groupId);
      }

      for (let index = 0; index < (delivery.pokes || []).length; index += 1) {
        this.store.assertReplyEnabled(groupId);
        if (delivery.pokes[index].delivered) continue;
        const sent = await this.oneBot.sendGroupPoke(groupId, delivery.pokes[index].userId);
        if (!sent?.ok) throw new Error(`QQ poke delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryPokeSent(groupId, index);
      }

      for (let index = 0; index < (delivery.images || []).length; index += 1) {
        this.store.assertReplyEnabled(groupId);
        if (delivery.images[index].delivered) continue;
        this.setLive(groupId, {
          status: "uploading",
          text: `QQ 正在发送图片（${index + 1}/${delivery.images.length}）：${delivery.images[index].name}`,
          trigger: delivery.trigger || "retry",
          updatedAt: new Date().toISOString(),
          error: null
        });
        this.onEvent({
          type: "image-send-started",
          groupId,
          name: delivery.images[index].name,
          index,
          total: delivery.images.length,
          at: new Date().toISOString()
        });
        const sent = await this.fileManager.sendImage("group", groupId, delivery.images[index]);
        if (!sent?.ok) throw new Error(`QQ image delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryImageSent(groupId, index);
      }

      for (let index = 0; index < (delivery.faces || []).length; index += 1) {
        this.store.assertReplyEnabled(groupId);
        if (delivery.faces[index].delivered) continue;
        const sent = await this.oneBot.sendGroupFace(groupId, delivery.faces[index].id);
        if (!sent?.ok) throw new Error(`QQ face delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryFaceSent(groupId, index);
      }

      for (let index = 0; index < (delivery.stickers || []).length; index += 1) {
        this.store.assertReplyEnabled(groupId);
        if (delivery.stickers[index].delivered) continue;
        if (!this.stickerManager) throw new Error("QQ native sticker manager is unavailable");
        const sent = await this.stickerManager.sendSticker("group", groupId, delivery.stickers[index]);
        if (!sent?.ok) throw new Error(`QQ native sticker delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryStickerSent(groupId, index);
      }

      for (let index = 0; index < (delivery.files || []).length; index += 1) {
        this.store.assertReplyEnabled(groupId);
        if (delivery.files[index].delivered) continue;
        this.setLive(groupId, {
          status: "uploading",
          text: `QQ 正在上传文件（${index + 1}/${delivery.files.length}）：${delivery.files[index].name}`,
          trigger: delivery.trigger || "retry",
          updatedAt: new Date().toISOString(),
          error: null
        });
        this.onEvent({
          type: "file-upload-started",
          groupId,
          name: delivery.files[index].name,
          index,
          total: delivery.files.length,
          at: new Date().toISOString()
        });
        const uploaded = await this.fileManager.upload(groupId, delivery.files[index]);
        if (!uploaded?.ok) throw new Error(`QQ file delivery failed with HTTP ${uploaded?.status || "unknown"}`);
        delivery = await this.store.markDeliveryFileSent(groupId, index);
      }

      const removedSourceMessages = this.subscriptionStore
        ? await this.subscriptionStore.completeClaims(delivery.subscriptionConsumptions || [])
        : [];
      const processed = await this.store.completeDeliveryWork(groupId);
      await this.mediaManager.removeMessages([...processed, ...removedSourceMessages]);
      return delivery;
    } catch (error) {
      error.delivery = this.store.snapshot(groupId).failedDelivery || fallbackDelivery;
      throw error;
    }
  }

  async runControl(groupId, work) {
    const message = work.messages[0];
    const command = parseOwnerControlCommand(message);
    if (!command) throw new Error("Invalid OWNER control command");
    if (command === "retry") {
      const failedSubscriptions = this.subscriptionStore
        ? await this.subscriptionStore.retryFailedForTarget("group", groupId)
        : 0;
      if (failedSubscriptions > 0) {
        const processed = await this.store.completeControlWork(groupId, message.sequence);
        await this.mediaManager.removeMessages(processed);
        await this.triggerManager.request(groupId, "subscription_auto", message);
        this.onEvent({ type: "control", groupId, command, subscriptionRetries: failedSubscriptions, at: new Date().toISOString() });
        return;
      }
      const before = this.store.snapshot(groupId);
      if (before.failedDelivery) {
        const processed = await this.store.completeControlWork(groupId, message.sequence);
        await this.mediaManager.removeMessages(processed);
        await this.triggerManager.request(groupId, "retry", message);
        this.onEvent({ type: "control", groupId, command, deliveryRetry: true, at: new Date().toISOString() });
        return;
      }
      if (before.pendingMessages.length <= 1) {
        const reply = "当前没有待重试的群消息。";
        const sent = await this.oneBot.sendGroupMessage(groupId, reply, { replyToMessageId: message.messageId });
        if (!sent.ok) throw deliveryError(`Unable to send /重试 confirmation: HTTP ${sent.status}`, { reply, trigger: "control" });
        const processed = await this.store.completeControlWork(groupId, message.sequence, { reply });
        await this.mediaManager.removeMessages(processed);
        this.onEvent({ type: "control", groupId, command, reply, at: new Date().toISOString() });
        return;
      }
      await this.store.completeControlWork(groupId, message.sequence);
      const remaining = this.store.snapshot(groupId);
      const failedControl = remaining.pendingMessages.find((candidate) => parseOwnerControlCommand(candidate));
      if (remaining.failedDelivery) await this.triggerManager.request(groupId, "retry", message);
      else if (failedControl) await this.triggerManager.request(groupId, "control", failedControl);
      else await this.triggerManager.request(groupId, "retry", message);
      this.onEvent({ type: "control", groupId, command, at: new Date().toISOString() });
      return;
    }

    if (command === "reset") {
      const previous = this.store.snapshot(groupId);
      const oldThreadId = previous.threadId;
      const codexOptions = optionsForConversation(previous);
      const workspaceDir = this.workspaceDirFor(groupId);
      if (workspaceDir) await mkdir(workspaceDir, { recursive: true });
      const newThreadId = await this.codex.startThread({ ...codexOptions, cwd: workspaceDir || undefined });
      const initialized = await this.codex.runTurn({
        groupId,
        threadId: newThreadId,
        prompt: `${baseThreadInstructions()}\n\n这是本群新会话的初始化消息。记住以上安全边界，只回复“会话已初始化”。`,
        imagePaths: [],
        model: codexOptions.model,
        effort: codexOptions.effort,
        turnSandbox: { type: "readOnly" }
      });
      await this.store.setThread(groupId, newThreadId, {
        bootstrapComplete: true,
        bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
      });
      for (const id of this.sharedContexts?.linkedPrivates(groupId) || []) {
        await this.sharedContexts.privateStore.resetReadCursor(id);
      }
      let oldThreadDeleted = !oldThreadId || oldThreadId === newThreadId;
      if (!oldThreadDeleted && typeof this.codex.deleteThread === "function") {
        try {
          const deleted = await this.codex.deleteThread(oldThreadId, {
            cwd: workspaceDir || undefined,
            deletePersistent: true
          });
          oldThreadDeleted = deleted?.deleted !== false;
          this.onEvent({ type: "superseded-thread-deleted", targetType: "group", groupId, threadId: oldThreadId, at: new Date().toISOString() });
        } catch (error) {
          this.onEvent({ type: "superseded-thread-delete-failed", targetType: "group", groupId, threadId: oldThreadId, error: error.message, at: new Date().toISOString() });
        }
      }
      const cleanupLine = oldThreadId
        ? (oldThreadDeleted ? "旧会话及其本地记录已删除。" : "新会话已生效，但旧会话记录清理失败。")
        : "当前没有旧会话需要清理。";
      const reply = `已为本群创建新的 WorkBuddy 会话。\n${cleanupLine}\nthreadId: ${newThreadId}`;
      const sent = await this.oneBot.sendGroupMessage(groupId, reply, { replyToMessageId: message.messageId });
      if (!sent.ok) throw deliveryError(`Unable to send /新会话 confirmation: HTTP ${sent.status}`, {
        reply,
        turnId: initialized.turnId,
        trigger: "control",
        bootstrapComplete: true
      });
      const processed = await this.store.completeControlWork(groupId, message.sequence, { reply });
      await this.mediaManager.removeMessages(processed);
      this.onEvent({ type: "control", groupId, command, threadId: newThreadId, reply, at: new Date().toISOString() });
      return;
    }

    const group = this.store.snapshot(groupId);
    const reply = [
      `threadId: ${group.threadId || "尚未创建"}`,
      `创建时间: ${group.threadCreatedAt || "-"}`,
      `最近活动: ${group.lastActivityAt || "-"}`,
      `pendingMessages: ${Math.max(0, group.pendingMessages.length - 1)}`,
      `busy: ${group.busy}`,
      `pendingTrigger: ${group.pendingTrigger?.reason || "无"}`
    ].join("\n");
    const sent = await this.oneBot.sendGroupMessage(groupId, reply, { replyToMessageId: message.messageId });
    if (!sent.ok) throw deliveryError(`Unable to send /会话 status: HTTP ${sent.status}`, { reply, trigger: "control" });
    const processed = await this.store.completeControlWork(groupId, message.sequence, { reply });
    await this.mediaManager.removeMessages(processed);
    this.onEvent({ type: "control", groupId, command, reply, at: new Date().toISOString() });
  }

  async cancel(groupId) {
    const waiting = this.running.has(String(groupId)) || this.sharedContexts?.busy("group", groupId);
    await this.followup.cancel(groupId);
    this.sharedContexts?.cancelTarget("group", groupId);
    this.setLive(groupId, { status: "cancelled", text: "", waitUntil: null });
    return await this.codex.interruptGroup(groupId) || waiting;
  }

  publicLiveState() {
    return Object.fromEntries([...this.live.entries()].map(([groupId, value]) => [groupId, { ...value }]));
  }

  setLive(groupId, patch) {
    const previous = this.live.get(String(groupId)) || { status: "idle", text: "", error: null };
    this.live.set(String(groupId), { ...previous, ...patch });
    if (patch.startedAt || (patch.status && patch.status !== "running")) {
      this.qzone?.clearManualActivity("group", groupId);
    }
  }

  workspaceDirFor(groupId) {
    if (!this.sharedWorkspaceRoot) return null;
    const segment = String(groupId || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Invalid QQ group id for shared workspace");
    const directory = resolve(this.sharedWorkspaceRoot, segment);
    if (!directory.startsWith(`${this.sharedWorkspaceRoot}${sep}`)) throw new Error("QQ shared workspace escaped its configured root");
    return directory;
  }
}

function deliverySummary({ files = [], images = [], faces = [], stickers = [], pokes = [] } = {}) {
  const parts = [];
  if (images.length) parts.push(`已发送图片：${images.map((image) => image.name).join("、")}`);
  if (faces.length) parts.push(`已发送表情：${faces.map((face) => face.name || face.id).join("、")}`);
  if (stickers.length) parts.push(`已发送 QQ 表情包：${stickers.map((sticker) => sticker.usage || sticker.id).join("、")}`);
  if (pokes.length) parts.push(`已戳一戳：${pokes.map((poke) => poke.userId).join("、")}`);
  if (files.length) parts.push(`已发送文件：${files.map((file) => file.name).join("、")}`);
  return parts.join("\n");
}

function deliveryError(message, delivery) {
  const error = new Error(message);
  error.delivery = delivery;
  return error;
}

function optionsForConversation(conversation) {
  return {
    model: conversation.codexConfig?.model || undefined,
    effort: conversation.codexConfig?.reasoningEffort || undefined,
    contextTokenLimit: conversation.codexConfig?.contextTokenLimit || undefined,
    workingMode: "agent",
    permissionMode: conversation.codexConfig?.permissionMode || "workspaceWrite",
    calendarRemindersEnabled: conversation.codexConfig?.calendarRemindersEnabled !== false
  };
}
