/**
 * Logos stored small: a capture re-encodes the site's icon as a 64 px WebP, and the one-off
 * backfill does the same for logos captured before. With the real image library, so what is
 * asserted is what a browser is sent.
 *
 * What matters: a raster icon becomes a WebP no larger than 64 px; an SVG is left as it is; bytes
 * the library cannot read are kept exactly as captured (a resize must never cost the logo); and a
 * re-encoded logo's capture time moves, because that time is the version in its immutable URL.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import sharp from "sharp";
import { createDb, readCompanyLogo, schema, type Db } from "@col/db";
import { normaliseLogo } from "@col/core";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleDiscover } from "./handlers/discover";
import { handleReencodeLogos } from "./handlers/reencode-logos";
import { encodeLogoWebp } from "./logo-encode";
import { startTestServer, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const HOSTS = ["www.touch.test", "icons.duckduckgo.com", "www.google.com"];

let server: TestServer;
let deps: WorkerDeps;
let db: Db;
let now = new Date("2026-09-27T09:00:00Z");

/** A real PNG: a coloured rectangle of this size. */
const pngOf = (width: number, height = width) =>
  sharp({ create: { width, height, channels: 4, background: { r: 37, g: 89, b: 58, alpha: 1 } } }).png().toBuffer();

/** An ICO file holding these images, each named in the directory as the format does. */
function icoOf(images: Buffer[]): Buffer {
  const header = 6 + images.length * 16;
  const out = Buffer.alloc(header + images.reduce((sum, image) => sum + image.length, 0));
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(images.length, 4);
  let offset = header;
  images.forEach((image, i) => {
    out.writeUInt32LE(image.length, 6 + i * 16 + 8);
    out.writeUInt32LE(offset, 6 + i * 16 + 12);
    image.copy(out, offset);
    offset += image.length;
  });
  return out;
}

/** Bytes that sniff as a PNG and are not one. */
function corruptPng(length = 400): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 0h64v64H0z"/></svg>'.padEnd(120, " "));

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();

  server = await startTestServer({
    "www.touch.test": {
      "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      "/": { body: '<!doctype html><html><head><link rel="apple-touch-icon" href="/touch.png"></head><body>home</body></html>' },
      "/touch.png": { body: await pngOf(180), contentType: "image/png" },
    },
    "icons.duckduckgo.com": {},
    "www.google.com": {},
  }, HOSTS);

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.COL_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.COL_DISABLE_BROWSER = "1";
  delete process.env.ANTHROPIC_API_KEY;
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => {
  await deps?.close();
  await server?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate users, companies, company_logos, career_sources, scan_runs, tasks, resource_leases, settings restart identity cascade`);
  now = new Date("2026-09-27T09:00:00Z");
});

it("encodes a PNG as a WebP of at most 64 px, fitted on a transparent square", async () => {
  const wide = await encodeLogoWebp(await pngOf(300, 100));
  const meta = await sharp(wide).metadata();
  expect(meta.format).toBe("webp");
  expect(meta).toMatchObject({ width: 64, height: 64, hasAlpha: true });
  // Letterboxed, not cropped: the corner is the transparent background.
  const { data } = await sharp(wide).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(data[3]).toBe(0);
  const square = await encodeLogoWebp(await pngOf(256));
  expect((await sharp(square).metadata()).width).toBeLessThanOrEqual(64);
});

it("keeps bytes it cannot read exactly as they were, and an SVG as it is", async () => {
  const bytes = new Uint8Array(corruptPng());
  await expect(encodeLogoWebp(bytes)).rejects.toThrow();
  expect(await normaliseLogo(bytes, "image/png", encodeLogoWebp)).toMatchObject({ bytes, contentType: "image/png", reencoded: false });
  const svg = new Uint8Array(SVG);
  expect(await normaliseLogo(svg, "image/svg+xml", encodeLogoWebp)).toMatchObject({ bytes: svg, contentType: "image/svg+xml", reencoded: false });
});

it("stores a captured touch icon as a 64 px WebP", async () => {
  const [company] = await db.insert(schema.companies).values({ name: "Touch Ltd", domain: "touch.test", homepageUrl: "https://www.touch.test/" }).returning();
  const task = { id: "00000000-0000-0000-0000-000000000001", type: "discover", payload: { companyId: company!.id, logoOnly: true, homepageUrl: company!.homepageUrl }, attempts: 1 } as never;
  const result = await handleDiscover(task, deps) as { captured: boolean; contentType: string; bytes: number };
  expect(result).toMatchObject({ captured: true, contentType: "image/webp" });
  const stored = await readCompanyLogo(db, company!.id);
  expect(stored?.contentType).toBe("image/webp");
  expect(await sharp(stored!.bytes).metadata()).toMatchObject({ format: "webp", width: 64, height: 64 });
  expect(result.bytes).toBe(stored!.bytes.length);
});

async function companyWithLogo(domain: string, bytes: Buffer, contentType: string, fetchedAt: Date) {
  const [company] = await db.insert(schema.companies).values({ name: domain, domain, homepageUrl: `https://${domain}/`, logoFetchedAt: fetchedAt }).returning();
  await db.insert(schema.companyLogos).values({
    companyId: company!.id, contentType, dataBase64: bytes.toString("base64"), byteLength: bytes.length,
    source: "site_icon", sourceUrl: `https://${domain}/icon`, fetchedAt,
  });
  return company!;
}

