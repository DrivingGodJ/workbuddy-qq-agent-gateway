import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_ONEBOT_RESPONSE_BYTES = 4 * 1024 * 1024;

export class OneBotClient {
  constructor({
    baseUrl,
    accessToken = "",
    fetchImpl = fetch,
    longRequestImpl = requestJsonOverNodeHttp,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
    readOnlyGroupIds = [],
    canReply = () => true
  } = {}) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:3000").replace(/\/$/, "");
    this.accessToken = String(accessToken || "");
    this.fetchImpl = fetchImpl;
    this.longRequestImpl = longRequestImpl;
    this.fileUploadTimeoutMs = normalizeTimeout(fileUploadTimeoutMs, DEFAULT_FILE_UPLOAD_TIMEOUT_MS);
    this.readOnlyGroupIds = new Set((readOnlyGroupIds || []).map(String));
    this.canReply = canReply;
  }

  setReadOnlyGroupIds(groupIds = []) {
    this.readOnlyGroupIds = new Set(groupIds.map(String));
  }

  async getLoginInfo() {
    return this.request("/get_login_info", null, { method: "GET" });
  }

  async getStatus() {
    return this.request("/get_status", null, { method: "GET" });
  }

  async getGroupInfo(groupId) {
    const result = await this.request("/get_group_info", {
      group_id: Number(groupId),
      no_cache: false
    });
    return result.data || null;
  }

  async getGroupList() {
    const result = await this.request("/get_group_list", { no_cache: false });
    return Array.isArray(result.data) ? result.data : [];
  }

  async getGroupMemberInfo(groupId, userId, { noCache = false } = {}) {
    const result = await this.request("/get_group_member_info", {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: Boolean(noCache)
    }, { timeoutMs: 6000 });
    return result.data || null;
  }

  async getStrangerInfo(userId) {
    const result = await this.request("/get_stranger_info", {
      user_id: Number(userId),
      no_cache: false
    });
    return result.data || null;
  }

  async getMessage(messageId) {
    const result = await this.request("/get_msg", { message_id: Number(messageId) });
    return result.data || null;
  }

  async deleteMessage(messageId) {
    const id = String(messageId || "").trim();
    if (!/^-?\d+$/u.test(id)) throw new Error("无效的 QQ 消息 ID");
    const result = await this.request("/delete_msg", { message_id: Number(id) });
    if (result.body?.retcode != null && Number(result.body.retcode) !== 0) {
      throw new Error(result.body?.wording || `QQ 撤回失败：${result.body.retcode}`);
    }
    return { ok: true, status: result.status, body: result.body };
  }

  async getForwardMessages({ forwardId = null, messageId = null } = {}) {
    const body = forwardId ? { id: String(forwardId) } : { message_id: String(messageId || "") };
    const result = await this.request("/get_forward_msg", body, { timeoutMs: 10_000 });
    const messages = Array.isArray(result.data) ? result.data : result.data?.messages;
    if (!Array.isArray(messages)) throw new Error("QQ 未返回有效的合并转发记录");
    return messages;
  }

  async resolveImageRef(ref) {
    if (ref?.url) return { url: ref.url };
    if (!ref?.file) return null;
    const result = await this.request("/get_image", { file: ref.file });
    return result?.data || null;
  }

  async resolveGroupFileRef(groupId, ref) {
    if (ref?.url) return { url: ref.url };
    if (!ref?.fileId) return null;
    const result = await this.request("/get_group_file_url", {
      group_id: Number(groupId),
      file_id: String(ref.fileId),
      ...(ref.busid != null && Number.isFinite(Number(ref.busid)) ? { busid: Number(ref.busid) } : {})
    });
    return result?.data || null;
  }

  async sendGroupMessage(groupId, text, { replyToMessageId = null } = {}) {
    const message = [];
    if (replyToMessageId != null && !String(replyToMessageId).startsWith("codex-ui-")) {
      message.push({ type: "reply", data: { id: String(replyToMessageId) } });
    }
    message.push({ type: "text", data: { text: String(text || "") } });
    return this.sendGroupSegments(groupId, message);
  }

  async sendGroupImage(groupId, file) {
    return this.sendGroupSegments(groupId, [
      { type: "image", data: { file: String(file) } }
    ]);
  }

  async sendGroupSticker(groupId, file, { summary = "[动画表情]" } = {}) {
    return this.sendGroupSegments(groupId, [
      { type: "image", data: { file: String(file), sub_type: 1, summary: String(summary || "[动画表情]") } }
    ]);
  }

  async sendGroupMarketFace(groupId, { emojiId, emojiPackageId = 0, key = "", summary = "表情" } = {}) {
    return this.sendGroupSegments(groupId, [
      {
        type: "mface",
        data: {
          emoji_id: String(emojiId || ""),
          emoji_package_id: Number(emojiPackageId || 0),
          key: String(key || ""),
          summary: String(summary || "表情")
        }
      }
    ]);
  }

  async sendGroupFace(groupId, faceId) {
    return this.sendGroupSegments(groupId, [
      { type: "face", data: { id: Number(faceId) } }
    ]);
  }

  async sendGroupPoke(groupId, userId) {
    this.assertWritableGroup(groupId);
    const normalizedGroupId = requireNumericQqId(groupId, "group id");
    const normalizedUserId = requireNumericQqId(userId, "user id");
    const result = await this.request("/group_poke", {
      group_id: normalizedGroupId,
      user_id: normalizedUserId
    });
    return {
      ok: result.ok && (result.body?.status == null || result.body.status === "ok"),
      status: result.status,
      body: result.body
    };
  }

  async sendGroupSegments(groupId, message) {
    this.assertWritableGroup(groupId);
    const result = await this.request("/send_group_msg", {
      group_id: Number(groupId),
      message
    });
    return {
      ok: result.ok && (result.body?.status == null || result.body.status === "ok"),
      status: result.status,
      body: result.body
    };
  }

  async sendPrivateMessage(userId, text, { replyToMessageId = null } = {}) {
    return this.sendPrivateSegments(userId, [
      ...(replyToMessageId == null ? [] : [{ type: "reply", data: { id: String(replyToMessageId) } }]),
      { type: "text", data: { text: String(text || "") } }
    ]);
  }

  async sendPrivateImage(userId, file) {
    return this.sendPrivateSegments(userId, [
      { type: "image", data: { file: String(file) } }
    ]);
  }

  async sendPrivateSticker(userId, file, { summary = "[动画表情]" } = {}) {
    return this.sendPrivateSegments(userId, [
      { type: "image", data: { file: String(file), sub_type: 1, summary: String(summary || "[动画表情]") } }
    ]);
  }

  async sendPrivateMarketFace(userId, { emojiId, emojiPackageId = 0, key = "", summary = "表情" } = {}) {
    return this.sendPrivateSegments(userId, [
      {
        type: "mface",
        data: {
          emoji_id: String(emojiId || ""),
          emoji_package_id: Number(emojiPackageId || 0),
          key: String(key || ""),
          summary: String(summary || "表情")
        }
      }
    ]);
  }

  async sendPrivateFace(userId, faceId) {
    return this.sendPrivateSegments(userId, [
      { type: "face", data: { id: Number(faceId) } }
    ]);
  }

  async sendPrivateSegments(userId, message) {
    this.assertReplyEnabled("private", userId);
    const result = await this.request("/send_private_msg", {
      user_id: Number(userId),
      message
    });
    return {
      ok: result.ok && (result.body?.status == null || result.body.status === "ok"),
      status: result.status,
      body: result.body
    };
  }

  async uploadGroupFile(groupId, file, name) {
    this.assertWritableGroup(groupId);
    const result = await this.request("/upload_group_file", {
      group_id: Number(groupId),
      file: String(file),
      name: String(name || "file"),
      upload_file: true
    }, {
      // SnowLuma keeps this HTTP request open until QQ's chunked Highway upload
      // is complete. Node's built-in fetch gives up waiting for response headers
      // after roughly five minutes, even though SnowLuma can still finish and
      // publish the file later. Use the native HTTP path with an explicit long
      // timeout so a slow but successful upload is not recorded as failed.
      longRunning: true,
      timeoutMs: this.fileUploadTimeoutMs
    });
    return {
      ok: result.ok && (result.body?.status == null || result.body.status === "ok"),
      status: result.status,
      body: result.body,
      fileId: result.data?.file_id || null
    };
  }

  async fetchCustomFaceDetails(count = 1000) {
    const result = await this.request("/fetch_custom_face_detail", {
      count: Math.max(0, Math.floor(Number(count) || 0))
    });
    return Array.isArray(result.data) ? result.data : [];
  }

  async addCustomFace(file) {
    const result = await this.request("/add_custom_face", { file: String(file) });
    return {
      emojiId: String(result.data?.emoji_id || result.data || "").trim() || null,
      body: result.body
    };
  }

  async deleteCustomFace(emojiId) {
    const id = String(emojiId || "").trim();
    if (!id) throw new Error("无效的 QQ 收藏表情 ID");
    const result = await this.request("/delete_custom_face", { emoji_id: id }, { timeoutMs: 15_000 });
    if (result.body?.status !== "ok" || result.body?.retcode == null || Number(result.body.retcode) !== 0) {
      throw new Error(result.body?.wording || result.body?.message || "QQ 收藏表情删除结果不确定");
    }
    return { ok: true };
  }

  async modifyCustomFace(emojiId, description) {
    const result = await this.request("/modify_custom_face", {
      emoji_id: String(emojiId),
      desc: String(description || "").slice(0, 80)
    });
    return { ok: result.ok, status: result.status, body: result.body };
  }

  async getQzoneFeeds(count = 30) {
    return (await this.getQzoneFeedPage(1, count)).feeds;
  }

  async getQzoneFeedPage(pageNum = 1, count = 50) {
    const result = await this.requestQzone("/get_qzone_feeds", {
      page_num: Math.max(1, Math.floor(Number(pageNum) || 1)),
      count: Math.max(1, Math.min(50, Math.floor(Number(count) || 30)))
    });
    return {
      feeds: Array.isArray(result.data?.feeds) ? result.data.feeds : [],
      hasMore: typeof result.data?.has_more === "boolean" ? result.data.has_more : null
    };
  }

  async publishQzone(content, { images = [] } = {}) {
    return this.requestQzone("/send_qzone_msg", {
      content: String(content || ""),
      images: images.map(String),
      ugc_right: 1
    });
  }

  async likeQzone({ uin, tid, abstime = 0 }) {
    return this.requestQzone("/like_qzone", {
      target_uin: requireNumericQqId(uin, "user id"),
      tid: String(tid || ""),
      abstime: Math.max(0, Math.floor(Number(abstime) || 0))
    });
  }

  async commentQzone({ uin, tid, content }) {
    return this.requestQzone("/comment_qzone", {
      target_uin: requireNumericQqId(uin, "user id"),
      tid: String(tid || ""),
      content: String(content || "")
    });
  }

  async requestQzone(path, body) {
    const result = await this.request(path, body);
    if (result.body?.retcode != null && Number(result.body.retcode) !== 0) {
      const error = new Error(result.body?.wording || result.body?.message || `QQ 空间请求失败 (${result.body.retcode})`);
      error.code = "QZONE_ACTION_FAILED";
      throw error;
    }
    return result;
  }

  assertWritableGroup(groupId) {
    if (this.readOnlyGroupIds.has(String(groupId))) {
      const error = new Error(`QQ group ${groupId} is a READ_ONLY_SOURCE_GROUP`);
      error.code = "READ_ONLY_SOURCE_GROUP";
      throw error;
    }
    this.assertReplyEnabled("group", groupId);
  }

  assertReplyEnabled(targetType, targetId) {
    if (this.canReply(targetType, String(targetId))) return;
    const error = new Error("本会话回复已关闭，消息继续记录");
    error.code = "REPLY_DISABLED";
    throw error;
  }

  async request(path, body = null, { method = "POST", longRunning = false, timeoutMs = null } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      ...(body == null ? {} : { "content-type": "application/json" }),
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {})
    };
    const payload = body == null ? null : JSON.stringify(body);
    const response = longRunning
      ? await this.longRequestImpl(url, { method, headers, body: payload, timeoutMs })
      : await this.fetchImpl(url, {
          method,
          headers,
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
          ...(payload == null ? {} : { body: payload })
        });
    const parsed = longRunning
      ? (response.body && typeof response.body === "object" ? response.body : {})
      : await response.json().catch(() => ({}));
    if (!response.ok || parsed?.status === "failed") {
      const error = new Error(parsed?.wording || parsed?.message || `OneBot ${path} returned HTTP ${response.status}`);
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    return { ok: response.ok, status: response.status, body: parsed, data: parsed?.data };
  }
}

function requireNumericQqId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{5,14}$/.test(normalized)) throw new Error(`Invalid QQ ${label}`);
  return Number(normalized);
}

function requestJsonOverNodeHttp(url, { method = "POST", headers = {}, body = null, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHeaders = {
      ...headers,
      ...(body == null ? {} : { "content-length": Buffer.byteLength(body) })
    };
    const request = requestImpl(target, { method, headers: requestHeaders }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ONEBOT_RESPONSE_BYTES) {
          const error = new Error("OneBot response exceeded the configured size limit");
          error.code = "ONEBOT_RESPONSE_TOO_LARGE";
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let parsed = {};
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = {};
          }
        }
        const status = Number(response.statusCode || 0);
        resolve({ ok: status >= 200 && status < 300, status, body: parsed });
      });
    });
    request.once("error", reject);
    if (Number(timeoutMs) > 0) {
      request.setTimeout(Number(timeoutMs), () => {
        const error = new Error(`OneBot file upload timed out after ${Number(timeoutMs)} ms`);
        error.code = "ONEBOT_FILE_UPLOAD_TIMEOUT";
        request.destroy(error);
      });
    }
    if (body != null) request.write(body);
    request.end();
  });
}

function normalizeTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
