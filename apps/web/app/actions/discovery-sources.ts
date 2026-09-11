"use server";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ensureHttpUrl, normalizeUrl, sha1, stripHtml } from "@christopher/core";
import { discoveryDocuments, discoverySources } from "@christopher/db/schema";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettings } from "@/lib/settings";
import { zUuid } from "@/lib/validation";
import type { DiscoveryActionResult } from "@/lib/discovery-ux";

const sourceInput = z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(["website", "email", "linkedin"]), intervalDays: z.coerce.number().int().min(1).max(90) });
export async function saveDiscoverySource(form: FormData): Promise<DiscoveryActionResult> {
  await requireSession();
  const parsed = sourceInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, error: "Enter a source name and a check interval between 1 and 90 days." };
  const { name, kind, intervalDays } = parsed.data;
  let url: string | null = null;
  if (kind !== "email") {
    try {
      const value = String(form.get("url") ?? "").trim();
      if (!value || value.length > 2048 || /^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error();
      const parsedUrl = new URL(ensureHttpUrl(value));
      if (parsedUrl.username || parsedUrl.password) throw new Error();
      if (kind === "linkedin" && parsedUrl.hostname !== "linkedin.com" && !parsedUrl.hostname.endsWith(".linkedin.com")) return { ok: false, error: "Use a LinkedIn URL, or select Website for another site." };
      url = normalizeUrl(parsedUrl.href);
    } catch { return { ok: false, error: "Enter a valid public website or LinkedIn URL." }; }
  }
  const created = await db().transaction(async tx => {
    // Serialise equivalent additions, including separate browser tabs.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${url ?? `email:${name.toLowerCase()}`}))`);
    const existing = await tx.select().from(discoverySources);
    if (existing.some(row => url ? row.url && normalizeUrl(row.url) === url : row.kind === "email" && row.name.toLowerCase() === name.toLowerCase())) return false;
    await tx.insert(discoverySources).values({ name, kind, intervalDays, url });
    return true;
  });
  if (!created) return { ok: false, error: "This source is already on your list. Use its settings or Check now." };
  revalidatePath("/suggestions");
  return { ok: true, message: kind === "email" ? "Source added. Import an edition to get started." : "Source added. Its first check is due now." };
}

export async function updateDiscoverySource(id: string, form: FormData): Promise<DiscoveryActionResult> {
  await requireSession();
  const sourceId = zUuid().parse(id);
  const interval = z.coerce.number().int().min(1).max(90).safeParse(form.get("intervalDays"));
  if (!interval.success) return { ok: false, error: "Choose a check interval between 1 and 90 days." };
  const enabled = form.get("enabled") === "on";
  const found = await db().transaction(async tx => {
    const [source] = await tx.select().from(discoverySources).where(eq(discoverySources.id, sourceId)).for("update");
    if (!source) return "This source no longer exists. Refresh the page.";
    const name = form.has("name") ? String(form.get("name")).trim() : source.name;
    if (!name || name.length > 200) return "Enter a source name of up to 200 characters.";
    let url = source.url;
    if (source.kind !== "email" && form.has("url")) {
      try {
        const value = String(form.get("url") ?? "").trim();
        if (!value || value.length > 2048 || /^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error();
        const parsedUrl = new URL(ensureHttpUrl(value));
        if (parsedUrl.username || parsedUrl.password) throw new Error();
        if (source.kind === "linkedin" && parsedUrl.hostname !== "linkedin.com" && !parsedUrl.hostname.endsWith(".linkedin.com")) return "Use a LinkedIn URL for this source.";
        url = normalizeUrl(parsedUrl.href);
      } catch { return "Enter a valid public source URL."; }
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${url ?? `email:${name.toLowerCase()}`}))`);
    const existing = await tx.select().from(discoverySources);
    if (existing.some(row => row.id !== sourceId && (url ? row.url && normalizeUrl(row.url) === url : row.kind === "email" && row.name.toLowerCase() === name.toLowerCase()))) return "Another source already uses this URL or email newsletter name.";
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
  await requireSession();
  if (!(await getSettings()).suggestionsEnabled) return { ok: false, error: "Enable company suggestions in Settings before running a check." };
  const [source] = await db().select().from(discoverySources).where(eq(discoverySources.id, zUuid().parse(id)));
  if (!source?.enabled) return { ok: false, error: "Enable this source before running a check." };
  const queued = await enqueue("monitor_source", { sourceId: source.id });
  revalidatePath("/suggestions");
  return { ok: true, message: queued ? "Check queued. Recommendations will appear in Review when it finishes." : "This source already has a check queued or running." };
}

export async function importDiscoveryDocument(id: string, form: FormData): Promise<DiscoveryActionResult> {
  await requireSession();
  const sourceId = zUuid().parse(id);
  const title = z.string().trim().min(1).max(300).safeParse(form.get("title"));
  const raw = z.string().trim().min(100).max(40000).safeParse(form.get("content"));
  if (!title.success || !raw.success) return { ok: false, error: "Enter an edition title and 100–40,000 characters of content. Split longer editions into separate imports." };
  const content = stripHtml(raw.data);
  if (content.length < 100) return { ok: false, error: "Include at least 100 characters of readable newsletter or post text." };
  const [source] = await db().select().from(discoverySources).where(eq(discoverySources.id, sourceId));
  if (!source) return { ok: false, error: "This source no longer exists. Refresh the page." };
  const rows = await db().insert(discoveryDocuments).values({ sourceId, title: title.data, content, fingerprint: sha1(content) }).onConflictDoNothing().returning({ id: discoveryDocuments.id });
  revalidatePath("/suggestions");
  return { ok: true, message: !rows.length ? "This edition was already imported. No duplicate was created." : source.enabled ? "Edition imported. It will be reviewed at the next check, or choose Check now." : "Edition imported. Enable the source when you are ready to check it." };
}
