import { PageHeader } from "@/components/PageHeader";
import { desc, eq } from "drizzle-orm";
import { cvLibraries } from "@christopher/db";
import { db } from "@/lib/db";
import { CvLibraryEditor } from "@/components/CvLibraryEditor";
import { requireUser } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function LibraryPage() {
  const user = await requireUser();
  const [library] = await db().select().from(cvLibraries).where(eq(cvLibraries.userId, user.id)).orderBy(desc(cvLibraries.version)).limit(1);
  // The editor is not keyed on the version: a save revalidates this page, and rebuilding the
  // editor from the server would throw away its unsaved-changes state and the version it is
  // writing over. It takes the stored version as a prop and adopts a newer one only when there is
  // nothing on the screen to lose.
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Library"
        description="The evidence every CV is written from. A block is used only once it is Active and its rows are confirmed."
      />
      <CvLibraryEditor library={library?.content ?? null} version={library?.version ?? 0} />
    </div>
  );
}
