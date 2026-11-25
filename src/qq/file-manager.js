import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCallback);
const DEFAULT_STAGING_ROOT = "/tmp/workbuddy-qq-files";
const IMAGE_MIME_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
});

export class QqFileManager {
  constructor({
    oneBot,
    dockerPath = "/opt/homebrew/bin/docker",
    dockerContext = "colima-snowluma",
    container = "snowluma",
    stagingRoot = DEFAULT_STAGING_ROOT,
    maxFileBytes = 1024 * 1024 * 1024,
    maxImageBytes = 20 * 1024 * 1024,
    imageOptimizerPath = "/usr/bin/sips",
    execFileImpl = defaultExecFile,
    realpathImpl = realpath,
    statImpl = stat
  } = {}) {
    this.oneBot = oneBot;
    this.dockerPath = dockerPath;
    this.dockerContext = dockerContext;
    this.container = container;
    this.stagingRoot = validateStagingRoot(stagingRoot);
    this.maxFileBytes = Math.max(1, Number(maxFileBytes));
    this.maxImageBytes = Math.max(1, Number(maxImageBytes));
    this.imageOptimizerPath = imageOptimizerPath;
    this.execFileImpl = execFileImpl;
    this.realpathImpl = realpathImpl;
    this.statImpl = statImpl;
    this.initialized = false;
    this.initializationPromise = null;
  }

