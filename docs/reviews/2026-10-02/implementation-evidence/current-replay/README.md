# Current scripted CV replay

An isolated local PostgreSQL database, `cv_replay_1002` at `127.0.0.1:55439`, was created for this run. The previous committed report is preserved as `previous-report.json`. `fixture.txt`, `replay.txt`, `evaluated-routes-write.txt`, and `ordinary-gate.txt` contain the exact commands and their output. Provider keys were cleared for both fixture and replay. The recording is gitignored because it contains CV text.

The scripted fixture published its synthetic draft, recorded four scripted calls, and replayed them at prompt set `27311fe3cb21`. The grade passed and the ordinary evaluation gate exited 0. The new report is expressly `unverified`; the displayed replay cost is recorded model-use metadata, not a charge incurred by this replay. This evidence does not qualify the strict verified release gate or live model quality.
