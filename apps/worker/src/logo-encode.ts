/**
 * The worker's half of storing a logo small: the pixel work, which needs sharp (libvips), a native
 * library the pure core package does not carry. `normaliseLogo` in @ava/core decides what to
 * re-encode and keeps the original when this throws.
 *
 * sharp is loaded on first use, as the browser is: the interface imports this package's handlers
 * for its cron, and a serverless function that never captures a logo should not load it. It runs
 * with one thread and no cache: the worker has 512 MB, and a logo a day per company needs neither.
 */
import { LOGO_STORED_PX } from "@ava/core";
import { log } from "./log";

/**
 * The most pixels an icon may decode to: 16 megapixels, 64 MB as RGBA. The capture already caps
 * the file at 512 KB, but a compressed image can decode to far more than its size, and sharp's own
 * default (268 megapixels, a gigabyte) would take a 512 MB worker down for a logo.
 */
const MAX_INPUT_PIXELS = 4096 * 4096;

type Sharp = typeof import("sharp").default;
let loading: Promise<Sharp> | undefined;

function loadSharp(): Promise<Sharp> {
  loading ??= import("sharp").then((module) => {
    const sharp = module.default;
    sharp.concurrency(1);
    sharp.cache(false);
    return sharp;
  });
  return loading;
}

/**
 * A raster icon (PNG, JPEG, GIF, WebP, or the PNG inside an ICO) as a 64 px WebP: fitted inside
 * the square on a transparent background, never cropped. Throws when the bytes cannot be decoded,
 * after logging why, so the caller stores the original.
 */
export async function encodeLogoWebp(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const sharp = await loadSharp();
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(LOGO_STORED_PX, LOGO_STORED_PX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90, effort: 4 })
      .toBuffer();
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (error) {
    log.warn("logo re-encode failed; the original is kept", { error: error instanceof Error ? error.message : String(error), bytes: bytes.length });
    throw error;
  }
}
