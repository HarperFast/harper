# Full-text index namespace

Status: implementation contract — code-traced against `codex/fulltext-schema-activation` on 2026-09-17 · Owner: Kyle Bernhardy

## TL;DR

- Replace the `search: FullText @fullText(...)` pseudo-field with a repeatable table directive: `@fullText(name: "search", fields: ...)`.
- Persist full-text declarations as table-level derived-index metadata, not record attributes.
- Keep `Table.search()` and REST conditions unchanged: the `matches*` comparator resolves `attribute: "search"` through the full-text registry.
- Remove the record resolver, write projection, and write guard created only to make a pseudo-field behave unlike record data.
- This contract is unreleased, so no stored `FullText` attribute migration is required.
- Keep the feature unavailable for release until the query planner and integration route are complete; before that, `matches*` returns an explicit unsupported-comparator error.

## Invariant

A derived full-text index identifier never owns, hides, rewrites, or removes record data with the same name.

## Problem

**Verified:** [PR 2615](https://github.com/HarperFast/harper/pull/2615) currently represents an index as a hidden record attribute. Harper permits dynamic fields unless a table is sealed. Activating `search: FullText` therefore makes the record encoder remove an existing dynamic `search` value on the next unrelated write. The durable-descriptor collision check catches declared fields but cannot prove that an unsealed table has no dynamic field with that name.

**Verified:** detecting every collision before publishing the schema requires scanning and decoding the table. `table()` currently publishes schema synchronously, while native full-text activation and rebuild are asynchronous. At the expected catalog scale, putting that scan in schema compilation would add an unbounded record walk to the schema-authoring critical section. No representative timing measurement exists yet.

## Chosen design

Declare one or more indexes on the table:

```graphql
type Product
	@table(audit: true)
	@fullText(name: "search", fields: [{ name: "title", weight: 3 }, { name: "description" }], analyzer: "english@1") {
	id: ID @primaryKey
	title: String
	description: String
}
```

`@fullText` is repeatable. `name` is unique within the table's derived-index registry. It is not added to `Table.attributes`, JSON Schema properties, record validation, record encoding, or ordinary secondary indexes.

The complete declaration list is stored on the table's canonical primary descriptor. It does not use `tableName/indexName` attribute keys. The list and referenced source descriptors are committed under the same schema transaction, so reload cannot observe a newly published declaration without its sources. An unchanged declaration does not acquire an LMDB environment-wide writer lock.

The query remains within Harper's existing condition shape:

```js
Product.search([
	{ attribute: 'search', comparator: 'matches', value: 'red shoes' },
	{ attribute: 'status', comparator: 'equals', value: 'active' },
]);
```

The full-text comparator selects the derived-index namespace. Ordinary comparators continue to interpret `attribute: "search"` as record data, so an unsealed table may keep a dynamic field with the same spelling without ambiguity or data loss.

That comparator-specific dual meaning is intentional. A non-full-text comparator targeting a name that exists only in the full-text registry returns a precise unknown-record-attribute error. A full-text comparator targeting a name that exists only as record data returns an unknown-full-text-index error. SQL does not gain a separate full-text syntax in this unit of work.

Full-text query authorization requires table read access and read access to every declared source attribute. Highlighting applies the same rule. This prevents match scores, terms, or snippets from revealing a source field the caller cannot read.

### Ownership

| Layer                   | Responsibility                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GraphQL schema compiler | Parse repeatable table directives and validate source fields.                                                      |
| Table catalog           | Persist canonical full-text declarations on the primary descriptor and reconcile replicated schema per index name. |
| Derived-index runtime   | Attach native indexes from table-level declarations and own readiness, replay, rebuild, and shutdown.              |
| Query planner           | Resolve only full-text comparators through the named full-text registry.                                           |
| `@harperfast/fulltext`  | Own Tantivy indexing and search behavior; remain unaware of Harper schemas and records.                            |

### Implementation sequence

1. Move the canonical full-text declaration collection from `Attribute.fullText` to table metadata.
2. Parse every table-level `@fullText` directive and reject duplicate names or invalid sources.
3. Validate that the table's audit transaction log is enabled before persisting a declaration; attachment faults mark the index unavailable without preventing the table from loading.
4. Persist the complete declaration list on the table's canonical primary descriptor in the same schema transaction as its source descriptors. Persist only when the canonical list changes.
5. Merge cluster-origin declarations per index name: accept peer-new names; keep local definitions on conflicts and warn; validate under the existing cluster schema lock.
6. Attach one native backend per declaration from the table-level list, with projections over its source fields.
7. Delete the `FullText` scalar, pseudo-field resolver, record write guard, storage projection behavior, and attribute-row ordering created for pseudo-fields.
8. Route `matches*` comparators to the full-text registry before ordinary attribute lookup and enforce read access to every source field.
9. Add unit coverage for multiple indexes, duplicate names, dynamic same-name record data, unchanged LMDB reload, atomic reload, per-name replication reconciliation, audit rejection, authorization, and native activation.

## Approaches considered

| Axis            | Candidate                                                                                                                  | Decision                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different layer | Keep the pseudo-field and scan every existing record before activation.                                                    | Rejected. It adds an unbounded synchronous table scan to schema publication and duplicates the native rebuild's record walk. Staging the schema until the rebuild completes would add a second schema state machine. |
| Deeper cause    | Create one new generic registry and migrate HNSW plus full-text declarations into it.                                      | Rejected. HNSW indexes a real stored vector attribute, so its attribute ownership is valid. Migrating it would change a working public schema and catalog format without fixing another known invariant violation.   |
| Do less         | Keep the pseudo-field but preserve colliding dynamic values in storage.                                                    | Rejected. The same name would still alternate between record data and a query-only resolver across read, REST, and GraphQL surfaces, so behavior would depend on the access path even if bytes were retained.        |
| Chosen          | Store repeatable named full-text declarations as table-level metadata and resolve the name only for full-text comparators. | Chosen because it removes the collision state entirely, preserves the existing query condition shape, and deletes record-path special cases.                                                                         |

## Verification plan

- Unit: schema parsing, primary-descriptor persistence, atomic reload, per-name cluster reconciliation, duplicate names, audit rejection, and source evolution.
- Unit: a dynamic record field with the same name survives full-text activation and unrelated updates.
- Unit: multiple full-text indexes attach independently.
- Unit: full-text query authorization requires read access to every source field.
- Unit: until the planner lands, `matches*` fails with an explicit 400 and never falls through to equality.
- Integration: schema load, write, restart/replay, and `Table.search()` plus REST query against the same native index.
- Performance: compare activation and query benchmarks before and after the schema rewrite; no improvement is claimed until measured.

## Open items

- The query planner work is not yet implemented; the condition-routing claim above is the target contract.
- Native index retirement remains tracked separately and is not changed by this namespace decision.
- End-to-end verification is blocked until the query path exists.
- Mixed builds exchange incompatible unreleased schema metadata; schema and runtime branches must land and release together.

## Sources

- [PR 2615: Add `@fullText` schema declaration and validation](https://github.com/HarperFast/harper/pull/2615)
- [Issue 2513: Add `@fullText` schema declaration, validation, activation, and introspection](https://github.com/HarperFast/harper/issues/2513)
- [`resources/RecordEncoder.ts`](../resources/RecordEncoder.ts)
- [`resources/databases.ts`](../resources/databases.ts)
- [`resources/Table.ts`](../resources/Table.ts)
