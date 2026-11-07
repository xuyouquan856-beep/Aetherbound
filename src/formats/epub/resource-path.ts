import { EpubPolicyError } from "./errors.js";

function decoded(value: string) {
  try { return decodeURIComponent(value); }
  catch { throw new EpubPolicyError("RESOURCE_BLOCKED", "Malformed percent-encoding in publication path"); }
}

function assertSafe(value: string) {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) {
    throw new EpubPolicyError("RESOURCE_BLOCKED", "Unsafe publication path");
  }
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new EpubPolicyError("RESOURCE_BLOCKED", "Publication path traversal");
  }
}

export function normalizePublicationPath(value: string): string {
  assertSafe(value);
  const once = decoded(value);
  const twice = decoded(once);
  assertSafe(once);
  assertSafe(twice);
  return value.replace(/^\.\//, "");
}
