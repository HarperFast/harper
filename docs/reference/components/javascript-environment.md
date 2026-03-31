---
title: JavaScript Environment
---

<!-- Source: versioned_docs/version-4.7/reference/globals.md (primary) -->

# JavaScript Environment

Harper executes component JavaScript inside Node.js VM contexts — isolated module environments that share the same Node.js runtime but have their own global scope. This means each component runs in its own module context while still being able to access Harper's global APIs without any imports.

## Module Loading

Harper supports both ESM and CommonJS module formats.

All Harper globals are available directly as global variables in any component module. They are also accessible by importing from the `harperdb` package, which can provide better TypeScript typing:

```javascript
import { tables, Resource } from 'harperdb';
```

```javascript
const { tables, Resource } = require('harperdb');
```

For components in their own directory, link the package to your local `harperdb` installation:

```bash
npm link harperdb
```

All installed components have `harperdb` automatically linked.

## Global APIs

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

Provides structured logging methods (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `notify`) that write to Harper's log file. Available without any imports in all component code.

See [Logging API](../logging/api.md) for full reference.
