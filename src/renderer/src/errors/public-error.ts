import { ReaderErrorCodes, type ReaderErrorCode } from "../../../shared/errors.js";

const knownCodes = new Set<string>(ReaderErrorCodes);

export type ReaderErrorContext = "library-load" | "library-remove" | "import-txt" | "import-epub" | "import-folder" | "open-book" | "runner" | "library-scan";
export type PublicReaderError = { code: ReaderErrorCode; message: string };
export type ReaderNoticeModel = { code: ReaderErrorCode; title: string; detail: string };

const fallbackError: PublicReaderError = {
  code: "DATABASE_ERROR",
  message: "操作失败，请稍后重试。",
};

export function sanitizePublicReaderText(value: string): string {
  return (value.split(/\r?\n/, 1)[0] ?? "")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "[path]")
    .replace(/file:\/\/\/[^\s]+/gi, "[path]")
    .slice(0, 240);
}

function parseCandidate(value: unknown): PublicReaderError | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== "string" || !knownCodes.has(candidate.code) || typeof candidate.message !== "string") return null;
  return { code: candidate.code as ReaderErrorCode, message: candidate.message.slice(0, 240) };
}

export function parsePublicReaderError(error: unknown): PublicReaderError {
  const direct = parseCandidate(error);
  if (direct) return direct;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const candidates = message.match(/\{[^{}]{1,1000}\}/g) ?? [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = parseCandidate(JSON.parse(candidates[index]!));
      if (parsed) return parsed;
    } catch {
      // Ignore malformed wrapper text and use the stable fallback below.
    }
  }
  return fallbackError;
}

export function describeReaderError(error: unknown, context: ReaderErrorContext): ReaderNoticeModel {
  const parsed = parsePublicReaderError(error);
  if (parsed.code === "ARCHIVE_LIMIT") return {
    code: parsed.code,
    title: "这本 EPUB 超过安全限制",
    detail: "文件体积、解压后内容或压缩比超出允许范围。请换用来源可靠、重新导出的 EPUB。",
  };
  if (parsed.code === "INVALID_PACKAGE") return {
    code: parsed.code,
    title: context === "import-epub" ? "这不是可读取的 EPUB" : "这本 EPUB 暂时无法打开",
    detail: "出版物结构不完整或文件已经损坏。可以先用其他阅读器验证，或重新导出后再试。",
  };
  if (parsed.code === "RESOURCE_BLOCKED") return {
    code: parsed.code,
    title: "EPUB 包含不受支持的资源",
    detail: "首版会阻止远程资源、脚本和危险嵌入内容。请使用不依赖这些能力的可重排 EPUB。",
  };
  if (parsed.code === "SOURCE_CHANGED") return {
    code: parsed.code,
    title: "文件仍在变化",
    detail: "导入期间检测到源文件被修改。请等待复制或同步完成后重试。",
  };
  if (parsed.code === "SOURCE_UNAVAILABLE") return {
    code: parsed.code,
    title: "找不到这本书的源文件",
    detail: "文件可能已经移动、删除或暂时不可读取。请把文件放回原位置，或重新导入。",
  };
  if (parsed.code === "FORMAT_NOT_SUPPORTED") return {
    code: parsed.code,
    title: "当前不支持这种格式",
    detail: "此版本只导入 TXT 与可重排 EPUB。",
  };
  if (parsed.code === "FILE_TOO_LARGE") return {
    code: parsed.code,
    title: "TXT 文件太大",
    detail: "当前版本只导入不超过 20 MiB 的 TXT。",
  };
  if (parsed.code === "FILE_NOT_READABLE") return {
    code: parsed.code,
    title: "无法读取这个文件",
    detail: "请确认文件仍存在、没有被其他程序锁定，并且当前账户有读取权限。",
  };
  return {
    code: parsed.code,
    title: context === "library-load" ? "书库暂时无法载入" : "这次操作没有完成",
    detail: "请重试；如果问题持续出现，可以重新启动 Aetherbound。",
  };
}
