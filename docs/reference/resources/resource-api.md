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

Static methods are defined on a Resource class and are the preferred way to interact with tables and resources from application code. They handle transaction setup, access checks, and request parsing automatically. These methods also map to RESTful HTTP verbs and can be overridden to define custom behavior for requests.

### `get(target: RequestTarget | Id | Query, context?: Resource | Context): Promise<object> | ExtendedIterable`

Retrieves a record by primary key, or queries for records when given a `Query` object or a collection `RequestTarget`.

```javascript
// By primary key
const product = await Product.get(34);

// By query object with select
const product = await Product.get({ id: 34, select: ['name', 'price'] });

// Iterate a collection query
for await (const record of Product.get({ conditions: [{ attribute: 'inStock', value: true }] })) {
	// ...
}
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

If you want a modified object from this record, you can copy the record and change properties:

```javascript
	static async get(target) {
		const record = await super.get(target);
		return { ...record, changedProperty: 'value' };
	}
```

#### RecordObject

The `get()` method returns a `RecordObject` — a frozen plain object with all record properties, plus:

- `getUpdatedTime(): number` — Last updated time (milliseconds since epoch)
- `getExpiresAt(): number` — Expiration time, if set

---

### `search(query: RequestTarget | Query, context?): ExtendedIterable`

Performs a query on the resource or table. This is called by `get()` on collection requests and can be overridden to define custom query behavior. The default implementation on tables queries by the `conditions`, `limit`, `offset`, `select`, and `sort` properties parsed from the URL or query object. See [Query Object](#query-object) below for available query options. See the [ExtendedIterable](#extendediterable) below for how to interact with the query results.

---

### `put(target: RequestTarget | Id, data: Promise<object>, context?: Resource | Context): Promise<void> | Response`

### `put(record: object, context?): Promise<void>`

Writes the full record to the table, creating or replacing the existing record. This does _not_ merge the `data` into the existing record — it replaces it. The second form reads the primary key from the record object.

```javascript
await Product.put(34, { name: 'New Product Name' });
// or with the primary key in the object:
await Product.put({ id: 34, name: 'New Product Name' });
```

This is called for HTTP PUT requests, and can be overridden to implement a custom `PUT` handler:

```javascript
class MyResource extends Resource {
	static async put(target, data) {
		return super.put(target, { ...(await data), status: data.status ?? 'active' });
	}
}
```

---

### `patch(target: RequestTarget | Id, data: Promise<object>, context?: Resource | Context): Promise<void> | Response`

Writes a partial record to the table, merging `data` into the existing record.

```javascript
await Product.patch(34, { description: 'Updated description' });
```

This is called for HTTP PATCH requests, and can be overridden to implement a custom `PATCH` handler:

```javascript
class MyResource extends Resource {
	static async patch(target, data) {
		return super.patch(target, { ...(await data), status: data.status ?? 'active' });
	}
}
```

<VersionBadge version="v4.3.0" /> (CRDT support for individual property updates via PATCH)

---

### `post(target: RequestTarget, data: Promise<object>, context?: Resource | Context): Promise<void> | Response`

Called for HTTP POST requests. The default behavior creates a new record, but it can be overridden to implement custom actions. Prefer more explicit methods like `create()` or `update()` over calling `post` directly.

```javascript
class MyResource extends Resource {
	static async post(target, promisedData) {
		let data = await promisedData;
		if (data.action === 'create') {
			return this.create(target, data.content);
		} else if (data.action === 'update') {
			let resource = await this.update(target);
			resource.set('status', data.status);
			resource.save();
		}
	}
}
```

---

### `delete(target: RequestTarget | Id, context?): Promise<void>`

Deletes a record from the table.

```javascript
await Product.delete(34);
```

This is called for HTTP DELETE requests, and can be overridden to implement a custom `DELETE` handler:

```javascript
class MyResource extends Resource {
	static async delete(target) {
		return super.delete(target);
	}
}
```

---

### `create(record: object, context?): Promise<Resource>`

Creates a new record with an auto-generated primary key. Returns the created Resource instance. Do not include a primary key in the `record` argument.

<VersionBadge version="v4.2.0" />

---

### `update(target: RequestTarget | Id, updates?: object): Promise<Resource>`

Returns a mutable Resource instance for a given record. Property changes on the instance are written to the table when the transaction commits. This is the primary method for getting a Resource instance and accessing all instance methods.

```javascript
const product = await Product.update(32);
product.status = 'active';
product.subtractFrom('quantity', 1);
product.save();
```

---

### `publish(target: RequestTarget | Id, message: object, context?: Resource | Context): Promise<void>`

Publishes a message to a record/topic using the same primary key structure as records.

```javascript
await Product.publish(34, { event: 'product-purchased', purchasePrice: 100 });
```

This is called for MQTT publish commands. The default behavior records the message and notifies subscribers without changing the record's stored data. This can be overridden to implement custom message handling.

---

### `subscribe(subscriptionRequest?: SubscriptionRequest, context?): Promise<Subscription>`

Called for MQTT subscribe commands. Returns a `Subscription` — an `AsyncIterable` of messages/changes.

#### `SubscriptionRequest` options

All properties are optional:

| Property             | Description                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `includeDescendants` | Include all updates with an id prefixed by the subscribed id (e.g. `sub/*`)                    |
| `startTime`          | Start from a past time (catch-up of historical messages). Cannot be used with `previousCount`. |
| `previousCount`      | Return the last N updates/messages. Cannot be used with `startTime`.                           |
| `omitCurrent`        | Do not send the current/retained record as the first update.                                   |

---

### `connect(target: RequestTarget, incomingMessages?: AsyncIterable): AsyncIterable`

Called for WebSocket and Server-Sent Events connections. `incomingMessages` is provided for WebSocket connections (not SSE). Returns an `AsyncIterable` of messages to send to the client.

---

### `invalidate(target: RequestTarget | Id, context?)`

Marks the specified record as invalid in a caching table, so it will be reloaded from the source on next access.

---

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

#### Observing cache disposition

Each `get` on a caching table records whether the record came from the cache or from the source in the `loadedFromSource` property of the **`RequestTarget`** for that get. Cache disposition is a per-get result, so it lives on the per-get target — pass an explicit `RequestTarget` to observe it:

```javascript
import { RequestTarget } from 'harper';

const target = new RequestTarget();
target.id = recordId;
const record = await MyCache.get(target);
console.log(target.loadedFromSource); // true = went to the source, false = served from cache
```

The flag settles as follows:

- `true` — the get went to the source: either it fetched the record, or the source errored and a stale cached record was served as a fallback (`staleIfError`). `true` means a source request was made, not necessarily that the returned data is fresh.
- `false` — the record was served from the cache: fresh hits, `onlyIfCached` requests, stale-while-revalidate responses (the source fetch continues in the background), and requests that waited on another request's in-flight fetch of the same record. This last case means a cache hit can still take as long as an upstream fetch.

Note that `get()` returns a plain `RecordObject`, not a resource instance — the record itself does not carry cache disposition; the explicitly passed `RequestTarget` is the supported way to observe it. There is deliberately no request-`Context` mirror of this flag: a context is shared across every `get` in the request (including a caching table's internal gets), so a context-level value would be silently overwritten before the caller could read it.

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

---

### `getUpdatedTime(): number`

Returns the last updated time of the resource (milliseconds since epoch).

---

### `getRecordCount({ exactCount?: boolean }): Promise<{ recordCount: number, estimatedRange?: [number, number] }>`

Returns the number of records in the table. By default returns an approximate (fast) count. Pass `{ exactCount: true }` for a precise count.

<VersionBadge version="v4.5.0" />

---

### `primaryKey`

The name of the primary key attribute for the table.

### `static path?: string`

<VersionBadge version="v5.1.13" />

Declares the URL path the resource is registered at, overriding the default export-name convention. A leading `/` makes the path root-relative (top-level); a leading `./` or a bare name resolves relative to the component directory. The path may contain `:name` (single-segment) and `*name` (trailing catch-all) parameters, whose matched values are bound onto the request target (e.g. `static path = '/widget/:id'` populates `target.id`).

```js
export class Widget extends Resource {
	static path = '/widget/:id/action/:action';
	static get(target) {
		// GET /widget/10/action/jump -> target.id === '10', target.action === 'jump'
	}
}
```

See [Exporting Resources as Endpoints → Path Parameters](./overview.md#path-parameters) for matching and precedence rules.

---

## Class-level metadata for MCP and OpenAPI

Resource classes — both `@table @export` Resources and programmatic Resource subclasses — can declare class-level static fields that drive the MCP tool descriptors and OpenAPI document. These statics are JSON-Schema-aligned and tool-agnostic; the same data feeds every introspectable surface.

For `@table @export` Resources, `static description` and `static properties` are auto-derived from the GraphQL schema (docstrings and field types). For programmatic Resources, you declare them directly.

### `static description?: string`

Class-level docstring. Consumed by:

- **MCP** — prefixed onto every verb-tool description (`get_X`, `search_X`, etc.) and onto the `harper://schema/{db}/{table}` resource description
- **OpenAPI** — set as the schema-level `description` on the resource's component schema; also prepended to the `description` of every path operation (POST/GET/PUT/PATCH/DELETE)

```typescript
import { Resource } from 'harperdb';

export class ProductInventory extends Resource {
	static description =
		'Aggregate inventory analytics computed over the Product catalog. ' +
		'Read-only; the underlying Product table is the system of record.';

	async get(id) {
		/* ... */
	}
}
```

### `static properties?: Record<string, JsonSchemaFragment>`

JSON-Schema-shaped attribute map keyed by name. This is the canonical public API for class-level metadata. For `@table @export` Resources it's auto-derived from the GraphQL schema. For programmatic Resources, declare it directly:

```typescript
export class ProductInventory extends Resource {
	static description = '...';
	static properties = {
		sku: { type: 'string', primaryKey: true, description: 'Stock keeping unit; matches Product.sku.' },
		onHand: { type: 'integer', description: 'Current warehouse count.' },
		reserved: { type: 'integer', description: 'Units allocated to open orders but not yet shipped.' },
		stockStatus: {
			type: 'string',
			enum: ['in_stock', 'out_of_stock', 'backorder'],
			description: 'Derived from onHand vs reserved.',
		},
	};

