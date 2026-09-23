/**
 * Which addresses the worker may be sent to on an account's behalf.
 *
 * Every URL the worker fetches or renders started with somebody else: a homepage an account typed,
 * a posting it pasted, a link or an icon a fetched page declared, a redirect a server answered
 * with. Left alone, any of them can point at the worker's own network — its loopback, the private
 * services beside it, a cloud metadata endpoint — and what comes back is stored where the account
 * can read it. This is the part of the refusal that needs no network: the scheme, credentials, IP
 * literals in every range that is not the public internet, and the names that only ever mean a
 * local machine. The worker adds the part that does, resolving a name and checking every address
 * it has before connecting.
 *
 * Pure and dependency-free, so the interface can give a person a clear refusal at the moment they
 * type an address, with the same rule the worker enforces.
 */

/** A URL the worker will not fetch. The message is a sentence a person can be shown. */
export class UnsafeUrlError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface UrlSafetyOptions {
  /**
   * Whether an IP address may be reached. Defaults to `isPublicAddress`; a test substitutes its own
   * so a local fixture can stand in for the public internet.
   */
  isAllowedAddress?: (address: string) => boolean;
}

/** The four octets of a dotted-quad IPv4 address, or null when `text` is not one. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** The eight 16-bit groups of an IPv6 address, or null when `text` is not one. */
function parseIpv6(text: string): number[] | null {
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string): number[] | null => {
    if (!half) return [];
    const out: number[] = [];
    const pieces = half.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (i === pieces.length - 1 && piece.includes(".")) {
        // An embedded IPv4 tail, as in ::ffff:127.0.0.1: two more groups.
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** `address` without IPv6 brackets or a zone index. */
function bareAddress(address: string): string {
  return address.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");
}

/** Whether `address` is an IPv4 or IPv6 literal (brackets allowed) rather than a name. */
export function isIpLiteral(address: string): boolean {
  const bare = bareAddress(address);
  return parseIpv4(bare) !== null || parseIpv6(bare) !== null;
}

/**
 * IPv4 ranges that are not the public internet: this network, private, shared (CGNAT), loopback,
 * link-local (where cloud metadata lives), IETF protocol assignments, the documentation and
 * benchmarking nets, the old 6to4 relay, multicast and everything reserved above it.
 */
const PRIVATE_V4: Array<[number, number, number, number, number]> = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24],
  [192, 0, 2, 0, 24],
  [192, 88, 99, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24],
  [203, 0, 113, 0, 24],
  [224, 0, 0, 0, 4],
  [240, 0, 0, 0, 4],
];

function isPublicV4(octets: number[]): boolean {
  const value = ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
  return !PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === base;
  });
}

function isPublicV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeroes = (from: number, to: number) => g.slice(from, to).every(n => n === 0);
  // IPv4 carried inside IPv6 is judged as the IPv4 it carries: mapped (::ffff:a.b.c.d),
  // compatible (::a.b.c.d, which also makes :: and ::1 read as 0.0.0.0 and 0.0.0.1), NAT64
  // (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
  if (zeroes(0, 5) && g[5] === 0xffff) return isPublicV4(v4(g[6]!, g[7]!));
  if (zeroes(0, 6)) return isPublicV4(v4(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeroes(2, 6)) return isPublicV4(v4(g[6]!, g[7]!));
  if (g[0] === 0x2002) return isPublicV4(v4(g[1]!, g[2]!));
  // Only 2000::/3 is global unicast. Everything else — loopback, unique-local fc00::/7,
  // link-local fe80::/10, multicast ff00::/8, the discard prefix — is someone's own network.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // Teredo tunnels (2001:0::/32), ORCHID (2001:10::/28, 2001:20::/28) and documentation (2001:db8::/32).
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || (g[1]! & 0xfff0) === 0x0010 || (g[1]! & 0xfff0) === 0x0020)) return false;
  return true;
}

/**
 * Whether an IP address is on the public internet. False for anything that is not an address at
 * all, so a caller can never be talked into treating a name as vetted.
 */
export function isPublicAddress(address: string): boolean {
  const bare = bareAddress(address);
  const v4 = parseIpv4(bare);
  if (v4) return isPublicV4(v4);
  const v6 = parseIpv6(bare);
  if (v6) return isPublicV6(v6);
  return false;
}

/** Names that only ever mean a machine on the local network, whatever DNS says about them. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".lan"];

/**
 * Parse `url` and refuse it unless it is an http(s) address on the public internet: no other
 * scheme, no user name or password, no IP literal in a private, loopback, link-local, CGNAT,
 * multicast or metadata range (IPv4 or IPv6, including IPv4 wrapped in IPv6), and no name that is
 * local by definition (`localhost`, `*.local`, `*.internal`, a single label). The WHATWG parser has
 * already turned `http://2130706433/` and `http://0x7f.1/` into `127.0.0.1` by the time this looks.
 *
 * A name that passes is not proven public — DNS decides that — so the worker still resolves it
 * before connecting. Throws `UnsafeUrlError`; returns the parsed URL.
 */
export function assertPublicHttpUrl(url: string | URL, opts: UrlSafetyOptions = {}): URL {
  const text = String(url);
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(text);
  } catch {
    throw new UnsafeUrlError(`${text} is not a web address`, text);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http and https addresses can be fetched, not ${parsed.protocol}`, text);
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError("An address with a user name or password in it cannot be fetched", text);
  }
  const host = bareAddress(parsed.hostname).toLowerCase().replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError(`${text} has no host`, text);
  if (isIpLiteral(host)) {
    if (!(opts.isAllowedAddress ?? isPublicAddress)(host)) {
      throw new UnsafeUrlError(`${host} is a private or local network address`, text);
    }
    return parsed;
  }
  if (host === "localhost" || LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix)) || !host.includes(".")) {
    throw new UnsafeUrlError(`${host} is a local network name`, text);
  }
  return parsed;
}
