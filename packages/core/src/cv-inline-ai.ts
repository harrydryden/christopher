import { z } from "zod";
import type { CvContent } from "./cv";
import type { CvEditingTargets } from "./cv-editing-modes";
import { CV_LIMITS } from "./cv-format";
import type { StageRoutes } from "./settings";

export const CV_INLINE_TEXT_LIMIT = 4_000;
export const CV_INLINE_CONTEXT_LIMIT = 12_000;
export const CvInlineActionSchema = z.enum(["inline_correction", "inline_refine", "inline_tailor"]);
export type CvInlineAction = z.infer<typeof CvInlineActionSchema>;
export const CvInlineTargetSchema = z.object({
  type: z.enum(["summary", "section", "bullet", "skill"]), id: z.string().uuid(),
  field: z.enum(["text", "signpost"]).default("text"),
}).strict();
export type CvInlineTarget = z.infer<typeof CvInlineTargetSchema>;
export const CvInlineRequestSchema = z.object({
  contextId: z.string().uuid(), requestKey: z.string().uuid(),
  source: z.object({ kind: z.enum(["baseline", "draft"]), id: z.string().uuid(),
    revision: z.number().int().min(1).optional() }).strict(),
  target: CvInlineTargetSchema,
  text: z.string().min(1).max(40_000),
  selectionStart: z.number().int().min(0).optional(), selectionEnd: z.number().int().min(0).optional(),
  action: CvInlineActionSchema, acceptRoleCredit: z.boolean().default(false),
  priceVersion: z.number().int().positive().default(1),
}).strict().superRefine((value, ctx) => {
  if (value.source.kind === "draft" && value.source.revision === undefined)
    ctx.addIssue({ code: "custom", message: "Reload this CV before asking for a change." });
  try { cvInlineSelection(value.text, value.selectionStart, value.selectionEnd); }
  catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); }
  if (value.target.field === "signpost" && value.target.type !== "bullet")
    ctx.addIssue({ code: "custom", message: "Only a bullet has a bullet title." });
});
export type CvInlineRequest = z.infer<typeof CvInlineRequestSchema>;
export type CvInlineSource = CvInlineRequest["source"];

/** Offsets use the browser's UTF-16 selection API. Never split a surrogate pair. */
export function cvInlineSelection(text: string, start = 0, end = start): { start: number; end: number; selected: string } {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length)
    throw new Error("Select the words to change again.");
  if (start === end) { start = 0; end = text.length; }
  const split = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
  if (split(start) || split(end)) throw new Error("Select complete characters to change.");
  const selected = text.slice(start, end);
  if (!selected.trim()) throw new Error("Select some wording to change.");
  if (selected.length > CV_INLINE_TEXT_LIMIT) throw new Error("Select up to 4,000 characters for an AI edit.");
  return { start, end, selected };
}

export function cvInlineTargetText(content: CvContent, targets: CvEditingTargets, target: CvInlineTarget): {
  text: string; maxLength: number; sourceIds: string[]; entryId?: string;
} | null {
  if (target.type === "summary" && target.id === targets.summaryId && target.field === "text")
    return { text: content.summary, maxLength: CV_LIMITS.summaryCharacters, sourceIds: content.summarySources ?? [] };
  for (let i = 0; i < targets.sections.length; i++) {
    const ids = targets.sections[i]!, section = content.sections[i];
    if (!section || ids.entryId !== section.entryId) continue;
    if (target.type === "section" && target.id === ids.sectionId && target.field === "text")
      return { text: section.heading, maxLength: 250, sourceIds: [], entryId: section.entryId };
    const bullet = ids.bulletIds.indexOf(target.id);
    if (target.type === "bullet" && bullet >= 0) return {
      text: target.field === "signpost" ? section.bulletSignposts?.[bullet] ?? "" : section.bullets[bullet]!,
      maxLength: target.field === "signpost" ? 60 : CV_LIMITS.bulletCharacters,
      sourceIds: section.bulletSources?.[bullet] ?? [], entryId: section.entryId,
    };
    const skill = ids.skillIds.indexOf(target.id);
    if (target.type === "skill" && skill >= 0 && section.skillItems?.[skill] && target.field === "text")
      return { text: section.skillItems[skill]!, maxLength: CV_LIMITS.skillCharacters, sourceIds: [], entryId: section.entryId };
  }
  return null;
}

export interface CvInlineInput {
  request: CvInlineRequest;
  descriptionVersionId: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  selection: { start: number; end: number; selected: string };
  /** Bounded adjacent text aids grammar; it is never another requested target. */
  surrounding: { before: string; after: string };
  role: string;
  roleTruncated: boolean;
  evidence: { id: string; text: string }[];
  omittedEvidence: number;
  maxFieldLength: number;
  model: string;
  routes: StageRoutes;
  promptVersion: string;
  verifierVersion: string;
  careerVersion: number;
}
export const CvInlineProposalSchema = z.object({ text: z.string().min(1).max(CV_INLINE_TEXT_LIMIT) }).strict();
export const CvInlineVerificationSchema = z.object({ preservesFacts: z.boolean(), followsAction: z.boolean() }).strict();

/** Deterministic backstop, in addition to a bounded semantic check. Context never licenses new facts. */
export function validateCvInlineProposal(input: CvInlineInput, raw: unknown): string | null {
  const parsed = CvInlineProposalSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.text.trim()) return null;
  const text = parsed.data.text;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null;
  const numbers = (value: string) => value.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const originalNumbers = new Set(numbers(input.selection.selected));
  if (numbers(text).some(number => !originalNumbers.has(number))) return null;
  const full = input.request.text.slice(0, input.selection.start) + text + input.request.text.slice(input.selection.end);
  if (full.length > input.maxFieldLength) return null;
  if ((input.request.target.field === "signpost" || input.request.target.type === "section" || input.request.target.type === "skill") && /[\r\n]/.test(text)) return null;
  return text;
}

export interface CvInlineRunView {
  id: string; status: "queued" | "ready" | "failed" | "dismissed";
  beforeText: string; proposedText: string | null; text: string;
  selectionStart: number; selectionEnd: number; error: string | null;
  target: CvInlineTarget; source: CvInlineSource;
}
export type CvInlineResult = { ok: true; run: CvInlineRunView } | { ok: false; error: string; recovery?: { href?: string; label?: string; resetAt?: string } };
