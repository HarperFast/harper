---
layers: universal, harper/common, harper/v5
---

## Repo-specific checks (Harper core)

This repo IS Harper core itself — "defer to Harper docs"
guidance from the layers applies to PLUGIN / APP docs,
not to docs within this repo (this is where the Harper docs'
behavior is defined).

On top of the layered scope, these are things specific to this
repo that the shared layers don't cover:

- **Linter is oxlint, not eslint.** `npm run lint` runs oxlint.
  Advice in layers that references ESLint doesn't apply here.
- **Build tolerance (`tsc || true`)** is NOT used here —
  Harper core's build should pass cleanly. Flag type errors
  as real findings.
- **`dependencies.md`** documents all npm packages. New
  runtime dependencies require an entry there; flag PRs that
  add a dep without updating the file.
- **TypeStrip compatibility** — Harper core uses
  `erasableSyntaxOnly`. Flag TypeScript constructs that would
  break typestrip (non-type-only imports of types, parameter
  property initialization, etc.).
- **RocksDB is primary storage; LMDB is deprecated** (legacy, but
  still loaded for existing databases and selectable with
  `storage.engine: lmdb` or `HARPER_STORAGE_ENGINE=lmdb`). Tests
  should exercise the primary path; flag PRs that test only the
  fallback.
