# Billing setup

The application is safe to run without Stripe. Every account receives Free with 25 active-company
places and three lifetime CV credits; paid checkout buttons return to Account with an availability
notice until Stripe is configured.

## Stripe test-mode catalogue

Create these GBP prices in Stripe test mode and copy their Price ids into the matching environment
variables. Customer-facing prices include VAT.

| Environment variable | Stripe price | Type |
|---|---:|---|
| `STRIPE_PRICE_SEARCH_MONTHLY` | £29/month | Recurring |
| `STRIPE_PRICE_INTENSIVE_MONTHLY` | £49/month | Recurring |
| `STRIPE_PRICE_CV_5` | £5 | One-off |
| `STRIPE_PRICE_CV_10` | £9 | One-off |
| `STRIPE_PRICE_CV_20` | £15 | One-off |
| `STRIPE_PRICE_COMPANY_BLOCK_MONTHLY` | £1/month | Recurring, quantity is the number of ten-company blocks |

Set `STRIPE_SECRET_KEY` to the test secret key. Add a webhook endpoint at
`https://<app-host>/api/webhooks/stripe`, subscribe it to the events below, and set its signing
secret as `STRIPE_WEBHOOK_SECRET`.

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`

Enable plan changes, cancellation and payment-method updates in Stripe Customer Portal. Do not
enable customer-controlled quantity changes: Course of Life previews and signs each company-capacity change
itself, limits the company-block price to Search and caps it at five blocks. Intensive already
reaches the 200-company technical ceiling.

Run database migrations through `0060_evidence_drafts` before enabling Checkout. Test a plan purchase, each top-up,
webhook retries, a failed renewal and a portal cancellation in Stripe test mode before copying the
catalogue to live mode.

Before enabling live Checkout, run `pnpm check:launch-config --surface=web --mode=live` with the web
deployment settings, then `pnpm check:launch-config --surface=worker --mode=live` with the worker
settings. Use `--mode=test` explicitly when checking a test-mode Stripe setup. The two commands
check required names and formats offline; they do not contact Stripe, verify Price amounts or
currency, or prove that the webhook and Customer Portal are configured. They print setting names
only, never credential values. The worker command also highlights
the optional deployment-wide AI spend caps, which are unlimited when unset.

With an explicit Stripe test or live secret key in `STRIPE_SECRET_KEY`, run
`pnpm check:stripe-catalogue --mode=test` or `pnpm check:stripe-catalogue --mode=live` against the
matching six Price ids. This makes six read-only Stripe Price requests and checks that each is
active, in the selected mode, GBP, the amount above, and either a fixed one-off price or a
licensed monthly price as appropriate. It reports setting names rather than Price ids or provider
response bodies. An exclusive `tax_behavior` conflicts with the customer-facing VAT-inclusive
price and fails; an unspecified value needs manual confirmation of the Stripe Tax default and the
checkout total. The command does not prove tax compliance, webhook subscriptions, Portal settings
or receipt delivery. Use the offline command first; this optional check requires Stripe network
access but makes no purchase or configuration change.

Before an administrator deletes a paid or recently checked-out account, reconcile that customer's
open Checkout sessions and subscription in Stripe. The application blocks deletion when a
subscription id is already stored, but a Checkout session can be in flight before its webhook
persists that id. The guard alone does not prove charges have stopped.
