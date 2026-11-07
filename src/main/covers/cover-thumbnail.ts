import { BrowserWindow, nativeImage } from "electron";
import {
  COVER_THUMBNAIL_MAX_HEIGHT,
  COVER_THUMBNAIL_MAX_WIDTH,
  COVER_THUMBNAIL_JPEG_QUALITY,
  type CoverThumbnailer,
} from "../../backend/library/epub-preparation-service.js";

/**
 * A reusable hidden window used purely as an image codec.
 *
 * It exists for two jobs `nativeImage` cannot do:
 *  - decoding WebP (PNG and JPEG decode fine, WebP comes back empty), and
 *  - flattening transparent covers onto white before JPEG encoding.
 *
 * It only ever loads about:blank and has no preload, so it can never see the
 * reader API.
 */
function createImageCodecWindow() {
  let window: BrowserWindow | null = null;

  return async function run(script: string): Promise<string | null> {
    try {
      if (!window || window.isDestroyed()) {
        window = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            preload: undefined,
          },
        });
        void window.loadURL("about:blank");
      }
      if (window.webContents.isLoading()) {
        await new Promise<void>((resolve) => {
          window!.webContents.once("did-finish-load", () => resolve());
          window!.webContents.once("did-fail-load", () => resolve());
        });
      }
      return await window.webContents.executeJavaScript(script) as string | null;
    } catch {
      return null;
    }
  };
}

/**
 * In-page codec: decode any format, downscale, flatten onto white, encode JPEG.
 *
 * The white fill matters: JPEG has no alpha channel, and without it transparent
 * covers would composite onto black.
 */
function codecScript(bytes: Uint8Array, mimeType: string): string {
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  return `
    (async () => {
      const image = new Image();
      image.src = ${JSON.stringify(dataUrl)};
      try { await image.decode(); } catch { return null; }
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) return null;
      const scale = Math.min(
        ${COVER_THUMBNAIL_MAX_WIDTH} / width,
        ${COVER_THUMBNAIL_MAX_HEIGHT} / height,
        1,
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", ${COVER_THUMBNAIL_JPEG_QUALITY})
        .split(",")[1] ?? null;
    })()
  `;
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array) {
  return bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/**
 * PNG colour type lives in the IHDR chunk: byte 25, with bit 2 set for an alpha
 * channel (types 4 and 6). Needed because JPEG cannot carry alpha, and blindly
 * calling toJPEG() would composite a transparent cover onto black.
 */
function pngHasAlpha(bytes: Uint8Array) {
  if (!isPng(bytes) || bytes.length < 26) return false;
  const colorType = bytes[25]!;
  return colorType === 4 || colorType === 6;
}

/**
 * Publication covers are commonly 1000-3000px wide while the UI paints them at
 * 58-260px, so shipping the original made the renderer decode several megapixels
 * per cover.
 *
 * Deliberately mirrors what Calibre does in `save_cover_data_to`:
 *  - output JPEG (its `scale_image` defaults to JPEG, and PNG was ~8x larger here
 *    for photographic covers),
 *  - fit inside a bounding box rather than scaling one axis,
 *  - blend transparency onto white so JPEG has defined pixels,
 *  - leave an already-small cover untouched instead of re-encoding it.
 *
 * Lives in main because backend modules may not import Electron; the backend
 * receives it through injection instead.
 */
export function createCoverThumbnailer(): CoverThumbnailer {
  const runScript = createImageCodecWindow();

  return async (bytes, mediaType) => {
    const buffer = Buffer.from(bytes);
    const image = nativeImage.createFromBuffer(buffer);

    if (!image.isEmpty()) {
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0) return null;

      const scale = Math.min(
        COVER_THUMBNAIL_MAX_WIDTH / size.width,
        COVER_THUMBNAIL_MAX_HEIGHT / size.height,
        1,
      );

      // Already small enough: re-encoding would only lose quality.
      if (scale >= 1) return null;

      const resized = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good",
      });
      if (resized.isEmpty()) return null;

      // JPEG has no alpha, so a cover carrying one must be flattened onto white;
      // toJPEG() alone would composite it onto black. Such covers take the browser
      // codec, which fills white first.
      const needsFlatten = pngHasAlpha(bytes);
      if (!needsFlatten) return new Uint8Array(resized.toJPEG(COVER_THUMBNAIL_JPEG_QUALITY));
    }

    // WebP (which nativeImage cannot decode) and covers needing alpha flattening:
    // the browser codec handles every format and fills white first.
    const base64 = await runScript(
      codecScript(bytes, mediaType),
    );
    if (!base64) return null;
    return new Uint8Array(Buffer.from(base64, "base64"));
  };
}

export const coverThumbnailer: CoverThumbnailer = createCoverThumbnailer();

/** Exposed for tests that need the raw codec without Electron. */
export const __internals = { codecScript, isJpeg, isPng, pngHasAlpha };
