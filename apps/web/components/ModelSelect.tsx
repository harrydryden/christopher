import { MODEL_CHOICES, isKnownModel } from "@christopher/core";

/**
 * Model picker for the two model settings. A stored value that is not in the supported
 * list stays visible and selected rather than being silently replaced by the first
 * option — the save action rejects it, so the mismatch is shown instead of hidden.
 */
export function ModelSelect({ name, value, className }: { name: string; value: string; className?: string }) {
  const unsupported = value.length > 0 && !isKnownModel(value);
  return (
    <select name={name} defaultValue={value} className={className}>
      {unsupported && <option value={value}>{value} — not a supported model, choose one below</option>}
      {MODEL_CHOICES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select>
  );
}
