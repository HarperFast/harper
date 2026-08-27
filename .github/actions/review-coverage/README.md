# PR description checks

This action independently reports cross-model review coverage and PR-description format. Format checking is off for consumers unless `format_mode` is set to `report` or `enforce`.

For a non-bot Harper organization member changing more than two lines, the description must contain:

- summary prose before the sections;
- exactly one `## Verification` section with executed evidence or a not-observable rationale; and
- at least one line-anchored link into the current PR diff. Every PR-diff link in the body must point to this repository and PR and resolve inside a current diff hunk.

If any AI field is present, the body must also have one `## For the human reviewer` section before Verification, one valid `Complexity: easy|medium|complicated` field, and one pinned `<sub>Review-Coverage: … @ <sha></sub>` and `<sub>Human-Review-Need: 0-4 @ <sha></sub>` footer.

Drafts are reported but do not fail enforcement. Bot, external-author, and at-most-two-line PRs are exempt. To repair a line link, hash the changed file path with SHA-256 and use `https://github.com/<owner>/<repo>/pull/<number>/changes?w=1#diff-<hash>R<line>` (`L<line>` for the old side).
