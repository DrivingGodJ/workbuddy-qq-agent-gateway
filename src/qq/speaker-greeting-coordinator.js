import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SPEAKER_GREETING_SLOTS = Object.freeze({ morning: "07:00", noon: "13:00", night: "23:30" });
const LABELS = { morning: "早间问候", noon: "午间问候", night: "晚间问候" };
const OPEN_STAGES = new Set(["queued", "generating", "speaking"]);
const STAGES = new Set([...OPEN_STAGES, "completed", "failed", "cancelled", "uncertain"]);
const TARGET_ID = /^\d{5,14}$/u;
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function shanghaiParts(date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function setting(config, slot) {
  return { enabled: config?.speakerGreetings?.[slot] === true, time: SPEAKER_GREETING_SLOTS[slot] };
}

function answer(value, isError = false) {
  return { isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function cancelled(message = "问候开关、家居权限或会话状态已变化，本次播报已取消。") {
  const error = new Error(message);
  error.code = "CANCELLED";
  return error;
}

export class SpeakerGreetingCoordinator {
  constructor({ filePath, homeAssistant, listTargets = () => [], canRun = () => true, clock = () => new Date(), onEvent = () => {}, onActivityChange = () => {} } = {}) {
    this.filePath = filePath;
    this.homeAssistant = homeAssistant;
    this.listTargets = listTargets;
    this.canRun = canRun;
    this.clock = clock;
    this.onEvent = onEvent;
    this.onActivityChange = onActivityChange;
    this.jobs = {};
    this.writes = Promise.resolve();
    this.ticks = Promise.resolve();
    this.running = new Map();
    this.timer = null;
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      if (saved.version !== 1 || !saved.jobs || Array.isArray(saved.jobs) || typeof saved.jobs !== "object") throw new Error("小爱定时问候记录格式无效；为避免重复播报，不能清空后继续。");
      for (const [id, job] of Object.entries(saved.jobs)) {
        if (!["group", "private"].includes(job.type) || !TARGET_ID.test(String(job.targetId)) || !Object.hasOwn(SPEAKER_GREETING_SLOTS, job.slot)
          || !/^\d{4}-\d{2}-\d{2}$/u.test(String(job.date)) || id !== job.id || id !== `${job.type}:${job.targetId}:${job.date}:${job.slot}`
          || job.time !== SPEAKER_GREETING_SLOTS[job.slot] || !STAGES.has(job.stage) || typeof job.attempted !== "boolean"
          || !Number.isFinite(Date.parse(job.scheduledAt))) throw new Error("小爱定时问候记录身份无效；停止恢复以避免重复播报。");
        if (OPEN_STAGES.has(job.stage)) {
          job.stage = job.attempted ? "uncertain" : "queued";
          if (job.attempted) job.error = "网关在播报尝试后重启，声音状态未知；不会自动重播。";
        }
        this.jobs[id] = job;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.save();
    return this;
  }

  targets() {
    const targets = typeof this.listTargets === "function" ? this.listTargets() : this.listTargets;
    return Array.isArray(targets) ? targets : [];
  }

  targetFor(job) {
    return this.targets().find((target) => target.type === job.type && String(target.id) === job.targetId);
  }

  enabled(target, slot, time = null) {
    if (!this.canRun() || !target || this.homeAssistant?.enabled === false || !this.homeAssistant?.allowedSpeakers?.size) return false;
    const snapshot = target.store.snapshot(target.id);
    const config = snapshot.codexConfig;
    const selected = setting(config, slot);
    return snapshot.replyEnabled !== false && ["owner", "group"].includes(config?.homeAssistantPermission)
      && selected.enabled && (!time || selected.time === time);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.emitEvent({ type: "speaker-greeting-error", error: error.message, at: this.clock().toISOString() })), 15_000);
    this.timer.unref?.();
    this.tick().catch((error) => this.emitEvent({ type: "speaker-greeting-error", error: error.message, at: this.clock().toISOString() }));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const tick = this.ticks.then(() => this.schedule(), () => this.schedule());
    this.ticks = tick.catch(() => {});
    return tick;
  }

  async schedule() {
    for (const job of Object.values(this.jobs).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
      if (job.stage !== "queued" || this.running.has(job.id)) continue;
      if (this.enabled(this.targetFor(job), job.slot, job.time)) this.launch(job);
      else {
        await this.update(() => { job.stage = "cancelled"; job.error = "恢复前相关开关或权限已关闭，问候不会补播。"; job.completedAt = this.clock().toISOString(); });
        this.notify(job);
      }
    }
    if (!this.canRun()) return;
    const parts = shanghaiParts(this.clock());
    for (const target of this.targets()) {
      if (!["group", "private"].includes(target.type) || !TARGET_ID.test(String(target.id))) continue;
      for (const slot of Object.keys(SPEAKER_GREETING_SLOTS)) {
        const config = setting(target.store.snapshot(target.id).codexConfig, slot);
        const id = `${target.type}:${target.id}:${parts.date}:${slot}`;
        if (config.time !== parts.time || this.jobs[id] || !this.enabled(target, slot)) continue;
        const job = { id, type: target.type, targetId: String(target.id), date: parts.date, slot, time: config.time,
          scheduledAt: this.clock().toISOString(), stage: "queued", attempted: false, text: "", error: null };
        await this.update(() => { this.jobs[id] = job; });
        this.notify(job);
        this.launch(job);
      }
    }
  }

  launch(job) {
    if (this.running.has(job.id)) return;
    const active = { cancelRequested: false, promise: null };
    this.running.set(job.id, active);
    active.promise = this.run(job, active).finally(() => this.running.delete(job.id));
    active.promise.catch((error) => this.emitEvent({ type: "speaker-greeting-error", jobId: job.id, error: error.message, at: this.clock().toISOString() }));
  }

  assertActive(job, active, modelActive = null) {
    if (active.cancelRequested || modelActive?.cancelRequested || !OPEN_STAGES.has(job.stage)
      || !this.enabled(this.targetFor(job), job.slot, job.time)) throw cancelled();
  }

  contextFor(job, active) {
    const speakerId = this.homeAssistant.allowedSpeakers.values().next().value;
    const context = { liveMode: true, requireRead: false, scheduledSpeakerGreeting: true, greetingJobId: job.id, targetType: job.type,
      allowMessage: false, ended: false, failed: false, spoken: false, readCalled: false, error: null };
    context.liveTool = async (name, args = {}, modelActive = null) => {
      try {
        this.assertActive(job, active, modelActive);
        if (context.failed || context.ended && name !== "end_conversation") throw new Error("本次问候已经停止，不再调用工具。");
        if (name === "end_conversation") { context.ended = true; return answer("本次模型轮次已结束。最终文字不会自动播报。"); }
        if (!["read_home_devices", "speak_home_speaker"].includes(name)) throw new Error("本次定时问候仅允许读取小爱发言入口并调用 speak_home_speaker；不能发送 QQ 消息、读取群消息或控制其他设备。");
        if (args.request_message_id !== job.id) throw new Error("请使用本次问候提供的 request_message_id，不能引用聊天消息授权。");
        if (args.entity_id != null && args.entity_id !== speakerId) throw new Error("本次问候只能使用指定的小爱播放文本入口。");
        if (name === "read_home_devices") {
          const result = await this.homeAssistant.read({ entity_id: speakerId, domain: "notify", limit: 1 });
          this.assertActive(job, active, modelActive);
          if (!result.devices?.some((device) => device.entity_id === speakerId)) throw new Error("指定的小爱发言入口未读取成功。");
          context.readCalled = true;
          return answer(result);
        }
        if (!context.readCalled) throw new Error("请先调用 read_home_devices 核实指定的小爱发言入口。");
        if (job.attempted || context.spoken) throw new Error("本次问候已尝试播报；不得重复播报。");
        if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 500) throw new Error("问候文本须为 1–500 字。");
        const result = await this.homeAssistant.speak({ entity_id: speakerId, text: args.text }, { beforeSend: async () => {
          this.assertActive(job, active, modelActive);
          await this.update(() => {
            if (job.attempted) throw new Error("本次问候已经尝试播报，不能重复。");
            job.attempted = true;
            job.attemptedAt = this.clock().toISOString();
            job.stage = "speaking";
            job.text = args.text.trim();
          });
          this.notify(job);
          this.assertActive(job, active, modelActive);
        } });
        if (result?.accepted !== true) throw new Error("小爱未确认接受本次播报。声音状态未知，不会自动重播。");
        context.spoken = true;
        return answer(result);
      } catch (error) {
        // Validation/tool errors stop this scheduled round, rather than provoking model retries.
        context.failed = true;
        context.error = error;
        return answer(error.message, true);
      }
    };
    return context;
  }

  async run(job, active) {
    const target = this.targetFor(job);
    let context;
    try {
      if (typeof target?.worker?.runQzoneSequence !== "function") throw new Error("会话 worker 未提供持久队列，不能执行小爱定时问候。");
      await target.worker.runQzoneSequence(target.id, async (runTurn) => {
        this.assertActive(job, active);
        await this.update(() => { job.stage = "generating"; });
        this.notify(job);
        context = this.contextFor(job, active);
        const prompt = `小爱${LABELS[job.slot]}。上海时间 ${job.date} ${job.time}。按当前人格想一句简短自然的问候，只在小爱播报一次，不向 QQ 发送，也不读取聊天。先调用 read_home_devices 核实发言入口，再调用 speak_home_speaker。request_message_id=${job.id}。最终文字不会自动播报。`;
        const result = await runTurn(prompt, { trigger: "speaker-greeting", qqToolContext: context });
        if (context.error) throw context.error;
        if (active.cancelRequested || result?.cancelled || result?.status === "cancelled") throw cancelled();
        if (!context.spoken) throw new Error("模型未调用小爱发言工具，本次问候未播报；最终文字不会隐式发送。");
      });
      await this.update(() => { job.stage = "completed"; job.completedAt = this.clock().toISOString(); job.error = null; });
    } catch (error) {
      await this.update(() => {
        job.stage = context?.spoken ? "completed" : job.attempted ? "uncertain" : active.cancelRequested || error.code === "CANCELLED" ? "cancelled" : "failed";
        job.completedAt = this.clock().toISOString();
        job.error = context?.spoken ? null : String(error.message || "小爱定时问候失败").slice(0, 500);
      });
    }
    this.notify(job);
  }

  async cancel(type, id) {
    const jobs = Object.values(this.jobs).filter((job) => job.type === type && job.targetId === String(id) && OPEN_STAGES.has(job.stage));
    for (const job of jobs) {
      const active = this.running.get(job.id);
      if (active) active.cancelRequested = true;
    }
    await this.update(() => {
      for (const job of jobs) {
        job.stage = job.attempted ? "uncertain" : "cancelled";
        job.completedAt = this.clock().toISOString();
        job.error = job.attempted ? "已终止后续动作；播报请求已尝试，声音状态未知，不会重播。" : "本次问候已取消，未播报。";
      }
    });
    for (const job of jobs) this.notify(job);
    return jobs.length;
  }

  activityFor(type, id) {
    const jobs = Object.values(this.jobs).filter((job) => job.type === type && job.targetId === String(id));
    const job = jobs.filter((item) => OPEN_STAGES.has(item.stage)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0]
      || jobs.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];
    return job ? { jobId: job.id, stage: job.stage, label: LABELS[job.slot], time: job.time,
      scheduledAt: job.scheduledAt, text: job.text, error: job.error } : null;
  }

  notify(job) {
    // UI/event delivery must not change the durable physical-action outcome.
    try { Promise.resolve(this.onActivityChange()).catch(() => {}); } catch { /* independent presentation callback */ }
    this.emitEvent({ type: "speaker-greeting", targetType: job.type, targetId: job.targetId,
      jobId: job.id, stage: job.stage, at: this.clock().toISOString() });
  }

  emitEvent(event) {
    try { Promise.resolve(this.onEvent(event)).catch(() => {}); } catch { /* independent presentation callback */ }
  }

  async drain() {
    while (this.running.size) await Promise.allSettled([...this.running.values()].map((active) => active.promise));
  }

  update(operation) {
    const next = this.writes.then(async () => { operation(); await this.save(); });
    this.writes = next.catch(() => {});
    return next;
  }

  async save() {
    const today = shanghaiParts(this.clock()).date;
    const protectedJobs = Object.entries(this.jobs).filter(([, job]) => OPEN_STAGES.has(job.stage) || job.date >= today);
    // ponytail: retain all active/current-day receipts, cap older terminal history at 600 jobs.
    const old = Object.entries(this.jobs).filter(([, job]) => !OPEN_STAGES.has(job.stage) && job.date < today)
      .sort(([, a], [, b]) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(-600);
    this.jobs = Object.fromEntries([...old, ...protectedJobs]);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify({ version: 1, jobs: this.jobs }), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
