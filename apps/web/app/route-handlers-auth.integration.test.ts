/**
 * Every route handler authenticates for itself. Middleware checks only that the session cookie is
 * signed (CLAUDE.md: "Authentication is a database row, not a cookie"), so a cookie for a session
 * that has since been deleted or has expired reaches the handler, and the handler's own
 * `routeUser()` is what turns it away. The PDF and CSV routes serve a person's CV and whole roles
 * table, so one that dropped it would leak exactly what an account most expects to stay private.
 *
 * This walks every `route.ts` under `app/` rather than a list. Each is classified below, and the
 * classification must be complete; then every handler that needs a session is called with none and
 * must answer 401 or 403 without touching the database.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import { createTestDb } from "@/test/db";

/** The real database while a test has somebody signed in; null while nobody is. */
let signedIn: Db | null = null;
const reached: string[] = [];
let session: string | undefined;

function watchedDatabase(): Db {
  return new Proxy({} as Db, {
    get(_target, property) {
      reached.push(String(property));
      if (!signedIn) throw new Error(`reached the database (${String(property)}) with nobody signed in`);
      const value: unknown = Reflect.get(signedIn, property, signedIn);
      return typeof value === "function" ? value.bind(signedIn) : value;
    },
  });
}

vi.mock("@/lib/db", () => ({ db: () => watchedDatabase() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers({ host: "ava.test", "x-forwarded-for": "198.51.100.45" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const SECRET = "route-handlers-auth-test-secret-0123456789";

type Access = "session" | { public: string } | { bearer: string };

/** Who may call each route handler. A public one says why; a bearer one names the secret it checks. */
const ROUTES: Record<string, Access> = {
  "(app)/cv/route.ts": { public: "Redirects an old /cv link to /applications; it reads nothing." },
  "api/applications/[id]/pdf/route.ts": "session",
  "api/companies/[id]/logo/route.ts": "session",
  "api/cron/route.ts": { bearer: "CRON_SECRET" },
  "api/cv/[id]/pdf/route.ts": "session",
  "api/cv/[id]/progress/route.ts": "session",
  "api/cv/library/reviews/route.ts": "session",
  "api/cv/library/route.ts": "session",
  "api/cv/manage/route.ts": "session",
  "api/cv/preview/route.ts": "session",
  "api/export.csv/route.ts": "session",
  "api/health/route.ts": { public: "The platform's liveness check: the serving commit, and nothing about any account." },
  "api/newsletters/route.ts": { bearer: "NEWSLETTER_INGEST_SECRET" },
  // Signed cookie only, by design: it logs a navigation's timing and reads and writes no account's data.
  "api/performance/route.ts": "session",
  "api/scan-status/route.ts": "session",
  "api/work-status/route.ts": "session",
  "auth/google/callback/route.ts": { public: "Completes Google sign-in; the signed state cookie and Google's answer are the credential." },
  "auth/google/route.ts": { public: "Starts Google sign-in, before there is any session." },
  "share/[token]/comments/route.ts": { public: "A reviewer holding a share link has no account; the live share token is the credential." },
};

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  }));
  return nested.flat();
}

async function handlers(route: string): Promise<Array<[string, Handler]>> {
  const loaded = (await import(join(__dirname, route))) as Record<string, unknown>;
  return METHODS.filter((method) => typeof loaded[method] === "function").map((method) => [method, loaded[method] as Handler]);
}

/** A minimal request, and params naming nothing that exists. */
function request(route: string, method: string, headers: Record<string, string> = {}) {
  const path = "/" + route.replace(/^\(app\)\//, "").replace(/\/route\.ts$/, "").replace(/\[id\]/g, "00000000-0000-4000-8000-00000000abcd").replace(/\[token\]/g, "token");
  const body = method === "GET" || method === "HEAD" ? undefined : "{}";
  return new NextRequest(`http://ava.test${path}`, {
    method,
    body,
    headers: { origin: "http://ava.test", host: "ava.test", "content-type": "application/json", ...headers },
  });
}
const context = { params: Promise.resolve({ id: "00000000-0000-4000-8000-00000000abcd", token: "token" }) };

beforeEach(() => {
  signedIn = null;
  session = undefined;
  process.env.SESSION_SECRET = SECRET;
  process.env.CRON_SECRET = "cron-secret-for-route-auth-tests";
  process.env.NEWSLETTER_INGEST_SECRET = "newsletter-secret-for-route-auth-tests";
});

it("classifies every route handler under app/", async () => {
  const found = (await routeFiles(__dirname)).map((path) => relative(__dirname, path)).sort();
  expect(found).toEqual(Object.keys(ROUTES).sort());
});

const sessionRoutes = Object.entries(ROUTES).filter(([, access]) => access === "session").map(([route]) => route);
const bearerRoutes = Object.entries(ROUTES).filter(([, access]) => typeof access === "object" && "bearer" in access).map(([route]) => route);

it.each(sessionRoutes)("answers %s with 401 or 403 and no database read when nobody is signed in", async (route) => {
  const found = await handlers(route);
  expect(found.length).toBeGreaterThan(0);
  for (const [method, handle] of found) {
    reached.length = 0;
    const response = await handle(request(route, method), context);
    expect({ method, status: [401, 403].includes(response.status), reached }).toEqual({ method, status: true, reached: [] });
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
  }
});

it.each(bearerRoutes)("answers %s with 401 and no database read without its bearer token, or with the wrong one", async (route) => {
  const found = await handlers(route);
  expect(found.length).toBeGreaterThan(0);
  for (const [method, handle] of found) {
    for (const headers of [{}, { authorization: "Bearer not-the-secret" }] as Array<Record<string, string>>) {
      reached.length = 0;
      const response = await handle(request(route, method, headers), context);
      expect({ method, status: response.status, reached }).toEqual({ method, status: 401, reached: [] });
    }
  }
});

describe("a signed cookie whose session row is gone", () => {
  let database: Db;
  let pool: ReturnType<typeof createTestDb>["pool"];

  beforeAll(async () => {
    const client = createTestDb();
    database = client.db;
    pool = client.pool;
    await runMigrations(database);
  }, 60_000);
  afterAll(async () => {
    signedIn = null;
    await pool?.end();
  });
  beforeEach(async () => {
    await database.execute(sql`truncate users restart identity cascade`);
    signedIn = database;
  });

  it("is refused by the application PDF route through the real session lookup, deleted or expired", async () => {
    const { GET } = await import("./api/applications/[id]/pdf/route");
    const signed = await signInTestUser(database, SECRET, "pdf-owner@example.com", "member");
    const [application] = await database.insert(schema.applications).values({
      userId: signed.user.id, jobTitle: "Operations Manager", companyName: "Acme", appliedOn: "2026-09-01",
      pdfBase64: Buffer.from("%PDF-1.4 submitted").toString("base64"), history: [],
    }).returning();
    const download = () => GET(new Request(`http://ava.test/api/applications/${application!.id}/pdf`), { params: Promise.resolve({ id: application!.id }) });
    session = signed.cookie;

    const served = await download();
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe("%PDF-1.4 submitted");

    // The cookie is still validly signed and unexpired; only the row says it has ended.
    await database.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.sessions.id, signed.sessionId));
    expect((await download()).status).toBe(401);
    await database.delete(schema.sessions).where(eq(schema.sessions.id, signed.sessionId));
    const refused = await download();
    expect(refused.status).toBe(401);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  });
});
