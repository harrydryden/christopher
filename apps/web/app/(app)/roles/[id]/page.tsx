import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { RolesTable } from "@/components/RolesTable";
import { buildRoleCompanies, buildRoleRowVM, fetchRoleDetails } from "@/lib/queries/jobs";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SavedRolePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ decision?: string }>;
}) {
  const { id } = await params;
  const { decision } = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const user = await requireUser();
  const [role] = await fetchRoleDetails(user.id, [id]);
  if (!role) notFound();
  const row = buildRoleRowVM(role, new Date(), user.id);
  return <div>
    <PageHeader title={row.title} description={`${row.companyName}${row.location ? ` · ${row.location}` : ""}`} />
    <Link prefetch={false} href="/?view=user-shortlisted#roles" className="mb-5 inline-flex min-h-11 items-center text-13 underline">← Back to Roles</Link>
    {row.locations.length > 3 && <section id="locations" className="mb-4 scroll-mt-4">
      <h2 className="mb-2 text-14 font-semibold">Locations</h2>
      <ul className="grid gap-x-4 gap-y-1 text-13 sm:grid-cols-3">{row.locations.map((location, index) => <li key={`${location}-${index}`}>{location}</li>)}</ul>
    </section>}
    <RolesTable rows={[row]} companies={buildRoleCompanies([role])} historyScope={user.id}
      initiallyExpandedId={id} initialDecision={decision === "apply" || decision === "skip" ? decision : null} emptyState={null} />
  </div>;
}
