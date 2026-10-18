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

Harper keeps the requested `offset + limit` within the native ordinary result window. When source checks or other conditions reject the first batch, Harper uses native traversal to reach later matches on the same reader snapshot. This also lets prefix and fuzzy-prefix queries return more than the native first-batch autocomplete limit. Raw batch sizes are bounded by the installed addon’s page and response-byte limits; all batches share one execution budget. A timeout returns an error rather than a successful incomplete page. If the snapshot runs out of eligible matches, Harper returns the remaining matches, including an empty result; filtering beyond an old native window no longer causes a 400 error.

Each request also has a configurable work budget: `storage.fullText.maxRawHitsPerRequest` defaults to 100,000 native hits, including the initial replay. If that budget is reached before the page fills or the snapshot ends, Harper returns a 400 error. Narrow the query or increase the configured budget; Harper does not return a successful incomplete page. This limit counts fetched hits, not every record Tantivy visits while scoring.

Ordinary offset-based requests each use their own snapshot and may observe different index publications. Use continuation mode below to keep the original search across requests. Highlight tracing has separate record and source-byte bounds. Query construction and some native operations cannot be interrupted, so the execution budget is not a hard response-time guarantee.

Harper does not configure Fulltext's native filter metadata or submit native filter or candidate-ID requests. Ordinary conditions continue through Harper's secondary-index gates and authoritative record predicates.

For implementation details, see the [full-text invariants in the Resource design guide](DESIGN.md#full-text-declarations-and-reader-snapshots). The schema contract lives in [schema.graphql](../schema.graphql); the compiler and generation rules are in [fullTextSchema.ts](fullTextSchema.ts).

## Continue a search across requests

Start with `continuation: true` and a positive `limit`. Awaiting this mode returns an array with
`continuation`, `complete`, and `expiresAt` properties. These properties are not part of the JSON
array body. Ordinary searches keep their existing iterable return value.

```js
const query = {
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	limit: 25,
};
let continuation = true;
do {
	const page = await Product.search({ ...query, continuation });
	for (const record of page) console.log(record);
	continuation = page.continuation;
} while (continuation);
```

Keep the same conditions and selected fields when resuming. The page size may change. Each request
checks the caller's current permissions and loads current records. The retained snapshot fixes index
matches and their ranking; it does not retain historical Harper records. Updated, deleted, expired,
or newly unauthorized records can be omitted. New index matches do not enter that search.

REST uses `continuation()` for the first request and `continuation(token)` for later requests:

```text
GET /Product/?catalogSearch=matches=trail%20shoes&limit(25)&continuation()
```

Read the next token from `Harper-Continuation` and pass it back unchanged, URL-encoded. The body stays
a JSON array. `Harper-Continuation-Complete` says whether traversal finished;
`Harper-Continuation-Expires` is the absolute expiry time in milliseconds since the Unix epoch.
These headers are exposed to browser clients. Continuation responses use `Cache-Control: no-store`.
Nonzero offsets, count requests, and other result ordering cannot be combined with continuation.

To stop early, repeat the query with its token and `closeContinuation: true`. In REST, add
`closeContinuation()` alongside `continuation(token)`. Closing returns an empty completed page.
Completion, explicit close, expiry, index reset, definition changes, worker loss, and process restart
release or invalidate the search. A previous token then returns 410; start a new search. Retries
before completion keep the same index boundary, but current record and permission changes can
change the returned rows. Continuation stays on one Harper instance; it does not coordinate servers.

All continuation settings are under `storage.fullText`:

| Setting                     | Default | What it bounds                                      |
| --------------------------- | ------: | --------------------------------------------------- |
| `cursorTtlMilliseconds`     |  60,000 | Absolute lifetime; paging does not extend it        |
| `maxCursors`                |       4 | Retained searches across all workers in one process |
| `maxRetainedQueryBytes`     |   8 MiB | Retained native query text and identity bytes       |
| `maxPageSize`               |   1,000 | Returned records per page                           |
| `requestBudgetMilliseconds` |   5,000 | Freshness wait and native/page processing budget    |
| `maxRawHitsPerRequest`      | 100,000 | Fetched native hits, including replayed batches     |
| `maxPendingRequests`        |      32 | Pending worker requests per requesting worker       |
| `maxPendingResponseBytes`   |  16 MiB | Reserved response bytes per requesting worker       |

Each setting also has the usual configuration parameter name, such as
`storage_fullText_maxRawHitsPerRequest` or `storage_fullText_runtime_maxSearchThreads`, for
`set_configuration` and environment overrides. Changing one setting preserves the others.

Capacity exhaustion returns an error rather than a successful partial page. Snapshot readers can
keep old index segments on disk until released. Neither query bytes nor native admission settings
provide a hard bound on resident memory or retained disk space.

The `storage.fullText.runtime` settings bound native process-wide admission before the first index
opens. Defaults allow 128 resident native indexes, 128 indexing threads, 256 search threads, 4 GiB
of configured writer memory, 8 GiB of configured queue capacity, and 8 concurrent expensive searches.
These limits apply together: for example, two indexing threads and 64 MiB of writer memory per index
reach the thread and memory budgets at 64 indexes. Readers share each native index's runtime;
retaining a reader does not allocate another index writer. Change these settings to fit the number
of indexes and their configured resources, and restart Harper after changing native admission limits.
