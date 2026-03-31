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

## API Versions

The Resource API has two behavioral modes selected by the `loadAsInstance` static property:

| Version      | `loadAsInstance` | Status                                |
| ------------ | ---------------- | ------------------------------------- |
| V2 (current) | `false`          | Recommended for new code              |
| V1 (legacy)  | `true` (default) | Preserved for backwards compatibility |

The default value of `loadAsInstance` is `true` (V1 behavior). To opt in to V2, you must explicitly set `static loadAsInstance = false` on your resource class.

This page documents V2 behavior (`loadAsInstance = false`). For V1 (legacy instance binding) behavior and migration examples, see [Legacy Instance Binding](#legacy-instance-binding-v1).

### V2 Behavioral Differences from V1

<VersionBadge type="changed" version="v4.6.0" /> (Resource API upgrades that formalized V2)

When `loadAsInstance = false`:

- Instance methods receive a `RequestTarget` as their first argument; no record is preloaded onto `this`.
- The `get` method returns the record as a plain (frozen) object rather than a Resource instance.
- `put`, `post`, and `patch` receive `(target, data)` — **arguments are reversed from V1**.
- Authorization is handled via `target.checkPermission` rather than `allowRead`/`allowUpdate`/etc. methods. Set it to `false` to bypass permission checks entirely (e.g. for a public read endpoint), or leave it at its default to require superuser access for write operations:

  ```javascript
  // Public read — no auth required
  get(target) {
  	target.checkPermission = false;
  	return super.get(target);
  }

  // POST is superuser-only by default — no change needed
  post(target, data) {
  	return super.post(target, data);
  }
  ```

  `checkPermission` can also be set to a non-boolean value to delegate to role-based or schema-defined permissions — see the authorization documentation for details.

- The `update` method returns an `Updatable` object instead of a Resource instance.
- Context is tracked automatically via async context tracking; set `static explicitContext = true` to disable (improves performance).
- `getId()` is not used and returns `undefined`.

---

## Resource Instance Methods

These methods are defined on a Resource class and called when requests are routed to the resource. Override them to define custom behavior.

### `get(target: RequestTarget): Promise<object> | AsyncIterable`

Called for HTTP GET requests. When the request targets a single record (e.g. `/Table/some-id`), returns a single record object. When the request targets a collection (e.g. `/Table/?name=value`), the `target.isCollection` property is `true` and the default behavior calls `search()`, returning an `AsyncIterable`.

```javascript
class MyResource extends Resource {
	static loadAsInstance = false;

	get(target) {
		const id = target.id; // primary key from URL path
		const param = target.get('param1'); // query string param
		const path = target.pathname; // path relative to resource
		return super.get(target); // default: return the record
	}
}
```

The default `super.get(target)` returns a `RecordObject` — a frozen plain object with the record's properties plus `getUpdatedTime()` and `getExpiresAt()`.

:::caution Common gotchas

- **`/Table` vs `/Table/`** — `GET /Table` returns metadata about the table resource itself. `GET /Table/` (trailing slash) targets the collection and invokes `get()` as a collection request. These are distinct endpoints.
- **Case sensitivity** — The URL path must match the exact casing of the exported resource or table name. `/Table/` works; `/table/` returns a 404.

:::

### `search(query: RequestTarget): AsyncIterable`

Performs a query on the resource or table. Called by `get()` on collection requests. Can be overridden to define custom query behavior. The default implementation on tables queries by the `conditions`, `limit`, `offset`, `select`, and `sort` properties parsed from the URL.

### `put(target: RequestTarget | Id, data: object): void | Response`

Called for HTTP PUT requests. Writes the full record to the table, creating or replacing the existing record.

```javascript
put(target, data) {
	// validate or transform before saving
	super.put(target, { ...data, status: data.status ?? 'active' });
}
```

### `patch(target: RequestTarget | Id, data: object): void | Response`

Called for HTTP PATCH requests. Merges `data` into the existing record, preserving any properties not included in `data`.

<VersionBadge version="v4.3.0" /> (CRDT support for individual property updates via PATCH)

### `post(target: RequestTarget | Id, data: object): void | Response`

Called for HTTP POST requests. Default behavior creates a new record. Override to implement custom actions.

### `delete(target: RequestTarget | Id): void | Response`

Called for HTTP DELETE requests. Default behavior deletes the record identified by `target`.

### `update(target: RequestTarget, updates?: object): Updatable`

Returns an `Updatable` instance providing mutable property access to a record. Any property changes on the `Updatable` are written to the database when the transaction commits.

```javascript
post(target, data) {
	const record = this.update(target.id);
	record.quantity = record.quantity - 1;
	// saved automatically on transaction commit
}
```

#### `Updatable` class

The `Updatable` class provides direct property access plus:

##### `addTo(property: string, value: number)`

Adds `value` to `property` using CRDT incrementation — safe for concurrent updates across threads and nodes.

<VersionBadge version="v4.3.0" />

```javascript
post(target, data) {
	const record = this.update(target.id);
	record.addTo('quantity', -1); // decrement safely across nodes
}
```

##### `subtractFrom(property: string, value: number)`

Subtracts `value` from `property` using CRDT incrementation.

##### `set(property: string, value: any): void`

Sets a property to `value`. Equivalent to direct property assignment (`record.property = value`), but useful when the property name is dynamic.

```javascript
const record = this.update(target.id);
record.set('status', 'active');
```

##### `getProperty(property: string): any`

Returns the current value of `property` from the record. Useful when the property name is dynamic or when you want an explicit read rather than direct property access.

```javascript
const record = this.update(target.id);
const current = record.getProperty('status');
```

##### `getUpdatedTime(): number`

Returns the last updated time as milliseconds since epoch.

##### `getExpiresAt(): number`

Returns the expiration time, if one is set.

### `publish(target: RequestTarget, message: object): void | Response`

Called for MQTT publish commands. Default behavior records the message and notifies subscribers without changing the record's stored data.

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

### `search(query: RequestTarget | Query, context?): AsyncIterable`

Query the table. See [Query Object](#query-object) below for available query options.

### `setComputedAttribute(name: string, computeFunction: (record) => any)`

Define the compute function for a `@computed` schema attribute.

<VersionBadge version="v4.4.0" />

```javascript
MyTable.setComputedAttribute('fullName', (record) => `${record.firstName} ${record.lastName}`);
```

### `getRecordCount({ exactCount?: boolean }): Promise<{ recordCount: number, estimatedRange?: [number, number] }>`

Returns the number of records in the table. By default returns an approximate (fast) count. Pass `{ exactCount: true }` for a precise count.

<VersionBadge version="v4.5.0" />

### `sourcedFrom(Resource, options?)`

Configure a table to use another resource as its data source (caching behavior). When a record is not found locally, it is fetched from the source and cached. Writes are delegated to the source.

Options:

- `expiration` — Default TTL in seconds
- `eviction` — Eviction time in seconds
- `scanInterval` — Period for scanning expired records

### `parsePath(path, context, query)`

Called by static methods when processing a URL path. Can be overridden to preserve the path directly as the primary key:

```javascript
static parsePath(path) {
	return path; // use full path as id, no parsing
}
```

### `directURLMapping`

Set this static property to `true` to map the full URL (including query string) as the primary key, bypassing query parsing.

<VersionBadge version="v4.5.0" /> (documented in improved URL path parsing)

```javascript
export class MyTable extends tables.MyTable {
	static directURLMapping = true;
}
// GET /MyTable/test?foo=bar → primary key is 'test?foo=bar'
```

### `primaryKey`

The name of the primary key attribute for the table.

```javascript
const record = await Table.get(34);
record[Table.primaryKey]; // → 34
```

### `isCollection(resource): boolean`

Returns `true` if the resource instance represents a collection (query result) rather than a single record.

---

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

Whenever you call other resources from within a resource method, pass `this` as the context argument to share the transaction and ensure atomicity:

```javascript
export class BlogPost extends tables.BlogPost {
	static loadAsInstance = false;

	post(target, data) {
		// both writes share the same transaction
		tables.Comment.put(data, this);
		const post = this.update(target.id);
		post.commentCount = (post.commentCount ?? 0) + 1;
	}
}
```

See [JavaScript Environment — transaction](../components/javascript-environment.md#transactionfn) for explicitly starting transactions outside of request handlers.

---

## Legacy Instance Binding (V1)

This documents the legacy `loadAsInstance = true` (or default pre-V2) behavior. The V2 API is recommended for all new code.

When `loadAsInstance` is not `false` (or is explicitly `true`):

- `this` is pre-bound to the matching record when instance methods are called.
- `this.getId()` returns the current record's primary key.
- Instance properties map directly to the record's fields.
- `get(query)` and `put(data, query)` have arguments in the older order (no `target` first).
- `allowRead()`, `allowUpdate()`, `allowCreate()`, `allowDelete()` methods are used for authorization.

```javascript
export class MyExternalData extends Resource {
	static loadAsInstance = true;

	async get() {
		const response = await this.fetch(this.id);
		return response;
	}

	put(data) {
		// write to external source
	}

	delete() {
		// delete from external source
	}
}

tables.MyCache.sourcedFrom(MyExternalData);
```

### Migration from V1 to V2

Updated `get`:

```javascript
// V1
async get(query) {
	let id = this.getId();
	this.newProperty = 'value';
	return super.get(query);
}

// V2
static loadAsInstance = false;
async get(target) {
	let id = target.id;
	let record = await super.get(target);
	return { ...record, newProperty: 'value' }; // record is frozen; spread to add properties
}
```

Updated authorization:

```javascript
// V1
allowRead(user) {
	return !!user;
}

// V2
static loadAsInstance = false;
async get(target) {
	if (!this.getContext().user) {
		const error = new Error('Unauthorized');
		error.statusCode = 401;
		throw error;
	}
	target.checkPermission = false;
	return super.get(target);
}
```

Updated `post` (note reversed argument order):

```javascript
// V1
async post(data, query) { ... }

// V2
static loadAsInstance = false;
async post(target, data) { ... } // target is first
```
