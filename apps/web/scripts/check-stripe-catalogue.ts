import { checkStripeCatalogue } from "../lib/billing/stripe-catalogue-check";

const args = process.argv.slice(2);
if (args.length !== 1 || !/^--mode=(test|live)$/.test(args[0]!)) {
  console.error("Usage: pnpm check:stripe-catalogue --mode=test|live");
  process.exitCode = 2;
} else {
  const mode = args[0]!.slice("--mode=".length) as "test" | "live";
  const result = await checkStripeCatalogue(process.env, mode);
  for (const message of result.errors) console.error(`ERROR: ${message}`);
  for (const message of result.attention) console.warn(`ATTENTION: ${message}`);
  if (!result.errors.length) console.log(`Stripe ${mode} Price catalogue verified read-only; check webhooks, Portal, tax and receipts separately.`);
  process.exitCode = result.errors.length ? 1 : 0;
}
