import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A per-source delivery address, so a newsletter can be subscribed to directly rather than
 * pasted in. LinkedIn emails every edition to its subscribers, which is the one route into a
 * LinkedIn newsletter that does not involve reading a page LinkedIn disallows.
 *
 * The local part is derived from the source id and the ingest secret, so it is stable, needs no
 * column of its own, and cannot be guessed by someone who knows the source id.
 */
export function addressTokenFor(sourceId: string, secret: string): string {
  return createHmac("sha256", secret).update(`newsletter:${sourceId}`)
    .digest("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 14).toLowerCase();
}

/** The domain an operator has pointed at this app's inbound endpoint, when they have. */
export function inboundDomain(): string | null {
  const domain = (process.env.NEWSLETTER_INBOUND_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

/** The address to subscribe with, or null when inbound email is not configured. */
export function subscribeAddressFor(sourceId: string): string | null {
  const secret = process.env.NEWSLETTER_INGEST_SECRET;
  const domain = inboundDomain();
  return secret && domain ? `${addressTokenFor(sourceId, secret)}@${domain}` : null;
}

/** The local part of a recipient header, tolerating `Name <token@host>` and plus-addressing. */
export function localPartOf(address: string): string {
  const bare = address.includes("<") ? address.slice(address.indexOf("<") + 1, address.lastIndexOf(">")) : address;
  return (bare.trim().toLowerCase().split("@")[0] ?? "").split("+")[0] ?? "";
}

/** Which source an inbound message was addressed to, or null if none matches. */
export function sourceIdForAddress(address: string, sourceIds: string[], secret: string): string | null {
  const token = Buffer.from(localPartOf(address));
  for (const id of sourceIds) {
    const expected = Buffer.from(addressTokenFor(id, secret));
    if (token.length === expected.length && timingSafeEqual(token, expected)) return id;
  }
  return null;
}
