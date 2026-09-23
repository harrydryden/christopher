/**
 * Renders every brand asset from the glyph rows in `apps/web/components/brand/mark-cells.ts`, so
 * the favicon, the installed-app icon and the mark on the page are the same artwork by
 * construction.
 *
 *   pnpm exec tsx scripts/generate-brand-assets.ts
 *
 * Writes:
 *   apps/web/app/icon.svg          the monogram white on black, what the tab shows
 *   apps/web/app/favicon.ico       16/32/48 PNGs of it in one container
 *   apps/web/app/apple-icon.png    192px, white on black
 *   apps/web/public/brand/…        the wordmark (mark*) and the monogram (monogram*) as SVG in
 *                                  currentColor, white and black, the PNG sizes of each, and the
 *                                  manifest icons
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLYPH_A, MONOGRAM_PATH, TILE, WORDMARK_GLYPHS, WORDMARK_PATHS, WORDMARK_WIDTH,
} from "../apps/web/components/brand/mark-cells.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

type RGB = [number, number, number];

/** A form of the mark: its width in cells, its letters for the rasters and its paths for the SVGs. */
interface Artwork {
  width: number;
  letters: ReadonlyArray<{ rows: readonly string[]; dx: number }>;
  paths: readonly string[];
}

const WORDMARK: Artwork = { width: WORDMARK_WIDTH, letters: WORDMARK_GLYPHS, paths: WORDMARK_PATHS };
const MONOGRAM: Artwork = { width: TILE, letters: [{ rows: GLYPH_A, dx: 0 }], paths: [MONOGRAM_PATH] };

for (const { rows } of WORDMARK.letters) {
  if (rows.length !== TILE || rows.some((row) => row.length !== TILE)) throw new Error(`glyphs must be ${TILE}×${TILE}`);
}

/** The filled cells of an artwork as "x,y" keys. */
function cellsOf(art: Artwork): Set<string> {
  const cells = new Set<string>();
  for (const { rows, dx } of art.letters) {
    rows.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === "#") cells.add(`${x + dx},${y}`); }));
  }
  return cells;
}

/** Nearest-neighbour upscale to `height` pixels: every cell must stay a hard square. */
function raster(art: Artwork, height: number, ink: RGB, ground: RGB | null): Buffer {
  if (height % TILE !== 0) throw new Error(`${height} is not a multiple of ${TILE}`);
  const scale = height / TILE;
  const width = art.width * scale;
  const filled = cellsOf(art);
  // Raw PNG scanlines: one filter byte (0 = None) then RGBA per pixel.
  const row = 1 + width * 4;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const cellY = Math.floor(y / scale);
    for (let x = 0; x < width; x++) {
      const on = filled.has(`${Math.floor(x / scale)},${cellY}`);
      const colour = on ? ink : ground;
      const at = y * row + 1 + x * 4;
      raw[at] = colour ? colour[0] : 0;
      raw[at + 1] = colour ? colour[1] : 0;
      raw[at + 2] = colour ? colour[2] : 0;
      raw[at + 3] = colour ? 255 : 0;
    }
  }
  return png(width, height, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function png(width: number, height: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO holding PNG images, which every browser we care about reads. */
function ico(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries: Buffer[] = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function svg(art: Artwork, { ink, ground }: { ink: string; ground?: string }): string {
  const box = `0 0 ${art.width} ${TILE}`;
  const back = ground ? `<rect width="${art.width}" height="${TILE}" fill="${ground}"/>` : "";
  const letters = art.paths.map((d) => `<path d="${d}" fill="${ink}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" shape-rendering="crispEdges" role="img" aria-label="AVA">${back}${letters}</svg>\n`;
}

const brand = join(root, "apps/web/public/brand");
rmSync(brand, { recursive: true, force: true });
mkdirSync(brand, { recursive: true });

const write = (path: string, data: Buffer | string) => {
  writeFileSync(join(root, path), data);
  console.log("wrote", path);
};

// The tab: the monogram white on black, so it reads on a dark or light browser chrome.
write("apps/web/app/icon.svg", svg(MONOGRAM, { ink: "#ffffff", ground: "#000000" }));
write("apps/web/app/apple-icon.png", raster(MONOGRAM, 192, WHITE, BLACK));
write(
  "apps/web/app/favicon.ico",
  ico([16, 32, 48].map((size) => ({ size, data: raster(MONOGRAM, size, WHITE, BLACK) }))),
);

// Everything else, for documents and anywhere the ground is not ours to pick.
for (const [name, art] of [["mark", WORDMARK], ["monogram", MONOGRAM]] as const) {
  write(`apps/web/public/brand/${name}.svg`, svg(art, { ink: "currentColor" }));
  write(`apps/web/public/brand/${name}-white.svg`, svg(art, { ink: "#ffffff" }));
  write(`apps/web/public/brand/${name}-black.svg`, svg(art, { ink: "#000000" }));
}
// PNGs are named for their height; the wordmark is 2.75 times as wide.
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  write(`apps/web/public/brand/monogram-white-${size}.png`, raster(MONOGRAM, size, WHITE, null));
  write(`apps/web/public/brand/monogram-black-${size}.png`, raster(MONOGRAM, size, BLACK, null));
}
for (const height of [32, 64, 128, 256]) {
  write(`apps/web/public/brand/mark-white-${height}.png`, raster(WORDMARK, height, WHITE, null));
  write(`apps/web/public/brand/mark-black-${height}.png`, raster(WORDMARK, height, BLACK, null));
}
// Manifest icons carry the ground with them; maskable needs it edge to edge.
write("apps/web/public/brand/app-icon-192.png", raster(MONOGRAM, 192, WHITE, BLACK));
write("apps/web/public/brand/app-icon-512.png", raster(MONOGRAM, 512, WHITE, BLACK));
