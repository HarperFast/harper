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

<VersionBadge version="v4.3.0" />

## Relationships and Joins

<VersionBadge version="v4.3.0" />

Harper supports querying across related tables through dot-syntax chained attributes. Relationships must be defined in the schema using `@relation`.

**Schema example**:

```graphql
type Product @table @export {
	id: Long @primaryKey
	name: String
	brandId: Long @indexed
	brand: Brand @relation(from: "brandId")
}
type Brand @table @export {
	id: Long @primaryKey
	name: String
	products: [Product] @relation(to: "brandId")
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
	resellers: [Reseller] @relation(from: "resellerId")
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

This only works for properties declared in the schema. As of v4.5.0, dots in URL paths are no longer interpreted as property access for undeclared properties, allowing URLs to generally include dots without being misinterpreted.

## `directURLMapping` Option

<VersionBadge version="v4.5.0" />

Resources can be configured with `directURLMapping: true` for more direct URL path handling. When enabled, the URL path is mapped more directly to the resource without the default query parameter parsing semantics. See [Database / Schema](../database/schema.md) for configuration details.

## See Also

- [REST Overview](./overview.md) — HTTP methods, URL structure, and caching
- [Headers](./headers.md) — Request and response headers
- [Content Types](./content-types.md) — Encoding formats
- [Database / Schema](../database/schema.md) — Defining schemas, relationships, and indexes
