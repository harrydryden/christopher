import Link from "next/link";
import { notFound } from "next/navigation";
import { getCareerConflictDetail, listCareerReviewIssues } from "@col/db";
import { decideCareerConflict } from "@/app/actions/career-review";
import { CareerConflictOnDemand } from "@/components/CareerConflictOnDemand";
import { CareerConflictSnapshot } from "@/components/CareerConflictSnapshot";
import { PageHeader } from "@/components/PageHeader";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
type Filter = "active" | "deferred" | "decided";
const filters: Array<[Filter, string]> = [["active", "To review"], ["deferred", "Later"], ["decided", "Decision history"]];

export default async function CareerReviewPage({ searchParams }: { searchParams: Promise<{
  status?: string; conflict?: string; cursor?: string; historyCursor?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const status = filters.some(([key]) => key === params.status) ? params.status as Filter : "active";
  const cursor = /^[0-9a-f]{64}$/.test(params.cursor ?? "") ? params.cursor : undefined;
  const chosenId = /^[0-9a-f]{64}$/.test(params.conflict ?? "") ? params.conflict : undefined;
  const parsedHistoryCursor = params.historyCursor && /^\d+$/.test(params.historyCursor) ? Number(params.historyCursor) : undefined;
  const historyCursor = parsedHistoryCursor && Number.isSafeInteger(parsedHistoryCursor) ? parsedHistoryCursor : undefined;
  const list = await listCareerReviewIssues(db(), user.id, { status, cursor });
  const selectedId = chosenId ?? list.items[0]?.id;
  const detail = selectedId ? await getCareerConflictDetail(db(), user.id, selectedId, historyCursor) : null;
  if (chosenId && !detail) notFound();
  const selected = list.items.find(item => item.id === selectedId);
  const reviewHref = (id: string) => `/library/review?status=${status}&conflict=${id}`;
  return <div className="max-w-6xl space-y-5">
    <PageHeader title="Review Experience details" description="Compare saved statements and decide how they should be used in future CVs. You can leave an issue for later." />
    <Link prefetch={false} href="/library" className="inline-flex min-h-11 items-center text-13 underline">← Back to Experience</Link>
    <nav aria-label="Experience review lists" className="flex flex-wrap gap-2 border-b border-line-muted pb-3 text-13">
      {filters.map(([key, label]) => <Link prefetch={false} key={key} href={`/library/review?status=${key}`}
        aria-current={status === key ? "page" : undefined} className={`inline-flex min-h-11 items-center px-3 ${status === key ? "border-b-2 border-fg font-semibold" : "underline"}`}>
        {label}{key === "active" && list.summary.activeCount > 0 ? ` · ${list.summary.activeCount}` : key === "deferred" && list.summary.deferredCount > 0 ? ` · ${list.summary.deferredCount}` : ""}
      </Link>)}
    </nav>
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)]">
      <section aria-label={`${filters.find(([key]) => key === status)?.[1]} issues`} className="min-w-0">
        {list.items.length ? <ul className="divide-y divide-line-faint border border-line-faint">{list.items.map(item => <li key={item.id}>
          <Link prefetch={false} href={reviewHref(item.id)} aria-current={selectedId === item.id ? "true" : undefined}
            className={`block min-h-11 px-3 py-3 text-13 no-underline hover:bg-raised ${selectedId === item.id ? "bg-raised font-semibold" : ""}`}>
            <span className="block break-words">{item.title}</span>
            <span className="text-12 text-muted">{item.statementCount} saved statements · {item.status === "deferred" ? "Review later" : item.status === "decided" ? "Decision saved" : "Needs a decision"}</span>
          </Link>
        </li>)}</ul> : <p className="text-14 text-muted">{status === "active" ? "No details need a decision. You can still review deferred or past decisions." : status === "deferred" ? "Nothing has been left for later." : "No past decisions yet."}</p>}
        {list.nextCursor && <Link prefetch={false} href={`/library/review?status=${status}&cursor=${list.nextCursor}`}
          className="mt-3 inline-flex min-h-11 items-center text-13 underline">Older issues</Link>}
      </section>
      <div className="min-w-0">{detail ? <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="text-18 font-semibold">{detail.subjectTitle || selected?.title || "Saved Experience item"}</h2>
            <p className="text-13 text-muted">The statements describe the same detail, scope and period with different values.</p></div>
          {detail.subjectId && <Link prefetch={false} href={`/library?record=${detail.subjectId}#career-record-${detail.subjectId}`}
            className="inline-flex min-h-11 items-center text-13 underline">Open this Experience item</Link>}
        </div>
        <CareerConflictOnDemand detail={detail} decide={decideCareerConflict}>
          <CareerConflictSnapshot detail={detail} />
        </CareerConflictOnDemand>
        {detail.historyNextCursor !== null && <Link prefetch={false}
          href={`/library/review?status=${status}&conflict=${detail.id}&historyCursor=${detail.historyNextCursor}`}
          className="mt-3 inline-flex min-h-11 items-center text-13 underline">Older decisions</Link>}
      </> : <p className="text-14 text-muted">Choose an issue to see the saved statements.</p>}</div>
    </div>
  </div>;
}
