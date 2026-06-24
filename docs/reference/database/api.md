---
title: API
---

<!-- Source: versioned_docs/version-4.7/reference/globals.md (tables, databases globals) -->
<!-- Source: versioned_docs/version-4.7/reference/transactions.md (transaction() function) -->
<!-- Source: versioned_docs/version-4.7/reference/blob.md (createBlob() function) -->

# API

Harper exposes a set of global variables and functions that JavaScript code (in components, applications, and plugins) can use to interact with the database system.

## `tables`

`tables` is an object whose properties are the tables in the default database (`data`). Each table defined in your `schema.graphql` file is available as a property, and the value is the table class that implements the [Resource API](../resources/resource-api.md).

```graphql
# schema.graphql
type Product @table {
	id: Long @primaryKey
	name: String
	price: Float
}
```

```javascript
const { Product } = tables;
// same as: databases.data.Product
```

### Example

```javascript
// Create a new record (id auto-generated)
const created = await Product.create({ name: 'Shirt', price: 9.5 });

// Modify the record
await Product.patch(created.id, { price: Math.round(created.price * 0.8 * 100) / 100 });

// Retrieve by primary key
const record = await Product.get(created.id);

// Query with conditions
const query = {
	conditions: [{ attribute: 'price', comparator: 'less_than', value: 8.0 }],
};
for await (const record of Product.search(query)) {
	// ...
}
```

For the full set of methods available on table classes, see the [Resource API](../resources/resource-api.md).

## `databases`

`databases` is an object whose properties are Harper databases. Each database contains its tables as properties, the same way `tables` does for the default database. In fact, `databases.data === tables` is always true.

Use `databases` when you need to access tables from a non-default database.

### Example

```javascript
const { Product } = databases.data; // default database
const Events = databases.analytics.Events; // another database

// Create an event record
const event = await Events.create({ eventType: 'login', timestamp: Date.now() });

// Query events
for await (const e of Events.search({ conditions: [{ attribute: 'eventType', value: 'login' }] })) {
	// handle each event
}
```

To define tables in a non-default database, use the `database` argument on the `@table` directive in your schema:

```graphql
type Events @table(database: "analytics") {
	id: Long @primaryKey
	eventType: String @indexed
}
```

See [Schema](./schema.md) for full schema definition syntax.

## `transaction(context?, callback)`

`transaction` executes a callback within a database transaction and returns a promise that resolves when the transaction commits. The callback may be async.

```typescript
transaction(context?: object, callback: (txn: Transaction) => any | Promise<any>): Promise<any>
```

For most operations — HTTP request handlers, for example — Harper automatically starts a transaction. Use `transaction()` explicitly when your code runs outside of a natural transaction context, such as in timers or background jobs.

### Basic Usage

```javascript
import { tables } from 'harper';
const { MyTable } = tables;

if (isMainThread) {
	setInterval(async () => {
		let data = await (await fetch('https://example.com/data')).json();
		transaction(async (txn) => {
			for (let item of data) {
				await MyTable.put(item, txn);
			}
		});
	}, 3600000); // every hour
}
```

### Nesting

If `transaction()` is called with a context that already has an active transaction, it reuses that transaction, executes the callback immediately, and returns. This makes `transaction()` safe to call defensively to ensure a transaction is always active.

### Transaction Object

The callback receives a `txn` object with the following members:

| Member                | Type            | Description                                            |
| --------------------- | --------------- | ------------------------------------------------------ |
| `commit()`            | `() => Promise` | Commits the current transaction                        |
| `abort()`             | `() => void`    | Aborts the transaction and resets it                   |
| `resetReadSnapshot()` | `() => void`    | Resets the read snapshot to the latest committed state |
| `timestamp`           | `number`        | Timestamp associated with the current transaction      |

On normal callback completion the transaction is committed automatically. If the callback throws, the transaction is aborted.

### Transaction Scope and Atomicity

Transactions span a single database. All tables within the same database share a single transactional context: reads return a consistent snapshot, and writes across multiple tables are committed atomically. If code accesses tables in different databases, each database gets its own transaction with no cross-database atomicity guarantee.

For deeper background on Harper's transaction model, see [Storage Algorithm](./storage-algorithm.md).

## `createBlob(data, options?)`

<VersionBadge version="v4.5.0" />

`createBlob` creates a [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob) backed by Harper's storage engine. Use it to store large binary content (images, audio, video, large HTML, etc.) in a `Blob`-typed schema field.

```typescript
createBlob(data: Buffer | Uint8Array | ReadableStream | string, options?: BlobOptions): Blob
```

Harper's `Blob` extends the [Web API `Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob), so standard methods (`.text()`, `.arrayBuffer()`, `.stream()`, `.slice()`, `.bytes()`) are all available. Unlike `Bytes`, blobs are stored separately from the record, support streaming, and do not need to fit in memory.

