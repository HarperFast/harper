---
title: Querying
---

# Querying Full-Text Indexes

<VersionBadge version="v5.3.0" />

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
| `matches_fuzzy`        | Matches terms within the supported edit distance.                     | —                     |
| `matches_fuzzy_prefix` | Combines fuzzy matching with a final-term prefix.                     | `surfaceTerms: true`  |

Every comparator also has a negated form: `not_matches`, `not_matches_all`, `not_matches_phrase`, `not_matches_prefix`, `not_matches_fuzzy`, and `not_matches_fuzzy_prefix`.

A query containing a negated full-text condition must also contain a positive condition. The positive condition bounds the candidate set; the negated condition filters it.

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

Every requested field must belong to the index and be readable by the caller.

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

A non-waiting HTTP query returns `Harper-Index-Coverage` with the admitted state, lag upper bound, and requested tolerance. Waiting queries establish coverage while the response stream is consumed and do not emit that header before completion.

## Prefix result window

`matches_prefix` and `matches_fuzzy_prefix` are autocomplete-style record searches. Their current native result window is 100 records, and `offset + limit` cannot exceed that window. They return matching records, not a separate list of suggested terms.

Other match modes page through the native result window as needed.

## REST

Use the comparator in the collection query string:

```http
GET /Product/?catalogSearch=matches=waterproof%20trail&limit(20)
GET /Product/?catalogSearch=matches_phrase=trail%20running&select(id,name,$score,$highlights)
GET /Product/?catalogSearch=matches_prefix=waterproof%20tra&limit(10)
```

REST supports all positive and negated full-text comparators. It can express the query text, selected fields, and pagination. Use `Table.search()` or `search_by_conditions` when a condition needs `fields`, highlighting flags, or freshness controls.

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

If an index is rebuilding or unavailable, the query returns a retryable `503`. Invalid declarations, unsupported match modes, incompatible combinations, and out-of-range options return `400` responses.
