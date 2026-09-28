"use server";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ensureHttpUrl, normalizeUrl, sha1, stripHtml } from "@ava/core";
import { discoveryDocuments, discoverySources } from "@ava/db/schema";
import { requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettings } from "@/lib/settings";
import { zUuid } from "@/lib/validation";
import { unsafeUrlRefusal } from "@/lib/public-url";
import type { DiscoveryActionResult } from "@/lib/discovery-ux";

/**
 * Each enabled source is fetched through the shared polite fetcher and read by the model on its
 * interval, so one account keeps a newsletter shelf, not a crawl list.
 */
const MAX_DISCOVERY_SOURCES = 20;

/**
 * The URL a website or LinkedIn source is read from, normalised, or the sentence that refuses it:
 * `invalid` when it is not a plain public http(s) address, `notLinkedIn` for a LinkedIn source
 * pointed elsewhere, or the public-address refusal the worker would give.
 */
function sourceUrlFrom(value: string, kind: string, sentences: { invalid: string; notLinkedIn: string }): { url: string } | { error: string } {
  let url: string;
  try {
    if (!value || value.length > 2048 || /^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error();
    const parsedUrl = new URL(ensureHttpUrl(value));
    if (parsedUrl.username || parsedUrl.password) throw new Error();
    if (kind === "linkedin" && parsedUrl.hostname !== "linkedin.com" && !parsedUrl.hostname.endsWith(".linkedin.com")) return { error: sentences.notLinkedIn };
    url = normalizeUrl(parsedUrl.href);
  } catch { return { error: sentences.invalid }; }
  const unsafe = unsafeUrlRefusal(url);
  return unsafe ? { error: unsafe } : { url };
}

/** Whether another of the account's sources already reads this URL, or this email newsletter by name. */
function sameSource(row: { url: string | null; kind: string; name: string }, url: string | null, name: string): boolean {
  return url ? !!row.url && normalizeUrl(row.url) === url : row.kind === "email" && row.name.toLowerCase() === name.toLowerCase();
}

const sourceInput = z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(["website", "email", "linkedin"]), intervalDays: z.coerce.number().int().min(1).max(90) });
export async function saveDiscoverySource(form: FormData): Promise<DiscoveryActionResult> {
  const user = await requireVerifiedUser();
  const parsed = sourceInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Enter a source name and a check interval between 1 and 90 days." };
  const { name, kind, intervalDays } = parsed.data;
  let url: string | null = null;
  if (kind !== "email") {
    const checked = sourceUrlFrom(String(form.get("url") ?? "").trim(), kind, { invalid: "Enter a valid public website or LinkedIn URL.", notLinkedIn: "Use a LinkedIn URL, or select Website for another site." });
    if ("error" in checked) return { ok: false, error: checked.error };
    url = checked.url;
  }
  const created = await db().transaction(async tx => {
    // Serialise this account's additions, including separate browser tabs, so neither the duplicate
    // check nor the count can be passed twice at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`discovery-sources:${user.id}`}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${user.id}:${url ?? `email:${name.toLowerCase()}`}`}))`);
    const existing = await tx.select().from(discoverySources).where(eq(discoverySources.userId, user.id));
    if (existing.some(row => sameSource(row, url, name))) return "duplicate";
    if (existing.length >= MAX_DISCOVERY_SOURCES) return "full";
    await tx.insert(discoverySources).values({ userId: user.id, name, kind, intervalDays, url });
    return "created";
  });
  if (created === "duplicate") return { ok: false, error: "This source is already on your list. Use its settings or Check now." };
  if (created === "full") return { ok: false, error: `You can keep up to ${MAX_DISCOVERY_SOURCES} sources, and this list is full. Point one you no longer read at the new address instead.` };
  revalidatePath("/suggestions");
  return { ok: true, message: kind === "email" ? "Source added. Import an edition to get started." : "Source added. Its first check is due now." };
}

