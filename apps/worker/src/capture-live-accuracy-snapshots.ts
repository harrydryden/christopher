import { PoliteFetcher, userAgentFor } from "./fetcher";
import { ats } from "@christopher/core";

const fetcher = new PoliteFetcher({
  userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "christopher-live-acceptance@example.invalid"),
  respectRobots: () => true,
});

const targets = [
  { id: "mozilla", url: "https://www.mozilla.org/en-US/careers/listings/" },
  { id: "mozilla-gb", url: "https://www.mozilla.org/en-GB/careers/listings/" },
  { id: "37signals", url: "https://37signals.com/jobs" },
  { id: "stripe-careers", url: "https://stripe.com/gb/careers" },
  { id: "mozilla-careers", url: "https://www.mozilla.org/en-GB/careers/" },
];

const snapshots = [];
for (const target of targets) {
  const response = await fetcher.fetchText(target.url);
  if (response.status < 200 || response.status >= 300 || !response.body) {
    throw new Error(`${target.id} snapshot unavailable: HTTP ${response.status}`);
  }
  const body = response.body;
  const identities = target.id === "mozilla" || target.id === "mozilla-gb"
    ? [...new Map([...body.matchAll(/href=["']([^"']*\/careers\/position\/gh\/(\d+)\/)["']/gi)].map(match => [
        `gh:${match[2]}`,
        { id: `gh:${match[2]}`, url: new URL(match[1]!, response.url).toString() },
      ])).values()]
    : [];
  const spec = { type: "html" as const, url: target.url };
  const adapterPostings = await ats.getAdapter("html").fetchPostings(spec, {
    fetchText: async (url) => {
      const requested = new URL(url);
      requested.hash = "";
      const captured = [target.url, response.url].some(value => {
        const candidate = new URL(value);
        candidate.hash = "";
        return requested.toString() === candidate.toString();
      });
      if (!captured) throw new Error(`adapter requested uncaptured URL ${url}`);
      return response;
    },
    fetchBytes: async (url) => { throw new Error(`adapter requested uncaptured bytes ${url}`); },
    now: () => new Date(),
  });
  const oracleIds = new Set(identities.map(identity => identity.id));
  const observedIdentities = adapterPostings.map(posting => {
    const match = posting.url.match(/\/careers\/position\/gh\/(\d+)\/?/i);
    return { id: match ? `gh:${match[1]}` : `url:${posting.url}`, title: posting.title, url: posting.url };
  });
  const observedIds = new Set(observedIdentities.map(identity => identity.id));
  const truePositives = [...oracleIds].filter(id => observedIds.has(id)).length;
  const falseNegatives = [...oracleIds].filter(id => !observedIds.has(id)).length;
  const falsePositives = [...observedIds].filter(id => !oracleIds.has(id)).length;
  const explicitEmptyState = target.id === "37signals" ? /(?:don't|don’t) have any job openings right now/i.test(body) : false;
  if (target.id === "37signals" && !explicitEmptyState) throw new Error("37signals snapshot lacks its asserted explicit empty state");
  const hasOracle = target.id === "mozilla" || target.id === "mozilla-gb" || (target.id === "37signals" && explicitEmptyState);
  snapshots.push({
    ...target,
    fetchedAt: new Date().toISOString(),
    finalUrl: response.url,
    status: response.status,
    oracleMethod: target.id === "mozilla" || target.id === "mozilla-gb"
      ? "Independent, source-specific enumeration of unique first-party /careers/position/gh/<id>/ anchors; this does not call Christopher's HTML adapter."
      : target.id === "37signals"
        ? "Independent inspection of the first-party jobs page's explicit no-openings state; zero posting-detail links were present."
        : "Diagnostic snapshot of a discovery candidate; no posting oracle is asserted for this page.",
    explicitEmptyState,
    ...(hasOracle ? { identities } : {}),
    adapterObservation: {
      identities: observedIdentities,
      ...(hasOracle ? { comparison: {
        truePositives,
        falsePositives,
        falseNegatives,
        precision: observedIds.size ? truePositives / observedIds.size : oracleIds.size ? 0 : 1,
        recall: oracleIds.size ? truePositives / oracleIds.size : 1,
      } } : {}),
    },
    bodyBase64: Buffer.from(body).toString("base64"),
  });
}

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  classification: "machine-derived independent oracle; requires human review before it is a golden label",
  snapshots,
}));
