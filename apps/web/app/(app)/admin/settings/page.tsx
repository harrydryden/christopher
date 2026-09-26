import { runDailyScanNow, saveAiSettings, saveSchedule, saveStageRoutes } from "@/app/actions/settings";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "@/components/SettingsForm";
import { ModelSelect } from "@/components/ModelSelect";
import { inputClass, labelClass as fieldLabelClass, selectClass } from "@/components/Field";
import { requireAdmin } from "@/lib/auth";
import { getSystemSettings } from "@/lib/settings";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { MODEL_CHOICES, STAGE_EFFORTS } from "@ava/core";
import { stageRouteRows } from "@/lib/stage-routes";

export const dynamic = "force-dynamic";

const labelClass = "flex flex-col gap-1.5 text-14";
const checkboxClass = "flex items-center gap-2 text-14";

export default async function AdminSettingsPage() {
  await requireAdmin();
  const settings = await getSystemSettings();
  const routes = stageRouteRows(settings.stageRoutes);

  return (
    <div className="space-y-6">
      <PageHeader
        title="System settings"
        description="The daily run and the models apply to every account."
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
          <p className="text-12 text-muted">One key and one default model for every account; spending is capped per account in <a href="/admin" className="text-fg underline">Accounts</a>.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              <span className={fieldLabelClass}>Default model</span>
              <ModelSelect name="defaultModel" value={settings.defaultModel} className={selectClass} />
            </label>
          </div>
        </SettingsForm>
      </Card>

      <Card title="Stage routes">
        <SettingsForm action={saveStageRoutes} submitLabel="Save stage routes">
          <p className="text-12 text-muted">
            The model and effort each stage runs at, for every account. A stage left at <strong className="font-semibold text-fg">default</strong> uses the account&apos;s CV model (or the call site&apos;s model) at the stage&apos;s own effort.
          </p>
          <Table>
            <THead>
              <tr>
                <TH>Stage</TH>
                <TH>Model</TH>
                <TH>Effort</TH>
              </tr>
            </THead>
            <TBody>
              {routes.map((row) => (
                <TR key={row.id}>
                  <TD className="whitespace-nowrap">{row.label}</TD>
                  <TD>
                    <select name={`route:${row.id}:model`} defaultValue={row.model ?? ""} aria-label={`${row.label} model`} className={selectClass}>
                      <option value="">default</option>
                      {MODEL_CHOICES.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </TD>
                  <TD>
                    <select name={`route:${row.id}:effort`} defaultValue={row.effort ?? ""} aria-label={`${row.label} effort`} className={selectClass}>
                      <option value="">default</option>
                      {STAGE_EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </SettingsForm>
      </Card>
    </div>
  );
}