/** Enabling or re-pointing a source schedules its next model-read check, so it waits for a confirmed address too. */
export async function updateDiscoverySource(id: string, form: FormData): Promise<DiscoveryActionResult> {
  const user = await requireVerifiedUser();
  const sourceId = zUuid().parse(id);
  const interval = z.coerce.number().int().min(1).max(90).safeParse(form.get("intervalDays"));
  if (!interval.success) return { ok: false, error: "Choose a check interval between 1 and 90 days." };
  const enabled = form.get("enabled") === "on";
  const found = await db().transaction(async tx => {
    const [source] = await tx.select().from(discoverySources).where(and(eq(discoverySources.id, sourceId), eq(discoverySources.userId, user.id))).for("update");
    if (!source) return "This source no longer exists. Refresh the page.";
    const name = form.has("name") ? String(form.get("name")).trim() : source.name;
    if (!name || name.length > 200) return "Enter a source name of up to 200 characters.";
    let url = source.url;
    if (source.kind !== "email" && form.has("url")) {
      const checked = sourceUrlFrom(String(form.get("url") ?? "").trim(), source.kind, { invalid: "Enter a valid public source URL.", notLinkedIn: "Use a LinkedIn URL for this source." });
      if ("error" in checked) return checked.error;
      url = checked.url;
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${user.id}:${url ?? `email:${name.toLowerCase()}`}`}))`);
    const existing = await tx.select().from(discoverySources).where(eq(discoverySources.userId, user.id));
    if (existing.some(row => row.id !== sourceId && sameSource(row, url, name))) return "Another source already uses this URL or email newsletter name.";
    const nextRunAt = (!source.enabled && enabled) || url !== source.url ? new Date() : interval.data !== source.intervalDays
      ? new Date(Date.now() + interval.data * 86400000) : source.nextRunAt;
    await tx.update(discoverySources).set({ name, url, intervalDays: interval.data, enabled, nextRunAt }).where(eq(discoverySources.id, sourceId));
    return true;
  });
  if (found !== true) return { ok: false, error: found };
  revalidatePath("/suggestions");
  return { ok: true, message: enabled ? "Source settings saved." : "Source paused. A check already in progress may finish." };
}

export async function checkDiscoverySource(id: string): Promise<DiscoveryActionResult> {
  const user = await requireVerifiedUser();
  if (!(await getSettings()).suggestionsEnabled) return { ok: false, error: "Enable company suggestions in Settings before running a check." };
  const [source] = await db().select().from(discoverySources).where(and(eq(discoverySources.id, zUuid().parse(id)), eq(discoverySources.userId, user.id)));
  if (!source?.enabled) return { ok: false, error: "Enable this source before running a check." };
  const queued = await enqueue("monitor_source", { sourceId: source.id });
  revalidatePath("/suggestions");
  return { ok: true, message: queued ? "Check queued. Suggestions will appear in Review when it finishes." : "This source already has a check queued or running." };
}

export async function importDiscoveryDocument(id: string, form: FormData): Promise<DiscoveryActionResult> {
  const user = await requireVerifiedUser();
  const sourceId = zUuid().parse(id);
  const title = z.string().trim().min(1).max(300).safeParse(form.get("title"));
  const raw = z.string().trim().min(100).max(40000).safeParse(form.get("content"));
  if (!title.success || !raw.success) return { ok: false, error: "Enter an edition title and 100–40,000 characters of content. Split longer editions into separate imports." };
  const content = stripHtml(raw.data);
  if (content.length < 100) return { ok: false, error: "Include at least 100 characters of readable newsletter or post text." };
  const [source] = await db().select().from(discoverySources).where(and(eq(discoverySources.id, sourceId), eq(discoverySources.userId, user.id)));
  if (!source) return { ok: false, error: "This source no longer exists. Refresh the page." };
  const rows = await db().insert(discoveryDocuments).values({ sourceId, title: title.data, content, fingerprint: sha1(content) }).onConflictDoNothing().returning({ id: discoveryDocuments.id });
  revalidatePath("/suggestions");
  return { ok: true, message: !rows.length ? "This edition was already imported. No duplicate was created." : source.enabled ? "Edition imported. It will be reviewed at the next check, or choose Check now." : "Edition imported. Enable the source when you are ready to check it." };
}
