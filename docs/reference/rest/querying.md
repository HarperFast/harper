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

Limit the number of results returned, with an optional starting offset.

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

### Requesting a count

Send a `Prefer` header on a `GET` (or `HEAD`) request to a collection:

| Value             | Meaning                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `count=exact`     | The exact number of matching records. Scans the full matched set, so it is off by default (see [below](#enabling-exact-counts)) and served as an estimate unless enabled for the REST interface. |
| `count=estimated` | A fast planner/table estimate. Cheap, approximate.                                                                                                                                               |

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

The total is reported as `*` (for example `Content-Range: items 0-24/*`) when it cannot be produced — an exact scan that hits its guardrail (counting the tail past the requested page is bounded by a 1,000,000-row cap and a ~1-second budget, and abandons the total rather than truncating the page), or a query with no cardinality estimate (for example a `!=` or `=ct=` (contains) condition). `Preference-Applied` still echoes the requested mode, so an unavailable total (`.../*`) is distinct from a request that asked for no count.

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

### Filtering and Paging Each Relationship

:::note Pending release

Pending a 5.3 patch release; see [Honor nested relationship filters and pagination](https://github.com/HarperFast/harper/pull/3279).

:::

Use square brackets inside `select()` to apply conditions, sort, and pagination to each parent's related records.

**An outer relationship filter also narrows that relationship's nested results.** For example, `products.price=ge=number:30` selects brands with a qualifying product and restricts their selected products to those costing at least 30. **You do not need to repeat that price filter inside `products[...]`.** Add a nested condition only when you want to narrow the already-eligible products further without removing their parents.

The following examples use a `Brand.products` relationship with this data:

| Brand ID | Brand         | Product ID | Product  | Price |
| -------- | ------------- | ---------- | -------- | ----- |
| 42       | Acme          | p1         | Cable    | 10    |
| 42       | Acme          | p2         | Keyboard | 35    |
| 42       | Acme          | p3         | Dock     | 60    |
| 43       | Budget Basics | p4         | Mouse    | 15    |
| 44       | Studio Gear   | p5         | Stand    | 45    |
| 44       | Studio Gear   | p6         | Monitor  | 120   |

Each response below contains only the requested fields. Parent order is shown for this sample; the nested `sort(price)` orders products within each brand, not the brands themselves.

#### Keep every brand; show its cheapest product costing at least 30

The price filter is inside the relationship selection, so Budget Basics remains in the response with an empty product list.

```http
GET /Brand/?select(id,name,products[price=ge=number:30&sort(price)&limit(1)&select(id,name,price)])
```

Response:

```json
[
	{
		"id": 42,
		"name": "Acme",
		"products": [
			{
				"id": "p2",
				"name": "Keyboard",
				"price": 35
			}
		]
	},
	{
		"id": 43,
		"name": "Budget Basics",
		"products": []
	},
	{
		"id": 44,
		"name": "Studio Gear",
		"products": [
			{
				"id": "p5",
				"name": "Stand",
				"price": 45
			}
		]
	}
]
```

#### Return only qualifying brands; inherit the price filter

The outer price filter removes Budget Basics and also removes cheaper products from the nested candidates. The nested selection only needs sorting, a limit, and a projection; repeating the price filter is unnecessary.

```http
GET /Brand/?products.price=ge=number:30&select(id,name,products[sort(price)&limit(1)&select(id,name,price)])
```

Response:

```json
[
	{
		"id": 42,
		"name": "Acme",
		"products": [
			{
				"id": "p2",
				"name": "Keyboard",
				"price": 35
			}
		]
	},
	{
		"id": 44,
		"name": "Studio Gear",
		"products": [
			{
				"id": "p5",
				"name": "Stand",
				"price": 45
			}
		]
	}
]
```

#### Use a stricter condition for the displayed products

Both Acme and Studio Gear qualify because each has a product costing at least 30. The additional nested condition displays only products costing at least 100. Acme remains with an empty array: the nested condition does not remove a parent. It further narrows the inherited candidates; it cannot restore products excluded by the outer filter.

```http
GET /Brand/?products.price=ge=number:30&select(id,name,products[price=ge=number:100&sort(price)&limit(1)&select(id,name,price)])
```

Response:

```json
[
	{
		"id": 42,
		"name": "Acme",
		"products": []
	},
	{
		"id": 44,
		"name": "Studio Gear",
		"products": [
			{
				"id": "p6",
				"name": "Monitor",
				"price": 120
			}
		]
	}
]
```

#### Page through each brand's qualifying products

After the outer price filter and per-brand sort, `limit(1,2)` skips the first eligible product and returns the second for each qualifying brand. Acme returns Dock, not Keyboard; Studio Gear returns Monitor, not Stand. The offset applies independently to each brand.

```http
GET /Brand/?products.price=ge=number:30&select(id,name,products[sort(price)&limit(1,2)&select(id,name,price)])
```

Response:

```json
[
	{
		"id": 42,
		"name": "Acme",
		"products": [
			{
				"id": "p3",
				"name": "Dock",
				"price": 60
			}
		]
	},
	{
		"id": 44,
		"name": "Studio Gear",
		"products": [
			{
				"id": "p6",
				"name": "Monitor",
				"price": 120
			}
		]
	}
]
```

#### Nested option reference

| Nested option      | Behavior                                                                         |
| ------------------ | -------------------------------------------------------------------------------- |
| Conditions         | Qualify children of the selected relationship; combine with AND, OR, and groups. |
| `sort(price)`      | Order that parent's eligible children before pagination.                         |
| `limit(end)`       | Return at most `end` children per parent.                                        |
| `limit(start,end)` | Skip `start` eligible children and return at most `end - start`.                 |
| `select(id,price)` | Project fields from returned children; omit it to return whole child records.    |

Use a non-negative safe-integer window; `limit(0)` returns no children without reading them; an absent foreign key keeps its missing-value shape. A missing singular relationship remains absent. For array-valued foreign keys, pagination alone preserves missing target positions; adding conditions or a sort drops missing targets. Child conditions and sort fields remain subject to read permissions.

A condition that traverses another relationship qualifies the immediate child; it does not narrow that child's projected descendants. To filter or page grandchildren, put those constraints on the grandchild's own bracket selection. Outer join restrictions are still inherited.

For source-backed caches, eligibility and sort keys use local cached entries, as in a top-level table query. Returned children can refresh from source; a refreshed child that no longer matches, or has been deleted, does not consume offset or limit. A locally rejected child is not fetched to discover whether its source value now matches. Ordering is not recomputed from refreshed source values.

Unsorted pagination can stop when the requested page is filled. Sorting or a predicate with few matches can still examine all related candidates; a small output limit does not guarantee a small scan.

Query constraints on plain JSON projections and full-text predicates inside a relationship selection are unsupported and return a client error. Projection-only JSON syntax remains supported. Earlier versions accepted nested filters and pagination but could silently ignore them and return all related children; this correction can reduce child arrays and reject previously ignored unsupported options.

The [Resource API](../resources/resource-api.md#constraining-related-records) accepts the same options in a nested selection object.

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
