import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MacActionClient } from "./automation/macos-actions.js";
import { HomeAssistantClient } from "./automation/home-assistant.js";
import { CodexClient } from "./codex/client.js";
import { WorkBuddyClient } from "./workbuddy/client.js";
import { PersonaStore } from "./persona/persona-store.js";
import { ThreadReservationManager } from "./codex/thread-reservations.js";
import { GroupWorker } from "./groups/group-worker.js";
import { GroupMemberDirectory } from "./qq/group-member-directory.js";
import { toPublicGroupState } from "./groups/group-state.js";
import { TriggerManager } from "./groups/trigger-manager.js";
import { QqFileManager } from "./qq/file-manager.js";
import { QqMediaManager } from "./qq/media-manager.js";
import { QqStickerStore } from "./qq/sticker-store.js";
import { EphemeralStickerLabeler } from "./qq/sticker-labeler.js";
import { AgentTaskGate } from "./qq/agent-task-gate.js";
import { SharedContexts } from "./qq/shared-contexts.js";
import { createSharedContextReader } from "./qq/shared-context-reader.js";
import { TargetUpdateStream } from "./qq/target-update-stream.js";
import { removeGatewayTarget, targetBusyForRemoval } from "./qq/target-removal.js";
import { EphemeralStickerCurator, StickerCurationCoordinator } from "./qq/sticker-curator.js";
import { isUsableStickerDescription } from "./qq/sticker-label.js";
import { QzoneCoordinator } from "./qq/qzone-coordinator.js";
import { SpeakerGreetingCoordinator } from "./qq/speaker-greeting-coordinator.js";
import { normalizeOneBotGroupMessage, normalizeOneBotGroupPoke, normalizeOneBotPrivateMessage, formatLocalTime, renderOneBotMessageText } from "./qq/message-normalizer.js";
import { OneBotClient } from "./qq/onebot-client.js";
import { PrivateWorker } from "./qq/private-worker.js";
import { AGENT_QQ_ID, OWNER_QQ_ID, parseOwnerControlCommand } from "./security/policy.js";
import { SessionStore } from "./storage/session-store.js";
import { AgentDispatchStore } from "./storage/agent-dispatch-store.js";
import { eventMetadata } from "./security/event-metadata.js";
import { StickerLabelSettingsStore } from "./storage/sticker-label-settings-store.js";
import { QzoneStore } from "./qq/qzone-store.js";
import { SubscriptionStore } from "./storage/subscription-store.js";
import { TargetAllowlistSettings } from "./storage/target-allowlist-settings.js";
import { resolvePersonaFiles, validateRuntimeConfig } from "./security/runtime-config.js";

const sourceDir = fileURLToPath(new URL(".", import.meta.url));
const projectDir = resolve(sourceDir, "..");
const publicDir = join(projectDir, "modules", "web-console", "public");
const runtimeDir = process.env.CODEX_REMOTE_CONTACT_RUNTIME_DIR || join(projectDir, "runtime");
const dataDir = process.env.CODEX_REMOTE_CONTACT_DATA_DIR || join(runtimeDir, "qq-only-data");
const sharedDataDir = process.env.CODEX_REMOTE_CONTACT_SHARED_DATA_DIR || join(projectDir, "data");
const settingsPath = join(dataDir, "settings.json");
const sessionStorePath = join(dataDir, "group-sessions.json");
const privateSessionStorePath = join(dataDir, "private-sessions.json");
const subscriptionStorePath = join(dataDir, "subscriptions.json");
const agentDispatchStorePath = join(dataDir, "agent-dispatch.json");
const stickerStorePath = join(dataDir, "stickers.json");
const stickerLabelSettingsPath = join(dataDir, "sticker-label-settings.json");
const stickerCurationPath = join(dataDir, "sticker-curation.json");
const qzoneStorePath = join(dataDir, "qzone.json");
const personaOwnerStylePath = join(dataDir, "persona-owner-style.json");
const { corePath: personaCorePath, examplesPath: personaExamplesPath } = resolvePersonaFiles(
  projectDir, process.env.CODEX_REMOTE_CONTACT_PERSONA_DIR
);
const legacyContextPath = join(sharedDataDir, "qq-owner-agent-context.json");
const mediaRoot = join(runtimeDir, "qq-media");
const stickerLibraryDir = join(runtimeDir, "qq-stickers");
const stickerLabelWorkspaceRoot = join(runtimeDir, "sticker-label-jobs");
const stickerCurationWorkspaceRoot = join(runtimeDir, "sticker-curation-jobs");
const groupWorkspaceRoot = process.env.CODEX_REMOTE_CONTACT_GROUP_WORKSPACE_ROOT || join(runtimeDir, "group-workspaces");

const hubHost = process.env.CODEX_REMOTE_CONTACT_HOST || "127.0.0.1";
const hubPort = Number(process.env.CODEX_REMOTE_CONTACT_PORT || 3789);
const bodyLimit = Math.max(64 * 1024, Number(process.env.CODEX_REMOTE_CONTACT_BODY_LIMIT_BYTES || 4 * 1024 * 1024));
const authDisabled = process.env.CODEX_REMOTE_CONTACT_DISABLE_AUTH === "1";
const configuredApiToken = String(process.env.CODEX_REMOTE_CONTACT_API_TOKEN || "").trim();
const apiToken = authDisabled ? "" : configuredApiToken;
const oneBotAccessToken = String(process.env.ONEBOT_ACCESS_TOKEN || "").trim();
const oneBotCallbackToken = configuredApiToken || oneBotAccessToken;
const oneBotBaseUrl = process.env.ONEBOT_API_BASE || "http://127.0.0.1:3000";
validateRuntimeConfig({ ownerId: OWNER_QQ_ID, botId: AGENT_QQ_ID, host: hubHost,
  authDisabled, apiToken, oneBotToken: oneBotAccessToken });
const codexExecutable = process.env.CODEX_CLI_PATH || [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
].find((candidate) => existsSync(candidate)) || "codex";

const settings = await loadSettings(settingsPath);
const targetAllowlist = new TargetAllowlistSettings({ filePath: settingsPath, settings });
const allowedGroups = targetAllowlist.list("group");

// 引擎选择：默认换成 WorkBuddy，可用 CODEX_REMOTE_CONTACT_ENGINE=codex 回退。
// 传输层（QQ 队列 / 订阅 / 投递确认 / UI 状态）两者共用，接口同构。
const engineKind = String(process.env.CODEX_REMOTE_CONTACT_ENGINE || "workbuddy").toLowerCase() === "codex"
  ? "codex"
  : "workbuddy";
const WORKBUDDY_DEFAULT_MODEL = process.env.CODEX_REMOTE_CONTACT_WB_MODEL || "auto";
const looksLikeCodexModelName = (name) => /^(gpt-|o[0-9])/i.test(String(name || ""));
const configuredModel = process.env.CODEX_REMOTE_CONTACT_CODEX_MODEL || settings.ai?.model || null;
// 换引擎就换了模型命名空间：settings 里存的 gpt-* 在 WorkBuddy 上不存在，
// 这种情况下退回 WorkBuddy 的默认模型（null 表示交给 CLI 自己选）。
const codexModel = engineKind === "workbuddy"
  ? (configuredModel && !looksLikeCodexModelName(configuredModel) ? configuredModel : WORKBUDDY_DEFAULT_MODEL)
  : (configuredModel || "gpt-5.6-luna");
const codexEffort = process.env.CODEX_REMOTE_CONTACT_REASONING_EFFORT || settings.ai?.reasoningEffort || "low";
const configuredAutoCompactTokenLimit = Number(process.env.CODEX_REMOTE_CONTACT_AUTO_COMPACT_TOKEN_LIMIT || settings.ai?.autoCompactTokenLimit || 0);
const codexAutoCompactTokenLimit = Number.isFinite(configuredAutoCompactTokenLimit) && configuredAutoCompactTokenLimit > 0
  ? Math.max(10_000, Math.floor(configuredAutoCompactTokenLimit))
  : null;
const configuredAutoCompactScope = String(process.env.CODEX_REMOTE_CONTACT_AUTO_COMPACT_TOKEN_SCOPE || settings.ai?.autoCompactTokenScope || "total");
const codexAutoCompactTokenScope = ["total", "body_after_prefix"].includes(configuredAutoCompactScope)
  ? configuredAutoCompactScope
  : "total";
const contextTokenOptions = engineKind === "workbuddy"
  ? [
      { value: "auto", label: "自动 · 跟随模型", description: "由 WorkBuddy 按当前模型的上下文窗口自动压缩" },
      { value: 100_000, label: "最短 · 100K", description: "WorkBuddy CLI 允许的最小压缩阈值" },
      { value: 200_000, label: "轻量 · 200K", description: "较早压缩，适合日常对话" },
      { value: 400_000, label: "平衡 · 400K", description: "保留较多近期细节" },
      { value: 600_000, label: "较长 · 600K", description: "较长任务使用，单轮处理可能更慢" },
      { value: 800_000, label: "长 · 800K", description: "长任务使用，可能增加耗时与用量" },
      { value: 1_000_000, label: "最长 · 1M", description: "WorkBuddy CLI 允许的最大压缩阈值" }
    ]
  : [
      { value: 32_000, label: "省量 · 32K", description: "更早压缩；压缩后的新增上下文按 32K 计量，不是总输入硬上限" },
      { value: 64_000, label: "轻量 · 64K", description: "适合通知和日常对话；压缩后的新增上下文按 64K 计量" },
      { value: 100_000, label: "精简 · 100K", description: "更早压缩，适合日常短对话" },
      { value: 200_000, label: "平衡 · 200K", description: "保留更多近期细节，当前默认" },
      { value: 400_000, label: "充足 · 400K", description: "更长历史，单轮处理可能更慢" }
    ];
