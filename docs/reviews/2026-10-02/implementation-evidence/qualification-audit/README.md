# Operational qualification audit evidence

[Checkpoint](../../QUALIFICATION-AND-OPERATIONS-VERIFICATION.md) · [Independent review](INDEPENDENT-REVIEW.md)

- `hosted-operational-failure.txt`: bounded read-only excerpt from GitHub run 36931172888 at remote main; confirms the gate reported sustained heap pressure, without numerical samples.
- `worker-health.json`: fresh public liveness/identity read; does not establish memory safety.
- `branch-protection.json`: read-only branch and ruleset API results; main is unprotected, ruleset list empty.
- `operational-worker-tests.txt`, `operational-release-tests.txt`, `operational-worker-typecheck.txt`, `operational-worker-build.txt`: focused tests, typecheck and worker build commands/results. Worker tests use isolated `operational_heap_1002`.
- `operational-cli-probe.mjs` and `.txt`: actual CLI against an isolated HTTP server, both sides of the 85% boundary, verified exit codes and absent private markers. An initial assertion used the wrong case for the word “attention”; that harness assertion was corrected before the recorded passing run.
- `release-suite.txt`: initial broad suite failure caused by the obsolete corpus expectation; not passing evidence.
- `release-suite-final.txt`: final corrected broad suite result, with isolated database coverage.

Current offline CV replay evidence lives in `../current-replay/`; its explicit unverified status means the strict release gate remains red. Text logs have trailing whitespace normalised without altering results. All synthetic servers used by tests/probes are closed in cleanup.
