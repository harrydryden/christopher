/**
 * Renders every brand asset from the one cell list in
 * `apps/web/components/brand/mark-cells.ts`, so the favicon, the installed-app
 * icon and the mark on the page are the same artwork by construction.
 *
 *   pnpm exec tsx scripts/generate-brand-assets.ts
 *
 * Writes:
 *   apps/web/app/icon.svg          white mark on black, what the tab shows
 *   apps/web/app/favicon.ico       16/32/48 PNGs in one container
 *   apps/web/app/apple-icon.png    180px, white on black
 *   apps/web/public/brand/…        mark.svg (currentColor) and the PNG sizes
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MARK_CELLS, MARK_GRID, MARK_PATH } from "../apps/web/components/brand/mark-cells.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

type RGB = [number, number, number];

const filled = new Set(MARK_CELLS.map((cell) => `${cell.x},${cell.y}`));

/** Nearest-neighbour upscale: every cell must stay a hard square. */
function raster(size: number, ink: RGB, ground: RGB | null): Buffer {
  if (size % MARK_GRID !== 0) throw new Error(`${size} is not a multiple of ${MARK_GRID}`);
  const scale = size / MARK_GRID;
  // Raw PNG scanlines: one filter byte (0 = None) then RGBA per pixel.
  const row = 1 + size * 4;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    const cellY = Math.floor(y / scale);
    for (let x = 0; x < size; x++) {
      const on = filled.has(`${Math.floor(x / scale)},${cellY}`);
      const colour = on ? ink : ground;
      const at = y * row + 1 + x * 4;
      raw[at] = colour ? colour[0] : 0;
      raw[at + 1] = colour ? colour[1] : 0;
      raw[at + 2] = colour ? colour[2] : 0;
      raw[at + 3] = colour ? 255 : 0;
    }
  }
  return png(size, raw);
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

function png(size: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
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

function svg({ ink, ground }: { ink: string; ground?: string }): string {
  const box = `0 0 ${MARK_GRID} ${MARK_GRID}`;
  const back = ground ? `<rect width="${MARK_GRID}" height="${MARK_GRID}" fill="${ground}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" shape-rendering="crispEdges" role="img" aria-label="Christopher">${back}<path d="${MARK_PATH}" fill="${ink}"/></svg>\n`;
}

const brand = join(root, "apps/web/public/brand");
rmSync(brand, { recursive: true, force: true });
mkdirSync(brand, { recursive: true });

const write = (path: string, data: Buffer | string) => {
  writeFileSync(join(root, path), data);
  console.log("wrote", path);
};

// The tab: white on black, so the mark reads on a dark or light browser chrome.
write("apps/web/app/icon.svg", svg({ ink: "#ffffff", ground: "#000000" }));
write("apps/web/app/apple-icon.png", raster(192, WHITE, BLACK));
write(
  "apps/web/app/favicon.ico",
  ico([16, 32, 48].map((size) => ({ size, data: raster(size, WHITE, BLACK) }))),
);

// Everything else, for documents and anywhere the ground is not ours to pick.
write("apps/web/public/brand/mark.svg", svg({ ink: "currentColor" }));
write("apps/web/public/brand/mark-white.svg", svg({ ink: "#ffffff" }));
write("apps/web/public/brand/mark-black.svg", svg({ ink: "#000000" }));
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  write(`apps/web/public/brand/mark-white-${size}.png`, raster(size, WHITE, null));
  write(`apps/web/public/brand/mark-black-${size}.png`, raster(size, BLACK, null));
}
// Manifest icons carry the ground with them; maskable needs it edge to edge.
write("apps/web/public/brand/app-icon-192.png", raster(192, WHITE, BLACK));
write("apps/web/public/brand/app-icon-512.png", raster(512, WHITE, BLACK));
