"use client";

import { useEffect, useState, useTransition } from "react";
import { retryFailedScore } from "@/app/actions/scores";
import { Button } from "@/components/Button";

/** A failed automatic update can be retried without disturbing the person's own review. */
export function RetryScore({ jobId, scoreState }: { jobId: string; scoreState: "failed" | "requested" | "queued" }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const requested = message?.error === false;
  const waiting = scoreState !== "failed" || requested;
  useEffect(() => {
    if (scoreState === "failed") setMessage(null);
  }, [scoreState]);
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    <Button size="sm" variant="secondary" disabled={pending || waiting} onClick={() => {
      setMessage(null);
      startTransition(async () => {
        try {
          const result = await retryFailedScore(jobId);
          setMessage(result.ok
            ? { text: "Score retry requested. You can keep reviewing this role.", error: false }
            : { text: result.error, error: true });
        } catch {
          setMessage({ text: "Could not request a score retry. Please try again.", error: true });
        }
      });
    }}>{pending ? "Requesting…" : waiting ? "Score requested" : "Retry score"}</Button>
    {(message || scoreState !== "failed") && <p role={message?.error ? "alert" : "status"} className={`text-12 ${message?.error ? "text-danger" : "text-muted"}`}>{message?.text ?? "Score pending. You can keep reviewing this role."}</p>}
  </div>;
}
