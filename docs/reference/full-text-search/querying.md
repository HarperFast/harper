---
title: Querying
sidebar_position: 30
sidebar_label: 'Querying'
---

# Querying Full-Text Indexes

<VersionBadge version="v5.3.0" /> <EngineBadge engines="RocksDB" />

Use the query-only `FullText` field name as a condition attribute in `Table.search()`.

```javascript
const products = Product.search({
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'waterproof trail shoes' }],
	limit: 20,
});
```

`Table.search()` returns an async iterable. Consume it with `for await...of`, or return it directly from a custom Resource to stream the results.

Results are ordered by BM25 relevance. In v5.4, supplied [query-time boosts and optional clauses](#query-time-relevance-controls) adjust that ranking. The `FullText` field, not one of its source fields, identifies the search target.

## Match modes

| Comparator             | Behavior                                                               | Required index option |
| ---------------------- | ---------------------------------------------------------------------- | --------------------- |
| `matches`              | Matches any analyzed query term.                                       | —                     |
| `matches_all`          | Requires every analyzed query term.                                    | —                     |
| `matches_phrase`       | Matches analyzed terms in order as a phrase.                           | `positions: true`     |
| `matches_prefix`       | Matches records whose analyzed terms start with the final query term.  | `surfaceTerms: true`  |
| `matches_fuzzy`        | By default, matches terms within one edit, including a transposition.  | —                     |
| `matches_fuzzy_prefix` | By default, combines one-edit fuzzy matching with a final-term prefix. | `surfaceTerms: true`  |

Every comparator also has a negated form: `not_matches`, `not_matches_all`, `not_matches_phrase`, `not_matches_prefix`, `not_matches_fuzzy`, and `not_matches_fuzzy_prefix`.

An empty string is invalid and returns `400`. Whitespace-only text or text reduced to no terms by the analyzer, such as a query containing only enabled stop words, returns an exact empty result.

A query containing a negated full-text condition must also contain a non-negated full-text condition on the same index. A structured record condition alone does not satisfy this requirement. The positive full-text condition bounds the candidate set; the negated condition filters it.

```javascript
const products = Product.search({
	operator: 'and',
	conditions: [
		{ attribute: 'catalogSearch', comparator: 'matches', value: 'waterproof' },
		{ attribute: 'catalogSearch', comparator: 'not_matches', value: 'leather' },
	],
});
```

## Restricting source fields

By default, a condition searches every source field in the index. Use `fields` to restrict it:

```javascript
const products = Product.search({
	conditions: [
		{
			attribute: 'catalogSearch',
			comparator: 'matches_phrase',
			value: 'trail running',
			fields: ['name', 'description'],
		},
	],
});
```

Every requested field must belong to the index and be readable by the caller. Without `fields`, the caller must be allowed to read every source field in the index. Harper rejects an external REST or Operations API query with `403` if any searched source field is not readable. `$highlights` never bypasses this check.

Direct calls through `tables` or `databases` run in a trusted server-side context. From an authenticated custom resource, pass the `context` received by the static resource method to `Table.search()` and set `checkPermission: true` in the search options to enforce the caller's table and source-field permissions. Context propagation alone does not request the table permission check.

## Score and ordering

Select `$score` to include the relevance score. Without query-time controls, this is the BM25 score. In v5.4, [boosts and optional clauses](#query-time-relevance-controls) adjust it when supplied:

```javascript
const products = Product.search({
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	select: ['id', 'name', '$score'],
	limit: 20,
});
```

Full-text results use descending relevance order. The only explicit full-text sort is `$score` descending; other sort keys and reverse iteration are rejected because they would discard the native ranking.

Full-text queries cannot provide an exact total after authorization, structured filtering, and current-record validation. On a REST interface with `exactCount` enabled, `Prefer: count=exact` reports an unavailable total; otherwise it is downgraded to an estimated count. See [pagination and total count](../rest/querying.md#pagination-and-total-count). `Table.getRecordCount()` counts table records, not matches for a full-text query.

## Fuzzy controls in v5.4

<VersionBadge version="v5.4.0" />

`fuzzyDistance` and `fuzzyTranspositions` can be set on structured `matches_fuzzy` and `matches_fuzzy_prefix` conditions, including their negated forms. Supplying them on another match mode or a group object returns HTTP 400; put the controls on its individual fuzzy conditions. Values with the wrong type also return HTTP 400. `fuzzyDistance` must be an integer from 0 to 2. `fuzzyTranspositions` must be a boolean. Omitted values default to `1` and `true`, respectively.

The server setting `storage.fullText.query.maxFuzzyDistance` accepts integers from `0` to `2`, defaults to `1`, and caps accepted distances. With a cap of `0`, a fuzzy condition must explicitly set `fuzzyDistance: 0`. Omitting it still defaults to `1` and is rejected as over capacity. Distance `2` requires a cap of `2`. The cap is checked when the query executes, so the rejection can arrive after the response has started; see [how a capacity rejection reaches the client](#how-a-capacity-rejection-reaches-the-client).

Fuzzy edits apply only to eligible analyzed surface terms: at least four characters, alphabetic content, and no numeric characters, hyphens, underscores or slashes. Other terms receive no fuzzy expansion; fuzzy controls do not override native eligibility or the normal final-term prefix behavior.

Distance two and fuzzy-prefix are preview features. Qualify the selected fuzzy distance and fuzzy-prefix workload against the actual corpus and concurrency before exposing them to callers. See [full-text configuration](../configuration/options.md#storage) for the surrounding request budgets.

## Query-time relevance controls

<VersionBadge version="v5.4.0" />

These controls are available in Harper 5.4 with its bundled fulltext wrapper. Earlier 5.4 prerelease builds may not include them. Do not send these keys to builds without query-scoring support: a successful request alone does not prove scoring was applied. Harper validates its bundled wrapper before activating an index and requires native ABI 14, query API 8 and telemetry API 1. An incompatible wrapper prevents index activation; install the compatible wrapper before serving full-text queries.

Use `should` to reward additional text matches while retaining the parent condition's required matches:

```javascript
const target = {
	conditions: [
		{
			attribute: 'catalogSearch',
			comparator: 'matches_all',
			value: 'waterproof boots',
			should: [
				{
					comparator: 'matches_phrase',
					value: 'waterproof boots',
					fields: ['name'],
					boost: 3,
				},
			],
		},
	],
	select: ['id', 'name', '$score'],
	limit: 20,
};
const products = Product.search(target);
```

A product that matches the required text remains eligible without the optional phrase. A product that matches only an optional clause is excluded. Optional scores add to the required score; they do not change which records match.

Each optional descriptor accepts a positive full-text `comparator`, a nonempty string `value`, optional `fields`, `boost`, `fuzzyDistance`, and `fuzzyTranspositions`.

Optional descriptors use the same [fuzzy controls](#fuzzy-controls-in-v54) as required fuzzy conditions, including their configured distance cap. Optional descriptors remain positive-only.

`boost` and `should` are reserved query-object keys on all tables in v5.4. Misplaced controls return HTTP 400 even without a full-text index; applications that previously passed ignored custom keys must rename them. An attribute named `boost` or `should` can still be queried through the `attribute` property.

Each descriptor searches the parent index. An `attribute` property is rejected even if it repeats the parent index name. The list must be nonempty and contain at most `storage.fullText.query.maxQueryClauses` descriptors (default `256`). This is a coarse host precheck: native compilation also counts required clauses, Boolean structure, boosts, analyzed terms and field expansion, so a smaller list can still exceed the compiled-clause budget. That overflow is found while the query executes and does not always return HTTP 400; see [how a capacity rejection reaches the client](#how-a-capacity-rejection-reaches-the-client). A positive full-text leaf condition inside an `and` or `or` group can use these controls. The following shapes return HTTP 400:

- `should` inside an optional descriptor;
- a `not_*` comparator inside `should`;
- `boost` or `should` on the query target, a group object, a negated full-text condition, or an ordinary record condition.

A positive full-text condition with scoring controls can still combine with negated full-text conditions on the same index and ordinary record filters under `and`. Full-text `or` groups cannot mix full-text and ordinary record conditions.

Set `boost` on the parent condition to multiply its required text score, or on an optional descriptor to multiply that bonus. Boosts multiply existing configured source-field weights; they do not replace those weights or require an index rebuild. `boost` is a number and defaults to `1` when omitted. Values round to float32 and must then be finite between 0 and 100 inclusive. Invalid values, including negative zero, return HTTP 400. Zero preserves matching while contributing zero score. For a standalone required condition without optional clauses, a positive uniform boost rescales scores without changing relative ranking, apart from floating-point ties. Zero makes those scores tie.

Every referenced source must be readable, including optional fields used only for ranking. Omitting `fields` searches all sources and requires permission for all of them. The same server query limits and result limits apply to optional clauses. Requested highlights include matching positive required and optional clauses.

Use the same structured target through HTTP `QUERY`:

```javascript
const response = await fetch('http://localhost:9926/Product/', {
	method: 'QUERY',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(target),
});
```

Include the application's normal authentication credentials. Operations `search_by_conditions` accepts the same `conditions` with its usual `database`, `table` and `get_attributes` properties. These controls add no FIQL syntax.

## Highlights

Highlighting returns source-field fragments and matching character spans. The index must configure highlighting and mark at least one source with `highlight: true`. A query can also search sources without that option; those sources can affect matching and ranking but are omitted from `$highlights`.

Selecting `$highlights` turns highlighting on for the query:

```javascript
const products = Product.search({
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches_phrase', value: 'trail running' }],
	select: ['id', 'name', '$score', '$highlights'],
});
```

You can also set `includeHighlights: true` on the condition. A result has this shape:

```json
{
	"id": "shoe-1",
	"name": "Waterproof trail running shoe",
	"$score": 2.41,
	"$highlights": {
		"name": [
			{
				"valueIndex": 0,
				"spans": [{ "start": 11, "end": 24 }],
				"fragments": [
					{
						"text": "Waterproof trail running shoe",
						"start": 0,
						"spans": [{ "start": 11, "end": 24 }]
					}
				]
			}
		]
	}
}
```

Offsets are UTF-16 half-open ranges. Value-level spans address the original source value. A fragment's `start` addresses that value, while spans inside the fragment address its returned `text`. Harper returns offsets rather than HTML so the caller controls rendering and escaping.

## Combining conditions

Full-text conditions can be combined with structured filters using `and`:

```javascript
const products = Product.search({
	operator: 'and',
	conditions: [
		{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoe' },
		{ attribute: 'category', comparator: 'equals', value: 'footwear' },
		{ attribute: 'available', comparator: 'equals', value: true },
	],
	limit: 20,
});
```

Harper checks the structured conditions against current source records before returning them. Existing Harper secondary indexes can narrow candidate IDs or support point checks. Rejected hits do not count toward a v5.4 page's offset and limit, but fetching them still consumes the raw-hit budget.

An `or` group may combine conditions from the same full-text index:

```javascript
const products = Product.search({
	operator: 'or',
	conditions: [
		{ attribute: 'catalogSearch', comparator: 'matches_phrase', value: 'trail running' },
		{ attribute: 'catalogSearch', comparator: 'matches', value: 'hiking boot' },
	],
});
```

An `or` group cannot mix full-text and ordinary record conditions, and one query cannot combine different full-text indexes. Full-text conditions must name a field directly on the queried table; relationship and nested-property paths are not supported. Run separate queries when any of these boundaries is required.

## Freshness controls

A full-text index is derived from committed table changes. Each condition accepts:

| Option                     | Default | Description                                                                                                                                                           |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxIndexLagMilliseconds`  | `3000`  | Maximum accepted upper bound on index lag. Set to `0` to require current coverage.                                                                                    |
| `waitForIndexMilliseconds` | `0`     | How long to wait for acceptable coverage, from `0` through `30000`. Does not bound opening or refreshing the node's search reader, which has its own 30-second limit. |

To wait for committed changes already received by this node to reach its local index, require current coverage and allow a bounded wait. These controls do not wait for a write to arrive from another replica; a query routed to a different node can run before that node receives the write:

```javascript
for await (const product of Product.search({
	conditions: [
		{
			attribute: 'catalogSearch',
			comparator: 'matches',
			value: 'new product',
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 10000,
		},
	],
})) {
	console.log(product);
}
```

Cold scoring-capability loading and reader acquisition each have their own 30-second limit, independent of `waitForIndexMilliseconds`. These stages are additional to coverage waiting and native query execution. A capability-loading timeout is retryable and returns HTTP 503 with `code: "FULL_TEXT_INITIALIZATION_TIMEOUT"`. The operations API also includes `retryable: true`; REST clients should use the code. Coverage waiting starts after capability loading finishes. Reader-acquisition timeouts retain a generic 503 without this retry code.

All full-text conditions combined into one query must use the same freshness values. Harper returns `400` when combined conditions specify different values.

A non-waiting HTTP query can return `Harper-Index-Coverage` with the admitted state, lag upper bound, and requested tolerance. A zero-size page performs no native search and carries no coverage proof. A waiting `Table.search()` establishes coverage as its iterator is consumed. A `search_by_conditions` request completes only after its wait and search finish. Waiting queries do not emit a coverage header before completion.

If acceptable coverage is not reached before `waitForIndexMilliseconds` expires, Harper returns `503` with `code: "DERIVED_INDEX_LAGGING"` and `retryable: true`. For `Table.search()`, the error is raised while the async iterator is consumed. An HTTP response may already be streaming, so clients should also handle a cut-off stream (which may end without a terminal diagnostic) or terminal stream error rather than relying only on the initial status; see [When a Streamed Response Fails](../rest/content-types.md#when-a-streamed-response-fails).

The same code is also used when prolonged derived-index lag causes Harper to reject local writes. Query waits can be retried according to the caller's freshness needs; rejected writes should use backoff while the index catches up. See [Write backpressure](./overview.md#write-backpressure).

## Paging and prefix result windows

`matches_prefix` and `matches_fuzzy_prefix` are autocomplete-style record searches. These modes return matching records, not a separate list of suggested terms.

Before v5.4, any expression containing one of these modes uses a 100-record native result window, and `offset + limit` cannot exceed 100. An unbounded query with more than 100 matches returns `400` rather than silently truncating the result.

### Paging in v5.4

<VersionBadge type="changed" version="v5.4.0" />

Full-text and autocomplete searches use Harper's existing `limit` and `offset`. Bounded queries can pass the ordinary native result window, including the earlier 100-record prefix boundary. Within one request, one native reader fetches ranked batches until Harper has enough eligible records for the offset and limit, exhausts the matches, or reaches a request budget. Source-version checks and record filters run before records count toward the requested page.

For example, `offset: 100` and `limit: 10` skip the first 100 eligible records and return up to the next 10, even for prefix matching. A short or empty page means matches were exhausted. Exhausting the fetched-hit or retained-result budget returns `400`; narrow the query, reduce offset or limit, or raise the named budget. Exhausting the execution budget returns `503`; narrow the query or adjust the execution budget rather than retrying it unchanged. These budget errors carry no readiness-specific `code` or `retryable` flag. If a response has already started streaming, a later error terminates that stream instead of changing its HTTP status. An unbounded query can still fail when it exceeds the native window or configured limits. Native response-envelope overflow can return `413`, including an oversized ordinary batch even when each hit would fit. Other native failures can return `500`. A `503` without a readiness code is not a signal to wait for an index rebuild; inspect its message and adjust the work or concurrency that caused it.

`storage.fullText.maxRawHitsPerRequest`, `storage.fullText.maxResultsPerRequest` and `storage.fullText.requestBudgetMilliseconds` bound fetched work, retained results and execution time. Replayed or rejected hits consume raw work; a request can exhaust that budget before reaching its result target. The execution budget is not a hard response-time guarantee; reader acquisition and some native work can take additional time. See [storage configuration](../configuration/options.md#storage) for the controls and [REST paging and counts](../rest/querying.md#pagination-and-total-count) for URL syntax and count behavior.

Each offset request runs a new query and revisits earlier matches, so deeper offsets increase fetched work and source reads. Prefer narrower filters and a bounded maximum offset over repeatedly raising budgets. Each query can see changed records, permissions or index contents. Pages can therefore repeat or omit records during concurrent changes. There are no continuation tokens, close operations or retained searches across requests.

## Host query capacity

<VersionBadge version="v5.4.0" />

The default native policy allows 64 analyzed terms per text condition and 256 compiled clauses per query. Operators can configure `storage.fullText.query.maxQueryTerms` (1-1,024) and `storage.fullText.query.maxQueryClauses` (1-4,096), within the loaded native runtime's ceilings. Boolean groups, NOT, field expansion, fuzzy branches and prefix expansion also consume clause capacity. Raising fetched-hit or retained-result budgets does not raise these limits.

The host policy is captured once for the full Harper process, inherited by workers and applied to reader handles, including reopened readers. A full process restart is required; a worker-only restart does not apply changes. Requests cannot raise the policy. Overflow rejects the query rather than executing a truncated one. The rejection is a `ClientError` with status `400`, but that status does not always reach the client; see [how a capacity rejection reaches the client](#how-a-capacity-rejection-reaches-the-client). Other depth, byte, phrase/fuzzy construction, queue, response and deadline safeguards continue to apply. Native deadlines are cooperative; they cannot interrupt every construction step immediately. Fuzzy queries still have fixed native limits of 16 eligible terms and 256 construction-work units; distance two costs four times as much construction work per term and field as distance one. Raising term or clause policy does not raise those limits. Raised-policy handles also route non-ASCII text and larger ASCII queries through expensive-search admission, which can increase busy rejections under concurrency. See [storage configuration](../configuration/options.md#storage) and the [native limits](https://github.com/HarperFast/fulltext/blob/v0.9.0/docs/limits.md#query-capacity-policy).

### How a capacity rejection reaches the client

Harper returns `400` for a capacity failure only when it finds the problem before it writes the response head. Of the `storage.fullText.query` limits, the only one checked before the query runs is the `should` list length against `maxQueryClauses`. It returns `400` in every response format, like the other malformed-control errors on this page.

Harper finds every other capacity failure while the query runs:

- more analyzed terms than `storage.fullText.query.maxQueryTerms`;
- more compiled clauses than `storage.fullText.query.maxQueryClauses`, including Boolean structure, field expansion and a `should` list that passed the precheck;
- a fuzzy distance above `storage.fullText.query.maxFuzzyDistance`.

A REST collection read normally streams its results, so the response can already have started by then. The error is still a `ClientError` with status `400`, but it arrives in the body instead of the status line:

| Format           | `GET`                                                                                                                                                                  | `QUERY`                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| NDJSON           | `400` if Harper finds the problem within the stream's short startup window; otherwise `200` and a final `{"$harperStreamError": {...}}` line                           | `200` and a final `{"$harperStreamError": {...}}` line |
| JSON             | `200`; the array ends at an `{"error": "ClientError: ..."}` element with no closing `]`, and the connection closes                                                     | Same as `GET`                                          |
| CBOR             | `200`; the body is cut off                                                                                                                                             | Same as `GET`                                          |
| CSV, MessagePack | If the failure comes before the first row, no status at all: over HTTP/1.1 the connection closes and the client reports a network error. Otherwise the body is cut off | Same as `GET`                                          |

Of these formats, only NDJSON has a startup window, and only on `GET` and `HEAD`. A rejection found inside it returns `400`; one found after it does not. The same limit can land on either side, so do not rely on a `400`. `HEAD` behaves like `GET` for NDJSON. For every other format it returns an empty `200` without streaming rows, so a `200` from `HEAD` does not show that the query is within capacity. Other methods, such as a custom resource's `POST` that returns the search iterator, have no startup window and behave like `QUERY`. The operations API `search_by_conditions` operation behaves like `QUERY` for JSON and NDJSON.

Two cases return an ordinary `400` in every format, because the query finishes before Harper writes the response head:

- a `GET` with `Prefer: count=exact` or `Prefer: count=estimated` and a bounded `limit`, which builds the whole page before it responds;
- a resource that finishes consuming the `Table.search()` iterator before it returns, for example by collecting rows into an array. A resource that returns the iterator is streamed like a REST read.

See [When a Streamed Response Fails](../rest/content-types.md#when-a-streamed-response-fails) for the stream formats.

When you send a full-text query, check for all of these:

- Treat an HTTP `400`, an NDJSON `$harperStreamError` record with `status: 400`, and a JSON `error` element that begins `ClientError:` as the same result. The query is invalid or over the host policy. Do not retry it unchanged: shorten the text, reduce the conditions or fuzzy distance, or ask the operator to raise the policy.
- Do not treat `200` as success until the whole body has been read. A body that is cut off, fails to parse, or ends the read with a network error is a failed read. Discard its rows.
- The message for term and clause overflow is the same text, `Full-text query on '<index>' is invalid; check its syntax and storage.fullText.query limits`, and does not say which limit was exceeded. Count analyzed terms and Boolean branches before sending a query built from user text.

## REST

Use the comparator in the collection query string:

```http
GET /Product/?catalogSearch=matches=waterproof%20trail&limit(20)
GET /Product/?catalogSearch=matches_phrase=trail%20running&select(id,name,$score,$highlights)
GET /Product/?catalogSearch=matches_prefix=waterproof%20tra&limit(10)
```

REST supports all positive and negated full-text comparators. It can express the query text, selected fields, and pagination.

Repeat the index parameter to combine the required positive and negated conditions:

```http
GET /Product/?catalogSearch=matches=waterproof&catalogSearch=not_matches=leather&limit(20)
```

REST can return configured highlights by selecting `$highlights`. Use `Table.search()` or `search_by_conditions` for explicit `fields`, condition-level `includeHighlights`, or freshness controls. For v5.4 [query-time relevance controls](#query-time-relevance-controls), use HTTP `QUERY`, `Table.search()` or `search_by_conditions`.

## Operations API

`search_by_conditions` uses the same condition shape:

```json
{
	"operation": "search_by_conditions",
	"database": "catalog",
	"table": "Product",
	"limit": 20,
	"get_attributes": ["id", "name", "$score", "$highlights"],
	"conditions": [
		{
			"attribute": "catalogSearch",
			"comparator": "matches_all",
			"value": "waterproof trail",
			"fields": ["name", "description"],
			"includeHighlights": true,
			"maxIndexLagMilliseconds": 0,
			"waitForIndexMilliseconds": 10000
		}
	]
}
```

For v5.4 [query-time relevance controls](#query-time-relevance-controls), use the following shape:

```json
{
	"operation": "search_by_conditions",
	"database": "catalog",
	"table": "Product",
	"limit": 20,
	"get_attributes": ["id", "name", "$score"],
	"conditions": [
		{
			"attribute": "catalogSearch",
			"comparator": "matches_all",
			"value": "waterproof boots",
			"boost": 0.5,
			"should": [
				{
					"comparator": "matches_phrase",
					"value": "waterproof boots",
					"fields": ["name"],
					"boost": 3
				}
			]
		}
	]
}
```

If an index is `unknown`, `needs-rebuild`, or `rebuilding`, the query returns `503` with `code: "INDEX_REBUILDING"` and `retryable: true`. An index in terminal `unavailable` state returns a generic, non-retryable `503`; inspect readiness and logs instead of retrying it as a rebuild. Other busy paths can also return a generic `503`, so clients should branch on the code rather than the status alone. Unreadable source fields return `403`. Invalid declarations, unsupported match modes, incompatible combinations, and out-of-range options return `400` responses.

For paging-budget and native response-envelope failures, see [paging and prefix result windows](#paging-and-prefix-result-windows).
