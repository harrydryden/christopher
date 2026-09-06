import { desc } from "drizzle-orm";
import { cvLibraries } from "@christopher/db";
import { db } from "@/lib/db";
import { CvLibraryEditor } from "@/components/CvLibraryEditor";
export const dynamic = "force-dynamic";
export default async function LibraryPage() {
  const [library] = await db().select().from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
  return <div className="max-w-4xl space-y-5"><h1 className="text-2xl font-semibold">Evidence library</h1><p>Your complete saved skills, experience, education and interests. All stored evidence is shown below and can be edited. Save changes before generating a CV.</p><CvLibraryEditor key={library?.version ?? 0} library={library?.content ?? null} version={library?.version ?? 0} /></div>;
}
