"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { refreshCompany } from "@/app/actions/companies";
import { Button } from "./Button";

export function RefreshCompanyButton({ companyId, running }: { companyId: string; running: boolean }) {
  const router = useRouter();
  const [, action, pending] = useActionState(async () => {
    await refreshCompany(companyId);
    router.refresh();
  }, undefined);
  return <form action={action}><Button type="submit" size="sm" disabled={pending || running}>{pending || running ? "Refreshing…" : "Refresh"}</Button></form>;
}
