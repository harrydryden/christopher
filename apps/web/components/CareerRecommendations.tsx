import Link from "next/link";
import { careerRecommendations } from "@/lib/queries/career-recommendations";
import { FollowCompanyButton } from "./FollowCompanyButton";
import { CatalogueRoleActions } from "./CatalogueRoleActions";

/** Server-rendered explanations; the browser receives only the IDs needed by each small action. */
export async function CareerRecommendations({ userId, followBlocked }: { userId: string; followBlocked: string | null }) {
  const result = await careerRecommendations(userId);
  if (result.state === "disabled") return null;
  return <section aria-label="Matches from your Experience" className="mb-6 border border-line-muted p-4">
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-semibold">Matches from your Experience</h2>
      <span className="flex gap-4 text-12"><Link prefetch={false} href="/library" className="underline">Edit Experience</Link><Link prefetch={false} href="/settings" className="underline">Preferences</Link></span>
    </div>
    {result.state === "unavailable" ? <p role="status" className="text-14 text-muted">Matches could not load. You can still search the catalogue below.</p>
      : result.state === "empty_experience" ? <p className="text-14 text-muted">Add roles or skills to <Link prefetch={false} href="/library" className="underline">Experience</Link> to find relevant openings across the catalogue.</p>
      : !result.companies.length ? <p className="text-14 text-muted">No recommendations right now. Adjust your preferences or search companies below.</p>
      : <ul className="divide-y divide-line-faint">{result.companies.map(company => <li key={company.companyId} className="py-3 first:pt-0 last:pb-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">{company.name} <span className="font-normal text-12 text-muted">{company.domain}</span></span>
          {company.following ? <Link prefetch={false} href={`/companies/${company.companyId}`} className="text-12 underline">Following</Link>
            : <FollowCompanyButton companyId={company.companyId} companyName={company.name} disabled={!!followBlocked}/>}
        </div>
        <ul className="space-y-3">{company.roles.map(({ role, match }) => <li key={role.id} className="grid gap-1 border-l-2 border-line-faint pl-3">
          <span className="font-medium">{role.url && /^https?:\/\//i.test(role.url) ? <a href={role.url} target="_blank" rel="noopener noreferrer" className="underline">{role.title} ↗</a> : role.title}</span>
          <span className="text-12 text-muted">{(role.location ?? role.locations?.join("; ")) || "Location not listed"} · Last seen {role.lastSeenAt.toLocaleDateString("en-GB", { timeZone: "UTC" })}</span>
          <span className="text-12">Relevant experience: {match.reasons.map(reason => reason.label).join(", ")}</span>
          <CatalogueRoleActions jobId={role.id} title={role.title}/>
        </li>)}</ul>
      </li>)}</ul>}
    {followBlocked && result.companies.some(company => !company.following) && <p className="mt-3 text-12 text-muted">{followBlocked}</p>}
  </section>;
}
