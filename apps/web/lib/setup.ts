/** Outcome-based setup: monitoring starts with chosen filters, a company and a successful scan. */
export const COMPANIES_TARGET = 1;

export interface MonitoringFacts {
  /** Active subscriptions only; paused companies cannot deliver first value. */
  activeCompanies: number;
  successfulCompanies: number;
  attentionCompanies: number;
  pendingCompanies: number;
  /** Read only when company work is queued or running. */
  workerState?: "healthy" | "restarting" | "stopped";
  /** Latest complete successful scan of a currently followed source. */
  lastSuccessAt: string | null;
}
export interface SetupFacts {
  emailConfirmed: boolean;
  gateChosen: boolean;
  seedProfileWritten: boolean;
  companiesFollowed: number;
  libraryFilled: boolean;
  dismissedAt: string | null;
  monitoring: MonitoringFacts;
}
export interface SetupStep {
  id: "email" | "gate" | "companies" | "first-scan";
  label: string;
  shortLabel: string;
  description: string;
  href: string;
  done: boolean;
  progress?: string;
}
export interface MonitoringNotice {
  state: "preferences" | "no-companies" | "attention" | "working" | "monitoring-paused" | "complete" | "waiting";
  title: string;
  description: string;
  href: string;
  action: string;
}
export interface SetupChecklist {
  steps: SetupStep[];
  doneCount: number;
  total: number;
  complete: boolean;
  summary: string;
  nextStep: SetupStep | null;
  dismissed: boolean;
  notice: MonitoringNotice;
  /** These improve ranking/CVs; they never block monitoring. */
  seedProfileWritten: boolean;
  libraryFilled: boolean;
}

export const GATE_SENTENCE = "A role is kept only when its title contains one of these words and it is in one of these places or remote.";
export const GATE_EXAMPLE = "e.g. operations, chief of staff, programme";
export const CHOOSE_GATE_SENTENCE = "Choose your keywords and locations first, so the first scan runs against your filters.";
export const GATE_NEEDS_KEYWORD_SENTENCE = "Enter at least one keyword.";

/** Never infer that nothing ran from an empty roles table. */
export function monitoringNotice(facts: SetupFacts): MonitoringNotice {
  const m = facts.monitoring;
  if (!facts.gateChosen) return { state: "preferences", title: "Choose the roles you want to see", description: "Set your keywords and locations, then follow a company. You can prepare your CV evidence later.", href: "/settings#keywords", action: "Choose preferences" };
  if (!m.activeCompanies) return { state: "no-companies", title: "Follow a company to start watching", description: facts.companiesFollowed ? "Your followed companies are paused. Resume one, or choose another company." : "Choose an employer you are interested in. AVA will find its careers page and check it for your roles.", href: facts.companiesFollowed ? "/companies" : "/suggestions", action: facts.companiesFollowed ? "Manage companies" : "Follow a company" };
  if (m.attentionCompanies > 0) return { state: "attention", title: `${m.attentionCompanies} ${m.attentionCompanies === 1 ? "company needs" : "companies need"} attention`, description: "A careers source is missing, awaiting confirmation or has an incomplete or unsuccessful scan. An empty list does not mean there are no suitable roles.", href: "/health", action: "Resolve on Health" };
  if (m.pendingCompanies > 0 && m.workerState === "stopped") return { state: "monitoring-paused", title: "Company checks are waiting for monitoring", description: "Company work is unfinished, and the background worker has not reported. An administrator needs to restore monitoring. Check Health for details.", href: "/health", action: "Check monitoring on Health" };
  if (m.pendingCompanies > 0 && m.workerState === "restarting") return { state: "monitoring-paused", title: "Company checks may be delayed", description: "The background worker is restarting while company work is unfinished. Check Health for monitoring status before treating an empty list as a result.", href: "/health", action: "Check monitoring on Health" };
  if (m.pendingCompanies > 0) return { state: "working", title: "Checking your companies", description: "Discovery or scanning is queued or running. Verified matching roles can appear while a long listing is still being checked; follow progress on Companies.", href: "/companies", action: "View progress" };
  if (m.successfulCompanies > 0 && m.successfulCompanies < m.activeCompanies) return { state: "waiting", title: `${m.successfulCompanies} of ${m.activeCompanies} companies checked`, description: "Monitoring has started, but some companies have no complete successful scan yet. Check their progress before treating an empty list as a complete result.", href: "/companies", action: "Check remaining companies" };
  if (m.successfulCompanies > 0) return { state: "complete", title: "Your companies have been checked", description: "A complete scan has finished. If your list is empty, no roles are waiting in this view; check your preferences or follow another company. A CV Library is not needed to receive roles.", href: "/settings#keywords", action: "Review preferences" };
  return { state: "waiting", title: "Waiting for a complete scan", description: "No complete successful scan is recorded for your active companies yet. Check their source and progress before treating an empty list as a result.", href: "/companies", action: "Check companies" };
}

export function buildSetupChecklist(facts: SetupFacts): SetupChecklist {
  const followed = Math.max(0, facts.monitoring.activeCompanies);
  const notice = monitoringNotice(facts);
  const steps: SetupStep[] = [
    { id: "email", shortLabel: "Email", label: "Confirm your email", description: "Scans, discovery and CV builds wait for it.", href: "/account", done: facts.emailConfirmed },
    { id: "gate", shortLabel: "Preferences", label: "Choose keywords and locations", description: "They decide which roles reach your table.", href: "/settings#keywords", done: facts.gateChosen },
    { id: "companies", shortLabel: "Company", label: "Follow a company", description: "Start with one employer; you can add several together.", href: "/suggestions", done: followed >= COMPANIES_TARGET, progress: followed ? `${followed} following` : undefined },
    { id: "first-scan", shortLabel: "First scan", label: facts.monitoring.successfulCompanies ? "First complete scan finished" : "Check the first scan", description: "A complete successful scan confirms the first check finished. Matching roles may appear sooner.", href: notice.state === "attention" || notice.state === "monitoring-paused" ? notice.href : "/companies", done: facts.monitoring.successfulCompanies > 0 },
  ];
  const doneCount = steps.filter(step => step.done).length;
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length, summary: `${doneCount} of ${steps.length} done`, nextStep: steps.find(step => !step.done) ?? null, dismissed: facts.dismissedAt !== null, notice, seedProfileWritten: facts.seedProfileWritten, libraryFilled: facts.libraryFilled };
}
export type MilestoneState = "done" | "current" | "todo";
export interface SetupMilestone extends SetupStep { state: MilestoneState }
export function setupMilestones(checklist: Pick<SetupChecklist, "steps" | "nextStep">): SetupMilestone[] {
  return checklist.steps.map(step => ({ ...step, state: step.done ? "done" : step.id === checklist.nextStep?.id ? "current" : "todo" }));
}
