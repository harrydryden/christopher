/**
 * Renders every brand asset from the glyph rows in `apps/web/components/brand/mark-cells.ts`, so
 * the favicon, the installed-app icon and the mark on the page are the same artwork by
 * construction.
 *
 *   pnpm exec tsx scripts/generate-brand-assets.ts
 *
 * Writes:
 *   apps/web/app/icon.svg          the small mark, what the tab shows: the Course of Life mark on
 *                                  its 16-cell tile, brand green on a transparent ground
 *   apps/web/app/favicon.ico       16/32/48 PNGs of it in one container
 *   apps/web/app/apple-icon.png    192px, the mark at 144 centred on white
 *   apps/web/public/brand/…        the mark (mark*), the small mark (mark-small*) and the stacked
 *                                  wordmark (wordmark*) in currentColor, brand green and light
 *                                  green, as SVG and PNG; and the manifest icons, including a
 *                                  maskable one with the mark inside the safe zone
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLYPH_MARK, GLYPH_MARK_SMALL, MARK_PATH, MARK_SMALL_PATH, MARK_SMALL_TILE, MARK_TILE,
  WORDMARK_GLYPHS, WORDMARK_PATH, WORDMARK_TILE, WORDMARK_WIDTH, type PlacedGlyph,
} from "../apps/web/components/brand/mark-cells.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type RGB = [number, number, number];

/* The brand pair, mirroring --brand-green and --brand-green-light in apps/web/app/globals.css. */
const GREEN_HEX = "#25593a";
const LIGHT_HEX = "#e8fecc";
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const GREEN = rgb(GREEN_HEX);
const LIGHT = rgb(LIGHT_HEX);
const WHITE: RGB = [255, 255, 255];

/** One colour layer of an artwork: its cells for the rasters and its paths for the SVGs. */
interface Layer {
  glyphs: readonly PlacedGlyph[];
  paths: readonly string[];
}

/** A form of the mark: its size in cells, its accessible name, and its layers, painted in order. */
interface Artwork {
  width: number;
  height: number;
  label: string;
  layers: readonly Layer[];
}

const MARK: Artwork = {
  width: MARK_TILE,
  height: MARK_TILE,
  label: "Course of Life",
  layers: [{ glyphs: [{ rows: GLYPH_MARK, dx: 0, dy: 0 }], paths: [MARK_PATH] }],
};
const MARK_SMALL: Artwork = {
  width: MARK_SMALL_TILE,
  height: MARK_SMALL_TILE,
  label: "Course of Life",
  layers: [{ glyphs: [{ rows: GLYPH_MARK_SMALL, dx: 0, dy: 0 }], paths: [MARK_SMALL_PATH] }],
};
const WORDMARK: Artwork = {
  width: WORDMARK_WIDTH,
  height: WORDMARK_TILE,
  label: "course of.life",
  layers: [{ glyphs: WORDMARK_GLYPHS, paths: [WORDMARK_PATH] }],
};

for (const art of [MARK, MARK_SMALL, WORDMARK]) {
  for (const { glyphs } of art.layers) {
    for (const { rows, dx, dy } of glyphs) {
      if (dx + rows[0]!.length > art.width || dy + rows.length > art.height) {
        throw new Error(`"${art.label}" has a glyph outside its ${art.width}×${art.height} box`);
      }
    }
  }
}

/** The filled cells of a layer as "x,y" keys. */
function cellsOf(layer: Layer): Set<string> {
  const cells = new Set<string>();
  for (const { rows, dx, dy } of layer.glyphs) {
    rows.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === "#") cells.add(`${x + dx},${y + dy}`); }));
  }
  return cells;
}

/**
 * Nearest-neighbour upscale so the artwork is `height` pixels tall: every cell must stay a hard
 * square. `inks` colours the layers in order. With `canvas`, the artwork is centred on a square
 * of that many pixels (for app icons, which need a margin), otherwise the image is the artwork.
 */
