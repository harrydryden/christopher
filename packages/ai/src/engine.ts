import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { estimateCostUsd } from "./pricing";
import * as P from "./prompts";
import * as S from "./schemas";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiUsageRecord {
  callSite: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  refType?: string;
  refId?: string;
}

export interface Ref {
  refType?: string;
  refId?: string;
}

/** The slice of the Anthropic client this engine uses, so tests can inject a fake. */
export interface AiClientLike {
  messages: {
    parse(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<ParseResponse>;
  };
}

export interface ParseResponse {
  parsed_output?: unknown;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  model?: string;
}

export interface AiEngineOptions {
  apiKey?: string;
  getModel: (callSite: string) => string;
  onUsage?: (record: AiUsageRecord) => void | Promise<void>;
  client?: AiClientLike;
  /** Route calls through the server-side refusal fallback. Requires a model that supports it. */
  useServerFallback?: boolean;
  logger?: (msg: string, data?: unknown) => void;
}

interface RunParams {
  system: string;
  user: string;
  schema: z.ZodType;
  effort: Effort;
  maxTokens?: number;
  timeoutMs?: number;
  tools?: Array<Record<string, unknown>>;
}

export class AiEngine {
  readonly enabled: boolean;
  private readonly client: AiClientLike | null;

  constructor(private readonly options: AiEngineOptions) {
    if (options.client) {
      this.client = options.client;
    } else if (options.apiKey) {
      this.client = new Anthropic({ apiKey: options.apiKey }) as unknown as AiClientLike;
    } else {
      this.client = null;
    }
    this.enabled = this.client !== null;
  }

  private log(msg: string, data?: unknown) {
    this.options.logger?.(msg, data);
  }

  private async record(record: AiUsageRecord) {
    try {
      await this.options.onUsage?.(record);
    } catch (err) {
      this.log("usage callback failed", err);
    }
  }

  private async run<T>(callSite: string, params: RunParams, ref: Ref = {}): Promise<T | null> {
    if (!this.client) return null;
    const model = this.options.getModel(callSite);
    const started = Date.now();
    const request: Record<string, unknown> = {
      model,
      max_tokens: params.maxTokens ?? 4096,
      system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: params.user }],
      output_config: { format: zodOutputFormat(params.schema), effort: params.effort },
    };
    if (params.tools) request.tools = params.tools;

