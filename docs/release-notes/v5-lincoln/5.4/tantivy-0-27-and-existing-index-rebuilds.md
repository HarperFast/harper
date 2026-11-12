---
section: 'Full-Text Search'
order: 10
---

### Tantivy 0.27 and Existing Index Rebuilds

Harper now uses `@harperfast/fulltext` 0.9.0 with Tantivy 0.27.0. Harper 5.3.1–5.3.4 ship fulltext 0.5.0. Existing 0.5.0 indexes using current field-based declarations, and prerelease 0.6 indexes, rebuild automatically from authoritative records. Harper 5.3.0 ships fulltext 0.3.0 and is outside this qualified procedure; validate that migration separately. Earlier beta declarations and indexes have no supported migration path. Plan for local full-text unavailability, disk headroom and possible retryable write failures while replay catches up. Stop old processes before starting the new version against the same storage; direct downgrade to fulltext 0.5.x is unsupported.

For the 0.5/0.6 rebuild path, English stemming changes despite the unchanged `english@2` analyzer name: `added` now stems to `add` rather than `ad`. Matching and ranking can change. Query modes and schema options are unchanged; benchmark results from the wrapper do not establish application performance parity. Review representative searches and see [upgrading existing indexes](/reference/v5/full-text-search/overview#upgrading-existing-indexes) before restoring traffic.

Harper 5.4.0-alpha.1/alpha.2 indexes using fulltext 0.7.0, and current Harper indexes written by development builds with 0.8.0, can reuse compatible checkpoints with 0.9.0. See [upgrading from fulltext 0.7.0 or 0.8.0](/reference/v5/full-text-search/overview#upgrading-from-fulltext-070-or-080) for process coordination and the unqualified rollback caveat.
