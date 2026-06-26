---
title: Resources Overview
---

<!-- Source: versioned_docs/version-4.7/reference/resources/index.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (Resource API introduction) -->

# Resources

Harper's Resource API is the foundation for building custom data access logic and connecting data sources. Resources are JavaScript classes that define how data is accessed, modified, subscribed to, and served over HTTP, MQTT, and WebSocket protocols.

## What Is a Resource?

A **Resource** is a class that provides a unified interface for a set of records or entities. Harper's built-in tables extend the base `Resource` class, and you can extend either `Resource` or a table class to implement custom behavior for any data source — internal or external.

<VersionBadge version="v4.2.0" />

The Resource API is designed to mirror REST/HTTP semantics: methods map directly to HTTP verbs (`get`, `put`, `patch`, `post`, `delete`), making it straightforward to build API endpoints alongside custom data logic.

## Relationship to Other Features

- **Database tables** extend `Resource` automatically. You can use tables through the Resource API without writing any custom code.
- The **REST plugin** maps incoming HTTP requests to Resource methods. See [REST Overview](../rest/overview.md).
- The **MQTT plugin** routes publish/subscribe messages to `publish` and `subscribe` Resource methods. See [MQTT Overview](../mqtt/overview.md).
- **Global APIs** (`tables`, `databases`, `transaction`) provide access to resources from JavaScript code.
- The **`jsResource` plugin** (configured in `config.yaml`) registers a JavaScript file's exported Resource classes as endpoints.

## Extending a Table

The most common use case is extending an existing table to add custom logic.

Starting with a table definition in a `schema.graphql`:

```graphql
# Omit the `@export` directive
type MyTable @table {
	id: Long @primaryKey
	# ...
}
```

`@export` on the schema type registers Harper's default table resource at `/MyTable`. When you extend the table in JavaScript and want your subclass to serve those endpoints instead, **omit `@export`** from the schema and let the exported JavaScript class own the URL. Leaving `@export` on the schema while also exporting a subclass with the same name produces conflicting endpoints. When overriding handlers, call `super.get/post/...` to preserve Harper's default behavior unless you intend to replace it entirely.

> For more info on the schema API see [`Database / Schema`](../database/schema.md)

Then, in a `resources.js` extend from the `tables.MyTable` global:

```javascript
export class MyTable extends tables.MyTable {
	static async get(target) {
		// get the record from the database
		const record = await super.get(target);
		// add a computed property before returning
		return { ...record, computedField: 'value' };
	}

	static async post(target, data) {
		// custom action on POST
		this.create({ ...(await data), status: 'pending' });
	}
}
```

When delegating to `super`, match the argument form to the operation: a collection create passes the collection target and the record (`super.post(target, record)` — the target identifies the collection and carries no id, since the primary key is auto-generated), while updates pass the target and data (`super.put(target, data)` / `super.patch(target, data)`) and reads/deletes pass the target (`super.get(target)` / `super.delete(target)`).

To return a specific HTTP status from a thrown error, set `.statusCode` (e.g. `400`) on the error object — a plain `.status` property is ignored:

```javascript
const error = new Error('Name is required');
error.statusCode = 400; // use statusCode, NOT status
throw error;
```

Finally, ensure everything is configured appropriately:

```yaml
rest: true
graphqlSchema:
  files: schema.graphql
jsResource:
  files: resources.js
```

## Custom External Data Source

You can also extend the base `Resource` class directly to implement custom endpoints, or even wrap an external API or service as a custom caching layer:

```javascript
export class CustomEndpoint extends Resource {
	static get(target) {
		return {
			data: doSomething(),
		};
	}
}

export class MyExternalData extends Resource {
	static async get(target) {
		const response = await fetch(`https://api.example.com/${target.id}`);
		return response.json();
	}

	static async put(target, data) {
		return fetch(`https://api.example.com/${target.id}`, {
			method: 'PUT',
			body: JSON.stringify(await data),
		});
	}
}