### Basic Usage

Declare a blob field in your schema (see [Schema — Blob Type](./schema.md#blob-type)):

```graphql
type MyTable @table {
	id: Any! @primaryKey
	data: Blob
}
```

Create and store a blob:

```javascript
let blob = createBlob(largeBuffer);
await MyTable.put({ id: 'my-record', data: blob });
```

Retrieve blob data using standard `Blob` methods:

```javascript
let record = await MyTable.get('my-record');
let buffer = await record.data.bytes(); // ArrayBuffer
let text = await record.data.text(); // string
let stream = record.data.stream(); // ReadableStream
```

### Streaming

`createBlob` supports streaming data in as data is streamed out — useful for large media where low-latency transmission from origin is critical:

```javascript
let blob = createBlob(incomingStream);
// blob exists, but data is still streaming to storage
await MyTable.put({ id: 'my-record', data: blob });

let record = await MyTable.get('my-record');
// blob data is accessible as it arrives
let outgoingStream = record.data.stream();
```

Blobs are inherently a streaming API designed to work asynchronously, so they can be referenced before they are fully written and are **not** ACID-compliant by default. Use `saveBeforeCommit: true` to ensure the blob is fully saved before the transaction commits. Even then, a `Blob` is stored alongside the record rather than within it — if you need the data to be a true, ACID-committed part of the record, use a `Bytes` field instead of a `Blob`:

```javascript
let blob = createBlob(stream, { saveBeforeCommit: true });
await MyTable.put({ id: 'my-record', data: blob });
// put() resolves only after blob is fully written and record is committed
```

### `BlobOptions`

| Option             | Type      | Default     | Description                                                                                                                  |
| ------------------ | --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `type`             | `string`  | `undefined` | MIME type to associate with the blob (e.g., `image/jpeg`, `audio/mpeg`). Readable via `blob.type` and used when serving HTTP |
| `size`             | `number`  | `undefined` | Size of the data in bytes, if known ahead of time. Otherwise inferred from a buffer or determined as a stream completes      |
| `saveBeforeCommit` | `boolean` | `false`     | Wait until the blob is fully written before the transaction commits                                                          |
| `compress`         | `boolean` | `false`     | Compress the stored data with deflate                                                                                        |
| `flush`            | `boolean` | `false`     | Flush the file to disk after writing, before the `createBlob` promise chain resolves                                         |

Example with MIME type:

```javascript
let blob = createBlob(imageBuffer, { type: 'image/jpeg' });
await Photo.put({ id, data: blob });
```

### Accepting Binary in JSON Requests

REST clients that can't post raw binary typically send base64 inside JSON. Decode in the resource override and wrap with `createBlob`, recording the MIME type so it round-trips on read:

```typescript
import { type RequestTargetOrId, tables, createBlob } from 'harper';

export class Photo extends tables.Photo {
	static async post(target: RequestTargetOrId, record: any) {
		if (record.data) {
			record.data = createBlob(Buffer.from(record.data, record.encoding || 'base64'), {
				type: record.contentType || 'application/octet-stream',
			});
		}
		return super.post(target, record);
	}
}
```

### Serving Binary from a Resource

Return a response object with the blob's MIME type in headers and the blob itself as the body. Harper will stream it to the client:

```typescript
export class Photo extends tables.Photo {
	static async get(target: RequestTargetOrId) {
		const record = await super.get(target);
		if (record?.data) {
			return {
				status: 200,
				headers: { 'Content-Type': record.data.type || 'application/octet-stream' },
				body: record.data,
			};
		}
		return record;
	}
}
```

### Error Handling

Blobs written from a stream can fail mid-stream after the record is committed. Register an error handler to respond to interrupted writes:

```javascript
export class MyEndpoint extends MyTable {
	static async get(target) {
		const record = await super.get(target);
		let blob = record.data;
		blob.on('error', () => {
			MyTable.invalidate(target);
		});
		return { status: 200, headers: {}, body: blob };
	}
}
```

### `size` Property

Blobs created from a stream may not have `size` available immediately. Listen for the `size` event if you need it:

```javascript
let blob = record.data;
if (blob.size === undefined) {
	blob.on('size', (size) => {
		// called once size is determined
	});
}
```

### Blob Coercion

When a field is typed as `Blob` in the schema, any string or buffer assigned via `put`, `patch`, or `publish` is automatically coerced to a `Blob`. This means plain JSON HTTP bodies and MQTT messages work without manual `createBlob()` calls in most cases.

## Related Documentation

- [Schema](./schema.md) — Defining tables and blob fields
- [Resource API](../resources/resource-api.md) — Full table class method reference
- [Transaction Logging](./transaction.md) — Audit log and transaction log for data change history
- [Configuration](../configuration/options.md) — Blob storage path configuration
