"""One ordinary robots-aware GET per previously labelled first-party listing.

No challenge solving, cookies, browser impersonation, retry or extraction.
"""
import datetime as dt
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def get(url: str, timeout: int):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    return response.status, response.url, response.headers, response.read()

TARGETS = {
    "cloudflare": "https://www.cloudflare.com/careers/jobs/",
    "stripe": "https://stripe.com/careers/search",
    "salesforce": "https://careers.salesforce.com/en/jobs/",
    "revolut": "https://www.revolut.com/careers/",
    "wise": "https://wise.jobs/jobs",
    "spotify": "https://www.lifeatspotify.com/jobs",
}
UA = "AvaSourceQualification/1.0"
out = {"checkedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(), "userAgent": UA, "candidates": []}

for candidate, url in TARGETS.items():
    parsed = urllib.parse.urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    result = {"id": candidate, "url": url, "robotsUrl": robots_url}
    try:
        robots_status, robots_final_url, _, robots_body = get(robots_url, 12)
        result["robotsStatus"] = robots_status
        result["robotsFinalUrl"] = robots_final_url
        if robots_status == 200:
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(robots_body.decode("utf-8", errors="replace").splitlines())
            allowed = parser.can_fetch(UA, url)
        elif robots_status in (404, 410):
            allowed = True
        else:
            allowed = False
        result["robotsAllowed"] = allowed
        if not allowed:
            out["candidates"].append(result)
            continue
        status, response_url, headers, body = get(url, 15)
        result.update({
            "status": status,
            "responseUrl": response_url,
            "responseDateHeader": headers.get("Date"),
            "headers": {key: value for key, value in headers.items()
                        if key.lower() in ("content-type", "server", "cf-mitigated", "cf-ray", "location", "x-datadome", "x-sucuri-block")},
            "bodyBytes": len(body),
            "bodySha256": hashlib.sha256(body).hexdigest(),
        })
    except (OSError, ValueError) as exc:
        result["requestError"] = f"{type(exc).__name__}: {exc}"
    out["candidates"].append(result)

print(json.dumps(out, ensure_ascii=False, indent=2))
