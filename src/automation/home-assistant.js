const ENTITY_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/u;
const SPEAKER_ID = /^notify\.xiaomi_[a-z0-9_]+_play_text_a_[0-9]+_[0-9]+$/u;
const MAX_SPEECH_LENGTH = 500;
const RULES = {
  light: { turn_on: { brightness_pct: [0, 100], color_temp_kelvin: [1000, 10000], rgb_color: "rgb", effect: "effect_list" }, turn_off: {}, toggle: {} },
  switch: { turn_on: {}, turn_off: {}, toggle: {} },
  cover: { open_cover: {}, close_cover: {}, stop_cover: {}, set_cover_position: { position: [0, 100] } },
  climate: { turn_on: {}, turn_off: {}, set_temperature: { temperature: "temperature" }, set_hvac_mode: { hvac_mode: "hvac_modes" }, set_fan_mode: { fan_mode: "fan_modes" } },
  fan: { turn_on: {}, turn_off: {}, set_percentage: { percentage: [0, 100] } },
  media_player: { media_play: {}, media_pause: {}, media_stop: {}, volume_set: { volume_level: [0, 1] } },
  button: { press: {} },
  number: { set_value: { value: "value" } },
  select: { select_option: { option: "options" } }
};
const REQUIRED = { set_cover_position: "position", set_temperature: "temperature", set_hvac_mode: "hvac_mode", set_fan_mode: "fan_mode", set_percentage: "percentage", volume_set: "volume_level", set_value: "value", select_option: "option" };
const ATTRIBUTES = ["brightness", "color_temp_kelvin", "min_color_temp_kelvin", "max_color_temp_kelvin", "supported_color_modes", "effect_list", "current_position", "temperature", "current_temperature", "min_temp", "max_temp", "hvac_modes", "fan_modes", "min", "max", "step", "unit_of_measurement", "options", "volume_level", "percentage"];
function denied(message, code = "HOME_ASSISTANT_DENIED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// The model understands references and intent; these are only obvious write vetoes.
// Identity, message scope and device capabilities remain enforced separately.
function assertActionRequest(text, { speech = false } = {}) {
  const instruction = speech ? String(text || "").split(/[:：]/u, 1)[0] : String(text || "");
  if (!instruction.trim()
    || /(?:不要|不用|无需|不需要|禁止|(?<!分|特|区|辨|识)别)[^，。！？\n]{0,16}(?:开|关|调|设置|控制|拉|停|播|说|念|喊|读|发言|讲|提醒|闪|执行|运行)/u.test(instruction)
    || /(?:现在|目前).{0,16}(?:开|关|亮|状态).{0,8}[吗？?]|是否|有没有|什么状态|开着|关着|(?:我|已经|刚才|刚刚|今天|之前|昨天).{0,12}(?:开了|关了|调了|设置了)/u.test(instruction)) {
    denied("当前消息是在否定控制、查询状态或叙述过往操作；可以查询设备，但不能据此执行控制或播报。", "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
  }
}

/** A model-supplied identity or a message in quoted/source context is not authorization. */
export function homeAssistantRequest({ store, messageReader, targetId, targetType = "group", ownerId, messageId, scheduledTask = false }) {
  const message = (messageReader?.directMessages || messageReader?.messages)?.get(String(messageId || ""));
  const snapshot = store.snapshot(targetId);
  const pending = snapshot.pendingMessages;
  const permission = snapshot.codexConfig?.homeAssistantPermission || "owner";
  const isOwner = ownerId && String(message?.senderId) === String(ownerId) && message?.trust === "OWNER";
  const isGroupMember = permission === "group" && targetType === "group" && message?.source === "qq"
    && /^[1-9][0-9]{4,13}$/u.test(String(message.senderId || ""));
  const ageMs = Date.now() - Date.parse(message?.receivedAt || "");
  if (scheduledTask || !["owner", "group"].includes(permission) || permission === "group" && targetType !== "group" || !message || !(isOwner || isGroupMember)
    || String(message.groupId) !== String(targetId)
    || !["qq", "codex-ui"].includes(message.source) || !(Number(message.sequence) > 0)
    || !Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > 15 * 60_000
    || !pending.some((item) => String(item.messageId) === String(message.messageId))
    || store.isRecalled?.(targetId, message.messageId)) {
    denied("家居权限未满足：须使用当前会话已读、仍待处理的获准成员直接消息；关闭权限、跨会话、引用、过期或撤回消息以及定时任务不能授权。这不是 HA 连接失败。", "HOME_ASSISTANT_PERMISSION_DENIED");
  }
  return message;
}

export const ownerHomeRequest = homeAssistantRequest;

export class HomeAssistantClient {
  constructor({ baseUrl = "", token = "", enabled = false, allowedButtons = [], allowedSpeakers = [], fetchImpl = fetch, timeoutMs = 3000 } = {}) {
    this.enabled = Boolean(enabled);
    this.token = String(token).trim();
    this.baseUrl = String(baseUrl).trim().replace(/\/+$/u, "");
    if (this.baseUrl) {
      const url = new URL(this.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Home Assistant 地址须为不含凭证、路径或查询参数的 HTTP/HTTPS 根地址。");
    }
    this.allowedButtons = new Set(allowedButtons);
    const speakers = typeof allowedSpeakers === "string" ? allowedSpeakers.split(",").map((value) => value.trim()).filter(Boolean) : allowedSpeakers;
    if (!Array.isArray(speakers) || speakers.some((value) => typeof value !== "string" || !SPEAKER_ID.test(value))) throw new Error("小爱发言白名单只能包含 Xiaomi 播放文本实体；执行文本指令等入口不可配置。");
    this.allowedSpeakers = new Set(speakers);
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(100, Math.min(3000, Number(timeoutMs) || 3000));
    this.services = null;
    this.servicesAt = 0;
  }

  async request(path, { method = "GET", body } = {}) {
    if (!this.enabled || !this.baseUrl || !this.token) denied("智能家居未配置或专用访问凭证缺失。");
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, { method, redirect: "error",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      const error = new Error(method === "POST" ? "Home Assistant 控制请求中断，执行状态未知；不得自动重试。" : "Home Assistant 暂时无法访问，未发出控制指令。");
      error.code = method === "POST" ? "HOME_ASSISTANT_UNCERTAIN" : "HOME_ASSISTANT_OFFLINE";
      throw error;
    }
    if (!response.ok) throw new Error(`Home Assistant 返回 HTTP ${response.status}，未确认操作成功。`);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error("Home Assistant 响应超过安全大小限制。");
    try { return JSON.parse(text); } catch { throw new Error("Home Assistant 响应不是有效 JSON；操作结果未确认。"); }
  }

  actionsFor(state) {
    const domain = state.entity_id.split(".")[0];
    if (domain === "button" && !this.allowedButtons.has(state.entity_id)) return [];
    return Object.keys(RULES[domain] || {});
  }

  fieldsFor(state, service) {
    const domain = state.entity_id.split(".")[0];
    const fields = Object.keys(RULES[domain]?.[service] || {});
    if (domain !== "light") return fields;
    const modes = state.attributes?.supported_color_modes || [];
    return fields.filter((key) => key !== "brightness_pct" || modes.some((mode) => mode !== "onoff"))
      .filter((key) => key !== "color_temp_kelvin" || modes.includes("color_temp"))
      .filter((key) => key !== "rgb_color" || modes.some((mode) => ["rgb", "rgbw", "rgbww", "hs", "xy"].includes(mode)));
  }

  canSpeak(entityId) {
    return SPEAKER_ID.test(String(entityId || "")) && this.allowedSpeakers.has(entityId);
  }

  async loadServices() {
    if (!this.services || Date.now() - this.servicesAt > 60_000) {
      const services = await this.request("/api/services");
      if (!Array.isArray(services)) throw new Error("Home Assistant 服务列表无效。");
      this.services = services;
      this.servicesAt = Date.now();
    }
    return this.services;
  }

  describe(state) {
    const attributes = Object.fromEntries(ATTRIBUTES.filter((key) => state.attributes?.[key] != null).map((key) => [key, state.attributes[key]]));
    const services = this.actionsFor(state);
    const domain = state.entity_id.split(".")[0];
    return { entity_id: state.entity_id, name: String(state.attributes?.friendly_name || state.entity_id).slice(0, 120), state: state.state,
      attributes, services,
      service_data: Object.fromEntries(services.map((service) => [service, this.fieldsFor(state, service)])),
      ...(this.canSpeak(state.entity_id) ? { speaker: { tool: "speak_home_speaker", fields: ["entity_id", "text"], max_text_length: MAX_SPEECH_LENGTH },
        note: "小爱发言须使用独立发言工具；成功仅表示 HA 接受文本播放，不能核实实际声音。" } : {}),
      ...(domain === "button" || /(?:^|_)ir(?:_|$)/u.test(state.entity_id) || state.attributes?.assumed_state === true
        || ["select", "number"].includes(domain) && state.state === "unknown"
        ? { note: "此实体没有可核实的设备状态反馈；服务成功只能说明指令已送出。" } : {}) };
  }

  async read({ query = "", entity_id, domain, offset = 0, limit = 10 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20 || typeof query !== "string" || query.length > 80) denied("查询参数无效；limit 须为 1–20。");
    if (entity_id && !ENTITY_ID.test(entity_id)) denied("entity_id 格式无效。");
    const readable = new Set([...Object.keys(RULES), "sensor", "binary_sensor", "notify"]);
    if (domain && !readable.has(domain)) denied("仅可查询家居设备和传感器，不能读取人员位置、摄像头或系统配置。");
    if (entity_id && !readable.has(entity_id.split(".")[0])) denied("此实体不在家居设备与传感器读取范围内。");
    if (entity_id?.startsWith("notify.") && !this.canSpeak(entity_id)) denied("只能查询已配置的小爱播放文本实体，不能读取或使用任意通知及执行指令入口。");
    const raw = entity_id ? [await this.request(`/api/states/${encodeURIComponent(entity_id)}`)] : await this.request("/api/states");
    if (!Array.isArray(raw)) throw new Error("Home Assistant 设备列表无效。");
    const values = raw.filter((state) => readable.has(String(state.entity_id).split(".")[0])
      && (!String(state.entity_id).startsWith("notify.") || this.canSpeak(state.entity_id))
      && (!domain || state.entity_id.startsWith(domain + "."))
      && `${state.entity_id} ${state.attributes?.friendly_name || ""}`.toLowerCase().includes(query.toLowerCase()));
    return { total: values.length, offset, next_offset: offset + limit < values.length ? offset + limit : null, devices: values.slice(offset, offset + limit).map((state) => this.describe(state)) };
  }

  async control({ entity_id, service, data = {} }, { ownerText, beforeSend = () => {} } = {}) {
    if (!ENTITY_ID.test(String(entity_id || ""))) denied("entity_id 格式无效。");
    assertActionRequest(ownerText);
    const domain = entity_id.split(".")[0];
    const domainRules = Object.hasOwn(RULES, domain) ? RULES[domain] : null;
    const rules = domainRules && Object.hasOwn(domainRules, service) ? domainRules[service] : null;
    if (!rules || domain === "button" && !this.allowedButtons.has(entity_id)) denied("该设备或服务不在家居控制白名单中；系统重启、脚本、安防与任意服务均不可调用。");
    // Reject an explicitly opposite request, not the absence of magic verbs.
    const opening = /打开|开灯|开启|开起来|点亮|拉开/u;
    const closing = /关闭|关灯|关掉|关上|熄灯|熄灭/u;
    const opens = service === "turn_on" || service === "open_cover" || service === "press" && /_turn_on_/u.test(entity_id);
    const closes = service === "turn_off" || service === "close_cover" || service === "press" && /_turn_off_/u.test(entity_id);
    if ((opens && closing.test(ownerText) && !opening.test(ownerText) || closes && opening.test(ownerText) && !closing.test(ownerText))
      && !(domain === "light" && /灯光秀|闪烁|闪动|渐变/u.test(ownerText))) denied("请求与这项开关操作相反；不能把关灯请求当作开灯授权。", "HOME_ASSISTANT_ACTION_NOT_REQUESTED");
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((key) => !Object.hasOwn(rules, key))) denied("控制参数含未获准字段，不能覆盖实体、目标、区域或服务。");
    if (REQUIRED[service] && data[REQUIRED[service]] == null) denied(`此服务须提供 ${REQUIRED[service]}。`);
    const state = await this.request(`/api/states/${encodeURIComponent(entity_id)}`);
    if (state.entity_id !== entity_id || state.state === "unavailable") denied("设备不可用或实体无法核实，不发送控制指令。");
    if (["garage", "door", "gate"].includes(state.attributes?.device_class)) denied("门、车库与安防设备不在默认控制范围内。");
    const supportedFields = this.fieldsFor(state, service);
    if (Object.keys(data).some((key) => !supportedFields.includes(key))) denied("控制参数不是此设备支持的能力；仅色温灯不能使用 RGB，开关灯不能调亮度。");
    for (const [key, value] of Object.entries(data)) {
      let rule = rules[key];
      if (rule === "value") rule = [Number(state.attributes?.min), Number(state.attributes?.max)];
      if (rule === "temperature") rule = [Number(state.attributes?.min_temp), Number(state.attributes?.max_temp)];
      if (key === "color_temp_kelvin") rule = [Number(state.attributes?.min_color_temp_kelvin), Number(state.attributes?.max_color_temp_kelvin)];
      if (Array.isArray(rule)) {
        if (typeof value !== "number" || !Number.isFinite(value) || !rule.every(Number.isFinite) || value < rule[0] || value > rule[1]) denied(`${key} 超出设备支持的范围。`);
      } else if (rule === "rgb") {
        if (!Array.isArray(value) || value.length !== 3 || value.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) denied("rgb_color 须为三个 0–255 整数。");
      } else if (!Array.isArray(state.attributes?.[rule]) || !state.attributes[rule].includes(value)) denied(`${key} 不是设备支持的选项。`);
    }
    const services = await this.loadServices();
    if (!services.some((item) => item.domain === domain && Object.hasOwn(item.services || {}, service))) denied("Home Assistant 当前没有提供此设备服务。");
    await beforeSend();
    await this.request(`/api/services/${domain}/${service}`, { method: "POST", body: { ...data, entity_id } });
    let after = null;
    try { after = await this.request(`/api/states/${encodeURIComponent(entity_id)}`); } catch { /* accepted command must not be retried because the independent read failed */ }
    const hasFeedback = after && !["unknown", "unavailable"].includes(after.state) && domain !== "button"
      && !/(?:^|_)ir(?:_|$)/u.test(entity_id) && after.attributes?.assumed_state !== true;
    return { accepted: true, entity_id, service, ...(after ? { observed: this.describe(after) } : {}),
      confirmation: hasFeedback ? "指令已接受；以下为独立回读的 HA 状态，并非物理效果保证。" : "指令已接受，但无法核实设备实际状态；不要自动重试。" };
  }

  async speak({ entity_id, text }, { requestText, beforeSend = () => {} } = {}) {
    if (requestText != null) assertActionRequest(requestText, { speech: true });
    if (typeof entity_id !== "string" || !this.canSpeak(entity_id)) denied("发言只能指向已配置的小爱播放文本实体，不能执行小爱指令或发送其他通知。");
    if (typeof text !== "string" || !text.trim() || text.length > MAX_SPEECH_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) denied(`发言文本须为 1–${MAX_SPEECH_LENGTH} 个字符，且不含控制字符。`);
    const state = await this.request(`/api/states/${encodeURIComponent(entity_id)}`);
    if (state.entity_id !== entity_id || state.state === "unavailable") denied("小爱发言实体不可用或无法核实，未发送文本。");
    const services = await this.loadServices();
    if (!services.some((item) => item.domain === "notify" && Object.hasOwn(item.services || {}, "send_message"))) denied("Home Assistant 当前未提供 notify.send_message 发言服务。");
    await beforeSend();
    await this.request("/api/services/notify/send_message", { method: "POST", body: { entity_id, message: text.trim() } });
    return { accepted: true, entity_id, service: "notify.send_message", confirmation: "HA 已接受小爱文本播放指令；无法核实实际声音，请勿自动重复播报。" };
  }
}
