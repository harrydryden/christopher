import { PageHeader } from "@/components/PageHeader";
import Link from "next/link";
import { Card } from "@/components/Card";
import { SettingsForm } from "@/components/SettingsForm";
import { inputClass, labelClass } from "@/components/Field";
import { CareerRecordEditor } from "@/components/CareerRecordEditor";
import { LibraryImportCard } from "@/components/LibraryImportCard";
import { LibrarySecondaryTasks } from "@/components/LibrarySecondaryTasks";
import { LibraryImportPoller } from "@/components/LibraryImportPoller";
import { LibraryImportProposals } from "@/components/LibraryImportProposals";
import { saveCvWritingPreferences } from "@/app/actions/cv";
import { getCvWritingPreferences } from "@/lib/cv-writing-preferences";
import { libraryImportProgress, listLibraryImports } from "@/lib/queries/library-imports";
import { requireUser } from "@/lib/auth";
import { getCareerWorkspace } from "@/app/actions/career";

import { db } from "@/lib/db";
import { cvLibraries } from "@col/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function LibraryPage({ searchParams }: {
  searchParams: Promise<{ view?: string; need?: string; job?: string; return?: string; onboarding?: string; record?: string;
    assertion?: string; query?: string; cursor?: string; assertionsCursor?: string; linksCursor?: string; changesCursor?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const openLinkedIn = params.onboarding === "linkedin";
  const [libraryRows, career, writing, imports] = await Promise.all([
    db().select({ version: cvLibraries.version }).from(cvLibraries)
      .where(eq(cvLibraries.userId, user.id)).orderBy(desc(cvLibraries.version)).limit(1),
    getCareerWorkspace({ recordId: params.record, legacyJobId: params.job, assertionId: params.assertion, query: params.query, cursor: params.cursor,
      assertionsCursor: params.assertionsCursor, linksCursor: params.linksCursor,
      changesCursor: params.changesCursor && /^\d+$/.test(params.changesCursor) ? Number(params.changesCursor) : undefined }),
    getCvWritingPreferences(user.id),
    listLibraryImports(user.id, 10, user.role === "admin"),
  ]);
  const library = libraryRows[0] ?? null;
  // Documents still being read. The page watches for them below, and stops watching when the
  // refresh that lands the last proposal re-renders this without any.
  const reading = imports.filter(item => item.state === "reading").length;
  // The fingerprint the poller compares against, read only while there is something to watch.
  const importProgress = reading > 0 ? await libraryImportProgress(user.id) : null;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Experience" />
      <Link prefetch={false} href="/library/review" className="inline-flex min-h-11 items-center text-13 underline">Review saved details</Link>
      <LibraryImportProposals imports={imports} version={library?.version ?? 0} needsName={!library && !(user.name ?? "").trim()} />
      {importProgress && <LibraryImportPoller pending={reading} signature={importProgress.signature} />}
      <LibrarySecondaryTasks initialTask={params.view === "records" || params.record || params.job || params.assertion ? "records"
        : params.view === "writing" ? "writing" : params.view === "import" || !library || openLinkedIn ? "import" : "records"}
        records={<section id="experience-manual" aria-label="Edit Experience" className="scroll-mt-20"><CareerRecordEditor workspace={career} initialQuery={params.query ?? ""} /></section>}
        importForm={<LibraryImportCard showTitle={!library} openLinkedIn={openLinkedIn} />}
        writingForm={<Card>
          <SettingsForm action={saveCvWritingPreferences} key={JSON.stringify(writing)}
            submitLabel="Save writing preferences" successMessage="Writing preferences saved."
            secondaryActions={<span className="text-12 text-muted">{library ? `Experience version ${library.version}` : "No Experience saved yet"}</span>}>
            <input type="hidden" name="previousPreferences" value={JSON.stringify(writing)} />
            <label className={labelClass}>Writing style<textarea name="stylePreferences" rows={4} maxLength={4000} defaultValue={writing.stylePreferences} className={inputClass} /></label>
            <label className={labelClass}>Saved phrasing<textarea name="preferredWording" rows={5} maxLength={12000} defaultValue={writing.preferredWording} className={inputClass} /></label>
          </SettingsForm>
        </Card>} />
      <Link prefetch={false} href="/library/about" className="inline-flex min-h-11 items-center text-14 underline">
        About you and contact
      </Link>
    </div>
  );
}
