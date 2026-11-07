export type AdapterErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "INVALID_PACKAGE"
  | "RESOURCE_BLOCKED"
  | "ARCHIVE_LIMIT"
  | "SOURCE_CHANGED"
  | "CANCELLED";

export class EpubPolicyError extends Error {
  constructor(public readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "EpubPolicyError";
  }
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AdapterErrorCode; detail?: string };

export function adapterFailure(error: unknown): AdapterResult<never> {
  if (error instanceof EpubPolicyError) return { ok: false, code: error.code, detail: error.message };
  return { ok: false, code: "INVALID_PACKAGE" };
}
