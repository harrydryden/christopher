# Discovery and review UX review

Reviewed 11 September 2026. Changes are implemented locally; this review does not deploy them.

The main issue was that source configuration and company decisions competed for attention on one
page. The revised journey is **Sources → check content → Review → add or dismiss → History**.
Review is the default view, with a count of pending recommendations. Source configuration is a
separate view; advanced settings and evidence expand only when needed.

## Findings addressed

| Finding | Change |
|---|---|
| Source setup pushed recommendations below lengthy configuration forms. | Separate Review, Sources and History views, with consistent naming and counts. |
| “Find more” could be mistaken for checking newsletters. | “Find similar companies” explicitly describes the portfolio-based search; external sources have their own Check now action. |
| Source checks lacked visible progress and useful failure states. | Queued, Checking, Paused, Content ready, Waiting for content, Up to date and Needs attention states; refresh controls; last-check result where retained task history is available. Disabled discovery links to Settings. |
| Email setup showed an irrelevant URL field and implied inbox integration. | Conditional fields and explicit import guidance. Email delivery configuration is in a separate advanced disclosure. Empty email sources wait for content without an AI error. |
| Missing, invalid or duplicate input produced generic failures. | Friendly action feedback, retained form entries, duplicate-source prevention (including concurrent additions and URL normalisation), and duplicate-import acknowledgement. |
| Long imports silently lost content. | Manual and inbound-email imports reject content above 40,000 characters and ask for separate imports. Webpage fetching remains bounded. |
| A routine save could postpone discovery; a running check could overwrite a changed interval. | Unchanged saves preserve the due date; resuming or changing a source URL makes it due; check completion uses the interval currently saved in the database. |
| Incorrect source names and URLs could not be corrected. | Name and URL editing within Source settings, with validation and duplicate checks. |
| Review cards emphasised technical checks and overstated sample counts. | Rationale first, direct careers link, expandable source evidence, and explicit “filter matches in sample” wording. |
| “Accept” did not clearly explain its consequence. | “Add to tracked companies”, with careers-setup feedback. Dismissal asks for a reason and explains repeat suppression. |
| Repeated or competing decisions could produce inconsistent state. | Transactional acceptance and dismissal with row locking. Company creation, decision and queued setup are committed together; already-reviewed recommendations cannot be overwritten. |
| Accepted careers sources could omit the identifiers needed by an ATS adapter. | Acceptance queues full careers discovery using the verified URL before scanning. |
| Navigation and post-save content could become stale. | Discovery view links and successful forms use fresh page navigation. Inputs remain intact on validation errors. |
| The fixed sidebar squeezed narrow screens. | Responsive workspace navigation, wrapping controls, larger discovery touch targets and single-column source settings on mobile. |

## Verification

- Full repository test suite passed; the additional discovery regressions also passed.
- 12 discovery action tests cover concurrent duplicate prevention, validation, schedule preservation,
  paused/disabled checks, duplicate imports, acceptance races, existing companies, authentication,
  dismissal protection and transaction rollback if queueing fails.
- Seven worker source tests cover scheduling, evidence requirements, duplicate recommendations,
  blocked fetching with imported text, unavailable AI, empty email sources and schedule changes
  during a running check. Five inbound-email tests cover authentication, input and size limits,
  source type and duplicate delivery.
- Type checking and the production build passed.
- Browser verification exercised view navigation, conditional email fields, retained input after a
  duplicate-source error, source creation, import, interval changes, pause, source evidence,
  acceptance, dismissal and review history against an isolated database with fixture content.
- Desktop and 390px mobile layouts were inspected. The mobile check found no horizontal overflow;
  the browser flow produced no page errors.
- The web smoke test includes Review, Sources and History as well as the existing app pages.

## Remaining product boundaries

This review improves the workflow and safeguards; it does not change recommendation weighting or
add a per-edition LinkedIn checkpoint. Publicly linked editions can still be missed, and content
requiring sign-in may need importing. Source creation does not subscribe to email newsletters.

Progress is refreshed explicitly, so a background update does not interrupt someone entering a
source or dismissal reason. Previously suggested domains remain suppressed by external discovery,
including dismissed and expired recommendations. Automatic reconsideration needs a separate policy.
