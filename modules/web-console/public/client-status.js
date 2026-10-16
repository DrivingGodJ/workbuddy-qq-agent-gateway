export function isSpeakerGreetingBusy(data) {
  return ["queued", "generating", "speaking"].includes(data?.speakerGreetingActivity?.stage);
}

export function speakerGreetingStatus(activity = {}) {
  const label = activity.label || "定时问候";
  const states = {
    queued: { short: "问候排队", detail: `${label}已排队 · 等待当前会话前序任务`, tone: "pending" },
    generating: { short: "生成问候", detail: `正在生成${label}的小爱播报内容`, tone: "running" },
    speaking: { short: "小爱播报", detail: `${label}播报指令正在提交 · 结果以回执为准`, tone: "running" },
    completed: { short: "问候完成", detail: "HA 已接受小爱播报指令，无法核实实际声音；未发送到 QQ", tone: "idle" },
    failed: { short: "问候失败", detail: activity.error || "问候未完成，未确认播报成功", tone: "error" },
    cancelled: { short: "问候取消", detail: "本次定时问候已取消，不会自动重发", tone: "idle" },
    uncertain: { short: "播报未知", detail: activity.error || "播报请求结果未知，请勿自动重试，以免重复打扰", tone: "attention" }
  };
  return states[activity.stage] || { short: "定时问候", detail: "等待下一次已开启的问候时间", tone: "idle" };
}

export function conversationStatus(data, state = {}, now = Date.now()) {
  const active = data?.activeReply || {};
  const diagnostics = data?.diagnostics;
  const stage = diagnostics?.finishedAtMs != null ? null : diagnostics?.stage;
  const waitingModel = ["prompt_sent", "waiting_model"].includes(stage);
  if (data?.replyEnabled === false) return { short: "不回复", detail: "本会话不回复 · 消息继续记录", tone: "idle" };
  if (state.agentDispatch?.enabled === false) return { short: "已暂停", detail: "总开关已暂停 · 消息继续记录", tone: "idle" };
  if (active.uploading) return { short: "上传中", detail: active.text || "QQ 正在上传文件", tone: "running" };
  if (stage === "recovering") return { short: "恢复中", detail: "本轮无进展且未尝试外部操作 · 正在原会话中自动恢复一次，消息仍保留", tone: "running" };
  if (stage === "compacting") return { short: "压缩中", detail: "正在压缩上下文 · 最多等待六分钟，不是 QQ 发送中", tone: "running" };
  if (isSpeakerGreetingBusy(data)) {
    const status = speakerGreetingStatus(data.speakerGreetingActivity);
    return waitingModel ? { ...status, detail: `${status.detail} · 等待模型输出` } : status;
  }
  if (data?.qzoneActivity) {
    const activity = data.qzoneActivity;
    if (activity.stage === "queued") return { short: "动态排队", detail: "动态任务已排队 · 等待当前会话前序任务", tone: "pending" };
    const detail = activity.kind === "post" ? "正在处理空间发布" : "正在读取和判断好友动态";
    return { short: activity.kind === "post" ? "发动态" : "看动态", detail: `${detail}${waitingModel ? " · 等待模型输出" : ""}`, tone: "running" };
  }
  if (active.waiting) {
    const seconds = Math.max(0, Math.ceil((Date.parse(active.waitUntil) - now) / 1000));
    const countdown = Number.isFinite(seconds) ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
    return { short: "等接话", detail: `等待接话${countdown} · 期间不调用模型，新消息立即续接`, tone: "running" };
  }
  if (active.running) {
    if (stage === "preparing_images") return { short: "处理图片", detail: "正在生成受控图片预览 · 原图和原表情不变", tone: "running" };
    if (waitingModel) return { short: "等模型", detail: "请求已提交 · 等待模型输出，连续三分钟无实际进展才中断", tone: "running" };
    const detail = stage === "tool" ? `正在使用工具：${diagnostics.toolName || "Agent 工具"}`
      : stage === "starting" || stage === "client_ready" ? "正在准备模型请求"
      : active.trigger === "subscription_auto" ? "正在整理订阅通知" : "模型正在生成或思考";
    return { short: stage === "tool" ? "用工具" : "生成中", detail, tone: "running" };
  }
  if (active.status === "queued" || data?.pendingTrigger && state.dailyStyle?.gate?.blocked) {
    const maintenance = state.dailyStyle?.status === "running" ? "人格总结" : state.qq?.stickers?.curation?.status === "running" ? "表情筛选" : "前序任务";
    return { short: "排队中", detail: `任务排队 · 等待${maintenance}，消息仍保留`, tone: "pending" };
  }
  if (data?.threadLock?.status === "external_writer") return { short: "被占用", detail: "会话被其他写入端占用 · 网关自动重试", tone: "attention" };
  if (data?.lastError || active.error) return { short: "失败", detail: "本轮失败 · 消息和发送记录保留", tone: "error" };
  if (data?.pendingCount) return { short: String(data.pendingCount), detail: `${data.pendingCount} 条消息等待处理`, tone: "pending" };
  if (data?.speakerGreetingActivity) return speakerGreetingStatus(data.speakerGreetingActivity);
  const silent = diagnostics?.stage === "complete" && data?.lastCompletedReply?.completedAt
    && diagnostics.startedAtMs > Date.parse(data.lastCompletedReply.completedAt);
  return { short: "空闲", detail: silent ? "本轮正常结束，未新增 QQ 回复" : "消息已处理完毕", tone: "idle" };
}