const permissionModeOptions = [
  { value: "readOnly", label: "只读分析", description: "可读取和分析，不修改文件或外部状态", targetTypes: ["group", "private"] },
  { value: "workspaceWrite", label: "工作区写入", description: "可在当前目标工作区内创建、修改和运行文件", targetTypes: ["group", "private"] },
  { value: "dangerFullAccess", label: "完全访问", description: "可操作整台 Mac 并发送本机文件；群聊启用后所有群成员的触发消息都会获得此权限", targetTypes: ["group", "private"] }
];
const homeAssistantPermissionOptions = [
  { value: "disabled", label: "关闭", description: "这个会话不能读取或控制智能家居，也不能让小爱音箱说话", targetTypes: ["group", "private"] },
  { value: "owner", label: "仅 OWNER（你本人）", description: "只接受你本人在当前会话发出的家居和音箱请求；其他成员不能授权", targetTypes: ["group", "private"] },
  { value: "group", label: "全群成员", description: "本群成员都可请求读取、控制已开放的家居设备或让小爱音箱说话；不开放 HA 账号和系统设置", targetTypes: ["group"] }
];
const defaultCodexConfig = {
  model: codexModel,
  reasoningEffort: codexEffort,
  contextTokenLimit: engineKind === "workbuddy"
    ? normalizeWorkBuddyContextLimit(codexAutoCompactTokenLimit || 200_000)
    : (codexAutoCompactTokenLimit || 200_000),
  workingMode: "agent",
  permissionMode: "workspaceWrite",
  calendarRemindersEnabled: false,
  homeAssistantPermission: "owner",
  speakerGreetings: { morning: false, noon: false, night: false }
};
const codexExecutableArgs = codexAutoCompactTokenLimit == null ? [] : [
  "-c", `model_auto_compact_token_limit=${codexAutoCompactTokenLimit}`,
  "-c", `model_auto_compact_token_limit_scope=${JSON.stringify(codexAutoCompactTokenScope)}`
];
const periodicTriggerMinutes = Math.max(1, Number(settings.qq?.triggerPolicy?.periodicMinutes || 10));
const qzoneScheduleTimes = String(process.env.CODEX_REMOTE_CONTACT_QZONE_POST_SCHEDULE || process.env.CODEX_REMOTE_CONTACT_QQ_SCHEDULE
  || (settings.qq?.qzonePostSchedule || settings.qq?.triggerPolicy?.schedule || ["08:00", "12:00", "18:00"]).join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const store = new SessionStore({ filePath: sessionStorePath, defaultCodexConfig });
await store.init({ allowedGroups, legacyContextPath });
const subscriptionStore = new SubscriptionStore({ filePath: subscriptionStorePath });
await subscriptionStore.init();
const agentDispatchStore = new AgentDispatchStore({ filePath: agentDispatchStorePath });
await agentDispatchStore.init();
const stickerLabelSettingsStore = new StickerLabelSettingsStore({
  filePath: stickerLabelSettingsPath,
  defaultModel: "hy3"
});
await stickerLabelSettingsStore.init();
const qzoneStore = new QzoneStore({ filePath: qzoneStorePath });
await qzoneStore.init();
// Finish any interrupted removal before deriving subscription targets.
for (const type of ["group", "private"]) {
  for (const id of targetAllowlist.removed(type)) {
    await subscriptionStore.removeTarget(type, id);
    if (type === "group") await store.removeConversation(id);
  }
}
const initialQzoneBinding = qzoneStore.snapshot();
if (initialQzoneBinding.targetType && targetAllowlist.isRemoved(initialQzoneBinding.targetType, initialQzoneBinding.targetId)) {
  await qzoneStore.configure({});
}
const sourceTargetCollisions = subscriptionStore.sourceGroupIds().filter((groupId) => allowedGroups.includes(groupId));
if (sourceTargetCollisions.length) throw new Error(`A QQ group cannot be both AGENT_CHAT_GROUP and READ_ONLY_SOURCE_GROUP: ${sourceTargetCollisions.join(", ")}`);

const groupMemberDirectory = new GroupMemberDirectory({ rootDir: groupWorkspaceRoot });
for (const group of store.listGroups().filter((item) => allowedGroups.includes(item.groupId))) {
  await groupMemberDirectory.initGroup(group.groupId, group.pendingMessages || [])
    .catch((error) => console.warn(`QQ member directory initialization failed for ${group.groupId}: ${error.message}`));
}
const sourceMemberSnapshot = subscriptionStore.snapshot();
for (const groupId of subscriptionStore.sourceGroupIds()) {
  const source = sourceMemberSnapshot.sources[groupId];
  await groupMemberDirectory.initGroup(groupId, [...(source?.messages || []), ...(source?.recentMessages || [])])
    .catch((error) => console.warn(`QQ source member directory initialization failed for ${groupId}: ${error.message}`));
}

const configuredPrivateIds = uniqueStrings([OWNER_QQ_ID, ...targetAllowlist.list("private"), ...subscriptionStore.privateTargetIds()])
  .filter((id) => !targetAllowlist.isRemoved("private", id));
const privateStore = new SessionStore({ filePath: privateSessionStorePath, defaultCodexConfig });
await privateStore.init({ allowedGroups: configuredPrivateIds });
for (const id of targetAllowlist.removed("private")) await privateStore.removeConversation(id);
const personaStore = new PersonaStore({
  corePath: personaCorePath,
  examplesPath: personaExamplesPath,
  ownerStylePath: personaOwnerStylePath
});
await personaStore.init();
if (engineKind === "workbuddy") {
  await migrateWorkBuddyConversationConfigs(store);
  await migrateWorkBuddyConversationConfigs(privateStore);
}

const oneBot = new OneBotClient({
  baseUrl: oneBotBaseUrl, accessToken: oneBotAccessToken, readOnlyGroupIds: subscriptionStore.sourceGroupIds(),
  fileUploadTimeoutMs: Number(process.env.CODEX_REMOTE_CONTACT_QQ_FILE_UPLOAD_TIMEOUT_MS || settings.qq?.files?.uploadTimeoutMs || 6 * 60 * 60 * 1000),
  canReply: (type, id) => {
    assertTarget(type, id);
    (type === "private" ? privateStore : store).assertReplyEnabled(id);
    return true;
  }
});
const groupMetadata = Object.fromEntries(allowedGroups.map((groupId) => [groupId, { groupId, groupName: null }]));
const availableGroupMetadata = {};
const privateMetadata = Object.fromEntries(privateStore.listGroups().map((item) => [item.groupId, { displayName: item.groupId === OWNER_QQ_ID ? "OWNER" : null }]));
const mentionNameCache = new Map();
const fileManager = new QqFileManager({
  oneBot,
  dockerPath: process.env.CODEX_REMOTE_CONTACT_DOCKER_PATH || "/opt/homebrew/bin/docker",
  dockerContext: process.env.CODEX_REMOTE_CONTACT_DOCKER_CONTEXT || "colima-snowluma",
  container: process.env.CODEX_REMOTE_CONTACT_SNOWLUMA_CONTAINER || "snowluma",
  stagingRoot: process.env.CODEX_REMOTE_CONTACT_QQ_FILE_STAGING_ROOT || "/tmp/codexremotecontact-qq-files",
  maxFileBytes: Number(process.env.CODEX_REMOTE_CONTACT_QQ_FILE_MAX_BYTES || settings.qq?.files?.maxFileBytes || 1024 * 1024 * 1024),
  maxImageBytes: Number(process.env.CODEX_REMOTE_CONTACT_QQ_IMAGE_SEND_MAX_BYTES || settings.qq?.files?.maxImageBytes || 20 * 1024 * 1024)
});
// QQ may still be booting. Staging cleanup must not prevent the panel from
// starting; retry later and share the same initialization with outbound jobs.
const initializeFileStaging = () => fileManager.init().catch((error) => {
  console.warn(`QQ file staging initialization deferred: ${error.message}`);
});
await initializeFileStaging();
const fileStagingInitTimer = setInterval(initializeFileStaging, 60_000);
fileStagingInitTimer.unref();
const mediaManager = new QqMediaManager({
  rootDir: mediaRoot,
  maxImageBytes: Number(process.env.CODEX_REMOTE_CONTACT_QQ_IMAGE_MAX_BYTES || settings.qq?.media?.maxImageBytes || 20 * 1024 * 1024),
  maxAttachmentBytes: Number(process.env.CODEX_REMOTE_CONTACT_QQ_ATTACHMENT_MAX_BYTES || settings.qq?.media?.maxAttachmentBytes || 1024 * 1024 * 1024),
  orphanTtlMs: Number(process.env.CODEX_REMOTE_CONTACT_QQ_MEDIA_TTL_MS || Number(settings.qq?.media?.orphanTtlDays || 7) * 24 * 60 * 60 * 1000)
});
await mediaManager.init();
const stickerManager = new QqStickerStore({
  filePath: stickerStorePath,
  libraryDir: stickerLibraryDir,
  oneBot,
  fileManager,
  maxPromptItems: Number(process.env.CODEX_REMOTE_CONTACT_QQ_STICKER_PROMPT_LIMIT || settings.qq?.stickers?.promptLimit || 24)
});
await stickerManager.init();
const removedInvalidStickers = await stickerManager.removeInvalidEntries();
if (removedInvalidStickers.length) {
  console.warn(`Removed ${removedInvalidStickers.length} QQ sticker entries with invalid or empty labels: ${removedInvalidStickers.map((item) => item.id).join(", ")}`);
}
await stickerManager.retryPendingFavorites().catch((error) => {
  console.warn(`QQ sticker favorite recovery failed: ${error.message}`);
});

const agentTimeoutMs = Number(process.env.CODEX_REMOTE_CONTACT_QQ_AGENT_TIMEOUT_MS || 10 * 60 * 1000);
const codex = engineKind === "codex"
  ? new CodexClient({
      executable: codexExecutable,
      executableArgs: codexExecutableArgs,
      cwd: projectDir,
      model: codexModel,
      effort: codexEffort,
      timeoutMs: agentTimeoutMs
    })
  : new WorkBuddyClient({
      // python / bridgePath 默认取 CODEX_REMOTE_CONTACT_WB_PYTHON 与模块内路径
      cwd: projectDir,
      model: codexModel,
      effort: codexEffort,
      systemPrompt: personaStore.systemPromptForClient(),
      timeoutMs: agentTimeoutMs,
      onTurnEvent: (event) => recordEvent({ ...event, at: new Date().toISOString() })
    });
console.log(`agent engine: ${engineKind} (model=${codexModel}, effort=${codexEffort})`);
let codexModels = engineKind === "workbuddy"
  ? fallbackWorkBuddyModels(codexModel, codexEffort)
  : fallbackCodexModels(codexModel, codexEffort);
const automationClient = new MacActionClient();
const stickerLabeler = new EphemeralStickerLabeler({
  codex,
  stickerManager,
  workspaceRoot: stickerLabelWorkspaceRoot,
  getSettings: () => stickerLabelSettingsStore.snapshot(),
  onEvent: recordEvent
});
await stickerLabeler.init();

const sseClients = new Set();
const recentEvents = [];
const removingTargets = new Set();
const contextLinkChanges = new Set();
const targetUpdateStream = new TargetUpdateStream({ emit: publishTargetUpdate });
const triggerManager = new TriggerManager({ store, allowedGroups, periodicMinutes: periodicTriggerMinutes });
const privateTriggerManager = new TriggerManager({ store: privateStore, allowedGroups: null });
const taskGate = new AgentTaskGate();
let sharedContextsReady = false;
const sharedContexts = new SharedContexts({
  filePath: join(dataDir, "context-links.json"), groupStore: store, privateStore,
  groupWorkspace: (id) => join(groupWorkspaceRoot, String(id)),
  onChange: () => { if (sharedContextsReady) broadcast({ type: "context-queue", state: publicState() }); },
  onIdle: resumeSharedContextTarget
});
await sharedContexts.init();
for (const [id, groupId] of Object.entries(sharedContexts.state.privateGroups)) {
  if (!allowedGroups.includes(groupId) || !privateStore.listGroups().some((item) => item.groupId === id)
    || targetAllowlist.isRemoved("private", id)) throw new Error("共享上下文指向未启用的群或私聊，请先修正 context-links.json");
}
const homeAssistant = new HomeAssistantClient({
  enabled: process.env.CODEX_REMOTE_CONTACT_HA_ENABLED === "1",
  baseUrl: process.env.CODEX_REMOTE_CONTACT_HA_BASE_URL || "",
  token: process.env.CODEX_REMOTE_CONTACT_HA_TOKEN || "",
  allowedButtons: uniqueStrings(String(process.env.CODEX_REMOTE_CONTACT_HA_ALLOWED_BUTTONS || "").split(",")),
  allowedSpeakers: uniqueStrings(String(process.env.CODEX_REMOTE_CONTACT_HA_ALLOWED_SPEAKERS || "").split(","))
});
const speakerGreetingsAvailable = homeAssistant.enabled && Boolean(homeAssistant.baseUrl && homeAssistant.token && homeAssistant.allowedSpeakers.size);
const worker = new GroupWorker({
  store, codex, oneBot, mediaManager, fileManager, stickerManager, stickerLabeler, triggerManager, subscriptionStore, automationClient, persona: personaStore,
  homeAssistant,
  targetNameResolver: (groupId) => groupMetadata[groupId]?.groupName || null,
  knownMemberIds: (groupId) => groupMemberDirectory.knownMemberIds(groupId),
  sharedWorkspaceRoot: groupWorkspaceRoot,
  taskGate,
  canRun: (id) => agentDispatchStore.isEnabled() && allowedGroups.includes(String(id)) && !removingTargets.has(`group:${id}`)
    && !contextLinkChanges.has(`group:${id}`) && !sharedContexts.isCancelled("group", id),
  onEvent: recordEvent
});
const privateWorker = new PrivateWorker({
  store: privateStore, codex, oneBot, mediaManager, fileManager, stickerManager, stickerLabeler, triggerManager: privateTriggerManager, subscriptionStore, automationClient, persona: personaStore,
  homeAssistant,
  targetNameResolver: (userId) => privateMetadata[userId]?.displayName || null,
  taskGate,
  canRun: (id) => agentDispatchStore.isEnabled() && !targetAllowlist.isRemoved("private", id) && !removingTargets.has(`private:${id}`)
    && !contextLinkChanges.has(`private:${id}`) && !sharedContexts.isCancelled("private", id),
  onEvent: recordEvent
});
for (const targetWorker of [worker, privateWorker]) {
  targetWorker.sharedContexts = sharedContexts;
  targetWorker.readSharedContextFor = (targetType, targetId) => createSharedContextReader({
    sharedContexts, groupStore: store, privateStore, targetType, targetId,
    groupNameResolver: (id) => groupMetadata[id]?.groupName,
    privateNameResolver: (id) => privateMetadata[id]?.displayName,
    canRead: (type, id) => targetWorker.canRun(targetId) && (type === "group"
      ? allowedGroups.includes(id) : privateStore.listGroups().some((item) => item.groupId === id) && !targetAllowlist.isRemoved("private", id))
  });
}
const qzone = new QzoneCoordinator({
  store: qzoneStore, oneBot, fileManager, groupStore: store, privateStore,
  groupWorker: worker, privateWorker, scheduleTimes: qzoneScheduleTimes,
  canRun: () => agentDispatchStore.isEnabled(), onEvent: recordEvent,
  onActivityChange: () => broadcast({ type: "qzone-activity", state: publicState() })
});
worker.qzone = qzone;
privateWorker.qzone = qzone;
const speakerGreetings = new SpeakerGreetingCoordinator({
  filePath: join(dataDir, "speaker-greetings.json"), homeAssistant,
  listTargets: () => [
    ...store.listGroups().filter((item) => allowedGroups.includes(item.groupId) && !removingTargets.has(`group:${item.groupId}`))
      .map((item) => ({ type: "group", id: item.groupId, store, worker })),
    ...privateStore.listGroups().filter((item) => !targetAllowlist.isRemoved("private", item.groupId) && !removingTargets.has(`private:${item.groupId}`))
      .map((item) => ({ type: "private", id: item.groupId, store: privateStore, worker: privateWorker }))
  ],
  canRun: () => agentDispatchStore.isEnabled(), onEvent: recordEvent,
  onActivityChange: () => broadcast({ type: "speaker-greeting-activity", state: publicState() })
});
await speakerGreetings.init();
const stickerCuration = new StickerCurationCoordinator({
  filePath: stickerCurationPath, stickerManager, gate: taskGate,
  selector: new EphemeralStickerCurator({ codex, workspaceRoot: stickerCurationWorkspaceRoot,
    getSettings: () => stickerLabelSettingsStore.snapshot(), canRun: () => agentDispatchStore.isEnabled() }),
  canRun: () => agentDispatchStore.isEnabled(), onEvent: recordEvent
});
await stickerCuration.init();
triggerManager.setWorker(worker);
privateTriggerManager.setWorker(privateWorker);
triggerManager.start();

const threadReservations = new ThreadReservationManager({
  codex,
  listTargets: reservationTargets,
  intervalMs: Number(process.env.CODEX_REMOTE_CONTACT_THREAD_LOCK_INTERVAL_MS || 15_000),
  onChange: () => broadcast({ type: "thread-reservations", state: publicState() })
});
await threadReservations.start();
sharedContextsReady = true;
qzone.start();
stickerCuration.start();
speakerGreetings.start();

const seenMessages = new Map();
const seenTtlMs = 10 * 60 * 1000;
for (const group of store.listGroups()) {
  if (allowedGroups.includes(group.groupId)) {
    worker.recoverStickerLabels(group.groupId).catch((error) => console.warn(`QQ sticker recovery failed for ${group.groupId}: ${error.message}`));
    recoverConversation(group, triggerManager);
  }
}
for (const conversation of privateStore.listGroups()) {
  privateWorker.recoverStickerLabels(conversation.groupId).catch((error) => console.warn(`Private sticker recovery failed for ${conversation.groupId}: ${error.message}`));
  recoverConversation(conversation, privateTriggerManager);
}

const recoveredRateLimitWindows = new Map();
const subscriptionTimer = setInterval(() => {
  checkSubscriptionSchedule().catch((error) => console.warn(`Subscription scheduler failed: ${error.message}`));
  checkRateLimitRecovery().catch((error) => console.warn(`Model quota recovery failed: ${error.message}`));
  checkSharedContextFollowups().catch((error) => console.warn(`Shared context followup failed: ${error.message}`));
}, 2000);
subscriptionTimer.unref?.();
await checkSubscriptionSchedule();
await checkRateLimitRecovery();

mediaManager.cleanupOrphans(referencedMedia()).catch((error) => console.warn(`QQ media cleanup failed: ${error.message}`));
const mediaCleanupTimer = setInterval(() => {
  mediaManager.cleanupOrphans(referencedMedia()).catch((error) => console.warn(`QQ media cleanup failed: ${error.message}`));
}, 6 * 60 * 60 * 1000);
mediaCleanupTimer.unref?.();
refreshGroupMetadata().catch((error) => console.warn(`QQ group metadata refresh failed: ${error.message}`));
const groupMetadataTimer = setInterval(() => {
  refreshGroupMetadata().catch((error) => console.warn(`QQ group metadata refresh failed: ${error.message}`));
}, 10 * 60 * 1000);
groupMetadataTimer.unref?.();

const server = createServer(async (req, res) => {
  try {
    const url = requestUrl(req);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: String(error?.message || error) });
    else res.end();
  }
});

