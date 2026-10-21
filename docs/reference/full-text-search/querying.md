---
title: Querying
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

Results are ordered by BM25 relevance. The `FullText` field, not one of its source fields, identifies the search target.

## Match modes

| Comparator             | Behavior                                                              | Required index option |
| ---------------------- | --------------------------------------------------------------------- | --------------------- |
| `matches`              | Matches any analyzed query term.                                      | —                     |
| `matches_all`          | Requires every analyzed query term.                                   | —                     |
| `matches_phrase`       | Matches analyzed terms in order as a phrase.                          | `positions: true`     |
| `matches_prefix`       | Matches records whose analyzed terms start with the final query term. | `surfaceTerms: true`  |
| `matches_fuzzy`        | Matches terms within one edit, including a transposition.             | —                     |
| `matches_fuzzy_prefix` | Combines one-edit fuzzy matching with a final-term prefix.            | `surfaceTerms: true`  |

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

Select `$score` to include the BM25 score:

```javascript
const products = Product.search({
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	select: ['id', 'name', '$score'],
	limit: 20,
});
```

Full-text results use descending relevance order. The only explicit full-text sort is `$score` descending; other sort keys and reverse iteration are rejected because they would discard the native ranking.

An exact count requested through `Table.search()` does not report a full-text total after authorization, structured filtering, and current-record validation. It returns `recordCount: null` and `recordCountExact: false`. REST behaves the same when its interface enables `exactCount`; otherwise `Prefer: count=exact` is downgraded to an estimated count.

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

| Option                     | Default | Description                                                                        |
| -------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `maxIndexLagMilliseconds`  | `3000`  | Maximum accepted upper bound on index lag. Set to `0` to require current coverage. |
| `waitForIndexMilliseconds` | `0`     | How long to wait for acceptable coverage, from `0` through `30000`.                |

For read-after-write behavior, require current coverage and allow a bounded wait:

```javascript
const products = [];
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
	products.push(product);
}
```

All full-text conditions combined into one query must use the same freshness values. Harper returns `400` when combined conditions specify different values.

A non-waiting HTTP query can return `Harper-Index-Coverage` with the admitted state, lag upper bound, and requested tolerance. A zero-size page performs no native search and carries no coverage proof. A waiting `Table.search()` establishes coverage as its iterator is consumed. A `search_by_conditions` request completes only after its wait and search finish. Waiting queries do not emit a coverage header before completion.

If acceptable coverage is not reached before `waitForIndexMilliseconds` expires, Harper returns `503` with `code: "DERIVED_INDEX_LAGGING"` and `retryable: true`. For `Table.search()`, the error is raised while the async iterator is consumed. An HTTP response may already be streaming, so clients should also handle a terminal stream error rather than relying only on the initial status.

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

REST can return configured highlights by selecting `$highlights`. Use `Table.search()` or `search_by_conditions` for explicit `fields`, condition-level `includeHighlights`, or freshness controls.

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

If an index is `unknown`, `needs-rebuild`, or `rebuilding`, the query returns `503` with `code: "INDEX_REBUILDING"` and `retryable: true`. An index in terminal `unavailable` state returns a generic, non-retryable `503`; inspect readiness and logs instead of retrying it as a rebuild. Other busy paths can also return a generic `503`, so clients should branch on the code rather than the status alone. Unreadable source fields return `403`. Invalid declarations, unsupported match modes, incompatible combinations, and out-of-range options return `400` responses.

For paging-budget and native response-envelope failures, see [paging and prefix result windows](#paging-and-prefix-result-windows).
