import Link from "next/link";
import { disableSource, markSourceConfirmed, pasteDiscoveryUrl, pauseCompany, rediscoverCompany, useDiscoveryCandidate } from "@/app/actions/companies";
import { keepCurrentSource } from "@/app/actions/health";
import { Badge, type Tone } from "./Badge";
import { Button } from "./Button";
import { inputClass, labelClass } from "./Field";
import { VERIFY_SENTENCE, VerifyNotice } from "./VerifyNotice";
import { sourceWords } from "@/lib/company-timeline";
import { healthItemDetail, healthItemHeadline, type HealthCandidate, type HealthItem, type HealthItemKind } from "@/lib/queries/health";

/** What each kind is called on its badge, and the tone it earns. */
const KIND_LABELS: Record<HealthItemKind, string> = {
  budget: "budget",
  needs_confirmation: "needs confirmation",
  no_source: "no source",
  blocked: "blocked",
  failing: "failing",
  rediscovery: "proposal",
};
const KIND_TONES: Record<HealthItemKind, Tone> = {
  budget: "red",
  needs_confirmation: "amber",
  no_source: "red",
  blocked: "red",
  failing: "amber",
  rediscovery: "blue",
};

/** "a Greenhouse board (98%) · homepage link" — one candidate, in the words the company page uses. */
function CandidateLine({ candidate }: { candidate: HealthCandidate }) {
  return (
    <span className="min-w-0 text-14">
      {sourceWords(candidate.type)}
      {candidate.confidence !== null && <span className="text-12 text-muted"> {Math.round(candidate.confidence * 100)}%</span>}
      {candidate.method && <span className="text-12 text-muted"> · {candidate.method}</span>}
      {candidate.url && (
        <a href={candidate.url} target="_blank" rel="noopener noreferrer" className="block truncate text-12 text-fg no-underline hover:underline">
          {candidate.url} ↗
        </a>
      )}
    </span>
  );
}

/** The careers or board URL field, the same one the company page's setup card carries. */
function PasteUrl({ companyId, unverified }: { companyId: string; unverified: boolean }) {
  return (
    <form action={pasteDiscoveryUrl.bind(null, companyId)} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-1 flex-col gap-1.5">
        <span className={labelClass}>Careers or board URL</span>
        <input name="url" type="text" required maxLength={2048} disabled={unverified} placeholder="https://boards.greenhouse.io/acme" className={inputClass} />
      </label>
      <Button type="submit" size="sm" disabled={unverified}>Try this URL</Button>
    </form>
  );
}

/**
 * One thing that needs you, with the way out of it beside it (R-9.2).
 *
 * Every control here posts to an action that already exists, and every one of them is a state
 * change the product already had: confirm a candidate, paste a URL, re-discover, pause the
 * company, disable the source. There is no "dismiss" that only hides a row — a row goes away
 * because something about the company changed.
 */
function HealthItemRow({ item, unverified }: { item: HealthItem; unverified: boolean }) {
  const company = item.company;
  const verifyTitle = unverified ? VERIFY_SENTENCE : undefined;
  return (
    <li className="space-y-2 border-2 border-line-muted p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONES[item.kind]}>{KIND_LABELS[item.kind]}</Badge>
        {company && (
          <Link href={`/companies/${company.id}`} className="text-14 font-medium text-fg hover:underline">
            {company.name}
          </Link>
        )}
        <span className="text-14">{healthItemHeadline(item)}</span>
      </div>
      <p className="text-12 break-words text-muted">{healthItemDetail(item)}</p>
      {item.source && (
        <a href={item.source.url} target="_blank" rel="noopener noreferrer" className="block truncate text-12 text-muted no-underline hover:underline">
          {item.source.type} · {item.source.url} ↗
        </a>
      )}

      {item.kind === "budget" && (
        <p className="text-14">
          <Link href="/settings#ai-budget" className="text-fg underline">Raise your monthly budget on Settings</Link>, or ask an administrator.
        </p>
      )}

      {item.candidates.length > 0 && item.runId && (
        <ul className="space-y-2">
          {item.candidates.map((candidate) => (
            <li key={candidate.index} className="flex flex-wrap items-start justify-between gap-2 border-t-2 border-line-faint pt-2">
              <CandidateLine candidate={candidate} />
              <form action={useDiscoveryCandidate.bind(null, item.runId!, candidate.index)}>
                <Button type="submit" variant="primary" size="sm" disabled={unverified} title={verifyTitle}>Use this</Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {item.kind === "rediscovery" && item.runId && (
          <form action={keepCurrentSource.bind(null, item.runId)}>
            <Button type="submit" size="sm">Keep the current source</Button>
          </form>
        )}
        {item.kind === "needs_confirmation" && item.source && (
          <form action={markSourceConfirmed.bind(null, item.source.id)}>
            <Button type="submit" size="sm">Use this source</Button>
          </form>
        )}
        {company && (item.kind === "failing" || item.kind === "blocked" || item.kind === "no_source") && (
          <form action={rediscoverCompany.bind(null, company.id)}>
            <Button type="submit" size="sm" disabled={unverified} title={verifyTitle}>Re-discover</Button>
          </form>
        )}
        {item.source && (item.kind === "failing" || item.kind === "blocked") && (
          <form action={disableSource.bind(null, item.source.id)}>
            <Button type="submit" size="sm">Disable this source</Button>
          </form>
        )}
        {company && item.kind !== "rediscovery" && (
          <form action={pauseCompany.bind(null, company.id)}>
            <Button type="submit" size="sm">Pause scanning</Button>
          </form>
        )}
      </div>

      {company && (item.kind === "needs_confirmation" || item.kind === "no_source") && (
        <PasteUrl companyId={company.id} unverified={unverified} />
      )}
    </li>
  );
}

/** The attention list itself: everything that needs this account, resolution included. */
export function HealthItems({ items, unverified }: { items: HealthItem[]; unverified: boolean }) {
  return (
    <div className="space-y-3">
      {unverified && <VerifyNotice />}
      <ul className="space-y-3">
        {items.map((item) => (
          <HealthItemRow key={item.key} item={item} unverified={unverified} />
        ))}
      </ul>
    </div>
  );
}
