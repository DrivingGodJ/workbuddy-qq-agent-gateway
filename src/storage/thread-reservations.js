const DEFAULT_INTERVAL_MS = 15_000;

export class ThreadReservationManager {
  constructor({ agent, listTargets, onChange = null, intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date() } = {}) {
    if (!agent) throw new Error("ThreadReservationManager requires an agent client");
    if (typeof listTargets !== "function") throw new Error("ThreadReservationManager requires listTargets");
    this.agent = agent;
    this.listTargets = listTargets;
    this.onChange = onChange;
    this.intervalMs = Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.now = now;
    this.locks = new Map();
    this.reconcilePromise = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return this.reconcile();
    const first = this.reconcile();
    this.timer = setInterval(() => {
      this.reconcile().catch((error) => console.warn(`Agent thread reservation check failed: ${error.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
    return first;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  reconcile() {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.reconcileOnce().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  stateFor(targetType, targetId, threadId = null) {
    const key = reservationKey(targetType, targetId);
    const current = this.locks.get(key);
    if (current && (!threadId || current.threadId === String(threadId))) return structuredClone(current);
    return {
      status: threadId ? "checking" : "unbound",
      threadId: threadId ? String(threadId) : null,
      checkedAt: null,
      error: null
    };
  }

  snapshot() {
    return Object.fromEntries([...this.locks.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }

  async reconcileOnce() {
    const targets = normalizeTargets(this.listTargets());
    const targetKeys = new Set(targets.map((target) => reservationKey(target.targetType, target.targetId)));
    let changed = false;

    for (const key of this.locks.keys()) {
      if (!targetKeys.has(key)) {
        this.locks.delete(key);
        changed = true;
      }
    }

    const boundTargets = targets.filter((target) => target.threadId);
    for (const target of targets.filter((item) => !item.threadId)) {
      changed = this.setState(target, "unbound", null) || changed;
    }

    if (!boundTargets.length) {
      if (changed) this.onChange?.(this.snapshot());
      return this.snapshot();
    }

    let loaded;
    try {
      loaded = new Set(await this.agent.listLoadedThreads());
    } catch (error) {
      for (const target of boundTargets) changed = this.setState(target, "error", shortError(error)) || changed;
      if (changed) this.onChange?.(this.snapshot());
      return this.snapshot();
    }

    let recovering = false;
    for (const target of boundTargets) {
      const previous = this.locks.get(reservationKey(target.targetType, target.targetId));
      if (!loaded.has(target.threadId) && previous?.status === "locked") {
        changed = this.setState(target, "checking", null) || changed;
        recovering = true;
      }
    }
    if (recovering && changed) this.onChange?.(this.snapshot());

    for (const target of boundTargets) {
      if (loaded.has(target.threadId)) {
        changed = this.setState(target, "locked", null) || changed;
        continue;
      }
      try {
        await this.agent.resumeThread(target.threadId, {
          threadSandbox: "read-only",
          model: target.model,
          effort: target.effort,
          contextTokenLimit: target.contextTokenLimit,
          workingMode: target.workingMode,
          cwd: target.cwd
        });
        loaded.add(target.threadId);
        changed = this.setState(target, "locked", null) || changed;
      } catch (error) {
        const message = shortError(error);
        const status = isExternalWriterError(message) ? "external_writer" : "error";
        changed = this.setState(target, status, message) || changed;
      }
    }

    if (changed) this.onChange?.(this.snapshot());
    return this.snapshot();
  }

  setState(target, status, error) {
    const key = reservationKey(target.targetType, target.targetId);
    const next = {
      status,
      threadId: target.threadId || null,
      checkedAt: this.now().toISOString(),
      error: error || null
    };
    const previous = this.locks.get(key);
    const changed = !previous
      || previous.status !== next.status
      || previous.threadId !== next.threadId
      || previous.error !== next.error;
    this.locks.set(key, next);
    return changed;
  }
}

function normalizeTargets(targets) {
  return (targets || []).map((target) => ({
    targetType: String(target.targetType || "group"),
    targetId: String(target.targetId || ""),
    threadId: target.threadId ? String(target.threadId) : null,
    model: target.model ? String(target.model) : undefined,
    effort: target.effort ? String(target.effort) : undefined,
    contextTokenLimit: Number(target.contextTokenLimit) > 0 ? Number(target.contextTokenLimit) : null,
    workingMode: target.workingMode ? String(target.workingMode) : undefined,
    cwd: target.cwd ? String(target.cwd) : null
  })).filter((target) => target.targetId);
}

function reservationKey(targetType, targetId) {
  return `${String(targetType)}:${String(targetId)}`;
}

function isExternalWriterError(message) {
  return /active writer|thread-store conflict|already has an active writer/i.test(String(message || ""));
}

function shortError(error) {
  return String(error?.message || error || "Unknown agent error").slice(0, 1000);
}
