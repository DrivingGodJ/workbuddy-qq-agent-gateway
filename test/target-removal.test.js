import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetAllowlistSettings } from "../src/storage/target-allowlist-settings.js";
import { SessionStore } from "../src/storage/session-store.js";
import { SubscriptionStore } from "../src/storage/subscription-store.js";
import { QzoneStore } from "../src/qq/qzone-store.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";
import { removeGatewayTarget, targetBusyForRemoval } from "../src/qq/target-removal.js";

const ids = { group:"200000001", other:"200000002", private:"100000001", source:"300000001" };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-remove-target-"));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const allowlist = new TargetAllowlistSettings({filePath:join(directory,"settings.json"),settings:{
    ai:{model:"auto"},qq:{allowedGroups:[ids.group,ids.other],privateAgentUsers:[ids.private]}
  }});
  const targetStore = new SessionStore({filePath:join(directory,"sessions.json")});
  await targetStore.init({allowedGroups:[ids.group,ids.other,ids.private]});
  const subscriptions = new SubscriptionStore({filePath:join(directory,"subscriptions.json")});
  await subscriptions.init();
  const qzoneStore = new QzoneStore({filePath:join(directory,"qzone.json")});
  await qzoneStore.init();
  return {directory,allowlist,targetStore,subscriptions,qzoneStore,archiveDir:join(directory,"removed-targets")};
}
const sourceMessage = {groupId:ids.source,messageId:"notice-1",senderId:"100000003",
  senderName:"通知管理员",senderRole:"admin",text:"明天上课",timestamp:"2026-10-03T00:00:00Z",images:[],attachments:[]};

for (const type of ["group","private"]) {
  test(`${type} removal archives only that conversation, subscriptions and Qzone binding`, async (t) => {
    const f = await fixture(t), id = ids[type];
    const original = f.targetStore.ensureGroup(id);
    original.threadId = "demo-persistent-thread";
    await f.targetStore.appendMessage({...sourceMessage,groupId:id,messageId:"own-message"});
    await f.subscriptions.upsertSubscription({targetType:type,targetId:id,sourceGroupId:ids.source,intakeMode:"ALL"});
    await f.subscriptions.upsertSubscription({targetType:"group",targetId:ids.other,sourceGroupId:ids.source,intakeMode:"ALL"});
    await f.subscriptions.appendSourceMessage(sourceMessage);
    await f.qzoneStore.configure({targetType:type,targetId:id,autoPostEnabled:true,autoEngageEnabled:true});
    const other = f.targetStore.snapshot(ids.other);
    let disabled = false;
    const result = await removeGatewayTarget({...f,type,id,onDisabled:() => {
      disabled = true;
      assert.equal(f.allowlist.isRemoved(type,id),true,"persist exclusion before disabling runtime");
    }});
    assert.equal(disabled,true);
    assert.equal(result.removed,true);
    assert.equal(result.threadId,"demo-persistent-thread");
    assert.equal(result.subscriptionCount,1);
    assert.deepEqual(result.removedMessages.map((message) => message.messageId),["own-message"],"only the deleted target media is released; another subscriber still needs the source notification");
    assert.deepEqual(f.targetStore.snapshot(ids.other),other);
    assert.equal(f.targetStore.listGroups().some((item) => item.groupId === id),false);
    assert.equal(f.allowlist.list(type).includes(id),false);
    const archive = JSON.parse(await readFile(result.archiveFile,"utf8"));
    assert.equal(Object.hasOwn(archive.conversation,"pendingMessages"),false);
    assert.equal(archive.version,2);
    assert.equal(archive.conversation.threadId,"demo-persistent-thread");
    assert.equal(archive.subscriptions.length,1);
    assert.equal(archive.qzoneBinding.targetId,id);
    assert.equal((await stat(result.archiveFile)).mode & 0o777,0o600);
    assert.equal((await stat(f.archiveDir)).mode & 0o777,0o700);
    assert.equal(f.subscriptions.listSubscriptions().length,1);
    assert.equal(f.subscriptions.listSubscriptions()[0].state.pendingCount,1);
    assert.equal(f.qzoneStore.snapshot().targetId,null);
    const reloaded = new TargetAllowlistSettings({filePath:f.allowlist.filePath,
      settings:JSON.parse(await readFile(f.allowlist.filePath,"utf8"))});
    assert.equal(reloaded.isRemoved(type,id),true);
    assert.equal(reloaded.settings.ai.model,"auto");
    await reloaded.add(type,id);
    assert.equal(reloaded.isRemoved(type,id),false);
    await f.targetStore.addConversation(id);
    assert.equal(f.targetStore.snapshot(id).threadId,null,"re-adding starts a fresh conversation");
    assert.equal(f.targetStore.snapshot(id).pendingMessages.length,0);
  });
}

