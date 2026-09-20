"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { refreshCompany } from "@/app/actions/companies";
import { Button } from "./Button";

/**
 * `blockedReason` is the sentence an unverified account gets instead of a refusal at submit time:
 * the action still asks `requireVerifiedUser()` for itself, this only stops the press.
 */
export function RefreshCompanyButton({ companyId, running, blockedReason }: { companyId: string; running: boolean; blockedReason?: string }) {
  const router = useRouter();
  const [, action, pending] = useActionState(async () => {
    await refreshCompany(companyId);
    router.refresh();
  }, undefined);
  return (
    <form action={action}>
      <Button type="submit" size="sm" disabled={pending || running || !!blockedReason} title={blockedReason}>
        {pending || running ? "Refreshing…" : "Refresh"}
      </Button>
    </form>
  );
}
