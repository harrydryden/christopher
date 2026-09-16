import { AutoRefresh } from "@/components/AutoRefresh";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { PageHeader } from "@/components/PageHeader";
import { RoleWorkspace } from "@/components/RoleWorkspace";
import type { RawSearchParams } from "@/lib/queries/jobs";
import { Suspense } from "react";
export const dynamic = "force-dynamic";

/** Streams in beside the table rather than holding it back for one more round trip. */
async function WorkNotice() {
  const work = await getCompanyWorkStatus();
  return work.active ? <AutoRefresh message="Scans, discovery or filter updates are pending. Results update as work completes." /> : null;
}

export default async function RolesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return <div>
    <Suspense><WorkNotice /></Suspense>
    <PageHeader title="Roles" />
    <RoleWorkspace searchParams={await searchParams} />
  </div>;
}
