# CV build recordings

`pnpm --filter @ava/worker cli record <draft-id>` writes a live, paid rebuild of a draft here, one
JSON line per answered model call, keyed by prompt id, prompt version, stage and a hash of the exact
request. Everything in this folder except this README is gitignored: a recording holds a person's
Library and CV text, so it stays on the machine that made it.

A recording's lines:

- `meta` (first): the draft, the prompt set it was recorded at, the route every CV stage ran at, and
  whether the answers came from the provider (`client: "provider"`) or from an injected stand-in
  such as the scripted test client (`client: "injected"`).
- `call`: one request (without transport fields or credentials) and the response it got.
- `baseline` (last): the recorded run's own grade, which later replays are held to.

`pnpm --filter @ava/worker cli replay <draft-id> --recordings <file>` rebuilds the draft from these
answers with no key and no cost. A request the recording does not hold — an edited prompt, a changed
input, another model or effort — fails the replay, naming the prompt and version, and the provider is
never called. To compare a different route, replay live (no `--recordings`, with a key) and pass
`--routes`; the report holds the result against the recording's baseline only when `--recordings`
names it, so keep the baseline's figures from the recorded run's report. See docs/DEPLOY.md,
"Changing a stage's effort or model".

No recording contains an API key: request options are never written, fields that name a credential
are dropped, and the key's value is redacted from every line.
