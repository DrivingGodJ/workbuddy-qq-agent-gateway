import {
  baseThreadInstructions,
  buildMcpTurnPrompt,
  constrainConversationSecurity,
  parseOwnerControlCommand,
  requireAgentReply,
  sanitizeGroupReply,
  THREAD_INSTRUCTIONS_REVISION
} from "../security/policy.js";
import { parseQqDeliveryDirectives } from "./file-directive.js";
import { createLiveConversationTools } from "./live-conversation.js";
import { runConversationTurn } from "./conversation-turn.js";
import { QqMessageReader } from "./message-reader.js";
import { ConversationFollowup } from "./conversation-followup.js";
import { StickerLabelCoordinator } from "./sticker-label-coordinator.js";
import { markNotifiedClaims, optimizeSubscriptionInput, uniqueImagePaths } from "../security/subscription-input.js";
import {
  autoSubscriptionOutputSchema,
  buildAutoSubscriptionPrompt,
  buildPrivateTurnPrompt,
  formatAutomationConfirmations,
  formatSubscriptionContexts,
  privateSandbox
} from "../security/subscription-policy.js";

export class PrivateWorker {
  constructor({ store, codex, oneBot, mediaManager, fileManager = null, stickerManager = null, stickerLabeler = null, triggerManager, subscriptionStore = null, automationClient = null, homeAssistant = null, persona = null, targetNameResolver = () => null, taskGate = null, canRun = () => true, onEvent = () => {}, followupDurationMs } = {}) {
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
    this.followup = new ConversationFollowup({ store, targetType: "private", durationMs: followupDurationMs,
      canRun: (id) => this.canRun(id), blocked: () => Boolean(this.taskGate?.blocked),
      shouldYield: (id) => this.qzoneReservations.has(String(id)),
      setLive: (id, patch) => this.setLive(id, patch), onEvent });
    this.stickerLabels = new StickerLabelCoordinator({
      targetType: "private",
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

  codexKey(userId) {
    return `private:${userId}`;
  }

  kick(userId) {
    const id = String(userId);
    if (!this.canRun(id)) return Promise.resolve();
    if (this.store.rateLimitUntil(id) > Date.now()) return Promise.resolve();
    if (this.qzoneReservations.has(id) && !this.olderChatPermits.has(id)) {
      if (!this.store.snapshot(id).pendingTrigger) return this.qzoneReservations.get(id);
      return this.queueChatBehindReservation(id);
    }
    if (this.running.has(id)) return this.running.get(id);
    if (this.taskGate?.blocked) {
      if (this.waitingChat.has(id)) return this.waitingChat.get(id);
      const waiting = this.taskGate.wait().then(() => this.kick(id)).finally(() => {
        if (this.waitingChat.get(id) === waiting) this.waitingChat.delete(id);
      });
      this.waitingChat.set(id, waiting);
      return waiting;
    }
    const stickerCommit = this.stickerLabels.waitForCommit(id);
    if (stickerCommit) {
      if (this.waitingChat.has(id)) return this.waitingChat.get(id);
      const waiting = stickerCommit.finally(() => this.kick(id)).finally(() => {
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
      if (this.qzoneReservations.get(id) === reservation) this.qzoneReservations.delete(id);
      else this.olderChatPermits.add(id);
      return this.kick(id);
    }).finally(() => {
      this.olderChatPermits.delete(id);
      if (this.queuedChat.get(id) === waiting) this.queuedChat.delete(id);
      if (this.qzoneReservations.get(id) === reservation) this.qzoneReservations.delete(id);
      release();
    });
    this.queuedChat.set(id, waiting);
    return waiting;
  }

  async runLoop(userId) {
    for (;;) {
      if (!this.canRun(userId)) {
        if (this.store.snapshot(userId).replyFollowup) await this.followup.cancel(userId);
        this.setLive(userId, { status: "paused", text: "", waitUntil: null });
        return;
      }
      if (this.followup.cancelled.has(String(userId))) return;
      if (this.taskGate?.blocked) {
        if (this.store.snapshot(userId).replyFollowup) this.followup.publishQueued(userId);
        return;
      }
      if (this.qzoneReservations.has(String(userId)) && !this.olderChatPermits.delete(String(userId))) return;
      if (this.stickerLabels.hasCommitBarrier(userId)) {
        if (this.store.snapshot(userId).replyFollowup) this.followup.publishQueued(userId);
        return;
      }
      const work = await this.store.beginWork(userId);
      if (!work) {
        if (await this.followup.wait(userId)) continue;
        return;
      }
      try {
        if (work.kind === "control") await this.runControl(userId, work);
        else if (work.kind === "delivery") await this.retryDelivery(userId, work);
        else await this.runAgent(userId, work);
      } catch (error) {
        const recalled = this.store.snapshot(userId).processing?.invalidatedByRecall === true;
        await this.store.failWork(userId, error, error.delivery ? { delivery: error.delivery } : {});
        if (recalled || error.code === "RECALLED_INPUT") {
          this.setLive(userId, { status: "cancelled", error: null });
          this.onEvent({ type: "private-recall-cancelled", userId, at: new Date().toISOString() });
          return;
        }
        if (this.store.snapshot(userId).replyEnabled === false || error.code === "REPLY_DISABLED") {
          this.setLive(userId, { status: "paused", error: null });
          return;
        }
        this.setLive(userId, { status: error.code === "CANCELLED" ? "cancelled" : "error", error: error.message });
        this.onEvent({ type: "private-error", userId, error: error.message, at: new Date().toISOString() });
        return;
      }
      if (this.stickerLabels.hasCommitBarrier(userId)) {
        if (this.store.snapshot(userId).replyFollowup) this.followup.publishQueued(userId);
        return;
      }
      if (this.subscriptionStore?.dueAutoTargets().includes(`private:${userId}`)) {
        await this.triggerManager.request(userId, "subscription_auto", {});
      }
      await this.triggerManager.reconsiderPending(userId);
    }
  }

  async runQzoneTurn(userId, prompt, { trigger = "qzone", qqToolContext = null } = {}) {
    const id = String(userId);
    if (!this.canRun(id)) throw new Error("当前私聊会话或 Agent 总开关已关闭");
    const reservation = this.qzoneReservations.get(id);
    if (reservation) {
      await reservation;
      return this.runQzoneTurn(id, prompt, { trigger, qqToolContext });
    }
    const active = this.running.get(id);
    if (active) await active.catch(() => {});
    if (this.running.has(id) || this.qzoneReservations.has(id)) return this.runQzoneTurn(id, prompt, { trigger, qqToolContext });
    const committing = this.stickerLabels.waitForCommit(id);
    if (committing) {
      await committing;
      return this.runQzoneTurn(id, prompt, { trigger, qqToolContext });
    }
    if (this.taskGate?.blocked) { await this.taskGate.wait(); return this.runQzoneTurn(id, prompt, { trigger, qqToolContext }); }
    const release = this.taskGate?.tryEnter();
    const run = this.performQzoneTurn(id, prompt, trigger, qqToolContext).finally(() => {
      this.running.delete(id);
      release?.();
      if (this.canRun(id) && this.store.snapshot(id).pendingTrigger) queueMicrotask(() => this.kick(id));
    });
    this.running.set(id, run);
    return run;
  }

  async runQzoneSequence(userId, task) {
    const id = String(userId);
    const previous = this.qzoneReservations.get(id);
    if (!previous && !this.running.has(id) && this.store.snapshot(id).pendingTrigger) this.kick(id);
    const olderChat = previous ? null : this.waitingChat.get(id);
    if (olderChat) this.olderChatPermits.add(id);
    let releaseGate;
    let release;
    const reservation = new Promise((resolve) => { release = resolve; });
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
      if (!this.canRun(id)) throw new Error("当前私聊会话或 Agent 总开关已关闭");
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

  async performQzoneTurn(userId, prompt, trigger, qqToolContext = null) {
    let conversation = this.store.snapshot(userId);
    const options = optionsForConversation(conversation);
    const scheduledSandbox = trigger === "speaker-greeting" ? "readOnly" : qqToolContext && this.codex?.supportsQqMcp
      ? options.permissionMode
      : "readOnly";
    let threadId = conversation.threadId;
    if (!threadId) {
      threadId = await this.codex.startThread({ ...options, workingMode: "agent", threadSandbox: scheduledSandbox });
      await this.store.setThread(userId, threadId, { bootstrapComplete: false });
      conversation = this.store.snapshot(userId);
    } else {
      await this.codex.resumeThread(threadId, { ...options, workingMode: "agent", threadSandbox: scheduledSandbox });
    }
    const includeBase = !conversation.bootstrapComplete || conversation.bootstrapRevision !== THREAD_INSTRUCTIONS_REVISION;
    let qzonePrompt = [
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
        this.onEvent({ type: "persona-error", targetType: "private", targetId: userId, error: error.message, at: new Date().toISOString() });
      }
    }
    this.setLive(userId, { status: "running", threadId, trigger, text: trigger === "speaker-greeting" ? "正在准备小爱问好…" : "正在处理 QQ 空间任务…", startedAt: new Date().toISOString(), error: null });
    try {
      const result = await this.codex.runTurn({
        groupId: this.codexKey(userId), threadId,
        prompt: qzonePrompt,
        imagePaths: [], model: options.model, effort: options.effort,
        contextTokenLimit: options.contextTokenLimit, workingMode: "agent",
        qqToolContext: qqToolContext || (trigger === "qzone-post" ? { targetType: "private", allowQzonePost: true, scheduledQzonePost: true } : null),
        turnSandbox: { type: scheduledSandbox }
      });
      if (result.compacted) await this.store.markBootstrapRequired(userId);
      else await this.store.markBootstrapComplete(userId, THREAD_INSTRUCTIONS_REVISION);
      this.setLive(userId, { status: "idle", threadId, trigger: null, text: "", error: null });
      return result;
    } catch (error) {
      if (error?.contextCompacted) await this.store.markBootstrapRequired(userId).catch(() => {});
      this.setLive(userId, { status: "error", threadId, trigger: null, text: "", error: error.message });
      throw error;
    }
  }

  createScheduledToolContext(userId, qzoneActions) {
    const conversation = this.store.snapshot(userId);
    const trigger = { reason: "qzone_scheduled", trust: "SYSTEM" };
    const security = constrainConversationSecurity(privateSandbox(userId, trigger), optionsForConversation(conversation));
    return createLiveConversationTools({
      store: this.store, targetId: userId, targetType: "private", oneBot: this.oneBot,
      fileManager: this.fileManager, stickerManager: this.stickerManager, qzone: this.qzone,
      trigger, triggerMessages: [], security, scheduledTask: true, qzoneActions,
      initialImageSequence: Number(conversation.pendingMessages.at(-1)?.sequence || 0),
      stickers: this.stickerManager?.promptCatalog() || [],
      canRun: () => this.canRun(userId), onEvent: this.onEvent,
      renderMessages: (messages, { snapshot }) => buildPrivateTurnPrompt(messages, [], {
        userId, displayName: this.targetNameResolver(userId), security,
        compact: true, includePermissionNotice: false,
        includeResponseInstruction: false, activeMessages: snapshot.pendingMessages
      })
    });
  }

  labelStickers(userId, messages) {
    return this.stickerLabels.schedule(userId, messages);
  }

  recoverStickerLabels(userId) {
    return this.stickerLabels.recover(userId);
  }

  async runAgent(userId, work) {
    this.store.assertReplyEnabled(userId);
    const autoSubscriptionTurn = work.trigger.reason === "subscription_auto";
    const contexts = autoSubscriptionTurn && this.subscriptionStore
      ? await this.subscriptionStore.claimForTarget("private", userId, { mode: "AUTO" })
      : [];
    let deliveryPrepared = false;
    let claimsCompleted = false;
    try {
      const optimizedContexts = autoSubscriptionTurn ? optimizeSubscriptionInput(contexts, { now: this.subscriptionStore?.clock().getTime() }) : contexts;
      const inputContexts = autoSubscriptionTurn && !optimizedContexts.length && contexts.length ? contexts : optimizedContexts;
      if (autoSubscriptionTurn && inputContexts.length === 0) {
        const removed = this.subscriptionStore ? await this.subscriptionStore.completeClaims(contexts) : [];
        claimsCompleted = true;
        const processed = await this.store.completeAgentWork(userId, { reply: "", turnId: null, trigger: work.trigger, messages: work.messages });
        await this.mediaManager.removeMessages([...processed, ...removed]);
        this.setLive(userId, { status: "idle", text: "", error: null });
        return;
      }
      let conversation = this.store.snapshot(userId);
      let threadId = conversation.threadId;
      const codexOptions = optionsForConversation(conversation);
      const sourceViaMcp = autoSubscriptionTurn && this.codex.supportsQqMcp === true;
      const turnOptions = codexOptions;
      const security = constrainConversationSecurity(privateSandbox(userId, work.trigger), codexOptions);
      if (!threadId) {
        threadId = await this.codex.startThread({ ...turnOptions, cwd: security.cwd, threadSandbox: security.threadSandbox });
        await this.store.setThread(userId, threadId, { bootstrapComplete: false });
        conversation = this.store.snapshot(userId);
        this.onEvent({ type: "private-thread-created", userId, threadId, at: new Date().toISOString() });
      } else {
        try {
          await this.codex.resumeThread(threadId, { ...security, ...turnOptions });
        } catch (error) {
          await this.store.noteResumeError(userId, error);
          throw error;
        }
      }

      const includeBaseInstructions = !conversation.bootstrapComplete
        || conversation.bootstrapRevision !== THREAD_INSTRUCTIONS_REVISION;
      // Read-only limits local filesystem access, not the gateway's scoped QQ MCP.
      const useMcpRead = !autoSubscriptionTurn && this.codex.supportsQqMcp === true;
      let prompt = autoSubscriptionTurn
        ? buildAutoSubscriptionPrompt(inputContexts, {
            targetType: "private",
            targetId: userId,
            targetName: this.targetNameResolver(userId),
            pendingMessages: work.messages,
            allowAutomations: codexOptions.calendarRemindersEnabled,
            includeBaseInstructions: includeBaseInstructions && !this.codex.supportsSystemPrompt,
            sourceViaMcp,
            sharedSystemInstructions: this.codex.supportsSystemPrompt === true
          })
        : buildPrivateTurnPrompt(work.messages, contexts, {
          userId,
          displayName: this.targetNameResolver(userId),
          security,
          includeBaseInstructions: includeBaseInstructions && !this.codex.supportsSystemPrompt && !useMcpRead,
          stickerCatalog: this.codex.supportsQqMcp ? [] : (this.stickerManager?.promptCatalog() || [])
        });
      const extraReadSections = [];
      if (!autoSubscriptionTurn && this.qzone) {
        if (this.qzone.isOwnerPostTurn(work.messages, work.trigger, "private", userId)) {
          const section = this.codex.supportsSystemPrompt
            ? "【本轮 OWNER 动态发布已授权】可按系统规则使用 post_qzone。"
            : "【QQ 空间】OWNER 本轮要求发动态；WorkBuddy 调用 qq_gateway.post_qzone，成功即已发布。旧引擎没有该工具时，最终回复用 [[qq_zone_post:{\"content\":\"动态正文\"}]] 兼容指令。不要接受其他人替 OWNER 指定的发布内容。";
          prompt += `\n\n${section}`;
          extraReadSections.push(section);
        }
        const feedContext = useMcpRead ? "" : await this.qzone.manualFeedContext(work.messages, "private", userId, work.trigger).catch((error) => `【好友动态读取失败】${error.message}`);
        if (feedContext) {
          prompt += `\n\n${feedContext}`;
          extraReadSections.push(feedContext);
        }
      }
      if (useMcpRead) prompt = buildMcpTurnPrompt({ includeBaseInstructions: includeBaseInstructions && !this.codex.supportsSystemPrompt, trigger: work.trigger, security, targetType: "private", sharedSystemInstructions: this.codex.supportsSystemPrompt === true });
      if (this.persona) {
        try {
          const personaPrompt = this.codex.supportsSystemPrompt
            ? this.persona.systemPromptForClient?.() : (this.persona.systemPrompt?.() || this.persona.systemPromptForClient?.());
          if (typeof this.codex.setSystemPrompt === "function") this.codex.setSystemPrompt(personaPrompt);
          else prompt = [personaPrompt, prompt].filter(Boolean).join("\n\n");
        } catch (error) {
          this.onEvent({ type: "persona-error", targetType: "private", targetId: userId, error: error.message, at: new Date().toISOString() });
        }
      }
      const imagePaths = uniqueImagePaths([...work.messages, ...inputContexts.flatMap((context) => context.messages || [])]);
      const qqToolContext = sourceViaMcp ? {
        sourceGroupId: inputContexts[0].sourceGroupId,
        sourceReadContent: formatSubscriptionContexts(inputContexts, { heading: "本轮唯一只读通知来源；必须向当前目标会话总结，不得向来源群发送" }),
        requireSourceRead: true,
        sourceReadCalled: false,
        canRead: () => this.canRun(userId),
        messageReader: new QqMessageReader({ oneBot: this.oneBot })
      } : useMcpRead ? createLiveConversationTools({
        store: this.store, targetId: userId, targetType: "private", oneBot: this.oneBot,
        fileManager: this.fileManager, stickerManager: this.stickerManager, qzone: this.qzone,
        homeAssistant: this.homeAssistant,
        canRun: () => this.canRun(userId),
        trigger: work.trigger, triggerMessages: work.messages, security,
        initialImageSequence: Number(work.messages.at(-1)?.sequence || 0),
        stickers: this.stickerManager?.promptCatalog() || [],
        readOnlyContextMessages: inputContexts.flatMap((context) => context.messages || []),
        renderMessages: (messages, { first, snapshot }) => [
          buildPrivateTurnPrompt(messages, first ? contexts : [], {
            userId, displayName: this.targetNameResolver(userId), security,
            includeBaseInstructions: false, includeResponseInstruction: false, stickerCatalog: [],
            activeMessages: snapshot.pendingMessages, compact: true, includePermissionNotice: false
          }),
          ...(first ? extraReadSections : [])
        ].filter(Boolean).join("\n\n")
      }) : !autoSubscriptionTurn ? {
        targetType: "private", allowMessage: true, allowReactions: true,
        stickers: this.stickerManager?.promptCatalog() || [],
        allowQzonePost: Boolean(this.qzone?.isOwnerPostTurn(work.messages, work.trigger, "private", userId))
      } : null;
      if (sourceViaMcp) qqToolContext.messageReader.capture(inputContexts[0].messages || []);
      this.setLive(userId, {
        status: "running", threadId, turnId: null, trigger: work.trigger.reason, text: "",
        startedAt: new Date().toISOString(), error: null
      });
      this.onEvent({ type: "private-turn-started", userId, threadId, trigger: work.trigger.reason, at: new Date().toISOString() });

      this.store.assertReplyEnabled(userId);
      const turnRequest = {
        groupId: this.codexKey(userId),
        threadId,
        prompt,
        imagePaths,
        model: codexOptions.model,
        effort: codexOptions.effort,
        contextTokenLimit: codexOptions.contextTokenLimit,
        workingMode: turnOptions.workingMode,
        outputSchema: autoSubscriptionTurn ? autoSubscriptionOutputSchema() : null,
        qqToolContext,
        turnSandbox: security.turnSandbox,
        onDelta: (delta, text) => {
          const visibleText = autoSubscriptionTurn ? "正在整理订阅通知…" : text;
          this.setLive(userId, { status: "running", threadId, text: visibleText, updatedAt: new Date().toISOString() });
          this.onEvent({ type: "private-delta", userId, threadId, delta: autoSubscriptionTurn ? "" : delta, text: visibleText, at: new Date().toISOString() });
        }
      };
      const autoTurn = await runConversationTurn({ codex: this.codex, request: turnRequest,
        autoSubscription: autoSubscriptionTurn ? { contexts: inputContexts, targetType: "private", targetId: userId,
          pendingMessages: work.messages, allowAutomations: codexOptions.calendarRemindersEnabled,
          sourceReadContext: sourceViaMcp ? qqToolContext : null } : null,
        onRecovery: () => this.onEvent({ type: "private-send-tool-recovery", userId, threadId, at: new Date().toISOString() })
      });
      const result = autoTurn.result;

      this.store.assertReplyEnabled(userId);
      if (useMcpRead) {
        if (qqToolContext.failed) throw new Error("本轮 QQ 操作失败；待处理消息仍保留");
        const silentScheduledCompletion = work.trigger.reason === "scheduled"
          && qqToolContext.actionCount === 0 && qqToolContext.readCalled;
        if (!qqToolContext.readCalled) throw new Error("Agent 本轮未读取消息；待处理消息仍保留");
        const live = this.store.snapshot(userId).liveSession;
        const removedSourceMessages = this.subscriptionStore ? await this.subscriptionStore.completeClaims(contexts) : [];
        claimsCompleted = true;
        await this.followup.arm(userId, qqToolContext);
        const processed = await this.store.completeLiveConversation(userId, {
          turnId: result.turnId, trigger: work.trigger,
          bootstrapComplete: !result.compacted, bootstrapRevision: THREAD_INSTRUCTIONS_REVISION,
          lastReadSequence: qqToolContext.lastReadSequence,
          consumeReadWithoutReply: silentScheduledCompletion || qqToolContext.qzoneActionCount > 0
        });
        await this.mediaManager.removeMessages([...processed, ...removedSourceMessages]);
        this.followup.publishWaiting(userId, { threadId, turnId: result.turnId });
        this.onEvent({ type: "private-turn-completed", userId, threadId, turnId: result.turnId, reply: live?.lastReply || "", at: new Date().toISOString() });
        return;
      }
      let resultText = autoSubscriptionTurn ? String(result.text || "").trim() : requireAgentReply(result.text);
      let qzoneNotices = [];
      if (!autoSubscriptionTurn && this.qzone) {
        const qzone = await this.qzone.executeManual({ targetType: "private", targetId: userId, trigger: work.trigger, messages: work.messages, turnId: result.turnId, text: resultText });
        resultText = qzone.text;
        qzoneNotices = qzone.notices;
      }
      let reply = "";
      let displayReply = "";
      let images = [];
      let faces = [];
      let stickers = [];
      const automationResults = [];
      if (autoSubscriptionTurn) {
        const autoResult = autoTurn.autoResult;
        for (const action of autoResult.actions) {
          this.store.assertReplyEnabled(userId);
          if (!this.automationClient) throw new Error("Calendar/Reminders automation is unavailable");
          const sourceName = contexts.find((context) => context.sourceGroupId === action.sourceGroupId)?.sourceGroupName;
          automationResults.push(await this.automationClient.execute(action, { sourceGroupId: action.sourceGroupId, sourceGroupName: sourceName }));
        }
        const notification = autoResult.reply;
        const confirmation = formatAutomationConfirmations(autoResult.actions, automationResults);
        const text = [notification, confirmation].filter(Boolean).join("\n\n");
        reply = text ? sanitizeGroupReply(text) : "";
        displayReply = reply;
      } else {
        const parsed = parseQqDeliveryDirectives(resultText, {
          allowFiles: false,
          allowImages: Boolean(security.allowQqFiles),
          allowFaces: true,
          allowStickers: Boolean(this.stickerManager)
        });
        const restrictionNotices = [];
        try {
          images = parsed.images.length
            ? await this.fileManager.resolveImageRequests(parsed.images, { allowedRoots: security.allowedFileRoots })
            : [];
        } catch (error) {
          if (error?.code === "QQ_IMAGE_OUTSIDE_ALLOWED_ROOT") {
            images = [];
            restrictionNotices.push("这张图片不在当前会话允许访问的目录内，不能发送。");
          } else if (error?.code === "QQ_IMAGE_UNSUPPORTED_FORMAT") {
            images = [];
            restrictionNotices.push("这张图片的格式暂不支持；请使用 JPG、PNG、GIF、WebP 或 BMP。");
          } else {
            throw error;
          }
        }
        faces = parsed.faces;
        stickers = this.stickerManager ? this.stickerManager.resolveRequests(parsed.stickers) : [];
        reply = sanitizeGroupReply([parsed.text, ...restrictionNotices, ...qzoneNotices].filter(Boolean).join("\n\n"));
        displayReply = reply || deliverySummary({ images, faces, stickers });
      }

      this.store.assertReplyEnabled(userId);
      if (!reply && images.length === 0 && faces.length === 0 && stickers.length === 0) {
        const removedSourceMessages = this.subscriptionStore ? await this.subscriptionStore.completeClaims(contexts) : [];
        claimsCompleted = true;
        const processed = await this.store.completeAgentWork(userId, {
          reply: "", turnId: result.turnId, trigger: work.trigger, messages: work.messages,
          bootstrapComplete: !result.compacted,
          bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
        });
        await this.mediaManager.removeMessages([...processed, ...removedSourceMessages]);
        this.setLive(userId, { status: "completed", threadId, turnId: result.turnId, text: "", error: null });
        this.onEvent({ type: "private-subscription-auto-completed", userId, notified: false, automationResults, at: new Date().toISOString() });
        return;
      }

      if (autoSubscriptionTurn && reply) markNotifiedClaims(contexts, inputContexts);
      await this.store.prepareDeliveryWork(userId, {
        reply,
        displayReply,
        turnId: result.turnId,
        trigger: work.trigger,
        images,
        faces,
        stickers,
        subscriptionConsumptions: contexts,
        bootstrapComplete: !result.compacted,
        bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
      });
      deliveryPrepared = true;
      await this.deliverPrepared(userId);
      claimsCompleted = true;
      this.setLive(userId, { status: "completed", threadId, turnId: result.turnId, trigger: work.trigger.reason, text: displayReply, updatedAt: new Date().toISOString(), error: null });
      this.onEvent({
        type: "private-turn-completed", userId, threadId, turnId: result.turnId, reply: displayReply,
        images: images.map((image) => ({ name: image.name, size: image.size, mimeType: image.mimeType })),
        faces: faces.map((face) => ({ id: face.id, name: face.name })),
        stickers: stickers.map((sticker) => ({ id: sticker.id, usage: sticker.usage })),
        at: new Date().toISOString()
      });
    } catch (error) {
      if (error?.contextCompacted) await this.store.markBootstrapRequired(userId).catch(() => {});
      if (!deliveryPrepared && !claimsCompleted && this.subscriptionStore && contexts.length) {
        if (this.store.snapshot(userId).replyEnabled === false || this.store.snapshot(userId).processing?.invalidatedByRecall || ["REPLY_DISABLED", "RECALLED_INPUT"].includes(error.code)) await this.subscriptionStore.releaseClaims(contexts).catch(() => {});
        else await this.subscriptionStore.failClaims(contexts, error).catch(() => {});
      }
      throw error;
    }
  }

  async retryDelivery(userId, work) {
    const delivery = await this.deliverPrepared(userId, work.delivery);
    this.setLive(userId, { status: "completed", text: delivery.displayReply || delivery.reply, threadId: this.store.snapshot(userId).threadId, trigger: "retry", updatedAt: new Date().toISOString(), error: null });
  }

  async deliverPrepared(userId, fallbackDelivery = null) {
    try {
      let delivery = this.store.snapshot(userId).failedDelivery || fallbackDelivery;
      this.store.assertReplyEnabled(userId);
      if (!delivery) throw new Error("Prepared private QQ delivery state is missing");
      if (!delivery.textSent && delivery.reply) {
        const sent = await this.oneBot.sendPrivateMessage(userId, delivery.reply);
        if (!sent.ok) throw new Error(`Private QQ delivery failed with HTTP ${sent.status}`);
        delivery = await this.store.markDeliveryTextSent(userId);
      }
      for (let index = 0; index < (delivery.images || []).length; index += 1) {
        this.store.assertReplyEnabled(userId);
        if (delivery.images[index].delivered) continue;
        this.setLive(userId, {
          status: "uploading",
          text: `QQ 正在发送图片（${index + 1}/${delivery.images.length}）：${delivery.images[index].name}`,
          trigger: delivery.trigger || "retry",
          updatedAt: new Date().toISOString(),
          error: null
        });
        const sent = await this.fileManager.sendImage("private", userId, delivery.images[index]);
        if (!sent?.ok) throw new Error(`Private QQ image delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryImageSent(userId, index);
      }
      for (let index = 0; index < (delivery.faces || []).length; index += 1) {
        this.store.assertReplyEnabled(userId);
        if (delivery.faces[index].delivered) continue;
        const sent = await this.oneBot.sendPrivateFace(userId, delivery.faces[index].id);
        if (!sent?.ok) throw new Error(`Private QQ face delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryFaceSent(userId, index);
      }
      for (let index = 0; index < (delivery.stickers || []).length; index += 1) {
        this.store.assertReplyEnabled(userId);
        if (delivery.stickers[index].delivered) continue;
        if (!this.stickerManager) throw new Error("QQ native sticker manager is unavailable");
        const sent = await this.stickerManager.sendSticker("private", userId, delivery.stickers[index]);
        if (!sent?.ok) throw new Error(`Private QQ native sticker delivery failed with HTTP ${sent?.status || "unknown"}`);
        delivery = await this.store.markDeliveryStickerSent(userId, index);
      }
      const removedSourceMessages = this.subscriptionStore
        ? await this.subscriptionStore.completeClaims(delivery.subscriptionConsumptions || [])
        : [];
      const processed = await this.store.completeDeliveryWork(userId);
      await this.mediaManager.removeMessages([...processed, ...removedSourceMessages]);
      return delivery;
    } catch (error) {
      error.delivery = this.store.snapshot(userId).failedDelivery || fallbackDelivery;
      throw error;
    }
  }

  async runControl(userId, work) {
    const message = work.messages[0];
    const command = parseOwnerControlCommand(message);
    if (!command) throw new Error("Invalid OWNER control command");
    if (command === "retry") {
      const failedSubscriptions = this.subscriptionStore
        ? await this.subscriptionStore.retryFailedForTarget("private", userId)
        : 0;
      await this.store.completeControlWork(userId, message.sequence);
      const remaining = this.store.snapshot(userId);
      if (failedSubscriptions > 0) await this.triggerManager.request(userId, "subscription_auto", message);
      else if (remaining.failedDelivery) await this.triggerManager.request(userId, "retry", message);
      else if (remaining.pendingMessages.length) await this.triggerManager.request(userId, "mention", remaining.pendingMessages.at(-1));
      else await this.oneBot.sendPrivateMessage(userId, "当前没有待重试的私聊消息。");
      return;
    }
    if (command === "reset") {
      const codexOptions = optionsForConversation(this.store.snapshot(userId));
      const newThreadId = await this.codex.startThread(codexOptions);
      const initialized = await this.codex.runTurn({
        groupId: this.codexKey(userId),
        threadId: newThreadId,
        prompt: `${baseThreadInstructions()}\n\n这是 QQ 私聊新会话的初始化消息。记住安全边界，只回复“会话已初始化”。`,
        imagePaths: [],
        model: codexOptions.model,
        effort: codexOptions.effort,
        turnSandbox: { type: "readOnly" }
      });
      await this.store.setThread(userId, newThreadId, {
        bootstrapComplete: true,
        bootstrapRevision: THREAD_INSTRUCTIONS_REVISION
      });
      const reply = `已为本私聊创建新的 WorkBuddy 会话。\nthreadId: ${newThreadId}`;
      const sent = await this.oneBot.sendPrivateMessage(userId, reply);
      if (!sent.ok) throw deliveryError(`Unable to send private reset confirmation: HTTP ${sent.status}`, { reply, turnId: initialized.turnId, trigger: "control", bootstrapComplete: true });
      const processed = await this.store.completeControlWork(userId, message.sequence, { reply });
      await this.mediaManager.removeMessages(processed);
      return;
    }
    const conversation = this.store.snapshot(userId);
    const reply = [
      `threadId: ${conversation.threadId || "尚未创建"}`,
      `创建时间: ${conversation.threadCreatedAt || "-"}`,
      `最近活动: ${conversation.lastActivityAt || "-"}`,
      `pendingMessages: ${Math.max(0, conversation.pendingMessages.length - 1)}`,
      `busy: ${conversation.busy}`,
      `pendingTrigger: ${conversation.pendingTrigger?.reason || "无"}`
    ].join("\n");
    const sent = await this.oneBot.sendPrivateMessage(userId, reply);
    if (!sent.ok) throw deliveryError(`Unable to send private session status: HTTP ${sent.status}`, { reply, trigger: "control" });
    const processed = await this.store.completeControlWork(userId, message.sequence, { reply });
    await this.mediaManager.removeMessages(processed);
  }

  async cancel(userId) {
    const waiting = this.running.has(String(userId));
    await this.followup.cancel(userId);
    return await this.codex.interruptGroup(this.codexKey(userId)) || waiting;
  }

  publicLiveState() {
    return Object.fromEntries([...this.live.entries()].map(([userId, value]) => [userId, { ...value }]));
  }

  setLive(userId, patch) {
    const previous = this.live.get(String(userId)) || { status: "idle", text: "", error: null };
    this.live.set(String(userId), { ...previous, ...patch });
    if (patch.startedAt || (patch.status && patch.status !== "running")) {
      this.qzone?.clearManualActivity("private", userId);
    }
  }
}

function deliverySummary({ images = [], faces = [], stickers = [] } = {}) {
  const parts = [];
  if (images.length) parts.push(`已发送图片：${images.map((image) => image.name).join("、")}`);
  if (faces.length) parts.push(`已发送表情：${faces.map((face) => face.name || face.id).join("、")}`);
  if (stickers.length) parts.push(`已发送 QQ 表情包：${stickers.map((sticker) => sticker.usage || sticker.id).join("、")}`);
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
