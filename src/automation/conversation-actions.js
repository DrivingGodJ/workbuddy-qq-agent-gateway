import { createHash } from "node:crypto";

// Reuse the notification writer and its stable markers, without inventing a source group.
export function conversationAction(args, targetType, targetId) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => !["type", "title", "calendarName", "start", "end", "allDay", "location", "due", "notes"].includes(key))) {
    throw new Error("请提供日历或待办参数，不能指定来源或内部事项 ID。");
  }
  if (!["calendar", "reminder"].includes(args.type) || typeof args.title !== "string"
    || !args.title.trim() || args.title.length > 300) throw new Error("类型须为 calendar/reminder，标题须为 1–300 字。");
  const date = (value, required = false) => {
    if (value == null && !required) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      || Number.isNaN(Date.parse(value))) throw new Error("时间须为含时区的 ISO 时间；未知截止时间用 null，不猜日期。");
    return new Date(value).toISOString();
  };
  const action = { type: args.type, title: args.title.trim() };
  for (const [key, max] of [["notes", 2000], ["location", 500]]) {
    if (args[key] != null && (typeof args[key] !== "string" || args[key].length > max)) throw new Error(`${key} 参数无效或过长。`);
    action[key] = args[key]?.trim() || "";
  }
  if (args.type === "calendar") {
    if (!["学习", "社团", "活动"].includes(args.calendarName)) throw new Error("日历须选择学习、社团或活动。");
    if (args.allDay != null && typeof args.allDay !== "boolean") throw new Error("allDay 须为布尔值。");
    Object.assign(action, { calendarName: args.calendarName, start: date(args.start, true), end: date(args.end), allDay: args.allDay === true });
    if (action.end && action.end < action.start) throw new Error("结束时间不能早于开始时间。");
  } else action.due = date(args.due);
  action.actionId = createHash("sha256").update(JSON.stringify([
    "conversation", targetType, targetId, action.type, action.title,
    action.calendarName || null, action.start || action.due || null
  ])).digest("hex").slice(0, 24);
  return action;
}
