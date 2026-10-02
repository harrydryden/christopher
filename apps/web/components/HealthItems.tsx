import Link from "next/link";
import { disableSource, pasteDiscoveryUrl, pauseCompany, rediscoverCompany } from "@/app/actions/companies";
import { confirmHealthSource, keepHealthCurrentSource, useHealthCandidate } from "@/app/actions/health";
import { Badge, type Tone } from "./Badge";
import { Button } from "./Button";
import { inputClass, labelClass } from "./Field";
import { SettingsForm } from "./SettingsForm";
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
  suspect_empty: "empty scan",
  partial: "partial scan",
  incomplete_read: "incomplete read",
  rediscovery: "proposal",
};
const KIND_TONES: Record<HealthItemKind, Tone> = {
  budget: "red",
  needs_confirmation: "amber",
  no_source: "red",
  blocked: "red",
  failing: "amber",
  suspect_empty: "amber",
  partial: "amber",
  incomplete_read: "red",
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
function HealthItemRow({ item, unverified, isAdmin }: { item: HealthItem; unverified: boolean; isAdmin: boolean }) {
  const company = item.company;
  const verifyTitle = unverified ? VERIFY_SENTENCE : undefined;
  return (
    <li className="space-y-2 border-2 border-line-muted p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONES[item.kind]}>{KIND_LABELS[item.kind]}</Badge>
        {company && (
          <Link prefetch={false} href={`/companies/${company.id}`} className="text-14 font-medium text-fg hover:underline">
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
          <Link prefetch={false} href="/settings#ai-budget" className="text-fg underline">Raise your monthly budget on Settings</Link>, or ask an administrator.
        </p>
      )}

      {item.kind === "incomplete_read" && company && (
        <Link prefetch={false} href={`/companies/${company.id}`} className="inline-flex min-h-11 items-center text-14 font-semibold underline">Open company to Rescan</Link>
      )}

      {item.candidates.length > 0 && item.runId && (
        <ul className="space-y-2">
          {item.candidates.map((candidate) => (
            <li key={candidate.index} className="flex flex-wrap items-start justify-between gap-2 border-t-2 border-line-faint pt-2">
              <CandidateLine candidate={candidate} />
              {candidate.memberBlock === "invalid" ? <p className="text-12 text-muted">This candidate is incomplete. Re-discover the company to check it again.</p>
                : isAdmin || candidate.memberBlock === null
                  ? <SettingsForm action={useHealthCandidate.bind(null, item.runId!, candidate.index)} submitLabel="Use this"
                      submitDisabled={unverified} />
                  : <p className="max-w-sm text-12 text-muted">{candidate.memberBlock === "reactivate"
                    ? "This source was switched off or blocked for everyone. Only an administrator can turn it back on."
                    : "A source already scans this company for everyone. Only an administrator can replace it."}</p>}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {item.kind === "rediscovery" && item.runId && (
          <SettingsForm action={keepHealthCurrentSource.bind(null, item.runId)} submitLabel="Keep the current source" />
        )}
        {item.kind === "needs_confirmation" && item.source && (isAdmin || item.memberCanConfirmSource) && (
          <SettingsForm action={confirmHealthSource.bind(null, item.source.id)} submitLabel="Use this source" submitDisabled={unverified} />
        )}
        {item.kind === "needs_confirmation" && item.source && !isAdmin && !item.memberCanConfirmSource && (
          <p className="text-12 text-muted">A source already scans this company for everyone. Only an administrator can replace it.</p>
        )}
        {company && (item.kind === "failing" || item.kind === "blocked" || item.kind === "no_source" || item.kind === "suspect_empty" || item.kind === "partial") && (
          <form action={rediscoverCompany.bind(null, company.id)}>
            <Button type="submit" size="sm" disabled={unverified} title={verifyTitle}>Re-discover</Button>
          </form>
        )}
        {isAdmin && item.source && (item.kind === "failing" || item.kind === "blocked") && (
          <form action={disableSource.bind(null, item.source.id)}>
            <Button type="submit" size="sm">Disable this source</Button>
          </form>
        )}
        {!isAdmin && item.source && (item.kind === "failing" || item.kind === "blocked") && (
          <p className="text-12 text-muted">Only an administrator can disable this shared source. You can pause scanning for your account or try re-discovery.</p>
        )}
        {company && item.kind !== "rediscovery" && (
          <form action={pauseCompany.bind(null, company.id)}>
            <Button type="submit" size="sm">Pause scanning</Button>
          </form>
        )}
      </div>

      {company && (item.kind === "needs_confirmation" || item.kind === "no_source" || item.kind === "suspect_empty" || item.kind === "partial") && (
        <PasteUrl companyId={company.id} unverified={unverified} />
      )}
    </li>
  );
}

/** The attention list itself: everything that needs this account, resolution included. */
export function HealthItems({ items, unverified, isAdmin }: { items: HealthItem[]; unverified: boolean; isAdmin: boolean }) {
  return (
    <div className="space-y-3">
      {unverified && <VerifyNotice />}
      <ul className="space-y-3">
        {items.map((item) => (
          <HealthItemRow key={item.key} item={item} unverified={unverified} isAdmin={isAdmin} />
        ))}
      </ul>
    </div>
  );
}