test("removing a different target keeps Qzone binding and active subscriber claims intact", async (t) => {
  const f = await fixture(t);
  await f.qzoneStore.configure({targetType:"group",targetId:ids.other,autoEngageEnabled:true});
  await f.subscriptions.upsertSubscription({targetType:"group",targetId:ids.group,sourceGroupId:ids.source});
  await f.subscriptions.upsertSubscription({targetType:"group",targetId:ids.other,sourceGroupId:ids.source});
  await f.subscriptions.appendSourceMessage(sourceMessage);
  f.subscriptions.clock = () => new Date("2100-01-01T00:00:00Z");
  const claim = await f.subscriptions.claimForTarget("group",ids.other,{mode:"AUTO"});
  const before = f.subscriptions.listSubscriptions({targetId:ids.other})[0];
  await removeGatewayTarget({...f,type:"group",id:ids.group});
  assert.equal(f.qzoneStore.snapshot().targetId,ids.other);
  assert.deepEqual(f.subscriptions.listSubscriptions({targetId:ids.other})[0],before);
  await f.subscriptions.completeClaims(claim);
  assert.equal(f.subscriptions.listSubscriptions({targetId:ids.other})[0].state.pendingCount,0);
});

test("busy targets cannot be removed; waiting, queued, sticker and Qzone work also count as busy", async (t) => {
  const f = await fixture(t);
  f.targetStore.ensureGroup(ids.group).busy = true;
  await assert.rejects(removeGatewayTarget({...f,type:"group",id:ids.group}),/进行中的任务/);
  assert.equal(f.allowlist.isRemoved("group",ids.group),false);
  const idle = {groupId:ids.group};
  assert.equal(targetBusyForRemoval({},idle),false);
  for (const name of ["running","waitingChat","qzoneReservations"]) {
    assert.equal(targetBusyForRemoval({[name]:new Map([[ids.group,true]])},idle),true);
  }
  assert.equal(targetBusyForRemoval({stickerLabels:{recognitionQueues:new Map([[ids.group,[]]])}},idle),true);
  assert.equal(targetBusyForRemoval({stickerLabels:{hasCommitBarrier:() => true}},idle),true);
  assert.equal(targetBusyForRemoval({},idle,{kind:"feed"}),true);
});

test("archive failure makes no destructive change; interrupted cleanup remains excluded and can be retried", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.directory,"not-a-directory");
  await writeFile(blocked,"blocked");
  await assert.rejects(removeGatewayTarget({...f,archiveDir:blocked,type:"group",id:ids.group}));
  assert.equal(f.allowlist.isRemoved("group",ids.group),false);
  const removeTarget = f.subscriptions.removeTarget.bind(f.subscriptions);
  f.subscriptions.removeTarget = async () => { throw new Error("disk interrupted"); };
  await assert.rejects(removeGatewayTarget({...f,type:"group",id:ids.group}),/disk interrupted/);
  assert.equal(f.allowlist.isRemoved("group",ids.group),true);
  assert.equal(f.targetStore.listGroups().some((item) => item.groupId === ids.group),true);
  f.subscriptions.removeTarget = removeTarget;
  await removeGatewayTarget({...f,type:"group",id:ids.group});
  assert.equal(f.targetStore.listGroups().some((item) => item.groupId === ids.group),false);
  const count = (await readdir(f.archiveDir)).length;
  const retry = await removeGatewayTarget({...f,type:"group",id:ids.group});
  assert.equal(retry.removed,true);
  assert.equal(retry.archiveFile,null);
  assert.equal((await readdir(f.archiveDir)).length,count,"idempotent retry does not archive an empty ghost");
});

test("removed private targets cannot be recreated by stale triggers, including unrestricted managers", async (t) => {
  const f = await fixture(t);
  const manager = new TriggerManager({store:f.targetStore});
  manager.disallowGroup(ids.private);
  await removeGatewayTarget({...f,type:"private",id:ids.private});
  assert.equal(await manager.request(ids.private,"mention"),null);
  assert.equal(await manager.reconsiderPending(ids.private),null);
  assert.equal(f.targetStore.listGroups().some((item) => item.groupId === ids.private),false);
  manager.allowGroup(ids.private);
  assert.equal(manager.isAllowed(ids.private),true);
});

test("allowlist tombstones win over legacy duplicate IDs and serialized add/remove operations", async (t) => {
  const f = await fixture(t);
  f.allowlist.settings.qq.removedAgentTargets = {group:[ids.group,"../../bad"]};
  assert.deepEqual(f.allowlist.removed("group"),[ids.group]);
  assert.deepEqual(f.allowlist.list("group"),[ids.other]);
  await Promise.all([f.allowlist.add("group",ids.group),f.allowlist.remove("group",ids.group),f.allowlist.add("private","100000009")]);
  assert.equal(f.allowlist.isRemoved("group",ids.group),true);
  assert.equal(f.allowlist.list("private").includes("100000009"),true);
  await f.allowlist.add("group",ids.group);
  assert.equal(f.allowlist.isRemoved("group",ids.group),false);
});

test("unknown, source and malformed target removals are rejected without touching known targets", async (t) => {
  const f = await fixture(t), before = f.targetStore.listGroups();
  await assert.rejects(removeGatewayTarget({...f,type:"source",id:ids.source}),/Invalid QQ target/);
  await assert.rejects(removeGatewayTarget({...f,type:"group",id:"../../file"}),/Invalid QQ target/);
  await assert.rejects(removeGatewayTarget({...f,type:"group",id:"900000009"}),/Unknown/);
  assert.deepEqual(f.targetStore.listGroups(),before);
});