  async init() {
    if (this.initialized) return;
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      await this.dockerExec("rm", "-rf", "--", this.stagingRoot);
      await this.dockerExec("mkdir", "-p", "--", this.stagingRoot);
      await this.dockerExec("chmod", "0755", this.stagingRoot);
      this.initialized = true;
    })();
    try { await this.initializationPromise; }
    finally { this.initializationPromise = null; }
  }

  async resolveRequests(requests = [], { allowedRoots = null } = {}) {
    const files = [];
    const roots = allowedRoots == null
      ? null
      : await Promise.all(allowedRoots.map(async (root) => resolve(await this.realpathImpl(root))));
    for (const request of requests) {
      const requestedPath = String(request?.sourcePath || "").trim();
      if (!requestedPath.startsWith("/")) throw new Error("QQ file path must be absolute");
      const sourcePath = await this.realpathImpl(requestedPath);
      if (roots && !roots.some((root) => isWithinRoot(sourcePath, root))) {
        const error = new Error("QQ file is outside the current group's shared workspace");
        error.code = "QQ_FILE_OUTSIDE_ALLOWED_ROOT";
        throw error;
      }
      const info = await this.statImpl(sourcePath);
      if (!info.isFile()) throw new Error(`QQ file source is not a regular file: ${basename(sourcePath) || "unknown"}`);
      if (info.size > this.maxFileBytes) {
        throw new Error(`QQ file exceeds the configured ${this.maxFileBytes} byte limit: ${basename(sourcePath)}`);
      }
      files.push({
        sourcePath,
        name: safeFileName(basename(sourcePath)),
        size: info.size,
        delivered: false
      });
    }
    return files;
  }

  async resolveImageRequests(requests = [], { allowedRoots = null } = {}) {
    const images = [];
    const roots = allowedRoots == null
      ? null
      : await Promise.all(allowedRoots.map(async (root) => resolve(await this.realpathImpl(root))));
    for (const request of requests) {
      const requestedPath = String(request?.sourcePath || "").trim();
      if (!requestedPath.startsWith("/")) throw new Error("QQ image path must be absolute");
      const sourcePath = await this.realpathImpl(requestedPath);
      if (roots && !roots.some((root) => isWithinRoot(sourcePath, root))) {
        const error = new Error("QQ image is outside the current group's shared workspace");
        error.code = "QQ_IMAGE_OUTSIDE_ALLOWED_ROOT";
        throw error;
      }
      const extension = extname(sourcePath).toLowerCase();
      const mimeType = IMAGE_MIME_TYPES[extension];
      if (!mimeType) {
        const error = new Error(`QQ image format is not supported: ${basename(sourcePath) || "unknown"}`);
        error.code = "QQ_IMAGE_UNSUPPORTED_FORMAT";
        throw error;
      }
      const info = await this.statImpl(sourcePath);
      if (!info.isFile()) throw new Error(`QQ image source is not a regular file: ${basename(sourcePath) || "unknown"}`);
      if (info.size > this.maxFileBytes) {
        const error = new Error(`QQ image source exceeds the configured ${this.maxFileBytes} byte safety limit: ${basename(sourcePath)}`);
        error.code = "QQ_IMAGE_SOURCE_TOO_LARGE";
        throw error;
      }
      images.push({
        sourcePath,
        name: safeFileName(basename(sourcePath)),
        size: info.size,
        mimeType,
        needsOptimization: info.size > this.maxImageBytes,
        delivered: false
      });
    }
    return images;
  }

  async upload(groupId, file) {
    await this.init();
    const jobDir = posix.join(this.stagingRoot, randomUUID());
    const containerPath = posix.join(jobDir, "payload");
    try {
      await this.dockerExec("mkdir", "-p", "--", jobDir);
      await this.execDocker("cp", file.sourcePath, `${this.container}:${containerPath}`);
      // docker cp preserves restrictive host modes. SnowLuma runs as `node`, so
      // explicitly make only this temporary copy readable by that process.
      await this.dockerExec("chown", "node:node", containerPath);
      await this.dockerExec("chmod", "0644", containerPath);
      return await this.oneBot.uploadGroupFile(groupId, containerPath, file.name);
    } finally {
      await this.dockerExec("rm", "-rf", "--", jobDir).catch(() => {});
    }
  }

  async sendImage(targetType, targetId, image) {
    return this.withPreparedOutboundImage(image, (prepared) => this.withStagedImage(prepared, async (containerPath) => {
      if (targetType === "private") return this.oneBot.sendPrivateImage(targetId, containerPath);
      if (targetType === "group") return this.oneBot.sendGroupImage(targetId, containerPath);
      throw new Error(`Unsupported QQ image target type: ${targetType}`);
    }));
  }

  async withPreparedOutboundImage(image, callback) {
    if (Number(image?.size || 0) <= this.maxImageBytes && !image?.needsOptimization) {
      return callback(image);
    }
    const tempDir = await mkdtemp(join(tmpdir(), "workbuddy-qq-image-"));
    try {
      const prepared = await this.optimizeImage(image, tempDir);
      return await callback(prepared);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async optimizeImage(image, tempDir) {
    const sourcePath = String(image?.sourcePath || "");
    const originalExtension = extname(sourcePath).toLowerCase();
    const preserveFormat = [".jpg", ".jpeg", ".png", ".gif"].includes(originalExtension)
      ? originalExtension
      : ".png";
    const attempts = [
      { extension: preserveFormat, maxDimension: 4096, quality: 82 },
      { extension: preserveFormat, maxDimension: 3072, quality: 75 },
      { extension: ".jpg", maxDimension: 3072, quality: 78 },
      { extension: ".jpg", maxDimension: 2048, quality: 70 }
    ];
    let lastSize = Number(image?.size || 0);
    let lastError = null;
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const outputPath = join(tempDir, `optimized-${index}${attempt.extension}`);
      const args = ["-Z", String(attempt.maxDimension)];
      if ([".jpg", ".jpeg"].includes(attempt.extension)) {
        args.push("-s", "format", "jpeg", "-s", "formatOptions", String(attempt.quality));
      }
      args.push(sourcePath, "--out", outputPath);
      try {
        await this.execFileImpl(this.imageOptimizerPath, args);
        const info = await this.statImpl(outputPath);
        lastSize = info.size;
        if (info.isFile() && info.size > 0 && info.size <= this.maxImageBytes) {
          return {
            ...image,
            sourcePath: outputPath,
            name: `${basename(image.name || sourcePath, extname(image.name || sourcePath)) || "image"}${attempt.extension}`,
            size: info.size,
            mimeType: IMAGE_MIME_TYPES[attempt.extension] || "image/jpeg",
            needsOptimization: false,
            optimizedFromSize: Number(image?.size || 0)
          };
        }
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(
      `QQ image optimization could not reduce ${basename(sourcePath) || "image"} below ${this.maxImageBytes} bytes`
    );
    error.code = "QQ_IMAGE_OPTIMIZATION_FAILED";
    error.lastSize = lastSize;
    if (lastError) error.cause = lastError;
    throw error;
  }

  async sendSticker(targetType, targetId, sticker) {
    return this.withStagedImage(sticker, async (containerPath) => {
      const options = { summary: sticker.qqSummary || sticker.usage || "[动画表情]" };
      if (targetType === "private") return this.oneBot.sendPrivateSticker(targetId, containerPath, options);
      if (targetType === "group") return this.oneBot.sendGroupSticker(targetId, containerPath, options);
      throw new Error(`Unsupported QQ sticker target type: ${targetType}`);
    });
  }

  async addCustomFace(sticker) {
    return this.withStagedImage(sticker, (containerPath) => this.oneBot.addCustomFace(containerPath));
  }

  async withStagedImage(image, callback) {
    await this.init();
    const jobDir = posix.join(this.stagingRoot, randomUUID());
    const sourcePath = String(image?.sourcePath || image?.localPath || "").trim();
    if (!sourcePath) throw new Error("QQ staged image source path is missing");
    const extension = extname(String(image?.name || sourcePath)).toLowerCase();
    const containerPath = posix.join(jobDir, `payload${IMAGE_MIME_TYPES[extension] ? extension : ".png"}`);
    try {
      await this.dockerExec("mkdir", "-p", "--", jobDir);
      await this.execDocker("cp", sourcePath, `${this.container}:${containerPath}`);
      await this.dockerExec("chown", "node:node", containerPath);
      await this.dockerExec("chmod", "0644", containerPath);
      return await callback(containerPath);
    } finally {
      await this.dockerExec("rm", "-rf", "--", jobDir).catch(() => {});
    }
  }

  async execDocker(...args) {
    return this.execFileImpl(this.dockerPath, ["--context", this.dockerContext, ...args]);
  }

  async dockerExec(...command) {
    return this.execDocker("exec", "-u", "0", this.container, ...command);
  }

  async cleanupStaleStaging({ aggressive = false } = {}) {
    const minAgeMinutes = aggressive ? 5 : 60;
    const escapedRoot = this.stagingRoot.replace(/'/g, "'\\''");
    const script = [
      "rm -f /app/core /app/core.* /app/.config/QQ/crash_files/* 2>/dev/null || true",
      `[ -d '${escapedRoot}' ] && find '${escapedRoot}' -mindepth 1 -maxdepth 2 -mmin +${minAgeMinutes} -exec rm -rf -- {} + 2>/dev/null || true`
    ].join("; ");
    try {
      await this.dockerExec("sh", "-c", script);
      return { ok: true };
    } catch (error) {
      return { ok: false, skipped: true, reason: String(error?.message || error) };
    }
  }
}

function validateStagingRoot(value) {
  const path = String(value || DEFAULT_STAGING_ROOT).trim();
  if (path !== DEFAULT_STAGING_ROOT && !path.startsWith(`${DEFAULT_STAGING_ROOT}/`)) {
    throw new Error("QQ file staging root must stay under /tmp/workbuddy-qq-files");
  }
  return path.replace(/\/+$/, "") || DEFAULT_STAGING_ROOT;
}

function safeFileName(value) {
  const name = String(value || "file").replace(/[\0\r\n/\\]/g, "_").trim();
  return name.slice(0, 240) || "file";
}

function isWithinRoot(candidate, root) {
  const offset = relative(resolve(root), resolve(candidate));
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}
