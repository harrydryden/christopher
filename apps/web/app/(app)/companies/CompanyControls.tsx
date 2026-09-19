/**
 * Pause, Archive and Stop following used to sit side by side as three buttons that differed only
 * in their confirm text, on two pages. They are one control now: a collapsed menu that says in
 * plain words what each does and what it leaves behind, with the confirm texts unchanged.
 *
 * The subscription is this account's; the shared company, its sources and every observed posting
 * are untouched by all three.
 */
import { archiveCompany, pauseCompany, resumeCompany, unfollowCompany } from "@/app/actions/companies";
import { Button } from "@/components/Button";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import type { CompanySubscription } from "@christopher/db/schema";

export function CompanyControls({
  companyId,
  companyName,
  status,
}: {
  companyId: string;
  companyName: string;
  status: CompanySubscription["status"];
}) {
  return (
    <details className="border-2 border-line-muted bg-raised">
      <summary className="ds-pixel cursor-pointer px-2.5 py-1 text-10 text-fg">Manage</summary>
      <div className="space-y-2 border-t-2 border-line-muted p-2">
        <div className="flex flex-wrap gap-2">
          {status === "active" ? (
            <form action={pauseCompany.bind(null, companyId)}>
              <Button type="submit" size="sm">Pause scanning</Button>
            </form>
          ) : (
            <form action={resumeCompany.bind(null, companyId)}>
              <Button type="submit" size="sm">{status === "paused" ? "Resume scanning" : "Follow again"}</Button>
            </form>
          )}
          {status !== "archived" && (
            <form action={archiveCompany.bind(null, companyId)}>
              <ConfirmSubmitButton variant="ghost" confirmMessage={`Archive ${companyName}? It leaves your inbox; other followers are unaffected.`}>
                Hide from my list
              </ConfirmSubmitButton>
            </form>
          )}
          <form action={unfollowCompany.bind(null, companyId)}>
            <ConfirmSubmitButton variant="ghost" confirmMessage={`Stop following ${companyName}? Its roles leave your table. Your decision snapshots are retained.`}>
              Stop following
            </ConfirmSubmitButton>
          </form>
        </div>
        <p className="text-12 text-muted">
          Pausing keeps this company and its roles and stops the daily scan; hiding takes it off your list and keeps
          everything; stopping following removes its roles from your table. Other followers are unaffected.
        </p>
      </div>
    </details>
  );
}
