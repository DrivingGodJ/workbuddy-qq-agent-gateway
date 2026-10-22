import test from "node:test";
import assert from "node:assert/strict";
import { searchReactions } from "../src/qq/reaction-search.js";
import { handleQqMcpTool } from "../src/qq/mcp-actions.js";
import { compactMessageContext } from "../src/security/message-context.js";
import { buildTurnPrompt, buildMcpTurnPrompt } from "../src/security/policy.js";
import { buildPrivateTurnPrompt } from "../src/security/subscription-policy.js";
import { TurnDiagnostics } from "../src/workbuddy/turn-diagnostics.js";
import { TargetUpdateStream } from "../src/qq/target-update-stream.js";
import { WorkBuddyClient } from "../src/workbuddy/client.js";
import { conversationStatus } from "../modules/web-console/public/client-status.js";

const stickers = Array.from({ length: 30 }, (_, i) => ({
  id: `st_${i.toString(16).padStart(12, "0")}`, usage: i % 2 ? "疑惑 没看懂" : "赞同 认可 很好"
}));

test("reaction lookup is bounded, deterministic, searchable and pageable", () => {
  const first = searchReactions(stickers, ["微笑", "疑问"]);
  assert.equal(first.stickers.length, 8);
  assert.equal(first.totalStickers, 30);
  assert.equal(first.nextOffset, 8);
  const next = searchReactions(stickers, [], { offset: first.nextOffset });
  assert.equal(next.stickers[0].id, stickers[8].id);
  const match = searchReactions(stickers, ["微笑", "疑问"], { query: "疑惑 没看懂", limit: 20 });
  assert.equal(match.totalStickers, 15);
  assert.equal(match.nextOffset, null);
  assert.ok(match.stickers.every((item) => item.usage.includes("疑惑")));
  assert.equal(searchReactions(stickers, [], { query: "完全不匹配" }).totalStickers, 0);
  assert.deepEqual(first, searchReactions(stickers, ["微笑", "疑问"]));
});

test("reaction lookup rejects invalid arguments and cannot invent unlabeled IDs", () => {
  const items = [stickers[0], stickers[0], { id: "fake", usage: "好" }, { id: stickers[1].id, usage: "  " }];
  assert.deepEqual(searchReactions(items).stickers, [stickers[0]]);
  for (const args of [{limit:21}, {limit:0}, {offset:-1}, {offset:1.5}, {query:7}, {query:"长".repeat(81)}]) {
    assert.throws(() => searchReactions(stickers, [], args));
    assert.equal(handleQqMcpTool({ name:"list_reactions", args, context:{allowReactions:true,stickers} }).isError, true);
  }
  const response = handleQqMcpTool({ name:"list_reactions", args:{query:"赞同",limit:2}, context:{allowReactions:true,stickers} });
  assert.equal(JSON.parse(response.content[0].text).stickers.length, 2);
  assert.equal(handleQqMcpTool({name:"list_reactions",context:{allowReactions:false,stickers}}).isError, true);
});

const messages = Array.from({length:20}, (_, i) => ({
  messageId: String(i + 1), senderId: i % 2 ? "100000003" : "100000001",
  senderName: i % 2 ? "讨论者" : "管理员", trust:i % 2 ? "UNTRUSTED" : "OWNER",
  displayTime:`2026-10-03 15:00:${String(i).padStart(2,"0")}`, text:`第 ${i+1} 条消息 原文 @某人（QQ 100000004）`, images:[], attachments:[]
}));

test("compact pages preserve all message facts, inline mentions, quotes, resources and image status", () => {
  const rows = structuredClone(messages.slice(0, 3));
  rows[1].replyToMessageId = "1";
  rows[2].replyToMessageId = "-999";
  rows[2].quotedMessage = {messageId:"-999", senderId:"100000005", senderName:"引用者", displayTime:"昨日", text:"被清理掉的原文"};
  rows[2].text += "\n换行保留，emoji 🙂 保留";
  rows[2].links = ["https://example.com/page"];
  rows[2].attachments = [{type:"forward",name:"合并转发"}];
  rows[2].images = [{localPath:"/tmp/qq-test-image",stickerId:stickers[0].id,stickerNeedsReview:true},{error:"下载超时"}];
  const prompt = compactMessageContext(rows).join("\n");
  for (const row of rows) assert.ok(prompt.includes(row.text));
  assert.match(prompt, /100000001=管理员\[OWNER\]/);
  assert.match(prompt, /100000003=讨论者\[UNTRUSTED\]/);
  assert.match(prompt, /回复消息 ID 1（仍在当前待处理消息中/);
  assert.match(prompt, /不可信引用.*被清理掉的原文/);
  assert.match(prompt, /read_forward_messages/);
  assert.match(prompt, /https:\/\/example.com\/page/);
  assert.match(prompt, /视觉输入；独立标注中，不可发送/);
  assert.match(prompt, /下载失败:下载超时/);
});

