import { describe, expect, it } from "vitest";
import type { CvClaimItem, CvReviewPlan, CvRubric, CvTextItem } from "@ava/core/cv-assessment";
import { createAiEngine, type AiClientLike, type ParseResponse } from "./engine";
import { cvClaimMemoFrom, cvClaimMemoKeys } from "./claim-memo";
import { UNVERIFIED_CLAIM_REASON } from "./cv-review-batch";

/** The synthetic audit: twelve requirements, six Library entries, forty-eight printed claims. */
export function memoFixture() {
  const evidence: CvTextItem[] = [
    { id: "source:profile", text: "Operations leader across regulated services." },
    ...Array.from({ length: 6 }, (_, entry) => ({
      id: `entry:e${entry}`,
      text: Array.from({ length: 8 }, (_, row) => `Delivered outcome ${entry}-${row} for the operations portfolio.`).join("\n"),
    })),
  ];
  const rubric: CvRubric = {
    requirements: Array.from({ length: 12 }, (_, i) => ({
      id: `r${i + 1}`, label: `Requirement ${i + 1}`, quote: `Requirement ${i + 1}`,
      importance: i % 3 ? "desirable" as const : "essential" as const, category: "experience" as const,
    })),
    caveats: ["Scope is judged from the responsibilities only."],
  };
  const claims = (changed: ReadonlySet<number> = new Set()): CvClaimItem[] => Array.from({ length: 48 }, (_, i) => {
    const entry = Math.floor(i / 8);
    // A changed claim is reworded; the reworded text is still in its source for one of the three.
    const text = changed.has(i) ? (i % 2 ? `Rewrote outcome ${entry}-${i % 8} as something the source never says.` : `Delivered outcome ${entry}-${i % 8} for the operations portfolio.`)
      : `Delivered outcome ${entry}-${i % 8}`;
    return { id: `section:e${entry}:${i % 8}`, text, requiredEvidenceId: `entry:e${entry}` };
  });
  const input = (changed?: ReadonlySet<number>) => {
    const items = claims(changed);
    return { rubric, claims: items, cv: [{ id: "profile", text: "Operations leader" }, ...items.map(({ id, text }) => ({ id, text }))], evidence };
  };
  return { input, evidence, rubric };
}

