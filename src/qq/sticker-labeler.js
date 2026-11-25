import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildStickerLabelPrompt, parseStickerLabelResult } from "./sticker-label.js";

export class EphemeralStickerLabeler {
  constructor({ agent, stickerManager, workspaceRoot, getSettings = () => ({ model: "hy3" }), onEvent = () => {} } = {}) {
    this.agent = agent;
    this.stickerManager = stickerManager;
    this.workspaceRoot = resolve(workspaceRoot);
    this.getSettings = getSettings;
    this.onEvent = onEvent;
  }

  async init() {
    await mkdir(this.workspaceRoot, { recursive: true });
  }

  async labelMessages(messages, { targetType, targetId, deferCommit = false } = {}) {
    if (typeof this.agent?.deleteThread !== "function") {
      throw new Error("当前 Agent 引擎不支持彻底删除临时表情识别会话");
    }
    const requests = this.stickerManager?.claimLabelRequests
      ? await this.stickerManager.claimLabelRequests(messages)
      : this.stickerManager?.labelRequests(messages) || [];
    if (!requests.length) return { updated: [], discardedIds: [], model: null };
    this.onEvent({
      type: "sticker-label-claimed",
      targetType,
      targetId: String(targetId || ""),
      stickerIds: requests.map((request) => request.id),
      at: new Date().toISOString()
    });

    const jobId = randomUUID();
    const jobDir = join(this.workspaceRoot, jobId);
    const threadIdHint = `sticker-label-${jobId}`;
    const groupId = `sticker-label:${targetType || "unknown"}:${targetId || "unknown"}:${jobId}`;
    const model = String(this.getSettings()?.model || "hy3");
    let threadId = null;
    let labels = null;
    let runError = null;
    let cleanupError = null;
    await mkdir(jobDir, { recursive: true });

    try {
      threadId = await this.agent.startThread({
        threadId: threadIdHint,
        model,
        effort: "auto",
        contextTokenLimit: "auto",
        workingMode: "agent",
        cwd: jobDir,
        threadSandbox: { type: "readOnly" },
        ephemeral: true
      });
      const result = await this.agent.runTurn({
        groupId,
        threadId,
        prompt: buildStickerLabelPrompt(requests),
        imagePaths: [...new Set(requests.map((request) => request.localPath))],
        model,
        effort: "auto",
        contextTokenLimit: "auto",
        workingMode: "agent",
        cwd: jobDir,
        turnSandbox: { type: "readOnly" },
        onDelta: () => {}
      });
      labels = parseStickerLabelResult(result.text, requests);
    } catch (error) {
      runError = error;
    } finally {
      if (threadId) {
        try {
          await this.agent.deleteThread(threadId, { purgeProject: true, cwd: jobDir, ephemeral: true });
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        await rm(jobDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError ||= error;
      }
    }

    if (runError || cleanupError || !labels) {
      const failure = cleanupError
        ? new Error(`表情识别临时会话清理失败：${cleanupError.message || cleanupError}`)
        : runError;
      const discardedIds = await this.stickerManager.discardCandidates(requests);
      failure.discardedStickerIds = discardedIds;
      failure.cause ||= runError || cleanupError;
      this.onEvent({
        type: "sticker-label-failed",
        targetType,
        targetId: String(targetId || ""),
        model,
        discardedStickerIds: discardedIds,
        error: failure.message,
        at: new Date().toISOString()
      });
      throw failure;
    }

    const staged = this.stickerManager.stageLabels
      ? await this.stickerManager.stageLabels(labels)
      : labels;
    if (staged.length !== requests.length) {
      const missing = requests.filter((request) => !staged.some((entry) => entry.id === request.id));
      const discardedIds = await this.stickerManager.discardCandidates(missing);
      const error = new Error(`表情识别结果暂存未完整完成（需要 ${requests.length}，完成 ${staged.length}）`);
      error.discardedStickerIds = discardedIds;
      throw error;
    }
    this.onEvent({
      type: "sticker-label-recognized",
      targetType,
      targetId: String(targetId || ""),
      stickerIds: staged.map((entry) => entry.id),
      waitingForReply: Boolean(deferCommit),
      at: new Date().toISOString()
    });
    if (deferCommit) return { updated: [], labels, requestIds: requests.map((request) => request.id), discardedIds: [], model };

    const updated = this.stickerManager.commitStagedLabels
      ? await this.stickerManager.commitStagedLabels(requests.map((request) => request.id))
      : await this.stickerManager.applyLabels(labels);
    if (updated.length !== requests.length) {
      const missing = requests.filter((request) => !updated.some((entry) => entry.id === request.id));
      const discardedIds = await this.stickerManager.discardCandidates(missing);
      const error = new Error(`表情入库未完整完成（需要 ${requests.length}，完成 ${updated.length}）`);
      error.discardedStickerIds = discardedIds;
      throw error;
    }
    return { updated, labels, requestIds: requests.map((request) => request.id), discardedIds: [], model };
  }
}
