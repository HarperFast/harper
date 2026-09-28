# Full-text search

Declare a `FullText` field to name an index over stored text sources. Search that field with a full-text comparator; read the original source fields and optional search metadata in the results.

## Declare an index

```graphql
type Product @table(audit: true) @export {
	id: ID @primaryKey
	title: String
	description: String
	tags: [String]
	catalogSearch: FullText
		@fullText(
			fields: [{ name: "title", weight: 3, highlight: true }, { name: "description" }, { name: "tags" }]
			highlighting: { maxFragments: 2, fragmentLength: 120 }
		)
}
```

The field name, `catalogSearch`, identifies the index. `@fullText` accepts no `name` argument and is supported only on a `FullText` field. Source order in the table declaration does not matter.

Sources may be stored `String`, `[String]`, or `Blob` fields. A Blob source requires `mediaType: "text/plain"` in its `fields` entry. Computed fields, relationships, and other full-text fields cannot be sources. Weights must be positive finite numbers and default to `1`.

The supported analyzer is `english@2`. `stopWords`, `positions`, and `surfaceTerms` default to `true`. Phrase queries require positions; prefix and fuzzy-prefix queries require surface terms. Highlighting also requires surface terms, a `highlighting` configuration, and at least one source with `highlight: true`.

## Search

From an authenticated Resource handler, request table permission checks and pass its context through to `Product.search()`:

```javascript
return Product.search(
	{
		checkPermission: true,
		conditions: [
			{
				attribute: 'catalogSearch',
				comparator: 'matches',
				value: 'trail shoes',
				maxIndexLagMilliseconds: 0,
				waitForIndexMilliseconds: 30_000,
			},
		],
		select: ['id', 'title', '$score', '$highlights'],
		limit: 20,
	},
	this.getContext()
);
```

Selecting `$highlights` requests highlighting; a structured condition may also set `includeHighlights: true`. `$score` contains the relevance score. Highlights are grouped by source field and value, with character spans and optional fragments. Only sources configured with `highlight: true` contribute highlights.

A REST search uses the exported table path:

```text
GET /Product/?catalogSearch=matches=trail%20shoes&select(id,title,$score,$highlights)&limit(20)
```

| Comparator             | Query mode      |
| ---------------------- | --------------- |
| `matches`              | Any query term  |
| `matches_all`          | All query terms |
| `matches_phrase`       | Phrase          |
| `matches_prefix`       | Prefix          |
| `matches_fuzzy`        | Fuzzy           |
| `matches_fuzzy_prefix` | Fuzzy prefix    |

Use `fields: ['title']` on a structured condition to search a subset of an index's sources. Combine ordinary record filters with full-text conditions using `and`. Full-text Boolean groups must use one index; an `or` group cannot mix full-text and ordinary record conditions. Negated full-text conditions require at least one positive full-text condition.

Indexes follow committed record changes asynchronously. `waitForIndexMilliseconds` bounds how long the query waits for index coverage; `maxIndexLagMilliseconds` controls acceptable lag. A query can fail while its index is unavailable, rebuilding, or behind the requested coverage. Waiting for coverage does not promise a global snapshot across concurrent record changes.

## Fields, permissions, and results

`FullText` is declaration-only: `catalogSearch` has no stored or selectable record value. Records written under this schema and record input/output schemas omit it. Selecting it, sorting on it, comparing it as an ordinary scalar, or writing it returns an error. New-write protection also applies to unsealed tables and persists while the index is unavailable. Use `$score` and `$highlights` for search results.

Use the nullable `FullText` type exactly. Lists, non-null forms, and additional directives such as `@computed`, `@indexed`, or `@allow` are rejected. `FullText` without `@fullText` is also invalid.

Authorization uses the searched source fields. A caller must be allowed to read every source searched by the condition; specifying `fields` narrows that set. Configure permissions on sources such as `title`, not on `catalogSearch`. A permission entry for the virtual index name does not grant access to its sources. Normal table authorization and application row filters still apply. Internal calls without a user or explicit permissions are trusted. Custom endpoints must preserve the authenticated context and set `checkPermission: true` when delegating to the table; context propagation alone does not request its table permission check.

`describe_table` exposes the declaration under `full_text_indexes`, including its name, source configuration, supported query modes, and readiness. Source lists are filtered by the caller's read permissions. The declaration is absent from the ordinary `attributes` list and record schemas, including generated OpenAPI and MCP schemas.

Weight and highlighting changes preserve the physical index; changes to sources, analyzer settings, synonyms, positions, or surface terms require rebuilding. Renaming the index creates a new identity.

## Native package and limits

Harper pins `@harperfast/fulltext` to **0.3.0** and validates the native runtime capabilities before activation. Full-text activation requires RocksDB and explicit `@table(audit: true)`; keep audit logging enabled while an index is declared. LMDB is rejected. A missing or incompatible native package prevents activation.

Earlier beta declarations and indexes are unsupported. This field-only API does not provide a compatibility or upgrade path for them.

Native queries have finite result windows and execution budgets. Reduce the requested offset/limit or narrow the query when a window is exceeded; filtering can also exhaust the window. Prefix modes use the native autocomplete window. Highlight tracing has separate record and source-byte bounds. These are functional constraints, not catalog-scale performance guarantees.

For implementation details, see the [full-text invariants in the Resource design guide](DESIGN.md#full-text-declarations-and-reader-snapshots). The schema contract lives in [schema.graphql](../schema.graphql); the compiler and generation rules are in [fullTextSchema.ts](fullTextSchema.ts).
