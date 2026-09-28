---
title: Configuration
---

# Full-Text Search Configuration

<VersionBadge version="v5.3.0" /> <EngineBadge engines="RocksDB" />

Declare a full-text index with `@fullText` on an audited RocksDB table type. The directive is repeatable, so one table can have independent indexes for different search experiences.

```graphql
type Product
	@table(database: "catalog", audit: true)
	@fullText(
		name: "catalogSearch"
		fields: [
			{ name: "name", weight: 3, highlight: true }
			{ name: "description", weight: 1, highlight: true }
			{ name: "tags", weight: 1 }
		]
		highlighting: { maxFragments: 2, fragmentLength: 120 }
	) {
	id: ID @primaryKey
	name: String
	description: String
	tags: [String]
	price: Float @indexed
}
```

The index name is the attribute used in search conditions. It does not add a stored field to each record.

## Directive options

| Option         | Default       | Description                                                                          |
| -------------- | ------------- | ------------------------------------------------------------------------------------ |
| `name`         | required      | Unique index name on the table.                                                      |
| `fields`       | required      | One or more source fields.                                                           |
| `analyzer`     | `"english@2"` | Versioned text analyzer. `english@2` is the only supported value.                    |
| `stopWords`    | `true`        | Removes common English terms during analysis.                                        |
| `positions`    | `true`        | Stores token positions. Required for phrase queries.                                 |
| `surfaceTerms` | `true`        | Stores original analyzed terms. Required for prefix, fuzzy-prefix, and highlighting. |
| `synonyms`     | `[]`          | Index-time synonym expansion rules.                                                  |
| `highlighting` | omitted       | Enables highlight generation and sets fragment limits.                               |

Each field entry supports:

| Option      | Default  | Description                                                                    |
| ----------- | -------- | ------------------------------------------------------------------------------ |
| `name`      | required | Stored source field name.                                                      |
| `weight`    | `1`      | Positive relevance weight. Higher values contribute more to BM25 ranking.      |
| `highlight` | `false`  | Allows highlights from this field when index highlighting is enabled.          |
| `mediaType` | omitted  | Required as `"text/plain"` for a `Blob` source; invalid on other source types. |

Source fields cannot use `@computed` or `@relationship`. At write time, a source value must be a string, an array containing strings or nulls, or a matching text Blob.

## Phrase and prefix support

`positions` and `surfaceTerms` trade index size for query features. Keep their defaults unless storage measurements show that the features are unnecessary.

```graphql
type Article
	@table(audit: true)
	@fullText(name: "bodySearch", fields: [{ name: "body" }], positions: false, surfaceTerms: false) {
	id: ID @primaryKey
	body: String
}
```

This smaller declaration supports `matches`, `matches_all`, and `matches_fuzzy`. It rejects phrase, prefix, fuzzy-prefix, and highlighting requests.

## Highlighting

Highlighting is off by default. To enable it:

1. Set `highlight: true` on at least one source field.
2. Add `highlighting` to the directive.
3. Keep `surfaceTerms: true`.

```graphql
@fullText(
	name: "articleSearch"
	fields: [{ name: "title", highlight: true }, { name: "body", highlight: true }]
	highlighting: { maxFragments: 3, fragmentLength: 160 }
)
```

`maxFragments` and `fragmentLength` must be positive integers. Query results contain offsets into the original field value; see [Highlights](./querying.md#highlights).

## Synonyms

Synonyms expand terms while records are indexed:

```graphql
@fullText(
	name: "catalogSearch"
	fields: [{ name: "description" }]
	synonyms: [
		{ source: "sneaker", replacements: ["shoe", "trainer"] }
		{ source: "tv", replacements: ["television"] }
	]
)
```

Rules require one source term and one or more unique replacement terms. A rule cannot replace a term with itself.

## Multiple indexes

Repeat `@fullText` when separate index definitions are useful:

```graphql
type Product
	@table(database: "catalog", audit: true)
	@fullText(name: "titleSearch", fields: [{ name: "name", weight: 2 }])
	@fullText(name: "tagSearch", fields: [{ name: "tags" }]) {
	id: ID @primaryKey
	name: String
	tags: [String]
}
```

The indexes update independently and can be queried independently. A single query cannot combine conditions from different full-text indexes.

## Blob sources

Only plain-text Blob fields are supported:

```graphql
type Document
	@table(audit: true)
	@fullText(name: "contentSearch", fields: [{ name: "content", mediaType: "text/plain" }]) {
	id: ID @primaryKey
	content: Blob
}
```

Harper validates the Blob's media type when applying it to the index.

## Schema changes and rebuilds

Changes that affect indexed storage create a new local index generation and rebuild from source data. These include source names and media types, analyzer settings, stop-word handling, positions, surface terms, and synonyms.

Changing source weights or highlighting settings changes query behavior without rebuilding indexed term storage. Removing an index retires its local files after the schema change is confirmed.

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

`readiness.state` is `ready`, `rebuilding`, or `unavailable`. `readiness.reason` is included when Harper has more detail. Full-text queries are served only after readiness is established.

The Operations API uses snake_case for response metadata such as `stop_words`, `surface_terms`, and `owner_epoch`. The nested `highlighting` value mirrors the GraphQL option names `maxFragments` and `fragmentLength`.
