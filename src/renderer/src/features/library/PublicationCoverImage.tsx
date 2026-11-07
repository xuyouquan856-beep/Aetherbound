import { useCallback, useSyncExternalStore } from "react";
import {
  getCoverImageState,
  markCoverImageFailed,
  markCoverImageReady,
  subscribeCoverImage,
} from "./cover-image-cache.js";

type Props = {
  url: string;
  alt: string;
  className: string;
  loading: "eager" | "lazy";
};

async function settleElement(
  url: string,
  image: HTMLImageElement,
  loadEventReceived = false,
) {
  if (!loadEventReceived && (!image.complete || image.naturalWidth <= 0)) return;
  try {
    if (typeof image.decode === "function") await image.decode();
  } catch {
    // The pixels are already usable; a redundant decode can reject in Chromium.
  } finally {
    if (loadEventReceived || (image.complete && image.naturalWidth > 0)) {
      markCoverImageReady(url);
    }
  }
}

export function PublicationCoverImage({ url, alt, className, loading }: Props) {
  const subscribe = useCallback(
    (notify: () => void) => subscribeCoverImage(url, notify),
    [url],
  );
  const snapshot = useCallback(() => getCoverImageState(url), [url]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const captureImage = useCallback((image: HTMLImageElement | null) => {
    if (image) void settleElement(url, image);
  }, [url]);

  if (state === "failed") return null;
  return (
    <img
      ref={captureImage}
      className={className}
      src={url}
      alt={alt}
      loading={loading}
      decoding="async"
      data-loaded={state === "ready"}
      onLoad={(event) => void settleElement(url, event.currentTarget, true)}
      onError={() => markCoverImageFailed(url)}
    />
  );
}