function raster(art: Artwork, height: number, inks: readonly RGB[], ground: RGB | null, canvas?: number): Buffer {
  if (height % art.height !== 0) throw new Error(`${height} is not a multiple of ${art.height}`);
  const scale = height / art.height;
  const artWidth = art.width * scale;
  const width = canvas ?? artWidth;
  const tall = canvas ?? height;
  const left = (width - artWidth) / 2;
  const top = (tall - height) / 2;
  if (!Number.isInteger(left) || !Number.isInteger(top)) throw new Error("the artwork must centre on whole pixels");
  const layers = art.layers.map(cellsOf);
  // Raw PNG scanlines: one filter byte (0 = None) then RGBA per pixel.
  const row = 1 + width * 4;
  const raw = Buffer.alloc(row * tall);
  for (let y = 0; y < tall; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= left && x < left + artWidth && y >= top && y < top + height;
      const key = inside ? `${Math.floor((x - left) / scale)},${Math.floor((y - top) / scale)}` : "";
      let colour = ground;
      layers.forEach((cells, i) => { if (inside && cells.has(key)) colour = inks[i]!; });
      const at = y * row + 1 + x * 4;
      raw[at] = colour ? colour[0] : 0;
      raw[at + 1] = colour ? colour[1] : 0;
      raw[at + 2] = colour ? colour[2] : 0;
      raw[at + 3] = colour ? 255 : 0;
    }
  }
  return png(width, tall, raw);
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

function svg(art: Artwork, inks: readonly string[], ground?: string): string {
  const box = `0 0 ${art.width} ${art.height}`;
  const back = ground ? `<rect width="${art.width}" height="${art.height}" fill="${ground}"/>` : "";
  const layers = art.layers
    .flatMap((layer, i) => layer.paths.map((d) => `<path d="${d}" fill="${inks[i]}"/>`))
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" shape-rendering="crispEdges" role="img" aria-label="${art.label}">${back}${layers}</svg>
`;
}

const brand = join(root, "apps/web/public/brand");
rmSync(brand, { recursive: true, force: true });
mkdirSync(brand, { recursive: true });

const write = (path: string, data: Buffer | string) => {
  writeFileSync(join(root, path), data);
  console.log("wrote", path);
};

// The tab: the small mark, because it is the artwork drawn for 16px, in green on a transparent
// ground.
write("apps/web/app/icon.svg", svg(MARK_SMALL, [GREEN_HEX]));
write(
  "apps/web/app/favicon.ico",
  ico([16, 32, 48].map((size) => ({ size, data: raster(MARK_SMALL, size, [GREEN], null) }))),
);
// Home-screen icons are opaque squares the platform crops, so the mark sits on white with a
// margin: three quarters of the square for the plain icons. The maskable one is the mark in light
// green on a green ground at 288 of 512, which keeps its corners inside the safe circle (40% of
// the width from the centre).
write("apps/web/app/apple-icon.png", raster(MARK, 144, [GREEN], WHITE, 192));
write("apps/web/public/brand/app-icon-192.png", raster(MARK, 144, [GREEN], WHITE, 192));
write("apps/web/public/brand/app-icon-512.png", raster(MARK, 384, [GREEN], WHITE, 512));
write("apps/web/public/brand/app-icon-maskable-512.png", raster(MARK, 288, [LIGHT], GREEN, 512));

// Everything else, for documents and anywhere the ground is not ours to pick: green on white
// grounds, light green on the brand green. PNGs are named for their height, which is a multiple of
// the artwork's tile: 24 for the mark, 16 for the small mark and the wordmark.
write("apps/web/public/brand/mark.svg", svg(MARK, ["currentColor"]));
write("apps/web/public/brand/mark-green.svg", svg(MARK, [GREEN_HEX]));
write("apps/web/public/brand/mark-light.svg", svg(MARK, [LIGHT_HEX]));
for (const height of [24, 48, 96, 192]) {
  write(`apps/web/public/brand/mark-green-${height}.png`, raster(MARK, height, [GREEN], null));
  write(`apps/web/public/brand/mark-light-${height}.png`, raster(MARK, height, [LIGHT], null));
}
write("apps/web/public/brand/mark-small.svg", svg(MARK_SMALL, ["currentColor"]));
write("apps/web/public/brand/mark-small-green.svg", svg(MARK_SMALL, [GREEN_HEX]));
for (const size of [16, 32, 48, 64]) {
  write(`apps/web/public/brand/mark-small-green-${size}.png`, raster(MARK_SMALL, size, [GREEN], null));
}
write("apps/web/public/brand/wordmark.svg", svg(WORDMARK, ["currentColor"]));
write("apps/web/public/brand/wordmark-green.svg", svg(WORDMARK, [GREEN_HEX]));
write("apps/web/public/brand/wordmark-light.svg", svg(WORDMARK, [LIGHT_HEX]));
for (const height of [32, 48, 64, 96]) {
  write(`apps/web/public/brand/wordmark-green-${height}.png`, raster(WORDMARK, height, [GREEN], null));
  write(`apps/web/public/brand/wordmark-light-${height}.png`, raster(WORDMARK, height, [LIGHT], null));
}
