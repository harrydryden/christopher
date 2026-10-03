# CV editing and review decisions

The review editor supports adding and removing individual skills and skill sections. Empty skill sections are omitted from both the preview and saved revision, rather than failing the minimum-one-item schema. Other empty sections retain actionable validation. Newly entered skills carry no invented Library citations. Preview and save share the same section normalisation, and remembered wording matches sections by their stable identifier rather than array position.

The Evaluation tab offers a guided review of flagged findings with Previous/Next, edit and evidence links, and “Nothing further to add”. Dismissals persist on the owned revision and are bound to the assessment's input hash and timestamp. A changed assessment or new revision requires a new decision. Dismissing a finding does not change its evaluation status or score.

Users can explicitly skip review and finalise despite factual flags. The saved decision is honoured by PDF download and application recording. Current assessment, ownership, valid PDF layout and concurrent revision checks remain enforced. Unsaved edits cannot silently finalise an older saved CV, and the guided evidence link asks the user to save before leaving the editor.

Browser coverage exercises adding a skill, clearing it, rendering both previews, saving a new skill with remembered wording enabled, dismissal persistence after reload, explicit override, unchanged assessment results, and downloading the final PDF through both paths. The guided review is checked at desktop and phone widths. These tests use synthetic assessed drafts; they do not claim a new live model evaluation.
