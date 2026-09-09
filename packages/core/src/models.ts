/**
 * Models the interface offers, newest release of each family.
 *
 * This list is the allowed set for `defaultModel` and `cvModel`: both are validated
 * against it on save, so an unrecognised ID cannot be stored and then fail later at
 * call time. Pricing (`packages/ai/src/pricing.ts`) deliberately keeps a wider map,
 * including superseded models, so historical `ai_calls` rows still cost out correctly.
 *
 * When a newer release lands, replace the ID in its family rather than adding a row:
 * the point of this list is that it only ever offers current models.
 */
export interface ModelChoice {
  id: string;
  /** Family name plus the trade-off that decides between them. */
  label: string;
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1 — most capable, highest cost" },
  { id: "claude-opus-5", label: "Opus 5 — strong reasoning, mid cost" },
  { id: "claude-sonnet-5", label: "Sonnet 5 — balanced, good for bulk scanning" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest and cheapest" },
];

export const MODEL_IDS: readonly string[] = MODEL_CHOICES.map(m => m.id);

export function isKnownModel(id: string): boolean {
  return MODEL_IDS.includes(id);
}

/** Human-readable label for a stored ID, falling back to the raw ID for superseded models. */
export function modelLabel(id: string): string {
  return MODEL_CHOICES.find(m => m.id === id)?.label ?? id;
}
