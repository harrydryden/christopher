/** In-process budget for opt-in, synthetic model evaluations. Never used as a billing ledger. */
export function evaluationBudget(cap) {
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('The evaluation budget must be positive and finite.');
  let spent = 0;
  let held = 0;
  const records = [];
  return {
    async reserve(_site, estimate) {
      if (!Number.isFinite(estimate) || estimate <= 0) throw new Error('Invalid AI cost estimate.');
      if (spent + held + estimate > cap) return null;
      held += estimate;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        held = Math.max(0, held - estimate);
      };
    },
    onUsage(record) {
      if (!Number.isFinite(record.costUsd) || record.costUsd < 0) throw new Error('Invalid recorded AI cost.');
      spent += record.costUsd;
      records.push(record);
    },
    snapshot() { return { capUsd: cap, spentUsd: spent, heldUsd: held, records: [...records], exceeded: spent > cap }; },
  };
}
