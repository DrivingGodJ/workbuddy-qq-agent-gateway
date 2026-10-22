/** Bounded, process-local diagnostics; never used as chat history or model input. */
export class TurnDiagnostics {
  constructor({ clock = () => Date.now(), limit = 64 } = {}) {
    this.clock = clock;
    this.limit = limit;
    this.turns = new Map();
  }

  start(threadId, { prompt, model, groupId, imagePaths = [] }) {
    const previous = this.turns.get(threadId);
    const calls = Number(previous?.requests || 0) + 1;
    this.turns.delete(threadId);
    this.turns.set(threadId, {
      groupId, model, requests: calls, startedAtMs: this.clock(), finishedAtMs: null,
      stage: "starting", firstTextMs: null, lastProgressAtMs: this.clock(), toolCalls: 0,
      toolName: null, imageCount: imagePaths.length,
      inputChars: String(prompt || "").length,
      // Latest submitted envelope only; no growing copy of QQ history.
      inputPreview: String(prompt || "").slice(0, 32_000),
      inputTruncated: String(prompt || "").length > 32_000,
      usage: null, error: null
    });
    while (this.turns.size > this.limit) this.turns.delete(this.turns.keys().next().value);
  }

  progress(threadId, stage, toolName = null) {
    const entry = this.turns.get(threadId);
    if (!entry || entry.finishedAtMs !== null && stage !== "recovering") return;
    if (stage === "recovering") {
      entry.finishedAtMs = null;
      entry.error = null;
    }
    entry.stage = stage;
    entry.lastProgressAtMs = this.clock();
    entry.toolName = toolName;
    if (stage === "tool" && toolName) entry.toolCalls++;
    if (stage === "text" && entry.firstTextMs === null) entry.firstTextMs = this.clock() - entry.startedAtMs;
  }

  usage(threadId, usage) {
    const entry = this.turns.get(threadId);
    if (!entry) return;
    const count = (key) => Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
    entry.usage = Object.fromEntries(["inputTokens", "cachedTokens", "cacheCreationTokens", "outputTokens", "modelCalls"].map((key) => [key, count(key)]));
  }

  finish(threadId, error = null) {
    const entry = this.turns.get(threadId);
    if (!entry) return;
    entry.finishedAtMs = this.clock();
    entry.stage = error ? "failed" : "complete";
    entry.error = error ? String(error.message || error) : null;
    if (!error) delete entry.inputPreview;
  }

  snapshot(threadId, { includeInput = false } = {}) {
    const entry = structuredClone(this.turns.get(String(threadId)) || null);
    if (entry && !includeInput) delete entry.inputPreview;
    return entry;
  }
}
