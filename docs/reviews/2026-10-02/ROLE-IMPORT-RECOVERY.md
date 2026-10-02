# Uploaded-role CV recovery

## Confirmed production failure

Read-only Render logs and database diagnostics on 2 October 2026 confirmed the reported build ran on `8a26455efd45cfc5a137f3fd5de4299a9fca4819`.

- The first requirements response was rejected because `requirements.6.label` exceeded the schema's 250-character limit. The provider ended normally; this was not a timeout or a failed PDF read.
- The next attempt extracted 30 requirements successfully.
- Both subsequent evidence-planning attempts failed with `Unknown tailoring evidence source: entry:innocent-asia`.
- The build exhausted its three attempts. Repeating the same planning request did not resolve the reference error.

The canonical Library input exposes whole-entry identifiers for the audit and row identifiers for the planner/writer. The failed planner used a whole-entry identifier. The validator correctly refused it, but the request did not clearly distinguish the two contracts or feed the failure back into a corrective request.

## Recovery design

Keep exact evidence validation. A whole-entry reference can be canonicalised only if its quote matches exactly one eligible evidence row within that entry. Ambiguous, fabricated, inactive and unconfirmed sources remain invalid. For other invalid responses, make one bounded repair request with validation feedback and validate the replacement again. Preserve completed rubric checkpoints and the existing gap-question quiz.

This is a validation-feedback loop within the build, not model training. Regression tests capture the observed failure classes. Production diagnostics remain the source for discovering additional failure classes; no claim of automatic learning across users is made.

## Company branding

The role-import review form accepts an optional public company website/domain. Saving it links branding to the existing company-logo pipeline without subscribing the user or starting careers-page discovery. The role retains its private owner and entered employer name. Website/logo failure must not prevent a role being used to build a CV.

Linking a private role to a catalogue company introduces an additional boundary: existing job-board import lookup must exclude private manual roles when it looks for a previously imported URL.

Unfollowing a company preserves manually imported roles. Newly created shared branding records use the public domain as their name; the user's entered employer label remains on the private role.

## Verification boundaries

Automated tests use controlled provider responses to reproduce invalid labels, incorrect source IDs and recovery. These establish the application's behaviour, not a guarantee that every live model response will be recoverable. A fresh live end-to-end CV build and release evaluation are separate checks; neither should be reported as passed merely because unit and integration tests pass.

The committed replay for prompt set `9c7ae3186d99` is explicitly unverified and uses a scripted provider. The normal prompt-version consistency check passes; the strict live-evaluation qualification remains outstanding.

The built-app import browser smoke passed for both link and PDF inputs. It checks domain persistence, private employer labels, unchanged company subscriptions and mobile overflow, with desktop and phone screenshots. Worker extraction is simulated in this browser check; separate worker tests cover logo capture.
