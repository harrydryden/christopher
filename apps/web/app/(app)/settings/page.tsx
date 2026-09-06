import { runDailyScanNow, saveAiSettings, saveKeywords, saveLocationFilter, saveMatchFields, saveSchedule, saveTableSettings } from "@/app/actions/settings";
import { rescoreAllRoles } from "@/app/actions/learning";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const inputClass =
  "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950";
const helpClass = "text-xs text-slate-500 dark:text-slate-400";
const labelClass = "flex flex-col gap-1 text-sm";
const fieldLabelClass = "text-xs font-medium text-slate-500";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Everything here is editable without a redeploy."
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
          <p className={helpClass}>Roles must match a role keyword AND a seniority keyword. Each list uses OR. Leave seniority blank to allow all levels. Exclusions win. Use strateg* to match strategy and strategic. Saving immediately refilters existing roles.</p>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Include keywords</span>
            <textarea name="includeKeywords" rows={2} defaultValue={settings.gate.includeKeywords.join("\n")} className={inputClass} />
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Exclude keywords</span>
            <textarea name="excludeKeywords" rows={2} defaultValue={settings.gate.excludeKeywords.join("\n")} className={inputClass} />
          </label>
          <p className={helpClass}>
            One term per line (or comma-separated). Matching is whole-word and case-insensitive. Use a trailing <code>*</code> for a prefix match
            (<code>operat*</code> matches &quot;operations&quot; and &quot;operating&quot;), or wrap a phrase in quotes for an exact match (
            <code>&quot;chief of staff&quot;</code>). Any exclude match wins over an include match.
          </p>
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
          <p className={helpClass}>Which fields the keyword filter reads. Description matching needs a detail fetch per posting on HTML sources.</p>
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
          <p className={helpClass}>
            One term per line. &quot;UK&quot; expands to England, Scotland, Wales, London and other UK cities; country names expand similarly. Leave blank to
            allow every location. Remote roles pass unless they name another region you have not listed.
          </p>
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
            <label className={labelClass}>
              <span className={fieldLabelClass}>Near-miss daily cap</span>
              <input name="nearMissDailyCap" type="number" min={0} max={100} defaultValue={settings.nearMissDailyCap} className={inputClass} />
            </label>
            <label className={labelClass}>
              <span className={fieldLabelClass}>Near-miss minimum score</span>
              <input name="nearMissMinScore" type="number" min={0} max={100} defaultValue={settings.nearMissMinScore} className={inputClass} />
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="nearMissEnabled" value="1" defaultChecked={settings.nearMissEnabled} />
            Show &quot;Outside your keywords&quot; section
          </label>
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

      <Card title="AI">
        <SettingsForm action={saveAiSettings}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Default model</span>
              <input name="defaultModel" type="text" defaultValue={settings.defaultModel} className={inputClass} />
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
          <p className={helpClass}>Non-essential AI calls (near-miss scoring, then suggestions) are skipped once the monthly budget is exceeded.</p>
        </SettingsForm>
      </Card>

      <Card title="Account">
        <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
          Christopher has a single application password, checked against <code>APP_PASSWORD_HASH</code>. This app cannot change environment variables
          itself — to set a new password, generate a fresh hash and update it on your host:
        </p>
        <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">pnpm --filter @christopher/web hash-password &apos;your new password&apos;</pre>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Set the result as <code>APP_PASSWORD_HASH</code> and redeploy. <code>SESSION_SECRET</code> can be any long random string; changing it signs
          everyone out.
        </p>
      </Card>
    </div>
  );
}
