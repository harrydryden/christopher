import { runDailyScanNow, saveAiSettings, saveSchedule } from "@/app/actions/settings";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { ModelSelect } from "@/components/ModelSelect";
import { inputClass, labelClass as fieldLabelClass, selectClass } from "@/components/Field";
import { requireAdmin } from "@/lib/auth";
import { getSystemSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const labelClass = "flex flex-col gap-1.5 text-14";
const checkboxClass = "flex items-center gap-2 text-14";

export default async function AdminSettingsPage() {
  await requireAdmin();
  const settings = await getSystemSettings();

  return (
    <div className="space-y-6">
      <PageHeader
        title="System settings"
        description="The daily run and the models apply to every account. Personal filters, CV preferences and each account's own monthly AI budget live elsewhere: Settings for the account, Accounts for anyone's budget."
        actions={
          <form action={runDailyScanNow}>
            <Button type="submit" variant="primary">Run daily scan now</Button>
          </form>
        }
      />

      <Card title="Schedule">
        <SettingsForm action={saveSchedule}>
          <p className="text-12 text-muted">One daily run scans every company anyone follows.</p>
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
          <label className={checkboxClass}>
            <input type="checkbox" name="respectRobotsTxt" value="1" defaultChecked={settings.respectRobotsTxt} className="h-4 w-4" />
            Respect robots.txt for HTML fetches
          </label>
        </SettingsForm>
      </Card>

      <Card title="AI">
        <SettingsForm action={saveAiSettings}>
          <p className="text-12 text-muted">One key and one default model for every account. Spending is bounded per account: each has its own monthly budget, which it can set on Settings and which you can set for anyone in <a href="/admin" className="text-fg underline">Accounts</a>. <a href="/admin/health" className="text-fg underline">Operations</a> shows what every account&apos;s spend bought.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Default model</span>
              <ModelSelect name="defaultModel" value={settings.defaultModel} className={selectClass} />
            </label>
          </div>
        </SettingsForm>
      </Card>
    </div>
  );
}
