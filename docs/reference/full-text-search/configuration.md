---
title: Configuration
---

# Full-Text Search Configuration

<VersionBadge version="v5.3.0" /> <EngineBadge engines="RocksDB" />

Declare a nullable `FullText` field on an audited RocksDB table and attach `@fullText` to that field. The field name identifies the index. Add another `FullText` field when one table needs independent indexes for different search experiences.

```graphql
type Product @table(database: "catalog", audit: true) {
	id: ID @primaryKey
	name: String
	description: String
	tags: [String]
	category: String @indexed
	price: Float @indexed
	available: Boolean
	catalogSearch: FullText
		@fullText(
			fields: [
				{ name: "name", weight: 3, highlight: true }
				{ name: "description", weight: 1, highlight: true }
				{ name: "tags", weight: 1 }
			]
			filterFields: ["category", "available"]
			highlighting: { maxFragments: 2, fragmentLength: 120 }
		)
}
```

`catalogSearch` is a query-only declaration. It is not stored, selectable, writable, or included in record, OpenAPI, or MCP schemas. Use the field name as the condition attribute and select `$score` or `$highlights` for search metadata.

The declaration must use nullable `FullText` exactly and carry one `@fullText` directive. Lists, non-null forms, a bare `FullText` field, and additional directives such as `@computed`, `@indexed`, or `@allow` are rejected. `@fullText` is not valid on a table type or any other field type.

New schema tables must explicitly set `@table(audit: true)`; omitting it or setting `audit: false` returns `400`. An existing table that already has persisted audit logging can add the field without restating `audit`. A previously unaudited table can enable `audit: true` in the same schema change that adds its first full-text field; the initial build scans current records and does not require older transaction history. Disabling audit logging while a full-text field exists is rejected.

Writing the declaration-only field or selecting it as record data returns an error, including on unsealed tables. A read-through source response containing that name fails with `502` and is not cached, indexed, or audited. For HTTP-sourced caching tables, avoid index names that collide with response wrapper fields such as `data`, `headers`, `body`, and `status`.

:::warning Prerelease schema declarations
Earlier prerelease type-level `@fullText(name: ...)` declarations are not supported. Move the directive to a nullable `FullText` field and use that field's name as the index identity.
:::

## Directive options

| Option         | Default       | Description                                                                           |
| -------------- | ------------- | ------------------------------------------------------------------------------------- |
| `fields`       | required      | One or more source fields.                                                            |
| `filterFields` | `[]`          | Stored attributes copied into Tantivy as typed, score-neutral filter metadata.        |
| `analyzer`     | `"english@2"` | Versioned text analyzer. `english@2` is the only supported value.                     |
| `stopWords`    | `true`        | Removes common English terms during analysis.                                         |
| `positions`    | `true`        | Stores token positions. Required for phrase queries.                                  |
| `surfaceTerms` | `true`        | Stores unstemmed analyzed terms. Required for prefix, fuzzy-prefix, and highlighting. |
| `synonyms`     | `[]`          | Index-time synonym expansion rules.                                                   |
| `highlighting` | omitted       | Enables highlight generation and sets fragment limits.                                |

Each field entry supports:

| Option      | Default  | Description                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------------ |
| `name`      | required | Stored source field name.                                                      |
| `weight`    | `1`      | Positive relevance weight. Higher values contribute more to BM25 ranking.      |
| `highlight` | `false`  | Allows highlights from this field when index highlighting is enabled.          |
| `mediaType` | omitted  | Required as `"text/plain"` for a `Blob` source; invalid on other source types. |

Source fields cannot use `@computed` or `@relationship`. Indexable source values are strings, arrays containing strings or nulls, or Blob values declared as plain text.

## Filter metadata

`filterFields` copies selected stored attributes into the Tantivy index. Tantivy can apply those conditions before returning ranked IDs, reducing record reads without changing BM25 scores. Harper still loads the returned records and checks the original conditions, permissions, and row filters before returning them.

Schema configuration controls which conditions Tantivy can apply directly. It does not restrict Harper queries. A condition on an attribute omitted from `filterFields` still works, but Harper applies it after full-text search. Query syntax does not change; Harper pushes eligible conditions automatically.

| Declaration                   | Purpose                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `fields` in `@fullText`       | Analyzed text that contributes to BM25 scoring                                |
| `filterFields` in `@fullText` | Typed metadata that narrows one full-text index without changing scores       |
| `@indexed` on an attribute    | Independent Harper secondary index; not required for a full-text filter field |

Each full-text index has its own filter metadata. Configure attributes commonly combined with text search rather than every table attribute. Filter metadata increases index size and write work.

Supported attributes are `String`, `Boolean`, `Int`, `Long`, `Float`, `Date`, and lists of those types. Equality and `in` can be pushed for every supported type. Lower-bounded and bounded ranges can be pushed for `Int`, `Long`, and `Date`. Harper retains other conditions as record filters. Lists match when any element matches. Null, missing, and empty-list values are not indexed. Filter strings are limited to 65,530 UTF-8 bytes. Computed fields and relationships are not supported.

## Phrase and prefix support

`positions` and `surfaceTerms` trade index size for query features. Keep their defaults unless storage measurements show that the features are unnecessary.

