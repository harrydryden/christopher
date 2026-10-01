# Independent Learning recovery review — 1 October 2026

I reviewed the frozen Learning actions, controlled editors, task deduplication and focused verification. The final candidate addresses the observed silent overwrite: profile text and pinned statements now keep their visible text and profile version together; question answers and reason tags retain their drafts and guards through sibling refreshes. Profile append plus forced synthesis enqueue, and tag edit plus its follow-up enqueues, commit or roll back together. A queued routine synthesis is upgraded to forced without changing the first non-promoted request's scheduling. I found no material defect in those final paths.

The intermediate first-edit-only guard was **superseded**. It stopped an already dirty textarea from taking a newly rendered hidden version, but React 19 leaves even a pristine uncontrolled textarea's visible value unchanged when its `defaultValue` changes. An old visible value could therefore be edited for the first time against a new hidden version. A separate intermediate uncontrolled multiple-select retained old choices on rerender and reset to its original choices after a successful save. The final candidate uses controlled, paired value-and-guard editors for profile text, pinned statements and tags; questions retain dirty rows when a server refresh answers or removes them.

I reproduced the React behaviour using the repository's React and jsdom dependencies. Both commands were run from `apps/web` with `node -e` and the following JavaScript bodies:

```js
const { JSDOM } = require('jsdom');
const d = new JSDOM('<div id="root"></div>');
global.window = d.window; global.document = d.window.document;
global.HTMLElement = d.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const root = createRoot(document.getElementById('root'));
const view = x => React.createElement('textarea', { defaultValue: x });
act(() => root.render(view('old')));
const field = document.querySelector('textarea');
act(() => root.render(view('new')));
process.stdout.write(JSON.stringify({ value: field.value, defaultValue: field.defaultValue }));
```

Output: `{"value":"old","defaultValue":"new"}`.

```js
const { JSDOM } = require('jsdom');
const d = new JSDOM('<div id="root"></div>');
global.window = d.window; global.document = d.window.document;
global.HTMLElement = d.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const root = createRoot(document.getElementById('root'));
const view = x => React.createElement('form', null,
  React.createElement('select', { multiple: true, defaultValue: x },
    React.createElement('option', { value: 'remote' }, 'Remote'),
    React.createElement('option', { value: 'leadership' }, 'Leadership')));
act(() => root.render(view([])));
const select = document.querySelector('select');
select.options[0].selected = true;
act(() => root.render(view(['remote'])));
const before = { selected: select.options[0].selected, defaultSelected: select.options[0].defaultSelected };
select.form.reset();
process.stdout.write(JSON.stringify({ before, afterReset: { selected: select.options[0].selected, defaultSelected: select.options[0].defaultSelected } }));
```

Output: `{"before":{"selected":true,"defaultSelected":false},"afterReset":{"selected":false,"defaultSelected":false}}`.

The final focused web run passed 107 tests across six files ([log](web-learning-final.txt)); the database queue run passed 16 and the scheduler run passed 13 ([queue evidence](README-queue.md)). Web, database and worker typechecks and the worker build passed. Failure-injection integration tests confirm that a rejected synthesis task insert rolls back pinned/answer profile versions and tag edits. Component tests exercise pristine and dirty refreshes, changes during a pending save, retained question drafts and successive tag saves.

The final browser replay reached a confirmed second-tab profile save at version 9. A sibling save refreshed the first tab; its older profile, pinned and answer submissions were refused with their draft text and older guards intact, and the database remained at version 9 ([browser state](final-dirty-editors-refused.json), [database check](final-dirty-editors-db.txt)). The earlier [incomplete pointer replay](incomplete-pointer-replay.json) was not counted as a pass because its offscreen focus did not activate the intended control. The earlier [silent-overwrite reproduction](sibling-refresh-before-repair.json) records the superseded candidate's failure.

Remaining limits: Starting preferences is still an uncontrolled, unversioned textarea. A pristine sibling refresh can leave its old text visible; concurrent seed edits have last-writer-wins behaviour. Dirty reason-tag editors can also disappear if their decision leaves the 20 most recent rows. Drafts survive while the Learning page remains mounted, not a reload or closed tab. The checks are local and synthetic: they do not establish 50 genuine learning decisions, model output quality, representative human task success, or hosted release behaviour.

This repair improves confidence in the local recovery behaviour, but does not justify raising the existing readiness scores: J7 remains **80** (C 4.5, R 3.5, UX 4) and J8 remains **83** (C 4.5, R 4, UX 4). No other job score changes on this evidence alone; the every-job 90 threshold remains unmet.
