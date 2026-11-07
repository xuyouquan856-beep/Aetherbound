import { useMemo } from "react";
import {
  EPUB_RUNNER_ORIGIN,
  EPUB_RUNNER_VERSION,
} from "../epub-runner/protocol.js";

function createNonce() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function EpubRunnerPrewarm() {
  const src = useMemo(() => {
    const params = new URLSearchParams({
      version: String(EPUB_RUNNER_VERSION),
      bookId: "prewarm",
      sourceRevision: "prewarm",
      nonce: createNonce(),
      hostOrigin: location.origin,
    });
    return `${EPUB_RUNNER_ORIGIN}/epub-runner.html?${params}`;
  }, []);

  return (
    <iframe
      aria-hidden="true"
      className="epub-runner-prewarm"
      data-epub-runner-prewarm="true"
      src={src}
      tabIndex={-1}
      title="EPUB engine prewarm"
    />
  );
}
