---
title: Resources Overview
---

<!-- Source: versioned_docs/version-4.7/reference/resources/index.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (Resource API introduction) -->

# Resources

Harper's Resource API is the foundation for building custom data access logic and connecting data sources. Resources are JavaScript classes that define how data is accessed, modified, subscribed to, and served over HTTP, MQTT, and WebSocket protocols.

## What Is a Resource?

A **Resource** is a class that provides a unified interface for a set of records or entities. Harper's built-in tables extend the base `Resource` class, and you can extend either `Resource` or a table class to implement custom behavior for any data source — internal or external.

Added in: v4.2.0

The Resource API is designed to mirror REST/HTTP semantics: methods map directly to HTTP verbs (`get`, `put`, `patch`, `post`, `delete`), making it straightforward to build API endpoints alongside custom data logic.

## Relationship to Other Features

- **Database tables** extend `Resource` automatically. You can use tables through the Resource API without writing any custom code.
- The **REST plugin** maps incoming HTTP requests to Resource methods. See [REST Overview](TODO:reference_versioned_docs/version-v4/rest/overview.md 'REST plugin reference').
- The **MQTT plugin** routes publish/subscribe messages to `publish` and `subscribe` Resource methods. See [MQTT Overview](TODO:reference_versioned_docs/version-v4/mqtt/overview.md 'MQTT plugin reference').
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

> For more info on the schema API see [`Database / Schema`]()

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

Resources become HTTP/MQTT endpoints when they are exported. As the examples demonstrated if a Resource extends an existing table, make sure to not have conflicting exports between the schema and the JavaScript implementation. Alternatively, you can register resources programmatically using `server.resources.set()`. See [HTTP API](../http/api.md) for server extension documentation.

## Pages in This Section

| Page                                          | Description                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Resource API](./resource-api.md)             | Complete reference for instance methods, static methods, the Query object, RequestTarget, and response handling |
| [Query Optimization](./query-optimization.md) | How Harper executes queries and how to write performant conditions                                              |