server.listen(hubPort, hubHost, () => console.log(`codexremotecontact QQ Agent gateway: http://${hubHost}:${hubPort}`));
refreshCodexModels().catch((error) => console.warn(`Unable to refresh Codex model catalog: ${error.message}`));

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  const rawBody = req.method === "POST" ? await readRawBody(req) : null;
  if (!isAuthorized(req, url.pathname, rawBody)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (req.method === "POST" && !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, publicState());
    return;
  }
  const diagnosticsMatch = /^\/api\/qq\/(groups|private)\/(\d+)\/diagnostics$/u.exec(url.pathname);
  if (req.method === "GET" && diagnosticsMatch) {
    const type = diagnosticsMatch[1] === "private" ? "private" : "group";
    const id = diagnosticsMatch[2];
    assertTarget(type, id);
    const conversation = (type === "private" ? privateStore : store).snapshot(id);
    const shared = sharedContexts.contextFor(type, id);
    sendJson(res, 200, { diagnostics: codex.diagnostics?.snapshot(shared ? shared.group.threadId : conversation.threadId, { includeInput: true }) || null });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/persona/name") {
    const body = parseJson(rawBody);
    let name;
    try { name = await personaStore.setName(body.name); }
    catch (error) { throw new HttpError(400, error.message); }
    codex.setSystemPrompt?.(personaStore.systemPromptForClient());
    recordEvent({ type: "persona-name-updated", at: new Date().toISOString() });
    sendJson(res, 200, { name, persona: personaStore.publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/persona/catchphrases") {
    const body = parseJson(rawBody);
    let saved;
    try { saved = await personaStore.stageCatchphrases(body.catchphrases); }
    catch (error) { throw new HttpError(400, error.message); }
    codex.setSystemPrompt?.(personaStore.systemPromptForClient());
    recordEvent({ type: "persona-catchphrases-updated", count: saved.entries.length, at: new Date().toISOString() });
    sendJson(res, 200, { ...saved, persona: personaStore.publicState() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/qq/stickers") {
    sendJson(res, 200, { ...stickerManager.publicState(), labeling: stickerLabelingState(), curation: stickerCuration.snapshot() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/qzone/settings") {
    const body = parseJson(rawBody);
    const targetType = body.targetType == null || body.targetType === "" ? null : String(body.targetType);
    const targetId = targetType ? String(body.targetId || "") : null;
    if (targetType && !["group", "private"].includes(targetType)) throw new HttpError(400, "请选择可用的 Agent 会话");
    if (targetType) assertTarget(targetType, targetId);
    if (targetType === "private" && targetId !== OWNER_QQ_ID) {
      throw new HttpError(400, "QQ 空间只能绑定 OWNER 私聊或 Agent 群聊");
    }
    if ((body.autoPostEnabled || body.autoEngageEnabled) && !targetId) throw new HttpError(400, "请先绑定一个 Agent 会话");
    if (typeof body.autoPostEnabled !== "boolean" || typeof body.autoEngageEnabled !== "boolean") {
      throw new HttpError(400, "定时开关必须为布尔值");
    }
    const saved = await qzoneStore.configure({
      targetType, targetId,
      autoPostEnabled: body.autoPostEnabled,
      autoEngageEnabled: body.autoEngageEnabled
    });
    recordEvent({ type: "qzone-settings-updated", targetType, targetId, at: new Date().toISOString() });
    sendJson(res, 200, { ...saved, scheduleTimes: qzoneScheduleTimes });
    return;
  }
  const stickerImage = url.pathname.match(/^\/api\/qq\/stickers\/(st_[a-f0-9]{12,64})\/image$/i);
  if (req.method === "GET" && stickerImage) {
    const asset = stickerManager.imageAsset(stickerImage[1]);
    if (!asset) throw new HttpError(404, "Sticker image not found");
    let body;
    try {
      body = await readFile(asset.localPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new HttpError(404, "Sticker image not found");
      throw error;
    }
    res.writeHead(200, {
      "content-type": asset.mimeType,
      "content-length": body.length,
      "cache-control": asset.ready ? "private, max-age=3600" : "no-store",
      ...corsHeaders()
    });
    res.end(body);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/stickers/blacklist/clean-files") {
    const result = await stickerManager.cleanExcludedFiles();
    recordEvent({ type: "sticker-blacklist-files-cleaned", ...result, at: new Date().toISOString() });
    sendJson(res, 200, { result, stickers: stickerManager.publicState() });
    return;
  }
  const stickerAction = url.pathname.match(/^\/api\/qq\/stickers\/(st_[a-f0-9]{12,64})\/(update|delete|blacklist|restore|forget)$/i);
  if (req.method === "POST" && stickerAction) {
    const [, id, requestedAction] = stickerAction;
    const action = requestedAction.toLowerCase();
    if (action === "update") {
      const body = parseJson(rawBody);
      const usage = String(body.usage || "").trim();
      if (usage.length < 2 || usage.length > 80 || !isUsableStickerDescription(usage)) {
        throw new HttpError(400, "表情备注需要是有效的中文使用场景，长度为 2–80 个字符");
      }
      const updated = await stickerManager.updateUsage(id, usage);
      if (!updated) throw new HttpError(404, "Sticker not found");
      recordEvent({ type: "sticker-usage-updated", stickerId: id, at: new Date().toISOString() });
      sendJson(res, 200, { updated, stickers: stickerManager.publicState() });
      return;
    }
    if (action === "restore" || action === "forget") {
      const result = action === "restore" ? await stickerManager.restoreExcluded(id) : await stickerManager.forgetSticker(id);
      if (!result) throw new HttpError(404, "Sticker not found");
      recordEvent({ type: `sticker-${action === "restore" ? "blacklist-removed" : "forgotten"}`, stickerId: id, at: new Date().toISOString() });
      sendJson(res, 200, { result, stickers: stickerManager.publicState() });
      return;
    }
    const deleted = await stickerManager.deleteSticker(id);
    if (!deleted) throw new HttpError(404, "Sticker not found");
    recordEvent({ type: "sticker-blacklisted", stickerId: id, at: new Date().toISOString() });
    sendJson(res, 200, { deleted, stickers: stickerManager.publicState() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/stickers/label-settings") {
    const body = parseJson(rawBody);
    const model = String(body.model || "").trim();
    if (!codexModels.some((item) => item.model === model)) {
      throw new HttpError(400, "请选择当前 Agent 账号真实可用的临时任务模型");
    }
    const labeling = await stickerLabelSettingsStore.setModel(model);
    recordEvent({ type: "sticker-label-settings-updated", model, at: new Date().toISOString() });
    sendJson(res, 200, { ...labeling, ephemeralSession: true, retainsContext: false });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/maintenance") {
    sendJson(res, 200, await maintenanceState());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/agent-dispatch") {
    const body = parseJson(rawBody);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    const wasEnabled = agentDispatchStore.isEnabled();
    const dispatch = await agentDispatchStore.setEnabled(body.enabled);
    if (!wasEnabled && dispatch.enabled) await resumeAgentDispatch();
    recordEvent({ type: "agent-dispatch-updated", enabled: dispatch.enabled, at: new Date().toISOString() });
    sendJson(res, 200, dispatch);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/refresh-instructions") {
    const body = parseJson(rawBody);
    const groupIds = uniqueStrings(Array.isArray(body.groupIds) && body.groupIds.length ? body.groupIds : allowedGroups);
    for (const groupId of groupIds) assertTarget("group", groupId);
    const results = await Promise.all(groupIds.map(async (groupId) => {
      try {
        return await worker.refreshInstructions(groupId);
      } catch (error) {
        return { groupId, status: "failed", error: error.message };
      }
    }));
    recordEvent({ type: "instruction-refresh-batch-completed", results, at: new Date().toISOString() });
    sendJson(res, 200, { results });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/qq/stream") {
    openEventStream(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/onebot/event") {
    sendJson(res, 200, await handleOneBotEvent(parseJson(rawBody)));
    return;
  }
  if (req.method === "POST" && ["/api/qq/agent-message", "/api/qq/owner-agent"].includes(url.pathname)) {
    const body = parseJson(rawBody);
    const targetType = url.pathname.endsWith("owner-agent") ? "group" : (body.targetType === "private" ? "private" : "group");
    const targetId = String(body.targetId || body.groupId || (targetType === "group" ? allowedGroups[0] : OWNER_QQ_ID) || "");
    assertTarget(targetType, targetId);
    const message = await appendUiOwnerMessage(targetType, targetId, String(body.text || "").trim());
    sendJson(res, 202, { status: "accepted", targetType, targetId, messageId: message.messageId });
    return;
  }
  if (req.method === "POST" && ["/api/qq/agent/cancel", "/api/qq/owner-agent/cancel"].includes(url.pathname)) {
    const body = parseJson(rawBody);
    const targetType = body.targetType === "private" ? "private" : "group";
    const targetId = String(body.targetId || body.groupId || "");
    assertTarget(targetType, targetId);
    const greetingCancelled = await speakerGreetings.cancel(targetType, targetId);
    const cancelled = targetType === "private" ? await privateWorker.cancel(targetId) : await worker.cancel(targetId);
    sendJson(res, 200, { status: cancelled || greetingCancelled ? "cancelling" : "idle", targetType, targetId });
    return;
  }
  const replySwitch = url.pathname.match(/^\/api\/qq\/(groups|private)\/([^/]+)\/reply-enabled$/);
  if (req.method === "POST" && replySwitch) {
    const targetType = replySwitch[1] === "private" ? "private" : "group";
    const targetId = decodeURIComponent(replySwitch[2]);
    assertTarget(targetType, targetId);
    const body = parseJson(rawBody);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    const targetStore = targetType === "private" ? privateStore : store;
    const targetWorker = targetType === "private" ? privateWorker : worker;
    const manager = targetType === "private" ? privateTriggerManager : triggerManager;
    await targetStore.setReplyEnabled(targetId, body.enabled);
    if (!body.enabled) {
      await speakerGreetings.cancel(targetType, targetId);
      await targetWorker.cancel(targetId);
    }
    else {
      await checkSubscriptionSchedule();
      targetWorker.recoverStickerLabels(targetId).catch((error) => console.warn(`Sticker recovery failed for ${targetType}:${targetId}: ${error.message}`));
      manager.kick(targetId);
    }
    recordEvent({ type: "reply-enabled-updated", targetType, targetId, enabled: body.enabled, at: new Date().toISOString() });
    sendJson(res, 200, { targetType, targetId, replyEnabled: body.enabled });
    return;
  }
  const contextLinkAction = /^\/api\/qq\/private\/(\d+)\/context-link$/u.exec(url.pathname);
  if (req.method === "POST" && contextLinkAction) {
    const id = validateQqId(contextLinkAction[1], "Private QQ id");
    assertTarget("private", id);
    if (!privateStore.listGroups().some((item) => item.groupId === id)) throw new HttpError(404, "请先将私聊加入网关");
    const body = parseJson(rawBody);
    if (!Object.hasOwn(body, "groupId")) throw new HttpError(400, "请选择目标群，或用 null 恢复独立私聊");
    const groupId = body.groupId === null ? null : validateQqId(body.groupId, "Group QQ id");
    if (groupId) assertTarget("group", groupId);
    const previous = sharedContexts.groupFor("private", id);
    if (previous !== groupId) {
      if (body.acknowledgeSharedContext !== true) throw new HttpError(400, "请确认共享模型上下文和群工作区；解绑不会抹除已共享的内容");
      const members = new Map(contextMembers("private", id).map((item) => [`${item.type}:${item.id}`, item]));
      if (groupId) for (const item of contextMembers("group", groupId)) members.set(`${item.type}:${item.id}`, item);
      for (const item of members.values()) {
        if (contextBusy(item.type, item.id)) throw new HttpError(409, "相关会话仍在运行、接话或排队，请先终止或等待结束再更改关联");
      }
      for (const key of members.keys()) contextLinkChanges.add(key);
      const previousCursor = privateStore.snapshot(id);
      try {
        // The new model context has not seen retained private messages. Replay
        // only this small pending window, never copy the parked transcript.
        await privateStore.resetReadCursor(id);
        sharedContexts.setPrivateGroup(id, groupId);
      } catch (error) {
        // A failed mapping save must not replay the old context's read messages.
        await privateStore.setReadCursor(id, previousCursor).catch(() => {});
        throw error;
      } finally {
        for (const key of members.keys()) contextLinkChanges.delete(key);
        for (const item of members.values()) resumeSharedContextTarget(item.type, item.id);
      }
      recordEvent({ type: "context-link-updated", targetType: "private", targetId: id, groupId, at: new Date().toISOString() });
    }
    sendJson(res, 200, { status: "updated", contextLink: contextLinkView(id), contextQueue: sharedContexts.snapshot("private", id) });
    return;
  }
  const targetConfig = url.pathname.match(/^\/api\/qq\/(groups|private)\/([^/]+)\/config$/);
  if (req.method === "POST" && targetConfig) {
    const targetType = targetConfig[1] === "private" ? "private" : "group";
    const targetId = decodeURIComponent(targetConfig[2]);
    assertTarget(targetType, targetId);
    const targetStore = targetType === "private" ? privateStore : store;
    const conversation = targetStore.snapshot(targetId);
    if (contextBusy(targetType, targetId) || conversation.busy || targetBusyForRemoval(targetType === "private" ? privateWorker : worker, conversation,
      speakerGreetingBusy(targetType, targetId))) throw new HttpError(409, "会话仍有进行中或排队的任务，请结束后再修改设置");
    const input = parseJson(rawBody);
    if (targetType === "private" && sharedContexts.groupFor(targetType, targetId)) {
      for (const key of ["model", "reasoningEffort", "contextTokenLimit"]) input[key] = conversation.codexConfig?.[key];
    }
    const config = validateCodexConfig(input, { targetType, currentConfig: conversation.codexConfig });
    const saved = await targetStore.setCodexConfig(targetId, config);
    if (saved.model !== conversation.codexConfig.model) {
      const restoredSubscriptions = await subscriptionStore.retryRateLimitedForTarget(targetType, targetId);
      const manager = targetType === "private" ? privateTriggerManager : triggerManager;
      if (restoredSubscriptions) await manager.request(targetId, "subscription_auto", {});
      else if (conversation.pendingMessages.length || conversation.pendingTrigger) await manager.request(targetId, "retry", {});
    }
    recordEvent({ type: "codex-config-updated", targetType, targetId, codexConfig: saved, at: new Date().toISOString() });
    sendJson(res, 200, { status: "saved", targetType, targetId, codexConfig: saved });
    return;
  }
  const targetAction = url.pathname.match(/^\/api\/qq\/(groups|private)\/([^/]+)\/(retry|reset|session)$/);
  if (req.method === "POST" && targetAction) {
    const targetType = targetAction[1] === "private" ? "private" : "group";
    const targetId = decodeURIComponent(targetAction[2]);
    assertTarget(targetType, targetId);
    if (targetAction[3] === "reset" && targetType === "private" && sharedContexts.groupFor("private", targetId)) {
      throw new HttpError(409, "私聊正在共享群上下文，请先解除关联；群会话重置须在对应群操作");
    }
    if (targetAction[3] === "retry") {
      const failedSubscriptions = await subscriptionStore.retryFailedForTarget(targetType, targetId);
      if (failedSubscriptions > 0) {
        const manager = targetType === "private" ? privateTriggerManager : triggerManager;
        await manager.request(targetId, "subscription_auto", {});
        sendJson(res, 202, { status: "accepted", targetType, targetId, subscriptionRetries: failedSubscriptions });
        return;
      }
    }
    const command = targetAction[3] === "retry" ? "/重试" : targetAction[3] === "reset" ? "/新会话" : "/会话";
    const message = await appendUiOwnerMessage(targetType, targetId, command);
    sendJson(res, 202, { status: "accepted", targetType, targetId, messageId: message.messageId });
    return;
  }
  const deleteTarget = /^\/api\/qq\/(groups|private)\/(\d+)\/delete$/u.exec(url.pathname);
  if (req.method === "POST" && deleteTarget) {
    const type = deleteTarget[1] === "private" ? "private" : "group";
    const id = validateQqId(deleteTarget[2], "Target QQ id");
    if (contextLinkChanges.has(`${type}:${id}`)) throw new HttpError(409, "该会话正在更改共享上下文，请稍后再删除");
    if (sharedContexts.groupFor(type, id)) throw new HttpError(409, "请先解除该会话的共享上下文关联，再删除会话");
    const body = parseJson(rawBody);
    if (String(body.confirmTargetId || "") !== id) throw new HttpError(400, "请确认要删除的会话 QQ 号或群号");
    const key = `${type}:${id}`;
    if (removingTargets.has(key)) throw new HttpError(409, "这个会话正在删除，请稍后刷新");
    const targetStore = type === "private" ? privateStore : store;
    const targetWorker = type === "private" ? privateWorker : worker;
    const conversation = targetStore.listGroups().find((item) => item.groupId === id);
    if (!conversation && !targetAllowlist.isRemoved(type, id)) throw new HttpError(404, "会话不存在");
    if (targetBusyForRemoval(targetWorker, conversation, qzone.activityFor(type, id) || speakerGreetingBusy(type, id))) {
      throw new HttpError(409, "会话还有回复、接话、动态、小爱问好或表情任务。请先终止或等待任务完成再删除");
    }
    removingTargets.add(key);
    try {
      const result = await removeGatewayTarget({ type, id, targetStore, subscriptions:subscriptionStore,
        allowlist:targetAllowlist,archiveDir:join(dataDir,"removed-targets"),qzoneStore,
        onDisabled: () => {
          if (type === "group") {
            const index = allowedGroups.indexOf(id);
            if (index >= 0) allowedGroups.splice(index,1);
            delete groupMetadata[id];
          } else delete privateMetadata[id];
          (type === "private" ? privateTriggerManager : triggerManager).disallowGroup(id);
        }
      });
      targetWorker.live.delete(id);
      targetWorker.followup.cancelled.delete(id);
      oneBot.setReadOnlyGroupIds(subscriptionStore.sourceGroupIds());
      await mediaManager.removeMessages(result.removedMessages);
      threadReservations.reconcile().catch((error) => console.warn(`Thread lock refresh after removal failed: ${error.message}`));
      recordEvent({type:"target-deleted",targetType:type,targetId:id,at:new Date().toISOString()});
      sendJson(res,200,{removed:true,targetType:type,targetId:id,archived:Boolean(result.archiveFile),subscriptionCount:result.subscriptionCount});
    } finally { removingTargets.delete(key); }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/qq/groups/available") {
    let joined;
    try { joined = await oneBot.getGroupList(); }
    catch { throw new HttpError(503, "暂时无法读取机器人已加入的群，请确认 QQ 在线后重试"); }
    const unavailable = new Set([...allowedGroups, ...subscriptionStore.sourceGroupIds()]);
    const groups = joined
      .map((item) => ({ groupId: String(item?.group_id || ""), groupName: String(item?.group_name || "").trim().slice(0, 100) }))
      .filter((item) => /^\d{5,14}$/u.test(item.groupId) && !unavailable.has(item.groupId))
      .sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-CN") || a.groupId.localeCompare(b.groupId));
    sendJson(res, 200, { groups });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/groups") {
    const body = parseJson(rawBody);
    const groupId = validateQqId(body.groupId, "QQ group id");
    if (removingTargets.has(`group:${groupId}`)) throw new HttpError(409, "这个会话正在删除，请稍后再添加");
    if (allowedGroups.includes(groupId)) throw new HttpError(409, "这个群已经在 Agent 白名单中");
    if (subscriptionStore.sourceGroupIds().includes(groupId)) throw new HttpError(409, "只读通知源不能同时加入 Agent 群白名单");
    let joined;
    try { joined = await oneBot.getGroupList(); }
    catch { throw new HttpError(503, "暂时无法读取机器人已加入的群，请确认 QQ 在线后重试"); }
    const info = joined.find((item) => String(item?.group_id || "") === groupId);
    if (!info) throw new HttpError(400, "机器人尚未加入这个 QQ 群");
    await store.addConversation(groupId);
    const result = await targetAllowlist.add("group", groupId);
    if (!result.added) throw new HttpError(409, "这个群已经在 Agent 白名单中");
    allowedGroups.push(groupId);
    triggerManager.allowGroup(groupId);
    const metadata = { groupId, groupName: String(info.group_name || "").trim().slice(0, 100) || null };
    groupMetadata[groupId] = metadata;
    availableGroupMetadata[groupId] = metadata;
    await groupMemberDirectory.initGroup(groupId)
      .catch((error) => console.warn(`QQ member directory initialization failed for ${groupId}: ${error.message}`));
    recordEvent({ type: "group-target-created", groupId, at: new Date().toISOString() });
    sendJson(res, 201, { status: "created", groupId, groupName: metadata.groupName });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/private-chats") {
    const body = parseJson(rawBody);
    const userId = validateQqId(body.userId, "Private QQ user id");
    if (removingTargets.has(`private:${userId}`)) throw new HttpError(409, "这个会话正在删除，请稍后再添加");
    if (userId === AGENT_QQ_ID) throw new HttpError(400, "不能把机器人自己的 QQ 号加入私聊白名单");
    if (privateStore.listGroups().some((item) => item.groupId === userId)) throw new HttpError(409, "这个 QQ 号已经在 Agent 私聊白名单中");
    await targetAllowlist.add("private", userId);
    await privateStore.addConversation(userId);
    privateTriggerManager.allowGroup(userId);
    privateMetadata[userId] ||= { displayName: String(body.displayName || "").trim() || null };
    refreshPrivateMetadata(userId).catch(() => {});
    recordEvent({ type: "private-target-created", userId, at: new Date().toISOString() });
    sendJson(res, 201, { status: "created", userId });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/qq/subscriptions") {
    const body = parseJson(rawBody);
    if (body.mode != null && body.mode !== "AUTO") throw new HttpError(400, "通知订阅仅支持自动处理，静默模式已移除");
    const targetType = body.targetType === "private" ? "private" : "group";
    const targetId = validateQqId(body.targetId, "Target QQ id");
    const sourceGroupId = validateQqId(body.sourceGroupId, "Source QQ group id");
    assertTarget(targetType, targetId);
    if (allowedGroups.includes(sourceGroupId)) throw new HttpError(400, "AGENT_CHAT_GROUP cannot be used as a READ_ONLY_SOURCE_GROUP");
    const result = await subscriptionStore.upsertSubscription({ ...body, targetType, targetId, sourceGroupId });
    await groupMemberDirectory.initGroup(sourceGroupId)
      .catch((error) => console.warn(`QQ source member directory initialization failed for ${sourceGroupId}: ${error.message}`));
    oneBot.setReadOnlyGroupIds(subscriptionStore.sourceGroupIds());
    await mediaManager.removeMessages(result.removedMessages);
    await refreshOneSourceMetadata(sourceGroupId).catch(() => {});
    await checkSubscriptionSchedule();
    recordEvent({ type: "subscription-updated", subscription: result.subscription, at: new Date().toISOString() });
    sendJson(res, body.id ? 200 : 201, result.subscription);
    return;
  }
  const deleteSubscription = url.pathname.match(/^\/api\/qq\/subscriptions\/([^/]+)\/delete$/);
  if (req.method === "POST" && deleteSubscription) {
    const id = decodeURIComponent(deleteSubscription[1]);
    const result = await subscriptionStore.deleteSubscription(id);
    oneBot.setReadOnlyGroupIds(subscriptionStore.sourceGroupIds());
    await mediaManager.removeMessages(result.removedMessages);
    recordEvent({ type: "subscription-deleted", subscriptionId: id, at: new Date().toISOString() });
    sendJson(res, result.deleted ? 200 : 404, result.deleted ? { deleted: true, id } : { error: "Subscription not found" });
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

async function handleOneBotEvent(payload) {
  if (isGroupPokeEvent(payload)) return handleGroupPoke(payload);
  if (payload?.post_type === "notice" && ["group_recall", "friend_recall"].includes(payload?.notice_type)) {
    return handleMessageRecall(payload);
  }
  if (payload?.post_type !== "message" || !["group", "private"].includes(payload?.message_type)) {
    return { ignored: true, reason: "Only QQ group and private messages are handled" };
  }
  if (String(payload.user_id || "") === String(payload.self_id || "")) return { status: "ignored", reason: "Self message" };
  if (payload.message_type === "private") return handlePrivateMessage(payload);
  const message = normalizeOneBotGroupMessage(payload);
  const isSource = subscriptionStore.sourceGroupIds().includes(message.groupId);
  if (removingTargets.has(`group:${message.groupId}`)) return {status:"ignored",reason:"Conversation is being removed"};
  if (!isSource && !allowedGroups.includes(message.groupId)) return { status: "ignored", reason: "Group is not managed" };
  if (isSource ? subscriptionStore.isSourceRecalled(message.groupId, message.messageId)
    : store.isRecalled(message.groupId, message.messageId)) return { status: "ignored", reason: "Message was recalled" };
  if (rememberMessage(`group:${message.messageId}`)) return { status: "ok", duplicate: true };
  await groupMemberDirectory.record(message, payload.sender)
    .catch((error) => console.warn(`QQ member directory update failed for ${message.groupId}: ${error.message}`));
  await hydrateMessage(payload, message);
  if (!isSource && (!allowedGroups.includes(message.groupId) || removingTargets.has(`group:${message.groupId}`))) {
    return {status:"ignored",reason:"Conversation was removed"};
  }
  if (isSource) {
    const result = await subscriptionStore.appendSourceMessage(message);
    if (result.recalled || result.duplicate) return { status: "ignored", reason: "Source message was recalled or duplicated" };
    await mediaManager.removeMessages(result.removedMessages);
    recordEvent({ type: "source-message", sourceGroupId: message.groupId, message: result.message, at: new Date().toISOString() });
    await checkSubscriptionSchedule();
    return { status: "accepted", conversationType: "READ_ONLY_SOURCE_GROUP", sourceGroupId: message.groupId, messageId: message.messageId, affectedTargets: result.affectedTargets };
  }
  const collectedStickers = await stickerManager.collectFromMessage(message, {
    contextMessages: store.snapshot(message.groupId).pendingMessages
  });
  if (collectedStickers.length) {
    recordEvent({
      type: "stickers-collected",
      groupId: message.groupId,
      stickerIds: collectedStickers.map((sticker) => sticker.id),
      at: new Date().toISOString()
    });
  }
  if (!allowedGroups.includes(message.groupId) || removingTargets.has(`group:${message.groupId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const stored = await store.appendMessage(message);
  if (!stored) return { status: "ignored", reason: "Message was recalled" };
  if (!allowedGroups.includes(message.groupId) || removingTargets.has(`group:${message.groupId}`)) return {status:"ignored",reason:"Conversation was removed"};
  recordEvent({ type: "message", groupId: stored.groupId, message: stored, at: new Date().toISOString() });
  const control = parseOwnerControlCommand(stored);
  if (control) await triggerManager.request(stored.groupId, "control", stored);
  else {
    if (collectedStickers.some((sticker) => sticker.labelStatus !== "ready")) {
      worker.labelStickers(stored.groupId, [stored]).catch((error) => console.warn(`QQ sticker labeling failed for ${stored.groupId}: ${error.message}`));
    }
    if (qzone.shouldWakeForOwnerRequest(stored, "group", stored.groupId)) await triggerManager.request(stored.groupId, "mention", stored);
    else await triggerManager.considerMessage(stored);
  }
  if (!allowedGroups.includes(stored.groupId) || removingTargets.has(`group:${stored.groupId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const group = store.snapshot(stored.groupId);
  return { status: "accepted", groupId: stored.groupId, messageId: stored.messageId, pendingMessages: group.pendingMessages.length, trigger: group.pendingTrigger?.reason || null };
}

async function handleMessageRecall(payload) {
  const messageId = String(payload.message_id || "");
  if (!/^-?\d+$/u.test(messageId)) return { status: "ignored", reason: "Invalid recall message ID" };
  const now = new Date().toISOString();
  if (payload.notice_type === "group_recall") {
    const groupId = String(payload.group_id || "");
    const isSource = subscriptionStore.sourceGroupIds().includes(groupId);
    if (!isSource && !allowedGroups.includes(groupId)) return { status: "ignored", reason: "Group is not managed" };
    if (String(payload.user_id || "") === String(payload.self_id || AGENT_QQ_ID) && !isSource) {
      const changed = await store.markSentMessageRecalled(groupId, messageId);
      if (changed) recordEvent({ type: "own-message-recalled", groupId, messageId, at: now });
      return { status: "accepted", groupId, messageId, ownMessage: true };
    }
    if (isSource) {
      const result = await subscriptionStore.recallSourceMessage(groupId, messageId);
      await Promise.all(result.activeTargets.map(async (key) => {
        const separator = key.indexOf(":");
        await (key.slice(0, separator) === "private" ? privateStore : store)
          .invalidateActiveWorkForRecall(key.slice(separator + 1));
      }));
      await mediaManager.removeMessages(result.removedMessages);
      await mediaManager.removeImages(result.removedImages);
      recordEvent({ type: "source-message-recalled", sourceGroupId: groupId, messageId, at: now });
      await Promise.allSettled(result.activeTargets.map(async (key) => {
        const separator = key.indexOf(":");
        const type = key.slice(0, separator);
        const id = key.slice(separator + 1);
        return type === "private" ? privateWorker.cancel(id) : worker.cancel(id);
      }));
      await checkSubscriptionSchedule();
      return { status: "accepted", sourceGroupId: groupId, messageId, cancelledTargets: result.activeTargets };
    }
    const result = await store.recallMessage(groupId, messageId);
    await mediaManager.removeMessages(result.removedMessages);
    await mediaManager.removeImages(result.removedImages);
    recordEvent({ type: "message-recalled", groupId, messageId, at: now });
    if (result.wasProcessing) await worker.cancel(groupId);
    await triggerManager.reconsiderPending(groupId);
    return { status: "accepted", groupId, messageId };
  }
  const userId = String(payload.user_id || "");
  if (!userId || !privateStore.listGroups().some((item) => item.groupId === userId)) {
    return { status: "ignored", reason: "Private Agent chat is not configured" };
  }
  const result = await privateStore.recallMessage(userId, messageId);
  await mediaManager.removeMessages(result.removedMessages);
  await mediaManager.removeImages(result.removedImages);
  recordEvent({ type: "private-message-recalled", userId, messageId, at: now });
  if (result.wasProcessing) await privateWorker.cancel(userId);
  await privateTriggerManager.reconsiderPending(userId);
  return { status: "accepted", userId, messageId };
}

function isGroupPokeEvent(payload) {
  return payload?.post_type === "notice"
    && payload?.notice_type === "notify"
    && payload?.sub_type === "poke"
    && payload?.group_id != null;
}

async function handleGroupPoke(payload) {
  const groupId = String(payload.group_id || "");
  if (subscriptionStore.sourceGroupIds().includes(groupId)) {
    return { status: "ignored", reason: "READ_ONLY_SOURCE_GROUP poke events are not recorded" };
  }
  if (!allowedGroups.includes(groupId)) return { status: "ignored", reason: "Group is not managed" };

  const selfId = String(payload.self_id || AGENT_QQ_ID);
  const senderId = String(payload.user_id || "");
  const targetId = String(payload.target_id || "");
  if (!senderId || senderId === selfId) return { status: "ignored", reason: "Self poke" };
  if (!targetId || targetId !== selfId) return { status: "ignored", reason: "Poke target is not the Agent" };

  const message = normalizeOneBotGroupPoke({ ...payload, self_id: selfId });
  if (rememberMessage(`group:${message.messageId}`)) return { status: "ok", duplicate: true };
  try {
    const info = await oneBot.getGroupMemberInfo(groupId, senderId);
    message.senderName = String(info?.card || info?.nickname || message.senderName || senderId).trim();
    message.senderRole = ["owner", "admin"].includes(String(info?.role || "").toLowerCase())
      ? String(info.role).toLowerCase()
      : "member";
  } catch {
    // A poke must still wake the Agent if QQ member metadata is temporarily unavailable.
  }
  if (!allowedGroups.includes(groupId) || removingTargets.has(`group:${groupId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const stored = await store.appendMessage(message);
  recordEvent({ type: "poke", groupId, message: stored, at: new Date().toISOString() });
  await triggerManager.considerMessage(stored);
  if (!allowedGroups.includes(groupId) || removingTargets.has(`group:${groupId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const group = store.snapshot(groupId);
  return {
    status: "accepted",
    groupId,
    messageId: stored.messageId,
    pendingMessages: group.pendingMessages.length,
    trigger: group.pendingTrigger?.reason || "poke"
  };
}

async function handlePrivateMessage(payload) {
  const message = normalizeOneBotPrivateMessage(payload);
  if (targetAllowlist.isRemoved("private",message.senderId) || removingTargets.has(`private:${message.senderId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const known = privateStore.listGroups().some((item) => item.groupId === message.senderId);
  if (!known && message.senderId !== OWNER_QQ_ID) return { status: "ignored", reason: "Private Agent chat is not configured" };
  if (rememberMessage(`private:${message.messageId}`)) return { status: "ok", duplicate: true };
  if (known && privateStore.isRecalled(message.senderId, message.messageId)) return { status: "ignored", reason: "Message was recalled" };
  message.mentionedBot = true;
  await hydrateMessage(payload, message);
  if (targetAllowlist.isRemoved("private",message.senderId) || removingTargets.has(`private:${message.senderId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const collectedStickers = await stickerManager.collectFromMessage(message, {
    contextMessages: known ? privateStore.snapshot(message.senderId).pendingMessages : []
  });
  if (collectedStickers.length) {
    recordEvent({
      type: "private-stickers-collected",
      userId: message.senderId,
      stickerIds: collectedStickers.map((sticker) => sticker.id),
      at: new Date().toISOString()
    });
  }
  if (targetAllowlist.isRemoved("private",message.senderId) || removingTargets.has(`private:${message.senderId}`)) return {status:"ignored",reason:"Conversation was removed"};
  if (!known) await privateStore.addConversation(message.senderId);
  if (targetAllowlist.isRemoved("private",message.senderId) || removingTargets.has(`private:${message.senderId}`)) return {status:"ignored",reason:"Conversation was removed"};
  privateMetadata[message.senderId] ||= { displayName: message.senderName || null };
  const stored = await privateStore.appendMessage(message);
  if (!stored) return { status: "ignored", reason: "Message was recalled" };
  if (targetAllowlist.isRemoved("private",message.senderId) || removingTargets.has(`private:${message.senderId}`)) return {status:"ignored",reason:"Conversation was removed"};
  recordEvent({ type: "private-message", userId: stored.senderId, message: stored, at: new Date().toISOString() });
  const control = parseOwnerControlCommand(stored);
  if (control) await privateTriggerManager.request(stored.senderId, "control", stored);
  else {
    if (collectedStickers.some((sticker) => sticker.labelStatus !== "ready")) {
      privateWorker.labelStickers(stored.senderId, [stored]).catch((error) => console.warn(`Private sticker labeling failed for ${stored.senderId}: ${error.message}`));
    }
    await privateTriggerManager.request(stored.senderId, "mention", stored);
  }
  if (targetAllowlist.isRemoved("private",stored.senderId) || removingTargets.has(`private:${stored.senderId}`)) return {status:"ignored",reason:"Conversation was removed"};
  const conversation = privateStore.snapshot(stored.senderId);
  return { status: "accepted", userId: stored.senderId, messageId: stored.messageId, pendingMessages: conversation.pendingMessages.length, trigger: conversation.pendingTrigger?.reason || null };
}

async function hydrateMessage(payload, message) {
  await hydrateMentionNames(payload, message);
  if (message.replyToMessageId) {
    const quotedRecalled = payload.message_type === "private"
      ? privateStore.isRecalled(message.groupId, message.replyToMessageId)
      : (subscriptionStore.sourceGroupIds().includes(message.groupId)
        ? subscriptionStore.isSourceRecalled(message.groupId, message.replyToMessageId)
        : store.isRecalled(message.groupId, message.replyToMessageId));
    if (quotedRecalled) message.quoteError = "被引用消息已撤回";
    else {
      const session = payload.message_type === "private" ? privateStore : store;
      const local = subscriptionStore.sourceGroupIds().includes(message.groupId)
        ? subscriptionStore.snapshot().sources[message.groupId]?.messages.find((item) => String(item.messageId) === message.replyToMessageId)
        : findSessionQuote(session.snapshot(message.groupId), message.replyToMessageId);
      if (local) message.quotedMessage = quotedSummary(local);
      else try {
        const quotedPayload = await oneBot.getMessage(message.replyToMessageId);
        if (quotedPayload) {
          const quotedInput = { ...quotedPayload, post_type: "message", message_type: payload.message_type, group_id: quotedPayload.group_id ?? payload.group_id, self_id: payload.self_id, user_id: quotedPayload.user_id ?? quotedPayload.sender?.user_id };
          const quoted = payload.message_type === "private" ? normalizeOneBotPrivateMessage(quotedInput) : normalizeOneBotGroupMessage(quotedInput);
          await hydrateMentionNames(quotedInput, quoted);
          message.quotedMessage = quotedSummary(quoted);
          message.imageRefs.push(...quoted.imageRefs.map((ref) => ({ ...ref, context: "quoted" })));
        }
      } catch (error) {
        message.quoteError = String(error.message || error).slice(0, 500);
      }
    }
  }
  message.images = await mediaManager.cacheMessageImages(message, { resolveImageRef: (ref) => oneBot.resolveImageRef(ref) });
  message.attachments = await mediaManager.cacheMessageAttachments(message, {
    resolveAttachmentRef: payload.message_type === "group" ? (ref) => oneBot.resolveGroupFileRef(message.groupId, ref) : null
  });
}

function findSessionQuote(snapshot, messageId) {
  const id = String(messageId);
  return snapshot.pendingMessages.find((item) => String(item.messageId) === id);
}

function quotedSummary(quoted) {
  return {
    messageId: quoted.messageId, senderId: quoted.senderId, senderName: quoted.senderName, senderRole: quoted.senderRole,
    timestamp: quoted.timestamp, displayTime: quoted.displayTime, text: quoted.text, trust: quoted.trust,
    attachments: quoted.attachments, links: quoted.links
  };
}

async function hydrateMentionNames(payload, message) {
  if (message.rawType !== "group" || !message.groupId || !message.mentions?.length) return;
  const mentionNames = {};
  const userIds = [...new Set(message.mentions
    .filter((mention) => !mention.isBot && !mention.isAll && /^\d+$/.test(mention.userId))
    .map((mention) => mention.userId))];
  await Promise.all(userIds.map(async (userId) => {
    const name = await resolveMentionName(message.groupId, userId);
    if (name) mentionNames[userId] = name;
  }));
  message.mentions = message.mentions.map((mention) => ({
    ...mention,
    displayName: mentionNames[mention.userId] || mention.displayName || null
  }));
  const rendered = renderOneBotMessageText(payload?.message, { selfId: payload?.self_id, mentionNames }).trim();
  if (rendered) message.text = rendered;
}

async function resolveMentionName(groupId, userId) {
  const key = `${groupId}:${userId}`;
  const cached = mentionNameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    const info = await oneBot.getGroupMemberInfo(groupId, userId);
    const name = String(info?.card || info?.nickname || "").trim() || null;
    mentionNameCache.set(key, { name, expiresAt: Date.now() + 30 * 60 * 1000 });
    return name;
  } catch {
    mentionNameCache.set(key, { name: null, expiresAt: Date.now() + 60 * 1000 });
    return null;
  }
}

async function appendUiOwnerMessage(targetType, targetId, text) {
  if (!text) throw new HttpError(400, "Message text is required");
  const targetStore = targetType === "private" ? privateStore : store;
  const manager = targetType === "private" ? privateTriggerManager : triggerManager;
  const now = new Date();
  const message = await targetStore.appendMessage({
    messageId: `codex-ui-${randomUUID()}`, groupId: targetId, senderId: OWNER_QQ_ID, senderName: "OWNER", senderRole: "member",
    timestamp: now.toISOString(), displayTime: formatLocalTime(now), text, images: [], attachments: [], mentionedBot: true,
    replyToMessageId: null, trust: "OWNER", source: "codex-ui", rawType: targetType
  });
  recordEvent({ type: targetType === "private" ? "private-message" : "message", targetType, targetId, message, at: now.toISOString() });
  const control = parseOwnerControlCommand(message);
  if (control) await manager.request(targetId, "control", message);
  else await manager.request(targetId, "mention", message);
  return message;
}

function contextMembers(type, id) {
  const groupId = sharedContexts.groupFor(type, id);
  return groupId ? [{ type: "group", id: groupId },
    ...sharedContexts.linkedPrivates(groupId).map((id) => ({ type: "private", id }))] : [{ type, id: String(id) }];
}

function contextBusy(type, id) {
  if (sharedContexts.busy(type, id)) return true;
  return contextMembers(type, id).some((item) => {
    const targetStore = item.type === "private" ? privateStore : store;
    const conversation = targetStore.listGroups().find((state) => state.groupId === item.id);
    return contextLinkChanges.has(`${item.type}:${item.id}`) || targetBusyForRemoval(
      item.type === "private" ? privateWorker : worker, conversation,
      qzone.activityFor(item.type, item.id) || speakerGreetingBusy(item.type, item.id))
      || Date.parse(conversation?.replyFollowup?.expiresAt) > Date.now();
  });
}

function contextLinkView(id) {
  const linked = sharedContexts.contextFor("private", id);
  return linked ? {
    groupId: linked.groupId, groupName: groupMetadata[linked.groupId]?.groupName || null,
    threadId: linked.group.threadId || null, parkedThreadId: privateStore.snapshot(id).threadId || null
  } : null;
}

function resumeSharedContextTarget(type, id) {
  const targetWorker = type === "private" ? privateWorker : worker;
  sharedContexts.settleTarget(type, id, targetWorker);
}

async function checkSharedContextFollowups() {
  const members = new Map(Object.entries(sharedContexts.state.privateGroups).flatMap(([id, groupId]) => [
    [`group:${groupId}`, { type: "group", id: groupId }], [`private:${id}`, { type: "private", id }]
  ]));
  for (const item of members.values()) {
    const targetWorker = item.type === "private" ? privateWorker : worker;
    const targetStore = item.type === "private" ? privateStore : store;
    const lane = sharedContexts.snapshot(item.type, item.id);
    if (targetWorker.running.has(item.id) || [lane?.active, ...(lane?.queued || [])].some((task) => task?.targetType === item.type && task?.targetId === item.id)) continue;
    const conversation = targetStore.snapshot(item.id);
    if (Date.parse(conversation.replyFollowup?.expiresAt) <= Date.now()) await targetStore.cancelReplyFollowup(item.id);
    if (conversation.replyFollowup || ["waiting", "queued"].includes(targetWorker.live.get(item.id)?.status)) {
      resumeSharedContextTarget(item.type, item.id);
    }
  }
}

function publicState() {
  const liveByGroup = worker.publicLiveState();
  const liveByPrivate = privateWorker.publicLiveState();
  const groups = Object.fromEntries(store.listGroups().filter((group) => allowedGroups.includes(group.groupId)).map((group) => {
    const view = toPublicGroupState(group, liveByGroup[group.groupId], groupMetadata[group.groupId]);
    return [group.groupId, {
      ...view,
      contextQueue: sharedContexts.snapshot("group", group.groupId),
      diagnostics: codex.diagnostics?.snapshot(group.threadId) || null,
      qzoneActivity: qzone.activityFor("group", group.groupId),
      speakerGreetingActivity: speakerGreetings.activityFor("group", group.groupId),
      targetType: "group",
      targetId: group.groupId,
      conversationType: "AGENT_CHAT_GROUP",
      threadLock: threadReservations.stateFor("group", group.groupId, group.threadId),
      subscriptions: subscriptionStore.listSubscriptions({ targetType: "group", targetId: group.groupId })
    }];
  }));
  const privateChats = Object.fromEntries(privateStore.listGroups().filter((item) => !targetAllowlist.isRemoved("private",item.groupId)).map((conversation) => {
    const metadata = privateMetadata[conversation.groupId] || {};
    const view = toPublicGroupState(conversation, liveByPrivate[conversation.groupId], { groupName: metadata.displayName || null });
    const contextLink = contextLinkView(conversation.groupId);
    const threadId = contextLink ? contextLink.threadId : conversation.threadId;
    const effectiveCodexConfig = contextLink ? {
      ...conversation.codexConfig,
      ...Object.fromEntries(["model", "reasoningEffort", "contextTokenLimit"].map((key) => [key, store.snapshot(contextLink.groupId).codexConfig?.[key]]))
    } : conversation.codexConfig;
    return [conversation.groupId, {
      ...view,
      threadId, contextLink, effectiveCodexConfig,
      threadCreatedAt: contextLink ? store.snapshot(contextLink.groupId).threadCreatedAt : conversation.threadCreatedAt,
      contextQueue: sharedContexts.snapshot("private", conversation.groupId),
      diagnostics: codex.diagnostics?.snapshot(threadId) || null,
      qzoneActivity: qzone.activityFor("private", conversation.groupId),
      speakerGreetingActivity: speakerGreetings.activityFor("private", conversation.groupId),
      userId: conversation.groupId,
      displayName: metadata.displayName || null,
      targetType: "private",
      targetId: conversation.groupId,
      conversationType: "PRIVATE_AGENT_CHAT",
      threadLock: threadReservations.stateFor("private", conversation.groupId, threadId),
      subscriptions: subscriptionStore.listSubscriptions({ targetType: "private", targetId: conversation.groupId })
    }];
  }));
  const targetViews = Object.fromEntries([
    ...Object.values(groups).map((view) => [`group:${view.targetId}`, view]),
    ...Object.values(privateChats).map((view) => [`private:${view.targetId}`, view])
  ]);
  const sourceGroups = subscriptionStore.publicSources(availableGroupMetadata, targetViews, {
    dispatchEnabled: agentDispatchStore.snapshot().enabled !== false
  });
  const availableSourceGroups = Object.values(availableGroupMetadata)
    .filter((item) => !allowedGroups.includes(item.groupId))
    .map((item) => ({ groupId: item.groupId, groupName: item.groupName || null }))
    .sort((a, b) => String(a.groupName || a.groupId).localeCompare(String(b.groupName || b.groupId), "zh-CN"));
  for (const source of Object.values(sourceGroups)) {
    if (!availableSourceGroups.some((item) => item.groupId === source.groupId)) availableSourceGroups.push({ groupId: source.groupId, groupName: source.groupName || null });
  }
  return {
    version: 5,
    architecture: "target-owned-read-only-source-subscriptions",
    agentDispatch: agentDispatchStore.snapshot(),
    persona: personaStore.publicState(),
    taskGate: taskGate.snapshot(),
    ai: {
      provider: engineKind === "codex" ? "codex-app-server" : "workbuddy-agent-sdk",
      model: codexModel,
      reasoningEffort: codexEffort,
      persistentThreads: true,
      autoCompactTokenLimit: codexAutoCompactTokenLimit,
      autoCompactTokenScope: codexAutoCompactTokenScope,
      availableModels: codexModels,
      contextTokenOptions,
      permissionModeOptions,
      homeAssistantPermissionOptions,
      speakerGreetingsAvailable
    },
    channels: { qq: true },
    qq: {
      ownerId: OWNER_QQ_ID,
      allowedGroups,
      triggerPolicy: { mention: 1, poke: 1, periodicMinutes: periodicTriggerMinutes },
      groups,
      privateChats,
      sourceGroups,
      availableSourceGroups,
      stickers: { ...stickerManager.publicState(), labeling: stickerLabelingState(), curation: stickerCuration.snapshot() },
      qzone: { ...qzoneStore.publicState(), scheduleTimes: qzoneScheduleTimes },
      activeTargets: [...new Set([...codex.activeGroups(), ...worker.running.keys(), ...[...privateWorker.running.keys()].map((id) => `private:${id}`)])],
      activeGroups: [...new Set([...codex.activeGroups().filter((id) => !id.startsWith("private:")), ...worker.running.keys()])],
      events: recentEvents
    }
  };
}

async function checkSubscriptionSchedule() {
  for (const key of subscriptionStore.dueAutoTargets()) {
    const separator = key.indexOf(":");
    const targetType = key.slice(0, separator);
    const targetId = key.slice(separator + 1);
    if (targetAllowlist.isRemoved(targetType,targetId) || removingTargets.has(key)) continue;
    if (targetType === "group" && !allowedGroups.includes(targetId)) continue;
    if (targetType === "private" && !privateStore.listGroups().some((item) => item.groupId === targetId)) await privateStore.addConversation(targetId);
    const targetStore = targetType === "private" ? privateStore : store;
    const manager = targetType === "private" ? privateTriggerManager : triggerManager;
    const conversation = targetStore.snapshot(targetId);
    if (conversation.failedDelivery?.subscriptionConsumptions?.length) {
      continue;
    }
    if (conversation.processing?.trigger?.reason === "subscription_auto") continue;
    if (conversation.pendingTrigger?.reason !== "subscription_auto") await manager.request(targetId, "subscription_auto", {});
  }
}

async function checkRateLimitRecovery() {
  if (!agentDispatchStore.isEnabled()) return;
  for (const [targetType, targetStore, manager] of [
    ["group", store, triggerManager], ["private", privateStore, privateTriggerManager]
  ]) {
    for (const conversation of targetStore.listGroups()) {
      if (targetType === "group" && !allowedGroups.includes(conversation.groupId)) continue;
      if (conversation.replyEnabled === false || conversation.busy) continue;
      const resumeAt = targetStore.rateLimitUntil(conversation.groupId);
      if (!resumeAt || resumeAt > Date.now()) continue;
      const key = `${targetType}:${conversation.groupId}`;
      if (recoveredRateLimitWindows.get(key) === resumeAt) continue;
      recoveredRateLimitWindows.set(key, resumeAt);
      try {
        const subscriptions = await subscriptionStore.retryRateLimitedForTarget(targetType, conversation.groupId);
        if (subscriptions) await manager.request(conversation.groupId, "subscription_auto", {});
        else if (conversation.pendingMessages.length || conversation.pendingTrigger) {
          await manager.request(conversation.groupId, "retry", {});
        }
      } catch (error) {
        recoveredRateLimitWindows.delete(key);
        throw error;
      }
    }
  }
}

async function resumeAgentDispatch() {
  Promise.resolve(stickerCuration.tick()).catch((error) => console.warn(`Sticker curation resume failed: ${error.message}`));
  await checkSubscriptionSchedule();
  for (const conversation of store.listGroups()) {
    if (!allowedGroups.includes(conversation.groupId)) continue;
    worker.recoverStickerLabels(conversation.groupId).catch((error) => console.warn(`QQ sticker recovery failed for ${conversation.groupId}: ${error.message}`));
    if (conversation.pendingTrigger || conversation.replyFollowup) triggerManager.kick(conversation.groupId);
  }
  for (const conversation of privateStore.listGroups()) {
    privateWorker.recoverStickerLabels(conversation.groupId).catch((error) => console.warn(`Private sticker recovery failed for ${conversation.groupId}: ${error.message}`));
    if (conversation.pendingTrigger || conversation.replyFollowup) privateTriggerManager.kick(conversation.groupId);
  }
}

function recoverConversation(conversation, manager) {
  if (conversation.pendingTrigger || conversation.replyFollowup) manager.kick(conversation.groupId);
  else if (!conversation.lastError && conversation.pendingMessages.length) manager.reconsiderPending(conversation.groupId).catch(console.warn);
}

async function refreshGroupMetadata() {
  let groups = [];
  try {
    groups = await oneBot.getGroupList();
  } catch {
    groups = (await Promise.allSettled(allowedGroups.map((groupId) => oneBot.getGroupInfo(groupId))))
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
  }
  for (const info of groups) {
    const groupId = String(info?.group_id || "");
    if (!groupId) continue;
    const metadata = { groupId, groupName: String(info?.group_name || "").trim() || null };
    availableGroupMetadata[groupId] = metadata;
    if (allowedGroups.includes(groupId)) groupMetadata[groupId] = metadata;
    if (subscriptionStore.sourceGroupIds().includes(groupId)) await subscriptionStore.setSourceMetadata(groupId, metadata);
  }
  await Promise.allSettled(privateStore.listGroups().map((item) => refreshPrivateMetadata(item.groupId)));
  broadcast({ type: "metadata", state: publicState() });
}

async function refreshOneSourceMetadata(groupId) {
  const info = await oneBot.getGroupInfo(groupId);
  const metadata = { groupId: String(groupId), groupName: String(info?.group_name || "").trim() || null };
  availableGroupMetadata[String(groupId)] = metadata;
  await subscriptionStore.setSourceMetadata(groupId, metadata);
}

async function refreshPrivateMetadata(userId) {
  const info = await oneBot.getStrangerInfo(userId);
  privateMetadata[userId] = { displayName: String(info?.remark || info?.nickname || "").trim() || privateMetadata[userId]?.displayName || null };
}

async function maintenanceState() {
  let oneBotStatus = null;
  let oneBotError = null;
  try {
    const [login, status] = await Promise.all([oneBot.getLoginInfo(), oneBot.getStatus()]);
    oneBotStatus = { login: login.data, status: status.data };
  } catch (error) {
    oneBotError = error.message;
  }
  const threadLocks = threadReservations.snapshot();
  const threadLocksOk = Object.values(threadLocks).every((lock) => ["locked", "unbound"].includes(lock.status));
  return {
    ok: !oneBotError && threadLocksOk,
    hub: { host: hubHost, port: hubPort, authDisabled },
    oneBot: { ok: !oneBotError, ...oneBotStatus, error: oneBotError },
    codex: {
      dispatchEnabled: agentDispatchStore.isEnabled(),
      model: codexModel,
      reasoningEffort: codexEffort,
      autoCompactTokenLimit: codexAutoCompactTokenLimit,
      autoCompactTokenScope: codexAutoCompactTokenScope,
      activeTargets: codex.activeGroups(),
      reservationsOk: threadLocksOk,
      threadLocks
    },
    storage: {
      groupSessions: sessionStorePath,
      privateSessions: privateSessionStorePath,
      subscriptions: subscriptionStorePath,
      agentDispatch: agentDispatchStorePath,
      stickers: stickerStorePath,
      personaOwnerStyle: personaOwnerStylePath,
      mediaRoot,
      stickerLibrary: stickerLibraryDir
    }
  };
}

function assertTarget(targetType, targetId) {
  validateQqId(targetId, "Target QQ id");
  if (targetAllowlist.isRemoved(targetType,targetId) || removingTargets.has(`${targetType}:${targetId}`)) throw new HttpError(404,"会话已移除或正在删除");
  if (targetType === "group" && !allowedGroups.includes(String(targetId))) throw new HttpError(404, "Unknown Agent group");
  if (targetType === "private" && !privateStore.listGroups().some((item) => item.groupId === String(targetId))) throw new HttpError(404, "Unknown private Agent chat");
}

function validateQqId(value, label) {
  const id = String(value || "").trim();
  if (!/^\d{5,14}$/.test(id)) throw new HttpError(400, `${label} is invalid`);
  return id;
}

function validateCodexConfig(value, { targetType = "group", currentConfig = null } = {}) {
  const model = String(value?.model || "").trim();
  const selectedModel = codexModels.find((item) => item.model === model);
  if (!selectedModel) throw new HttpError(400, "请选择当前 Codex 账号可用的模型");
  const reasoningEffort = String(value?.reasoningEffort || "").trim();
  if (!selectedModel.supportedReasoningEfforts.some((item) => item.reasoningEffort === reasoningEffort)) {
    throw new HttpError(400, "所选模型不支持这个思考强度");
  }
  const requestedContext = value?.contextTokenLimit === "auto" ? "auto" : Number(value?.contextTokenLimit || 0);
  const contextTokenLimit = requestedContext === "auto" ? requestedContext : Number(requestedContext);
  if (!contextTokenOptions.some((item) => String(item.value) === String(contextTokenLimit))) {
    throw new HttpError(400, "请选择可用的上下文量");
  }
  const workingMode = "agent";
  const permissionMode = String(value?.permissionMode || "workspaceWrite");
  const permission = permissionModeOptions.find((item) => item.value === permissionMode);
  if (!permission || !permission.targetTypes.includes(targetType)) {
    throw new HttpError(400, "请选择可用的执行权限");
  }
  if (typeof value?.calendarRemindersEnabled !== "boolean") {
    throw new HttpError(400, "请选择是否允许当前会话写入日历和提醒事项");
  }
  const calendarRemindersEnabled = value.calendarRemindersEnabled;
  const homeAssistantPermission = String(value?.homeAssistantPermission ?? currentConfig?.homeAssistantPermission ?? "owner");
  const homePermission = homeAssistantPermissionOptions.find((item) => item.value === homeAssistantPermission);
  if (!homePermission || !homePermission.targetTypes.includes(targetType)) {
    throw new HttpError(400, "请选择可用的智能家居权限；私聊不能开放全群权限");
  }
  const greetingSlots = ["morning", "noon", "night"];
  const speakerGreetings = value?.speakerGreetings === undefined
    ? (currentConfig?.speakerGreetings || { morning: false, noon: false, night: false })
    : value.speakerGreetings;
  if (!speakerGreetings || typeof speakerGreetings !== "object" || Array.isArray(speakerGreetings)
    || Object.keys(speakerGreetings).length !== greetingSlots.length
    || !greetingSlots.every((slot) => typeof speakerGreetings[slot] === "boolean")) {
    throw new HttpError(400, "小爱定时问候须分别设置早上、中午和晚上的开关");
  }
  const enablingGreeting = greetingSlots.some((slot) => speakerGreetings[slot] && currentConfig?.speakerGreetings?.[slot] !== true);
  if (enablingGreeting && homeAssistantPermission === "disabled") {
    throw new HttpError(400, "请先开启当前会话的智能家居与小爱发言权限");
  }
  if (enablingGreeting && !speakerGreetingsAvailable) {
    throw new HttpError(400, "请先配置可用的小爱发言实体和 HA 凭证，再开启定时问候");
  }
  return { model, reasoningEffort, contextTokenLimit, workingMode, permissionMode, calendarRemindersEnabled, homeAssistantPermission, speakerGreetings: { ...speakerGreetings } };
}

function normalizeWorkBuddyContextLimit(value) {
  if (value === "auto") return "auto";
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "auto";
  return Math.min(1_000_000, Math.max(100_000, Math.floor(numeric)));
}

async function migrateWorkBuddyConversationConfigs(targetStore) {
  for (const conversation of targetStore.listGroups()) {
    const current = conversation.codexConfig || defaultCodexConfig;
    const normalizedLimit = normalizeWorkBuddyContextLimit(current.contextTokenLimit);
    if (normalizedLimit === current.contextTokenLimit && current.workingMode === "agent" && current.permissionMode) continue;
    await targetStore.setCodexConfig(conversation.groupId, {
      ...current,
      contextTokenLimit: normalizedLimit,
      workingMode: "agent",
      permissionMode: current.permissionMode || "workspaceWrite"
    });
  }
}

function reservationTargets() {
  return [
    ...store.listGroups()
      .filter((conversation) => allowedGroups.includes(conversation.groupId))
      .map((conversation) => reservationTarget("group", conversation)),
    ...privateStore.listGroups().filter((item) => !targetAllowlist.isRemoved("private",item.groupId)).map((conversation) => reservationTarget("private", conversation))
  ];
}

function reservationTarget(targetType, conversation) {
  const shared = sharedContexts.contextFor(targetType, conversation.groupId);
  const config = shared?.group.codexConfig || conversation.codexConfig || defaultCodexConfig;
  return {
    targetType,
    targetId: conversation.groupId,
    threadId: shared ? shared.group.threadId : conversation.threadId,
    model: config.model || codexModel,
    effort: config.reasoningEffort || codexEffort,
    contextTokenLimit: config.contextTokenLimit || codexAutoCompactTokenLimit || 200_000,
    workingMode: "agent",
    cwd: shared ? shared.cwd : targetType === "group"
      ? join(groupWorkspaceRoot, String(conversation.groupId))
      : projectDir
  };
}

async function refreshCodexModels() {
  const listed = await codex.listModels();
  const normalized = listed
    .filter((item) => !item.hidden && (item.model || item.id))
    .map((item) => ({
      model: String(item.model || item.id),
      displayName: String(item.displayName || item.model || item.id),
      description: String(item.description || ""),
      isDefault: Boolean(item.isDefault),
      defaultReasoningEffort: String(item.defaultReasoningEffort || "low"),
      reasoningCapabilitySource: String(item.reasoningCapabilitySource || "model-catalog"),
      supportedReasoningEfforts: (item.supportedReasoningEfforts || []).map((effort) => ({
        reasoningEffort: String(effort.reasoningEffort || ""),
        description: String(effort.description || "")
      })).filter((effort) => effort.reasoningEffort)
    }))
    .filter((item) => item.supportedReasoningEfforts.length);
  if (!normalized.some((item) => item.model === codexModel)) {
    const fallback = engineKind === "workbuddy"
      ? fallbackWorkBuddyModels(codexModel, codexEffort)
      : fallbackCodexModels(codexModel, codexEffort);
    normalized.push(...fallback.filter((item) => item.model === codexModel));
  }
  if (normalized.length) codexModels = normalized;
  await ensureStickerLabelModelAvailable();
  broadcast({ type: "model-catalog", state: publicState() });
}

function stickerLabelingState() {
  return {
    ...stickerLabelSettingsStore.snapshot(),
    ephemeralSession: true,
    retainsContext: false,
    cleanupPolicy: "delete-thread-and-candidate-after-each-batch"
  };
}

async function ensureStickerLabelModelAvailable() {
  const current = stickerLabelSettingsStore.snapshot().model;
  if (codexModels.some((item) => item.model === current)) return;
  const fallback = codexModels.find((item) => item.model === "hy3")?.model
    || codexModels.find((item) => item.isDefault)?.model
    || codexModels[0]?.model;
  if (fallback) await stickerLabelSettingsStore.setModel(fallback);
}

function fallbackCodexModels(currentModel, currentEffort) {
  const entries = [
    ["gpt-6-astra", "GPT-6 Astra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-sol", "GPT-5.6 Sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", "GPT-5.6 Terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", "GPT-5.6 Luna", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"]]
  ];
  if (!entries.some(([model]) => model === currentModel)) entries.unshift([currentModel, currentModel, [currentEffort]]);
  return entries.map(([model, displayName, efforts]) => ({
    model,
    displayName,
    description: "",
    isDefault: model === currentModel,
    defaultReasoningEffort: model === currentModel ? currentEffort : "low",
    supportedReasoningEfforts: [...new Set([...efforts, ...(model === currentModel ? [currentEffort] : [])])]
      .filter(Boolean)
      .map((reasoningEffort) => ({ reasoningEffort, description: "" }))
  }));
}

function fallbackWorkBuddyModels(currentModel, currentEffort) {
  const models = [
    "auto", "hy4-preview-f", "hy3", "hy3-x", "deepseek-v4.1-flash",
    "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo",
    "minimax-m3", "kimi-k3-1", "kimi-k2.8-preview", "kimi-k2.7", "kimi-k2.6",
    "deepseek-v4-pro", "hy4-preview"
  ];
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
  const efforts = ["auto", "minimal", "low", "medium", "high", "xhigh", "max"];
  return models.map((model) => ({
    model,
    displayName: model,
    description: "WorkBuddy 当前账号模型目录的启动兜底；连接完成后会自动刷新",
    isDefault: model === "auto",
    defaultReasoningEffort: efforts.includes(currentEffort) ? currentEffort : "auto",
    reasoningCapabilitySource: "workbuddy-cli-global",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort === "auto" ? "不固定档位，由当前模型决定" : "WorkBuddy CLI 公开档位；模型不支持时可能自动忽略"
    }))
  }));
}

function referencedMedia() {
  const subscriptionState = subscriptionStore.snapshot();
  const sourceMedia = Object.values(subscriptionState.sources || {}).flatMap((source) => source.messages || []).flatMap((message) => [...(message.images || []), ...(message.attachments || [])]);
  const pendingAttachments = [...store.listGroups(), ...privateStore.listGroups()]
    .flatMap((group) => group.pendingMessages || []).flatMap((message) => message.attachments || []);
  return [...store.referencedImages(), ...privateStore.referencedImages(), ...pendingAttachments, ...sourceMedia];
}

function publishTargetUpdate(keys) {
  const snapshot = publicState();
  const targets = Object.fromEntries(keys.flatMap((key) => {
    const [kind, id] = key.split(":");
    const target = (kind === "private" ? snapshot.qq.privateChats : snapshot.qq.groups)[id];
    return target ? [[key, target]] : [];
  }));
  broadcast({ type: "target-update", targets, activeTargets: snapshot.qq.activeTargets, activeGroups: snapshot.qq.activeGroups });
}

function recordEvent(event) {
  if (["delta", "private-delta", "agent-progress"].includes(event.type)) {
    const id = String(event.userId || event.groupId || "");
    const key = event.userId ? `private:${id}` : id.startsWith("private:") ? id : `group:${id}`;
    targetUpdateStream.queue(key);
    return;
  }
  const metadata = eventMetadata(event);
  recentEvents.unshift(metadata);
  recentEvents.splice(100);
  broadcast({ type: "event", event: metadata, state: publicState() });
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of sseClients) {
    try {
      response.write(line);
    } catch {
      sseClients.delete(response);
    }
  }
}

function openEventStream(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", ...corsHeaders() });
  res.write(`data: ${JSON.stringify({ type: "snapshot", state: publicState() })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

function rememberMessage(messageId) {
  const key = String(messageId || "");
  if (!key) return false;
  const now = Date.now();
  for (const [seen, at] of seenMessages) if (now - at > seenTtlMs) seenMessages.delete(seen);
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, now);
  return false;
}

function isAuthorized(req, path, rawBody) {
  if (path === "/api/onebot/event") {
    const signature = String(req.headers["x-signature"] || "").trim();
    if (signature && oneBotCallbackToken && rawBody) {
      const expected = Buffer.from(`sha1=${createHmac("sha1", oneBotCallbackToken).update(rawBody).digest("hex")}`);
      const actual = Buffer.from(signature);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
    }
    return requestTokens(req).some((candidate) => candidate && [oneBotAccessToken, oneBotCallbackToken].includes(candidate));
  }
  if (!apiToken) return true;
  return requestTokens(req).includes(apiToken);
}

function requestTokens(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const header = String(req.headers["x-codex-remote-token"] || "").trim();
  const query = requestUrl(req).searchParams.get("access_token") || "";
  return [bearer, header, query];
}

async function readRawBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > bodyLimit) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(rawBody) {
  if (!rawBody?.length) return {};
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function corsHeaders() {
  return { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-codex-remote-token, x-signature", "access-control-allow-methods": "GET, POST, OPTIONS" };
}

function requestUrl(req) {
  return new URL(req.url || "/", `http://${hubHost}:${hubPort}`);
}

async function serveStatic(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const requested = path === "/" ? "/index.html" : path;
  const relative = normalize(decodeURIComponent(requested)).replace(/^([/\\])+/, "");
  const filePath = resolve(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}/`)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const body = await readFile(filePath);
  res.writeHead(200, { "content-type": mimeType(filePath), "cache-control": "no-store" });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

function mimeType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" })[extname(path).toLowerCase()] || "application/octet-stream";
}

async function loadSettings(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { qq: { allowedGroups: [] }, ai: {} };
    throw error;
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(String).map((value) => value.trim()).filter(Boolean))];
}

function speakerGreetingBusy(type, id) {
  const activity = speakerGreetings.activityFor(type, id);
  return ["queued", "generating", "speaking"].includes(activity?.stage) ? activity : null;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function shutdown() {
  triggerManager.stop();
  privateTriggerManager.stop();
  qzone.stop();
  speakerGreetings.stop();
  stickerCuration.stop();
  threadReservations.stop();
  clearInterval(subscriptionTimer);
  clearInterval(mediaCleanupTimer);
  clearInterval(groupMetadataTimer);
  await codex.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
