---
title: REST Querying
---

<!-- Source: versioned_docs/version-4.7/developers/rest.md (querying sections - primary) -->
<!-- Source: release-notes/v4-tucker/4.1.0.md (iterator-based queries) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (relationships/joins, sorting, nested select, null indexing) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (improved URL path parsing, directURLMapping) -->

# REST Querying

Harper's REST interface supports a rich URL-based query language for filtering, sorting, selecting, and limiting records. Queries are expressed as URL query parameters on collection paths.

## Basic Attribute Filtering

Search by attribute name and value using query parameters. The queried attribute must be indexed.

```http
GET /Product/?category=software
```

Multiple attributes can be combined — only one needs to be indexed for the query to execute:

```http
GET /Product/?category=software&inStock=true
```

### Null Queries

<VersionBadge version="v4.3.0" />

Query for null values or non-null values:

```http
GET /Product/?discount=null
```

Note: Only indexes created in v4.3.0 or later support null indexing. Existing indexes must be rebuilt (removed and re-added) to support null queries.

## Comparison Operators (FIQL)

Harper uses [FIQL](https://datatracker.ietf.org/doc/html/draft-nottingham-atompub-fiql-00) syntax for comparison operators:

| Operator             | Meaning                                |
| -------------------- | -------------------------------------- |
| `==`                 | Equal                                  |
| `=lt=`               | Less than                              |
| `=le=`               | Less than or equal                     |
| `=gt=`               | Greater than                           |
| `=ge=`               | Greater than or equal                  |
| `=ne=`, `!=`         | Not equal                              |
| `=ct=`               | Contains (strings)                     |
| `=sw=`, `==<value>*` | Starts with (strings)                  |
| `=ew=`               | Ends with (strings)                    |
| `=`, `===`           | Strict equality (no type conversion)   |
| `!==`                | Strict inequality (no type conversion) |

Full-text indexes support `=matches=`, `=matches_all=`, `=matches_phrase=`, `=matches_prefix=`, `=matches_fuzzy=`, and `=matches_fuzzy_prefix=`. Each has a negated form: `=not_matches=`, `=not_matches_all=`, `=not_matches_phrase=`, `=not_matches_prefix=`, `=not_matches_fuzzy=`, and `=not_matches_fuzzy_prefix=`. Combine a negated condition with a positive full-text condition on the same index; a structured filter alone does not qualify. These use the full-text index rather than ordinary string comparisons. See [Full-text query execution](../resources/query-optimization.md#full-text-search-work-and-paging).

**Examples**:

```http
GET /Product/?price=gt=100
GET /Product/?price=le=20
GET /Product/?name==Keyboard*
GET /Product/?category=software&price=gt=100&price=lt=200
```

For date fields, colons must be URL-encoded as `%3A`:

```http
GET /Product/?listDate=gt=2017-03-08T09%3A30%3A00.000Z
```

### Full-Text Operators

<VersionBadge version="v5.3.0" /> <EngineBadge engines="RocksDB" />

For a `FullText` field carrying `@fullText`, use the field name as the query attribute and choose a full-text comparator:

```http
GET /Product/?catalogSearch=matches=waterproof%20trail
GET /Product/?catalogSearch=matches_phrase=trail%20running
GET /Product/?catalogSearch=matches_prefix=waterproof%20tra&limit(10)
```

REST supports `matches`, `matches_all`, `matches_phrase`, `matches_prefix`, `matches_fuzzy`, and `matches_fuzzy_prefix`, plus a `not_` form of each. A negated full-text condition requires a non-negated condition on the same index. Repeat the parameter to provide both conditions:

```http
GET /Product/?catalogSearch=matches=waterproof&catalogSearch=not_matches=leather
```

REST's `limit(start,end)` uses an exclusive end. In v5.4, this prefix query skips 100 eligible products and requests the next 10, within request budgets:

```http
GET /Product/?catalogSearch=matches_prefix=waterproof%20tra&limit(100,110)
```

Use `Table.search()` or `search_by_conditions` when conditions need source-field selection, condition-level highlighting, or freshness controls. See [Querying Full-Text Indexes](../full-text-search/querying.md) for ranking, highlights, query combinations, and freshness controls.

The REST URL syntax searches every source field in the index, so the caller must be allowed to read every source field. Before v5.4, prefix and fuzzy-prefix queries restrict `offset + limit` to 100. In v5.4, bounded full-text and autocomplete queries can pass that native window within request budgets; source-version checks and filters run before records count toward the offset and limit. Each page is a new query and can see concurrent changes. See [paging and prefix result windows](../full-text-search/querying.md#paging-and-prefix-result-windows). Full-text queries cannot provide an exact total count. On a REST interface with `exactCount: true`, a `Prefer: count=exact` request returns an unavailable total (`Content-Range: items <range>/*`). Without that opt-in, Harper applies `count=estimated` instead and can return an estimate.

### Chained Conditions (Range)

Omit the attribute name on the second condition to chain it against the same attribute:

```http
GET /Product/?price=gt=100&lt=200
```

Chaining supports `gt`/`ge` combined with `lt`/`le` for range queries. No other chaining combinations are currently supported.

### Type Conversion

For FIQL comparators (`==`, `!=`, `=gt=`, etc.), Harper applies automatic type conversion:

| Syntax                                    | Behavior                                    |
| ----------------------------------------- | ------------------------------------------- |
| `name==null`                              | Converts to `null`                          |
| `name==123`                               | Converts to number if attribute is untyped  |
| `name==true`                              | Converts to boolean if attribute is untyped |
| `name==number:123`                        | Explicit number conversion                  |
| `name==boolean:true`                      | Explicit boolean conversion                 |
| `name==string:some%20text`                | Keep as string with URL decode              |
| `name==date:2024-01-05T20%3A07%3A27.955Z` | Explicit Date conversion                    |

If the attribute specifies a type in the schema (e.g., `Float`), values are always converted to that type before searching.

For strict operators (`=`, `===`, `!==`), no automatic type conversion is applied — the value is decoded as a URL-encoded string, and the attribute type (if declared in the schema) dictates type conversion.

## Unions (OR Logic)

Use `|` instead of `&` to combine conditions with OR logic:

```http
GET /Product/?rating=5|featured=true
```

## Grouping

Use parentheses or square brackets to control order of operations:

```http
GET /Product/?rating=5|(price=gt=100&price=lt=200)
```

Square brackets are recommended when constructing queries from user input because standard URI encoding safely encodes `[` and `]` (but not `(`):

```http
GET /Product/?rating=5&[tag=fast|tag=scalable|tag=efficient]
```

Constructing from JavaScript:

```javascript
let url = `/Product/?rating=5&[${tags.map(encodeURIComponent).join('|')}]`;
```

Groups can be nested for complex conditions:

```http
GET /Product/?price=lt=100|[rating=5&[tag=fast|tag=scalable|tag=efficient]&inStock=true]
```

## Query Functions

Harper supports special query functions using call syntax, included in the query string separated by `&`.

### `select(properties)`

Specify which properties to include in the response.

| Syntax                                 | Returns                                     |
| -------------------------------------- | ------------------------------------------- |
| `?select(property)`                    | Values of a single property directly        |
| `?select(property1,property2)`         | Objects with only the specified properties  |
| `?select([property1,property2])`       | Arrays of property values                   |
| `?select(property1,)`                  | Objects with a single specified property    |
| `?select(property{subProp1,subProp2})` | Nested objects with specific sub-properties |

**Examples**:

```http
GET /Product/?category=software&select(name)
GET /Product/?brand.name=Microsoft&select(name,brand{name})
```

### `limit(end)` or `limit(start,end)`

Limit the number of results returned, with an optional starting offset. The start is inclusive and the end is exclusive: `limit(10,30)` skips 10 records and returns up to 20.

```http
GET /Product/?rating=gt=3&inStock=true&select(rating,name)&limit(20)
GET /Product/?rating=gt=3&limit(10,30)
```

### `sort(property)` or `sort(+property,-property,...)`

Sort results by one or more properties. Prefix `+` or no prefix = ascending; `-` = descending. Multiple properties break ties in order.

```http
GET /Product/?rating=gt=3&sort(+name)
GET /Product/?sort(+rating,-price)
```

## Pagination and Total Count

<VersionBadge version="v5.3.0" />

Use `limit(start,end)` to page through a collection, and opt in to a total match count with the `Prefer` request header (`Prefer: count=exact`) so a client can render pagination (for example "1-25 of 1,234") without a second request.

Counting is opt-in: without the header, no count is computed and no count headers are returned. It applies only to `GET`/`HEAD` requests and requires a bounded page — the `limit()` must be a non-negative integer no larger than **10,000**, and the requested window (offset + limit) no larger than **1,000,000**. A request with no `limit()`, one outside those bounds, or a non-numeric one is served normally with no count headers, since counting an unbounded page would defeat the point of paging.

Full-text and autocomplete queries use the same paging syntax. The page window counts eligible records after record filtering, rather than raw full-text hits. Harper fetches more ranked batches to fill that window when needed. A page can contain fewer records when no further matches remain; reaching a search work or time limit fails the query. A failure detected before response headers can set an error HTTP status. After streaming starts, the response can retain HTTP 200 and end with an error. For JSON-array responses, check for a terminal `error` element and treat the response as failed; do not render that element as a record. For other formats, detect stream or decoding failures as well. Neither status 200 nor count headers prove that a page completed successfully. Each page request runs a new query, so concurrent changes can cause repeats or omissions between pages. See [Full-text query execution](../resources/query-optimization.md#full-text-search-work-and-paging) for search work limits and recovery guidance.

The count-header guardrails do not override query-specific limits such as the full-text work budget.

### Requesting a count

Send a `Prefer` header on a `GET` (or `HEAD`) request to a collection:

| Value             | Meaning                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `count=exact`     | The exact number of matching records when the query plan can count them. Scans the full matched set, so it is off by default (see [below](#enabling-exact-counts)) and served as an estimate unless enabled for the REST interface. When enabled, full-text and other custom-index queries report an unavailable total instead. |
| `count=estimated` | A fast planner/table estimate. Cheap, approximate.                                                                                                                                                                                                                                                                              |

```http
GET /Product/?category=software&limit(0,25)
Prefer: count=exact
```

### Count response headers

The count is returned in [RFC 7233](https://datatracker.ietf.org/doc/html/rfc7233)-style response headers alongside the page body:

| Header               | Example           | Description                                                                                   |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `Content-Range`      | `items 0-24/1234` | The 0-based, inclusive range of records returned (`start-end`) out of the total matching set. |
| `Range-Unit`         | `items`           | The unit used by `Content-Range`.                                                             |
| `Preference-Applied` | `count=exact`     | The count mode the server applied (`exact` or `estimated`).                                   |

```http
HTTP/1.1 200 OK
Content-Range: items 0-24/1234
Range-Unit: items
Preference-Applied: count=exact
```

The response status is always `200` — `Content-Range` is informational (Harper does not use `206 Partial Content`). A `HEAD` request with a `count` preference returns the count headers with no body — it saves transferring the page, but `count=exact` still scans the matched set (subject to the same guardrails), so it is a bandwidth-saving pre-flight, not a low-cost counting shortcut. When CORS is enabled, these three headers are added to `Access-Control-Expose-Headers` so browser clients can read them cross-origin.

### Unavailable totals

The total is reported as `*` (for example `Content-Range: items 0-24/*`) when it cannot be produced — an exact scan that hits its guardrail (counting the tail past the requested page is bounded by a 1,000,000-row cap and a ~1-second budget, and abandons the total rather than truncating the page), a full-text or other custom-index query, or a query with no cardinality estimate (for example a `!=` or `=ct=` (contains) condition). `Preference-Applied` still echoes the requested mode, so an unavailable total (`.../*`) is distinct from a request that asked for no count.

Full-text and autocomplete queries cannot provide an exact total. An estimated count may use the planner estimate when the query has no opaque row or vector filter. See [Full-text query execution](../resources/query-optimization.md#full-text-search-work-and-paging).

### Enabling exact counts

Because an exact count scans the full matched set, it is **off by default**. Enable it in an application's REST configuration via the [`exactCount` option](./overview.md#configuration):

```yaml
rest:
  exactCount: true
```

Without it, a `count=exact` request is served as an estimate (the response reports `Preference-Applied: count=estimated`). Estimated counts do not require `exactCount`; when no estimate is available, the total is reported as `*`.

<VersionBadge version="v4.3.0" />

## Relationships and Joins

<VersionBadge version="v4.3.0" />

Harper supports querying across related tables through dot-syntax chained attributes. Relationships must be defined in the schema using `@relationship`.

**Schema example**:

```graphql
type Product @table @export {
	id: Long @primaryKey
	name: String
	brandId: Long @indexed
	brand: Brand @relationship(from: "brandId")
}
type Brand @table @export {
	id: Long @primaryKey
	name: String
	products: [Product] @relationship(to: "brandId")
}
```

**Query by related attribute** (INNER JOIN behavior):

```http
GET /Product/?brand.name=Microsoft
GET /Brand/?products.name=Keyboard
```

### Nested Select with Joins

Relationship attributes are not included by default. Use `select()` to include them:

```http
GET /Product/?brand.name=Microsoft&select(name,brand)
GET /Product/?brand.name=Microsoft&select(name,brand{name})
GET /Product/?name=Keyboard&select(name,brand{name,id})
```

When selecting without a filter on the related table, this acts as a LEFT JOIN — the relationship property is omitted if the foreign key is null or references a non-existent record.

### Many-to-Many Relationships

Many-to-many relationships can be modeled with an array of foreign key values, without a junction table:

```graphql
type Product @table @export {
	id: Long @primaryKey
	name: String
	resellerIds: [Long] @indexed
	resellers: [Reseller] @relationship(from: "resellerIds")
}
```

```http
GET /Product/?resellers.name=Cool Shop&select(id,name,resellers{name,id})
```

The array order of `resellerIds` is preserved when resolving the relationship.

## Property Access via URL

<VersionBadge type="changed" version="v4.5.0" />

Access a specific property of a record by appending it with dot syntax to the record id:

```http
GET /MyTable/123.propertyName
```

This only works for declared properties — a table's schema attributes, or a programmatic Resource's [`static properties`](/reference/v5/resources/resource-api#static-properties-recordstring-jsonschemafragment) <VersionBadge type="changed" version="v5.2.0" />. As of v4.5.0, dots in URL paths are no longer interpreted as property access for undeclared properties, allowing URLs to generally include dots without being misinterpreted. The suffixes `.json`, `.cbor`, `.msgpack`, and `.csv` are reserved as content-type selectors and take precedence over a property of the same name.

## `directURLMapping` Option

<VersionBadge version="v4.5.0" />

Resources can be configured with `directURLMapping: true` for more direct URL path handling. When enabled, the URL path is mapped more directly to the resource without the default query parameter parsing semantics. See [Database / Schema](../database/schema.md) for configuration details.

## See Also

- [REST Overview](./overview.md) — HTTP methods, URL structure, and caching
- [Headers](./headers.md) — Request and response headers
- [Content Types](./content-types.md) — Encoding formats
- [Database / Schema](../database/schema.md) — Defining schemas, relationships, and indexes
