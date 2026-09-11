import { PageHeader } from "@/components/PageHeader";
import { desc } from "drizzle-orm";
import { cvLibraries } from "@christopher/db";
import { db } from "@/lib/db";
import { CvLibraryEditor } from "@/components/CvLibraryEditor";
export const dynamic = "force-dynamic";
export default async function LibraryPage() {
  const [library] = await db().select().from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
  return <div className="max-w-6xl space-y-5"><PageHeader title="Evidence library" description="Your skills, experience, education and CV preferences. Save changes before generating a CV." /><CvLibraryEditor key={library?.version ?? 0} library={library?.content ?? null} version={library?.version ?? 0} /></div>;
}
