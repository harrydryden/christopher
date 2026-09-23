"use client";
import { useState } from "react";
import { Button } from "@/components/Button";
import { scheduledWorkSentence } from "@/lib/scheduled-work";

/**
 * Administrators: run the scheduler now, and on a deployment without a worker service work through
 * the queue for up to a minute. `/api/cron` accepts a signed-in administrator only on a POST from
 * this site, which is what this sends.
 */
export function RunScheduledWork() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; sentence: string } | null>(null);
  async function run() {
    setPending(true);
    setResult(null);
    try {
      const response = await fetch("/api/cron", { method: "POST", cache: "no-store" });
      setResult(scheduledWorkSentence(response.status, await response.json().catch(() => null)));
    } catch {
      setResult({ ok: false, sentence: "Nothing ran: the server could not be reached." });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={run} disabled={pending}>{pending ? "Running…" : "Run now"}</Button>
      {result && <p role="status" className={`text-13 ${result.ok ? "text-muted" : "text-danger"}`}>{result.sentence}</p>}
    </div>
  );
}
