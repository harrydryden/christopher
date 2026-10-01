import { acceptFilterSuggestionSetting, rejectFilterSuggestionSetting, rescoreAllRolesSetting, resynthesizeNowSetting, savePinnedStatementsSetting, saveSeedProfileSetting, savePreferenceProfileSetting, acceptReasonTagSetting, suggestFromScansNowSetting } from "@/app/actions/learning";
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
import { selectClass } from "@/components/Field";
import { SearchForm, SearchPending } from "@/components/SearchForm";
import { SettingsForm } from "@/components/SettingsForm";
import { ReasonTagList } from "@/components/ReasonTagList";
import { SeedProfileEditor } from "@/components/SeedProfileEditor";
import { OpenQuestionEditors } from "@/components/OpenQuestionEditors";
import { LearningProfileEditor } from "@/components/LearningProfileEditor";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";
import { RefusalNotice } from "@/components/RefusalNotice";
import { VERIFY_SENTENCE, VerifyNotice } from "@/components/VerifyNotice";

export const dynamic = "force-dynamic";

export default async function LearningPage({ searchParams }: { searchParams: Promise<{ v?: string; error?: string }> }) {
  const user = await requireUser();
  const unverified = needsEmailConfirmation(user);
  const sp = await searchParams;
  const requestedVersion = sp.v ? Number(sp.v) : undefined;
  const now = new Date();

  const [profile, versions, calibration, suggestions, settings, tags] = await Promise.all([
    getPreferenceProfile(user.id, Number.isFinite(requestedVersion) ? requestedVersion : undefined),
    listProfileVersions(user.id),
    getCalibration(user.id),
    listPendingFilterSuggestionsResolved(user.id),
    getSettings(),
    getReasonTagEditor(user.id),
  ]);

  // On the default route the profile read can race the version list. Keep its editors mounted;
  // their submitted version still prevents an obsolete write. Only an explicit history view is read-only.
  const isLatest = !sp.v || versions.length === 0 || (profile && profile.version === versions[0]?.version);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Learning"
        actions={
          <>
            <SettingsForm action={resynthesizeNowSetting} submitLabel="Update preference profile" submitDisabled={unverified} />
            <SettingsForm action={rescoreAllRolesSetting} submitLabel="Re-score all" submitDisabled={unverified} />
          </>
        }
      />

      <RefusalNotice sentence={sp.error} className="mb-4" />
      {unverified && <VerifyNotice />}

      <Card
        title="Preference profile"
        actions={
          versions.length > 1 && (
            <SearchForm action="/learning" className="flex items-center gap-2">
              <select key={profile?.version ?? 0} name="v" defaultValue={profile?.version} className={`w-auto py-1 text-12 ${selectClass}`}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm">
                View
              </Button>
              <SearchPending />
            </SearchForm>
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
          <EmptyState title="No profile yet" description={unverified
            ? "Save your starting preferences and decisions now. Your preference profile can be updated once you confirm your email address."
            : "Your profile is built from your starting preferences and decisions. You can request an update above."} />
        )}
      </Card>

      {isLatest && <Card title="Edit preference profile">
        <LearningProfileEditor action={savePreferenceProfileSetting} name="markdown" id="profile-markdown"
          label="Your current preferences" text={profile?.markdown ?? settings.seedProfile} version={profile?.version ?? 0}
          rows={10} disabled={unverified} submitLabel="Save profile version" description="Saving creates a new version and re-scores open roles."
          required maxLength={50000} />
      </Card>}

      {isLatest && <Card title="Pinned statements">
        <p className="mb-2 text-12 text-muted">
          One per line, kept verbatim by every future synthesis.
        </p>
        <LearningProfileEditor action={savePinnedStatementsSetting} name="pinnedStatements" id="pinned-statements"
          label="Statements to keep in future updates" text={(profile?.pinnedStatements ?? []).join("\n")}
          version={profile?.version ?? 0} rows={4} disabled={unverified} submitLabel="Save" />
      </Card>}

      <Card title="Open questions">
        <OpenQuestionEditors questions={profile?.openQuestions ?? []} profileVersion={profile?.version ?? 0} isLatest={Boolean(isLatest)} disabled={unverified} />
      </Card>

      <Card title="Starting preferences">
        <p className="mb-2 text-12 text-muted">
          Your starting preferences. Profile updates do not replace these.
        </p>
        <SeedProfileEditor text={settings.seedProfile} action={saveSeedProfileSetting} />
      </Card>

      <Card title="Reason tags">
        <p className="mb-3 text-14 text-muted">Tags on your 20 most recent decisions. Your edits are kept.</p>
        {tags.vocabulary.filter(tag => !tag.accepted).map(tag => (
          <div key={tag.tag} className="mb-2 flex items-center gap-3">
            <span className="text-14">{tag.tag}{tag.description ? ` — ${tag.description}` : ""}</span>
            <SettingsForm action={acceptReasonTagSetting.bind(null, tag.tag)} submitLabel="Accept tag" />
          </div>
        ))}
        <ReasonTagList recent={tags.recent} options={tags.vocabulary.filter(tag => tag.accepted)} disabled={unverified} />
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

      <Card title="Filter suggestions" actions={
        <SettingsForm action={suggestFromScansNowSetting} submitLabel="Mine recent scans" submitDisabled={unverified} />
      }>
        <p className="mb-3 text-12 text-muted">Terms your filters turn away that would admit roles in your locations. Accepting adds the term.</p>
        {suggestions.length === 0 ? (
          <EmptyState title="No pending filter suggestions" description="Suggestions arrive after the daily run." />
        ) : (
          <div className="space-y-3">
            {suggestions.map(({ suggestion, companyName }) => (
              <div key={suggestion.id} className="border border-line-muted p-3 text-14">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone={(suggestion.value as { source?: string }).source === "scans" ? "green" : "blue"}>{suggestion.type.replace(/_/g, " ")}</Badge>
                  {(suggestion.value as { source?: string }).source === "scans" && <span className="text-12 text-muted">from recent scans</span>}
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
                  <SettingsForm action={acceptFilterSuggestionSetting.bind(null, suggestion.id)} submitLabel="Accept" submitDisabled={unverified} />
                  <SettingsForm action={rejectFilterSuggestionSetting.bind(null, suggestion.id)} submitLabel="Reject" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
