import Link from "next/link";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";

/** The read model supplied by billing; this component never reads payment state itself. */
export interface BillingSummaryView {
  plan: "free" | "search" | "intensive";
  status: string;
  monthlyPriceGbp?: number;
  cancelAtPeriodEnd?: boolean;
  cv: {
    available: number;
    reserved: number;
    monthly: number;
    welcome: number;
    purchased: number;
    nextGrantAt: Date | string | null;
  };
  companies: {
    active: number;
    included: number;
    paidBlocks: number;
    capacity: number;
    technicalMax: number;
  };
  renewalAt: Date | string | null;
  paymentNeedsAttention: boolean;
}

export interface BillingActions {
  startPlanCheckout: (formData: FormData) => Promise<void>;
  startCreditCheckout: (formData: FormData) => Promise<void>;
  openBillingPortal: () => Promise<void>;
}

const PLANS = [
  { name: "Free", price: "£0", companies: "25", cvs: "First 3 CVs" },
  { name: "Search", price: "£29/month", companies: "100", cvs: "10 CV credits/month" },
  { name: "Intensive", price: "£49/month", companies: "200", cvs: "20 CV credits/month" },
] as const;

const TOP_UPS = [
  { credits: 5, price: "£5" },
  { credits: 10, price: "£9" },
  { credits: 20, price: "£15" },
] as const;

function planName(plan: BillingSummaryView["plan"]): string {
  return plan === "search" ? "Search" : plan === "intensive" ? "Intensive" : "Free";
}

function dateLabel(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

/** A linked account readout, small enough for the sidebar and phone navigation. */
export function PlanReadout({ billing, mobile = false }: { billing: BillingSummaryView; mobile?: boolean }) {
  const label = planName(billing.plan);
  return <Link prefetch={false} href="/account#plan-and-credits"
    className={mobile
      ? "inline-flex min-h-11 min-w-0 items-center truncate text-12 text-brand-ink-muted underline decoration-dotted md:hidden"
      : "block min-h-11 py-2 text-12 text-brand-ink-muted underline decoration-dotted hover:text-brand-ink"}
    aria-label={`${label} plan, ${billing.cv.available} CV ${billing.cv.available === 1 ? "credit" : "credits"} available. Open plan and credits.`}>
    {label} · {billing.cv.available} CV {billing.cv.available === 1 ? "credit" : "credits"}
  </Link>;
}

/** The account is the only persistent home for pricing, usage and billing actions. */
export function BillingOverview({ billing, actions }: { billing: BillingSummaryView; actions?: BillingActions }) {
  const label = planName(billing.plan);
  const renewal = dateLabel(billing.renewalAt);
  const nextGrant = dateLabel(billing.cv.nextGrantAt);
  return <div id="plan-and-credits" className="space-y-4 scroll-mt-4">
    <Card title="Plan and credits" actions={<div className="flex flex-wrap items-center gap-2">
      <Badge tone="green">{label}</Badge>
      {actions && billing.plan !== "free" && <form action={actions.openBillingPortal}>
        <Button type="submit" size="sm">Manage plan, capacity and payment</Button>
      </form>}
    </div>}>
      {billing.paymentNeedsAttention && <p role="alert" className="mb-4 border-2 border-warn p-3 text-13 text-warn">
        Your payment needs attention. Update your payment details to keep your plan active.
      </p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="font-semibold">CV credits</h3>
          <p className="mt-1 text-20 font-semibold tabular-nums">{billing.cv.available} available</p>
          <p className="text-13 text-muted">
            {billing.cv.welcome} welcome · {billing.cv.monthly} monthly · {billing.cv.purchased} purchased
            {billing.cv.reserved > 0 && <> · {billing.cv.reserved} in use</>}
          </p>
          {nextGrant && <p className="mt-1 text-12 text-muted">Next monthly credits: {nextGrant}.</p>}
        </div>
        <div>
          <h3 className="font-semibold">Company monitoring</h3>
          <p className="mt-1 text-20 font-semibold tabular-nums">{billing.companies.active} of {billing.companies.capacity} active</p>
          <p className="text-13 text-muted">
            {billing.companies.included} included
            {billing.companies.paidBlocks > 0 && <> · {billing.companies.paidBlocks * 10} extra slots</>}
          </p>
          {billing.plan === "search" && <p className="mt-1 text-12 text-muted">Add 10 slots for £1/month, up to 150 active companies. Manage capacity above.</p>}
        </div>
      </div>
      {billing.plan !== "free" && typeof billing.monthlyPriceGbp === "number" &&
        <p className="mt-4 border-t border-line-faint pt-3 text-13">Current plan and company capacity: <strong>£{billing.monthlyPriceGbp}/month</strong>.</p>}
      {renewal && <p className="mt-1 text-13">{billing.cancelAtPeriodEnd ? "Your paid plan ends" : "Your plan renews"} on {renewal}.</p>}
      <p className="mt-3 text-12 text-muted">One credit is used when a tailored CV is successfully saved. Paused companies do not use monitoring slots.</p>
    </Card>

    <Card title="Plans" className="scroll-mt-4" bodyClassName="p-0">
      <div id="plans" className="grid divide-y divide-line-faint sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {PLANS.map(plan => <div key={plan.name} className="space-y-1 p-4 text-13">
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{plan.name}</h3>{plan.name === label && <Badge tone="green">Current</Badge>}</div>
          <p className="text-16 font-semibold">{plan.price}</p>
          <p>{plan.companies} active companies</p>
          <p>{plan.cvs}</p>
          {actions && billing.plan === "free" && plan.name !== "Free" && <form action={actions.startPlanCheckout} className="pt-2">
            <input type="hidden" name="plan" value={plan.name.toLowerCase()} />
            <input type="hidden" name="returnTo" value="/account" />
            <Button type="submit" variant="secondary" size="sm">Choose {plan.name}</Button>
          </form>}
        </div>)}
      </div>
      <p className="border-t border-line-faint p-4 text-12 text-muted">Search can add up to 50 more active companies in blocks of 10 for £1/month per block. Prices include VAT. {billing.plan !== "free" && "Change or cancel your plan using Manage plan, capacity and payment above."}</p>
    </Card>

    <Card title="CV top-ups" className="scroll-mt-4">
      <p className="mb-3 text-13 text-muted">Buy credits when you need more. Purchased credits do not expire.</p>
      <ul id="top-ups" className="flex flex-wrap gap-3">
        {TOP_UPS.map(pack => <li key={pack.credits} className="space-y-2 border border-line-muted px-3 py-2 text-13">
          <p><strong>{pack.credits} CV credits</strong> · {pack.price}</p>
          {actions && <form action={actions.startCreditCheckout}>
            <input type="hidden" name="pack" value={`cv${pack.credits}`} />
            <input type="hidden" name="returnTo" value="/account" />
            <Button type="submit" size="sm">Buy {pack.credits}</Button>
          </form>}
        </li>)}
      </ul>
    </Card>
  </div>;
}
