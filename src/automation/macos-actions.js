import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCallback);
const defaultActionScript = fileURLToPath(new URL("../../scripts/macos-notification-action.js", import.meta.url));
const defaultReminderScript = fileURLToPath(new URL("../../scripts/macos-reminder-action.applescript", import.meta.url));

export class MacActionClient {
  constructor({ executable = "/usr/bin/osascript", actionScript = defaultActionScript, reminderScript = defaultReminderScript, execFileImpl = defaultExecFile, timeoutMs = 180_000 } = {}) {
    this.executable = executable;
    this.actionScript = actionScript;
    this.reminderScript = reminderScript;
    this.execFileImpl = execFileImpl;
    this.timeoutMs = timeoutMs;
  }

  async execute(action, { sourceGroupId, sourceGroupName } = {}) {
    const payload = {
      ...action,
      sourceGroupId: String(sourceGroupId || ""),
      sourceGroupName: String(sourceGroupName || "学校通知群"),
      marker: `[WorkBuddyQQ:${action.actionId}]`
    };
    const args = action.type === "reminder"
      ? reminderArguments(this.reminderScript, payload)
      : ["-l", "JavaScript", this.actionScript, JSON.stringify(payload)];
    let stdout = "";
    try {
      ({ stdout = "" } = await this.execFileImpl(this.executable, args, { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }));
    } catch (error) {
      const detail = String(error?.stderr || "").trim();
      if (detail && !String(error.message || "").includes(detail)) error.message = `${error.message}\n${detail}`;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
    } catch {
      parsed = { externalItemId: String(stdout || "").trim() || null };
    }
    return {
      externalItemId: parsed.externalItemId || null,
      result: parsed.result || (action.type === "calendar" ? "日历已写入" : "待办已写入"),
      targetList: parsed.targetList || (action.type === "calendar" ? action.calendarName : "待办")
    };
  }

  async preflight() {
    const { stdout = "" } = await this.execFileImpl(this.executable, [
      "-l",
      "JavaScript",
      this.actionScript,
      JSON.stringify({ type: "preflight" })
    ], { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 });
    return JSON.parse(String(stdout || "{}").trim() || "{}");
  }

  async getContext({ horizonDays = 60, limit = 80, now = new Date() } = {}) {
    const { stdout = "" } = await this.execFileImpl(this.executable, [
      "-l",
      "JavaScript",
      "-e",
      JXA_CONTEXT,
      JSON.stringify({ now: now.toISOString(), horizonDays, limit })
    ], { timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
    return {
      calendar: Array.isArray(parsed.calendar) ? parsed.calendar.slice(0, limit) : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders.slice(0, limit) : []
    };
  }
}

function reminderArguments(scriptPath, payload) {
  const due = payload.due ? new Date(payload.due) : null;
  const validDue = due && !Number.isNaN(due.getTime());
  return [
    scriptPath,
    String(payload.title || ""),
    validDue ? "1" : "0",
    String(validDue ? due.getFullYear() : 0),
    String(validDue ? due.getMonth() + 1 : 0),
    String(validDue ? due.getDate() : 0),
    String(validDue ? due.getHours() : 0),
    String(validDue ? due.getMinutes() : 0),
    String(validDue ? due.getSeconds() : 0),
    String(payload.notes || ""),
    String(payload.marker || ""),
    String(payload.sourceGroupName || "学校通知群"),
    String(payload.sourceGroupId || "")
  ];
}

const JXA_CONTEXT = String.raw`
function safe(callable, fallback) {
  try { return callable(); } catch (_) { return fallback; }
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function run(argv) {
  const p = JSON.parse(argv[0]);
  const now = new Date(p.now);
  const until = new Date(now.getTime() + Math.max(1, Number(p.horizonDays || 60)) * 86400000);
  const limit = Math.max(1, Number(p.limit || 80));
  const output = { calendar: [], reminders: [] };

  const calendarApp = Application("Calendar");
  for (const calendar of safe(() => calendarApp.calendars(), [])) {
    if (output.calendar.length >= limit) break;
    for (const event of safe(() => calendar.events(), [])) {
      const start = safe(() => event.startDate(), null);
      if (!start || start < now || start > until) continue;
      output.calendar.push({
        title: String(safe(() => event.summary(), "")),
        start: iso(start),
        end: iso(safe(() => event.endDate(), null)),
        location: String(safe(() => event.location(), ""))
      });
      if (output.calendar.length >= limit) break;
    }
  }

  const remindersApp = Application("Reminders");
  for (const list of safe(() => remindersApp.lists(), [])) {
    if (output.reminders.length >= limit) break;
    for (const reminder of safe(() => list.reminders(), [])) {
      if (safe(() => reminder.completed(), false)) continue;
      const due = safe(() => reminder.dueDate(), null);
      if (due && due > until) continue;
      output.reminders.push({ title: String(safe(() => reminder.name(), "")), due: iso(due) });
      if (output.reminders.length >= limit) break;
    }
  }
  return JSON.stringify(output);
}
`;
