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

| Argument       | Type      | Default                       | Description                                                                 |
| -------------- | --------- | ----------------------------- | --------------------------------------------------------------------------- |
| `table`        | `String`  | type name                     | Override the table name                                                     |
| `database`     | `String`  | `"data"`                      | Database to place the table in                                              |
| `expiration`   | `Int`     | —                             | Seconds until a record goes stale (useful for caching tables)               |
| `eviction`     | `Int`     | `0`                           | Additional seconds after `expiration` before a record is physically removed |
| `scanInterval` | `Int`     | `(expiration + eviction) / 4` | Seconds between eviction scans                                              |
| `replicate`    | `Boolean` | true                          | Enable replication of this table                                            |

**`expiration`, `eviction`, and `scanInterval`**

These three arguments work together to control the full lifecycle of a cached record:

- **`expiration`** — When elapsed, a record is considered _stale_. The next request for a stale record triggers a fetch from the source. The record may still be served while revalidation is in progress.
- **`eviction`** — Additional time after `expiration` before the record is physically removed from the table. Setting `eviction > 0` lets you serve the stale record while revalidation happens and controls how long after expiration the data is kept on disk.
- **`scanInterval`** — How often Harper scans the table for records to evict. Defaults to one quarter of `expiration + eviction`.

You can provide a single `expiration` value and all three behaviors share the same TTL. To tune them independently:

```graphql
# Expire after 5 minutes, evict after 1 hour, scan every 10 minutes
type WeatherCache @table(expiration: 300, eviction: 3300, scanInterval: 600) {
	id: ID @primaryKey
	temperature: Float
}
```

#### How `scanInterval` Determines the Eviction Cycle

`scanInterval` determines fixed clock-aligned times when eviction runs. Harper divides the clock into evenly spaced anchors based on the interval, calculated in the server's local timezone. As a result:

- The server's startup time does not affect when eviction runs.
- Eviction timings are deterministic and timezone-aware.
- For any given configuration, the eviction schedule is the same across restarts and across servers in the same local timezone.

**Example: 1-hour expiration** — default `scanInterval` = 15 minutes (one quarter of `expiration`). Eviction schedule:

```
00:00, 00:15, 00:30, 00:45, 01:00, ...
```

If the server starts at 12:05, the first eviction runs at 12:15 — not 12:20. The schedule is clock-aligned, not startup-aligned.

**Example: 1-day expiration** — default `scanInterval` = 6 hours. Eviction schedule:

```
00:00, 06:00, 12:00, 18:00, ...
```

#### Eviction with Indexing

Eviction removes non-indexed record data, but it does _not_ remove a record from its secondary indexes. If an evicted record matches a search query, Harper fetches the full record from the source on demand to satisfy the query. This means indexes remain fully functional even when most of the data has been evicted.

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

