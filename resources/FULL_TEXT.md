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

Harper pins `@harperfast/fulltext` to **0.8.0**, embedding **Tantivy 0.27.0**, and validates the native runtime capabilities before activation. Full-text activation requires RocksDB and an audited table. Declare new schema tables with `@table(audit: true)` and keep audit logging enabled while an index is declared. LMDB is rejected. A missing or incompatible native package prevents activation.

### Upgrading from fulltext 0.7.0

Harper's existing indexes written by fulltext 0.7.0 contain text fields only and remain reusable with 0.8.0. This upgrade does not add native filter metadata or change their storage identity. Query limits and fuzzy controls do not require rebuilding. Stop all processes sharing a local index before switching package versions; never mix facade/native binaries or engine versions against a live directory. New installations omit `storage.fullText.query`; defaults apply automatically. An explicitly configured query block must be removed before returning to Harper 5.4.0-alpha.1 or alpha.2, whose validators reject it. Existing configuration is not rewritten. Returning to fulltext 0.7.0 after 0.8.0 has written to an index is not a qualified operator rollback procedure.

### Upgrading an existing native index

Harper 5.3.4 ships fulltext 0.5.0. **Every existing 0.5.x index requires a rebuild.** Tantivy 0.27 changes English stemming even though the public analyzer remains `english@2`: `added` now stems to `add` rather than `ad`. Matching and ranking can therefore change. The wrapper rejects older persisted identities with `E_IDENTITY_MISMATCH`; Harper's existing derived-index runtime automatically retires and rebuilds that local index from authoritative records, and resumes committed-write replay. Readiness and the query's requested coverage jointly gate admission; readiness alone does not prove that every concurrent write has been indexed.

Drain a node's full-text traffic and stop its old Harper processes before starting the new version against the same storage. Do not run old and new workers against one local index. Reserve time and disk headroom for rebuilding all declared indexes on each node, including temporarily retained retired files. Full-text queries on that node fail until readiness and required coverage recover. Failures detected before response headers return HTTP 503. A streamed REST response can already have HTTP 200 headers and finish with a terminal error instead of records; JSON-array clients must check for an `error` element and treat that response as failed. A completed HTTP response alone does not prove search succeeded. Writes to indexed tables can also receive retryable 503 responses while index replay catches up after a long rebuild. Restore its search traffic only after verifying readiness and catch-up. A node-by-node deployment can use other ready replicas if the application's routing supports it; it does not make the rebuilding node available.

Prerelease installations using fulltext 0.6 also require a full rebuild.

