/**
 * Renders every brand asset from the glyph rows in `apps/web/components/brand/mark-cells.ts`, so
 * the favicon, the installed-app icon and the mark on the page are the same artwork by
 * construction.
 *
 *   pnpm exec tsx scripts/generate-brand-assets.ts
 *
 * Writes:
 *   apps/web/app/icon.svg          the monogram, what the tab shows: a brand-green triangle with a
 *                                  light-green A, on a transparent ground
 *   apps/web/app/favicon.ico       16/32/48 PNGs of it in one container
 *   apps/web/app/apple-icon.png    192px, the monogram centred on white
 *   apps/web/public/brand/…        the wordmark (mark*) in currentColor, brand green and light
 *                                  green, as SVG and PNG; the monogram (monogram*) as SVG and PNG;
 *                                  and the manifest icons, including a maskable one with the
 *                                  monogram inside the safe zone
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLYPH_A, GLYPH_V, GLYPH_MONOGRAM_A, GLYPH_TRIANGLE, MONOGRAM_PATH, MONOGRAM_TILE, MONOGRAM_TRIANGLE_PATH,
  TILE, WORDMARK_GLYPHS, WORDMARK_PATHS, WORDMARK_WIDTH,
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
  glyphs: ReadonlyArray<{ rows: readonly string[]; dx: number }>;
  paths: readonly string[];
}

/** A form of the mark: its size in cells and its layers, painted in order. */
interface Artwork {
  width: number;
  height: number;
  layers: readonly Layer[];
}

const WORDMARK: Artwork = {
  width: WORDMARK_WIDTH,
  height: TILE,
  layers: [{ glyphs: WORDMARK_GLYPHS, paths: WORDMARK_PATHS }],
};
/** The triangle layer is the knockout path; its raster cells skip whatever the A layer paints. */
const KNOCKOUT = GLYPH_TRIANGLE.map((row, y) => [...row].map((c, x) => (GLYPH_MONOGRAM_A[y]![x] === "#" ? "." : c)).join(""));
const MONOGRAM: Artwork = {
  width: MONOGRAM_TILE,
  height: MONOGRAM_TILE,
  layers: [
    { glyphs: [{ rows: KNOCKOUT, dx: 0 }], paths: [MONOGRAM_TRIANGLE_PATH] },
    { glyphs: [{ rows: GLYPH_MONOGRAM_A, dx: 0 }], paths: [MONOGRAM_PATH] },
  ],
};

for (const rows of [GLYPH_A, GLYPH_V]) {
  if (rows.length !== TILE || rows.some((row) => row.length !== TILE)) throw new Error(`letters must be ${TILE}×${TILE}`);
}
for (const rows of [GLYPH_TRIANGLE, GLYPH_MONOGRAM_A]) {
  if (rows.length !== MONOGRAM_TILE || rows.some((row) => row.length !== MONOGRAM_TILE)) {
    throw new Error(`monogram layers must be ${MONOGRAM_TILE}×${MONOGRAM_TILE}`);
  }
}

/** The filled cells of a layer as "x,y" keys. */
function cellsOf(layer: Layer): Set<string> {
  const cells = new Set<string>();
  for (const { rows, dx } of layer.glyphs) {
    rows.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === "#") cells.add(`${x + dx},${y}`); }));
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" shape-rendering="crispEdges" role="img" aria-label="AVA">${back}${layers}</svg>
`;
}

const brand = join(root, "apps/web/public/brand");
rmSync(brand, { recursive: true, force: true });
mkdirSync(brand, { recursive: true });

const write = (path: string, data: Buffer | string) => {
  writeFileSync(join(root, path), data);
  console.log("wrote", path);
};

const MONOGRAM_INKS = [GREEN, LIGHT] as const;

// The tab: the triangle fills the tile, with the corners left transparent.
write("apps/web/app/icon.svg", svg(MONOGRAM, [GREEN_HEX, LIGHT_HEX]));
write(
  "apps/web/app/favicon.ico",
  ico([16, 32, 48].map((size) => ({ size, data: raster(MONOGRAM, size, MONOGRAM_INKS, null) }))),
);
// Home-screen icons are opaque squares the platform crops, so the monogram sits on white with a
// margin: two thirds of the square for the plain icons, half for the maskable one, which keeps the
// triangle's corners inside the safe circle (40% of the width from the centre).
write("apps/web/app/apple-icon.png", raster(MONOGRAM, 128, MONOGRAM_INKS, WHITE, 192));
write("apps/web/public/brand/app-icon-192.png", raster(MONOGRAM, 128, MONOGRAM_INKS, WHITE, 192));
write("apps/web/public/brand/app-icon-512.png", raster(MONOGRAM, 336, MONOGRAM_INKS, WHITE, 512));
write("apps/web/public/brand/app-icon-maskable-512.png", raster(MONOGRAM, 256, MONOGRAM_INKS, WHITE, 512));

// Everything else, for documents and anywhere the ground is not ours to pick. The wordmark is
// green on white grounds and light green on the brand green; the monogram carries both colours.
write("apps/web/public/brand/mark.svg", svg(WORDMARK, ["currentColor"]));
write("apps/web/public/brand/mark-green.svg", svg(WORDMARK, [GREEN_HEX]));
write("apps/web/public/brand/mark-light.svg", svg(WORDMARK, [LIGHT_HEX]));
write("apps/web/public/brand/monogram.svg", svg(MONOGRAM, [GREEN_HEX, LIGHT_HEX]));
// PNGs are named for their height. The wordmark's are multiples of its 24-cell tile, the
// monogram's of its 16-cell one.
for (const height of [24, 48, 96, 192]) {
  write(`apps/web/public/brand/mark-green-${height}.png`, raster(WORDMARK, height, [GREEN], null));
  write(`apps/web/public/brand/mark-light-${height}.png`, raster(WORDMARK, height, [LIGHT], null));
}
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  write(`apps/web/public/brand/monogram-${size}.png`, raster(MONOGRAM, size, MONOGRAM_INKS, null));
}
