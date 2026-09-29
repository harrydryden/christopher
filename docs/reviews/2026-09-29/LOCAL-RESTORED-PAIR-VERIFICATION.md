# Local restored web and worker compatibility — 29 September 2026

The final synthetic drill passed at **15:50:14 UTC**. Its [machine report](implementation-evidence/restored-pair-drill.json) embeds the logical restore's before/after integrity fingerprints, PostgreSQL versions and command outcomes. The report records source commit `d798ccfc617612bc864618a4884f639401e49ebf`, web build ID `KnoFYghfgYO8mhSe0336D`, and SHA-256 hashes for the drill, real worker entry point and gate handler; the working tree had uncommitted implementation changes, so the commit alone is not an exact source identity.

The drill was run from the repository root with the current production web build already present:

```sh
RECOVERY_SOURCE_URL='postgres://postgres:postgres@127.0.0.1:55439/christopher_users_benchmark' \
RECOVERY_TARGET_URL='postgres://postgres:postgres@127.0.0.1:55439/christopher_recovery_drill' \
RECOVERY_DOCKER_CONTAINER='jtbd-90-postgres-20260929' \
node scripts/restored-pair-drill.mjs
```

It refused existing named databases, created one claimed synthetic account with a paused company, disabled loopback source, role, Library and application, then restored a logical dump into the second named local database. Before the worker started, that account's role was deliberately **outside** its table. The actual worker booted against the restore, reported healthy and wrote a heartbeat; its real `reevaluate_gate` handler admitted the role (`accounts: 1`, `changed: 1`). No other task type was queued. The built web interface returned HTTP 200 with the restored account's content on Roles, Companies, Applications and Library. Revoking the temporary session yielded HTTP 401 with `private, no-store`. Cleanup confirmed the session was removed and both local process ports were closed.

An earlier run at 15:46:59 UTC passed the restore and page checks but seeded the role as already visible, so its completed gate task had no demonstrated effect. Those two databases were retained by renaming them `christopher_users_benchmark_initial_20260929` and `christopher_recovery_drill_initial_20260929`; the stronger final run used fresh databases with the original strict names. **All four local databases remain for inspection.** The new script's two safety tests and the initial release-script suite passed (119 passed, two existing database-dependent tests skipped). The parent subsequently reran the complete release-script suite with its isolated database configured: **121 passed, zero skipped**.

This supports a provisional J9 score of **70/100** (completeness 3.5, robustness 3.5, UX 3.5): local restore compatibility now includes both real processes and a state-changing queue journey. It does not establish managed backup quality, hosted restore, production deployment protection, alerts, RPO, RTO, rollback or live provider behaviour.
