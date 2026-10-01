# Bot-protected source qualification — 1 October 2026

**Qualified observation:** Revolut's first-party careers listing, `https://www.revolut.com/careers/`, returned an explicit Cloudflare managed challenge to an ordinary, identified HTTP client. This establishes a bot-protected response for that client on this date. It does not establish that every client is challenged: the web text reader could read the listing the same day.

## Source identity

The existing [corpus manifest](../../../../../apps/worker/src/live-acceptance-manifest.ts) labels Revolut's company-owned `https://www.revolut.com/careers/` as its searchable jobs source. Its previous source check was dated 20 September; this checkpoint renews that evidence on 1 October. On 1 October, the official [Revolut homepage](https://www.revolut.com/) linked its [Company page](https://www.revolut.com/discover-our-company/), whose **Join us** link resolved to the same [careers listing](https://www.revolut.com/careers/). The [retained link chain and listing labels](revolut-source-navigation.json) record the small text-reader observations: the unfiltered linked URL displayed a jobs search with location and team controls. Its displayed number is not a reviewed posting count. A direct identified-client request to the Company page also encountered HTTP 403, so the link chain is grounded in the public web text reader, not in a direct HTML capture.

## Direct response proof

The [six-candidate record](observations.json) checked each source's robots file first and made at most one ordinary listing GET per permitted source. Salesforce's robots URL redirected, so that source was not fetched. The retained [Revolut robots response](revolut-robots.txt) was HTTP 200 and permits `/careers/` for `AvaSourceQualification/1.0`; it disallows query URLs, which this request did not use.

At **21:37:52 UTC**, the initial GET to the exact unfiltered listing returned HTTP **403** with `Cf-Mitigated: challenge`, `Server: cloudflare` and `CF-RAY: a43e9c6bed625e45-LHR`. A single repeat at **21:38:36 UTC** returned HTTP **403** with the same explicit challenge header and `CF-RAY: a43e9d7f9eba651e-LHR`; its body contains `window._cf_chl_opt` and `/cdn-cgi/challenge-platform/`. The [repeat observation](revolut-challenge.json) retains the response date, headers, body size and SHA-256, and marker presence without challenge tokens. These markers identify a managed challenge, beyond a bare 403. The body was not submitted to a solver or interacted with.

The other permitted candidates in the bounded set — Cloudflare, Stripe, Wise and Spotify — returned HTTP 200. Salesforce was not requested beyond robots. No unsupported negative conclusion about their bot protections follows from those responses.

The scripts [check.py](check.py) and [capture-revolut.py](capture-revolut.py) record the ordinary request method. No browser impersonation, automated retries, CAPTCHA interaction, bypass, paid model call or posting extraction was performed.
