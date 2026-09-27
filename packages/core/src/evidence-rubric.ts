/**
 * The rubric a row of Library evidence is scored against, one checklist per type.
 *
 * A row is scored for what its type needs, not for four fixed properties. A Responsibilities row
 * is strong when it says what was owned, for whom, at what level and at what scale; a Metrics
 * moved row when it gives the figure, what it measures, how it moved and what moved it. Each type
 * has four marks worth a quarter each, so a row's score against one type is 0, 25, 50, 75 or 100,
 * and a row tagged with several types is scored against each and shown the mean: a row that is
 * both the problem solved and the figure it moved has to carry both stories.
 *
 * Marks are properties of the wording, not of the tag. A row is checked for all twenty-four, and
 * the tags decide which checklists apply, so re-tagging a row on screen re-scores it without
 * re-reading it, and an untyped row has no score at all rather than a low one — the cell reads
 * "Select type".
 *
 * Browser-safe on purpose: the Library editor scores live from the person's own wording and tags
 * (`detectEvidenceMarks` is the rules baseline), and the model review (A12) replaces the detected
 * marks with its own judgement of the same twenty-four. Nothing here produces a number the model
 * wrote: the model says which marks a row earns, and `scoreRowAgainst` does the arithmetic.
 * Nothing here gates anything.
 */
import { EVIDENCE_FACETS, EVIDENCE_FACET_LABELS, type EvidenceFacet } from "./cv-helpers";

export interface EvidenceMarkSpec {
  facet: EvidenceFacet;
  /** What the row has when it earns the mark, as a short noun phrase: "the size of it". */
  label: string;
  /** What to add when it does not, as one imperative line the person can act on. */
  ask: string;
  /** The judgement, for the reviewer: when a row earns this and when it does not. */
  rubric: string;
}

/**
 * Twenty-four marks, four a type, in the order each type's checklist reads. The id is the type
 * and the mark joined by a dot, which is how the model names them and how they are stored.
 */
