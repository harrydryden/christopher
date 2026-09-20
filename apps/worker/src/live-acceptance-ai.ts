import { PRICING, type AiUsageRecord } from "@christopher/ai";

export interface LiveAcceptanceAiBudgetSnapshot {
  capUsd: number;
  spentUsd: number;
  heldUsd: number;
  conservativeFactor: number;
  refusedReservations: number;
  uncertainHeldUsd: number;
}

/**
 * A process-local admission gate for the opt-in live acceptance run.
 *
 * The engine estimate already reserves its maximum output and estimates input at one token per
 * three UTF-8 bytes. This gate prices input at one token per byte and allows for the most expensive
 * configured model being served instead, so admitted calls have a deliberately larger hold than
 * the engine's estimate. Runs are serial when AI is enabled, and actual billed usage is charged
 * before the next call can reserve capacity.
 */
export function createLiveAcceptanceAiBudget(model: string, capUsd: number) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("--ai-max-usd must be positive and finite");
  const selected = PRICING[model];
  if (!selected) throw new Error(`No checked pricing is configured for live acceptance model ${model}`);
  const highestInput = Math.max(...Object.values(PRICING).map(price => price.input));
  const highestOutput = Math.max(...Object.values(PRICING).map(price => price.output));
  const conservativeFactor = Math.max(3 * highestInput / selected.input, highestOutput / selected.output);
  let spentUsd = 0;
  let heldUsd = 0;
  let refusedReservations = 0;
  let uncertainHeldUsd = 0;
  let active: { holdUsd: number; uncertain: boolean } | null = null;

  return {
    async reserve(_callSite: string, estimateUsd: number) {
      if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) throw new Error("AI engine supplied an invalid cost estimate");
      if (active) throw new Error("Live acceptance AI calls must run serially");
      const holdUsd = estimateUsd * conservativeFactor;
      if (spentUsd + heldUsd + holdUsd > capUsd) {
        refusedReservations++;
        return null;
      }
      heldUsd += holdUsd;
      active = { holdUsd, uncertain: false };
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (active?.holdUsd === holdUsd && active.uncertain) {
          uncertainHeldUsd += holdUsd;
        } else {
          heldUsd = Math.max(0, heldUsd - holdUsd);
        }
        active = null;
      };
    },
    onUsage(record: AiUsageRecord) {
      if (!Number.isFinite(record.costUsd) || record.costUsd < 0) throw new Error("AI engine reported invalid usage cost");
      spentUsd += record.costUsd;
      // A failed provider call with no usage snapshot may still be billable. Retain its full
      // conservative hold for the rest of the run instead of treating missing usage as zero.
      if (!record.ok && record.costUsd === 0 && record.inputTokens === 0 && record.outputTokens === 0 && active) active.uncertain = true;
    },
    snapshot(): LiveAcceptanceAiBudgetSnapshot {
      return { capUsd, spentUsd, heldUsd, conservativeFactor, refusedReservations, uncertainHeldUsd };
    },
  };
}
