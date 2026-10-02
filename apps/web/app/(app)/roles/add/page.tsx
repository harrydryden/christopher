import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { RoleImportStartForm } from "@/components/RoleImportStartForm";
import { Card } from "@/components/Card";
import { requireUser } from "@/lib/auth";
import { listRecentRoleImports } from "@/lib/queries/role-imports";

export const dynamic = "force-dynamic";

export default async function AddRolePage() {
  const user = await requireUser();
  const recent = (await listRecentRoleImports(user.id)).filter(row => row.status !== "saved");
  return <div className="max-w-3xl">
    <PageHeader title="Add a role" description="Add a job link or PDF, then build a CV." />
    <Link prefetch={false} href="/" className="mb-5 inline-flex min-h-11 items-center text-13 underline">← Back to Roles</Link>
    <Card title="Role details"><RoleImportStartForm /></Card>
    {recent.length > 0 && <section className="mt-6" aria-labelledby="recent-imports-heading">
      <h2 id="recent-imports-heading" className="ds-label mb-2">Continue an earlier import</h2>
      <ul className="space-y-2">{recent.map(row => <li key={row.id}>
        <Link prefetch={false} href={`/roles/add/${row.id}`} className="inline-flex min-h-11 items-center underline">
          {row.title || row.filename || row.url || "Untitled role"} · {row.status === "failed" ? "Needs attention" : row.status === "ready" ? "Ready to review" : "Processing"}
        </Link>
      </li>)}</ul>
    </section>}
  </div>;
}
