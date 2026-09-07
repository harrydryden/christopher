# Performance and refactoring review

Measured against the local Anduril fixture with 2,211 stored roles. Company detail previously selected every job field despite only showing title, location and status. Serialised job row data fell from 21,572,042 to 1,002,244 bytes after selecting displayed fields (95.4%). This is payload reduction, not a production latency benchmark.

Implemented:
- Stream the non-essential scan banner separately so navigation does not wait for its database queries; add route loading feedback.
- Deduplicate settings reads within a render request using React cache, excluding internal bookkeeping. No cross-request stale cache.
- Start independent Roles-page reads together.
- Select only displayed company role fields and omit binary scan snapshots from company history.
- Bound returned event histories in SQL instead of transferring every historical event and truncating in JavaScript.
- Poll pending work every ten seconds, only while visible and without overlapping refresh transitions.
- Share the database connection implementation through an explicit client subpath.
- Keep one evidence editor, remove unused imports and parameters identified by TypeScript.

Remaining opportunities requiring separate measurement:
- Confirm Vercel function and database regions; cross-region round trips or cold starts may still dominate production latency.
- Paginate large role tables in SQL; preserve grouping, CSV export and bulk-selection semantics.
- Batch gate re-evaluation updates rather than one update per changed role.
- Consolidate status enums and reusable form fields, and retire legacy near-miss UI/settings once the storage release is deployed.

Do not remove the legacy near-miss engine solely because new scans discard non-matches: retained historical records and tests still reference it. Do not cache mutable settings globally without reliable invalidation.
