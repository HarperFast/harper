---
title: Resource API
---

<!-- Source: versioned_docs/version-4.7/reference/resources/index.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/resources/instance-binding.md (legacy V1 behavior) -->
<!-- Source: versioned_docs/version-4.7/reference/resources/migration.md (migration examples) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (Resource API introduction) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (CRDT support) -->
<!-- Source: release-notes/v4-tucker/4.4.0.md (Response object, computed properties) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (property forwarding, Table.getRecordCount) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (Resource API V2 upgrades) -->

# Resource API

<VersionBadge version="v4.2.0" />

The Resource API provides a unified JavaScript interface for accessing, querying, modifying, and subscribing to data resources in Harper. Tables extend the base `Resource` class, and all resource interactions — whether from HTTP requests, MQTT messages, or application code — flow through this interface.

A Resource class represents a collection of entities/records with methods for querying and accessing records and inserting/updating records. Instances of a Resource class represent a single record that can be modified through various methods or queries. A Resource instance holds the primary key/identifier and any pending updates to the record, so any instance methods can act on the record and have full access to this information during execution.

Resource classes have static methods that directly map to RESTful methods or HTTP verbs (`get`, `put`, `patch`, `post`, `delete`), which can be called to interact with records, with general create, read, update, and delete capabilities. And these static methods can be overridden for defining custom API endpoint handling.

## Resource Static Methods

Static methods are defined on a Resource class and called when requests are routed to the resource. This is the preferred way to interact with tables and resources from application code. You can override these methods to define custom behavior for these methods and for HTTP requests.

### `get(target: RequestTarget | Id, context?: Resource | Context): Promise<object> | ExtendedIterable`

This can be called to retrieve a record by primary key.

```javascript
// By primary key
const product = await Product.get(34);
```

The default `get` method returns a `RecordObject` — a frozen plain object with the record's properties plus `getUpdatedTime()` and `getExpiresAt()`. The record object is immutable because it represents the current state of the record in the database.

`get` is also called for HTTP GET requests and is always called with a `RequestTarget` as the `target` parameter. When the request targets a single record (e.g. `/Table/some-id`), the default `get` returns a single record object. When the request targets a collection (e.g. `/Table/?name=value`), the `target.isCollection` property is `true` and the default behavior calls `search()`, returning an `ExtendedIterable`.

```javascript
class MyResource extends Resource {
	static get(target) {
		const id = target.id; // primary key from URL path
		const param = target.get('param1'); // query string param
		const path = target.pathname; // path relative to resource
		return super.get(target); // default: return the record
	}
}
```

Again, the default `get` method (available through `super.get()` inside the `get` method) returns a frozen object. If you want a modified object from this record, you can copy the record and change properties. This is most conveniently done with the spread operator:

```javascript
	static async get(target) {
		const record = await super.get(target);
		const alteredRecord = { ...record, changedProperty: 'value' };
		return alteredRecord;
	}
```

The return value of `get` method on a `Table` is a `RecordObject`, which has the full state of the record as properties.

#### RecordObject

The `get()` method returns a `RecordObject` — a frozen plain object with all record properties, plus:

- `getUpdatedTime(): number` — Last updated time (milliseconds since epoch)
- `getExpiresAt(): number` — Expiration time, if set

---

### `search(query: RequestTarget): ExtendedIterable`

