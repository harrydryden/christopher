import { MAX_ACCOUNT_AI_BUDGET_USD, MAX_MEMBER_AI_BUDGET_USD } from "@ava/core";
import { CvAppearance } from "@/components/CvAppearance";
import { getDefaultCvAppearance } from "@/lib/cv-appearance";
import { saveCvModel, saveCvAppearance } from "@/app/actions/cv";
import { saveAiBudget, saveKeywords, saveLocationFilter, saveMatchFields, saveSuggestionSettings, saveTableSettings } from "@/app/actions/settings";
import { rescoreAllRoles, saveSeedProfileSetting } from "@/app/actions/learning";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { ModelSelect } from "@/components/ModelSelect";
import { inputClass as fieldClass, labelClass as fieldLabelClass, selectClass } from "@/components/Field";
import { getSettings } from "@/lib/settings";
import { hasChosenGate } from "@/lib/queries/setup";
import { GATE_EXAMPLE, GATE_SENTENCE } from "@/lib/setup";
import { accountAiBudget } from "@/lib/queries/accounts";
import { formatUsd, shortDate } from "@/lib/format";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Textareas and inputs share one shape; see components/Field.tsx.
const inputClass = `resize-y ${fieldClass}`;
const labelClass = "flex flex-col gap-1.5 text-14";
const checkboxClass = "flex items-center gap-2 text-14";

export default async function SettingsPage() {
  const user = await requireUser();
  const admin = user.role === "admin";
  const [settings, appearance, budget, gateChosen] = await Promise.all([getSettings(), getDefaultCvAppearance(user.id), accountAiBudget(user.id), hasChosenGate(user.id)]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        actions={
          <form action={rescoreAllRoles}>
            <Button type="submit" variant="ghost" size="sm">Re-score all</Button>
          </form>
        }
      />

      <div id="keywords">
      <Card title="Keywords">
        {/* Filters first: an account that has never saved its gate is shown the example, not the
            word the defaults happen to carry, so nothing is ever scanned against a choice nobody made. */}
        <p className="mb-3 text-14 text-muted">{GATE_SENTENCE}</p>
        <SettingsForm action={saveKeywords}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Seniority keywords (title only)</span>
            <textarea name="seniorityKeywords" rows={2} defaultValue={(settings.gate.seniorityKeywords ?? []).join("\n")} placeholder="Head, Director, VP, Chief" className={inputClass} />
            <span className="text-12 text-muted">One per line or comma-separated. <code>strateg*</code> matches Strategy and Strategic; <code>*ops</code> matches DevOps; quote a phrase to match it exactly.</span>
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Include keywords</span>
            <textarea name="includeKeywords" rows={2} defaultValue={gateChosen ? settings.gate.includeKeywords.join("\n") : ""} placeholder={gateChosen ? 'Operations, Strateg*, "Chief of Staff"' : GATE_EXAMPLE} className={inputClass} />
            <span className="text-12 text-muted">Whole words, in the fields chosen under Match fields.</span>
          </label>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Exclude keywords</span>
            <textarea name="excludeKeywords" rows={2} defaultValue={gateChosen ? settings.gate.excludeKeywords.join("\n") : ""} className={inputClass} />
          </label>
        </SettingsForm>
      </Card>
      </div>

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

      <div id="location">
      <Card title="Location filter">
        <SettingsForm action={saveLocationFilter}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Allowed locations</span>
            <textarea name="locationTerms" rows={2} defaultValue={gateChosen ? settings.gate.locationTerms.join("\n") : ""} placeholder="London, UK" className={inputClass} />
          </label>
          <label className={checkboxClass}>
            <input type="checkbox" name="includeRemote" value="1" defaultChecked={settings.gate.includeRemote} className="h-4 w-4" />
            Include remote roles
          </label>
        </SettingsForm>
      </Card>
      </div>

      <div id="seed-profile">
      <Card title="Seed profile">
        <p className="mb-2 text-14 text-muted">The starting point for your preference profile; it is never overwritten.</p>
        <SettingsForm action={saveSeedProfileSetting}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>What you are looking for</span>
            <textarea name="seedProfile" rows={5} maxLength={5000} defaultValue={settings.seedProfile} placeholder="e.g. Operations leadership in London or remote, at a company past Series B. Nothing below £90k, nothing that needs five days in an office." className={inputClass} />
          </label>
        </SettingsForm>
      </Card>
      </div>

      <Card title="Table">
        <SettingsForm action={saveTableSettings}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Show closed roles for (days)</span>
              <input name="showClosedDays" type="number" min={0} max={365} defaultValue={settings.showClosedDays} className={fieldClass} />
            </label>
          </div>
        </SettingsForm>
      </Card>

      <Card title="Company suggestions">
        <SettingsForm action={saveSuggestionSettings}>
          <label className={checkboxClass}>
            <input type="checkbox" name="suggestionsEnabled" value="1" defaultChecked={settings.suggestionsEnabled} className="h-4 w-4" />
            Weekly company suggestions and source checks
          </label>
        </SettingsForm>
      </Card>

      <SettingsForm action={saveCvAppearance}>
        <CvAppearance key={JSON.stringify(appearance)} name="theme" value={appearance} />
      </SettingsForm>

      <p className="text-14 text-muted">Writing preferences are on the <a href="/library" className="text-fg underline">Library</a> page.</p>

      <Card title="CV model">
        <SettingsForm action={saveCvModel}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>CV model</span>
            <ModelSelect name="cvModel" value={settings.cvModel} className={selectClass} />
          </label>
        </SettingsForm>
      </Card>

      <div id="ai-budget">
      <Card title="AI budget">
        <p className="text-14">
          You have used {formatUsd(budget.spentUsd)} of your {formatUsd(budget.limitUsd)} this month; it resets on the 1st.
          {budget.countingSince && <> Counting since {shortDate(budget.countingSince)}.</>}
        </p>
        <SettingsForm action={saveAiBudget}>
          <label className={labelClass}>
            <span className={fieldLabelClass}>Monthly AI budget (USD)</span>
            <input name="aiBudgetUsd" type="number" min={0} max={admin ? MAX_ACCOUNT_AI_BUDGET_USD : Math.max(MAX_MEMBER_AI_BUDGET_USD, budget.limitUsd)} step={1} defaultValue={budget.limitUsd} className={fieldClass} />
            <span className="text-12 text-muted">Scoring, suggestions and CV builds stop once it is spent.</span>
          </label>
        </SettingsForm>
        <p className="mt-2 text-14 text-muted">
          Scoring and extraction use the shared default model <code>{settings.defaultModel}</code>.
          {admin && <> Change it in <a href="/admin/settings" className="text-fg underline">System settings</a>.</>}
        </p>
      </Card>
      </div>
    </div>
  );
}
