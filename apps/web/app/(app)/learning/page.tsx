import { answerOpenQuestion, acceptFilterSuggestion, rejectFilterSuggestion, rescoreAllRoles, resynthesizeNow, savePinnedStatements, saveSeedProfile, savePreferenceProfile, acceptReasonTag } from "@/app/actions/learning";
import { saveDecisionTags } from "@/app/actions/decisions";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { SafeMarkdown } from "@/components/SafeMarkdown";
import { formatPercent, relativeTime } from "@/lib/format";
import { describeEvidenceItem, describeFilterSuggestion } from "@/lib/filterSuggestions";
import { getCalibration, getPreferenceProfile, listPendingFilterSuggestionsResolved, listProfileVersions, getReasonTagEditor } from "@/lib/queries/learning";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function LearningPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const sp = await searchParams;
  const requestedVersion = sp.v ? Number(sp.v) : undefined;
  const now = new Date();

  const [profile, versions, calibration, suggestions, settings, tags] = await Promise.all([
    getPreferenceProfile(Number.isFinite(requestedVersion) ? requestedVersion : undefined),
    listProfileVersions(),
    getCalibration(),
    listPendingFilterSuggestionsResolved(),
    getSettings(),
    getReasonTagEditor(),
  ]);

  const isLatest = versions.length === 0 || (profile && profile.version === versions[0]?.version);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Learning"
        actions={
          <>
            <form action={resynthesizeNow}>
              <Button type="submit" size="sm">
                Re-synthesise now
              </Button>
            </form>
            <form action={rescoreAllRoles}>
              <Button type="submit" size="sm">
                Re-score all
              </Button>
            </form>
          </>
        }
      />

      <Card
        title="Preference profile"
        actions={
          versions.length > 1 && (
            <form method="get" className="flex items-center gap-1.5">
              <select name="v" defaultValue={profile?.version} className="border border-line-muted px-1.5 py-0.5 text-12">
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm">
                View
              </Button>
            </form>
          )
        }
      >
        {profile ? (
          <div>
            <p className="mb-2 text-12 text-muted">
              Version {profile.version}
              {!isLatest && " (not the latest)"} · generated {relativeTime(profile.generatedAt, now)} from {profile.sourceDecisionCount} decisions
              {profile.model && ` · ${profile.model}`}
            </p>
            <SafeMarkdown markdown={profile.markdown} />
          </div>
        ) : (
          <EmptyState title="No profile yet" description="Once you have made a few decisions, a preference profile is synthesised automatically (or click Re-synthesise now)." />
        )}
      </Card>

      {isLatest && <Card title="Edit preference profile">
        <form action={savePreferenceProfile} className="flex flex-col gap-2">
          <input type="hidden" name="profileVersion" value={profile?.version ?? 0} />
          <label htmlFor="profile-markdown" className="text-14">Your current preferences</label>
          <textarea id="profile-markdown" name="markdown" required maxLength={50000} rows={10} defaultValue={profile?.markdown ?? settings.seedProfile}
            className="w-full border border-line-muted px-2 py-1.5 text-14" />
          <p className="text-12 text-muted">Saving creates a new version and queues scores for open roles. Previous versions remain available above.</p>
          <div><Button type="submit" variant="primary" size="sm">Save profile version</Button></div>
        </form>
      </Card>}

      {isLatest && <Card title="Pinned statements">
        <p className="mb-2 text-12 text-muted">
          One per line. These are preserved verbatim by every future synthesis, on top of your decisions.
        </p>
        <form action={savePinnedStatements} className="flex flex-col gap-2">
          <input type="hidden" name="profileVersion" value={profile?.version ?? 0} />
          <textarea
            name="pinnedStatements"
            rows={4}
            defaultValue={(profile?.pinnedStatements ?? []).join("\n")}
            className="w-full border border-line-muted px-2 py-1.5 text-14 outline-none focus:border-line"
          />
          <div>
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </div>
        </form>
      </Card>}

      <Card title="Open questions">
        {!profile || profile.openQuestions.length === 0 ? (
          <EmptyState title="No open questions" description="When the synthesiser is unsure how to generalise from your decisions, it asks here." />
        ) : (
          <div className="space-y-3">
            {profile.openQuestions.map((q) => (
              <div key={q.id} className="border border-line-muted p-3 text-14">
                <p className="mb-1.5 text-fg">{q.question}</p>
                {q.answer ? (
                  <p className="text-muted">
                    <span className="font-medium">Answered: </span>
                    {q.answer}
                  </p>
                ) : isLatest ? (
                  <form action={answerOpenQuestion.bind(null, q.id)} className="flex items-end gap-2">
                    <input type="hidden" name="profileVersion" value={profile.version} />
                    <input
                      name="answer"
                      required
                      placeholder="Your answer…"
                      className="flex-1 border border-line-muted px-2 py-1 text-14 outline-none focus:border-line"
                    />
                    <Button type="submit" size="sm">
                      Save answer
                    </Button>
                  </form>
                ) : <p className="text-12 text-muted">View the latest profile to answer this question.</p>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Seed profile">
        <p className="mb-2 text-12 text-muted">
          What you wrote at setup: seniority, sectors, locations, compensation floor, deal-breakers. Never overwritten by the model.
        </p>
        <form action={saveSeedProfile} className="flex flex-col gap-2">
          <textarea
            name="seedProfile"
            rows={4}
            defaultValue={settings.seedProfile}
            className="w-full border border-line-muted px-2 py-1.5 text-14 outline-none focus:border-line"
          />
          <div>
            <Button type="submit" variant="primary" size="sm">
              Save
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Reason tags">
        <p className="mb-3 text-14 text-muted">Review model-proposed tags and edit the tags on your 20 most recent decisions. Your edits are preserved if a tagging task finishes later.</p>
        {tags.vocabulary.filter(tag => !tag.accepted).map(tag => (
          <form key={tag.tag} action={acceptReasonTag.bind(null, tag.tag)} className="mb-2 flex items-center gap-3">
            <span className="text-14">{tag.tag}{tag.description ? ` — ${tag.description}` : ""}</span>
            <Button type="submit" size="sm">Accept tag</Button>
          </form>
        ))}
        {tags.recent.length === 0 && <EmptyState title="No decisions yet" description="Shortlist or skip a role to start recording your preferences." />}
        {tags.recent.map(decision => (
          <section key={decision.id} className="mb-2 border border-line-muted p-3">
            <h3 className="text-14">{decision.jobTitle} · {decision.companyName} · {decision.decision}</h3>
            <p className="my-2 text-14 text-muted">{decision.reason}</p>
            <form action={saveDecisionTags.bind(null, decision.id)} className="flex flex-col gap-2">
              <label htmlFor={`tags-${decision.id}`} className="text-12">Reason tags (hold Ctrl or Command to select several)</label>
              <select id={`tags-${decision.id}`} name="tags" multiple defaultValue={decision.tags}
                className="min-h-28 border border-line-muted p-2 text-14">
                {tags.vocabulary.filter(tag => tag.accepted).map(tag => <option key={tag.tag} value={tag.tag}>{tag.tag}</option>)}
              </select>
              <div><Button type="submit" size="sm">Save tags</Button></div>
            </form>
          </section>
        ))}
      </Card>

      <Card title="Calibration">
        {calibration.neededForCalibration !== null ? (
          <p className="text-14 text-muted">
            {calibration.totalDecisions} decisions so far. {calibration.neededForCalibration} more needed before calibration is shown.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="text-12 text-muted">Fit ≥ 70 → applied</p>
              <p className="text-16 font-semibold text-fg">
                {calibration.highBucket.applyRate !== null ? formatPercent(calibration.highBucket.applyRate) : "—"}
              </p>
              <p className="text-12 text-muted">n = {calibration.highBucket.n}</p>
            </div>
            <div>
              <p className="text-12 text-muted">Fit &lt; 30 → skipped</p>
              <p className="text-16 font-semibold text-fg">
                {calibration.lowBucket.skipRate !== null ? formatPercent(calibration.lowBucket.skipRate) : "—"}
              </p>
              <p className="text-12 text-muted">n = {calibration.lowBucket.n}</p>
            </div>
          </div>
        )}
      </Card>

      <Card title="Filter suggestions">
        {suggestions.length === 0 ? (
          <EmptyState title="No pending filter suggestions" description="Reviewed weekly from your decisions and near-miss outcomes." />
        ) : (
          <div className="space-y-3">
            {suggestions.map(({ suggestion, companyName }) => (
              <div key={suggestion.id} className="border border-line-muted p-3 text-14">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone="blue">{suggestion.type.replace("_", " ")}</Badge>
                  <span className="font-medium text-fg">{describeFilterSuggestion(suggestion, companyName ?? undefined)}</span>
                </div>
                {suggestion.rationale && <p className="text-muted">{suggestion.rationale}</p>}
                {suggestion.evidence.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-12 text-muted">
                    {suggestion.evidence.slice(0, 5).map((e, i) => (
                      <li key={i}>{describeEvidenceItem(e)}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex gap-1.5">
                  <form action={acceptFilterSuggestion.bind(null, suggestion.id)}>
                    <Button type="submit" variant="primary" size="sm">
                      Accept
                    </Button>
                  </form>
                  <form action={rejectFilterSuggestion.bind(null, suggestion.id)}>
                    <Button type="submit" size="sm">
                      Reject
                    </Button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