// Use as a cache source for a local table
tables.MyCache.sourcedFrom(MyExternalData);
```

Resources are the true customization point for Harper. This is where the business logic of a Harper application really lives. There is a lot more to this API than these examples show. Ensure you fully review the [Resource API](./resource-api.md) documentation, and consider exploring the Learn guides for more information.

## Exporting Resources as Endpoints

Resources become HTTP/MQTT endpoints when they are exported. As the examples demonstrated if a Resource extends an existing table, make sure to not have conflicting exports between the schema and the JavaScript implementation. Alternatively, you can register resources programmatically using `server.resources.set()`. See [HTTP API](../http/api.md) for `server` API documentation.

The shape of the export controls the resulting URL:

| Export form                                 | URL             | Notes                                                                                                                          |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `export class Foo extends Resource {}`      | `/Foo/`         | The class name becomes the path segment. Path segments are case-sensitive.                                                     |
| `export const Bar = { Foo };`               | `/Bar/Foo/`     | Nest a class under an object to add a path prefix.                                                                             |
| `export const bar = { 'foo-baz': Foo };`    | `/bar/foo-baz/` | Use object keys when you need lowercase, hyphens, or any non-identifier URL.                                                   |
| `export { Foo as '/widget/:id' }`           | `/widget/:id`   | Rename the export to set the path directly, including a leading-slash top-level path. See [Path Parameters](#path-parameters). |
| `static path = '/widget/:id'` (class field) | `/widget/:id`   | Declare the path on the class itself; overrides the export name. See [Path Parameters](#path-parameters).                      |
| `server.resources.set('my-path', Foo);`     | `/my-path/`     | Programmatic registration; useful when the path is dynamic.                                                                    |

URL path matching is case-sensitive — `/Foo/` and `/foo/` are different endpoints.

### Path Parameters

<VersionBadge version="v5.1.13" />

A resource's path can declare dynamic segments. A `:name` segment matches a single path segment, and a `*name` segment is a catch-all that matches the rest of the path. Matched values are bound onto the request target so a handler reads them as `target.<name>`:

```js
export class Widget extends Resource {
	// GET /widget/10/action/jump  ->  target.id === '10', target.action === 'jump'
	static path = '/widget/:id/action/:action';
	static get(target) {
		return { id: target.id, action: target.action };
	}
}

export class Files extends Resource {
	// GET /files/a/b/c.txt  ->  target.rest === 'a/b/c.txt'
	static path = '/files/*rest';
	static get(target) {
		return { path: target.rest };
	}
}
```

A bare `*` (no name) binds under `target.wildcard`. A wildcard must be the final segment of the path.

**Declaring the path.** The path can come from a `static path` field on the class (the recommended lever, since it leaves the exports untouched) or from the export name (`export { Widget as '/widget/:id' }`). A `static path` takes precedence over the export name. In both forms:

- A leading `/` makes the path **root-relative** (top-level), independent of the file's location — useful for fixed top-level routes such as `static path = '/.well-known/acme-challenge/:token'`.
- A leading `./` or a bare name resolves **relative to the component directory**, the same as the default export-name behavior.

**Resolution order.** Exact and static paths always win over parameterized ones — `/resource/admin` is matched by a `static`-pathed `/resource/admin` resource even when a `/resource/:id` resource is also registered. Among parameterized routes, more specific paths win: a literal segment beats a `:param`, which beats a `*` wildcard, compared left to right.

Parameterized routes also surface in the generated OpenAPI document (as templated paths like `/widget/{id}/action/{action}`) and in MCP `resources/templates/list` (as `{param}` URI templates).

## Pages in This Section

| Page                                          | Description                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Resource API](./resource-api.md)             | Complete reference for instance methods, static methods, the Query object, RequestTarget, and response handling |
| [Query Optimization](./query-optimization.md) | How Harper executes queries and how to write performant conditions                                              |