test("permissions appear once at the round entrance, not in every message page", () => {
  const security = {mode:"RISK_SCOPED_READ_ONLY",turnSandbox:{type:"readOnly"},allowQqFiles:false};
  for (const type of ["group","private"]) {
    const entrance = buildMcpTurnPrompt({security,targetType:type,sharedSystemInstructions:true});
    const options = {security,compact:true,includePermissionNotice:false,includeResponseInstruction:false};
    const page = type === "group" ? buildTurnPrompt(messages, options) : buildPrivateTurnPrompt(messages, [], {...options,userId:"100000001"});
    assert.equal((entrance + page).split("【本轮权限】").length - 1, 1);
    for (const row of messages) assert.ok(page.includes(row.text));
  }
  const old = buildTurnPrompt(messages, {includeResponseInstruction:false});
  const compact = buildTurnPrompt(messages, {compact:true,includePermissionNotice:false,includeResponseInstruction:false});
  assert.ok(compact.length < old.length * .8, `${compact.length} vs ${old.length}`);
});

test("diagnostics keep latest envelope only, missing cache values stay unknown", () => {
  let now = 100;
  const diagnostics = new TurnDiagnostics({clock:()=>now,limit:2});
  diagnostics.start("a",{prompt:"长".repeat(35000),model:"demo",groupId:"1",imagePaths:["/image"]});
  assert.equal(diagnostics.snapshot("a").inputPreview, undefined);
  assert.equal(diagnostics.snapshot("a",{includeInput:true}).inputPreview.length, 32000);
  now = 150;
  diagnostics.progress("a","tool","list_reactions");
  diagnostics.progress("a","tool");
  diagnostics.progress("a","text");
  diagnostics.usage("a",{inputTokens:7,outputTokens:2});
  assert.equal(diagnostics.snapshot("a").toolCalls,1);
  assert.equal(diagnostics.snapshot("a").firstTextMs,50);
  assert.equal(diagnostics.snapshot("a").usage.cachedTokens,null);
  diagnostics.finish("a");
  diagnostics.progress("a","text");
  assert.equal(diagnostics.snapshot("a").stage,"complete");
  diagnostics.start("a",{prompt:"下一轮",model:"demo",groupId:"1"});
  assert.equal(diagnostics.snapshot("a").requests,2);
  assert.equal(diagnostics.snapshot("a",{includeInput:true}).inputPreview,"下一轮");
  diagnostics.start("b",{prompt:"b"});
  diagnostics.start("c",{prompt:"c"});
  assert.equal(diagnostics.snapshot("a"),null);
});

test("diagnostics include bridge start failures but never adopt another thread's usage", async () => {
  const client = new WorkBuddyClient();
  client.ensureProcess = async () => {};
  client.request = async () => { throw new Error("bridge start failure"); };
  await assert.rejects(client.runTurn({groupId:"g",threadId:"t",prompt:"测试"}),/bridge start failure/);
  assert.equal(client.diagnostics.snapshot("t").stage,"failed");
  client.diagnostics.start("t",{prompt:"下一轮"});
  client.activeByTurn.set("turn",{turnId:"turn",threadId:"t",groupId:"g"});
  client.handleMessage({method:"turn/usage",params:{turnId:"turn",threadId:"another",usage:{inputTokens:999}}});
  assert.equal(client.diagnostics.snapshot("t").usage,null);
  client.handleMessage({method:"turn/usage",params:{turnId:"turn",threadId:"t",usage:{inputTokens:7}}});
  assert.equal(client.diagnostics.snapshot("t").usage.inputTokens,7);
  client.activeByTurn.clear();
});

test("stream batches UI updates only and flushes all changed targets once", () => {
  const emitted = [];
  let callback;
  let schedules=0;
  const stream = new TargetUpdateStream({emit:keys=>emitted.push(keys),schedule:fn=>{callback=fn;schedules++;return 1;},cancel:()=>{}});
  stream.queue("group:1"); stream.queue("private:2"); stream.queue("group:1");
  assert.equal(schedules,1);
  assert.deepEqual(emitted,[]);
  callback();
  assert.deepEqual(emitted,[["group:1","private:2"]]);
  stream.flush();
  assert.equal(emitted.length,1);
  stream.queue("group:3");callback();
  assert.deepEqual(emitted[1],["group:3"]);
});

test("UI states distinguish compaction, countdown, maintenance queue and errors", () => {
  assert.equal(conversationStatus({activeReply:{running:true},diagnostics:{stage:"compacting",finishedAtMs:null}}).short,"压缩中");
  const waiting = conversationStatus({activeReply:{running:true,waiting:true,waitUntil:new Date(120000).toISOString()}},{},60000);
  assert.match(waiting.detail,/1:00/);
  assert.match(waiting.detail,/不调用模型/);
  assert.match(conversationStatus({activeReply:{status:"queued"}},{taskGate:{blocked:true},qq:{stickers:{curation:{status:"running"}}}}).detail,/表情筛选/);
  assert.equal(conversationStatus({lastError:"failed"}).short,"失败");
  assert.equal(conversationStatus({activeReply:{running:true}},{agentDispatch:{enabled:false}}).short,"已暂停");
  assert.equal(conversationStatus({qzoneActivity:{kind:"feed",stage:"queued"}}).short,"动态排队");
});
