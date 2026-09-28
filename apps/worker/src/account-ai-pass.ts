import { aiBudgetRefusalMessage, aiFeatureLabel, type AppSettings } from "@ava/core";
import { createAiEngine, type AiFailure } from "@ava/ai";
import { budgetLimits, recordAiUsage, tryReserveAi, type AiHold } from "./budget";
import type { WorkerDeps } from "./context";
import { log } from "./log";

/** How long a pass may hold its share of the month: the task's deadline, with room to spare. */
const HOLD_MINUTES = 10;

/**
 * A private engine for one account's pass (a library import or review), admitted against that
 * account's month once, for the whole pass. Each call's record reduces the pass's hold in the same
 * transaction, so the budget never sees that spend twice. `signal` is the task's: a deadline or a
 * reclaimed task cuts off the calls in flight instead of paying for answers nobody reads.
 *
 * `admit` answers the sentence the person is shown when the month cannot pay, or `release`, which
 * the caller runs in a `finally` once its calls are done.
 */
export function openAccountAiPass(deps: WorkerDeps, opts: {
  userId: string; settings: AppSettings; callSite: string; model: string; refId: string; signal?: AbortSignal;
}) {
  const { userId } = opts;
  let cost = 0;
  let failure: AiFailure | undefined;
  let hold: AiHold | undefined;
  const ai = createAiEngine({
    apiKey: deps.env.anthropicApiKey,
    client: deps.aiClient,
    getModel: () => opts.model,
    getStageRoutes: async () => (await deps.settings()).stageRoutes,
    ...(opts.signal ? { signal: opts.signal } : {}),
    onUsage: async ({ failure: failed, ...usage }) => {
      cost += usage.costUsd;
      failure = failed;
      await recordAiUsage(deps.db, userId, usage, { hold });
    },
    logger: (msg, data) => log.debug(`ai ${msg}`, data),
  });
  return {
    ai,
    /** What the pass's calls have cost so far, in USD. */
    cost: () => cost,
    /** Why the last call produced nothing, as the engine classified it; the engine returns null either way. */
    failure: () => failure,
    admit: async (expectedUsd: number): Promise<{ refused: string } | { release: () => Promise<void> }> => {
      const now = deps.now();
      const admitted = await tryReserveAi(deps.db, opts.callSite, expectedUsd,
        budgetLimits(deps.env, now, { userId, settings: opts.settings }, { refId: opts.refId }), now, HOLD_MINUTES);
      if ("refused" in admitted) return { refused: aiBudgetRefusalMessage(aiFeatureLabel(opts.callSite), expectedUsd, admitted.refused) };
      hold = admitted;
      // The calls' real costs are in `ai_calls`; the hold only covered the gap until they landed.
      return { release: admitted.release };
    },
  };
}
