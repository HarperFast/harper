---
title: Full-Text Paging
---

# Full-Text Paging

<VersionBadge version="v5.4.0" />

The full-text index declaration below is a prerequisite.

Full-text continuation lets a client page through the original search matches while indexing
updates arrive. It is available through `Table.searchPage()` and REST. Ordinary offset-based paging
continues to run each request against its own index snapshot.
The same continuation options work with autocomplete searches using `matches_prefix` and `matches_fuzzy_prefix`.

## Declare a full-text index

Full-text indexes require RocksDB and an audited table. The query names the `FullText` declaration,
not a stored source field:

```graphql
type Product @table(audit: true) @export {
	id: ID @primaryKey
	title: String
	catalogSearch: FullText @fullText(fields: [{ name: "title" }])
}
```

`catalogSearch` is a query-only declaration. Select the stored fields and optional `$score` in results.
Full-text matches use descending relevance order. REST examples also require `rest: true` in the
application configuration; see [REST setup](../rest/overview.md).

## Page through `Table.searchPage()`

Use a positive integer `limit` no greater than `maxPageSize`.
`searchPage()` returns a promise for a bounded array. Omit `continuation` or set it to `true` to start.
`Table.search()` keeps its async iterable return value and rejects continuation options.

Inside an authenticated Resource instance method:

```javascript
const context = this.getContext();
const query = {
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	select: ['id', 'title', '$score'],
	limit: 25,
	checkPermission: true,
};

let continuation = true;
do {
	const page = await tables.Product.searchPage({ ...query, continuation }, context);
	for (const record of page) console.log(record);
	continuation = page.continuation;
} while (continuation);
```

The returned array has three additional properties:

| Property       | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `continuation` | Token for the next page; `undefined` when traversal is complete     |
| `complete`     | Whether the original search has been exhausted or explicitly closed |
| `expiresAt`    | Absolute expiry time in milliseconds since the Unix epoch           |

These properties are not included when the array is serialized as JSON. Keep the same conditions
and selected fields, and use the same authenticated caller when resuming. The page size may change. Use the default relevance order, or explicitly sort by descending
`$score` alone. A nonzero `offset`, another sort, or a truthy `count`, `explain`, or `sync` option
returns 400. In REST, the accepted explicit score order is `sort(-$score)` alone.

