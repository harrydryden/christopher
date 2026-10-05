/**
 * Tracing for the interface: Next.js's own route, render and fetch spans, head-sampled at 10 % and
 * exported over OTLP by @vercel/otel, so a slow page splits into database wait and render.
 *
 * Off unless asked for, like the worker's (apps/worker/src/otel.ts): registered only when
 * OTEL_SDK_DISABLED is "false" and OTEL_EXPORTER_OTLP_ENDPOINT names a collector (or Vercel's OTel
 * integration supplies one). No span attribute carries an account id, email or CV text; Next's
 * spans name routes, not their parameters. docs/DEPLOY.md, "Tracing", says how to turn it on.
 */
export function otelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "false" && !!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !otelEnabled()) return;
  // traceidratio reads its ratio from here; 10 % unless the deployment says otherwise.
  process.env.OTEL_TRACES_SAMPLER_ARG ??= "0.1";
  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME?.trim() || "col-web", traceSampler: "traceidratio" });
}
