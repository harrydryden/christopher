"use client";
import { useActionState } from "react";
import { refreshCompany } from "@/app/actions/companies";
import { Button } from "./Button";

/**
 * `blockedReason` is the sentence an unverified account gets instead of a refusal at submit time:
 * the action still asks `requireVerifiedUser()` for itself, this only stops the press.
 */
export function RefreshCompanyButton({ companyId, running, blockedReason }: { companyId: string; running: boolean; blockedReason?: string }) {
  // `refreshCompany` revalidates the company pages, so its own response carries the fresh page.
  const [, action, pending] = useActionState(async () => {
    await refreshCompany(companyId);
  }, undefined);
  return (
    <form action={action}>
      <Button type="submit" size="sm" disabled={pending || running || !!blockedReason} title={blockedReason}>
        {pending || running ? "Refreshing…" : "Refresh"}
      </Button>
    </form>
  );
}
