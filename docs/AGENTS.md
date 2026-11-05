# AGENTS.md

Read [README.md](README.md) first: where each page lives, the release-note fragment format, and how to preview.

## Content Style

Prefer plain ASCII characters in Markdown unless a typographic character is genuinely needed for meaning. This keeps content searchable, easy to type, and consistent with the rest of the docs.

- **Separators between fields** — use a regular hyphen with spaces (`-`), not bullet characters (`•`, `·`) or HTML entities (`&nbsp;`). For `Type:` / `Default:` reference blocks, put each on its own line separated by a blank line (the established pattern in `reference/logging/configuration.md`, `reference/http/configuration.md`, etc.):

  ```markdown
  ### `some.option`

  Type: `boolean`

  Default: `false`

  Description text here.
  ```

- **Type annotations** — use the form `` `<type>` (<modifier>) `` when a hint is useful, e.g. `` `string` (duration) ``, `` `number` (ratio) ``. Do not invent compound type names like `` `duration string` ``.
- **Hyphens vs. dashes** — em dashes (`—`) are fine for parenthetical asides and match existing prose; do not use them as field separators. Do not use en dashes (`–`) except for numeric ranges like `9229–9231`.
- **No HTML entities for whitespace** — let Markdown / Prettier handle spacing; never reach for `&nbsp;` to force layout.
- **Lists** — use `-` for bullets (Prettier's default) and avoid mixing with `*` or `•`.
- **Emoji** — only when the user explicitly requests it.

## Versioning Content

- Tag minor-version availability inline: `<VersionBadge version="vX.Y.0" />` for new surface, `<VersionBadge type="changed" version="vX.Y.0" />` for behavior changes to existing surface.
- Derive the version from the core release the change ships in, stripping prerelease suffixes (`5.1.0-beta.1` → `v5.1.0`).
- **Determine that release from the core repo's git tags, not from the feature branch's `package.json`.** A branch reading `5.2.0-beta.3` says which release was open when the branch started, not which one the change lands in — if a release is cut before the feature merges, the badge is silently wrong. Check `git tag --sort=-creatordate` for the newest release, and `git tag --contains <merge-commit>` for whether the change is in one; a merged-but-untagged feature ships in the _next_ version, which may be a minor bump. Re-check on every refresh pass of a long-lived docs PR, because a release cut between passes invalidates a badge that was correct when written.
- **Fetch tags and confirm the tag object before trusting the answer.** `git tag --contains` is only as good as the local tag it compares against: a stale or divergent tag of the same name gives a confidently wrong answer in either direction. Run `git fetch --tags`, then check `git rev-parse <tag>` against `git ls-remote --tags origin <tag>`. When a badge is disputed, the decisive check is not `--contains` at all but whether the feature's files exist at the tag — `git ls-tree -r --name-only <tag> | grep <path>`, or `git show <tag>:<file>` — since that cannot be confounded by ancestry or by which tag your clone happens to hold.
- **A patch release may or may not be cut from `main`, so ancestry is not a reliable test.** Roughly a third come off `main` and the rest off a release branch such as `v5.2`, which carries selective cherry-picks. When a tag is cut from a release branch, `git tag --contains <main-merge-sha>` returns nothing for it _by design_ — `v5.2.5`'s commit is not an ancestor of `main` at all. So an empty `--contains` does not mean "unreleased", and a newer patch tag existing is not evidence against a next-minor badge. It tells you nothing either way until you know which kind of cut that tag was.
- **Cherry-picks defeat ancestry checks entirely, so test for the feature's files instead.** A back-port creates a new commit SHA, so `git branch -r --contains <original-sha>` and `git tag --contains` both stay empty even when the feature is present on the release branch — which would wrongly badge a back-ported feature as next-minor. Ask whether the code is there, not whether the commit is: `git show <tag>:<path/to/feature/file>` or `git ls-tree -r --name-only <tag> | grep <path>`. When you need the commit rather than the file, `git log --oneline --cherry-mark --left-right <tag>...main` marks patch-equivalent commits with `=`; `git cherry <tag> main` is the equivalent shorthand. Do **not** use `--cherry-pick` for this — it _omits_ equivalent commits from both sides, so a back-port is exactly what disappears from the output.
- **Compare commits, not tag objects.** An annotated tag's own SHA differs from the commit it points at, so two people can cite `v5.2.5` as different hashes and both be right. Use `<tag>^{commit}`.
- Each change adds a release-note fragment under `release-notes/<major-codename>/<minor>/` for the release it ships in ([format](README.md#release-notes)).
- Absolute links from `release-notes/` into current reference docs use the versioned path `/reference/v5/...` — the reference plugin maps the current version to the `v5` URL path.

## Checking a page

- A PR that changes `docs/` gets a site build in CI that fails on broken links, missing imports and MDX errors; run the same build locally as [README.md](README.md#previewing) shows.
- **Run the commands a page documents** before shipping them, against a throwaway Harper of the version the page targets. In a scratch directory, `npm install harper@<version>`, then run that copy's `npx harper install` and `npx harper start` from the scratch directory — not a global `harper`, which may be another version — with `HOME`, `ROOTPATH`, `TC_AGREEMENT=yes`, `HDB_ADMIN_USERNAME`, `HDB_ADMIN_PASSWORD`, `OPERATIONSAPI_NETWORK_PORT` and `HTTP_PORT` set to scratch values, and point the CLI at it with `HARPER_CLI_TARGET`.
  - Set `HOME` to a scratch directory on every command. Without it, `harper install` finds the contributor's own `~/.harperdb/hdb_boot_properties.file` and inspects that install, and `harper login` writes their `~/.harperdb/credentials.json`.
  - Harper core alone has no replication, so anything that replicates fails with `Replication not implemented`, including `replicated=true`, and the job a `restart=rolling` deploy starts when it only restarts (before v5.4.0, or when the deploy's `certification` is `unavailable`). Those paths need Harper Pro.