export const EVIDENCE_MARK_SPECS = {
  // Responsibilities: what they were accountable for, and for whom.
  "responsibility.scope": {
    facet: "responsibility", label: "what was owned",
    ask: "Name what you owned: the function, process, product, market, budget or system.",
    rubric: "Names the thing they were accountable for — a function, process, product, market, budget, system or portfolio — rather than a job title or a generic duty (\"various tasks\", \"day-to-day operations\").",
  },
  "responsibility.audience": {
    facet: "responsibility", label: "who it was for",
    ask: "Say who relied on it: a team, leaders, clients, a region or another function.",
    rubric: "Says who the work served or answered to: a named team, leadership role, client group, region, business unit or function.",
  },
  "responsibility.ownership": {
    facet: "responsibility", label: "your part in it",
    ask: "Say your part: led it, ran it, owned it, built it or supported it.",
    rubric: "States the level of accountability with a verb of ownership — led, ran, owned, managed, headed, built, set up, was accountable for, reported to — not a passive \"involved in\" or \"helped with\".",
  },
  "responsibility.scale": {
    facet: "responsibility", label: "the size of it",
    ask: "Give the size: headcount, budget, revenue, sites, customers or how often.",
    rubric: "Gives a size or cadence: headcount, budget or revenue figure, number of sites, markets, entities, customers or products, or the frequency of the work.",
  },
  // Problems solved: the problem or constraint they were there to solve.
  "problem.situation": {
    facet: "problem", label: "the problem named",
    ask: "Name the problem: what was broken, late, manual, costly or at risk.",
    rubric: "Names a concrete problem or state that needed fixing — a backlog, failing process, manual work, overspend, missed deadlines, a risk, gap or complaint — rather than just the task.",
  },
  "problem.constraint": {
    facet: "problem", label: "what made it hard",
    ask: "Say what made it hard: the cause, the deadline, the budget or what you had to work around.",
    rubric: "Says why it was hard or what caused it: a root cause, deadline, budget or headcount limit, legacy system, regulation, or a constraint that had to be worked around.",
  },
  "problem.approach": {
    facet: "problem", label: "what you did about it",
    ask: "Say what you did about it: the change you made or the approach you took.",
    rubric: "Describes the action taken — rebuilt, redesigned, introduced, automated, negotiated, restructured, replaced — specifically enough that a reader knows what changed.",
  },
  "problem.resolution": {
    facet: "problem", label: "how it ended",
    ask: "Say how it ended: what was fixed, avoided, unblocked or recovered.",
    rubric: "Says how the problem ended — fixed, eliminated, avoided, recovered, unblocked, brought within target — so the reader knows the problem was solved, not just worked on.",
  },
  // Outcomes: what changed as a result of their work.
  "outcome.change": {
    facet: "outcome", label: "the change stated",
    ask: "State the change: what was different afterwards from before.",
    rubric: "States a change in state — reduced, grew, restored, launched, eliminated, from X to Y — not an activity (\"worked on improving\").",
  },
  "outcome.cause": {
    facet: "outcome", label: "what produced it",
    ask: "Tie it to what you did: the action that produced the change.",
    rubric: "Connects the change to the person's own action — by, through, after, using — so it reads as their result rather than something that happened around them.",
  },
  "outcome.beneficiary": {
    facet: "outcome", label: "who or what gained",
    ask: "Say who or what gained: the team, customers, the business, or a risk removed.",
    rubric: "Says who or what benefited: customers, a team, the business, revenue, cash, compliance, a risk that went away.",
  },
  "outcome.magnitude": {
    facet: "outcome", label: "the size of the change",
    ask: "Give the size of the change: a figure, a percentage, a time saved or a comparison.",
    rubric: "Gives the magnitude of the change as a figure, percentage, time, currency amount, multiple, or an explicit comparison (from X to Y, halved, first ever, every site).",
  },
  // Metrics moved: how much or how many.
  "metric.figure": {
    facet: "metric", label: "the figure",
    ask: "Give the figure: a number, a percentage, a currency amount or a time.",
    rubric: "Carries a number, percentage, currency amount or measured duration.",
  },
  "metric.measure": {
    facet: "metric", label: "what it measures",
    ask: "Name what the figure measures: revenue, cost, time, customers, errors, retention.",
    rubric: "Names the measure the figure belongs to — revenue, margin, cost, cash, churn, retention, NPS, cycle time, error rate, headcount, volume — so the number means something.",
  },
  "metric.movement": {
    facet: "metric", label: "how it moved",
    ask: "Show the movement: from what to what, or up or down by how much against what.",
    rubric: "Shows direction and a comparison point — from X to Y, up or down by N, versus target, prior year or baseline — not a bare level.",
  },
  "metric.driver": {
    facet: "metric", label: "what moved it, and when",
    ask: "Say what you did to move it, and over what period.",
    rubric: "Says what the person did that moved the number and, ideally, over what period — a quarter, a year, a programme — so the figure is attributable to them.",
  },
  // Milestones reached: what they shipped or completed, and when.
  "milestone.deliverable": {
    facet: "milestone", label: "what was delivered",
    ask: "Name what you shipped or completed: the launch, migration, deal, audit or release.",
    rubric: "Names a concrete thing completed — a launch, release, migration, go-live, signed deal, passed audit, certification, opened site, closed round — rather than ongoing work.",
  },
  "milestone.timing": {
    facet: "milestone", label: "when it landed",
    ask: "Say when: the date or quarter, or how it landed against the deadline.",
    rubric: "Gives the timing: a date, month, quarter or year, a duration, or how it landed against a deadline (on time, ahead of schedule, in six weeks).",
  },
  "milestone.role": {
    facet: "milestone", label: "your part in it",
    ask: "Say your part: led it, delivered it, or which piece was yours.",
    rubric: "States the person's part — led, delivered, owned, co-ordinated, or which piece was theirs — rather than an unattributed \"was launched\".",
  },
  "milestone.significance": {
    facet: "milestone", label: "why it mattered",
    ask: "Say why it mattered: what it enabled, its scale, or what was at stake.",
    rubric: "Says why the milestone mattered: what it enabled or unblocked, its scale or value, that it was a first or the largest, or what was at stake if it slipped.",
  },
  // Working style: how they work with other people to get something done.
  "style.behaviour": {
    facet: "style", label: "the behaviour named",
    ask: "Name the behaviour: how you actually worked, not a trait word.",
    rubric: "Names an observable behaviour — coached, facilitated, negotiated, pushed back, wrote it up, ran weekly one-to-ones — rather than a trait word (\"collaborative\", \"strong communicator\").",
  },
  "style.counterpart": {
    facet: "style", label: "who with",
    ask: "Say who with: your team, peers, senior stakeholders, clients or another function.",
    rubric: "Says who the behaviour was with: a team, peers, direct reports, senior stakeholders, clients, suppliers or another function.",
  },
  "style.instance": {
    facet: "style", label: "one real instance",
    ask: "Give one real instance: a situation where you worked this way.",
    rubric: "Anchors the behaviour in a real, checkable situation — a named project, moment, system or time — rather than a general claim about how they always are.",
  },
  "style.effect": {
    facet: "style", label: "what it led to",
    ask: "Say what it led to: the decision, the delivery or the relationship it produced.",
    rubric: "Says what the behaviour led to: a decision reached, a delivery kept on track, a relationship repaired, a team retained.",
  },
} as const satisfies Record<string, EvidenceMarkSpec>;