`search` performs a query on the resource or table. This is called by `get()` on collection requests and can be overridden to define custom query behavior. The default implementation on tables queries by the `conditions`, `limit`, `offset`, `select`, and `sort` properties parsed from the URL. See [Query Object](#query-object) below for available query options. See the [ExtendedIterable](#extendediterable) below for how to interact with the query results.

### `put(target: RequestTarget | Id, data: Promise<object>, context?: Resource | Context): Promise<void> | Response`

This writes the full record to the table, creating or replacing the existing record. This does _not_ merge the `data` into the existing record, but replaces it with the new data.

```javascript
await Product.put(34, { name: 'New Product Name' });
```

This is called for HTTP PUT requests, and can be overridden to implement a custom `PUT` handler. For example:

```javascript
class MyResource extends Resource {
	static async put(target, data) {
		// validate or transform before saving
		return super.put(target, { ...(await data), status: data.status ?? 'active' });
	}
}
```

### `put(data: object): Promise<void> | Response`

The `put` method can also be called directly with a plain object/record, and it will write the record to the table if it has a primary key defined in the object.

```javascript
await Product.put({ id: 34, name: 'New Product Name' });
```

### `patch(target: RequestTarget | Id, data: Promise<object>, context?: Resource | Context): Promise<void> | Response`

This writes a partial record to the table, creating or updating the existing record. This merges the `data` into the existing record.

```javascript
await Product.patch(34, { description: 'Updated description' });
```

This is called for HTTP PATCH requests, and can be overridden to implement a custom `PATCH` handler. For example:

```javascript
class MyResource extends Resource {
	static async patch(target, data) {
		// validate or transform before saving
		return super.patch(target, { ...(await data), status: data.status ?? 'active' });
	}
}
```

<VersionBadge version="v4.3.0" /> (CRDT support for individual property updates via PATCH)

### `post(target: RequestTarget, data: Promise<object>, context?: Resource | Context): Promise<void> | Response`

This is called for HTTP POST requests. The default behavior creates a new record, but it can overridden to implement custom actions:

```javascript
class MyResource extends Resource {
	static async post(target, promisedData) {
		let data = await promisedData;
		if (data.action === 'create') {
			// create a new record
			return this.create(target, data.content);
		} else if (data.action === 'update') {
			// update the referenced record
			let resource = await this.update(target);
			resource.set('status', data.status);
			resource.save();
		}
	}
}
```

It is not recommended to call `post` directly, and prefer more explicit methods like `create()` or `update()`.

### `delete(target: RequestTarget | Id): void | Response`

This deletes a record from the table.

```javascript
await Product.delete(34);
```

This is called for HTTP DELETE requests, and can be overridden to implement a custom `DELETE` handler. For example:

```javascript
class MyResource extends Resource {
	static async delete(target) {
		// validate or transform before deleting
		return super.delete(target);
	}
}
```

### `publish(target: RequestTarget, message: object, context?: Resource | Context): void | Response`

This is called to publish a message. Messages can be published through tables, using the same primary key structure as records.

```javascript
await Product.publish(34, { event: 'product-purchased', purchasePrice: 100 });
```

This is called for MQTT publish commands. The default behavior records the message and notifies subscribers without changing the record's stored data. This can be overridden to implement custom message handling.

### `subscribe(subscriptionRequest?: SubscriptionRequest): Promise<Subscription>`

Called for MQTT subscribe commands. Returns a `Subscription` — an `AsyncIterable` of messages/changes.

#### `SubscriptionRequest` options

All properties are optional:

| Property             | Description                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `includeDescendants` | Include all updates with an id prefixed by the subscribed id (e.g. `sub/*`)                    |
| `startTime`          | Start from a past time (catch-up of historical messages). Cannot be used with `previousCount`. |
| `previousCount`      | Return the last N updates/messages. Cannot be used with `startTime`.                           |
| `omitCurrent`        | Do not send the current/retained record as the first update.                                   |

### `connect(target: RequestTarget, incomingMessages?: AsyncIterable): AsyncIterable`

Called for WebSocket and Server-Sent Events connections. `incomingMessages` is provided for WebSocket connections (not SSE). Returns an `AsyncIterable` of messages to send to the client.

### `invalidate(target: RequestTarget)`

Marks the specified record as invalid in a caching table, so it will be reloaded from the source on next access.

### `allowStaleWhileRevalidate(entry, id): boolean`

For caching tables: return `true` to serve the stale entry while revalidation happens concurrently; `false` to wait for the fresh value.

Entry properties:

- `version` — Timestamp/version from the source
- `localTime` — When the resource was last refreshed locally
- `expiresAt` — When the entry became stale
- `value` — The stale record value

### `getUpdatedTime(): number`

Returns the last updated time of the resource (milliseconds since epoch).

### `wasLoadedFromSource(): boolean`

For caching tables, indicates that this request was a cache miss and the data was loaded from the source resource.

### `getContext(): Context`

Returns the current context, which includes:

- `user` — User object with username, role, and authorization information
- `transaction` — The current transaction

When triggered by HTTP, the context is the `Request` object with these additional properties:

- `url` — Full local path including query string
- `method` — HTTP method
- `headers` — Request headers (access with `context.headers.get(name)`)
- `responseHeaders` — Response headers (set with `context.responseHeaders.set(name, value)`)
- `pathname` — Path without query string
- `host` — Host from the `Host` header
- `ip` — Client IP address
- `body` — Raw Node.js `Readable` stream (if a request body exists)
- `data` — Promise resolving to the deserialized request body
- `lastModified` — Controls the `ETag`/`Last-Modified` response header
- `requestContext` — (For source resources only) Context of the upstream resource making the data request

### `operation(operationObject: object, authorize?: boolean): Promise<any>`

Executes a Harper operations API call using this table as the target. Set `authorize` to `true` to enforce current-user authorization.

---

## Resource Static Methods

Static methods are the preferred way to interact with tables and resources from application code. They handle transaction setup, access checks, and request parsing automatically.

All instance methods have static equivalents that accept an `id` or `RequestTarget` as the first argument:

### `get(target: RequestTarget | Id | Query, context?: Resource | Context)`

Retrieve a record by primary key, or query for records.

```javascript
// By primary key
const product = await Product.get(34);

// By query object
const product = await Product.get({ id: 34, select: ['name', 'price'] });

// Iterate a collection query
for await (const record of Product.get({ conditions: [{ attribute: 'inStock', value: true }] })) {
	// ...
}
```

### `put(target: RequestTarget | Id, record: object, context?): Promise<void>`

### `put(record: object, context?): Promise<void>`

Save a record (create or replace). The second form reads the primary key from the `record` object.

### `create(record: object, context?): Promise<Resource>`

Create a new record with an auto-generated primary key. Returns the created record. Do not include a primary key in the `record` argument.

<VersionBadge version="v4.2.0" />

### `patch(target: RequestTarget | Id, updates: object, context?): Promise<void>`

Apply partial updates to an existing record.

### `post(target: RequestTarget | Id, data: object, context?): Promise<any>`

Call the `post` instance method. Defaults to creating a new record.

### `delete(target: RequestTarget | Id, context?): Promise<void>`

Delete a record.

### `publish(target: RequestTarget | Id, message: object, context?): Promise<void>`

Publish a message to a record/topic.

### `subscribe(subscriptionRequest?, context?): Promise<Subscription>`

Subscribe to record changes or messages.

### `search(query: RequestTarget | Query, context?): ExtendedIterable`

Query the table. See [Query Object](#query-object) below for available query options.

### `setComputedAttribute(name: string, computeFunction: (record) => any)`

Define the compute function for a `@computed` schema attribute.

<VersionBadge version="v4.4.0" />

```javascript
MyTable.setComputedAttribute('fullName', (record) => `${record.firstName} ${record.lastName}`);
```

### `getRecordCount({ exactCount?: boolean }): Promise<{ recordCount: number, estimatedRange?: [number, number] }>`

Returns the number of records in the table. By default returns an approximate (fast) count. Pass `{ exactCount: true }` for a precise count.

<VersionBadge version="v4.2.0" />

### `sourcedFrom(Resource, options?)`

Configure a table to use another resource as its data source. When a record is not found locally or has expired, it is fetched from the source and cached. Writes to the table are optionally delegated to the source if the source implements `put`, `patch`, or `delete`.

```javascript
tables.MyCache.sourcedFrom(MyDataSource);
```

Options (all optional; prefer setting these via `@table` schema directives):

| Option         | Description                                      |
| -------------- | ------------------------------------------------ |
| `expiration`   | Seconds until a record goes stale                |
| `eviction`     | Seconds after expiration before physical removal |
| `scanInterval` | Seconds between eviction scans                   |

Harper automatically serializes concurrent requests for the same missing or stale record — all waiting requests share a single upstream fetch, preventing cache stampedes.

#### Source `get` — controlling timestamp and expiration

Inside a source `get()` method, the context (`this.getContext()`) exposes caching-specific properties:

```javascript
class MySource extends Resource {
	async get() {
		const context = this.getContext();

		// Pass If-Modified-Since to origin using the existing cached version
		const headers = new Headers();
		if (context.replacingVersion) {
			headers.set('If-Modified-Since', new Date(context.replacingVersion).toUTCString());
		}

		const response = await fetch(`https://api.example.com/${this.getId()}`, { headers });

		// Propagate the origin's Last-Modified timestamp to Harper's ETag
		context.lastModified = response.headers.get('Last-Modified');

		// Honor origin's Cache-Control max-age for per-record TTL
		const maxAge = response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1];
		if (maxAge) {
			context.expiresAt = Date.now() + Number(maxAge) * 1000;
		}

		// Return origin's 304 as a cache revalidation (no re-download)
		if (response.status === 304) return context.replacingRecord;

		return response.json();
	}
}
```

Context properties available inside a source `get()`:

| Property           | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `replacingVersion` | Timestamp of the currently cached record being replaced (useful for `If-Modified-Since`)      |
| `replacingRecord`  | The currently cached record value (return this on a 304 to skip a re-download)                |
| `lastModified`     | Set this to propagate the origin's timestamp as Harper's `ETag` / `Last-Modified`             |
| `expiresAt`        | Set this (milliseconds epoch) to give the record a per-entry TTL overriding the table default |

#### Source `subscribe` — active caching

For data sources that can push change notifications, implement a `subscribe` method returning an async iterable of events. Harper calls `subscribe` once per process and propagates updates to the cache automatically — no polling needed.

```javascript
class MySource extends Resource {
	async *subscribe() {
		// Option A: async generator
		const stream = connectToExternalEventStream();
		for await (const event of stream) {
			yield {
				type: 'put', // 'put' | 'invalidate' | 'delete' | 'message' | 'transaction'
				id: event.id,
				value: event.data,
				timestamp: event.ts,
			};
		}
	}
}
```

Alternatively, use the default subscription stream to push events from a callback-based source:

```javascript
class MySource extends Resource {
	subscribe() {
		const subscription = super.subscribe();
		remoteClient.on('update', (event) => {
			subscription.send({ type: 'put', id: event.id, value: event.data });
		});
		return subscription;
	}
}
```

**Supported event types:**

| Type          | Description                                                                        |
| ------------- | ---------------------------------------------------------------------------------- |
| `put`         | Record updated — `value` contains the new record                                   |
| `invalidate`  | Record changed but value not provided — cache evicts and re-fetches on next access |
| `delete`      | Record deleted                                                                     |
| `message`     | Pub/sub message passing through the record; record data is not changed             |
| `transaction` | Atomic group of writes; include an array of events in the `writes` property        |

**Event properties:**

| Property    | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `type`      | Event type (see above)                                            |
| `id`        | Primary key of the affected record                                |
| `value`     | New record value (for `put` and `message`)                        |
| `writes`    | Array of events for `transaction` events                          |
| `table`     | Target table name (for cross-table writes inside a `transaction`) |
| `timestamp` | Timestamp of the change                                           |

By default, `subscribe` runs on a single thread to avoid duplicate notifications and race conditions. To run on multiple threads:

```javascript
class MySource extends Resource {
	static subscribeOnThisThread(threadIndex) {
		return threadIndex < 2; // run on first two threads only
	}
	async *subscribe() { ... }
}
```

#### Write-through caching

If the source implements `put`, `patch`, or `delete`, writes to the caching table are forwarded to the source before being committed locally:

```javascript
class MySource extends Resource {
	async get() { ... }

