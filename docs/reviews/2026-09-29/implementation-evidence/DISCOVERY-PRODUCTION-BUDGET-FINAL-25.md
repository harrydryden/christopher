# Final 25-case discovery-only diagnostic — 29 September 2026

The serial run started at **15:59:41 UTC** and wrote its final report at **16:09:29 UTC**. It used all 25 frozen source cases, the guarded production browser, 40 fetches and 120 seconds **per case**, one case at a time, AI disabled and `CONTACT_EMAIL=ava-source-diagnostic@example.invalid` as a labelled diagnostic identity. It made no account/database changes, paid provider calls or extraction attempts. [Full per-case JSON](discovery-production-budget-final-25.json) is the result record. The command was:

```sh
CONTACT_EMAIL='ava-source-diagnostic@example.invalid' pnpm --filter @ava/worker exec tsx src/live-acceptance-cli.ts --discovery-only --browser --discovery-budget production --concurrency 1 --output '/Users/h_dryden/Documents/New project/christopher-jtbd-review/docs/reviews/2026-09-29/implementation-evidence/discovery-production-budget-final-25.json'
```

| Source-selection measure | Result |
|---|---:|
| Correct automatic matches at ≥0.85 | **20/25 (80.0%)** |
| Wrong automatic accepts | **0** |
| Matches including confirmation | 21/25 |
| Automatic resolutions | 20/25 |
| Independent role-count labels | 0/25 |
| Qualifying posting-identity snapshots | 0/25 |

The source-selection threshold of at least 80% correct automatic matches and zero wrong automatic accepts is met **in this discovery-only diagnostic**. The harness acceptance verdict remains **blocked** because all 25 independent role counts and full-scope posting-identity snapshots are absent, extraction did not run and posting recall/precision are unmeasured. Its process exit code 2 expresses those unmet gates, not a failed case execution. No user success, full-listing completeness or production release pass follows from these figures.

The four non-matching cases were OpenAI (`not_found`, 40 fetches), Salesforce (a `bc=DB` filtered listing held for confirmation after the 120-second limit), Spotify (a Lever probe held at 0.72 rather than the labelled source) and Revolut (`not_found`). Netflix matched its Eightfold source but stayed at 0.70 confirmation; its company homepage was denied by robots, which the run respected. Datadog now selected the labelled first-party `/all-jobs/` source at 0.85 after one browser render; its ten rendered identities are only an initial sample. [The targeted Datadog note](DATADOG-MOUNT-FOLLOWUP.md) gives the source-shaped DOM evidence and held-out regression.

The prior [25-case result](discovery-production-budget-25.json) remains intact at 17/25 labelled correct automatic matches. It used the earlier labels and code. Subsequent independent [source-equivalence review](../SOURCE-EQUIVALENCE-AUDIT.md) established that the Cloudflare Greenhouse feed and Zapier Ashby feed exactly represented the first-party pages' current roles; the manifest now accepts those typed alternatives. Datadog's generic mounted-search repair is a separate code improvement. Consequently the three-point change must **not** be reported as three algorithmic fixes or as evidence that an unreviewed alternative is acceptable.

The run began with HEAD `d798ccfc617612bc864618a4884f639401e49ebf` plus uncommitted changes. SHA-256 of its relevant source at start: `discover.ts` `f6770d0f03503754e8b615fb4e366afcf1061355ac664d2fc8c0892ebaec5a6e`; `confidence.ts` `74c6974845e4725406fbdf92012522bbe5827d8930baa61d3ecdc18782f6926e`; `ats/html.ts` `4a0ca3edaf96ffbe3b0b8d163e336805c608a5537b2579d0f6356ac099578659`; `live-acceptance.ts` `47ce3b096b612d78f447e25dfcb0719c0e7fe8fe1ca13751e68710adfcc18596`; CLI `d4ce6da42e6d7a48980fbaeafc80b560909e0c2c85bb5dd2b370b415ca084046`; manifest `57163e8d98c0346aab6b08a8d39cf4dc5fc314fc662a414044fc069373a4cf1d`. Full core [test log](datadog-core-tests.log) records 708/708 passed in 42 files; [typecheck log](datadog-core-typecheck.log) and `git diff --check` passed after the Datadog fixture was finalised.

An independent conservative re-score keeps **J2 at 77** (completeness 4, robustness 3.5, UX/UI 4) and **J8 at 83** (4.5, 4, 4). The source-discovery gate reaches its numerical threshold, but J2 still lacks independent posting recall/precision, a successful path for four difficult source cases, and evidence that partial and refused sources become useful roles for a follower. J8's local recovery and truthful status gains do not replace interrupted-network and assistive-technology user sessions. Neither reaches the requested 90 or all dimension floors.

The next bounded engineering work is to diagnose the four unresolved source paths while preserving confirmation and robots limits, then run discovery **and extraction** against current independently reviewed full-scope posting snapshots. That should measure identity recall and precision and exercise partial/continuation behaviour in a followed-account journey. The remaining release qualification needs the 50-company/15-minute operational gate and ordinary-user confirmation/recovery tasks; no absent measurement should be entered as zero or a pass.