export type EvidenceMark = keyof typeof EVIDENCE_MARK_SPECS;
export const EVIDENCE_MARKS = Object.keys(EVIDENCE_MARK_SPECS) as readonly EvidenceMark[];

/** Each type's checklist, in the order its marks are explained. Four each. */
export const EVIDENCE_MARKS_BY_FACET: Readonly<Record<EvidenceFacet, readonly EvidenceMark[]>> = Object.fromEntries(
  EVIDENCE_FACETS.map(facet => [facet, EVIDENCE_MARKS.filter(mark => EVIDENCE_MARK_SPECS[mark].facet === facet)]),
) as unknown as Record<EvidenceFacet, readonly EvidenceMark[]>;

/** A quarter a mark: four marks make a type's checklist. */
export const EVIDENCE_MARK_POINTS = 25;

/** Only the marks this rubric knows, each once, in rubric order. Anything else is dropped. */
export function knownEvidenceMarks(values: readonly string[]): EvidenceMark[] {
  const given = new Set(values);
  return EVIDENCE_MARKS.filter(mark => given.has(mark));
}

/** One type's checklist read against a row: the score for that type and what it still needs. */
export interface EvidenceFacetScore {
  facet: EvidenceFacet;
  score: number;
  earned: EvidenceMark[];
  missing: EvidenceMark[];
}

/**
 * A row's score against the types it is tagged with: each type's four marks at a quarter each,
 * and the mean across the types, rounded. `score` is null when the row has no type, because a
 * row nobody has said the purpose of cannot be short of anything in particular.
 */
export function scoreRowAgainst(
  marks: readonly EvidenceMark[],
  facets: readonly EvidenceFacet[],
): { score: number | null; byFacet: EvidenceFacetScore[] } {
  const earned = new Set(marks);
  const byFacet = EVIDENCE_FACETS.filter(facet => facets.includes(facet)).map<EvidenceFacetScore>(facet => {
    const checklist = EVIDENCE_MARKS_BY_FACET[facet];
    const has = checklist.filter(mark => earned.has(mark));
    return { facet, score: EVIDENCE_MARK_POINTS * has.length, earned: has, missing: checklist.filter(mark => !earned.has(mark)) };
  });
  if (!byFacet.length) return { score: null, byFacet };
  return { score: Math.round(byFacet.reduce((sum, item) => sum + item.score, 0) / byFacet.length), byFacet };
}

