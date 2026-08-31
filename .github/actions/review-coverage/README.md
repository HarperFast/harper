# PR description checks

This action independently reports cross-model review coverage and PR-description format. Format checking is off for consumers unless `format_mode` is set to `report` or `enforce`.

For a non-bot Harper organization member changing more than two lines, the description must contain:

- summary prose before the sections;
- exactly one `## Verification` section with executed evidence or a not-observable rationale; and
- at least one line-anchored link into the current PR diff. Every PR-diff link in the body must point to this repository and PR and resolve inside a current diff hunk.

If any AI field is present, the body must also have one `## For the human reviewer` section before Verification, one valid `Complexity: easy|medium|complicated` field, and one `<sub>Review-Coverage: … @ <sha></sub>` and `<sub>Human-Review-Need: 0-4 @ <sha></sub>` footer pinned to the current head.

Drafts are reported but do not fail enforcement. Bot, external-author, and at-most-two-line PRs are exempt. Repair a link by copying a line link from the PR's Files changed page.

GitHub may omit patches or fail to return a complete file list. Report mode records that as unverifiable and stays green. Enforce mode fails closed; do not enable it until the action runs from a trusted host rather than the PR checkout.