const payloadOf = (params: Record<string, unknown>) =>
  Object.assign({}, ...(params.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content.map(block => JSON.parse(block.text))) as {
    requirements: CvRubric["requirements"]; claims: CvClaimItem[]; cv: CvTextItem[]; claimSources: CvTextItem[];
  };

/**
 * A deterministic reviewer: a requirement is judged against the printed CV (it cites the profile),
 * a claim against its own source alone (supported when the source contains it word for word).
 */
export function memoReviewer() {
  const requests: Array<Record<string, unknown>> = [];
  const answer = (params: Record<string, unknown>): ParseResponse => {
    requests.push(params);
    const batch = payloadOf(params);
    const review: CvReviewPlan = {
      matches: batch.requirements.map(requirement => ({
        requirementId: requirement.id, status: "demonstrated", libraryStatus: "demonstrated",
        cvEvidence: [{ id: "profile", quote: "Operations leader" }], libraryEvidence: [{ id: "source:profile", quote: "Operations leader" }],
        reason: `Shown for ${requirement.id}`, improvement: "",
      })),
      claims: batch.claims.map(claim => {
        const source = batch.claimSources.find(item => item.id === claim.requiredEvidenceId)!;
        const supported = source.text.includes(claim.text);
        return { claimId: claim.id, status: supported ? "supported" : "unsupported",
          evidence: supported ? [{ id: source.id, quote: claim.text }] : [], reason: supported ? "Stated in its source" : "Not in its source" };
      }),
    };
    return { parsed_output: review, usage: { input_tokens: 600, output_tokens: 1400 }, stop_reason: "end_turn", model: params.model as string };
  };
  const client: AiClientLike = { messages: { create: async params => answer(params) } };
  return { client, requests, payloadOf };
}

const engineFor = (client: AiClientLike, routes = {}) => createAiEngine({ client, getModel: () => "claude-fable-5-1", getStageRoutes: () => routes });

describe("the delta re-audit of a revision", () => {
  it("sends only the changed claims with every requirement, keeps coverage, and merges to exactly the full re-audit", async () => {
    const { input } = memoFixture();
    const draftReviewer = memoReviewer();
    const draftEngine = engineFor(draftReviewer.client);
    const draft = await draftEngine.assessCvBatches(input(), {}, { pass: "draft" });
    expect(draft.review).not.toBeNull();
    const memo = cvClaimMemoFrom(draft.review!, cvClaimMemoKeys(input(), await draftEngine.claimMemoRoute("draft")));
    expect(Object.keys(memo)).toHaveLength(48);

    const changed = new Set([5, 20, 41]);
    const full = memoReviewer();
    const reaudit = await engineFor(full.client).assessCvBatches(input(changed), {}, { pass: "revision" });
    const delta = memoReviewer();
    const merged = await engineFor(delta.client).assessCvBatches(input(changed), {}, { pass: "revision", claimMemo: memo });

    // Only the three changed claims went out, beside all twelve requirements, in two batches not six.
    const sent = delta.requests.map(request => delta.payloadOf(request));
    expect(sent.flatMap(batch => batch.claims.map(claim => claim.id)).sort()).toEqual(["section:e0:5", "section:e2:4", "section:e5:1"]);
    expect(sent.flatMap(batch => batch.requirements.map(item => item.id)).sort()).toEqual(input().rubric.requirements.map(item => item.id).sort());
    expect(delta.requests).toHaveLength(2);
    expect(full.requests).toHaveLength(6);
    // Every batch covered what it was sent, exactly once.
    expect(merged.batches.every(batch => batch.status === "done")).toBe(true);
    expect(merged.reusedClaims).toBe(45);
    // The merged review is the full re-audit's, verdict for verdict and in the CV's order.
    expect(merged.review).toEqual(reaudit.review);
    expect(merged.review!.claims.find(claim => claim.claimId === "section:e5:1")!.status).toBe("unsupported");
  });

  it("reuses nothing when the re-audit runs at another effort or model, or under another rubric", async () => {
    const { input, rubric } = memoFixture();
    const draftEngine = engineFor(memoReviewer().client);
    const draft = await draftEngine.assessCvBatches(input(), {}, { pass: "draft" });
    const memo = cvClaimMemoFrom(draft.review!, cvClaimMemoKeys(input(), await draftEngine.claimMemoRoute("draft")));

    const atMedium = memoReviewer();
    const medium = await engineFor(atMedium.client, { "cv.review_candidate": { effort: "medium" } }).assessCvBatches(input(), {}, { pass: "revision", claimMemo: memo });
    expect(medium.reusedClaims).toBe(0);
    expect(atMedium.requests).toHaveLength(6);

    const otherModel = await engineFor(memoReviewer().client, { "cv.review_candidate": { model: "claude-sonnet-5" } }).assessCvBatches(input(), {}, { pass: "revision", claimMemo: memo });
    expect(otherModel.reusedClaims).toBe(0);

    const otherRubric = { ...input(), rubric: { ...rubric, caveats: ["Another caveat."] } };
    expect((await engineFor(memoReviewer().client).assessCvBatches(otherRubric, {}, { pass: "revision", claimMemo: memo })).reusedClaims).toBe(0);
  });

  it("re-asks about a claim the audit could not verify, and refuses a memo outside the revision's full audit", async () => {
    const { input } = memoFixture();
    const engine = engineFor(memoReviewer().client);
    const draft = await engine.assessCvBatches(input(), {}, { pass: "draft" });
    draft.review!.claims[0]!.reason = UNVERIFIED_CLAIM_REASON;
    const memo = cvClaimMemoFrom(draft.review!, cvClaimMemoKeys(input(), await engine.claimMemoRoute("draft")));
    expect(Object.keys(memo)).toHaveLength(47);
    await expect(engine.assessCvBatches(input(), {}, { pass: "draft", claimMemo: memo })).rejects.toThrow(/re-audit of a revision/);
    await expect(engine.assessCvBatches(input(), {}, { pass: "revision", claimMemo: memo, only: [0] })).rejects.toThrow(/re-audit of a revision/);
  });
});