    try {
      const response = await this.client.messages.parse(request, { timeout: params.timeoutMs ?? 30_000 });
      const usage = response.usage ?? {};
      const tokens = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      };
      const refused = response.stop_reason === "refusal";
      const parsed = refused ? null : (response.parsed_output ?? extractJsonBlock(textOf(response)));
      const validated = parsed === null || parsed === undefined ? null : safeParse<T>(params.schema, parsed);
      await this.record({
        callSite,
        model: response.model ?? model,
        ...tokens,
        costUsd: estimateCostUsd(response.model ?? model, tokens),
        durationMs: Date.now() - started,
        ok: validated !== null,
        error: refused ? `refusal:${response.stop_details?.category ?? "unknown"}` : validated === null ? "no parseable output" : undefined,
        ...ref,
      });
      if (refused) this.log(`${callSite} refused`, response.stop_details);
      return validated;
    } catch (err) {
      await this.record({
        callSite,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs: Date.now() - started,
        ok: false,
        error: (err as Error).message.slice(0, 500),
        ...ref,
      });
      this.log(`${callSite} failed`, err);
      return null;
    }
  }

  // A1 ---------------------------------------------------------------------
  async chooseCareersLinks(
    input: { companyName: string; homepageUrl: string; links: Array<{ href: string; text: string; context?: string }> },
    ref: Ref = {},
  ): Promise<Array<{ url: string; confidence: number; reason: string }> | null> {
    const links = input.links.slice(0, 300);
    const known = new Set(links.map((l) => l.href));
    const listing = links.map((l, i) => `[${i}] ${l.text || "(no text)"} | ${l.href}${l.context ? ` | ${l.context}` : ""}`).join("\n");
    const result = await this.run<S.CareersLinksOutput>(
      "A1",
      {
        system: P.A1_CHOOSE_CAREERS_LINKS,
        user: `Company: ${input.companyName}\nHomepage: ${input.homepageUrl}\n\n${P.wrap("page_content", P.truncate(listing, 40_000))}`,
        schema: S.CareersLinksSchema,
        effort: "low",
      },
      ref,
    );
    if (!result) return null;
    return result.candidates
      .filter((c) => known.has(c.url))
      .map((c) => ({ url: c.url, confidence: clamp01(c.confidence), reason: c.reason.slice(0, 200) }))
      .slice(0, 5);
  }

  // A2 ---------------------------------------------------------------------
  async classifyPage(
    input: { url: string; text: string; links: Array<{ href: string; text: string }> },
    ref: Ref = {},
  ): Promise<{ kind: "listing" | "landing" | "other"; nextHopUrl?: string; confidence: number } | null> {
    const links = input.links.slice(0, 120);
    const known = new Set(links.map((l) => l.href));
    const body = `${P.wrap("page_content", P.truncate(input.text, 24_000))}\n\nLinks on the page:\n${links.map((l) => `${l.text || "(no text)"} | ${l.href}`).join("\n")}`;
    const result = await this.run<S.PageClassificationOutput>(
      "A2",
      { system: P.A2_CLASSIFY_PAGE, user: `URL: ${input.url}\n\n${body}`, schema: S.PageClassificationSchema, effort: "low" },
      ref,
    );
    if (!result) return null;
    const nextHopUrl = result.nextHopUrl && known.has(result.nextHopUrl) ? result.nextHopUrl : undefined;
    return { kind: result.kind, nextHopUrl, confidence: clamp01(result.confidence) };
  }

  // A3 ---------------------------------------------------------------------
  async extractPostings(
    input: { pageUrl: string; compactDom: string; knownUrls: string[] },
    ref: Ref = {},
  ): Promise<{
    postings: Array<{ title: string; url: string; location?: string; department?: string }>;
    recipe: { version: 1; listItem: string; title: string; link: string; location?: string; department?: string } | null;
    confidence: number;
    dropped: number;
  } | null> {
    const result = await this.run<S.ExtractPostingsOutput>(
      "A3",
      {
        system: P.A3_EXTRACT_POSTINGS,
        user: `Page URL: ${input.pageUrl}\n\n${P.wrap("page_content", P.truncate(input.compactDom, 80_000))}`,
        schema: S.ExtractPostingsSchema,
        effort: "low",
        maxTokens: 8000,
        timeoutMs: 60_000,
      },
      ref,
    );
    if (!result) return null;
    const allowed = new Map(input.knownUrls.map((u) => [canonical(u), u]));
    const postings: Array<{ title: string; url: string; location?: string; department?: string }> = [];
    let dropped = 0;
    for (const p of result.postings) {
      const real = allowed.get(canonical(p.url));
      if (!real) {
        dropped++;
        continue;
      }
      postings.push({
        title: p.title.trim(),
        url: real,
        location: p.location?.trim() || undefined,
        department: p.department?.trim() || undefined,
      });
    }
    const recipe = result.recipe
      ? {
          version: 1 as const,
          listItem: result.recipe.listItem,
          title: result.recipe.title,
          link: result.recipe.link,
          location: result.recipe.location ?? undefined,
          department: result.recipe.department ?? undefined,
        }
      : null;
    return { postings, recipe, confidence: clamp01(result.confidence), dropped };
  }

  // A4 ---------------------------------------------------------------------
  async cleanDescription(
    input: { title: string; rawText: string },
    ref: Ref = {},
  ): Promise<{ descriptionText: string; salaryText?: string; employmentType?: string; remote?: boolean } | null> {
    const result = await this.run<S.DescriptionOutput>(
      "A4",
      {
        system: P.A4_CLEAN_DESCRIPTION,
        user: `Role: ${input.title}\n\n${P.wrap("page_content", P.truncate(input.rawText, 40_000))}`,
        schema: S.DescriptionSchema,
        effort: "low",
      },
      ref,
    );
    if (!result) return null;
    return {
      descriptionText: result.descriptionText.trim().slice(0, 30_000),
      salaryText: result.salaryText?.trim() || undefined,
      employmentType: result.employmentType?.trim() || undefined,
      remote: result.remote ?? undefined,
    };
  }

  // A5 ---------------------------------------------------------------------
  async scoreJob(
    input: {
      profileMarkdown: string;
      decisionDigest: string;
      job: { title: string; company: string; location?: string; department?: string; employmentType?: string; description?: string; keywordTerms?: string[] };
    },
    ref: Ref = {},
  ): Promise<{ score: number; verdict: "strong" | "possible" | "unlikely"; rationale: string; flags: string[] } | null> {
    const j = input.job;
    const jobText = [
      `Title: ${j.title}`,
      `Company: ${j.company}`,
      j.location ? `Location: ${j.location}` : null,
      j.department ? `Department: ${j.department}` : null,
      j.employmentType ? `Employment type: ${j.employmentType}` : null,
      j.keywordTerms?.length ? `Matched keywords: ${j.keywordTerms.join(", ")}` : null,
      j.description ? `\nDescription:\n${P.truncate(j.description, 6000)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const result = await this.run<S.FitScoreOutput>(
      "A5",
      {
        system: P.a5ScoreJobSystem(input.profileMarkdown, input.decisionDigest),
        user: P.wrap("job", jobText),
        schema: S.FitScoreSchema,
        effort: "low",
        maxTokens: 1024,
      },
      ref,
    );
    if (!result) return null;
    const score = Math.round(Math.max(0, Math.min(100, result.score)));
    const verdict = score >= 70 ? "strong" : score >= 30 ? "possible" : "unlikely";
    return {
      score,
      verdict: result.verdict === verdict ? result.verdict : verdict,
      rationale: result.rationale.trim().slice(0, 300),
      flags: [...new Set((result.flags ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean))].slice(0, 8),
    };
  }

  // A6 ---------------------------------------------------------------------
  async tagReason(
    input: { reason: string; decision: "apply" | "skip"; job: { title: string; company: string; location?: string; department?: string }; vocabulary: string[] },
    ref: Ref = {},
  ): Promise<{ tags: string[]; proposedNewTags: Array<{ tag: string; description: string }> } | null> {
    const result = await this.run<S.ReasonTagsOutput>(
      "A6",
      {
        system: P.A6_TAG_REASON,
        user: [
          `Decision: ${input.decision}`,
          `Role: ${input.job.title} at ${input.job.company}${input.job.location ? ` (${input.job.location})` : ""}`,
          input.job.department ? `Department: ${input.job.department}` : "",
          `\nVocabulary:\n${input.vocabulary.join("\n")}`,
          `\n${P.wrap("reason", input.reason.slice(0, 2000))}`,
        ]
          .filter(Boolean)
          .join("\n"),
        schema: S.ReasonTagsSchema,
        effort: "low",
        maxTokens: 1024,
      },
      ref,
    );
    if (!result) return null;
    const vocabulary = new Set(input.vocabulary.map((t) => t.toLowerCase()));
    const tags: string[] = [];
    const proposed: Array<{ tag: string; description: string }> = [...(result.proposedNewTags ?? [])];
    for (const raw of result.tags) {
      const tag = raw.trim().toLowerCase();
      if (vocabulary.has(tag)) tags.push(tag);
      else if (/^[a-z_]+:[a-z0-9_]+$/.test(tag)) proposed.push({ tag, description: "" });
    }
    const seen = new Set<string>();
    return {
      tags: tags.filter((t) => !seen.has(t) && seen.add(t)),
      proposedNewTags: proposed
        .map((p) => ({ tag: p.tag.trim().toLowerCase(), description: (p.description ?? "").slice(0, 200) }))
        .filter((p) => /^[a-z_]+:[a-z0-9_]+$/.test(p.tag) && !vocabulary.has(p.tag))
        .slice(0, 4),
    };
  }

  // A7 ---------------------------------------------------------------------
  async synthesizeProfile(
    input: {
      seedProfile: string;
      pinnedStatements: string[];
      currentProfile?: string;
      decisions: DecisionForDigest[];
      disagreements?: Array<{ title: string; company: string; decision: string; fitScore: number; reason: string }>;
      rejectedCompanySuggestions?: Array<{ name: string; reason: string }>;
    },
    ref: Ref = {},
  ): Promise<{ markdown: string; openQuestions: Array<{ id: string; question: string }> } | null> {
    const digest = decisionDigest(input.decisions, { maxItems: 400, maxChars: 40_000 });
    const user = [
      P.wrap("seed_profile", input.seedProfile || "(none written yet)"),
      P.wrap("pinned_statements", input.pinnedStatements.length ? input.pinnedStatements.map((s) => `- ${s}`).join("\n") : "(none)"),
      input.currentProfile ? P.wrap("current_profile", P.truncate(input.currentProfile, 8000)) : "",
      P.wrap("decisions", digest),
      input.disagreements?.length
        ? P.wrap(
            "score_disagreements",
            input.disagreements.map((d) => `- scored ${d.fitScore} but they chose ${d.decision}: ${d.title} at ${d.company} — ${d.reason}`).join("\n"),
          )
        : "",
      input.rejectedCompanySuggestions?.length
        ? P.wrap("rejected_companies", input.rejectedCompanySuggestions.map((r) => `- ${r.name}: ${r.reason}`).join("\n"))
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.run<S.ProfileOutput>(
      "A7",
      { system: P.A7_SYNTHESIZE_PROFILE, user, schema: S.ProfileSchema, effort: "high", maxTokens: 6000, timeoutMs: 60_000 },
      ref,
    );
    if (!result) return null;
    let markdown = result.markdown.trim();
    const missing = input.pinnedStatements.filter((s) => s.trim() && !markdown.includes(s.trim()));
    if (missing.length > 0) {
      markdown += `\n\n## Pinned\n${missing.map((s) => `- ${s} [pinned]`).join("\n")}`;
    }
    return { markdown, openQuestions: (result.openQuestions ?? []).slice(0, 3) };
  }

  // A8 ---------------------------------------------------------------------
  async suggestFilters(
    input: {
      includeKeywords: string[];
      excludeKeywords: string[];
      locationTerms: string[];
      decisions: DecisionForDigest[];
      nearMissDecisions: DecisionForDigest[];
      previouslyRejected: Array<{ type: string; value: unknown }>;
    },
    ref: Ref = {},
  ): Promise<S.FilterSuggestionsOutput["suggestions"] | null> {
    const user = [
      `Current include keywords: ${input.includeKeywords.join(", ") || "(none)"}`,
      `Current exclude keywords: ${input.excludeKeywords.join(", ") || "(none)"}`,
      `Current location terms: ${input.locationTerms.join(", ") || "(none)"}`,
      P.wrap("decisions", decisionDigest(input.decisions, { maxItems: 200, maxChars: 20_000 })),
      P.wrap("near_miss_decisions", decisionDigest(input.nearMissDecisions, { maxItems: 100, maxChars: 10_000 })),
      `Previously rejected suggestions: ${JSON.stringify(input.previouslyRejected).slice(0, 4000)}`,
    ].join("\n\n");
    const result = await this.run<S.FilterSuggestionsOutput>(
      "A8",
      { system: P.A8_SUGGEST_FILTERS, user, schema: S.FilterSuggestionsSchema, effort: "high", maxTokens: 4000 },
      ref,
    );
    if (!result) return null;
    const existing = new Set(
      [...input.includeKeywords, ...input.excludeKeywords, ...input.locationTerms].map((t) => t.trim().toLowerCase()),
    );
    const rejected = new Set(input.previouslyRejected.map((r) => `${r.type}|${JSON.stringify(r.value).toLowerCase()}`));
    return result.suggestions.filter((s) => {
      const term = typeof s.value.term === "string" ? s.value.term.trim().toLowerCase() : null;
      if (term && existing.has(term)) return false;
      return !rejected.has(`${s.type}|${JSON.stringify(s.value).toLowerCase()}`);
    });
  }

  // A9 ---------------------------------------------------------------------
  async profileCompany(
    input: { name: string; domain: string; homepageText: string; aboutText?: string },
    ref: Ref = {},
  ): Promise<S.CompanyProfileOutput | null> {
    const body = [input.homepageText, input.aboutText].filter(Boolean).join("\n\n---\n\n");
    const result = await this.run<S.CompanyProfileOutput>(
      "A9",
      {
        system: P.A9_PROFILE_COMPANY,
        user: `Company: ${input.name}\nDomain: ${input.domain}\n\n${P.wrap("page_content", P.truncate(body, 24_000))}`,
        schema: S.CompanyProfileSchema,
        effort: "low",
        maxTokens: 2000,
      },
      ref,
    );
    if (!result) return null;
    return {
      ...result,
      geographies: [...new Set(result.geographies ?? [])].slice(0, 12),
      tags: [...new Set((result.tags ?? []).map((t) => t.toLowerCase()))].slice(0, 12),
    };
  }

  // A10 --------------------------------------------------------------------
  async suggestCompanies(
    input: {
      portfolio: Array<{ name: string; domain: string; oneLiner?: string; sector?: string; stage?: string; sizeBand?: string; hqCountry?: string; tags?: string[] }>;
      preferenceProfile?: string;
      excludeDomains: string[];
      rejected: Array<{ name: string; reason: string }>;
      limit: number;
    },
    ref: Ref = {},
  ): Promise<Array<{ name: string; homepageUrl: string; similarTo: string[]; rationale: string; confidence: number }> | null> {
    const portfolio = input.portfolio
      .slice(0, 60)
      .map((c) => `- ${c.name} (${c.domain})${c.sector ? ` — ${c.sector}` : ""}${c.stage ? `, ${c.stage}` : ""}${c.sizeBand ? `, ${c.sizeBand}` : ""}${c.hqCountry ? `, ${c.hqCountry}` : ""}${c.oneLiner ? `: ${c.oneLiner}` : ""}`)
      .join("\n");
    const user = [
      `Return up to ${input.limit} candidates.`,
      P.wrap("tracked_companies", portfolio),
      input.preferenceProfile ? P.wrap("preference_profile", P.truncate(input.preferenceProfile, 6000)) : "",
      `Excluded domains (never suggest these): ${input.excludeDomains.slice(0, 400).join(", ")}`,
      input.rejected.length ? P.wrap("previously_rejected", input.rejected.map((r) => `- ${r.name}: ${r.reason}`).join("\n")) : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.run<S.CompanySuggestionsOutput>(
      "A10",
      {
        system: P.A10_SUGGEST_COMPANIES,
        user,
        schema: S.CompanySuggestionsSchema,
        effort: "high",
        maxTokens: 8000,
        timeoutMs: 60_000,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 15 }],
      },
      ref,
    );
    if (!result) return null;
    const excluded = new Set(input.excludeDomains.map((d) => d.toLowerCase()));
    const out: Array<{ name: string; homepageUrl: string; similarTo: string[]; rationale: string; confidence: number }> = [];
    const seen = new Set<string>();
    for (const c of result.candidates) {
      if (!/^https?:\/\//i.test(c.homepageUrl)) continue;
      let domain: string;
      try {
        domain = new URL(c.homepageUrl).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        continue;
      }
      if (excluded.has(domain) || AGGREGATORS.some((a) => domain === a || domain.endsWith(`.${a}`))) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({
        name: c.name.trim(),
        homepageUrl: c.homepageUrl,
        similarTo: (c.similarTo ?? []).slice(0, 6),
        rationale: c.rationale.trim().slice(0, 400),
        confidence: clamp01(c.confidence),
      });
    }
    return out.slice(0, input.limit);
  }
}

