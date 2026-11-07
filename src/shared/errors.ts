export const ReaderErrorCodes = [
  "FILE_NOT_READABLE",
  "FILE_TOO_LARGE",
  "FORMAT_NOT_SUPPORTED",
  "TXT_ENCODING_UNCERTAIN",
  "BOOK_NOT_FOUND",
  "SOURCE_UNAVAILABLE",
  "SESSION_INVALID",
  "INVALID_REQUEST",
  "DATABASE_ERROR",
  "INVALID_PACKAGE",
  "RESOURCE_BLOCKED",
  "ARCHIVE_LIMIT",
  "SOURCE_CHANGED",
  "AI_NOT_CONFIGURED",
  "AI_REQUEST_FAILED",
  "REVIEW_EXPIRED",
  "CANCELLED",
  "INTERNAL_ERROR",
  "TOOL_NOT_REGISTERED",
];

export type ReaderErrorCode = (typeof ReaderErrorCodes)[number];

export class ReaderError extends Error {
  constructor(readonly code: ReaderErrorCode, message: string) {
    super(message);
    this.name = "ReaderError";
  }
}

export function publicError(error: unknown) {
  if (error instanceof ReaderError) return { code: error.code, message: error.message.replace(/[A-Z]:\\[^\s]+/gi, "[path]") };
  return { code: "DATABASE_ERROR" as const, message: "操作失败，请稍后重试。" };
}