In a static custom Resource method, pass the method's `context` argument as the second argument
to `tables.Product.searchPage()`. In an instance method, use `this.getContext()` instead. See
[Resource context](./resource-api.md#getcontext-context) for both forms. Set `checkPermission: true`
in the query on every page. Without it, a direct call does not request the caller's
table and searched-source permission checks; passing context alone does not enable them.
Changing the caller identity, including switching from an authenticated request to an internal
call without that context, returns 410. Permission changes for the same caller are checked on each
page. Application row filters still run on each page.
The token does not store application callbacks such as `rowFilter` or
[`vectorFilter`](../database/schema.md#filtered-vector-search-with-a-function-predicate). Supply them
again on every page, together with the caller's context and permission settings.

If your table overrides `search()`, also implement `searchPage()` with the same filtering policy.
This applies to static and instance methods. Otherwise paging returns 400, including through REST,
to avoid bypassing application filters.

A custom Resource supporting the framework's QUERY paging route must implement `searchPage()`.
Return the original page array. Copying it with `map()`, `filter()` or
spread drops its paging metadata and a framework-serialized continuation response returns 400.
Use the query's `select` and filters instead. A Resource returning an explicit HTTP `Response`
owns its response headers, serialization and cache policy.

## Page through REST

Use the single-argument `limit(n)` page size and start with `continuation()`. Do not use
a nonzero starting offset with `limit(start,end)`, request a count with `Prefer: count=`, or change the relevance order. The same
`explain` and `sync` restrictions as `Table.searchPage()` apply; violations return 400.
The equivalent `limit(0,n)` form is accepted; it does not skip records within the retained search.

```http
GET /Product/?catalogSearch=matches=trail%20shoes&select(id,title,$score)&limit(25)&continuation()
```

The body stays a JSON array. Read the next token from `Harper-Continuation`, URL-encode it, and
send it in `continuation(token)` with the same conditions and selected fields. The page size may change:

```javascript
const query = '/Product/?catalogSearch=matches=trail%20shoes&select(id,title,$score)&limit(25)';
let token;
do {
	const continuation = token ? `continuation(${encodeURIComponent(token)})` : 'continuation()';
	const response = await fetch(`${query}&${continuation}`);
	if (!response.ok) throw new Error(await response.text());
	const records = await response.json();
	for (const record of records) console.log(record);
	token = response.headers.get('Harper-Continuation');
} while (token);
```

`Harper-Continuation-Complete` is present on every successful continuation page: the string `"false"` while more results remain, and `"true"` after completion or explicit close. `Harper-Continuation-Expires` contains the
absolute expiry time in milliseconds since the Unix epoch. Completed pages omit the token and
expiry. Harper adds these names to `Access-Control-Expose-Headers` so browser clients can read them.
Continuation responses override the usual read-cache policy with `Cache-Control: no-store`. JSON `QUERY` requests return the
same headers when their query body enables continuation.

Request URL logging can record continuation tokens. Keep tokens out of logs and analytics.
QUERY accepts the token in its JSON body with the same query fields if it should stay out of the URL.
Tokens still require the same caller and query and expire with their search.

Read and parse the complete response body before saving its next token. A stream can fail after
headers are sent. If a resumed page fails this way, retry with the previous token while the snapshot remains valid.
If no token was received on the first page, start a new search. The first search may keep its cursor
slot until absolute expiry because it cannot be closed without a token.

GET and QUERY can return continuation pages. OPTIONS returns request metadata without running a
search. HEAD is an exception to the usual GET-without-a-body behavior: it returns 400 before
opening or advancing a continuation. Other methods also reject continuation parameters with 400.

Long record IDs make continuation tokens larger. Qualification with the released library produced
tokens of about 600 bytes for short IDs and nearly 8 KB near the supported ID limit. Review Harper's
`http.maxHeaderSize` setting and any proxy response-header and request-line limits. Leave room for the
token, query, authentication, and other headers; a token that fits Harper may exceed a proxy limit.

## Records and permissions can change

The snapshot fixes the index matches and their ranking. It does not retain historical Harper
records or permissions. Each request loads current records and checks current access. Updated,
deleted, expired, or newly unauthorized records can be omitted, and new matches do not enter the
original search.

Retrying a token resumes the same index boundary. The returned rows can differ if records or
permissions changed. A page may be empty when the remaining snapshot contains no eligible records;
use the continuation token or completion flag to decide when to stop.

## Close or restart a search

To stop early, repeat the query with its current token and `closeContinuation: true`. In REST, add
`closeContinuation()` alongside `continuation(token)`. Closing returns an empty completed page.

Close and terminal pages wait for admission release before reporting success. If release fails, the
request returns an error instead. The revoked token may then return `410`, and its admission slot
can remain occupied until absolute expiry or worker exit. A successful close releases admission
capacity; it does not promise immediate removal of old index segments from disk.
Closing has a separate cleanup budget. Once release is acknowledged, the completed page can return
after its search-work deadline. Cancellation, transaction, and index-lifecycle checks still apply.

Completion, close, expiry, index reset, definition changes, worker loss, or process restart can
invalidate a token. Resuming an unavailable snapshot returns `410`; start a new search. Once any
request finishes traversal, older tokens for that search also expire.
Changing any `storage.fullText` setting also invalidates existing tokens, even when only a capacity
setting changes. Start a new search after changing these settings.

Snapshots belong to one Harper instance. Its workers can handle continuation requests for each
other. Requests reaching a different Harper instance cannot resume that snapshot.

## Configure resource limits

Settings live under `storage.fullText` in `harper-config.yaml`:

```yaml
storage:
  fullText:
    cursorTtlMilliseconds: 60000
    maxCursors: 4
    maxRetainedQueryBytes: 8388608
    maxPendingRequests: 32
    maxPendingResponseBytes: 16777216
    maxPageSize: 1000
    requestBudgetMilliseconds: 5000
    maxRawHitsPerRequest: 100000
    maxRawHitsPerOrdinaryRequest: 10000
```

| Setting                        | Default | Scope                                                       |
| ------------------------------ | ------: | ----------------------------------------------------------- |
| `cursorTtlMilliseconds`        |  60,000 | Absolute search lifetime; paging does not extend it         |
| `maxCursors`                   |       4 | Retained searches across all workers in one process         |
| `maxRetainedQueryBytes`        |   8 MiB | Retained native query text and identity bytes               |
| `maxPageSize`                  |   1,000 | Returned records per page                                   |
| `requestBudgetMilliseconds`    |   5,000 | Freshness wait and page processing budget                   |
| `maxRawHitsPerRequest`         | 100,000 | Fetched native hits per request, including replayed batches |
| `maxRawHitsPerOrdinaryRequest` |  10,000 | Additional hit ceiling for searches without continuation    |
| `maxPendingRequests`           |      32 | Pending requests per requesting worker                      |
| `maxPendingResponseBytes`      |  16 MiB | Reserved response bytes per requesting worker               |

Ordinary searches use the lower of `maxRawHitsPerRequest` and `maxRawHitsPerOrdinaryRequest`, and share the `requestBudgetMilliseconds` execution budget. A raw-hit ceiling returns 400 instead of a partial page. Increasing the ordinary ceiling permits more native work and record reads per request; test selective queries before raising it. Replayed batches count toward the ceiling, so the number of distinct matches reached can be lower.

A requesting worker reserves a conservative bound for a complete native batch before dispatch, including two-byte string encoding and message overhead. The reservation may exceed the returned payload. `maxPendingResponseBytes` can reject concurrent reads with 503 even when the cursor-count and pending-request limits have room. A reservation rejection happens before dispatch and does not advance the search. Reduce concurrency and retry with the same token while it remains valid; this rejection does not include a `Retry-After` header.

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

The usual individual configuration names also work, such as
`storage_fullText_maxRawHitsPerRequest` with `set_configuration`. Follow the
[configuration restart procedure](../configuration/operations.md#set-configuration) after applying
changes with that operation. Native process-wide admission
settings live under `storage.fullText.runtime` and require a full process restart when changed. Restarting only worker threads does not apply new native budgets; replacement workers keep the established process budgets. Their defaults
are 128 resident indexes, 128 indexing threads, 256 search threads, 4 GiB configured writer memory,
8 GiB configured queue capacity, and 8 concurrent expensive searches. All limits apply together.

Application-created workers inherit the established native settings too. Create them after
Harper initializes its full-text settings. A worker created before that point cannot initialize
full-text search; recreate it after Harper initializes rather than retrying inside the same worker.
This prevents a worker from applying different process-wide limits.

The runtime keys use integer counts or bytes:

```yaml
storage:
  fullText:
    runtime:
      maxResidentIndexes: 128
      maxIndexingThreads: 128
      maxSearchThreads: 256
      maxWriterMemoryBytes: 4294967296
      maxQueuedBytes: 8589934592
      maxExpensiveSearches: 8
```

The cursor pool is shared by all callers. Four unfinished searches fill the default pool, so a fifth
receives `503` until a search finishes, closes, or expires. Ordinary searches remain available.
Configure `maxCursors` for the number of unfinished searches the application needs to retain.
There is no per-caller reservation or eviction policy.

Cursor slots, pending-request counts, and response-byte allowances apply separately. Raising
`maxCursors` does not raise `maxPendingRequests` or `maxPendingResponseBytes`. Across workers,
Harper reserves response space using the library's largest supported IDs and versions, rather than
the average size of the current records. Many searches may be retained while fewer pages can run
at once.

A raw-hit budget failure returns `400`; narrow the query or increase the budget. Capacity exhaustion
and timeouts return errors instead of successful incomplete pages. If the snapshot itself runs out
of eligible matches, a shorter completed page is a valid result.

Retained readers can keep old index segments on disk until released. These settings do not provide
a hard limit on total process memory or retained disk space. Native deadlines are cooperative, so the
request budget is not a hard wall-clock guarantee.