const AGGREGATORS = [
  "linkedin.com", "glassdoor.com", "glassdoor.co.uk", "crunchbase.com", "wikipedia.org", "indeed.com", "indeed.co.uk",
  "pitchbook.com", "ycombinator.com", "otta.com", "welcometothejungle.com", "totaljobs.com", "reed.co.uk", "monster.com",
  "ziprecruiter.com", "builtin.com", "wellfound.com", "angel.co",
];

export interface DecisionForDigest {
  title: string;
  company: string;
  location?: string | null;
  department?: string | null;
  decision: "apply" | "skip";
  reason: string;
  tags: string[];
  snippet?: string | null;
  fitScore?: number | null;
  at: string;
}

/** Compact, newest-first summary of past decisions used as cached context for scoring. */
export function decisionDigest(decisions: DecisionForDigest[], opts: { maxItems?: number; maxChars?: number } = {}): string {
  const maxItems = opts.maxItems ?? 100;
  const maxChars = opts.maxChars ?? 12_000;
  const sorted = [...decisions].sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
  const lines: string[] = [];
  let used = 0;
  for (const d of sorted.slice(0, maxItems)) {
    const reason = (d.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const tags = d.tags.length ? ` #${d.tags.join(" #")}` : "";
    const line = `- [${d.decision}] ${d.title} @ ${d.company}${d.location ? ` (${d.location})` : ""}${reason ? ` — ${reason}` : ""}${tags}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(Math.max(0, Math.min(1, n)).toFixed(3));
}

function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function textOf(response: ParseResponse): string {
  return (response.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Recover a JSON object from a fenced block or the first balanced braces in free text. */
export function extractJsonBlock(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* try the next strategy */
    }
    const start = trimmed.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function safeParse<T>(schema: z.ZodType, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? (result.data as T) : null;
}

export function createAiEngine(options: AiEngineOptions): AiEngine {
  return new AiEngine(options);
}
