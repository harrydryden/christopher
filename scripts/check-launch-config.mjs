/** Offline launch configuration check. Never prints a credential or contacts a provider. */
import { pathToFileURL } from "node:url";

const PRICE_NAMES = [
  "STRIPE_PRICE_SEARCH_MONTHLY", "STRIPE_PRICE_INTENSIVE_MONTHLY",
  "STRIPE_PRICE_CV_5", "STRIPE_PRICE_CV_10", "STRIPE_PRICE_CV_20",
  "STRIPE_PRICE_COMPANY_BLOCK_MONTHLY",
];
const present = (env, name) => Boolean(env[name]?.trim());
const exampleDomain = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost|local)$/i;

export function launchConfigFindings(env = process.env, { surface = "web", mode = "live" } = {}) {
  if (!["web", "worker"].includes(surface)) throw new Error("surface must be web or worker");
  if (!["live", "test"].includes(mode)) throw new Error("mode must be live or test");
  const errors = [];
  const attention = [];
  const requireValue = (name) => { if (!present(env, name)) errors.push(`${name} is unset`); };

  requireValue("DATABASE_URL");
  if (surface === "web") {
    for (const name of ["SESSION_SECRET", "APP_URL", "RESEND_API_KEY", "EMAIL_FROM",
      "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", ...PRICE_NAMES]) requireValue(name);
  } else {
    for (const name of ["ANTHROPIC_API_KEY", "SCRAPER_CONTACT_EMAIL"]) requireValue(name);
  }

  if (present(env, "DATABASE_URL")) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { errors.push("DATABASE_URL must be a PostgreSQL URL"); }
  }
  if (surface === "web" && present(env, "SESSION_SECRET") &&
    (env.SESSION_SECRET.length < 32 || env.SESSION_SECRET === "change-me-to-a-long-random-string")) {
    errors.push("SESSION_SECRET must be at least 32 characters and differ from the example");
  }
  if (surface === "web" && present(env, "APP_URL")) {
    try {
      const url = new URL(env.APP_URL);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || exampleDomain.test(url.hostname)) throw new Error();
    } catch { errors.push("APP_URL must be a public HTTPS origin"); }
  }
  if (surface === "worker" && present(env, "SCRAPER_CONTACT_EMAIL")) {
    const email = env.SCRAPER_CONTACT_EMAIL.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || exampleDomain.test(email.split("@")[1])) {
      errors.push("SCRAPER_CONTACT_EMAIL must be a reachable, non-example email address");
    }
  }
  if (surface === "web" && present(env, "STRIPE_SECRET_KEY") && !new RegExp(`^sk_${mode}_\\S+$`).test(env.STRIPE_SECRET_KEY.trim())) {
    errors.push(`STRIPE_SECRET_KEY must be a Stripe ${mode} secret key`);
  }
  if (surface === "web" && present(env, "STRIPE_WEBHOOK_SECRET") && !/^whsec_\S+$/.test(env.STRIPE_WEBHOOK_SECRET.trim())) {
    errors.push("STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret");
  }
  const prices = new Map();
  for (const name of surface === "web" ? PRICE_NAMES : []) {
    if (!present(env, name)) continue;
    const id = env[name].trim();
    if (!/^price_\S+$/.test(id)) errors.push(`${name} must be a Stripe Price id`);
    if (prices.has(id)) errors.push(`${name} duplicates ${prices.get(id)}`);
    prices.set(id, name);
  }

  if (surface === "web") {
    if (!present(env, "ADMIN_EMAILS")) attention.push("ADMIN_EMAILS is unset; the built-in administrator address will apply");
    if (env.AUTH_EMAIL_LOG === "1") errors.push("AUTH_EMAIL_LOG=1 exposes confirmation and reset links in production logs");
    attention.push("Verify Stripe Price amounts, currency, tax settings, webhook subscriptions and Customer Portal configuration in Stripe; this offline check cannot inspect them");
  }
  for (const name of surface === "worker" ? ["DAILY_AI_BUDGET_USD", "DISCOVERY_AI_BUDGET_USD"] : []) {
    if (!present(env, name)) {
      attention.push(`${name} is unset; this deployment-wide spend cap is unlimited`);
    } else {
      const amount = Number(env[name]);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) errors.push(`${name} must be a number from 0 to 1000000`);
      else if (amount === 1_000_000) attention.push(`${name}=1000000 is effectively unlimited`);
    }
  }
  attention.push("Review customer-set AI budgets against paid-plan revenue and expected account count; CV credits do not cap other AI work");
  return { errors, attention };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valid = args.length === 2 && args.some(arg => /^--surface=(web|worker)$/.test(arg)) &&
    args.some(arg => /^--mode=(live|test)$/.test(arg));
  if (!valid) {
    console.error("Usage: node scripts/check-launch-config.mjs --surface=web|worker --mode=live|test");
    process.exitCode = 2;
  } else {
    const surface = args.find(arg => arg.startsWith("--surface=")).split("=")[1];
    const mode = args.find(arg => arg.startsWith("--mode=")).split("=")[1];
    const { errors, attention } = launchConfigFindings(process.env, { surface, mode });
    for (const message of errors) console.error(`ERROR: ${message}`);
    for (const message of attention) console.warn(`ATTENTION: ${message}`);
    if (!errors.length) console.log(`Offline ${mode} ${surface} configuration check passed; review attention items before launch.`);
    process.exitCode = errors.length ? 1 : 0;
  }
}
