---
title: Schema
---

<!-- Source: versioned_docs/version-4.7/developers/applications/defining-schemas.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/data-types.md (data types) -->
<!-- Source: versioned_docs/version-4.7/reference/dynamic-schema.md (dynamic schema behavior) -->
<!-- Source: versioned_docs/version-4.7/reference/blob.md (blob type) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (configurable schemas introduced) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (relationships, null indexing, BigInt) -->
<!-- Source: release-notes/v4-tucker/4.4.0.md (computed properties, custom indexing, auto-increment PKs) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (blob storage) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (vector indexing HNSW) -->

# Schema

Harper uses GraphQL Schema Definition Language (SDL) to declaratively define table structure. Schema definitions are loaded from `.graphql` files in a component directory and control table creation, attribute types, indexing, and relationships.

## Overview

<VersionBadge version="v4.2.0" />

Schemas are defined using standard [GraphQL type definitions](https://graphql.org/learn/schema/) with Harper-specific directives. A schema definition:

- Ensures required tables exist when a component is deployed
- Enforces attribute types and required constraints
- Controls which attributes are indexed
- Defines relationships between tables
- Configures computed properties, expiration, and audit behavior

Schemas are flexible by default — records may include additional properties beyond those declared in the schema. Use the `@sealed` directive to prevent this.

A minimal example:

```graphql
type Dog @table {
	id: Long @primaryKey
	name: String
	breed: String
	age: Int
}

type Breed @table {
	id: Long @primaryKey
	name: String @indexed
}
```

### Loading Schemas

In a component's `config.yaml`, specify the schema file with the `graphqlSchema` plugin:

```yaml
graphqlSchema:
  files: 'schema.graphql'
```

Keep in mind that both plugins and applications can specify schemas.

## Type Directives

Type directives apply to the entire table type definition.

### `@table`

Marks a GraphQL type as a Harper database table. The type name becomes the table name by default.

```graphql
type MyTable @table {
	id: Long @primaryKey
}
```

Optional arguments:

| Argument     | Type      | Default        | Description                                                             |
| ------------ | --------- | -------------- | ----------------------------------------------------------------------- |
| `table`      | `String`  | type name      | Override the table name                                                 |
| `database`   | `String`  | `"data"`       | Database to place the table in                                          |
| `expiration` | `Int`     | —              | Auto-expire records after this many seconds (useful for caching tables) |
| `audit`      | `Boolean` | config default | Enable audit log for this table                                         |

**Examples:**

```graphql
# Override table name
type Product @table(table: "products") {
	id: Long @primaryKey
}

# Place in a specific database
type Order @table(database: "commerce") {
	id: Long @primaryKey
}

# Auto-expire records after 1 hour (e.g., a session cache)
type Session @table(expiration: 3600) {
	id: Long @primaryKey
	userId: String
}

# Enable audit log for this table explicitly
type AuditedRecord @table(audit: true) {
	id: Long @primaryKey
	value: String
}

# Combine multiple arguments
type Event @table(database: "analytics", expiration: 86400) {
	id: Long @primaryKey
	name: String @indexed
}
```

**Database naming:** Since all tables default to the `data` database, when designing plugins or applications, consider using unique database names to avoid table naming collisions.

### `@export`

Exposes the table as an externally accessible resource endpoint, available via REST, MQTT, and other interfaces.

```graphql
type MyTable @table @export(name: "my-table") {
	id: Long @primaryKey
}
```

The optional `name` parameter specifies the URL path segment (e.g., `/my-table/`). Without `name`, the type name is used.

### `@sealed`

Prevents records from including any properties beyond those explicitly declared in the type. By default, Harper allows records to have additional properties.

```graphql
type StrictRecord @table @sealed {
	id: Long @primaryKey
	name: String
}
```

## Field Directives

Field directives apply to individual attributes in a type definition.

### `@primaryKey`

Designates the attribute as the table's primary key. Primary keys must be unique; inserts with a duplicate primary key are rejected.

```graphql
type Product @table {
	id: Long @primaryKey
	name: String
}
```

If no primary key is provided on insert, Harper auto-generates one:

- **UUID string** — when type is `String` or `ID`
- **Auto-incrementing integer** — when type is `Int`, `Long`, or `Any`

<VersionBadge type="changed" version="v4.4.0" />

Auto-incrementing integer primary keys were added. Previously only UUID generation was supported for `ID` and `String` types.

Using `Long` or `Any` is recommended for auto-generated numeric keys. `Int` is limited to 32-bit and may be insufficient for large tables.

### `@indexed`

Creates a secondary index on the attribute for fast querying. Required for filtering by this attribute in REST queries, SQL, or NoSQL operations.

```graphql
type Product @table {
	id: Long @primaryKey
	category: String @indexed
	price: Float @indexed
}
```

If the field value is an array, each element in the array is individually indexed, enabling queries by any individual value.

Null values are indexed by default (added in v4.3.0), enabling queries like `GET /Product/?category=null`.

### `@createdTime`

Automatically assigns a creation timestamp (Unix epoch milliseconds) to the attribute when a record is created.

```graphql
type Event @table {
	id: Long @primaryKey
	createdAt: Long @createdTime
}
```

### `@updatedTime`

Automatically assigns a timestamp (Unix epoch milliseconds) each time the record is updated.

```graphql
type Event @table {
	id: Long @primaryKey
	updatedAt: Long @updatedTime
}
```

## Relationships

<VersionBadge version="v4.3.0" />

The `@relationship` directive defines how one table relates to another through a foreign key. Relationships enable join queries and allow related records to be selected as nested properties in query results.

### `@relationship(from: attribute)` — many-to-one or many-to-many

The foreign key is in this table, referencing the primary key of the target table.

```graphql
type RealityShow @table @export {
	id: Long @primaryKey
	networkId: Long @indexed # foreign key
	network: Network @relationship(from: networkId) # many-to-one
	title: String @indexed
}

type Network @table @export {
	id: Long @primaryKey
	name: String @indexed # e.g. "Bravo", "Peacock", "Netflix"
}
```

Query shows by network name:

```http
GET /RealityShow?network.name=Bravo
```

If the foreign key is an array, this establishes a many-to-many relationship (e.g., a show with multiple streaming homes):

```graphql
type RealityShow @table @export {
	id: Long @primaryKey
	networkIds: [Long] @indexed
	networks: [Network] @relationship(from: networkIds)
}
```

### `@relationship(to: attribute)` — one-to-many or many-to-many

The foreign key is in the target table, referencing the primary key of this table. The result type must be an array.

```graphql
type Network @table @export {
	id: Long @primaryKey
	name: String @indexed # e.g. "Bravo", "Peacock", "Netflix"
	shows: [RealityShow] @relationship(to: networkId) # one-to-many
	# shows like "Real Housewives of Atlanta", "The Traitors", "Vanderpump Rules"
}
```

### `@relationship(from: attribute, to: attribute)` — foreign key to foreign key

Both `from` and `to` can be specified together to define a relationship where neither side uses the primary key — a foreign key to foreign key join. This is useful for many-to-many relationships that join on non-primary-key attributes.

```graphql
type OrderItem @table @export {
	id: Long @primaryKey
	orderId: Long @indexed
	productSku: Long @indexed
	product: Product @relationship(from: productSku, to: sku) # join on sku, not primary key
}

type Product @table @export {
	id: Long @primaryKey
	sku: Long @indexed
	name: String
}
```

Schemas can also define self-referential relationships, enabling parent-child hierarchies within a single table.

## Computed Properties

<VersionBadge version="v4.4.0" />

The `@computed` directive marks a field as derived from other fields at query time. Computed properties are not stored in the database but are evaluated when the field is accessed.

```graphql
type Product @table {
	id: Long @primaryKey
	price: Float
	taxRate: Float
	totalPrice: Float @computed(from: "price + (price * taxRate)")
}
```

The `from` argument is a JavaScript expression that can reference other record fields.

Computed properties can also be defined in JavaScript for complex logic:

```graphql
type Product @table {
	id: Long @primaryKey
	totalPrice: Float @computed
}
```

```javascript
tables.Product.setComputedAttribute('totalPrice', (record) => {
	return record.price + record.price * record.taxRate;
});
```

Computed properties are not included in query results by default — use `select` to include them explicitly.

### Computed Indexes

Computed properties can be indexed with `@indexed`, enabling custom indexing strategies such as composite indexes, full-text search, or vector indexing:

```graphql
type Product @table {
  id: Long @primaryKey
  tags: String
  tagsSeparated: String[] @computed(from: "tags.split(/\\s*,\\s*/)") @indexed
}
```

When using a JavaScript function for an indexed computed property, use the `version` argument to ensure re-indexing when the function changes:

```graphql
type Product @table {
	id: Long @primaryKey
	totalPrice: Float @computed(version: 1) @indexed
}
```

Increment `version` whenever the computation function changes. Failing to do so can result in an inconsistent index.

## Vector Indexing

<VersionBadge version="v4.6.0" />

Use `@indexed(type: "HNSW")` to create a vector index using the Hierarchical Navigable Small World algorithm, designed for fast approximate nearest-neighbor search on high-dimensional vectors.

```graphql
type Document @table {
	id: Long @primaryKey
	textEmbeddings: [Float] @indexed(type: "HNSW")
}
```

Query by nearest neighbors using the `sort` parameter:

```javascript
let results = Document.search({
	sort: { attribute: 'textEmbeddings', target: searchVector },
	limit: 5,
});
```

HNSW can be combined with filter conditions:

```javascript
let results = Document.search({
	conditions: [{ attribute: 'price', comparator: 'lt', value: 50 }],
	sort: { attribute: 'textEmbeddings', target: searchVector },
	limit: 5,
});
```

### HNSW Parameters

| Parameter              | Default           | Description                                                                                         |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `distance`             | `"cosine"`        | Distance function: `"euclidean"` or `"cosine"` (negative cosine similarity)                         |
| `efConstruction`       | `100`             | Max nodes explored during index construction. Higher = better recall, lower = better performance    |
| `M`                    | `16`              | Preferred connections per graph layer. Higher = more space, better recall for high-dimensional data |
| `optimizeRouting`      | `0.5`             | Heuristic aggressiveness for omitting redundant connections (0 = off, 1 = most aggressive)          |
| `mL`                   | computed from `M` | Normalization factor for level generation                                                           |
| `efSearchConstruction` | `50`              | Max nodes explored during search                                                                    |

Example with custom parameters:

```graphql
type Document @table {
	id: Long @primaryKey
	textEmbeddings: [Float] @indexed(type: "HNSW", distance: "euclidean", optimizeRouting: 0, efSearchConstruction: 100)
}
```

## Field Types

Harper supports the following field types:

| Type      | Description                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------- |
| `String`  | Unicode text, UTF-8 encoded                                                                    |
| `Int`     | 32-bit signed integer (−2,147,483,648 to 2,147,483,647)                                        |
| `Long`    | 54-bit signed integer (−9,007,199,254,740,992 to 9,007,199,254,740,992)                        |
| `Float`   | 64-bit double precision floating point                                                         |
| `BigInt`  | Integer up to ~300 digits. Note: distinct JavaScript type; handle appropriately in custom code |
| `Boolean` | `true` or `false`                                                                              |
| `ID`      | String; indicates a non-human-readable identifier                                              |
| `Any`     | Any primitive, object, or array                                                                |
| `Date`    | JavaScript `Date` object                                                                       |
| `Bytes`   | Binary data as `Buffer` or `Uint8Array`                                                        |
| `Blob`    | Binary large object; designed for streaming content >20KB                                      |

Added `BigInt` in v4.3.0

Added `Blob` in v4.5.0

Arrays of a type are expressed with `[Type]` syntax (e.g., `[Float]` for a vector).

### Blob Type

<VersionBadge version="v4.5.0" />

`Blob` fields are designed for large binary content. Harper's `Blob` type implements the [Web API `Blob` interface](https://developer.mozilla.org/en-US/docs/Web/API/Blob), so all standard `Blob` methods (`.text()`, `.arrayBuffer()`, `.stream()`, `.slice()`) are available. Unlike `Bytes`, blobs are stored separately from the record, support streaming, and do not need to be held entirely in memory. Use `Blob` for content typically larger than 20KB (images, video, audio, large HTML, etc.).

See [Blob usage details](#blob-usage) below.

#### Blob Usage

Declare a blob field:

```graphql
type MyTable @table {
	id: Any! @primaryKey
	data: Blob
}
```

Create and store a blob using [`createBlob()`](./api.md#createblobdata-options):

```javascript
let blob = createBlob(largeBuffer);
await MyTable.put({ id: 'my-record', data: blob });
```

Retrieve blob data using standard Web API `Blob` methods:

```javascript
let record = await MyTable.get('my-record');
let buffer = await record.data.bytes(); // ArrayBuffer
let text = await record.data.text(); // string
let stream = record.data.stream(); // ReadableStream
```

Blobs support asynchronous streaming, meaning a record can reference a blob before it is fully written to storage. Use `saveBeforeCommit: true` to wait for full write before committing:

```javascript
let blob = createBlob(stream, { saveBeforeCommit: true });
await MyTable.put({ id: 'my-record', data: blob });
```

Any string or buffer assigned to a `Blob` field in a `put`, `patch`, or `publish` is automatically coerced to a `Blob`.

When returning a blob via REST, register an error handler to handle interrupted streams:

```javascript
export class MyEndpoint extends MyTable {
	static async get(target) {
		const record = super.get(target);
		let blob = record.data;
		blob.on('error', () => {
			MyTable.invalidate(target);
		});
		return { status: 200, headers: {}, body: blob };
	}
}
```

## Dynamic Schema Behavior

When a table is created through the Operations API or Studio without a schema definition, it follows dynamic schema behavior:

- Attributes are reflexively created as data is ingested
- All top-level attributes are automatically indexed
- Records automatically get `__createdtime__` and `__updatedtime__` audit attributes

Dynamic schema tables are additive — new attributes are added as new data arrives. Existing records will have `null` for any newly added attributes.

Use `create_attribute` and `drop_attribute` operations to manually manage attributes on dynamic schema tables. See the [Operations API](../operations-api/operations.md#databases--tables) for details.

## OpenAPI Specification

Tables exported with `@export` are described via an `/openapi` endpoint on the main HTTP server associated with the REST service (default port 9926).

```http
GET http://localhost:9926/openapi
```

This provides an OpenAPI 3.x description of all exported resource endpoints. The endpoint is a starting guide and may not cover every edge case.

## Renaming Tables

Harper does **not** support renaming tables. Changing a type name in a schema definition creates a new, empty table — the original table and its data are unaffected.

## Related Documentation

- [JavaScript API](./api.md) — `tables`, `databases`, `transaction()`, and `createBlob()` globals for working with schema-defined tables in code
- [Data Loader](./data-loader.md) — Seed tables with initial data alongside schema deployment
- [REST Querying](../rest/querying.md) — Querying tables via HTTP using schema-defined attributes and relationships
- [Resources](../resources/resource-api.md) — Extending table behavior with custom application logic
- [Storage Algorithm](./storage-algorithm.md) — How Harper indexes and stores schema-defined data
- [Configuration](../configuration/options.md) — Component configuration for schemas
