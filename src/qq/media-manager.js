import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const EXT_BY_MIME = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/heic", ".heic"]
]);

export class QqMediaManager {
  constructor({
    rootDir,
    maxImageBytes = 20 * 1024 * 1024,
    maxAttachmentBytes = 1024 * 1024 * 1024,
    orphanTtlMs = 24 * 60 * 60 * 1000,
    maxTotalBytes = 200 * 1024 * 1024,
    maxReferencedAgeMs = 48 * 60 * 60 * 1000,
    clock = () => Date.now(),
    fetchImpl = fetch
  } = {}) {
    this.rootDir = resolve(rootDir);
    this.maxImageBytes = maxImageBytes;
    this.maxAttachmentBytes = maxAttachmentBytes;
    this.orphanTtlMs = orphanTtlMs;
    this.maxTotalBytes = Math.max(1024 * 1024, Number(maxTotalBytes) || 200 * 1024 * 1024);
    this.maxReferencedAgeMs = Math.max(60_000, Number(maxReferencedAgeMs) || 48 * 60 * 60 * 1000);
    this.clock = clock;
    this.fetchImpl = fetchImpl;
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
  }

  async cacheMessageImages(message, { resolveImageRef } = {}) {
    const refs = Array.isArray(message.imageRefs) ? message.imageRefs : [];
    if (refs.length === 0) return [];
    const messageDir = this.messageDir(message.groupId, message.messageId);
    await mkdir(messageDir, { recursive: true });
    const images = [];

    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      try {
        const resolvedRef = resolveImageRef ? await resolveImageRef(ref).catch(() => null) : null;
        images.push({
          ...(await this.cacheOne(ref, resolvedRef, messageDir, index + 1)),
          context: ref.context || null,
          summary: ref.summary || null,
          subType: Number(ref.subType || 0),
          emojiId: ref.emojiId || null,
          emojiPackageId: Number(ref.emojiPackageId || 0),
          emojiKey: ref.emojiKey || "",
          isSticker: Boolean(ref.isSticker)
        });
      } catch (error) {
        images.push({
          localPath: null,
          mimeType: null,
          originalUrl: ref.url || null,
          size: 0,
          error: String(error?.message || error).slice(0, 500)
        });
      }
    }
    return images;
  }

  async cacheMessageAttachments(message, { resolveAttachmentRef } = {}) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (attachments.length === 0) return [];
    const messageDir = this.messageDir(message.groupId, message.messageId);
    const cached = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      // Cards and forwards are references, not downloadable local files.
      if (["forward", "json"].includes(attachment.type)) {
        cached.push({ ...attachment, localPath: null });
        continue;
      }
      await mkdir(messageDir, { recursive: true });
      try {
        const resolvedRef = resolveAttachmentRef ? await resolveAttachmentRef(attachment).catch(() => null) : null;
        cached.push({ ...attachment, ...(await this.cacheAttachment(attachment, resolvedRef, messageDir, index + 1)) });
      } catch (error) {
        cached.push({ ...attachment, localPath: null, error: String(error?.message || error).slice(0, 500) });
      }
    }
    return cached;
  }

  async cacheAttachment(ref, resolvedRef, messageDir, number) {
    const source = chooseSource(ref, resolvedRef);
    if (!source) throw new Error("OneBot attachment did not include a downloadable URL or accessible file");
    const name = safeFilename(ref.name || ref.file || `attachment-${number}`);
    const localPath = join(messageDir, `attachment-${number}-${name}`);
    const partialPath = `${localPath}.partial`;
    if (source.kind === "file") {
      const info = await stat(source.path);
      if (!info.isFile()) throw new Error("OneBot attachment path is not a file");
      if (info.size > this.maxAttachmentBytes) throw new Error(`Attachment exceeds ${this.maxAttachmentBytes} bytes`);
      await copyFile(source.path, partialPath);
      await rename(partialPath, localPath);
      return { localPath, size: info.size, originalUrl: ref.url || null };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response;
    try {
      response = await this.fetchImpl(source.url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`Attachment download returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > this.maxAttachmentBytes) throw new Error(`Attachment exceeds ${this.maxAttachmentBytes} bytes`);
      let size = 0;
      const limiter = new Transform({
        transform: (chunk, _encoding, callback) => {
          size += chunk.length;
          callback(size > this.maxAttachmentBytes ? new Error(`Attachment exceeds ${this.maxAttachmentBytes} bytes`) : null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partialPath, { mode: 0o600 }));
      await rename(partialPath, localPath);
      return { localPath, size, originalUrl: source.url };
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async cacheOne(ref, resolvedRef, messageDir, imageNumber) {
    const source = chooseSource(ref, resolvedRef);
    if (!source) throw new Error("OneBot image did not include a downloadable URL or accessible file");

    if (source.kind === "file") {
      const info = await stat(source.path);
      if (!info.isFile()) throw new Error("OneBot image path is not a file");
      if (info.size > this.maxImageBytes) throw new Error(`Image exceeds ${this.maxImageBytes} bytes`);
      const extension = safeImageExtension(extname(source.path)) || ".img";
      const localPath = join(messageDir, `image-${imageNumber}${extension}`);
      const partialPath = `${localPath}.partial`;
      await copyFile(source.path, partialPath);
      await rename(partialPath, localPath);
      return {
        localPath,
        mimeType: mimeFromExtension(extension),
        originalUrl: ref.url || null,
        size: info.size
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response;
    try {
      response = await this.fetchImpl(source.url, { signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Image download returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > this.maxImageBytes) throw new Error(`Image exceeds ${this.maxImageBytes} bytes`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.maxImageBytes) throw new Error(`Image exceeds ${this.maxImageBytes} bytes`);
    const mimeType = normalizeMime(response.headers.get("content-type"));
    const extension = EXT_BY_MIME.get(mimeType) || safeImageExtension(extname(new URL(source.url).pathname)) || ".img";
    const localPath = join(messageDir, `image-${imageNumber}${extension}`);
    const partialPath = `${localPath}.partial`;
    await writeFile(partialPath, bytes);
    await rename(partialPath, localPath);
    return {
      localPath,
      mimeType: mimeType || mimeFromExtension(extension),
      originalUrl: source.url,
      size: bytes.length
    };
  }

  async removeMessages(messages) {
    const directories = new Set();
    for (const message of messages || []) {
      directories.add(this.messageDir(message.groupId, message.messageId));
    }
    for (const directory of directories) {
      if (!this.isInsideRoot(directory)) continue;
      await rm(directory, { recursive: true, force: true });
    }
  }

  async removeImages(images) {
    for (const image of images || []) {
      const path = image?.localPath;
      if (!path || resolve(path) === this.rootDir || !this.isInsideRoot(path)) continue;
      await rm(path, { force: true });
    }
  }

  async cleanupOrphans(referencedImages = [], { forceOrphans = false } = {}) {
    const referencedDirs = new Set(
      referencedImages
        .map((image) => image?.localPath)
        .filter(Boolean)
        .map((path) => resolve(path, ".."))
    );
    const now = this.clock();
    const survivors = [];
    let removedDirs = 0;
    let freedBytes = 0;

    const groupEntries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const groupEntry of groupEntries) {
      if (!groupEntry.isDirectory()) continue;
      const groupDir = join(this.rootDir, groupEntry.name);
      const messageEntries = await readdir(groupDir, { withFileTypes: true }).catch(() => []);
      for (const messageEntry of messageEntries) {
        const entryPath = join(groupDir, messageEntry.name);
        if (!messageEntry.isDirectory()) {
          const fileInfo = await stat(entryPath).catch(() => null);
          if (fileInfo && (forceOrphans || now - fileInfo.mtimeMs >= this.orphanTtlMs)) {
            if (this.isInsideRoot(entryPath)) {
              await rm(entryPath, { force: true }).catch(() => {});
              freedBytes += fileInfo.size;
            }
          }
          continue;
        }
        const resolvedMsgDir = resolve(entryPath);
        const info = await stat(entryPath).catch(() => null);
        if (!info) continue;
        const sizeBytes = await measureDirectoryBytes(entryPath);
        const referenced = referencedDirs.has(resolvedMsgDir);
        const ageMs = now - info.mtimeMs;
        const expiredOrphan = !referenced && (forceOrphans || ageMs >= this.orphanTtlMs);
        const expiredStaleReferenced = referenced && forceOrphans && ageMs >= this.maxReferencedAgeMs;
        if ((expiredOrphan || expiredStaleReferenced) && this.isInsideRoot(entryPath)) {
          await rm(entryPath, { recursive: true, force: true });
          removedDirs += 1;
          freedBytes += sizeBytes;
        } else {
          survivors.push({ path: entryPath, groupDir, mtimeMs: info.mtimeMs, sizeBytes, referenced });
        }
      }
    }

    let remainingBytes = survivors.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (remainingBytes > this.maxTotalBytes) {
      survivors.sort((a, b) => Number(a.referenced) - Number(b.referenced) || a.mtimeMs - b.mtimeMs);
      for (const item of survivors) {
        if (remainingBytes <= this.maxTotalBytes) break;
        if (!this.isInsideRoot(item.path)) continue;
        await rm(item.path, { recursive: true, force: true }).catch(() => {});
        remainingBytes = Math.max(0, remainingBytes - item.sizeBytes);
        removedDirs += 1;
        freedBytes += item.sizeBytes;
      }
    }

    for (const groupEntry of groupEntries) {
      if (!groupEntry.isDirectory()) continue;
      const groupDir = join(this.rootDir, groupEntry.name);
      const rest = await readdir(groupDir).catch(() => null);
      if (rest && rest.length === 0 && this.isInsideRoot(groupDir)) {
        await rm(groupDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    return { removedDirs, freedBytes, remainingBytes };
  }

  messageDir(groupId, messageId) {
    return join(this.rootDir, safeSegment(groupId), safeSegment(messageId));
  }

  isInsideRoot(path) {
    const target = resolve(path);
    return target === this.rootDir || target.startsWith(`${this.rootDir}/`);
  }
}

async function measureDirectoryBytes(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectoryBytes(full);
    } else if (entry.isFile()) {
      const info = await stat(full).catch(() => null);
      if (info) total += info.size;
    }
  }
  return total;
}

function chooseSource(ref, resolvedRef) {
  const candidates = [ref?.url, resolvedRef?.url, resolvedRef?.file, ref?.file].filter(Boolean).map(String);
  for (const candidate of candidates) {
    if (/^https?:\/\//i.test(candidate)) return { kind: "url", url: candidate };
    if (candidate.startsWith("file://")) return { kind: "file", path: fileURLToPath(candidate) };
    if (candidate.startsWith("/")) return { kind: "file", path: candidate };
  }
  return null;
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function safeFilename(value) {
  const cleaned = String(value || "attachment").replace(/[\0/\\:*?"<>|]/g, "_").trim().slice(0, 160);
  return cleaned || "attachment";
}

function normalizeMime(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function safeImageExtension(value) {
  const extension = String(value || "").toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"].includes(extension) ? extension : "";
}

function mimeFromExtension(extension) {
  const normalized = extension === ".jpeg" ? ".jpg" : extension;
  return [...EXT_BY_MIME.entries()].find(([, ext]) => ext === normalized)?.[0] || "application/octet-stream";
}
