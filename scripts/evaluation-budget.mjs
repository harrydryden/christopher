/**
 * In-process budget for opt-in, synthetic model evaluations. Never used as a billing ledger.
 *
 * `prior` is spend already made by an earlier run of the same subtask, counted against the cap.
 * With `hardCap`, a recorded call that takes spend past the cap throws. `onChange` is told after
 * every hold, release and recorded call, so a report on disk can follow the figures.
 *
 * @param {number} cap
 * @param {{ prior?: number, hardCap?: boolean, onChange?: () => void }} [options]
 */
export function evaluationBudget(cap, { prior = 0, hardCap = false, onChange } = {}) {
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('The evaluation budget must be positive and finite.');
  let spent = prior;
  let held = 0;
  const records = [];
  return {
    async reserve(_site, estimate) {
      if (!Number.isFinite(estimate) || estimate <= 0) throw new Error('Invalid AI cost estimate.');
      if (spent + held + estimate > cap) return null;
      held += estimate;
      onChange?.();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        held = Math.max(0, held - estimate);
        onChange?.();
      };
    },
    onUsage(record) {
      if (!Number.isFinite(record.costUsd) || record.costUsd < 0) throw new Error('Invalid recorded AI cost.');
      spent += record.costUsd;
      records.push(record);
      if (hardCap && spent > cap + 1e-9) throw new Error('Hard evaluation spend cap exceeded.');
      onChange?.();
    },
    /** The calls recorded so far, in order. */
    get calls() { return records; },
    snapshot() {
      return { capUsd: cap, spentUsd: spent, heldUsd: held, remainingUsd: Math.max(0, cap - spent - held), records: [...records], exceeded: spent > cap };
    },
  };
}