/** "Responsibilities and Metrics moved": the types a row was scored as, in the Type column's words. */
export function scoredAsLine(facets: readonly EvidenceFacet[]): string {
  const names = EVIDENCE_FACETS.filter(facet => facets.includes(facet)).map(facet => EVIDENCE_FACET_LABELS[facet]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// The rules baseline: what a row's own wording earns before any model has read it.
//
// Conservative on purpose. A mark missed here costs the person nothing but a line of advice they
// can ignore, and the full review corrects it; a mark awarded wrongly tells them a thin row is
// fine. So each detector looks for the words a strong row of that type actually uses, and a
// detector that would fire on nearly any sentence is not written.
// ---------------------------------------------------------------------------------------------

/** A number, a percentage or an amount of money anywhere in the row. */
const QUANTITY = /[0-9%£$€]/u;
/** A number written out, up to twelve, as sizes often are: "a team of six", "four countries". */
const NUMBER_WORD = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand|million|billion)\b/i;
/** Units a claim is usually measured in when it has no digit. */
const UNIT = /\b(hrs?|hours?|days?|weeks?|months?|quarters?|years?|people|staff|heads?|fte|users?|customers?|clients?|accounts?|countries|markets?|regions?|entities|sites?|stores?|offices?|branches|teams?|reports|engineers|nps|arr|mrr|sla|kpis?)\b/i;
/** A period: "over 12 months", "in six weeks", "Q3", "FY24", a year. */
const PERIOD = /\b((in|over|within|across|during|inside)\s+(\d+|a|an|one|two|three|four|five|six|nine|twelve|eighteen)\s+(days?|weeks?|months?|quarters?|years?)|Q[1-4]\b|H[12]\b|FY\s?\d{2,4}|20\d{2}|19\d{2})/i;
/** A named month, for "shipped in March" and "by December". */
const MONTH = /\b(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|June?|July?|Aug(ust)?|Sep(t(ember)?)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\b/;
/** Verbs of ownership. */
const OWNERSHIP = /\b(led|lead|leading|owned|own|owning|ran|run|running|managed|manage|managing|headed|head of|accountable for|responsible for|oversaw|oversee|overseeing|directed|direct(ing)?|drove|drive|built|building|set up|setting up|established|founded|reported to|reporting to|chaired|sole|single-handedly|personally|my)\b/i;
/** Verbs of doing something about it. */
const ACTION = /\b(rebuilt|rebuilding|redesigned|redesigning|introduced|introducing|implemented|implementing|migrated|migrating|automated|automating|negotiated|negotiating|renegotiated|restructured|restructuring|reorganised|reorganized|created|creating|built|building|replaced|replacing|consolidated|consolidating|streamlined|standardised|standardized|simplified|launched|launching|rolled out|rolling out|set up|changed|fixed|resolved|hired|hiring|trained|training|wrote|writing|designed|designing|developed|developing|moved|switched|overhauled|re-?platformed|integrated|deployed|shipped|delivered|removed|cut|reduced|rewrote|refactored|scaled|grew|raised|secured|closed|opened|turned around)\b/i;
/** A change of state. */
const CHANGE = /\b(reduced|reducing|reduction|cut|cutting|increased|increasing|grew|grow|growth|improved|improving|improvement|raised|lowered|doubled|halved|tripled|quadrupled|restored|eliminated|removed|accelerated|shortened|lengthened|extended|stabilised|stabilized|recovered|turned around|brought (down|up|in|forward|back)|went from|from\s+\S+\s+to\s+\S+|up\s+\d|down\s+\d|\bto\s+(zero|nil|none)\b|no longer|for the first time|first ever)\b/i;
/** The problem was ended, not just worked on. */
const RESOLUTION = /\b(resolved|resolving|fixed|fixing|eliminated|eliminating|removed|removing|restored|restoring|recovered|recovering|cleared|clearing|unblocked|unblocking|avoided|avoiding|prevented|preventing|averted|saved|saving|closed the gap|back on track|within (target|budget|tolerance|sla)|on time|ahead of|so that|which meant|meaning that|resulting in|resulted in|leading to|led to|enabling|enabled|allowed|allowing|halved|reduced|cut|improved|brought (down|up|in|back)|without (a|any) (further|more))\b/i;
/** The change is the person's: it came of what they did. */
const CAUSE = /\b(by\s+\w+ing|through\s+\w+ing|through (a|an|the)\b|via\b|after\s+\w+ing|after (I|we)\b|using (a|an|the)?\s*\w+|thanks to|following (a|an|the)|off the back of|as a result of (my|our|the)|which I|that I|because (I|we))\b/i;
/** Who or what gained. */
const BENEFICIARY = /\b(customers?|clients?|users?|patients?|students?|members?|the (team|business|company|group|board|firm|charity|trust|bank|fund|school|practice)|colleagues?|stakeholders?|leadership|the exec(utive)?s?|finance|sales|marketing|operations|engineering|product|hr|legal|revenue|margins?|profit|cash(flow)?|working capital|compliance|risk|auditors?|the regulator|regulators?|investors?|shareholders?|partners?|suppliers?|the public|residents?|communities|community)\b/i;
/** What a figure measures. */
const MEASURE = /\b(revenue|sales|turnover|income|arr|mrr|gmv|ebitda|margins?|profit|p&l|costs?|spend(ing)?|savings?|opex|capex|cash(flow)?|working capital|dso|dpo|churn|retention|attrition|nps|csat|ces|conversion|win rate|pipeline|bookings|billings|renewals?|headcount|hires?|vacancies|utilisation|utilization|productivity|output|throughput|volumes?|units|orders?|transactions?|tickets?|customers?|users?|subscribers?|accounts?|clients?|members?|market share|accuracy|error rates?|errors?|defects?|incidents?|outages?|uptime|availability|latency|response times?|resolution times?|cycle times?|lead times?|close|month-end|time to \w+|turnaround|backlog|variance|forecast accuracy|budget|sla|okrs?|kpis?|engagement|satisfaction|scores?|ratings?|ranking|traffic|visits|downloads|installs|leads|enquiries|footfall|occupancy|yield|adoption|coverage|compliance rate|audit findings|days? (late|overdue|sales outstanding))\b/i;
/** Direction against a comparison point. */
const MOVEMENT = /\b(from\s+\S+\s+to\s+\S+|up\b|down\b|increased?|decreased?|reduc(ed|tion)|grew|growth|cut|fell|rose|dropped|climbed|improved|improvement|doubled|halved|tripled|vs\.?|versus|against (a |the )?(target|plan|budget|baseline|prior|previous)|(on|over|versus) (the )?(prior|previous|last) (year|quarter|period)|yoy|year[- ]on[- ]year|ahead of (target|plan|budget)|below (target|budget|plan)|above (target|plan)|to (zero|nil))\b/i;
/** Something completed. */
const DELIVERABLE = /\b(launch(ed|ing)?|shipped|shipping|delivered|delivering|completed|completing|completion|released?|releasing|went live|go-?live|live in|opened|opening|closed|closing|signed|signing|secured|securing|won|winning|migrated|migration|implemented|implementation|rolled out|roll-?out|published|publishing|passed|achieved|certif(ied|ication)|accredit(ed|ation)|acquisition|acquired|merger|merged|ipo|listing|audit|tender|contract|deal|funding|round|series [a-d]|mvp|v\d|version \d|product|platform|app|site|store|office|warehouse|factory|programme|program|project|pilot|trial|rebrand|relaunch|restructure|transformation|integration|upgrade|cutover|first \w+)\b/i;
/** Against what deadline. */
const DEADLINE = /\b(on time|on schedule|ahead of (schedule|plan|time|deadline)|before (the )?deadline|by the deadline|to deadline|within (the )?(deadline|timeline|window)|in (record|good) time|early|late by|two weeks? (early|late)|a (week|month) (early|late)|day one|from day one|first (day|week|month|quarter|year))\b/i;
/** Why it mattered. */
const SIGNIFICANCE = /\b(first|largest|biggest|fastest|highest|lowest|only|record|flagship|critical|strategic|key|major|landmark|company-?wide|group-?wide|global|national|multi-?million|multi-?year|enabl(ed|es|ing)|unlock(ed|s|ing)|allow(ed|s|ing)|made it possible|paving the way|laid the (foundation|groundwork)|foundation for|regulatory|mandatory|statutory|required for|at stake|would have|otherwise|without which|ahead of (a|the) (deadline|audit|launch|listing|inspection))\b/i;
/** Observable behaviour, not a trait word. */
const BEHAVIOUR = /\b(coach(ed|ing)|mentor(ed|ing)|facilitat(ed|ing)|negotiat(ed|ing)|listen(ed|ing)|challeng(ed|ing)|escalat(ed|ing)|align(ed|ing)|influenc(ed|ing)|persuad(ed|ing)|partner(ed|ing) with|present(ed|ing) to|briefed|briefing|document(ed|ing)|wrote (up|down)|writing up|explain(ed|ing)|translat(ed|ing)|brought together|bringing together|pushed back|pushing back|asked|invited|delegat(ed|ing)|empower(ed|ing)|gave feedback|giving feedback|1:1s?|one-to-ones?|one-on-ones?|weekly|fortnightly|daily|ritual|retros?|retrospectives?|stand-?ups?|workshops?|paired|pairing|shadow(ed|ing)|walked (them|the team) through|sat with|sat down with|checked in|checking in|handed over|held (the|a) line|said no|made the call|took the decision|owned the (mistake|error|miss)|apologised|apologized|celebrated|recognised|recognized|hired for|interviewed|onboarded|set expectations|agreed|co-?wrote|co-?designed|co-?created|ran (a|the|weekly|monthly)|kept (everyone|them|the team) (informed|updated|in the loop))\b/i;
/** Who the behaviour was with. */
const COUNTERPART = /\b(team|teams|peers?|engineers?|developers?|designers?|analysts?|sales|marketing|finance|product|ops|operations|legal|hr|leadership|senior (leaders?|leadership|stakeholders?|management)|execs?|executives?|the board|ceo|cfo|coo|cto|cpo|cmo|directors?|vps?|founders?|clients?|customers?|stakeholders?|colleagues?|(direct )?reports?|juniors?|graduates?|apprentices?|new (starters|hires|joiners)|suppliers?|vendors?|partners?|agencies|agency|contractors?|consultants?|auditors?|regulators?|cross-?functional|across (the )?(business|functions|teams|departments|organisation|organization)|other (teams|functions|departments))\b/i;
/** A moment or a thing a reader could check. */
const INSTANCE = /\b(when|during|while|after|once|at the (time|point)|the (week|day|night|month|quarter|year) (we|I|the)|in 20\d{2}|last year|this year|ahead of (the|a)|on (the|a) \w+ (project|programme|program|launch|migration|deal|bid|audit|incident|outage|review))\b/i;
/** What the behaviour led to. */
const EFFECT = /\b(so that|which|led to|got \w+ to|agreed?|promot(ed|ion)|into (senior|new|bigger|leadership) roles?|leading to|resulted in|resulting in|meant|meaning|enabled|enabling|allowed|allowing|got (us|them|it|the)|landed|agreed|reached|delivered|unblocked|kept|retained|avoided|reduced|improved|faster|earlier|sooner|without (a|any)|no (further|more)|on track|back on track|signed off|approved|adopted|stuck|held|trusted|came back|stayed|renewed)\b/i;
/** A row that opens with what the person did reads as theirs: "Launched…", "Delivered…". */
const LEADS_WITH_VERB = /^(led|launched|shipped|delivered|completed|built|migrated|implemented|rolled out|opened|closed|signed|secured|won|ran|owned|managed|set up|established|created|designed|negotiated|introduced|rebuilt|redesigned|automated|restructured|consolidated|replaced|hired|trained|wrote|drove|headed|oversaw|co-?ordinated|coordinated)\b/i;
/** A capitalised word that is not simply the one the row opens with. */
function namesSomething(row: string): boolean {
  return row.split(/\s+/u).filter(Boolean).slice(1).some(word => /^\p{Lu}/u.test(word));
}
/** A concrete noun a Responsibilities row owns: a function, process, product, market or system. */
const OWNED_THING = /\b(function|process(es)?|product(s)?|portfolio|market(s)?|region(s)?|territory|budget|p&l|forecast(ing)?|planning|reporting|payroll|accounts?|ledger|audit|controls?|compliance|risk|treasury|tax|pricing|procurement|supply chain|logistics|warehouse|inventory|stock|operations|sales|pipeline|marketing|brand|campaigns?|content|seo|crm|roadmap|backlog|platform|system(s)?|infrastructure|data|analytics|dashboards?|models?|hiring|recruitment|onboarding|training|programme|program|project(s)?|projects|clients?|customers?|service|support|delivery|quality|safety|facilities|fleet|estate|contracts?|vendors?|suppliers?|partnerships?|strategy|governance|board (papers|reporting|packs?)|month-?end|year-?end|close|consolidation|fp&a|kpis?)\b/i;
/** Who a Responsibilities row served. */
const AUDIENCE = /\b((for|to|across|with|on behalf of|serving|supporting|advising|reporting to|reporting into|answering to|alongside)\s+(the\s+|a\s+|our\s+|its\s+|all\s+|senior\s+|c-?suite\s+|\d+\s+)?(board|exec(utive)?s?|executive team|leadership( team)?|slt|elt|c-?suite|ceo|cfo|coo|cto|cpo|cmo|md|managing director|directors?|partners?|founders?|investors?|shareholders?|team|teams|clients?|customers?|users?|group|regions?|business(es)?|company|companies|division|divisions|brands?|stakeholders?|departments?|markets?|sites?|stores?|countries|entities|subsidiaries|colleagues|staff|employees|engineers|emea|apac|uk|us|europe|north america|latam|ireland|nordics|dach|benelux|middle east|africa|asia|australia))\b/i;

/**
 * The marks a row's own wording earns, judged by rules alone, for every type at once.
 *
 * This is the score shown live as someone types and tags, and the baseline an account without a
 * model review sees. Every detector is deliberately a shortlist of the words a strong row uses:
 * see the note above on which way the errors are allowed to fall.
 */
export function detectEvidenceMarks(row: string): EvidenceMark[] {
  const text = row.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text) return [];
  const words = text.split(" ").length;
  const quantity = QUANTITY.test(text);
  const sized = quantity || (NUMBER_WORD.test(text) && UNIT.test(text));
  const period = PERIOD.test(text) || MONTH.test(text) || DEADLINE.test(text);
  const action = ACTION.test(text);
  const ownership = OWNERSHIP.test(text);
  const checks: Record<EvidenceMark, boolean> = {
    "responsibility.scope": words >= 5 && (OWNED_THING.test(text) || namesSomething(text)),
    "responsibility.audience": AUDIENCE.test(text),
    "responsibility.ownership": ownership,
    "responsibility.scale": sized || /\b(team of|headcount of|budget of|across \d|\d+\s*(people|reports|sites|markets|countries|entities|clients|customers|stores|offices))\b/i.test(text),
    "problem.situation": /\b(problems?|issues?|backlog|failing|failed|failure|broken|manual(ly)?|late|delays?|delayed|overdue|over budget|overspend|overrun|churn(ing)?|attrition|risk|gap|bottleneck|errors?|inaccura(te|cies)|unreliable|inconsistent|legacy|slow|missing|no (process|system|owner|visibility|data|budget|team)|lack(ed|ing)? of|without (a|any)|shortfall|losses|loss-?making|complaints?|outages?|breach|debt|duplicate[sd]?|siloed|fragmented|ad[- ]hoc|spreadsheets?|firefighting|understaffed|under-?resourced|unprofitable|declining|falling|stalled|blocked|struggling|at risk|non-?compliant|audit findings?|qualified opinion)\b/i.test(text),
    "problem.constraint": /\b(because|due to|caused by|as a result of|root cause|constrained|constraints?|deadline|within (\d+|a|two|three|six) (days|weeks|months)|with no|without (a|any)|limited|tight|under pressure|legacy|regulat(ory|ion|or)|compliance|budget of|only (\d+|one|two|three)|before the|ahead of (the|a)|by (q[1-4]|\w+ 20\d{2}|year[- ]end|month[- ]end)|while|despite|in spite of|inherited|had to|could not|couldn't|no (budget|headcount|team|time)|frozen|hiring freeze|during (the|a) (pandemic|downturn|merger|acquisition|migration|freeze))\b/i.test(text),
    "problem.approach": action && words >= 6,
    "problem.resolution": RESOLUTION.test(text),
    "outcome.change": CHANGE.test(text),
    "outcome.cause": CAUSE.test(text) || (action && /\b(by|through|via|after|which|that)\b/i.test(text)),
    "outcome.beneficiary": BENEFICIARY.test(text),
    "outcome.magnitude": sized || /\b(from\s+\S+\s+to\s+\S+|by (a )?(third|half|quarter)|x\d|\d+x|per ?cent|fold|half|halved|double[d]?|triple[d]?|every|zero|first|largest|all \w+ (sites|teams|markets|countries|regions))\b/i.test(text),
    "metric.figure": quantity,
    "metric.measure": MEASURE.test(text),
    "metric.movement": MOVEMENT.test(text),
    "metric.driver": action || ownership || period,
    "milestone.deliverable": DELIVERABLE.test(text) && (words >= 5 || namesSomething(text)),
    "milestone.timing": period,
    "milestone.role": ownership || LEADS_WITH_VERB.test(text) || /\b(co-?ordinated|coordinated|as (the )?(lead|pm|project manager|owner|sponsor)|I\b|we\b)/.test(text),
    "milestone.significance": SIGNIFICANCE.test(text) || quantity,
    "style.behaviour": BEHAVIOUR.test(text),
    "style.counterpart": COUNTERPART.test(text),
    "style.instance": INSTANCE.test(text) || (words >= 8 && (namesSomething(text) || quantity)),
    "style.effect": EFFECT.test(text),
  };
  return EVIDENCE_MARKS.filter(mark => checks[mark]);
}
