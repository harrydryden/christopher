import { getCvWritingPreferences } from "@/lib/cv-writing-preferences";
import { CvAppearance } from "@/components/CvAppearance";
import { getDefaultCvAppearance } from "@/lib/cv-appearance";
import { saveCvModel, saveCvAppearance, saveCvWritingPreferences } from "@/app/actions/cv";
import { runDailyScanNow, saveAiSettings, saveKeywords, saveLocationFilter, saveMatchFields, saveSchedule, saveTableSettings } from "@/app/actions/settings";
import { rescoreAllRoles } from "@/app/actions/learning";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { ModelSelect } from "@/components/ModelSelect";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const inputClass =
  "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent";
const labelClass = "flex flex-col gap-1 text-sm";
const fieldLabelClass = "text-xs font-medium text-slate-500";

export default async function SettingsPage() {
  const [settings, appearance, writing] = await Promise.all([getSettings(), getDefaultCvAppearance(), getCvWritingPreferences()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        actions={
          <>
            <form action={runDailyScanNow}>
              <Button type="submit" variant="primary">
                Run daily scan now
              </Button>
            </form>
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
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Include keywords</span>
            <textarea name="includeKeywords" rows={2} defaultValue={settings.gate.includeKeywords.join("\n")} className={inputClass} />
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Exclude keywords</span>
            <textarea name="excludeKeywords" rows={2} defaultValue={settings.gate.excludeKeywords.join("\n")} className={inputClass} />
          </label>
        </SettingsForm>
      </Card>

      <Card title="Match fields">
        <SettingsForm action={saveMatchFields}>
          <div className="flex gap-4 text-sm">
            {(["title", "department", "description"] as const).map((f) => (
              <label key={f} className="flex items-center gap-1.5">
                <input type="checkbox" name="matchFields" value={f} defaultChecked={settings.gate.matchFields.includes(f)} />
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
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="includeRemote" value="1" defaultChecked={settings.gate.includeRemote} />
            Include remote roles
          </label>
        </SettingsForm>
      </Card>

      <Card title="Table">
        <SettingsForm action={saveTableSettings}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Hide threshold (blank = off)</span>
              <input name="hideThreshold" type="number" min={0} max={100} defaultValue={settings.hideThreshold ?? ""} className={inputClass} />
            </label>
            <label className={labelClass}>
              <span className={fieldLabelClass}>Show closed roles for (days)</span>
              <input name="showClosedDays" type="number" min={0} max={365} defaultValue={settings.showClosedDays} className={inputClass} />
            </label>
          </div>
        </SettingsForm>
      </Card>

      <Card title="Schedule">
        <SettingsForm action={saveSchedule}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Daily scan time (24h, local)</span>
              <input name="scanTime" type="text" placeholder="06:00" defaultValue={settings.scanTime} className={inputClass} />
            </label>
            <label className={labelClass}>
              <span className={fieldLabelClass}>Timezone (IANA name)</span>
              <input name="timezone" type="text" placeholder="Europe/London" defaultValue={settings.timezone} className={inputClass} />
            </label>
            <label className={labelClass}>
              <span className={fieldLabelClass}>Close after N missing scans</span>
              <input name="closeAfterMissingScans" type="number" min={2} max={5} defaultValue={settings.closeAfterMissingScans} className={inputClass} />
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="respectRobotsTxt" value="1" defaultChecked={settings.respectRobotsTxt} />
            Respect robots.txt for HTML fetches
          </label>
        </SettingsForm>
      </Card>

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
            <ModelSelect name="cvModel" value={settings.cvModel} className={inputClass} />
          </label>
        </SettingsForm>
      </Card>

      <Card title="AI">
        <SettingsForm action={saveAiSettings}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Default model</span>
              <ModelSelect name="defaultModel" value={settings.defaultModel} className={inputClass} />
            </label>
            <label className={labelClass}>
              <span className={fieldLabelClass}>Monthly AI budget (USD)</span>
              <input name="monthlyAiBudgetUsd" type="number" min={0} step={1} defaultValue={settings.monthlyAiBudgetUsd} className={inputClass} />
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="suggestionsEnabled" value="1" defaultChecked={settings.suggestionsEnabled} />
            Enable weekly company suggestions
          </label>
        </SettingsForm>
      </Card>
    </div>
  );
}