	async put(data) {
		await fetch(`https://api.example.com/${this.getId()}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(await data),
		});
	}

	async delete() {
		await fetch(`https://api.example.com/${this.getId()}`, { method: 'DELETE' });
	}
}
```

Harper waits for the source to confirm the write before committing to the local cache (two-phase write).

**Loading from source in write methods:** Methods other than `get()` do not automatically load data from the source. Call `ensureLoaded()` first if you need the existing record:

```javascript
class MyCache extends tables.MyCache {
	async post(data) {
		await this.ensureLoaded(); // loads from source if not cached
		this.quantity = this.quantity - (await data).purchases;
	}
}
```

#### Passive-active updates

A source `get()` can proactively populate _other_ tables as a side effect, atomically with the main record. Pass `this` (the current context) to any write call to include it in the same transaction:

```javascript
const { Post, Comment } = tables;
class BlogSource extends Resource {
	async get() {
		const post = await (await fetch(`https://my-blog/${this.getId()}`)).json();
		for (const comment of post.comments) {
			await Comment.put(comment, this); // atomic with the Post write
		}
		return post;
	}
}
Post.sourcedFrom(BlogSource);
```

### `primaryKey`

The name of the primary key attribute for the table.

### `operation(operationObject: object, authorize?: boolean): Promise<any>`

Executes a Harper operations API call using this table as the target. Set `authorize` to `true` to enforce current-user authorization.

---

### `update(target: RequestTarget, updates?: object): Promise<Resource>`

This returns a promise to an instance of the Resource class that can be updated and saved. This has mutable property access to a record. Any property changes on the instance are written to the table when the transaction commits. This is primary method for getting an instance of a Resource and accessing all of the Resource instance methods.

## Resource Instance Methods

A Resource instance is used to update and interact with a single record/resource. It provides functionality for updating properties, accessing property values, and managing record lifecycle. The Resource instance is normally retrieved from the static `update()` method. An instance from a table has updatable properties that can used to access and update individual properties (for properties declared in the table's schema), as well methods for more advanced updates and saving data. For example:

```javascript
const product = await Product.update(32);
product.status = 'active'; // we can directly change properties on the updatable record, if they are declared in the schema
product.subtractFrom('quantity', 1); // We can use CRDT incrementation/decrementation to safely update the quantity
product.save();
```

### `save()`

This saves the current state of the resource to the database in the current transaction. This method can be called after making changes to the resource to ensure that those changes have been saved to the current transaction and can be queried within the same transaction. Any pending changes are automatically saved when the transaction commits (if `save()` has not already saved them).

This method only saves data when using RocksDB storage engine, and is a no-op when using LMDB.

### `addTo(property: string, value: number)`

Adds `value` to `property` using CRDT incrementation — safe for concurrent updates across threads and nodes.

<VersionBadge version="v4.3.0" />

```javascript
static async post(target, data) {
	const record = await this.update(target.id);
	record.addTo('quantity', -1); // decrement safely across nodes
}
// GET /MyTable/test?foo=bar → primary key is 'test?foo=bar'
```

### `subtractFrom(property: string, value: number)`

Subtracts `value` from `property` using CRDT incrementation.

### `set(property: string, value: any): void`

Sets a property to `value`. Equivalent to direct property assignment (`record.property = value`), but can be used when the property name is dynamic and not declared in the schema.

```javascript
const record = await Table.update(target.id);
record.set('status', 'active');
record.save();
```

### `put(record: object): void`

This replaces the current record data in the instance with the provided `record` object.

### `patch(record: object): void`

This merges the provided `record` object into the current record data for the instance.

### `validate(record: object, partial?: boolean): void`

This validates the provided `record` object against the schema, throwing an error if validation fails. If `partial` is true, only validates the provided properties, otherwise validates all required properties. This can be overridden to implement custom validation logic. This is called at the beginning of a transaction commit, prior to writing data to the transaction and fully committing it.

### `publish(message: object): void`

This publishes a message to the current instance's primary key.

### `invalidate(): void`

This invalidates the current instance's record in a caching table, forcing it to be reloaded from the source on next access.

### `getId(): Id`

Returns the primary key of the current instance.

### `getProperty(property: string): any`

Returns the current value of `property` from the record. Useful when the property name is dynamic or when you want an explicit read rather than direct property access.

```javascript
const record = await Table.update(target.id);
const current = record.getProperty('status');
```

### `getUpdatedTime(): number`

Returns the last updated time as milliseconds since epoch.

### `getExpiresAt(): number`

Returns the expiration time, if one is set.

### `allowStaleWhileRevalidate(entry, id): boolean`

For caching tables: return `true` to serve the stale entry while revalidation happens concurrently; `false` to wait for the fresh value.

Entry properties:

- `version` — Timestamp/version from the source
- `localTime` — When the resource was last refreshed locally
- `expiresAt` — When the entry became stale
- `value` — The stale record value

The following instances are also implemented on Resource instances for [backwards compatibility with 4.x](../../reference_versioned_docs/version-v4/resources/resource-api.md), but generally not necessary to directly use:

- `get`
- `search`
- `post`
- `create`
- `subscribe`

## Query Object

The `Query` object is accepted by `search()` and the static `get()` method.

### `conditions`

Array of condition objects to filter records. Each condition:

| Property     | Description                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attribute`  | Property name, or an array for chained/joined properties (e.g. `['brand', 'name']`)                                                                      |
| `value`      | The value to match                                                                                                                                       |
| `comparator` | `equals` (default), `greater_than`, `greater_than_equal`, `less_than`, `less_than_equal`, `starts_with`, `contains`, `ends_with`, `between`, `not_equal` |
| `conditions` | Nested conditions array                                                                                                                                  |
| `operator`   | `and` (default) or `or` for the nested `conditions`                                                                                                      |

Example with nested conditions:

```javascript
Product.search({
	conditions: [
		{ attribute: 'price', comparator: 'less_than', value: 100 },
		{
			operator: 'or',
			conditions: [
				{ attribute: 'rating', comparator: 'greater_than', value: 4 },
				{ attribute: 'featured', value: true },
			],
		},
	],
});
```

**Chained attribute references** (for relationships/joins): Use an array to traverse relationship properties:

```javascript
Product.search({ conditions: [{ attribute: ['brand', 'name'], value: 'Harper' }] });
```

<VersionBadge version="v4.3.0" />

### `operator`

Top-level `and` (default) or `or` for the `conditions` array.

### `limit`

Maximum number of records to return.

### `offset`

Number of records to skip (for pagination).

### `select`

Properties to include in each returned record. Can be:

- Array of property names: `['name', 'price']`
- Nested select for related records: `[{ name: 'brand', select: ['id', 'name'] }]`
- String to return a single property per record: `'id'`

Special properties:

- `$id` — Returns the primary key regardless of its name
- `$updatedtime` — Returns the last-updated timestamp

### `sort`

Sort order object:

| Property     | Description                                                |
| ------------ | ---------------------------------------------------------- |
| `attribute`  | Property name (or array for chained relationship property) |
| `descending` | Sort descending if `true` (default: `false`)               |
| `next`       | Secondary sort to resolve ties (same structure)            |

### `explain`

If `true`, returns conditions reordered as Harper will execute them (for debugging and optimization).

### `enforceExecutionOrder`

If `true`, forces conditions to execute in the order supplied, disabling Harper's automatic re-ordering optimization.

---

## RequestTarget

`RequestTarget` represents a URL path mapped to a resource. It is a subclass of `URLSearchParams`.

Properties:

- `pathname` — Path relative to the resource, without query string
- `search` — The query/search string portion of the URL
- `id` — Primary key derived from the path
- `isCollection` — `true` when the request targets a collection
- `checkPermission` — Set to indicate authorization should be performed; has `action`, `resource`, and `user` sub-properties

Standard `URLSearchParams` methods are available:

- `get(name)`, `getAll(name)`, `set(name, value)`, `append(name, value)`, `delete(name)`, `has(name)`
- Iterable: `for (const [name, value] of target) { ... }`

When a URL uses Harper's extended query syntax, these are parsed onto the target:

- `conditions`, `limit`, `offset`, `sort`, `select`

---

## RecordObject

The `get()` method returns a `RecordObject` — a frozen plain object with all record properties, plus:

- `getUpdatedTime(): number` — Last updated time (milliseconds since epoch)
- `getExpiresAt(): number` — Expiration time, if set

---

## ExtendedIterable

The `ExtendedIterable` extends and behaves like an `AsyncIterable`, but also includes a set of array-like methods:

- `map`: Returns a new `ExtendedIterable` with the results of calling a provided function on every element in the calling `ExtendedIterable` (lazily evaluated as the iterable is consumed).
- `filter`: Returns a new `ExtendedIterable` with the elements that pass the test implemented by the provided function (lazily evaluated as the iterable is consumed).
- `flatMap`: Returns a new `ExtendedIterable` with the results of calling a provided function on every element in the calling `ExtendedIterable` and then flattening the result by one-level (lazily evaluated as the iterable is consumed).
- `concat`: Returns a new `ExtendedIterable` that contains the elements of the calling `ExtendedIterable` followed by the elements of the iterable passed as an argument (lazily evaluated as the iterable is consumed).
- `forEach`: Iterates the `ExtendedIterable`, calling the provided function once per element. This is executed eagerly/immediately.
- `slice`: Returns a new `ExtendedIterable` containing a subset of the elements of the calling `ExtendedIterable` (lazily evaluated as the iterable is consumed).
- `mapError`: Returns a new `ExtendedIterable` with that matches the calling `ExtendedIterable`, but maps any element evaluation that throws an error (lazily evaluated as the iterable is consumed) to a new value.

These methods are intended to allow you to easily interact with the results of search queries, without having to convert the `ExtendedIterable` to an array. Generally, converting results to an array is discouraged because it can consume a excessive memory for large results, and undermines Harper's efficient iteration/streaming system. For example, you might write a `get` method like:

```javascript
static async function get(target) {
	const records = this.search(target);
	// we can filter records here
	const filteredRecords = records.map((record) => record.quantity > 100);
	// we can map to new values
	const mappedRecords = filteredRecords.map((record) => ({ ...record, extraProperty: 'value' }));
	// we never converted this to an array, large results can efficiently to be streamed to the client
	return mappedRecords;
}
```

If we do want to iterate the results within a function using a for-loop, you can use the `for await` syntax:

```javascript
for await (const record of records) {
	if (record.name === 'I found what I was looking for') {
		return record;
	}
}
```

(but again, using a for-loop to convert to an array is discouraged)

See the [ExtendedIterable documentation](https://github.com/harperfast/extended-iterable) for more details.

## Response Object

Resource methods can return:

1. **Plain data** — serialized using content negotiation
2. **`Response`-like object** with `status`, `headers`, and `data` or `body`:

```javascript
// Redirect
return { status: 302, headers: { Location: '/new-location' } };

// Custom header with data
return { status: 200, headers: { 'X-Custom-Header': 'value' }, data: { message: 'ok' } };
```

`body` must be a string, `Buffer`, Node.js stream, or `ReadableStream`. `data` is an object that will be serialized.

<VersionBadge version="v4.4.0" />

### Throwing Errors

Uncaught errors are caught by the protocol handler. For REST, they produce error responses. Set `error.statusCode` to control the HTTP status:

```javascript
if (!authorized) {
	const error = new Error('Forbidden');
	error.statusCode = 403;
	throw error;
}
```

---

## Context and Transactions

Harper's HTTP/REST request handler automatically starts a transaction for each request, and assigns the `Request` object as the current context. The current context is available via `getContext()` as export from the `harper` module, or as a global variable. All database interactions that are called from the request will automatically use that transaction, for reading and writing data. Transactions and context are tracking using [asynchronous context tracking](https://nodejs.org/dist/latest/docs/api/async_context.html).

However, you can explicitly create transactions to control the scope of atomicity and isolation. Transactions are created with the `transaction()` method, which establishes a transaction and context that are used for all subsequent database operations within the asynchronous context of the transaction. For example:

```javascript
import { transaction } from 'harper';

function receivedShipment(products) {
	let myContext = {};
	trasaction(myContext, async () => {
		for (let received of products) {
			let product = await Product.update(received.productId);
			product.addTo('quantity', received.quantity);
		}
	}); // all the product updates will be atomically commmited in this transaction
}
```

See [Global APIs — transaction](../components/javascript-environment.md#transaction) for more information on starting transactions outside of request handlers.

---

### `getContext(): Context`

getContext is availabe as export from the `harper` module, or as a global variable, and returns the current context, which includes:

- `user` — User object with username, role, and authorization information
- `transaction` — The current transaction

When triggered by HTTP, the context is the `Request` object with these additional properties:

- `url` — Full local path including query string
- `method` — HTTP method
- `headers` — Request headers (access with `context.headers.get(name)`)
- `responseHeaders` — Response headers (set with `context.responseHeaders.set(name, value)`)
- `pathname` — Path without query string
- `host` — Host from the `Host` header
- `ip` — Client IP address
- `body` — Raw Node.js `Readable` stream (if a request body exists)
- `data` — Promise resolving to the deserialized request body
- `lastModified` — Controls the `ETag`/`Last-Modified` response header
- `requestContext` — (For source resources only) Context of the upstream resource making the data request
