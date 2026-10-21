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

Harper keeps the requested `offset + limit` within the native ordinary result window. When source checks or other conditions reject the first batch, Harper uses native traversal to reach later matches on the same reader snapshot. This also lets prefix and fuzzy-prefix queries return more than the native first-batch autocomplete limit. Raw batch sizes are bounded by the installed addon’s page and response-byte limits; all batches share one execution budget. A timeout returns an error, including when native work finishes after its budget with a full batch. Harper does not accept a late batch as a completed page. If the snapshot runs out of eligible matches, Harper returns the remaining matches, including an empty result; filtering beyond an old native window no longer causes a 400 error.

Earlier bounded searches could raise `DerivedIndexLagError` when source-version changes left a
short page. Snapshot exhaustion now returns the eligible records instead. The explicit freshness
checks still apply before the search and can raise a retryable lag error.

Each request has a configurable work budget: `storage.fullText.maxRawHitsPerRequest` defaults to 100,000 native hits, including replay. Ordinary searches also apply `maxRawHitsPerOrdinaryRequest`, which defaults to 10,000; the lower ceiling applies. Both paths use `requestBudgetMilliseconds` (5,000 ms by default), capped by the native execution limit. Reaching the fetched-hit ceiling returns 400; exhausting the execution budget returns 503. Narrow the query or increase the relevant configured budget; Harper does not return a successful incomplete page. This limit counts fetched hits, not every record Tantivy visits while scoring.

Ordinary offset-based requests each use their own snapshot and may observe different index publications. Use continuation mode below to keep the original search across requests. Highlight tracing has separate record and source-byte bounds. Query construction and some native operations cannot be interrupted, so the execution budget is not a hard response-time guarantee.

Harper does not configure Fulltext's native filter metadata or submit native filter or candidate-ID requests. Ordinary conditions continue through Harper's secondary-index gates and authoritative record predicates.

