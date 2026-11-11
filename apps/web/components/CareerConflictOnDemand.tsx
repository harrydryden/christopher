"use client";

import { lazy, Suspense, useState, type ReactNode } from "react";
import type { CareerConflictDecisionInput, CareerConflictDecisionResult, CareerConflictDetail } from "@col/core/career-record";
import { buttonClass } from "./Button";

const Editor = lazy(() => import("./CareerConflictReview").then(module => ({ default: module.CareerConflictReview })));

export function CareerConflictOnDemand({ detail, decide, children }: { detail: CareerConflictDetail;
  decide: (input: CareerConflictDecisionInput) => Promise<CareerConflictDecisionResult>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) return <div className="space-y-5">{children}
    {detail.active && <button type="button" className={buttonClass("primary", "sm")} onClick={() => setOpen(true)}>
      Decide how to use these statements</button>}
  </div>;
  return <Suspense fallback={<p role="status" className="text-13 text-muted">Opening review choices…</p>}>
    <Editor detail={detail} decide={decide} />
  </Suspense>;
}