**Direct downgrade to fulltext 0.5.x is unsupported.** That engine refuses both opening and resetting a 0.8 identity, leaving full-text search unavailable. If a downgrade has already happened, keep search traffic drained and restore the 0.8.0-based Harper version. Harper does not yet provide a supported rollback procedure for full-text indexes; see [Implement full-text generation lifecycle, rebuild, eviction, backup, and status](https://github.com/HarperFast/harper/issues/2510). Do not edit, move or delete files in full-text index directories by hand.

### Upgrade and recovery checklist

1. Drain the node's full-text requests and stop every old Harper process that shares its storage, including background workers. Do not mix engine versions against one local index.
2. Confirm authoritative records and their recovery backups are available. Reserve disk and time for a complete rebuild of every local full-text index; the tests do not establish a universal capacity or duration estimate.
3. Start the 0.8.0-based Harper version. Use `describe_table` for each affected table and check every `full_text_indexes[].readiness.state`. Keep full-text traffic drained while any index is not `ready`.
4. Verify representative searches with `maxIndexLagMilliseconds: 0` and `waitForIndexMilliseconds: 30000`, so they wait for the writes committed before each search. Check the response body for stream errors as well as its HTTP status. Watch write-503 responses and retry with bounded backoff while replay catches up.
5. Restore full-text traffic only after all required indexes and current-coverage searches succeed. Readiness does not establish catalog-scale latency, spare disk capacity or coverage of writes committed after a search began.

If startup or rebuilding fails, keep the node's full-text traffic drained, preserve its source data and logs, and correct the reported package, storage or coordination failure before restarting the same 0.8.0-based version. An interrupted rebuild is recovered from authoritative records; do not force readiness or reset a live directory. After an accidental downgrade refusal, stop the older processes and restore the 0.8.0-based version before checking readiness and catch-up again. If that version also fails, stop and investigate rather than deleting index files. This is current-version recovery; an operator downgrade procedure remains unqualified.

The upgrade and recovery checks cover bounded fixture workloads. Multi-node deployment, sustained-write rejection windows and workload capacity still require the qualification in [Implement full-text generation lifecycle, rebuild, eviction, backup, and status](https://github.com/HarperFast/harper/issues/2510) and [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512).

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

Full-text queries also accept the existing `sort` option for directly stored record attributes, including linked sort fields. Harper uses its ordinary value ordering and keeps relevance order for equal sort keys. Computed fields, relationship paths, Blob fields and the query-only full-text field cannot be sort keys. The default remains descending `$score`.

A stored-field sort must examine the complete eligible matching set before applying offset and limit. It shares the configured raw-hit, retained-result and execution budgets; exceeding a bound returns an error rather than sorting a relevance-only subset. Highlights are computed only for the requested page after sorting.

The existing `count: 'exact'` option computes a total from the complete eligible set when a bounded page fits the count guardrails. REST exposes this through `Prefer: count=exact` on mounts configured with `rest: { exactCount: true }`. Totals include ordinary conditions, row guards, current source-version checks and expiry. If an unsorted count exceeds a full-text work or result ceiling, Harper returns the bounded page with an unknown total (`Content-Range: items …/*`). Sorting still requires complete enumeration and cannot use that fallback. Native execution and cancellation failures remain errors.

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

Harper does not configure the library's native filter metadata or submit native filter or candidate-ID requests. Ordinary conditions continue through Harper's secondary-index gates and authoritative record predicates. Native page, response-byte and highlight limits still apply. Fulltext 0.8.0 defaults to 64 analyzed terms per text leaf, 256 compiled clauses per query and a maximum fuzzy distance of one. Configure `storage.fullText.query` only to override those defaults, separately from request work budgets. Omitted fields retain their defaults:

```yaml
storage:
  fullText:
    query:
      maxQueryTerms: 128
      maxQueryClauses: 512
```

The policy is captured for the whole process and inherited by HTTP and application workers. Restart the full Harper process to change it; restarting only workers does not change the captured values. It applies to readers, including reopened readers, and does not change writer limits or index identity. Requests cannot raise it. Terms must be 1–1,024 and clauses 1–4,096, also within the loaded native runtime's advertised ceilings. Clause cost includes Boolean structure, NOT and field expansion, so a query below its term limit can still fail its clause limit. Overflow rejects the query rather than executing a truncated one. Before a response starts, query-capacity validation failures return 400; an operations JSON stream that has already started instead aborts and may include an error diagnostic. Treat an incomplete response as failed and discard its rows. Other depth, byte, phrase/fuzzy construction, queue, response and deadline guards still apply. Deadlines are cooperative and do not guarantee interruption during every native construction step. See the [published library limits](https://github.com/HarperFast/fulltext/blob/v0.8.0/docs/limits.md).

On structured full-text conditions, `fuzzyDistance` accepts integer 0–2 (default 1), and `fuzzyTranspositions` accepts a boolean (default true). They are valid only with `matches_fuzzy` or `matches_fuzzy_prefix`. Distance zero uses native exact matching; disabling transpositions makes adjacent swaps cost two edits. Both controls reach retrieval, traversal and highlights through Table.search and operations `search_by_conditions`; REST FIQL comparators retain their defaults. String values such as `"2"` and `"false"`, controls on condition groups, and controls on other comparators are rejected.

Distance two remains preview and requires operator opt-in with `storage.fullText.query.maxFuzzyDistance: 2`. The host maximum accepts 0–2; zero disables edit-tolerant fuzzy requests unless the condition explicitly requests distance zero. Qualify the actual corpus and concurrency before enabling two: admission and deadlines do not provide a hard process-memory bound. Fuzzy-prefix remains preview. Phrase slop remains deferred; no unreleased Tantivy patch is included.

Native metadata sorting, structured-filter pushdown, candidate-ID pushdown and facets/nested aggregations remain unexposed. Stored-field ordering above uses Harper’s existing source-value sorter and requires no metadata declaration or index rebuild. Their schema, authorization, consistency and workload qualification remain in [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512).

For implementation details, see the [full-text invariants in the Resource design guide](DESIGN.md#full-text-declarations-and-reader-snapshots). The schema contract lives in [schema.graphql](../schema.graphql); compiler and generation rules live in [fullTextSchema.ts](fullTextSchema.ts).
