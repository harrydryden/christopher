"""Capture one ordinary repeat of the robots-permitted Revolut listing response."""
import datetime as dt
import hashlib
import json
import urllib.error
import urllib.request

URL = "https://www.revolut.com/careers/"
UA = "AvaSourceQualification/1.0"
request = urllib.request.Request(URL, headers={"User-Agent": UA})
try:
    response = urllib.request.urlopen(request, timeout=15)
except urllib.error.HTTPError as error:
    response = error
body = response.read()
text = body.decode("utf-8", errors="replace")
markers = ["window._cf_chl_opt", "/cdn-cgi/challenge-platform/", "Just a moment", "verify you are human", "Checking your browser", "turnstile", "captcha"]
found = [marker for marker in markers if marker.lower() in text.lower()]
out = {
    "checkedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
    "url": URL,
    "userAgent": UA,
    "robotsPolicy": "200 and allowed for this user agent in observations.json",
    "status": response.status,
    "responseUrl": response.url,
    "responseDateHeader": response.headers.get("Date"),
    "headers": {key: value for key, value in response.headers.items()
                if key.lower() in ("content-type", "server", "cf-mitigated", "cf-ray", "location")},
    "bodyBytes": len(body),
    "bodySha256": hashlib.sha256(body).hexdigest(),
    "bodyChallengeMarkers": found,
}
print(json.dumps(out, ensure_ascii=False, indent=2))
