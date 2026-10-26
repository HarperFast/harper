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

The field name, `catalogSearch`, identifies the index. `@fullText` accepts no `name` argument and is supported only on a `FullText` field. Keep the source order stable: reordering the `fields` entries is treated as a storage configuration change and rebuilds the index.

Sources may be stored `String`, `[String]`, or `Blob` fields. A Blob source requires `mediaType: "text/plain"` in its `fields` entry. Computed fields, relationships, and other full-text fields cannot be sources. Weights must be positive finite numbers and default to `1`.

The supported analyzer is `english@2`. `stopWords`, `positions`, and `surfaceTerms` default to `true`. Phrase queries require positions; prefix and fuzzy-prefix queries require surface terms. Highlighting also requires surface terms, a `highlighting` configuration, and at least one source with `highlight: true`.

## Search

From an authenticated Resource handler, request table permission checks and pass its context through to `Product.search()`:

```javascript
return tables.Product.search(
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

Full-text predicates must name an index directly on the queried table; relationship and nested-path full-text predicates are unsupported.

Indexes follow committed record changes asynchronously. `maxIndexLagMilliseconds` defaults to `3000`; set it to `0` to require current coverage. `waitForIndexMilliseconds` defaults to `0` and may be set as high as `30000` to wait for writes committed before the search begins. A query can fail while its index is unavailable, rebuilding, or behind the requested coverage. A non-waiting REST response includes `Harper-Index-Coverage`. Waiting for coverage does not promise a global snapshot across concurrent record changes.

## Fields, permissions, and results

`FullText` is declaration-only: `catalogSearch` has no stored or selectable record value. Records written under this schema and record input/output schemas omit it. Selecting it, sorting on it, comparing it as an ordinary scalar, or writing it returns an error. New-write protection also applies to unsealed tables and persists while the index is unavailable. Use `$score` and `$highlights` for search results.

A read-through source must also omit the declaration-only name. A source response that includes it fails with a 502 response and is not returned, cached, indexed, or audited.
On HTTP-sourced caching tables, avoid index names that collide with response wrapper fields: `data`, `headers`, `body`, and `status`.

Use the nullable `FullText` type exactly. Lists, non-null forms, and additional directives such as `@computed`, `@indexed`, or `@allow` are rejected. `FullText` without `@fullText` is also invalid.

Authorization uses the searched source fields. A caller must be allowed to read every source searched by the condition; specifying `fields` narrows that set. Configure permissions on sources such as `title`, not on `catalogSearch`. A permission entry for the virtual index name does not grant access to its sources. Normal table authorization and application row filters still apply. Internal calls without a user or explicit permissions are trusted. Custom endpoints must preserve the authenticated context and set `checkPermission: true` when delegating to the table; context propagation alone does not request its table permission check.

`describe_table` exposes the declaration under `full_text_indexes`, including its name, source configuration, supported query modes, and readiness. Source lists are filtered by the caller's read permissions. The declaration is absent from the ordinary `attributes` list and record schemas, including generated OpenAPI and MCP schemas.

Weight and highlighting changes preserve the physical index and refresh query readers. Changing source membership, order, or media type, or changing the analyzer, stop words, synonyms, positions, or surface terms requires rebuilding. Renaming the index creates a new identity.

## Native package and limits

Harper pins `@harperfast/fulltext` to **0.6.0** and validates the native runtime capabilities before activation. Full-text activation requires RocksDB and an audited table. Declare new schema tables with `@table(audit: true)` and keep audit logging enabled while an index is declared. LMDB is rejected. A missing or incompatible native package prevents activation.

A format-incompatible native package upgrade causes each node to rebuild its local derived index from authoritative records. Full-text queries on that node return 503 until the index is ready. Use a rolling upgrade to keep full-text search available on other replicas while each local index rebuilds.

Earlier beta declarations and indexes are unsupported. This field-only API does not provide a compatibility or upgrade path for them.

## Paging and work limits

Full-text search uses Harper's usual `limit` and `offset` options. `Table.search()` returns an iterable, including when a custom Resource forwards or filters it.

```javascript
return tables.Product.search(
	{
		checkPermission: true,
		conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
		offset: 20,
		limit: 20,
	},
	this.getContext()
);
```

The equivalent REST range has an inclusive start and exclusive end:

```text
GET /Product/?catalogSearch=matches=trail%20shoes&limit(20,40)
```

Each page runs a new query. Changes to records, permissions, or the index can move results between requests, so separate pages may omit or repeat records. There is no retained search or cross-request snapshot.

Within one request, Harper reads native batches on the same index reader until enough eligible records have been found or the matches are exhausted. Current source versions and record filters are checked before counting records toward the offset and limit. This traversal also lets prefix and fuzzy-prefix searches return more than the initial autocomplete batch. The library's ordinary search window is not a total-result cutoff for a bounded Harper request.

Use a bounded `limit` for large result sets. An unbounded query that exceeds the native result window returns 400. Offset requests revisit earlier matches; deep offsets and restrictive filters can exhaust the work or time budget. Harper can retain up to `offset + limit` accepted records while building a bounded result, so raising the work limit can also increase memory use. An exhausted search returns its remaining eligible records, including an empty result. A budget failure returns an error instead of a successful incomplete page.

Search settings are under `storage.fullText`:

| Setting                     | Default | Meaning                                                                                                           |
| --------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------- |
| `maxRawHitsPerRequest`      |  10,000 | Fetched native hits, including bounded prefix replay                                                              |
| `maxResultsPerRequest`      |  10,000 | Maximum retained offset plus limit, independent of fetched-hit work                                               |
| `requestBudgetMilliseconds` |   5,000 | Execution budget across native batches, source checks and highlight tracing, capped by the native execution limit |

The hit limit counts fetched hits, not every record Tantivy visits while scoring. Reaching it before the page fills or the search is exhausted returns 400. Exceeding the execution budget returns 503. Narrow the query, reduce the offset, or increase the relevant configured budget. Freshness waiting uses `waitForIndexMilliseconds` separately. Reader acquisition, query construction and some native operations can take additional time; the execution budget is not a hard response-time guarantee.

Each setting has the usual configuration parameter name, such as `storage_fullText_maxRawHitsPerRequest`, for `set_configuration` and environment overrides. After changing request limits, restart HTTP workers with `restart_service` (`service: "http_workers"`) or restart Harper. Native process-budget changes require a full process restart.

Native process admission settings live under `storage.fullText.runtime`:

| Setting                | Default |
| ---------------------- | ------: |
| `maxResidentIndexes`   |     128 |
| `maxIndexingThreads`   |     128 |
| `maxSearchThreads`     |     256 |
| `maxWriterMemoryBytes` |   4 GiB |
| `maxQueuedBytes`       |   8 GiB |
| `maxExpensiveSearches` |       8 |

These limits apply together. For example, two indexing threads and 64 MiB of writer memory per index reach the default thread and memory budgets at 64 indexes. Readers share an index's runtime; they do not allocate another writer. Admission limits are not hard bounds on total resident memory or disk usage.

Harper captures native runtime budgets before loading application components, or on an earlier main-thread native load or managed worker spawn. Application-created workers inherit that configuration. A worker created before capture fails with `FullTextWorkerInitializationError` (500, non-retryable); recreate it after Harper initializes. Replacement workers keep the established budgets after a live configuration change. Restart the Harper process to apply new native runtime budgets; restarting only HTTP workers is insufficient.

Harper does not configure the library's native filter metadata or submit native filter or candidate-ID requests. Ordinary conditions continue through Harper's secondary-index gates and authoritative record predicates. Native page, response-byte and highlight limits still apply. Fulltext 0.6.0 also limits each analyzed query leaf to 64 terms and the compiled query to 256 clauses. Raising Harper's work budgets does not raise those limits. See the [published library limits](https://github.com/HarperFast/fulltext/blob/v0.6.0/docs/limits.md) for the full list and recovery guidance. Configuration of those query limits is tracked in [Make query term and clause limits configurable with bounded resource policy](https://github.com/HarperFast/fulltext/issues/63).

For implementation details, see the [full-text invariants in the Resource design guide](DESIGN.md#full-text-declarations-and-reader-snapshots). The schema contract lives in [schema.graphql](../schema.graphql); compiler and generation rules live in [fullTextSchema.ts](fullTextSchema.ts).
