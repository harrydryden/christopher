# Queue verification

Forced `synthesize_profile` requests now upgrade a matching queued task's `force` flag. The queued task keeps its existing payload identity, priority and start time. Repeated rows in a non-promoted batch retain the first row's scheduling options; a later non-forced request cannot clear the force flag. A request arriving while a task runs still creates a queued follow-up.

The focused checks used the isolated `synth_force_1001` database at `127.0.0.1:55439`. Each linked log records its exact command and exit code:

- [Database queue tests](queue-db-test.txt): 16 passed.
- [Scheduler tests](queue-scheduler-test.txt): 13 passed.
- [Database typecheck](queue-db-typecheck.txt): passed.
- [Worker typecheck](queue-worker-typecheck.txt): passed.
- [Worker build](queue-worker-build.txt): passed; built `dist/index.mjs` and `dist/otel.mjs`.