const reencodeTask = (payload: Record<string, unknown> = {}) => ({ id: "00000000-0000-0000-0000-000000000002", type: "reencode_logos", payload, attempts: 1 } as never);

it("re-encodes stored logos in bounded passes, moving each one's version, and leaves the rest alone", async () => {
  const captured = new Date("2026-06-01T12:00:00Z");
  const touch = await companyWithLogo("a-touch.test", await pngOf(180), "image/png", captured);
  const ico = await companyWithLogo("b-ico.test", icoOf([await pngOf(16), await pngOf(48)]), "image/x-icon", captured);
  const corrupt = await companyWithLogo("c-corrupt.test", corruptPng(), "image/png", captured);
  const svg = await companyWithLogo("d-svg.test", SVG, "image/svg+xml", captured);
  const ordered = [touch, ico, corrupt].map((company) => company.id).sort();

  // A pass of two: it takes the first two in company order and queues the next pass itself.
  const first = await handleReencodeLogos(reencodeTask(), deps, undefined, { batch: 2 }) as { examined: number; next: string | null };
  expect(first).toMatchObject({ examined: 2, next: ordered[1] });
  const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "reencode_logos"));
  expect(queued.map((task) => task.payload)).toEqual([{ afterCompanyId: ordered[1] }]);
  expect(queued[0]!.priority).toBe(7);
  // The last pass finds less than a batch and queues nothing more; the SVG is never examined.
  const second = await handleReencodeLogos(reencodeTask({ afterCompanyId: ordered[1] }), deps, undefined, { batch: 2 }) as { examined: number; next: string | null };
  expect(second).toMatchObject({ examined: 1, next: null });
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "reencode_logos"))).toHaveLength(1);

  for (const company of [touch, ico]) {
    const stored = await readCompanyLogo(db, company.id);
    expect(stored?.contentType).toBe("image/webp");
    expect(await sharp(stored!.bytes).metadata()).toMatchObject({ format: "webp", width: 64, height: 64 });
    // The version in the logo's URL moves with the bytes, so no cache keeps serving the old file.
    expect(stored!.fetchedAt.toISOString()).toBe(now.toISOString());
    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, company.id));
    expect(row!.logoFetchedAt?.toISOString()).toBe(now.toISOString());
    expect(row!.faviconUrl).toBeNull();
  }
  // Bytes the library cannot read, and the SVG: exactly as captured, version and all.
  for (const [company, bytes, contentType] of [[corrupt, corruptPng(), "image/png"], [svg, SVG, "image/svg+xml"]] as const) {
    const stored = await readCompanyLogo(db, company.id);
    expect(stored).toMatchObject({ contentType, bytes });
    expect(stored!.fetchedAt.toISOString()).toBe(captured.toISOString());
  }
});

it("does not overwrite a logo that a capture replaced while the pass was encoding", async () => {
  const captured = new Date("2026-06-01T12:00:00Z");
  const company = await companyWithLogo("race.test", await pngOf(180), "image/png", captured);
  const fresh = await pngOf(32);
  const result = await handleReencodeLogos(reencodeTask(), deps, undefined, {
    encode: async (bytes) => {
      // A capture lands between the read and the write.
      await db.update(schema.companyLogos).set({ dataBase64: fresh.toString("base64"), byteLength: fresh.length }).where(eq(schema.companyLogos.companyId, company.id));
      return encodeLogoWebp(bytes);
    },
  }) as { reencoded: number; replaced: number };
  expect(result).toMatchObject({ reencoded: 0, replaced: 1 });
  expect((await readCompanyLogo(db, company.id))?.bytes).toEqual(fresh);
});
