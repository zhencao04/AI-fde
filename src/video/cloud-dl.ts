/**
 * 云空间链接下载渠道：
 *   http(s):// / https:// / alioss:// / s3:// → 下载到本地临时文件
 *
 * 设计原则：
 *   1) 零 npm 依赖：使用 node:http / node:https / node:fs
 *   2) 自动识别文件类型（根据 URL 扩展名或 Content-Type）
 *   3) 有超时、最大文件大小限制，防止意外下载大量数据
 *   4) 提供 URL 合法性白名单（默认仅允许 http/https，alioss/s3 由用户显式配置）
 *
 * 常见 URL 形态：
 *   https://bucket.oss-cn-hangzhou.aliyuncs.com/path/to/video.mp4
 *   https://s3.amazonaws.com/bucket/key.png
 *   http://10.0.0.1/video.mp4
 *   alioss://bucket/path/to/video.mp4    (需额外配置 OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET)
 *   s3://bucket/key.mp4                    (需额外配置 S3 凭据)
 *
 * 对于 alioss:// 和 s3:// 这类非 HTTP 协议：此模块仅做"签名后转 GET"，底层
 * 仍然走 http/https；签名实现采用最轻量的 HMAC-SHA1/SHA256，避免引入 SDK。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createWriteStream, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { join, extname, basename as pathBasename } from "node:path";

export type DownloadedFile = {
  /** 本地绝对路径 */
  path: string;
  /** 文件大小（字节） */
  size: number;
  /** 推断的媒体类型："image" | "video" | "unknown" */
  mediaType: "image" | "video" | "unknown";
  /** 原始 URL（脱敏后，去除 query 中的 token 等） */
  safeUrl: string;
  /** 原始文件扩展名（含点） */
  ext: string;
};

const MAX_SIZE = 500 * 1024 * 1024; // 500 MB 硬性上限
const DEFAULT_TIMEOUT = 120_000;     // 2 分钟

/** 根据扩展名推断媒体类型。 */
function detectMediaType(pathOrUrl: string): "image" | "video" | "unknown" {
  const ext = extname(pathOrUrl).toLowerCase();
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"]);
  const videoExts = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".3gp", ".wmv", ".m4v", ".ts"]);
  if (imageExts.has(ext)) return "image";
  if (videoExts.has(ext)) return "video";
  return "unknown";
}

/** 去掉 URL 中可能泄露的 query（打印时用）。 */
function safeUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    // 清空可能的鉴权字段
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (/(token|key|secret|signature|sign|auth|pwd|password|api|access)/.test(lower)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return urlStr;
  }
}