For implementation details, see the [full-text invariants in the Resource design guide](DESIGN.md#full-text-declarations-and-reader-snapshots). The schema contract lives in [schema.graphql](../schema.graphql); the compiler and generation rules are in [fullTextSchema.ts](fullTextSchema.ts).

## Continue a search across requests

Call `Table.searchPage()` with a positive `limit`. It starts a new search when `continuation` is omitted or `true`, and returns a promise for an array with
`continuation`, `complete`, and `expiresAt` properties. These properties are not part of the JSON
array body. `Table.search()` keeps its iterable return value and rejects continuation options.

A custom `search()` override must explicitly implement `searchPage()` with the same row-filter policy before it can serve continuation requests. This applies to static and instance overrides, including through REST.

Inside an authenticated Resource instance method:

```js
const context = this.getContext();
const query = {
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	limit: 25,
	checkPermission: true,
};
let continuation = true;
do {
	const page = await Product.searchPage({ ...query, continuation }, context);
	for (const record of page) console.log(record);
	continuation = page.continuation;
} while (continuation);
```

Keep the same conditions and selected fields when resuming. The page size may change. Application
callbacks such as `rowFilter` and `vectorFilter` are not stored in the token. Supply them on every
page, along with the same context and `checkPermission: true` when searching on behalf of a caller.
Each request checks the caller's current permissions and loads current records. The retained snapshot fixes index
matches and their ranking; it does not retain historical Harper records. Updated, deleted, expired,
or newly unauthorized records can be omitted. New index matches do not enter that search. Freshness controls apply when the snapshot is started; later pages keep that snapshot and do not claim current index coverage.

REST uses `continuation()` for the first request and `continuation(token)` for later requests:

```text
GET /Product/?catalogSearch=matches=trail%20shoes&limit(25)&continuation()
```

Read the next token from `Harper-Continuation` and pass it back unchanged, URL-encoded. The body stays
a JSON array. `Harper-Continuation-Complete` says whether traversal finished;
`Harper-Continuation-Expires` is the absolute expiry time in milliseconds since the Unix epoch.
Completed pages omit the token and expiry.
Request URL logging can record continuation tokens. Keep them out of logs and analytics;
QUERY also accepts the token in its JSON body with the same query fields. Tokens still require
the same caller and query and expire with their search.
GET and QUERY can return continuation pages. OPTIONS returns request metadata without running a
search. Other methods reject continuation parameters with 400.
These headers are exposed to browser clients. Continuation responses use `Cache-Control: no-store`.
Nonzero offsets, count requests, and other result ordering cannot be combined with continuation.
The names `continuation` and `closeContinuation` are reserved REST options.

A custom Resource supporting the framework's QUERY paging route must implement `searchPage()`.
Return the original page array. Copying it with `map()`,
`filter()` or spread drops its paging metadata; returning that copy through the normal Resource
API returns 400. Put projections and filters in the query instead. To add custom headers,
return `{ headers, data: page }` with the original page array. A Resource returning an explicit
HTTP `Response` owns its response headers, serialization and cache policy.

These headers are added after serialization and stream startup; they do not guarantee delivery of
the complete body. A later stream error can leave a 200 response with an incomplete body. An
unfinished search can be retried with its previous token while that token remains valid. If no
token was received on the first request, its cursor slot may stay occupied until expiry.

Long IDs make tokens larger. Qualification with the released library produced tokens of about
600 bytes for short IDs and nearly 8 KB near the supported ID limit. Review `http.maxHeaderSize`
and any proxy response-header and request-line limits, allowing room for the token, query,
authentication, and other headers. A token that fits Harper may exceed a proxy limit.

To stop early, repeat the query with its token and `closeContinuation: true`. In REST, add
`closeContinuation()` alongside `continuation(token)`. Closing returns an empty completed page.
Close and terminal pages wait for admission release before reporting success. A release failure
returns an error instead; the revoked token may then return 410, and its admission slot can remain
occupied until absolute expiry or worker exit. This acknowledgement covers admission capacity,
not immediate removal of old index segments from disk.
Closing has a separate cleanup budget. Once release is acknowledged, the completed page can return
after its search-work deadline; cancellation, transaction and index-lifecycle checks still apply.
Completion, explicit close, expiry, index reset, definition changes, worker loss, and process restart
release or invalidate the search. A previous token then returns 410; start a new search. Retries
before completion keep the same index boundary, but current record and permission changes can
change the returned rows. Continuation stays on one Harper instance; it does not coordinate servers.
Changing any `storage.fullText` setting also invalidates existing tokens, including when only a
capacity setting changes. Start a new search after changing these settings.

Search and continuation settings are under `storage.fullText`:

| Setting                        | Default | What it bounds                                           |
| ------------------------------ | ------: | -------------------------------------------------------- |
| `cursorTtlMilliseconds`        |  60,000 | Absolute lifetime; paging does not extend it             |
| `maxCursors`                   |       4 | Retained searches across all workers in one process      |
| `maxRetainedQueryBytes`        |   8 MiB | Retained native query text and identity bytes            |
| `maxPageSize`                  |   1,000 | Returned records per page                                |
| `requestBudgetMilliseconds`    |   5,000 | Freshness wait and native/page processing budget         |
| `maxRawHitsPerRequest`         | 100,000 | Fetched native hits, including replayed batches          |
| `maxRawHitsPerOrdinaryRequest` |  10,000 | Additional hit ceiling for searches without continuation |
| `maxPendingRequests`           |      32 | Pending worker requests per requesting worker            |
| `maxPendingResponseBytes`      |  16 MiB | Reserved response bytes per requesting worker            |

A requesting worker reserves a conservative bound for each native batch before dispatch, including two-byte string encoding and message overhead. The reservation can exceed the returned payload. `maxPendingResponseBytes` can therefore reject concurrent reads even when the cursor-count and pending-request limits have room.

Search work and cleanup use separate windows based on `requestBudgetMilliseconds`. With the
5,000 ms default, a search that uses its full work budget and then closes can take about 10 seconds.
Waiting for other page requests already using the snapshot can add time. Native work checks its
deadline while running; these settings are not a hard limit on total response time.

Ordinary searches can use secondary indexes to skip record reads and enlarge batches when many
matches are filtered out. Continued searches do not yet use those optimizations; they fetch up to
256 native hits per batch and check current records. A selective filter can therefore add many
record reads and, when the snapshot belongs to another worker, many worker requests.
Qualification and these optimizations are tracked in
[Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512).

Each setting also has the usual configuration parameter name, such as
`storage_fullText_maxRawHitsPerRequest` or `storage_fullText_runtime_maxSearchThreads`, for
`set_configuration` and environment overrides. Changing one setting preserves the others.

The cursor limit is shared by all callers. Four unfinished searches fill the default pool; another
caller receives 503 until a search closes, finishes, or expires. Set `maxCursors` for the number of
unfinished searches the application expects to retain. There is no per-caller reservation or eviction.

Cursor slots, pending-request counts, and response-byte allowances apply separately. Raising
`maxCursors` does not raise `maxPendingRequests` or `maxPendingResponseBytes`. Across workers,
response reservations use the library's largest supported IDs and versions, rather than the
average size of the current records. More searches may be retained than can fetch a page at once.

Capacity exhaustion returns an error rather than a successful partial page. Snapshot readers can
keep old index segments on disk until released. Neither query bytes nor native admission settings
provide a hard bound on resident memory or retained disk space.

The `storage.fullText.runtime` settings bound native process-wide admission before the first index
opens. Defaults allow 128 resident native indexes, 128 indexing threads, 256 search threads, 4 GiB
of configured writer memory, 8 GiB of configured queue capacity, and 8 concurrent expensive searches.
These limits apply together: for example, two indexing threads and 64 MiB of writer memory per index
reach the thread and memory budgets at 64 indexes. Readers share each native index's runtime;
retaining a reader does not allocate another index writer. Harper captures these budgets before loading application components, or on an earlier main-thread native load or managed worker spawn. Application-created workers inherit that configuration. A standalone worker created before capture cannot initialize fulltext; recreate it after Harper initializes rather than retrying inside the same worker. Replacement workers retain the established budgets after a live configuration change. Change these settings to fit the number
of indexes and their configured resources, and restart Harper after changing native admission limits.
Retained paging still requires Harper's main thread or a managed worker; inheriting native settings
does not add paging-message routing to application-created workers.
