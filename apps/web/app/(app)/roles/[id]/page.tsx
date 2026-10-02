import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { RolesTable } from "@/components/RolesTable";
import { buildRoleCompanies, buildRoleRowVM, fetchRoleDetails } from "@/lib/queries/jobs";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SavedRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const user = await requireUser();
  const [role] = await fetchRoleDetails(user.id, [id]);
  if (!role) notFound();
  const row = buildRoleRowVM(role, new Date(), user.id);
  return <div>
    <PageHeader title={row.title} description={`${row.companyName}${row.location ? ` · ${row.location}` : ""}`} />
    <Link prefetch={false} href="/?view=user-shortlisted#roles" className="mb-5 inline-flex min-h-11 items-center text-13 underline">← Back to Roles</Link>
    <p className="mb-4 text-14 text-muted">Review the role below. If it is shortlisted, choose Build CV to answer the usual tailoring questions before generation.</p>
    <RolesTable rows={[row]} companies={buildRoleCompanies([role])} historyScope={user.id} initiallyExpandedId={id} emptyState={null} />
  </div>;
}
