/**
 * Every export of a `"use server"` module is an endpoint: Next registers it under an id the client
 * bundle carries, and anyone who has that id can call it with whatever arguments they like. So each
 * one authenticates before any read or write (CLAUDE.md): `requireUser()` for an account's own
 * data, `requireVerifiedUser()` for work that scans, discovers or calls a model, `requireAdmin()`
 * for what every account shares.
 *
 * This walks every such module rather than a list of actions somebody remembered. Each export is
 * classified below by how it begins, and the classification must be complete: a new export nobody
 * classified fails here by name. Then each class is refused to the caller it exists to keep out —
 * nobody signed in, a member, an unconfirmed member — and the refusal must come from the gate
 * itself, before the action has touched the database for anything but the session.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import { createTestDb } from "@/test/db";

/** The real database while a test has somebody signed in; null while nobody is. */
let signedIn: Db | null = null;
/** Every property an action asked of `db()`, in order. */
const reached: string[] = [];
let session: string | undefined;

/**
 * `db()` for the actions under test. Signed out, any use at all is a failure; signed in, it is the
 * real database, watched, so a test can say an action read nothing but the session.
 */
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

/** Each gate's own refusal, as it left the gate: what tells a refusal by the gate from any other. */
const refusals = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/db", () => ({ db: () => watchedDatabase() }));
vi.mock("@/lib/auth", async (original) => {
  const real = await original<typeof import("@/lib/auth")>();
  const watch = <A extends unknown[], R>(name: string, gate: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try {
      return await gate(...args);
    } catch (error) {
      refusals.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
  return {
    ...real,
    requireUser: watch("requireUser", real.requireUser),
    requireVerifiedUser: watch("requireVerifiedUser", real.requireVerifiedUser),
    requireAdmin: watch("requireAdmin", real.requireAdmin),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers({ host: "ava.test", "x-forwarded-for": "198.51.100.44" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: vi.fn() }));

type Gate = "user" | "verified" | "admin" | { public: string };

/**
 * Who may call each export, read off how it begins. `user` is `requireUser()` (or a
 * `getCurrentUser()` that throws `Unauthorised`), directly or through the one helper it calls;
 * `verified` is `requireVerifiedUser()`; `admin` is `requireAdmin()`. A public export says why.
 */
const GATES: Record<string, Record<string, Gate>> = {
  "login/actions.ts": {
    login: { public: "Signing in is how a session begins." },
    signup: { public: "Registering creates the account a session would name." },
    resendConfirmation: { public: "A registration still waiting on its link has no session; throttled per address." },
    logout: { public: "Signing out needs nothing but the cookie it clears." },
    requestReset: { public: "Someone who has forgotten their password cannot sign in first; throttled per address." },
    resetPassword: { public: "The single-use reset token is the credential." },
  },
  "auth/verify/actions.ts": {
    confirmEmail: { public: "The single-use confirmation token is the credential, with the password when there is one." },
  },
  "actions/account.ts": {
    changePassword: "user", signOutEverywhere: "user", resendVerification: "user", updateProfile: "user",
    setUserRole: "admin", deleteUser: "admin", createResetLink: "admin", listAccounts: "admin", accountCount: "admin",
    setAccountAiBudget: "admin", resetAccountAiSpend: "admin",
  },
  "actions/admin.ts": {
    saveCatalogueCompany: "admin", applyNameSuggestion: "admin", dismissNameSuggestion: "admin",
    removeCatalogueSource: "admin", removeCatalogueCompany: "admin",
  },
  "actions/applications.ts": { setRoleStage: "user", recordApplication: "user", updateApplication: "user", manageRoleCv: "user" },
  "actions/companies.ts": {
    addCompanies: "verified", pauseCompany: "user", resumeCompany: "user", archiveCompany: "user",
    refreshCompany: "verified", rescanCompany: "verified", rediscoverCompany: "verified", saveCompanyNotes: "user",
    importPosting: "verified", suggestCompanyName: "user", refreshCompanyLogo: "verified", disableSource: "admin",
    enableSource: "admin", markSourceConfirmed: "verified", useDiscoveryCandidate: "verified", pasteDiscoveryUrl: "verified",
    refreshCompanyProfile: "verified", unfollowCompany: "user", followCompany: "verified",
  },
  "actions/cv-share.ts": { createCvShareLink: "user", revokeCvShareLink: "user", resolveCvShareComment: "user" },
  "actions/cv.ts": {
    saveCvLibrary: "user", answerCvGapQuiz: "verified", saveCvWritingPreferences: "user", saveCvAppearance: "user",
    saveCvModel: "user", manageCvs: "user", requestCv: "verified", saveCvDraft: "verified", assessCvDraft: "verified",
    finaliseCvDraft: "user", rescoreLibrary: "verified",
  },
  "actions/decisions.ts": { roleDetails: "user", decide: "user", saveDecisionTags: "verified", archiveRoles: "user", decideRoles: "user" },
  "actions/discovery-sources.ts": {
    saveDiscoverySource: "verified", updateDiscoverySource: "verified", checkDiscoverySource: "verified", importDiscoveryDocument: "verified",
  },
  "actions/health.ts": { retryTask: "admin", keepCurrentSource: "user" },
  "actions/learning.ts": {
    savePinnedStatements: "verified", answerOpenQuestion: "verified", saveSeedProfile: "user", saveSeedProfileSetting: "user",
    acceptFilterSuggestionWithReport: "verified", acceptFilterSuggestion: "verified", suggestFromScansNow: "verified",
    rejectFilterSuggestion: "user", resynthesizeNow: "verified", rescoreAllRoles: "verified", savePreferenceProfile: "verified",
    acceptReasonTag: "user",
  },
  "actions/library-import.ts": {
    importLibraryDocument: "verified", acceptLibraryImport: "user", dismissLibraryImport: "user", retryLibraryImport: "verified",
  },
  "actions/settings.ts": {
    saveGate: "user", saveKeywords: "user", saveMatchFields: "user", saveLocationFilter: "user", saveTableSettings: "user",
    saveSuggestionSettings: "user", saveRegistrationSettings: "admin", saveSchedule: "admin", saveAiSettings: "admin",
    saveAiBudget: "user", runDailyScanNow: "admin",
  },
  "actions/setup.ts": { dismissSetupChecklist: "user" },
  "actions/suggestions.ts": { acceptSuggestion: "verified", rejectSuggestion: "verified", findMoreSuggestions: "verified" },
};

const classified = Object.entries(GATES).flatMap(([module, exports]) => Object.entries(exports).map(([name, gate]) => ({ module, name, gate })));
const gated = (gate: Exclude<Gate, { public: string }>) => classified.filter((entry) => entry.gate === gate);
const guarded = classified.filter((entry) => typeof entry.gate === "string");

type Action = (...args: unknown[]) => Promise<unknown>;

async function action(module: string, name: string): Promise<Action> {
  const loaded = (await import(join(__dirname, module))) as Record<string, unknown>;
  const fn = loaded[name];
  if (typeof fn !== "function") throw new Error(`${module} no longer exports ${name}`);
  return fn as Action;
}

/** An id no row has: the arguments must not matter, because the gate comes before them. */
const ABSENT_ID = "00000000-0000-4000-8000-00000000abcd";

/** Arguments of the right shape for each parameter, by its name; none names anything that exists. */
function harmlessArguments(fn: Action): unknown[] {
  const source = fn.toString();
  const open = source.indexOf("(");
  let depth = 0;
  let close = open;
  for (; close < source.length; close++) {
    if (source[close] === "(") depth++;
    else if (source[close] === ")" && --depth === 0) break;
  }
  const names = source.slice(open + 1, close).split(",").map((parameter) => parameter.split("=")[0]!.trim()).filter(Boolean);
  return names.map((name) => {
    if (/form|data$/i.test(name)) return new FormData();
    if (/^_?prev/i.test(name)) return { ok: true };
    if (/ids$/i.test(name)) return [ABSENT_ID];
    if (/^(page|perPage|candidateIndex)$/.test(name)) return 1;
    if (name === "archived") return true;
    if (name === "decision") return "skip";
    // The dangerous value: a member asking for administrator rights.
    if (name === "role") return "admin";
    if (/id$/i.test(name)) return ABSENT_ID;
    return "";
  });
}

type Outcome = { threw: string } | { returned: unknown };

async function call(module: string, name: string, args?: unknown[]): Promise<Outcome> {
  const fn = await action(module, name);
  reached.length = 0;
  refusals.length = 0;
  try {
    return { returned: await fn(...(args ?? harmlessArguments(fn))) };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Refused by the gate: the action threw the gate's refusal, or turned it into a failed result, and
 * the gate is on record as the thing that refused. A failed result alone is not enough: a harmless
 * argument that fails validation would look the same, with no gate behind it at all.
 */
function refusedBy(outcome: Outcome, refusal: string): boolean {
  if ("threw" in outcome) return outcome.threw === refusal;
  const failed = typeof outcome.returned === "object" && outcome.returned !== null && (outcome.returned as { ok?: unknown }).ok === false;
  return failed && refusals.some((entry) => entry.endsWith(`: ${refusal}`));
}

/** Everything the action asked of the database beyond `getCurrentUser`'s one session lookup. */
const beyondTheSession = () => reached.filter((property, index) => !(index === 0 && property === "select"));

async function serverActionModules(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : serverActionModules(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return /^\s*["']use server["']/.test(await readFile(path, "utf8")) ? [path] : [];
  }));
  return nested.flat();
}

it("classifies every export of every server-action module, each exactly once", async () => {
  const exported: string[] = [];
  // Wherever one lives: a "use server" module in lib/ or components/ is as much an endpoint.
  const roots = [__dirname, join(__dirname, "..", "lib"), join(__dirname, "..", "components")];
  for (const path of (await Promise.all(roots.map(serverActionModules))).flat()) {
    const module = relative(__dirname, path);
    const loaded = (await import(path)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(loaded)) if (typeof value === "function") exported.push(`${module}#${name}`);
  }
  const listed = classified.map(({ module, name }) => `${module}#${name}`);
  expect(new Set(listed).size).toBe(listed.length);
  // An export missing here is an endpoint nobody decided the gate of; one extra is a stale entry.
  expect(exported.filter((key) => !listed.includes(key)).sort()).toEqual([]);
  expect(listed.filter((key) => !exported.includes(key)).sort()).toEqual([]);
  expect(exported.length).toBeGreaterThan(90);
});

describe("with nobody signed in", () => {
  beforeEach(() => {
    signedIn = null;
    session = undefined;
    process.env.SESSION_SECRET = "server-actions-auth-test-secret";
  });

  it.each(guarded.map(({ module, name }) => [`${module} ${name}`, module, name]))("refuses %s before reaching the database", async (_label, module, name) => {
    const outcome = await call(module, name);
    expect({ refused: refusedBy(outcome, "Unauthorised"), reached, outcome }).toMatchObject({ refused: true, reached: [] });
  });
});

describe("signed in", () => {
  let database: Db;
  let pool: ReturnType<typeof createTestDb>["pool"];

  beforeAll(async () => {
    const client = createTestDb();
    database = client.db;
    pool = client.pool;
    await runMigrations(database);
    process.env.SESSION_SECRET = "server-actions-auth-test-secret";
  }, 60_000);
  afterAll(async () => {
    signedIn = null;
    await pool?.end();
  });
  beforeEach(async () => {
    signedIn = null;
    session = undefined;
    await database.execute(sql`truncate users, companies, tasks, ai_calls, ai_reservations, auth_tokens restart identity cascade`);
  });

  /** A member, confirmed or not, signed in on the watched database. */
  async function signInMember(email: string, confirmed: boolean) {
    const signed = await signInTestUser(database, process.env.SESSION_SECRET!, email, "member");
    if (!confirmed) await database.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, signed.user.id));
    session = signed.cookie;
    signedIn = database;
    return signed.user;
  }

  /** Rows the refusals could have left, in tables this file truncates before every test. */
  async function workLeftBehind() {
    const counts = await database.execute<{ tasks: number; calls: number; holds: number }>(sql`select
      (select count(*)::int from tasks) as tasks, (select count(*)::int from ai_calls) as calls, (select count(*)::int from ai_reservations) as holds`);
    return counts.rows[0];
  }

  describe("as a confirmed member", () => {
    beforeEach(async () => { await signInMember("member@example.com", true); });

    it.each(gated("admin").map(({ module, name }) => [`${module} ${name}`, module, name]))("refuses the administrator's %s, reading nothing but the session", async (_label, module, name) => {
      const outcome = await call(module, name);
      expect({ refused: refusedBy(outcome, "Forbidden"), beyond: beyondTheSession(), outcome }).toMatchObject({ refused: true, beyond: [] });
      expect(await workLeftBehind()).toEqual({ tasks: 0, calls: 0, holds: 0 });
    });
  });

  describe("as a member who has not confirmed their address", () => {
    beforeEach(async () => { await signInMember("unconfirmed@example.com", false); });

    it.each(gated("verified").map(({ module, name }) => [`${module} ${name}`, module, name]))("sends them to confirm before %s, reading nothing but the session", async (_label, module, name) => {
      const outcome = await call(module, name);
      expect({ refused: refusedBy(outcome, "redirect:/account?verify=required"), beyond: beyondTheSession(), outcome }).toMatchObject({ refused: true, beyond: [] });
      expect(await workLeftBehind()).toEqual({ tasks: 0, calls: 0, holds: 0 });
    });
  });

  it("leaves every account and follower's role as it was when a member aims an administrator's action at it", async () => {
    const admin = await signInTestUser(database, process.env.SESSION_SECRET!, "the-admin@example.com", "admin");
    const member = await signInMember("aiming@example.com", true);
    const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
    await subscribeToCompany(database, admin.user.id, company!.id);
    const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
    const [job] = await database.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id, externalKey: "1", title: "Operations Manager", normalizedTitle: "operations manager", url: "https://acme.example/jobs/1" }).returning();
    await database.insert(schema.userJobs).values({ userId: admin.user.id, jobId: job!.id, inTable: true });
    const resetFor = new FormData();
    resetFor.set("userId", admin.user.id);

    // A reset link for the administrator would be an account takeover; so would promoting oneself.
    expect(await call("actions/account.ts", "createResetLink", [{ ok: true }, resetFor])).toEqual({ threw: "Forbidden" });
    expect(await call("actions/account.ts", "setUserRole", [member.id, "admin"])).toEqual({ threw: "Forbidden" });
    expect(await call("actions/account.ts", "deleteUser", [admin.user.id])).toEqual({ threw: "Forbidden" });
    // Removing a shared company cascades to every follower's views.
    expect(await call("actions/admin.ts", "removeCatalogueCompany", [company!.id])).toEqual({ threw: "Forbidden" });
    expect(await call("actions/admin.ts", "removeCatalogueSource", [source!.id])).toEqual({ threw: "Forbidden" });

    signedIn = null;
    const roles = await database.select({ id: schema.users.id, role: schema.users.role }).from(schema.users).where(sql`${schema.users.id} in (${admin.user.id}, ${member.id})`);
    expect(Object.fromEntries(roles.map((row) => [row.id, row.role]))).toEqual({ [admin.user.id]: "admin", [member.id]: "member" });
    expect(await database.select().from(schema.authTokens).where(eq(schema.authTokens.userId, admin.user.id))).toEqual([]);
    expect((await database.select().from(schema.careerSources).where(eq(schema.careerSources.id, source!.id)))[0]!.status).toBe("active");
    expect(await database.select().from(schema.userJobs).where(eq(schema.userJobs.userId, admin.user.id))).toHaveLength(1);
  });
});
