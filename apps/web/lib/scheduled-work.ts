import { formatDuration } from "./format";

/** What `/api/cron` answers: the scheduler's run, or why there was none. */
interface ScheduledWorkAnswer {
  ok?: boolean;
  error?: string;
  processed?: number;
  byType?: Record<string, number>;
  durationMs?: number;
  timedOut?: boolean;
  drained?: boolean;
  standDown?: "worker";
}

/**
 * The one sentence Admin's "Run now" shows for a run it started by hand: what the scheduler did, what
 * of the queue this deployment worked through, or why nothing ran.
 */
export function scheduledWorkSentence(status: number, body: unknown): { ok: boolean; sentence: string } {
  const answer = (body && typeof body === "object" ? body : {}) as ScheduledWorkAnswer;
  if (status >= 400 || answer.ok !== true) {
    const reason = typeof answer.error === "string" && answer.error ? answer.error : `the server answered ${status}`;
    return { ok: false, sentence: `Nothing ran: ${reason}.` };
  }
  if (answer.standDown === "worker") {
    return { ok: true, sentence: "Nothing ran here: a worker reported in the last two minutes, and it runs the schedule and the queue." };
  }
  if (!answer.drained) {
    return { ok: true, sentence: "The scheduler ran: anything due is queued for the worker." };
  }
  const processed = answer.processed ?? 0;
  if (processed === 0) return { ok: true, sentence: "The scheduler ran, and nothing in the queue was waiting to run here." };
  const kinds = Object.entries(answer.byType ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([type, n]) => `${n} ${type}`).join(", ");
  const took = formatDuration(answer.durationMs ?? 0);
  return {
    ok: true,
    sentence: `The scheduler ran and worked through ${processed} ${processed === 1 ? "task" : "tasks"} in ${took} (${kinds})${answer.timedOut ? "; it stopped at the time limit, and the next run picks up the rest" : ""}.`,
  };
}
