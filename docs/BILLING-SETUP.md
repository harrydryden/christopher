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

Enable plan changes, cancellation, payment-method updates and subscription-item quantity changes
in Stripe Customer Portal. The company-block price may be added only to Search, with a maximum
quantity of five. Intensive already reaches the 200-company technical ceiling.

Run migration `0055_billing_credits` before enabling Checkout. Test a plan purchase, each top-up,
webhook retries, a failed renewal and a portal cancellation in Stripe test mode before copying the
catalogue to live mode.