```graphql
type Article @table(audit: true) {
	id: ID @primaryKey
	body: String
	bodySearch: FullText @fullText(fields: [{ name: "body" }], positions: false, surfaceTerms: false)
}
```

This smaller declaration supports `matches`, `matches_all`, and `matches_fuzzy`. It rejects phrase, prefix, fuzzy-prefix, and highlighting requests.

## Highlighting

Highlighting is off by default. To enable it:

1. Set `highlight: true` on at least one source field.
2. Add `highlighting` to the directive.
3. Keep `surfaceTerms: true`.

```graphql
articleSearch: FullText
	@fullText(
		fields: [{ name: "title", highlight: true }, { name: "body", highlight: true }]
		highlighting: { maxFragments: 3, fragmentLength: 160 }
	)
```

`maxFragments` and `fragmentLength` must be positive integers. Query results contain offsets into the original field value; see [Highlights](./querying.md#highlights).

## Synonyms

Synonyms expand terms while records are indexed:

```graphql
catalogSearch: FullText
	@fullText(
		fields: [{ name: "description" }]
		synonyms: [
			{ source: "sneaker", replacements: ["shoe", "trainer"] }
			{ source: "tv", replacements: ["television"] }
		]
	)
```

Rules require one source term and one or more unique replacement terms. A rule cannot replace a term with itself.

## Multiple indexes

Add separate `FullText` fields when separate index definitions are useful:

```graphql
type Product @table(database: "catalog", audit: true) {
	id: ID @primaryKey
	name: String
	tags: [String]
	titleSearch: FullText @fullText(fields: [{ name: "name", weight: 2 }])
	tagSearch: FullText @fullText(fields: [{ name: "tags" }])
}
```

The indexes update independently and can be queried independently. A single query cannot combine conditions from different full-text indexes.

## Blob sources

Only plain-text Blob fields are supported:

```graphql
type Document @table(audit: true) {
	id: ID @primaryKey
	content: Blob
	contentSearch: FullText @fullText(fields: [{ name: "content", mediaType: "text/plain" }])
}
```

`mediaType: "text/plain"` declares the expected Blob media type. Harper does not reject the source record write, but the derived index checks a nonempty runtime `Blob.type` and excludes the record when it does not match `text/plain`. The index decodes matching Blobs as UTF-8. A Blob source is limited to 1 MiB (1,048,576 bytes). A media-type mismatch, oversized value, or invalid UTF-8 removes the whole record from the index rather than indexing only its other fields. A transient Blob read failure rolls back the accepted native batch and retries it, so index coverage does not advance past unread source data.

## Schema changes and rebuilds

Changes that affect indexed storage create a new local index generation and rebuild from source data. These include source membership, source order, media types, filter fields, analyzer settings, stop-word handling, positions, surface terms, and synonyms. Keep the `fields` list in a stable order when its meaning has not changed.

While a generation rebuilds, ordinary table reads and writes remain available, but full-text queries on that node return retryable `503` responses until the index is ready.

Changing source weights or highlighting settings changes query behavior without rebuilding indexed term storage. Removing the `FullText` field retires its local files after the schema change is confirmed. Renaming the field creates a new index identity and retires the old one.

## Inspecting an index

`describe_table` reports `full_text_indexes`, including fields, analyzer options, supported query modes, and readiness:

```json
{
	"operation": "describe_table",
	"database": "catalog",
	"table": "Product"
}
```

The table response includes entries shaped like this:

```json
{
	"full_text_indexes": [
		{
			"name": "catalogSearch",
			"fields": [{ "name": "name", "weight": 3, "highlight": true }],
			"analyzer": "english@2",
			"stop_words": true,
			"positions": true,
			"surface_terms": true,
			"synonyms": [],
			"highlighting": { "maxFragments": 2, "fragmentLength": 120 },
			"query_modes": ["any", "all", "fuzzy", "phrase", "prefix", "fuzzy-prefix"],
			"readiness": { "state": "ready", "owner_epoch": "4", "rebuild_attempts": 0 }
		}
	]
}
```

`readiness.state` is `unknown`, `ready`, `needs-rebuild`, `rebuilding`, or `unavailable`. Only `ready` serves full-text queries. `unknown` is an activation or owner-election transition. `needs-rebuild` means the runtime has condemned the current generation and queued an automatic rebuild. Queries in `unknown`, `needs-rebuild`, or `rebuilding` return `503` with retryable code `INDEX_REBUILDING`. `unavailable` means activation failed or the automatic rebuild budget was exhausted; queries return a generic, non-retryable `503`. Inspect the optional `readiness.reason` and the node logs, correct the underlying storage, native-module, schema, or transaction-log problem, then reload or reapply the schema to retry activation.

`query_modes` maps to comparators as follows: `any` → `matches`, `all` → `matches_all`, `fuzzy` → `matches_fuzzy`, `phrase` → `matches_phrase`, `prefix` → `matches_prefix`, and `fuzzy-prefix` → `matches_fuzzy_prefix`. `owner_epoch` is an opaque decimal string used to fence work between derived-index owners; clients should not parse or persist it. `rebuild_attempts` is the current automatic-attempt count. `reason` is present when readiness has an operator-actionable explanation.

The Operations API uses snake_case for response metadata such as `stop_words`, `surface_terms`, and `owner_epoch`. The nested `highlighting` value mirrors the GraphQL option names `maxFragments` and `fragmentLength`.
