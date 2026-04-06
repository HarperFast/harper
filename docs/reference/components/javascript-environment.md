---
title: JavaScript Environment
---

<!-- Source: versioned_docs/version-4.7/reference/globals.md (primary) -->

# JavaScript Environment

Harper executes component JavaScript in distinct module caches, using Node.js's VM module loader. This provides contextualized module environments that share the same Node.js runtime but have their own set of modules isolated from other applications. This means each application runs in its own module context while still being able to access Harper's full set of APIs.

## Module Loading

Harper supports both ESM and CommonJS module formats. The full set of Harper APIs are accessible by importing from the `harper` package, for example::

```javascript
import { tables, Resource } from 'harper';
```

```javascript
const { tables, Resource } = require('harper');
```

The Harper APIs are also available as global variables. This can be a quick and easy way to use the APIs and is preserved for backward compatibility, but is not the recommended approach. There are also some APIs that are not fully functional as globals.

For components in their own directory, link the package to your local `harper` installation to ensure any typings use the current/correction version of Harper:

```bash
npm link harper
```

All installed components have `harper` automatically linked.

## Harper API

The following objects and functions are available as exports from the `harper` package (and also available as global variables).

### `tables`

An object whose properties are the tables in the default database (`data`). Each table defined in `schema.graphql` is accessible as a property and implements the Resource API.

See [Database API](../database/api.md) for full reference.

### `databases`

An object containing all databases defined in Harper. Each database is an object of its tables — `databases.data` is always equivalent to `tables`.

See [Database API](../database/api.md) for full reference.

### `transaction(fn)`

Executes a function inside a database transaction. Changes made within the function are committed atomically, or rolled back if an error is thrown.

See [Transactions](../database/transaction.md) for full reference.

### `createBlob(data, options?)`

<VersionBadge version="v4.5.0" />

Creates a [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob) backed by Harper's storage engine. Use it to store large binary content (images, audio, video, etc.) in `Blob`-typed schema fields.

See [Database API](../database/api.md) for full reference.

### `Resource`

The base class for all Harper resources, including tables and custom data sources. Extend `Resource` to implement custom data providers.

See [Resource API](../resources/resource-api.md) for full reference.

### `server`

Provides access to Harper's HTTP server middleware chain, WebSocket server, authentication helpers, resource registry, and cluster information. Also exposes `server.contentTypes` as an alias for the `contentTypes` global.

See [HTTP API](../http/api.md) for full reference.

### `contentTypes`

A `Map` of MIME type strings to content type handler objects. Harper uses this map for content negotiation — deserializing incoming request bodies and serializing outgoing responses. You can register custom handlers to support additional formats.

See [HTTP API](../http/api.md) for full reference.

### `logger`

Provides structured logging methods (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `notify`) that write to Harper's log file. Note that using the global variable may not provide full application tagging and configurability.

See [Logging API](../logging/api.md) for full reference.

### `resources`

A `Map` of all resources registered on this Harper server, keyed by their URL path. Each entry contains the resource class, path, and routing metadata. Use this to look up or enumerate registered resources programmatically.

### `config`

The configuration object for the current application, as provided by the component's configuration (e.g. `config.yaml`). Defaults to an empty object if no configuration is provided.

### `RequestTarget`

A class (extending `URLSearchParams`) that represents a parsed resource request — including the target record ID, query conditions, pagination (`limit`/`offset`), sort order, selected attributes, and caching directives. Use `RequestTarget` to construct typed resource requests when calling resource methods directly:

```javascript
import { tables, RequestTarget } from 'harper';

const target = new RequestTarget('/my-record-id?limit=10');
const results = await tables.myTable.search(target);
```

### `getContext()`

Returns the current async context object for the active request. The context holds request-scoped state including the active transaction, user, response, and timestamp. Returns an empty object if called outside of a request context.

```javascript
import { getContext } from 'harper';

const ctx = getContext();
console.log(ctx.user, ctx.transaction);
```

### `getUser()`

Returns the authenticated user from the current async request context, or `undefined` if called outside a request or the request is unauthenticated. Equivalent to `getContext().user`.

```javascript
import { getUser } from 'harper';

export class MyResource extends Resource {
	async get(id) {
		const user = getUser();
		if (!user) throw new Error('Unauthorized');
		// ...
	}
}
```

### `getResponse()`

Returns the outgoing `Response` object for the current request, or `undefined` if called outside a request context. Use this to set response headers or inspect the response mid-handler. Equivalent to `getContext().response`.
