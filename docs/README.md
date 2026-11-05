# Harper documentation source

This directory holds the source of the Harper v5 [reference](https://docs.harperdb.io/reference/v5) and the release notes of the open minor release. A PR that changes behavior changes its docs here, in the same PR.

The site itself — theme, the Learn and Fabric sections, the archived v4 reference, older release notes, redirects for old URLs, search and deployment — lives in [HarperFast/documentation](https://github.com/HarperFast/documentation). Its build assembles the published pages from this directory and from `docs/` in [HarperFast/harper-pro](https://github.com/HarperFast/harper-pro), and redeploys when what it publishes changes ([when docs publish](#when-docs-publish)).

```
docs/
├── reference/                         → /reference/v5/
│   ├── _redirects.json                (optional) [{ "from": "/reference/v5/old", "to": "/reference/v5/new" }]
│   └── <section>/_category_.json, *.md
└── release-notes/<codename>/<minor>/  → /release-notes/<codename>/<minor>
    ├── _index.md                      title, section order, text above the first section
    └── <change>.md                    one fragment per change
```

## Which repo a page belongs in

Each page lives in the repo whose code it documents. Pages for Harper Pro features (replication, the web application firewall) live in harper-pro's `docs/reference/`, at the same paths they are published under; a path provided by both repos fails the build. When a core page has a section that only Harper Pro implements, that section is a partial in harper-pro named `_pro-<topic>.md` next to the page's path, and the core page renders it:

```mdx
import ProReplicationOperations from './_pro-replication-operations.md';

<ProReplicationOperations />
```

Its headings appear in the page's table of contents, and links to its anchors work as before. Links between pages use relative paths within `reference/` (`../replication/clustering.md`), and `/reference/v5/...` from release notes.

## Release notes

Each change adds its own fragment to the open minor's directory, so PRs do not conflict over one shared file:

```markdown
---
section: Replication
order: 20
---

### Sharding

What changed and what a user needs to do about it, with links to the PR and the reference.
```

`section` is the `##` heading the fragment appears under. `_index.md` lists the order of known sections; a fragment can name a new section, which is placed after the listed ones. Within a section, fragments with an `order` come first, lowest first, then the rest by file name. A fragment without a `###` heading continues the section's opening text (as in Upgrade Notes). At release time the notes are edited as a whole; patch releases are described in GitHub releases, not here.

## Previewing

The site repo builds against a local checkout when given its path:

```bash
git clone https://github.com/HarperFast/documentation.git
cd documentation && npm ci
HARPER_DOCS_PATH=../harper npm run dev        # live reload of edits here
HARPER_DOCS_PATH=../harper npm run build      # fails on broken links, as CI does
```

`HARPER_PRO_DOCS_PATH` does the same for a harper-pro checkout; a harper-pro without a path is fetched at what the site publishes (`HARPER_PRO_DOCS_REF=main` fetches `main` instead). CI runs that build on every PR that changes `docs/`, against harper-pro at the PR's base branch, and uploads the built site as an artifact.

A PR that changes `docs/` also gets a deployed preview: a comment on the PR links to the site built from its head, with harper-pro at the PR's base branch. It updates with each push that still changes `docs/`, and says when the preview is removed at close. A fork's PR waits for a maintainer to approve the build. HarperFast/documentation builds and hosts it ([how](https://github.com/HarperFast/documentation/blob/main/CONTRIBUTING.md#reference-and-release-notes-content)).

## When docs publish

The site publishes harper-pro's latest published stable release, with harper's docs at the commit its `core` submodule points to, so docs merged with a change on `main` go live when the release containing it ships. A correction to docs that are already live goes in a PR milestoned to that release line; it is cherry-picked there and goes live with the next patch release.

Until a release contains `docs/` (5.4.0 is the first), the site publishes `main` instead, so docs go live when they merge there. Release lines cut before then (5.3 and older) have no `docs/`, so docs corrections for them go to `main` only.

To publish a correction before then, tag a harper-pro commit `docs/<release>-<n>`, numbering from 1 for each release (`docs/v5.3.5-1`, then `docs/v5.3.5-2`). The site publishes the highest such tag of its current release, and the next release replaces it. A `docs/` tag runs no release workflow.

- Everything in that commit's `docs/` publishes. Tag the release branch head when every docs change on it since the release is ready to go live; otherwise tag a commit on top of the release tag with only the correction:

  ```bash
  git switch --detach v5.3.5 && git cherry-pick <correction>
  git tag docs/v5.3.5-1 && git push origin docs/v5.3.5-1
  ```

- A correction in harper publishes only once harper-pro's `core` points to a harper commit containing it, so commit that `core` bump in harper-pro and tag the result. A harper commit made on top of its release tag needs pushing too (a tag of the same name keeps it fetchable).

## Reference Section Structure

The Reference section is organized as a flat list of feature-based sections — no deep nesting. Each top-level section corresponds to one Harper feature or subsystem.

### Section Layout

Every section follows this pattern:

```
reference/
└── {feature}/
    ├── overview.md        # General introduction, architecture, concepts
    ├── configuration.md   # Config options specific to this feature (if applicable)
    ├── api.md             # JS/programmatic API reference (if applicable)
    └── operations.md      # Operations API operations for this feature (if applicable)
```

Not every section needs all four files — some features only warrant an `overview.md`. The filenames above are conventions, not requirements.

### Section Order

Sections are ordered in the sidebar by who needs them first:

1. **Data & Application** — Database, Resources, Components
2. **Access & Security** — REST, HTTP, Security, Users & Roles
3. **Setup & Operation** — CLI, Configuration, Operations API
4. **Features** — Logging, Analytics, MQTT, Static Files, Environment Variables, Replication, GraphQL Querying, Studio, Fastify Routes
5. **Legacy** — Deprecated or discouraged features

### Sidebar

The site builds the reference sidebar from the directory tree. Each section directory has a `_category_.json` with its `label`, its `position` and `"className": "reference-category-header"` (compact styling; never `learn-category-header`). Each page orders itself within its section with `sidebar_position` and names its sidebar entry with `sidebar_label` front matter. Positions step by 10, so a page or section from the other repo can slot in between without renumbering.

### Legacy Section

Deprecated or discouraged features belong in `reference/legacy/`. Each legacy page should briefly explain what the feature was and direct users to the modern alternative.

---

## Version Annotations

Because the Reference section consolidates all minor versions of a major into one document, features are annotated inline to indicate when they were introduced or changed.

Use the `<VersionBadge>` component. It is registered globally and requires no import in `.md` or `.mdx` files.

```mdx
<VersionBadge version="v4.3.0" />
<VersionBadge type="changed" version="v4.5.0" />
<VersionBadge type="deprecated" version="v4.2.0" />
```

The `type` prop defaults to `"added"`, so the most common case is just `version`. Place the badge on its own line directly below the heading it describes:

**New feature:**

```mdx
## Relationships

<VersionBadge version="v4.3.0" />

The `@relationship` directive allows you to define relationships between tables...
```

**Changed behavior:**

```mdx
## Default Port

<VersionBadge type="changed" version="v4.5.0" />

The default MQTT port changed from 9925 to 9933.
In previous versions of v4, the default was 9925.
```

**Deprecated feature:**

```mdx
## SQL Querying

<VersionBadge type="deprecated" version="v4.2.0" />

SQL is still supported but discouraged. See [Database](../database/overview.md) for modern alternatives.
```

**Stabilized feature:**

```mdx
## Plugin API

{/* Now stable! */}

<VersionBadge type="stable" version="v5.0" />
{/* Was "experimental" */}
<VersionBadge version="v4.6" />

The Plugin API is the primary way to implement additional functionality in Harper.
```

**Configuration option** (inline in a list):

```mdx
- `logger.level` — Log level; _Default_: `"info"` (Added in: v4.1.0)
```

Use `<VersionBadge>` after headings or alongside the specific sentence, list item, or table entry it annotates. Use `<EngineBadge engines="RocksDB" />` the same way when behavior is storage-engine-specific; comma-separated values such as `engines="RocksDB, LMDB"` are supported. Keep adjacent version and engine badges together on one line. For dense prose where a component would interrupt the sentence, plain text such as `(Added in: vX.Y.Z)` is fine.
