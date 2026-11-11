"use server";

import { z } from "zod";
import { CvLibrarySchema } from "@col/core/cv";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeCvLibraryVersion } from "@/lib/cv-library-write";
import { revalidate } from "@/lib/action-helpers";
import { actionError } from "@/lib/action-result";

const AboutInput = z.object({
  name: z.string().max(120),
  email: z.string().max(254),
  phone: z.string().max(40),
  location: z.string().max(120),
  linkedinUrl: z.string().max(300),
  websiteUrl: z.string().max(500),
  contact: z.string().max(500),
  profile: z.string().max(5000),
}).strict();

export type CvAboutValues = z.infer<typeof AboutInput>;
export type CvAboutResult = { ok: true; version: number } | { ok: false; error: string };
const refused = (error: string): CvAboutResult => ({ ok: false, error });

/** Merge only contact and profile fields under the Library's version lock. */
export async function saveCvAbout(expectedVersion: number, raw: CvAboutValues): Promise<CvAboutResult> {
  const user = await requireUser();
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return refused("Reload this page before saving.");
  const input = AboutInput.safeParse(raw);
  if (!input.success) return refused("Check the contact details and try again.");
  try {
    const version = await db().transaction(tx => writeCvLibraryVersion(tx, user.id, expectedVersion, current => {
      const merged = { ...(current ?? { entries: [] }), ...input.data };
      const parsed = CvLibrarySchema.safeParse(merged);
      if (!parsed.success) {
        const issue = parsed.error.issues.find(item => ["name", "email", "phone", "location", "linkedinUrl", "websiteUrl", "contact", "profile"].includes(String(item.path[0])));
        throw new Error(`ABOUT_VALIDATION:${issue?.message ?? "Check the contact details and try again."}`);
      }
      return parsed.data;
    }, { review: false }));
    revalidate("/library", "/library/about", "/cv");
    return { ok: true, version };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ABOUT_VALIDATION:"))
      return refused(error.message.slice("ABOUT_VALIDATION:".length));
    const result = actionError(error, "Could not save your contact details. Your entries are still here.", "cv_about_save_failed");
    return refused(result.ok ? "Could not save your contact details. Your entries are still here." : result.error);
  }
}
