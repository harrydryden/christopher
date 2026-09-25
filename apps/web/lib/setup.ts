/**
 * The setup checklist: five steps, each derived from a row that already exists, each linking to the
 * exact field that finishes it.
 *
 * Nothing here reads the database. `setupStatus` in `lib/queries/setup.ts` gathers the facts for one
 * account and this turns them into labels, links and counts, so the wording and the ordering are
 * unit-testable and the query stays one round of reads.
 */

/** How many companies make a table worth reading on the first morning. */
export const COMPANIES_TARGET = 3;

/** What the checklist needs to know about an account. Every field is read per account. */
export interface SetupFacts {
  /** The address is confirmed, or this account is an administrator and was never held back. */
  emailConfirmed: boolean;
  /** A `gate` row exists in `user_settings`: these filters were chosen, not defaulted into. */
  gateChosen: boolean;
  seedProfileWritten: boolean;
  /** Companies this account follows and has not archived. */
  companiesFollowed: number;
  /** The latest saved Library has at least one experience entry. */
  libraryFilled: boolean;
  /** When the checklist was hidden, or null while it has never been hidden. */
  dismissedAt: string | null;
}

export interface SetupStep {
  id: "email" | "gate" | "seed-profile" | "companies" | "library";
  label: string;
  /** The one or two words under its milestone, where the full label would not fit five abreast. */
  shortLabel: string;
  /** One sentence on why the step is here, in the product's voice: the line under the milestones. */
  description: string;
  /** The exact field, not the page it lives on. */
  href: string;
  done: boolean;
  /** "1 of 3" for the step that counts; absent for the steps that are simply done or not. */
  progress?: string;
}

export interface SetupChecklist {
  steps: SetupStep[];
  doneCount: number;
  total: number;
  complete: boolean;
  /** "2 of 5 done". */
  summary: string;
  /** The first step still to do, or null once they are all done. */
  nextStep: SetupStep | null;
  /** This account hid the checklist. It is still shown when the table is empty. */
  dismissed: boolean;
}

/** The sentence under an empty table: a blank table means nothing has happened yet. */
export const EMPTY_TABLE_SENTENCE =
  "Nothing has run yet. Finish these steps to fill your table.";

/** What the gate does, in one sentence, wherever the gate is offered. */
export const GATE_SENTENCE =
  "A role is kept only when its title contains one of these words and it is in one of these places or remote.";

/** The example in an empty include-keywords field, so nobody scans against a word they never chose. */
export const GATE_EXAMPLE = "e.g. operations, chief of staff, programme";

/** Said on the form and by the action when a company is added before the filters are chosen. */
export const CHOOSE_GATE_SENTENCE = "Choose your keywords and locations first, so the first scan runs against your filters.";

/** At least one include keyword, so a saved gate never admits every role a company posts. */
export const GATE_NEEDS_KEYWORD_SENTENCE = "Enter at least one keyword.";

export function buildSetupChecklist(facts: SetupFacts): SetupChecklist {
  const followed = Math.max(0, facts.companiesFollowed);
  const steps: SetupStep[] = [
    {
      id: "email",
      shortLabel: "Email",
      label: "Confirm your email",
      description: "Scans, discovery and CV builds wait for it.",
      href: "/account",
      done: facts.emailConfirmed,
    },
    {
      id: "gate",
      shortLabel: "Filters",
      label: "Choose keywords and locations",
      description: "They decide which roles reach your table.",
      href: "/settings#keywords",
      done: facts.gateChosen,
    },
    {
      id: "seed-profile",
      shortLabel: "Seed profile",
      label: "Write the seed profile",
      description: "A few sentences on what you want; they seed the ranking.",
      href: "/settings#seed-profile",
      done: facts.seedProfileWritten,
    },
    {
      id: "companies",
      shortLabel: "Companies",
      label: `Follow ${COMPANIES_TARGET} companies`,
      description: "Each is scanned daily for matching roles.",
      href: "/suggestions",
      done: followed >= COMPANIES_TARGET,
      progress: `${Math.min(followed, COMPANIES_TARGET)} of ${COMPANIES_TARGET}`,
    },
    {
      id: "library",
      shortLabel: "Library",
      label: "Fill the Library",
      description: "Every CV is built from it.",
      href: "/library",
      done: facts.libraryFilled,
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  return {
    steps,
    doneCount,
    total: steps.length,
    complete: doneCount === steps.length,
    summary: `${doneCount} of ${steps.length} done`,
    nextStep: steps.find((step) => !step.done) ?? null,
    dismissed: facts.dismissedAt !== null,
  };
}

/** Where a milestone stands: finished, the one to do next, or waiting behind it. */
export type MilestoneState = "done" | "current" | "todo";

export interface SetupMilestone extends SetupStep {
  state: MilestoneState;
}

/**
 * The steps as the milestone row draws them. Exactly one is current while anything is left — the
 * first step not done, which is `nextStep` — so a step skipped early is the one pointed at, even
 * when later ones are finished.
 */
export function setupMilestones(checklist: Pick<SetupChecklist, "steps" | "nextStep">): SetupMilestone[] {
  return checklist.steps.map((step) => ({
    ...step,
    state: step.done ? "done" : step.id === checklist.nextStep?.id ? "current" : "todo",
  }));
}
