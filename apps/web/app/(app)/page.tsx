import { AutoRefresh } from "@/components/AutoRefresh";
import { getCompanyWorkStatus } from "@/lib/work-status";
import { PageHeader } from "@/components/PageHeader";
import { RoleWorkspace } from "@/components/RoleWorkspace";
import type { RawSearchParams } from "@/lib/queries/jobs";
export const dynamic = "force-dynamic";
export default async function RolesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const work = await getCompanyWorkStatus();
  return <div>
    {work.active && <AutoRefresh message="Scans, discovery or filter updates are pending. Results update as work completes." />}
    <PageHeader title="Roles" description="Review your matches, choose your shortlist and keep your decisions in one place." />
    <RoleWorkspace searchParams={await searchParams} />
  </div>;
}
