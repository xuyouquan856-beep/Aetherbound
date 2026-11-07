export type CoverImageState = "idle" | "loading" | "ready" | "failed";

type CoverImageEntry = {
  state: CoverImageState;
  promise: Promise<CoverImageState> | null;
  listeners: Set<(state: CoverImageState) => void>;
};

export const DefaultCoverPrewarmOptions = {
  limit: 8,
  concurrency: 4,
  timeoutMs: 250,
} as const;

type CoverPrewarmOptions = {
  limit: number;
  concurrency: number;
  timeoutMs: number;
};

const entries = new Map<string, CoverImageEntry>();

function getEntry(url: string) {
  const existing = entries.get(url);
  if (existing) return existing;
  const created: CoverImageEntry = {
    state: "idle",
    promise: null,
    listeners: new Set(),
  };
  entries.set(url, created);
  return created;
}

function setCoverImageState(url: string, state: CoverImageState) {
  const entry = getEntry(url);
  if (entry.state === state) return;
  entry.state = state;
  for (const listener of entry.listeners) listener(state);
}

export function getCoverImageState(url: string): CoverImageState {
  return getEntry(url).state;
}

export function markCoverImageReady(url: string) {
  setCoverImageState(url, "ready");
}

export function markCoverImageFailed(url: string) {
  setCoverImageState(url, "failed");
}

export function subscribeCoverImage(
  url: string,
  listener: (state: CoverImageState) => void,
) {
  const entry = getEntry(url);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function loadCoverImage(url: string): Promise<CoverImageState> {
  const entry = getEntry(url);
  if (entry.state === "ready" || entry.state === "failed") {
    return Promise.resolve(entry.state);
  }
  if (entry.promise) return entry.promise;

  const image = new Image();
  entry.state = "loading";
  let settled = false;
  let settling = false;
  entry.promise = new Promise<CoverImageState>((resolve) => {
    const finish = (state: Extract<CoverImageState, "ready" | "failed">) => {
      if (settled) return;
      settled = true;
      setCoverImageState(url, state);
      resolve(state);
    };
    const settleLoadedImage = async () => {
      if (settled || settling) return;
      settling = true;
      try {
        if (typeof image.decode === "function") await image.decode();
      } catch {
        // A complete image remains usable when Chromium rejects a redundant decode.
      }
      finish(image.naturalWidth > 0 ? "ready" : "failed");
    };
    image.onload = () => void settleLoadedImage();
    image.onerror = () => finish("failed");
    image.src = url;
    if (image.complete) queueMicrotask(() => void settleLoadedImage());
  });
  return entry.promise;
}

export async function prewarmCoverImages(
  urls: readonly string[],
  options: CoverPrewarmOptions = DefaultCoverPrewarmOptions,
) {
  const selected = [...new Set(urls)].slice(0, Math.max(0, options.limit));
  if (selected.length === 0) return;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, options.concurrency), selected.length) },
    async () => {
      while (cursor < selected.length) {
        const url = selected[cursor];
        cursor += 1;
        if (url) await loadCoverImage(url);
      }
    },
  );
  const work = Promise.all(workers).then(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, Math.max(0, options.timeoutMs));
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
