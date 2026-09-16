import { headers } from "next/headers";
import { emailConfigured } from "./email";

/**
 * The origin for links in emails. APP_URL is authoritative. Without it, the request's own host is
 * used only where the link cannot leave the server (no email provider, so it goes to the log) or
 * outside production: a real email carrying a host-derived link could be poisoned by a spoofed header.
 */
export async function emailLinkOrigin(): Promise<string | null> {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production" && emailConfigured()) {
    console.error(JSON.stringify({ event: "email_origin_missing", hint: "Set APP_URL to this deployment's public origin so emailed links can be built safely." }));
    return null;
  }
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || "localhost";
  return `${proto}://${host}`;
}

/** Build a same-site redirect target with query parameters, dropping blanks. */
export function withParams(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, "http://internal");
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}
