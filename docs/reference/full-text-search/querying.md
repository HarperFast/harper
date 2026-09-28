---
title: Querying
---

# Querying Full-Text Indexes

<VersionBadge version="v5.3.0" /> <EngineBadge engines="RocksDB" />

Use the full-text index name as a condition attribute in `Table.search()`.

```javascript
const products = await Product.search({
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'waterproof trail shoes' }],
	limit: 20,
});
```

Results are ordered by BM25 relevance. The index declaration, not the source field name, identifies the full-text search target.

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

A query containing a negated full-text condition must also contain a non-negated full-text condition on the same index. A structured record condition alone does not satisfy this requirement. The positive full-text condition bounds the candidate set; the negated condition filters it.

```javascript
const products = await Product.search({
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
const products = await Product.search({
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

Direct calls through `tables` or `databases` run in a trusted server-side context and do not reapply the caller's role or attribute permissions. Custom resources must authorize protected searches before returning records or highlights.

## Score and ordering

Select `$score` to include the BM25 score:

```javascript
const products = await Product.search({
	conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
	select: ['id', 'name', '$score'],
	limit: 20,
});
```

Full-text results use descending relevance order. The only explicit full-text sort is `$score` descending; other sort keys and reverse iteration are rejected because they would discard the native ranking.

## Highlights

Highlighting returns source-field fragments and matching character spans. The index must enable highlighting for each requested source field.

Selecting `$highlights` turns highlighting on for the query:

```javascript
const products = await Product.search({
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
const products = await Product.search({
	operator: 'and',
	conditions: [
		{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoe' },
		{ attribute: 'price', comparator: 'less_than', value: 150 },
	],
	limit: 20,
});
```

An `or` group may combine conditions from the same full-text index:

```javascript
const products = await Product.search({
	operator: 'or',
	conditions: [
		{ attribute: 'catalogSearch', comparator: 'matches_phrase', value: 'trail running' },
		{ attribute: 'catalogSearch', comparator: 'matches', value: 'hiking boot' },
	],
});
```

An `or` group cannot mix full-text and ordinary record conditions, and one query cannot combine different full-text indexes. Run separate queries when either boundary is required.

## Freshness controls

A full-text index is derived from committed table changes. Each condition accepts:

| Option                     | Default | Description                                                                        |
| -------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `maxIndexLagMilliseconds`  | `3000`  | Maximum accepted upper bound on index lag. Set to `0` to require current coverage. |
| `waitForIndexMilliseconds` | `0`     | How long to wait for acceptable coverage, from `0` through `30000`.                |

For read-after-write behavior, require current coverage and allow a bounded wait:

```javascript
const products = await Product.search({
	conditions: [
		{
			attribute: 'catalogSearch',
			comparator: 'matches',
			value: 'new product',
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 10000,
		},
	],
});
```

All full-text conditions combined into one query must use the same freshness values. Harper returns `400` when combined conditions specify different values.

A non-waiting HTTP query returns `Harper-Index-Coverage` with the admitted state, lag upper bound, and requested tolerance. A waiting `Table.search()` establishes coverage as its iterator is consumed. A `search_by_conditions` request completes only after its wait and search finish. Waiting queries do not emit a coverage header before completion.

## Prefix result window

`matches_prefix` and `matches_fuzzy_prefix` are autocomplete-style record searches. Any expression containing one of these modes uses a 100-record native result window, and `offset + limit` cannot exceed that window. If an unbounded query has more than 100 matches, Harper returns `400` and requires a limit instead of silently truncating the result. These modes return matching records, not a separate list of suggested terms.

Other match modes page through the native result window as needed.

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

If an index is rebuilding, the query returns `503` with `code: "INDEX_REBUILDING"` and `retryable: true`. Other unavailable or busy paths can return a generic `503`, so clients should branch on the code rather than the status alone. Invalid declarations, unsupported match modes, incompatible combinations, and out-of-range options return `400` responses.
