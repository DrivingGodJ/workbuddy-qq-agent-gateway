const LEGACY_TIMES = { morning: "07:00", noon: "13:00", night: "23:30" };
export const SPEAKER_GREETING_LIMIT = 32;
export const SPEAKER_GREETING_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const SPEAKER_GREETING_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

// Numeric weekdays match getUTCDay: 0 is Sunday and 1 is Monday.
export function normalizeSpeakerGreetings(value, { strict = false } = {}) {
  if (value == null && !strict) return [];
  if (!Array.isArray(value)) {
    if (value && typeof value === "object" && Object.keys(value).length === Object.keys(LEGACY_TIMES).length
      && Object.keys(LEGACY_TIMES).every((key) => typeof value[key] === "boolean")) {
      return Object.entries(LEGACY_TIMES).filter(([id]) => value[id])
        .map(([id, time]) => ({ id, time, days: [0, 1, 2, 3, 4, 5, 6], enabled: true, weather: false }));
    }
    if (strict) throw new Error("小爱定时播报须为计划列表");
    return [];
  }
  if (strict && value.length > SPEAKER_GREETING_LIMIT) throw new Error(`每个会话最多保存 ${SPEAKER_GREETING_LIMIT} 条播报计划`);
  const plans = new Map();
  for (const plan of value.slice(0, SPEAKER_GREETING_LIMIT)) {
    if (!plan || typeof plan.id !== "string" || !SPEAKER_GREETING_ID.test(plan.id) || plans.has(plan.id)
      || typeof plan.time !== "string" || !SPEAKER_GREETING_TIME.test(plan.time)
      || typeof plan.enabled !== "boolean" || typeof plan.weather !== "boolean"
      || !Array.isArray(plan.days) || !plan.days.length || plan.days.length > 7
      || !plan.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      || new Set(plan.days).size !== plan.days.length) {
      if (strict) throw new Error("每条播报计划须有有效的时间、至少一个星期和独立的开关");
      continue;
    }
    plans.set(plan.id, { id: plan.id, time: plan.time, days: [...plan.days].sort((a, b) => a - b), enabled: plan.enabled, weather: plan.weather });
  }
  return [...plans.values()];
}
