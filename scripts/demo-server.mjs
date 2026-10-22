// Real production frontend, entirely synthetic state. Never reads live gateway
// state, credentials, chat history or media; all mutations are rejected.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../modules/web-console/public");
const now = "2026-09-28T04:20:00.000Z";
const msg = (id, name, text, extra = {}) => ({
  messageId: String(id), sequence: id, senderId: "100000003", senderName: name,
  text, timestamp: now, displayTime: "12:20:00", trust: "UNTRUSTED",
  senderRole: "member", images: [], attachments: [], ...extra
});
const config = { model: "hy4-preview", reasoningEffort: "low", contextTokenLimit: 200000,
  workingMode: "agent", permissionMode: "workspaceWrite", calendarRemindersEnabled: false, homeAssistantPermission: "owner",
  speakerGreetings: { morning: false, noon: false, night: false } };
const sub = (targetId) => ({ id: "demo-sub-" + targetId, targetType: "group", targetId,
  sourceGroupId: "300000001", sourceGroupName: "课程通知（演示）", mode: "AUTO",
  intakeMode: "ADMIN_ONLY", collectionDelayMinutes: 10, enabled: true,
  state: { pendingCount: 2, collectionDeadline: "2026-09-28T04:30:00.000Z" } });
const group = (id, name, extra = {}) => ({
  groupId: id, targetId: id, targetType: "group", groupName: name,
  threadId: "demo-thread-" + id, threadCreatedAt: now, lastActivityAt: now,
  threadLock: { status: "locked" }, conversationType: "AGENT_CHAT_GROUP",
  replyEnabled: true, codexConfig: config, pendingCount: 2, busy: false,
  pendingMessages: [msg(11, "小林", "图纸做好了 要不要看看"), msg(12, "阿岚", "@老代 帮忙检查一下尺寸")],
  lastCompletedReply: { text: "先核对轮廓尺寸\n导出的文件可以直接发到这个群", completedAt: now },
  activeReply: { running: false, text: "", status: "idle", error: null },
  subscriptions: [sub(id)], ...extra
});
const state = {
  agentDispatch: { enabled: true },
  persona: {
    name: "老代",
    catchphrases: [{ text: "好", when: "简短确认时按需使用" }],
    promptPreview: "<laodai_persona>\n你是老代。所有会话共用同一份固定人格。\n表达：简短自然，内容较长时按意群分句\n</laodai_persona>"
  },
  ai: { provider: "workbuddy-agent-sdk", model: "hy4-preview", reasoningEffort: "low",
    speakerGreetingsAvailable: process.env.DEMO_SPEAKER_GREETINGS_AVAILABLE !== "0",
    availableModels: ["auto", "hy4-preview", "hy3"].map((model) => ({
      model, displayName: model === "auto" ? "自动选择" : model, defaultReasoningEffort: "low",
      reasoningCapabilitySource: "workbuddy-cli-global",
      supportedReasoningEfforts: ["auto", "low", "medium", "high"].map((reasoningEffort) => ({
        reasoningEffort, description: "由已安装的 WorkBuddy CLI 提供，支持情况依模型而定"
      }))
    })),
    contextTokenOptions: [
      {value:"auto",label:"自动 · 跟随模型",description:"由引擎自动选择压缩阈值"},
      {value:100000,label:"最短 · 100K",description:"较早触发自动压缩"},
      {value:200000,label:"轻量 · 200K",description:"保留近期细节并自动压缩"}
    ],
    workModeOptions: [
      {value:"agent",label:"Agent · 执行任务",description:"按当前权限使用工具并执行任务"}
    ],
    homeAssistantPermissionOptions: [
      {value:"disabled",label:"关闭",targetTypes:["group","private"],description:"不允许当前会话读取或控制智能家居，也不能让小爱音箱说话"},
      {value:"owner",label:"仅 OWNER（你本人）",targetTypes:["group","private"],description:"只接受你本人在当前会话发出的家居和音箱请求"},
      {value:"group",label:"全群成员",targetTypes:["group"],description:"本群成员都可请求控制已开放的家居设备和小爱音箱"}
    ],
    permissionModeOptions: [
      {value:"readOnly",label:"只读",targetTypes:["group","private"],description:"不修改本机文件"},
      {value:"workspaceWrite",label:"工作区写入",targetTypes:["group","private"],description:"仅当前会话共享工作区"},
      {value:"dangerFullAccess",label:"完全访问（高风险）",targetTypes:["group","private"],description:"可访问整台电脑，仅对可信会话开启"}
    ]
  },
  qq: {
    ownerId: "100000001", activeTargets: ["200000001"],
    groups: {
      "200000001": group("200000001", "项目讨论（演示）", {
        busy: true, processing: {kind:"agent",cutoffSequence:12},
        activeReply: {running:true,text:"整体比例没有问题\n我正在核对标注和导出尺寸",status:"running",trigger:"mention",startedAt:now}
      }),
      "200000002": group("200000002", "学习交流（演示）", {
        pendingMessages: [msg(13, "管理员（演示）", "新通知记得整理一下", {trust:"OWNER",senderId:"100000001"})],
        pendingCount: 1,
        lastCompletedReply: { text:"明天 14:00 的讲座在活动中心\n通知整理完会发到这里",completedAt:now },
        ...(process.env.DEMO_QZONE_ACTIVITY ? {
          qzoneActivity: { kind:"feed", stage:"reading", processed:3, total:12, startedAt:now },
          activeReply: { running:true, text:"正在处理 QQ 空间任务…", status:"running", trigger:"qzone-feed", startedAt:now }
        } : {}),
        ...(process.env.DEMO_SPEAKER_GREETING_STAGE ? {
          speakerGreetingActivity: { jobId: "demo-speaker-greeting", stage: process.env.DEMO_SPEAKER_GREETING_STAGE,
            label: "早安", time: "07:00", scheduledAt: now,
            text: ["generating", "queued"].includes(process.env.DEMO_SPEAKER_GREETING_STAGE) ? "" : "早上好\n今天也顺顺利利",
            error: process.env.DEMO_SPEAKER_GREETING_STAGE === "uncertain" ? "播报结果未知，未自动重试" : null }
        } : {})
      })
    },
    privateChats: {
      "100000001": {...group("100000001", "管理员（演示）"), userId:"100000001",displayName:"管理员（演示）",targetType:"private",subscriptions:[]}
    },
    sourceGroups: {
      "300000001": {
        groupId:"300000001",groupName:"课程通知（演示）",retainedCount:2,recentCount:1,visibleCount:3,
        subscriptionCount:2,pendingSubscriberCount:1,
        subscriberProgress:[
          {subscriptionId:"demo-sub-200000001",targetType:"group",targetId:"200000001",targetName:"项目讨论（演示）",status:"complete",pendingCount:0,lastCompletedAt:now},
          {subscriptionId:"demo-sub-200000002",targetType:"group",targetId:"200000002",targetName:"学习交流（演示）",status:"collecting",pendingCount:2,collectionDeadline:"2026-09-28T04:30:00.000Z"}
        ],
        visibleMessages:[
          msg(21,"小林","讲座地点确定了吗"),
          msg(22,"通知管理员","明天 14:00 在活动中心举办设计讲座 请准时参加",{senderRole:"admin",retainedBySubscription:true,pendingSubscriberCount:1}),
          msg(23,"通知管理员","请提前十分钟签到",{senderRole:"admin",retainedBySubscription:true,pendingSubscriberCount:1})
        ]
      }
    },
    availableSourceGroups:[{groupId:"300000001",groupName:"课程通知（演示）"},{groupId:"300000002",groupName:"活动通知（演示）"}],
    stickers: {
      items: [
        ["demo-ok","认可方案或简短确认","OK","#76cbd7"],
        ["demo-wow","看到出乎意料的结果","!","#ddac73"],
        ["demo-hmm","思考或需要更多背景","?","#a3a5ef"],
        ["demo-no","委婉拒绝或轻度无语","NO","#d895ac"]
      ].map(([id,usage])=>({id,usage,receiveCount:5,sendCount:2,createdAt:now,lastSeenAt:now})),
      candidates:[{id:"demo-loading",status:"labeling",usage:"",receiveCount:1,createdAt:now}],
      excludedItems:[{id:"demo-blocked",usage:"重复且不适合当前群的表情",reason:"curation",receiveCount:0,hasPreview:true,canRestore:true,excludedAt:now}],
      excludedCount:1,awaitingAi:1,awaitingCommit:0,labeling:{model:"hy3"},
      curation:{status:"skipped",beforeCount:4}
    },
    qzone:{autoPostEnabled:false,autoEngageEnabled:false,targetType:"group",targetId:"200000002",scheduleTimes:["08:00","12:00","18:00"],events:[]}
  }
};
const maintenance = {hub:{authDisabled:true},oneBot:{ok:true,login:{nickname:"老代（演示）"}}};
const tiles = new Map([
  ["demo-ok",["OK","#76cbd7"]],["demo-wow",["!","#ddac73"]],
  ["demo-hmm",["?","#a3a5ef"]],["demo-no",["NO","#d895ac"]],
  ["demo-loading",["…","#80a7b8"]],["demo-blocked",["—","#aab2b9"]]
]);
const server = createServer(async (req,res) => {
  const path = new URL(req.url,"http://localhost").pathname;
  res.setHeader("Cache-Control","no-store");
  if (req.method !== "GET") { res.writeHead(403,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"演示模式：禁止真实操作"}));return; }
  if (path === "/api/qq/groups/available") {
    res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({ groups: [
      { groupId: "200000003", groupName: "新群聊（演示）" },
      { groupId: "200000004", groupName: "项目小组（演示）" }
    ] }));
  } else if (path === "/api/state" || path === "/api/maintenance") {
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(path === "/api/state" ? state : maintenance));
  } else if (path === "/api/qq/stream") {
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write("data: " + JSON.stringify({type:"snapshot",state}) + "\n\n");
    const heartbeat = setInterval(()=>res.write(": demo\n\n"),20000);
    req.on("close",()=>clearInterval(heartbeat));
  } else if (/^\/api\/qq\/stickers\/demo-[a-z]+\/image$/.test(path)) {
    const [label,color] = tiles.get(path.split("/")[4]) || ["?","#888"];
    res.setHeader("Content-Type","image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220"><rect width="320" height="220" rx="24" fill="'+color+'"/><circle cx="160" cy="98" r="62" fill="#fff" fill-opacity=".85"/><text x="160" y="118" text-anchor="middle" font-family="sans-serif" font-size="50" font-weight="700" fill="#182635">'+label+'</text><text x="160" y="195" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#182635">DEMO · 示例表情</text></svg>');
  } else if (["/","/client.html","/index.html","/client.css","/client.js","/client-status.js"].includes(path)) {
    const file = path === "/" || path === "/index.html" ? "client.html" : path.slice(1);
    res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html");
    res.end(await readFile(resolve(root,file)));
  } else {res.writeHead(404);res.end();}
});
server.listen(Number(process.env.DEMO_PORT || 3790),"127.0.0.1",()=>{
  console.log("Read-only demo: http://127.0.0.1:"+server.address().port+"/client.html");
});
process.on("SIGTERM",()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
