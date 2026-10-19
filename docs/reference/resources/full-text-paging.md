---
title: Full-Text Paging
---

# Full-Text Paging

<VersionBadge version="v5.3.1" />

Full-text continuation lets a client page through the original search matches while indexing
updates arrive. It is available through `Table.search()` and REST. Ordinary offset-based paging
continues to run each request against its own index snapshot.

## Declare a full-text index

Full-text indexes require RocksDB and an audited table. The query names the `FullText` declaration,
not a stored source field:

```graphql
type Product @table(audit: true) {
	id: ID @primaryKey
	title: String
	catalogSearch: FullText @fullText(fields: [{ name: "title" }])
}
```

`catalogSearch` is a query-only declaration. Select the stored fields and optional `$score` in results.
Full-text matches use descending relevance order.

## Page through `Table.search()`

Set `continuation: true` to start. Continuation mode returns a promise for a bounded array;
ordinary searches keep their async iterable return value.

```javascript
const query = {
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	select: ['id', 'title', '$score'],
	limit: 25,
};

let continuation = true;
do {
	const page = await tables.Product.search({ ...query, continuation });
	for (const record of page) console.log(record);
	continuation = page.continuation;
} while (continuation);
```

The returned array has three additional properties:

| Property       | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `continuation` | Token for the next page; absent when traversal is complete          |
| `complete`     | Whether the original search has been exhausted or explicitly closed |
| `expiresAt`    | Absolute expiry time in milliseconds since the Unix epoch           |

These properties are not included when the array is serialized as JSON. Keep the same conditions
and selected fields when resuming. The page size may change. Do not combine continuation with a
nonzero offset, count request, or another sort order.

In an authenticated custom Resource, pass `this.getContext()` as the second argument to
`tables.Product.search()` and set `checkPermission: true` in the query. This requests the caller's
table and searched-source permissions; passing context alone does not request that permission gate.
Application row filters still run on each page.
The token does not store application callbacks such as `rowFilter` or `vectorFilter`. Supply them
again on every page, together with the caller's context and permission settings.

## Page through REST

Start with `continuation()`:

```http
GET /Product/?catalogSearch=matches=trail%20shoes&select(id,title,$score)&limit(25)&continuation()
```

The body stays a JSON array. Read the next token from `Harper-Continuation`, URL-encode it, and
send it in `continuation(token)` with the same query:

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

`Harper-Continuation-Complete` reports completion. `Harper-Continuation-Expires` contains the
absolute expiry time in milliseconds since the Unix epoch. Completed pages omit the token and
expiry. These headers are exposed to browser clients. Continuation responses use `Cache-Control: no-store`. JSON `QUERY` requests return the
same headers when their query body enables continuation.

HEAD rejects continuation requests because it cannot return the page records. Use GET or QUERY.

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
    maxPageSize: 1000
    requestBudgetMilliseconds: 5000
    maxRawHitsPerRequest: 100000
```

| Setting                     | Default | Scope                                                       |
| --------------------------- | ------: | ----------------------------------------------------------- |
| `cursorTtlMilliseconds`     |  60,000 | Absolute search lifetime; paging does not extend it         |
| `maxCursors`                |       4 | Retained searches across all workers in one process         |
| `maxRetainedQueryBytes`     |   8 MiB | Retained native query text and identity bytes               |
| `maxPageSize`               |   1,000 | Returned records per page                                   |
| `requestBudgetMilliseconds` |   5,000 | Freshness wait and page processing budget                   |
| `maxRawHitsPerRequest`      | 100,000 | Fetched native hits per request, including replayed batches |
| `maxPendingRequests`        |      32 | Pending requests per requesting worker                      |
| `maxPendingResponseBytes`   |  16 MiB | Reserved response bytes per requesting worker               |

The usual individual configuration names also work, such as
`storage_fullText_maxRawHitsPerRequest` with `set_configuration`. Native process-wide admission
settings live under `storage.fullText.runtime` and require a restart when changed. Their defaults
are 128 resident indexes, 128 indexing threads, 256 search threads, 4 GiB configured writer memory,
8 GiB configured queue capacity, and 8 concurrent expensive searches. All limits apply together.

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
