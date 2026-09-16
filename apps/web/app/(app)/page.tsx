import { AutoRefresh } from "@/components/AutoRefresh";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { PageHeader } from "@/components/PageHeader";
import { RoleWorkspace } from "@/components/RoleWorkspace";
import { requireUser } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/queries/jobs";
import { Suspense } from "react";
export const dynamic = "force-dynamic";

/** Streams in beside the table rather than holding it back for one more round trip. */
async function WorkNotice({ userId }: { userId: string }) {
  const work = await getCompanyWorkStatus(userId);
  return work.active ? <AutoRefresh message="Scans, discovery or filter updates are pending. Results update as work completes." /> : null;
}

export default async function RolesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const user = await requireUser();
  return <div>
    <Suspense><WorkNotice userId={user.id} /></Suspense>
    <PageHeader title="Roles" />
    <RoleWorkspace userId={user.id} searchParams={await searchParams} />
  </div>;
}