	async get(id) {
		/* ... */
	}
}
```

For complex types and nested structures, JSON Schema vocabulary applies (`type`, `enum`, `required`, `additionalProperties`, etc.). Per-property `description` flows into both MCP `inputSchema.properties[*].description` and OpenAPI `components.schemas[*].properties[*].description`.

**Inheritance composes naturally.** Extend a `@table @export` Resource and override individual entries with spread:

```typescript
const { Product } = tables;

class CustomProduct extends Product {
	static properties = {
		...Product.properties,
		priceCents: {
			...Product.properties.priceCents,
			description: 'Retail price in cents, including any per-customer adjustments.',
		},
	};
}
```

The author writes against `properties` (the public API). Internal code that needs ordered iteration / index metadata continues to read `Class.attributes` (the internal Array form, also inherited).

### `static outputSchemas?: { [verb: string]: JsonSchemaFragment }`

Per-verb output schema overrides for programmatic Resources whose verb methods return a projection rather than the full record. When omitted, the MCP deriver falls back to `static properties` for the cheap verbs (`get`/`create`/`update`/`patch`) and a synthesized `{deleted: true, <pk>}` envelope for `delete`. `search_*` deliberately has no output schema.

```typescript
export class ProductInventory extends Resource {
	static description = '...';
	static properties = {
		/* full record shape */
	};

