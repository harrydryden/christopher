"use client";
import { useSyncExternalStore } from "react";
import { dismissRoleRefusal, roleRefusals, serverRoleRefusals, subscribeRoleRefusals } from "@/lib/role-refusals";

/**
 * The sentences of decisions the server refused after the table that sent them had been replaced
 * (the person paged, filtered or changed tab while it was saved). Rendered by the workspace outside
 * the keyed table, so it survives the remount; styled as the table's own error line.
 */
export function RoleRefusalNotices() {
  const refusals = useSyncExternalStore(subscribeRoleRefusals, roleRefusals, serverRoleRefusals);
  if (refusals.length === 0) return null;
  return (
    <div role="alert" className="mb-2 space-y-2">
      {refusals.map(refusal => (
        <p key={refusal.id} className="flex flex-wrap items-center gap-3 border-2 border-danger px-3 py-1.5 text-14 text-danger">
          <span>{refusal.text}</span>
          <button type="button" onClick={() => dismissRoleRefusal(refusal.id)} className="text-13 font-semibold underline">Dismiss</button>
        </p>
      ))}
    </div>
  );
}
