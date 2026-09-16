import { getCvWritingPreferences } from "@/lib/cv-writing-preferences";
import { CvAppearance } from "@/components/CvAppearance";
import { getDefaultCvAppearance } from "@/lib/cv-appearance";
import { saveCvModel, saveCvAppearance, saveCvWritingPreferences } from "@/app/actions/cv";
import { runDailyScanNow, saveAiSettings, saveKeywords, saveLocationFilter, saveMatchFields, saveSchedule, saveSuggestionSettings, saveTableSettings } from "@/app/actions/settings";
import { rescoreAllRoles } from "@/app/actions/learning";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { ModelSelect } from "@/components/ModelSelect";
import { inputClass as fieldClass, labelClass as fieldLabelClass, selectClass } from "@/components/Field";
import { getSettings } from "@/lib/settings";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Textareas and inputs share one shape; see components/Field.tsx.
const inputClass = `resize-y ${fieldClass}`;
const labelClass = "flex flex-col gap-1.5 text-14";
const checkboxClass = "flex items-center gap-2 text-14";

export default async function SettingsPage() {
  const user = await requireUser();
  const admin = user.role === "admin";
  const [settings, appearance, writing] = await Promise.all([getSettings(), getDefaultCvAppearance(user.id), getCvWritingPreferences(user.id)]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Keywords, locations and CV preferences are yours. The scan schedule, models and budget are shared and set by an administrator."
        actions={
          <>
            {admin && (
              <form action={runDailyScanNow}>
                <Button type="submit" variant="primary">
                  Run daily scan now
                </Button>
              </form>
            )}
            <form action={rescoreAllRoles}>
              <Button type="submit">Re-score all</Button>
            </form>
          </>
        }
      />

      <Card title="Keywords">
        <SettingsForm action={saveKeywords}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Seniority keywords (title only)</span>
            <textarea name="seniorityKeywords" rows={2} defaultValue={(settings.gate.seniorityKeywords ?? []).join("\n")} placeholder="Head, Director, VP, Chief" className={inputClass} />
            <span className="text-12 text-muted">One per line or comma-separated. A trailing * matches the start of a word: <code>strateg*</code> matches Strategy and Strategic; <code>*ops</code> matches DevOps. Quote a phrase to match it exactly.</span>
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Include keywords</span>
            <textarea name="includeKeywords" rows={2} defaultValue={settings.gate.includeKeywords.join("\n")} placeholder={'Operations, Strateg*, "Chief of Staff"'} className={inputClass} />
            <span className="text-12 text-muted">Whole words, any field you choose below. <code>strateg*</code> also matches Strategic; Learning suggests such wildcards from recent scans.</span>
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Exclude keywords</span>
            <textarea name="excludeKeywords" rows={2} defaultValue={settings.gate.excludeKeywords.join("\n")} className={inputClass} />
          </label>
        </SettingsForm>
      </Card>

      <Card title="Match fields">
        <SettingsForm action={saveMatchFields}>
          <div className="flex flex-wrap gap-4">
            {(["title", "department", "description"] as const).map((f) => (
              <label key={f} className={checkboxClass}>
                <input type="checkbox" name="matchFields" value={f} defaultChecked={settings.gate.matchFields.includes(f)} className="h-4 w-4" />
                {f}
              </label>
            ))}
          </div>
        </SettingsForm>
      </Card>

      <Card title="Location filter">
        <SettingsForm action={saveLocationFilter}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Allowed locations</span>
            <textarea name="locationTerms" rows={2} defaultValue={settings.gate.locationTerms.join("\n")} placeholder="London, UK" className={inputClass} />
          </label>
          <label className={checkboxClass}>
            <input type="checkbox" name="includeRemote" value="1" defaultChecked={settings.gate.includeRemote} className="h-4 w-4" />
            Include remote roles
          </label>
        </SettingsForm>
      </Card>

      <Card title="Table">
        <SettingsForm action={saveTableSettings}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Hide threshold (blank = off)</span>
              <input name="hideThreshold" type="number" min={0} max={100} defaultValue={settings.hideThreshold ?? ""} className={fieldClass} />
            </label>
            <label className={labelClass}>
              <span className={fieldLabelClass}>Show closed roles for (days)</span>
              <input name="showClosedDays" type="number" min={0} max={365} defaultValue={settings.showClosedDays} className={fieldClass} />
            </label>
          </div>
        </SettingsForm>
      </Card>

      <Card title="Recommendations">
        <SettingsForm action={saveSuggestionSettings}>
          <label className={checkboxClass}>
            <input type="checkbox" name="suggestionsEnabled" value="1" defaultChecked={settings.suggestionsEnabled} className="h-4 w-4" />
            Enable weekly company suggestions and source checks for my account
          </label>
        </SettingsForm>
      </Card>

      {admin && (
        <Card title="Schedule (shared)">
          <SettingsForm action={saveSchedule}>
            <p className="text-12 text-muted">One daily run scans every company anyone follows. These settings apply to every account.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={labelClass}>
                <span className={fieldLabelClass}>Daily scan time (24h, local)</span>
                <input name="scanTime" type="text" placeholder="06:00" defaultValue={settings.scanTime} className={fieldClass} />
              </label>
              <label className={labelClass}>
                <span className={fieldLabelClass}>Timezone (IANA name)</span>
                <input name="timezone" type="text" placeholder="Europe/London" defaultValue={settings.timezone} className={fieldClass} />
              </label>
              <label className={labelClass}>
                <span className={fieldLabelClass}>Close after N missing scans</span>
                <input name="closeAfterMissingScans" type="number" min={2} max={5} defaultValue={settings.closeAfterMissingScans} className={fieldClass} />
              </label>
            </div>
            <label className={checkboxClass}>
              <input type="checkbox" name="respectRobotsTxt" value="1" defaultChecked={settings.respectRobotsTxt} className="h-4 w-4" />
              Respect robots.txt for HTML fetches
            </label>
          </SettingsForm>
        </Card>
      )}

      <SettingsForm action={saveCvAppearance}>
        <CvAppearance key={JSON.stringify(appearance)} name="theme" value={appearance} />
      </SettingsForm>

      <Card title="Writing preferences">
        <SettingsForm action={saveCvWritingPreferences} key={JSON.stringify(writing)}>
          <input type="hidden" name="previousPreferences" value={JSON.stringify(writing)} />
          <label className={labelClass}>Writing style<textarea name="stylePreferences" rows={4} maxLength={4000} defaultValue={writing.stylePreferences} className={inputClass} /></label>
          <label className={labelClass}>Saved phrasing<textarea name="preferredWording" rows={5} maxLength={12000} defaultValue={writing.preferredWording} className={inputClass} /></label>
        </SettingsForm>
      </Card>

      <Card title="CV model">
        <SettingsForm action={saveCvModel}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>CV model</span>
            <ModelSelect name="cvModel" value={settings.cvModel} className={selectClass} />
          </label>
        </SettingsForm>
      </Card>

      {admin ? (
        <Card title="AI (shared)">
          <SettingsForm action={saveAiSettings}>
            <p className="text-12 text-muted">One key, one budget, for every account. Health shows spend per account.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={labelClass}>
                <span className={fieldLabelClass}>Default model</span>
                <ModelSelect name="defaultModel" value={settings.defaultModel} className={selectClass} />
              </label>
              <label className={labelClass}>
                <span className={fieldLabelClass}>Monthly AI budget (USD)</span>
                <input name="monthlyAiBudgetUsd" type="number" min={0} step={1} defaultValue={settings.monthlyAiBudgetUsd} className={fieldClass} />
              </label>
            </div>
          </SettingsForm>
        </Card>
      ) : (
        <Card title="AI (shared)">
          <p className="text-14 text-muted">Scoring and extraction use the shared default model <code>{settings.defaultModel}</code> with a monthly budget of ${settings.monthlyAiBudgetUsd}. An administrator manages these.</p>
        </Card>
      )}
    </div>
  );
}