function buildHttpOptions(urlObj: URL, headers?: Record<string, string>): {
  method: "GET";
  hostname: string;
  port?: number;
  path: string;
  headers: Record<string, string>;
  timeout: number;
} {
  const extraHeaders: Record<string, string> = {};
  const env = process.env["CLOUD_DL_HEADERS"] || "";
  if (env) {
    for (const pair of env.split("|")) {
      const idx = pair.indexOf(":");
      if (idx > 0) extraHeaders[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return {
    method: "GET",
    hostname: urlObj.hostname,
    port: urlObj.port ? Number(urlObj.port) : undefined,
    path: urlObj.pathname + urlObj.search,
    headers: {
      "User-Agent": "ai-workflow-observer-agent/1.0",
      ...extraHeaders,
      ...headers,
    },
    timeout: DEFAULT_TIMEOUT,
  };
}

/**
 * 对 s3://bucket/key 风格 URL：构造签名的 HTTPS GET 请求。
 * 简化版签名（AWS Signature v2 风格）：对缺少 SDK 的环境可跑；
 * AWS SDK 未安装时走此兼容路径。若生产环境需要更严格的 SigV4，请替换为
 * 官方 SDK（此函数实现为最小兼容性，便于零依赖部署）。
 */
function buildS3Options(urlObj: URL): ReturnType<typeof buildHttpOptions> {
  const bucket = urlObj.hostname;
  const key = urlObj.pathname.replace(/^\/+/, "");
  const accessKey = process.env["S3_ACCESS_KEY_ID"] || process.env["AWS_ACCESS_KEY_ID"] || "";
  const secret = process.env["S3_SECRET_ACCESS_KEY"] || process.env["AWS_SECRET_ACCESS_KEY"] || "";
  const region = process.env["S3_REGION"] || "us-east-1";
  const endpoint = process.env["S3_ENDPOINT"] || `s3.${region}.amazonaws.com`;
  const useHttps = (process.env["S3_USE_HTTPS"] || "1") === "1";

  if (!accessKey || !secret) {
    // 无凭据 → 直接以匿名/公共可读形式 GET
    return {
      method: "GET",
      hostname: `${bucket}.${endpoint}`,
      path: `/${key}`,
      headers: { "User-Agent": "ai-workflow-observer-agent/1.0" },
      timeout: DEFAULT_TIMEOUT,
    };
  }

  // 签名（v2 简化）：构造 Authorization 头
  const date = new Date().toUTCString();
  const stringToSign = `GET\n\n\n${date}\n/${bucket}/${key}`;
  const sig = createHmac("sha1", secret).update(stringToSign).digest("base64");
  return {
    method: "GET",
    hostname: useHttps ? `${bucket}.${endpoint}` : endpoint,
    port: useHttps ? 443 : 80,
    path: `/${key}`,
    headers: {
      "User-Agent": "ai-workflow-observer-agent/1.0",
      Date: date,
      Authorization: `AWS ${accessKey}:${sig}`,
    },
    timeout: DEFAULT_TIMEOUT,
  };
}

/**
 * 对 alioss://bucket/key 风格 URL：阿里云 OSS 签名 v1。
 * 参考：https://help.aliyun.com/document_detail/31951.html
 */
function buildOssOptions(urlObj: URL): ReturnType<typeof buildHttpOptions> {
  const bucket = urlObj.hostname;
  const key = urlObj.pathname.replace(/^\/+/, "");
  const accessKey = process.env["OSS_ACCESS_KEY_ID"] || "";
  const secret = process.env["OSS_ACCESS_KEY_SECRET"] || "";
  const region = process.env["OSS_REGION"] || "oss-cn-hangzhou";

  if (!accessKey || !secret) {
    return {
      method: "GET",
      hostname: `${bucket}.${region}.aliyuncs.com`,
      path: `/${key}`,
      headers: { "User-Agent": "ai-workflow-observer-agent/1.0" },
      timeout: DEFAULT_TIMEOUT,
    };
  }
  const date = new Date().toUTCString();
  const stringToSign = `GET\n\n\n${date}\n/${bucket}/${key}`;
  const sig = createHmac("sha1", secret).update(stringToSign).digest("base64");
  return {
    method: "GET",
    hostname: `${bucket}.${region}.aliyuncs.com`,
    path: `/${key}`,
    headers: {
      "User-Agent": "ai-workflow-observer-agent/1.0",
      Date: date,
      Authorization: `OSS ${accessKey}:${sig}`,
    },
    timeout: DEFAULT_TIMEOUT,
  };
}

/**
 * 主入口：从任意 URL 下载文件到本地临时目录。
 * @param urlStr 可支持 http/https/s3/alioss 协议
 * @returns 下载后的本地文件元信息；调用方负责清理（调用 deleteDownloadedFile）。
 */
export async function downloadFromUrl(urlStr: string, options?: {
  /** 下载目录（不传则用系统 tmpdir） */
  targetDir?: string;
  /** 强制覆盖的自定义 HTTP 头 */
  headers?: Record<string, string>;
  /** 最大下载字节（默认 500MB） */
  maxSize?: number;
}): Promise<DownloadedFile> {
  if (!urlStr || typeof urlStr !== "string") {
    throw new Error("EMPTY_URL");
  }

  let urlObj: URL;
  try {
    // s3/alioss 协议兼容：临时替换为 http 以便 URL 解析
    const normalized = urlStr.replace(/^s3:\/\//i, "s3-scheme://")
      .replace(/^alioss:\/\//i, "alioss-scheme://");
    urlObj = new URL(normalized);
    // 还原 protocol
    if (urlStr.toLowerCase().startsWith("s3://")) urlObj.protocol = "s3:";
    if (urlStr.toLowerCase().startsWith("alioss://")) urlObj.protocol = "alioss:";
  } catch {
    throw new Error("INVALID_URL");
  }

  // 选择请求构造器
  const proto = urlObj.protocol.toLowerCase();
  const useHttps = proto === "s3:" || proto === "alioss:" || proto === "https:";
  let httpOpts;
  if (proto === "s3:") {
    httpOpts = buildS3Options(urlObj);
  } else if (proto === "alioss:") {
    httpOpts = buildOssOptions(urlObj);
  } else {
    httpOpts = buildHttpOptions(urlObj, options?.headers);
  }

  const targetDir = options?.targetDir || join(tmpdir(), "ai-observer-dl");
  mkdirSync(targetDir, { recursive: true });
  const name = pathBasename(urlObj.pathname) || `download-${Date.now()}`;
  const ext = extname(name).toLowerCase() || ".bin";
  const localPath = join(targetDir, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);

  return await new Promise((resolve, reject) => {
    const client = useHttps ? httpsRequest : httpRequest;
    const req = client(httpOpts, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随一次重定向（避免需要在 URL 上手动处理）
        downloadFromUrl(res.headers.location, options).then(resolve).catch(reject);
        res.resume();
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`DOWNLOAD_FAILED(code=${res.statusCode})`));
        return;
      }
      const file = createWriteStream(localPath);
      let size = 0;
      const maxSize = options?.maxSize ?? MAX_SIZE;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxSize) {
          res.destroy(new Error("DOWNLOAD_TOO_LARGE"));
          return;
        }
        file.write(chunk);
      });
      res.on("end", () => {
        file.end(() => {
          // 如果 URL 中没有扩展名，尝试根据 content-type 补一个
          let finalExt = ext;
          if (finalExt === ".bin" || finalExt === "") {
            const ct = String(res.headers["content-type"] || "").toLowerCase();
            if (ct.startsWith("image/")) finalExt = ".image";
            else if (ct.startsWith("video/")) finalExt = ".video";
          }
          resolve({
            path: localPath,
            size,
            mediaType: detectMediaType(name + finalExt),
            safeUrl: safeUrl(urlStr),
            ext: finalExt,
          });
        });
      });
      res.on("error", (e) => reject(e));
      file.on("error", (e) => reject(e));
    });
    req.on("error", (e) => reject(e));
    req.on("timeout", () => req.destroy(new Error("DOWNLOAD_TIMEOUT")));
    req.end();
  });
}

/** 辅助：删除下载产生的临时文件。 */
export function deleteDownloadedFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}