# Disable replication for this table explicitly
type LocalRecord @table(replicate: false) {
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

**Replication:** Replication is enabled by default for all tables. Note that if you disable replication on a table and re-enable it later, it will not catch-up on previous writes during when the replication was disabled.

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

### `@hidden` (Type Directive)

Suppresses the type from introspectable surfaces — MCP tool descriptors and the OpenAPI document. The table still exists; data is still queryable through Harper's other interfaces subject to RBAC. `@hidden` is a **metadata-visibility** directive, not an access-control mechanism: use `attribute_permissions` on roles to control data access.

```graphql
type InternalConfig @table @hidden {
	id: Long @primaryKey
	value: String
}
```

`@hidden` is also available as a [field directive](#hidden-field-directive) to suppress individual attributes.

## Documenting Types and Fields

Harper picks up GraphQL's standard triple-quoted docstrings on type and field definitions. Docstrings flow through to:

- **MCP** — `Table.description` (consumed as a prefix on every verb-tool description) and `inputSchema.properties[*].description` on derived tool schemas
- **OpenAPI** — `components.schemas[*].description`, per-property `description`, and the path-level `description` for every verb on the resource

```graphql
"""
Product catalog row — what shows up in the storefront listing,
search, and inventory feeds. One row per SKU.
"""
type Product @table @export {
	"""
	Stock keeping unit — globally unique across catalogs.
	"""
	sku: String! @primaryKey

	"""
	Display name shown in the storefront.
	"""
	name: String!

	"""
	Retail price in cents (USD).
	"""
	priceCents: Int!
}
```

Docstrings on `@hidden` fields are dropped from the descriptive surfaces alongside the field itself.

> **Trust model.** Docstrings reach LLMs and public OpenAPI consumers verbatim. Treat them as code: don't put secrets, internal-only commentary, or speculative prose in them. Use `@hidden` to suppress fields that shouldn't surface publicly.

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

### `@embed`

<VersionBadge version="v5.1.0" />

Automatically computes an embedding vector for the attribute whenever the source field is written, using a configured [embedding model](../models/overview):

```graphql
type Document @table {
	id: Long @primaryKey
	text: String
	embedding: [Float] @embed(source: "text", model: "default")
}
```

- `source` — the name of the field to embed. Must be a declared field on the same type, passed as a string literal.
- `model` — the logical name of a configured embedding model, passed as a string literal.

The attribute type must be `[Float]`. The attribute is automatically indexed with an [HNSW vector index](#vector-indexing), so it is immediately searchable by similarity; an explicit `@indexed` on the same attribute is allowed only if it is also HNSW.

Write semantics:

- Creating a record with the source field, or updating the source field, computes the vector before the write commits (with `inputType: 'document'`). A failure to compute the embedding fails the write.
- An update that does not touch the source field leaves the vector unchanged.
- Setting the source field to `null` sets the vector to `null`.
- Replicated writes and audit-log replays do not re-embed — the vector travels with the record, and only the node that accepted the original write calls the model.

Multiple `@embed` attributes on one type are computed concurrently.

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

### `@hidden` (Field Directive)

Suppresses the field from MCP tool descriptors and the OpenAPI document. The attribute still exists in the table; data is still queryable through other interfaces subject to RBAC. Use this for fields that should not appear in introspectable surfaces.

```graphql
type Customer @table {
	id: Long @primaryKey
	name: String

	"""
	Internal — do not surface to external consumers.
	"""
	creditScore: Int @hidden
}
```

`@hidden` is a metadata-visibility directive, not access control: `attribute_permissions` on roles remains the data-access enforcement mechanism.

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

Embedding vectors can also be computed automatically at write time from a text field with the [`@embed` directive](#embed), which creates the HNSW index implicitly.

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

<VersionBadge type="changed" version="v5.2.0" /> — Conditions combined with a vector sort are evaluated _during_ graph traversal (predicate-aware search): the search keeps exploring until it has enough _matching_ nearest neighbors, instead of finding the nearest candidates first and then dropping the ones that fail the filter. With a selective filter this is the difference between a full result set and an under-filled one. When a companion condition is very selective, Harper instead computes exact distances over just the records matching that condition, which is both exact and faster than traversing the graph.

### Filtered Vector Search with a Function Predicate

<VersionBadge version="v5.2.0" />

A `vectorFilter` function on the query participates in the traversal the same way, for predicates that are not expressible as conditions:

```javascript
let results = Document.search(
	{
		sort: { attribute: 'textEmbeddings', target: searchVector },
		vectorFilter: (record) => record.tenantId === context.user.tenantId && record.status === 'published',
		limit: 10,
	},
	context
);
```

`vectorFilter` is available from the JavaScript API only (it cannot be expressed in a REST query string). The function receives the candidate record and must return a boolean — `true` to include the record in results, `false` to exclude it (it still routes traversal either way). It must be synchronous, side-effect free, and fast — it can run once per candidate record visited during traversal (verdicts are memoized per query). Records passed to it are frozen.

### Record-Level Access Control (Record-Scoped `allowRead`)

<VersionBadge version="v5.2.0" />

Overriding `allowRead(user, target, context)` on a table resource makes it a **record-scoped** check: during query execution it is evaluated once per record with `this` bound to the record, so row-level logic reads naturally from `this`. For vector queries the check participates in the graph traversal, so a restricted user receives the k nearest records _they are allowed to see_ rather than "nearest k, minus redacted" (which under-fills results and reveals that nearby restricted records exist):

```javascript
export class Reports extends tables.Reports {
	allowRead(user, target, context) {
		// super = the table/RBAC permission check (safe at any scope)
		return super.allowRead(user, target, context) && (user.role.permission.super_user || this.ownerId === user.id);
	}
}
```

How the one definition applies at each scope (when permission checking is active, e.g. any external request):

- **Collection queries** (REST collection `GET`, `search()`, including vector sorts) — evaluated per record; rows failing the check are filtered out of results. The default (non-overridden) `allowRead` is a table-level RBAC check and continues to run once at request entry with no per-record cost.
- **Single-record `get(id)`** — evaluated at request entry with the record loaded (attribute reads like `this.ownerId` resolve against the record); a denied record returns a 403.
- **Subscriptions** — a record-scoped override currently fails closed at subscribe time (per-event delivery checks are a planned follow-up).

Constraints: the check must be synchronous, side-effect free, and fast — it can run once per candidate record visited during traversal (verdicts are memoized per query). `this` is the frozen record during per-record evaluation. A thrown exception denies that record (fail closed). On caching tables the check is enforced against the record actually returned, after any source revalidation.

### Tuning Filtered Traversal

Filtered traversal is bounded by a visit budget of `ef * filterExpansion` nodes (`filterExpansion` defaults to 24). If the budget is exhausted before the result list fills — which happens when the filter matches only a tiny fraction of records — the search returns the matches found so far rather than erroring. Both knobs can be set per query:

```javascript
let results = Document.search(
	{
		sort: { attribute: 'textEmbeddings', target: searchVector, ef: 200, filterExpansion: 40 },
		vectorFilter: (record) => record.category === 'rare',
		limit: 10,
	},
	context
);
```

Raise `filterExpansion` (or `ef`) to trade latency for recall under selective function predicates. Condition-based filters rarely need tuning: very selective conditions are automatically diverted to the exact-scan strategy instead of graph traversal.

### Filtering by Distance Threshold

To return only records whose distance to a target vector is below a threshold, place `target` directly on the condition (alongside `comparator` and `value`). This returns matches within the threshold without using `sort`:

```javascript
let results = Document.search({
	conditions: {
		attribute: 'textEmbeddings',
		comparator: 'lt',
		value: 0.1,
		target: searchVector,
	},
});
```

This form is useful when you want to bound result quality by a similarity cutoff rather than ranking by similarity.

### Selecting the Distance

Use the special `$distance` field in `select` to include the computed distance from the target vector in returned records:

```javascript
let results = Document.search({
	select: ['name', '$distance'],
	sort: { attribute: 'textEmbeddings', target: searchVector },
	limit: 5,
});
```

`$distance` is available in both `sort`-based ranking and `conditions`-based threshold queries.

### Per-Query Search Options

The `sort` descriptor (and threshold condition) accepts options that tune an individual query:

```javascript
let results = Document.search({
	sort: { attribute: 'textEmbeddings', target: searchVector, distance: 'dotProduct', ef: 200 },
	limit: 5,
});
```

- `distance` — overrides the index's distance function for this query: `"cosine"`, `"euclidean"`, or `"dotProduct"` (`dotProduct` <VersionBadge version="v5.1.0" />).
- `ef` <VersionBadge version="v5.1.0" /> — overrides the search exploration budget for this query. Higher values improve recall at the cost of latency.

<VersionBadge type="changed" version="v5.1.0" /> — When a query passes no `ef` and the index does not explicitly configure `efConstructionSearch` (or `efConstruction`), the search budget auto-scales with the size of the index, so recall holds as the table grows instead of decaying with a fixed budget.

### HNSW Parameters

| Parameter              | Default           | Description                                                                                                                                              |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distance`             | `"cosine"`        | Distance function: `"cosine"` (negative cosine similarity), `"euclidean"`, or `"dotProduct"` (added in v5.1.0)                                           |
| `efConstruction`       | `100`             | Max nodes explored during index construction. Higher = better recall, lower = better performance                                                         |
| `M`                    | `16`              | Preferred connections per graph layer. Higher = more space, better recall for high-dimensional data                                                      |
| `optimizeRouting`      | `0.5`             | Heuristic aggressiveness for omitting redundant connections (0 = off, 1 = most aggressive)                                                               |
| `mL`                   | computed from `M` | Normalization factor for level generation                                                                                                                |
| `efConstructionSearch` | auto-scaled       | Max nodes explored during search. When unset, auto-scales with index size (see above); setting it (or `efConstruction`, which seeds it) fixes the budget |
| `quantization`         | —                 | `"int8"` stores vectors quantized to int8 (added in v5.1.0, see below)                                                                                   |
| `filterExpansion`      | `24`              | Visit-budget multiplier for filtered (predicate-aware) search: a filtered query visits at most `ef * filterExpansion` nodes (added in v5.2.0, see above) |

Example with custom parameters:

```graphql
type Document @table {
	id: Long @primaryKey
	textEmbeddings: [Float] @indexed(type: "HNSW", distance: "euclidean", optimizeRouting: 0, efConstructionSearch: 100)
}
```

Note: this parameter was previously documented as `efSearchConstruction`; the option name Harper reads is `efConstructionSearch`.

<VersionBadge type="changed" version="v5.1.0" /> — Changing `efConstructionSearch` on an existing index no longer triggers a rebuild; it only affects searches. Structural parameters (`distance`, `M`, `efConstruction`, `quantization`) still rebuild the index when changed.

### Vector Quantization

<VersionBadge version="v5.1.0" />

`quantization: "int8"` stores the index's vectors quantized to 8-bit integers, substantially reducing index size and memory traffic:

```graphql
type Document @table {
	id: Long @primaryKey
	textEmbeddings: [Float] @indexed(type: "HNSW", quantization: "int8")
}
```

Graph navigation runs on the quantized (approximate) distances. For nearest-neighbor `sort` queries, Harper re-ranks the results against the full-precision vectors stored on the records, restoring exact ordering and exact `$distance` values. Distance-threshold (`lt`/`le`) queries currently filter on the approximate distance.

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

### Large integers: `Long` vs `BigInt`

Despite the name, `Long` is bounded by the JavaScript safe-integer range — values must satisfy `|value| < 2^53` (9,007,199,254,740,991, i.e. `Number.MAX_SAFE_INTEGER`). A `Long` attribute rejects integers beyond that range, so it is not a full 64-bit type.

For true 64-bit integers — IDs, counters, or timestamps that can exceed 2^53 — use `BigInt`, and send the value as an actual bigint (for example, via CBOR or MessagePack) rather than a JSON number. A JSON number above 2^53 has already lost precision before Harper receives it, so the larger value cannot be recovered. `BigInt` attributes, including `@indexed` range queries, store and order distinct values above 2^53 correctly.

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