	static outputSchemas = {
		get: {
			type: 'object',
			properties: {
				sku: { type: 'string' },
				onHand: { type: 'integer' },
				stockStatus: { type: 'string', enum: ['in_stock', 'out_of_stock', 'backorder'] },
			},
			required: ['sku', 'onHand', 'stockStatus'],
		},
	};

	async get(id) {
		/* returns the projection above */
	}
}
```

### `static hidden?: boolean`

When `true`, the Resource is dropped from MCP tool registration and OpenAPI path generation entirely. Data remains accessible via direct Harper interfaces subject to RBAC. Equivalent to applying `@hidden` to the `@table @export` declaration.

```typescript
export class InternalDiagnostics extends Resource {
	static hidden = true;
	async get() {
		/* ... */
	}
}
```

### `static mcp?: { annotations?: { [verb: string]: Annotations } }`

Narrow, MCP-only override for annotation hints that don't fit JSON Schema (such as `idempotentHint` per verb). Documented as discouraged — most authors should only need `static description` + `static properties`. Use this when you need to claim, for example, that your custom `update` semantics are observably idempotent on repeat calls.

```typescript
export class ProductInventory extends Resource {
	static description = '...';
	static properties = {
		/* ... */
	};

	static mcp = {
		annotations: {
			update: { idempotentHint: true },
		},
	};
}
```

> **Under-annotate before mis-annotate.** Under MCP semantics, `idempotentHint: true` is a strong claim: the second call must produce the same observable outcome as the first. `add_*`-style operations that return "already exists" on the second call are NOT idempotent in this sense, even though they don't crash. Verify repeat-call behavior end-to-end before annotating.

### `static mcpTools?: McpToolDefinition[]`

Component-author opt-in for exposing non-verb instance methods as MCP tools. Each entry maps an instance-method name to an MCP tool descriptor. RBAC is enforced by the Resource method itself; the MCP layer does not invent new ACLs.

```typescript
export class ProductInventory extends Resource {
	static mcpTools = [
		{
			name: 'reconcile_inventory',
			method: 'reconcileInventory',
			description:
				'Triggers an immediate reconciliation against the warehouse system. ' +
				'Returns the diff applied. Heavy — do not call in a loop.',
			inputSchema: {
				type: 'object',
				properties: {
					sku: { type: 'string', description: 'SKU to reconcile, or omit for full sweep.' },
				},
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
	];

	async reconcileInventory(args) {
		/* ... */
	}
}
```

Custom `mcpTools` declarations without a `description` or `inputSchema` are still registered, but Harper emits a warn-once log at registration time — LLM tool selection degrades without these fields.

---

### `setComputedAttribute(name: string, computeFunction: (record) => any)`

Define the compute function for a `@computed` schema attribute.

<VersionBadge version="v4.4.0" />

```javascript
MyTable.setComputedAttribute('fullName', (record) => `${record.firstName} ${record.lastName}`);
```

---

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

---

### `operation(operationObject: object, authorize?: boolean): Promise<any>`

Executes a Harper operations API call using this table as the target. Set `authorize` to `true` to enforce current-user authorization.

---

### `getCurrentUser(): User | undefined`

Returns the user associated with the current request, or `undefined` if no user is authenticated. The returned object exposes the username, role, and `role.permission` flags.

```javascript
async get(target) {
	const user = this.getCurrentUser();
	if (!user) return new Response(null, { status: 401 });
	return { username: user.username, role: user.role };
}
```

---

### Session and Login from a Resource

The context returned by `getContext()` exposes `login` and `session` for handling sign-in/out flows in a custom Resource. Sessions require `authentication.enableSessions: true` in `harperdb-config.yaml`.

```typescript
export class SignIn extends Resource {
	async post(_target, data) {
		const context = this.getContext();
		try {
			await context.login(data.username, data.password);
		} catch {
			return new Response('Invalid credentials', { status: 403 });
		}
		return new Response('Logged in', { status: 200 });
	}
}

export class SignOut extends Resource {
	async post() {
		const context = this.getContext();
		if (!context.session) return new Response(null, { status: 401 });
		await context.session.delete(context.session.id);
		return new Response('Logged out', { status: 200 });
	}
}
```

`context.login(username, password)` verifies credentials and establishes the session cookie on success. To end a session, delete it via `context.session.delete(context.session.id)`.

Cookie-based sessions are intended for browser clients. For non-browser clients (CLI tools, mobile apps, service-to-service), use JWT issuance — see [JWT Authentication](../security/jwt-authentication.md).

---

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

## Concurrency and Safe Concurrent Writes

When multiple writers may touch the same record concurrently, only atomic deltas are safe. Harper resolves deltas at commit time, so the committed result is exact regardless of how the writers interleave:

```javascript
record.addTo('counter', 1); // increment
record.subtractFrom('stock', 1); // decrement
```

Read-then-write patterns — "compare-and-set" — are not safe under concurrency. This includes version-guarded updates (`ifVersion`), create-only "first write wins", reading a value to decide and then writing it back, and HTTP `If-Match` / conditional writes. All of these read a value _before_ commit and are not re-validated _at_ commit, so two concurrent writers can both pass the check. Modeling state as commutative deltas avoids the problem entirely.

A few limitations to design around:

- `addTo` and `subtractFrom` return no value, and a read-back immediately after a write is not guaranteed to reflect your own committed result. You cannot use them to read "your position" for an exactly-once claim or a hard limit.
- `subtractFrom` has no floor; concurrent decrements can drive a value negative.

For non-commutative operations — claim-once, hard caps, inventory floors, state-machine transitions — serialize the operation through a single owning process, or use an external lock or coordinator. This matters more in a cluster: a counter replicates and converges eventually, but a decision made on one node's not-yet-converged view can be wrong during the replication window. A rate limiter built this way, for example, can transiently over-admit when requests are spread across nodes.

## Returning Errors and Status Codes

A custom resource method controls the HTTP status in a few ways. The key
distinction is **throw vs. return**: throwing rolls the transaction back,
while returning (resolving) commits it.

To return an **error** status, throw — either an `Error` carrying a status, or
a plain object. Both `statusCode` and `status` are honored:

```javascript
async get() {
	const err = new Error('Not found');
	err.statusCode = 404;
	throw err;
}
```

```javascript
async get() {
	throw { status: 400, message: 'Invalid input' };
}
```

To set the status on a **successful** response, return a `Response`, or set it
on the context and return your data — either commits the transaction:

```javascript
async post(target, data) {
	return new Response(body, { status: 201 });
}
```

```javascript
async get() {
	this.getContext().response.status = 202;
	return data;
}
```

A thrown `Response` is honored too — it short-circuits with its own status,
headers, and body — but, being a throw, it **rolls back the transaction**. Use
it for error or redirect short-circuits; `return` a `Response` when a preceding
write in the same method should commit:

```javascript
async post(target, data) {
	// short-circuits to 422; any write earlier in this method is rolled back
	throw new Response(body, { status: 422 });
}
```

One pattern looks like it should work but does not:

- `return { status: 400, data: {...} }` — a bare `status` on a returned plain
  object is ignored (the response is 200) unless the object also carries a
  `headers` field. `status` collides with ordinary record attributes, so
  `headers` is the disambiguator. Return a `Response`, or set
  `context.response.status`, instead.

Note that an unhandled throw currently surfaces its message in the response
body, so avoid putting sensitive detail in thrown error messages.

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
- `$distance` — When the query ranks or filters by a vector index, returns the computed distance from the target vector. See [Vector Indexing](../database/schema.md#vector-indexing).

#### Selecting related records

When a field is defined as a [relationship](../database/schema.md#relationships), `select` can pull the related record(s) into each result as a nested property — the programmatic equivalent of the REST `select(name,author{name})` syntax.

- **Whole related record** — list the relationship field by name. The related record (or an array of records for a to-many relationship) is attached as a nested property:

  ```javascript
  // `author` is a relationship field
  const book = await Book.get({ id: 42, select: ['id', 'title', 'author'] });
  book.author.name; // the full related Author record
  ```

- **Partial related record** — use an object `{ name, select }` to choose which fields of the related record to return. Unselected fields are omitted:

  ```javascript
  const book = await Book.get({ id: 42, select: ['id', 'title', { name: 'author', select: ['name'] }] });
  ```

- **Nesting** — a `select` inside an object entry may itself contain more `{ name, select }` objects, traversing multiple relationships in one query:

  ```javascript
  select: ['id', 'name', { name: 'segments', select: ['id', 'name', { name: 'client', select: ['id', 'name'] }] }];
  ```

A to-many relationship resolves to an array of records; depending on access pattern you may need to `await` the property before iterating it.

**Join behavior:** selecting a relationship _without_ filtering on it behaves as a **LEFT JOIN** — records with no related row are still returned (the relationship property is omitted or empty). Adding a condition on a related attribute (e.g. `attribute: ['author', 'name']`) behaves as an **INNER JOIN** — only records with a matching related row are returned.

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
