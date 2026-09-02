---
title: Plugin API
---

<!-- Source: versioned_docs/version-4.7/reference/components/plugins.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (Plugin API introduced) -->
<!-- Source: release-notes/v4-tucker/4.7.0.md (further plugin API improvements) -->

# Plugin API

<VersionBadge version="v5.0.0" type="stable" />
<VersionBadge version="v4.6.0" />

**Plugins** are the building blocks of the Harper component system. Applications depend on plugins to provide the functionality they implement. For example, the built-in `graphqlSchema` plugin enables applications to define databases and tables using GraphQL schemas. The `@harperfast/nextjs` plugin provides the functionality to build a Next.js application on Harper. Plugins export a single `handleApplication` method and are always executed on worker threads.

Plugins can also depend on other plugins. For example, `@harperfast/nextjs` depends on the built-in `graphqlSchema` to create caching tables.

## Declaring a Plugin

A plugin must specify a `pluginModule` option in `config.yaml` pointing to the plugin source:

```yaml
pluginModule: plugin.js
```

For TypeScript or other compiled languages, point to the built output:

```yaml
pluginModule: ./dist/index.js
```

It is recommended that plugins have a `package.json` with standard JavaScript package metadata (name, version, type, etc.). Plugins are standard JavaScript packages and can be published to npm, written in TypeScript, or export executables.

## Configuration

General plugin configuration options:

- `files` — `string | string[] | FilesOptionObject` _(optional)_ — Glob pattern(s) for files and directories handled by the plugin's default `EntryHandler`. Pattern rules:
  - Cannot contain `..` or start with `/`
  - `.` or `./` is transformed to `**/*` automatically
- `urlPath` — `string` _(optional)_ — Base URL path prepended to resolved `files` entries and used to route the plugin's HTTP, WebSocket, and upgrade handlers. Cannot contain `..`. If it starts with `./` or is `.`, the plugin name is automatically prepended.
- `host` — `string` _(optional)_ — Virtual hostname used to route the plugin's HTTP, WebSocket, and upgrade handlers
- `timeout` — `number` _(optional)_ — Timeout in milliseconds for plugin operations. Takes precedence over the plugin's `defaultTimeout` and the system default (30 seconds)

`urlPath` and `host` are available in v5.2.0. Harper automatically passes them to handlers registered through the scoped `server` API.

These position a plugin **within** its application. Where the application itself is served is set on the application's entry in the root `harper-config.yaml`; that mount is prefixed onto each plugin's `urlPath`, and a `host` there overrides one set here. See [Middleware routing](../http/overview#middleware-routing) for the full picture and [`HttpOptions`](../http/api#httpoptions) for matching behavior.

### File Entries

```yaml
# Serve files from web/ at /static/
static:
  files: 'web/**/*'
  urlPath: '/static/'

# Load only *.graphql files from src/schema/
graphqlSchema:
  files: 'src/schema/*.graphql'

# Exclude a subdirectory
static:
  files:
    source: 'web/**/*'
    ignore: 'web/images/**'
```

> Note: Unlike the Extension API, the Plugin API `files` object does **not** support an `only` field. Use `entryEvent.entryType` or `entryEvent.eventType` in your handler instead.

### Timeouts

The system default timeout is **30 seconds**. If `handleApplication()` does not complete within this time, the component loader throws an error to prevent indefinite hanging.

Plugins can override the system default by exporting a `defaultTimeout`:

```typescript
export const defaultTimeout = 60_000; // 60 seconds
```

Users can override at the application level in `config.yaml`:

```yaml
customPlugin:
  package: '@org/custom-plugin'
  files: 'foo.js'
  timeout: 45_000 # 45 seconds
```

## TypeScript Support

All classes and types are exported from the `harper` package:

```typescript
import type { Scope, Config } from 'harper';
```

## API Reference

### Function: `handleApplication(scope: Scope): void | Promise<void>`

The only required export from a plugin module. The component loader executes it sequentially across all worker threads. It can be async and is awaited.

Avoid event-loop-blocking operations within `handleApplication()`.

```typescript
export function handleApplication(scope: Scope) {
	// Use scope to access config, resources, server, etc.
}
```

Parameters:

- `scope` — [`Scope`](#class-scope) — Access to the application's configuration, resources, and APIs

The `handleApplication()` method cannot coexist with Extension API methods (`start`, `handleFile`, etc.). Defining both will throw an error.

### Class: `Scope`

Extends [`EventEmitter`](https://nodejs.org/docs/latest/api/events.html#class-eventemitter)

The central object passed to `handleApplication()`. Provides access to configuration, file entries, server APIs, and logging.

#### Events

- **`'close'`** — Emitted after `scope.close()` is called. Harper calls `scope.close()` itself on shutdown and on graceful restart, so this is the hook for application teardown — see [Cleanup on Shutdown](#cleanup-on-shutdown)
- **`'error'`** — `error: unknown` — An error occurred
- **`'ready'`** — Emitted when the Scope is ready after loading the config file

#### `scope.handleEntry([files][, handler])` {#scopehandleentry}

Returns an [`EntryHandler`](#class-entryhandler) for watching and processing file system entries.

Overloads:

- `scope.handleEntry()` — Returns the default `EntryHandler` based on `files`/`urlPath` in `config.yaml`
- `scope.handleEntry(handler)` — Returns default `EntryHandler`, registers `handler` for the `'all'` event
- `scope.handleEntry(files)` — Returns a new `EntryHandler` for custom `files` config
- `scope.handleEntry(files, handler)` — Returns a new `EntryHandler` with a custom `'all'` event handler

Example:

```js
export function handleApplication(scope) {
	// Default handler with inline callback
	scope.handleEntry((entry) => {
		switch (entry.eventType) {
			case 'add':
			case 'change':
				// handle file add/change
				break;
			case 'unlink':
				// handle file deletion
				break;
		}
	});

	// Custom handler for specific files
	const tsHandler = scope.handleEntry({ files: 'src/**/*.ts' });
}
```

#### `scope.requestRestart()`

Request a Harper restart. Does not restart immediately—indicates to the user that a restart is required. Called automatically if no `scope.options.on('change')` handler is defined or if a required handler is missing.

#### `scope.resources`

Returns: `Map<string, Resource>` — Currently loaded [Resource](../resources/resource-api.md) instances.

#### `scope.server`

Returns: `server` — Reference to the [server](../http/api.md) global API. Use for registering HTTP middleware, custom networking, etc.

#### `scope.options`

Returns: [`OptionsWatcher`](#class-optionswatcher) — Access to the application's configuration options. Emits `'change'` events when the plugin's section of the config file is modified.

#### `scope.logger`

Returns: `logger` — Scoped logger instance. Recommended over the global `logger`.

#### `scope.name`

Returns: `string` — The plugin name as configured in `config.yaml`.

#### `scope.directory`

Returns: `string` — Root directory of the application component (where `config.yaml` lives).

#### `scope.close()`

<VersionBadge type="changed" version="v5.1.3" />

Closes all associated entry handlers and the `scope.options` instance, emits `'close'`, and removes all listeners. Promises returned by `'close'` listeners are awaited before it resolves.

Plugins rarely call this directly. Harper calls it on each worker thread during shutdown and graceful restart — see [Cleanup on Shutdown](#cleanup-on-shutdown).

### Class: `OptionsWatcher`

Extends [`EventEmitter`](https://nodejs.org/docs/latest/api/events.html#class-eventemitter)

Provides reactive access to plugin configuration options, scoped to the specific plugin within the application's `config.yaml`.

#### Events

- **`'change'`** — `key: string[], value: ConfigValue, config: ConfigValue` — Emitted when a config option changes
  - `key` — Option key split into parts (e.g., `foo.bar` → `['foo', 'bar']`)
  - `value` — New value
  - `config` — Entire plugin configuration object

- **`'close'`** — Emitted when the watcher is closed
- **`'error'`** — `error: unknown` — An error occurred
- **`'ready'`** — `config: ConfigValue | undefined` — Emitted on initial load and after `'remove'` recovery
- **`'remove'`** — Config was removed (file deleted, config key deleted, or parse failure)

Example:

```typescript
export function handleApplication(scope) {
	scope.options.on('change', (key, value, config) => {
		if (key[0] === 'files') {
			scope.logger.info(`Files option changed to: ${value}`);
		}
	});
}
```

#### `options.get(key: string[]): ConfigValue | undefined`

Get the value at a specific config key path.

#### `options.getAll(): ConfigValue | undefined`

Get the entire plugin configuration object.

#### `options.getRoot(): Config | undefined`

Get the root `config.yaml` object (all plugins and options).

#### `options.close()`

Close the watcher, preventing further events.

### Class: `EntryHandler`

Extends [`EventEmitter`](https://nodejs.org/docs/latest/api/events.html#class-eventemitter)

Created by [`scope.handleEntry()`](#scopehandleentry). Watches file system entries matching a `files` glob pattern and emits events as files are added, changed, or removed.

#### Events

- **`'all'`** — `entry: FileEntryEvent | DirectoryEntryEvent` — Emitted for all entry events (add, change, unlink, addDir, unlinkDir). This is the event registered by the `scope.handleEntry(handler)` shorthand.
- **`'add'`** — `entry: AddFileEvent` — File created or first seen
- **`'addDir'`** — `entry: AddDirectoryEvent` — Directory created or first seen
- **`'change'`** — `entry: ChangeFileEvent` — File modified
- **`'close'`** — Entry handler closed
- **`'error'`** — `error: unknown` — An error occurred
- **`'ready'`** — Handler ready and watching
- **`'unlink'`** — `entry: UnlinkFileEvent` — File deleted
- **`'unlinkDir'`** — `entry: UnlinkDirectoryEvent` — Directory deleted

Recommended pattern for handling all events:

```js
scope.handleEntry((entry) => {
	switch (entry.eventType) {
		case 'add':
			break;
		case 'change':
			break;
		case 'unlink':
			break;
		case 'addDir':
			break;
		case 'unlinkDir':
			break;
	}
});
```

#### `entryHandler.name`

Returns: `string` — Plugin name.

#### `entryHandler.directory`

Returns: `string` — Application root directory.

#### `entryHandler.close()`

Closes the entry handler, removing all listeners. Can be restarted with `update()`.

#### `entryHandler.update(config: FilesOption | FileAndURLPathConfig)`

Update the handler to watch new entries. Closes and recreates the underlying watcher while preserving existing listeners. Returns a Promise that resolves when the updated handler is ready.

### Interfaces

#### `FilesOption`

`string | string[] | FilesOptionObject`

#### `FilesOptionObject`

- `source` — `string | string[]` _(required)_ — Glob pattern(s)
- `ignore` — `string | string[]` _(optional)_ — Patterns to exclude

#### `FileAndURLPathConfig`

- `files` — `FilesOption` _(required)_
- `urlPath` — `string` _(optional)_

#### `BaseEntry`

- `stats` — `fs.Stats | undefined` — File system stats (may be absent depending on event, entry type, and platform)
- `urlPath` — `string` — URL path of the entry, resolved from `files` + `urlPath` options
- `absolutePath` — `string` — Absolute filesystem path

#### `FileEntry`

Extends `BaseEntry`

- `contents` — `Buffer` — File contents (automatically read)

#### `EntryEvent`

Extends `BaseEntry`

- `eventType` — `string` — Type of event
- `entryType` — `'file' | 'directory'` — Entry type

#### `AddFileEvent`

- `eventType: 'add'`
- `entryType: 'file'`
- Extends `EntryEvent`, `FileEntry`

#### `ChangeFileEvent`

- `eventType: 'change'`
- `entryType: 'file'`
- Extends `EntryEvent`, `FileEntry`

#### `UnlinkFileEvent`

- `eventType: 'unlink'`
- `entryType: 'file'`
- Extends `EntryEvent`, `FileEntry`

#### `FileEntryEvent`

`AddFileEvent | ChangeFileEvent | UnlinkFileEvent`

#### `AddDirectoryEvent`

- `eventType: 'addDir'`
- `entryType: 'directory'`
- Extends `EntryEvent`

#### `UnlinkDirectoryEvent`

- `eventType: 'unlinkDir'`
- `entryType: 'directory'`
- Extends `EntryEvent`

#### `DirectoryEntryEvent`

`AddDirectoryEvent | UnlinkDirectoryEvent`

#### `Config`

`{ [key: string]: ConfigValue }`

Parsed representation of `config.yaml`.

#### `ConfigValue`

`string | number | boolean | null | undefined | ConfigValue[] | Config`

#### `onEntryEventHandler`

`(entryEvent: FileEntryEvent | DirectoryEntryEvent): void`

Function signature for the `'all'` event handler passed to `scope.handleEntry()`.

## Cleanup on Shutdown

Harper calls `scope.close()` on every application scope when a worker thread shuts down, which emits the [`'close'`](#events) event. This happens both when Harper is stopping and on a graceful restart — including the automatic worker restarts triggered by `harper dev` file watching and by the `restart` operation.

Listen for `'close'` to finish work that must complete, or be acknowledged outside the process, before the thread goes away: flushing buffered writes, deregistering from an external service or registry, releasing a distributed lock or lease, or closing a connection whose remote side expects a graceful goodbye. Node tears down timers and sockets on its own when a thread exits, so purely in-process resources need no `'close'` listener.

```js
export function handleApplication(scope) {
	const service = startService();
	scope.once('close', async () => {
		await service.close();
	});
}
```

Use `scope.once()` rather than `scope.on()` — closing is a one-time lifecycle event, so `once()` expresses that intent.

Notes on the shutdown sequence:

- **Async listeners are awaited.** Returning a promise from a `'close'` listener is supported: Harper awaits it before the worker exits, so cleanup completes rather than racing the process exit.
- **Cleanup is bounded.** Shutdown has a backstop timer (10 seconds by default, longer under `harper dev`), after which the worker is force-exited even if a `'close'` listener is still running. Keep teardown short and avoid unbounded work such as retry loops without a deadline.
- **A failed listener does not block shutdown.** If a `'close'` listener throws or rejects, Harper logs the error and continues shutting down. Because all listeners are awaited together, one that rejects also stops Harper from waiting on the others still in flight — so handle errors inside the listener rather than letting them escape.
- **Each worker cleans up independently.** `handleApplication()` runs on every worker thread, so a `'close'` listener registered there runs once per worker. Cleanup that must happen only once for the whole instance needs its own coordination.

Handlers created with [`scope.handleEntry()`](#scopehandleentry) and the [`scope.options`](#scopeoptions) watcher are closed by Harper automatically; a `'close'` listener is only needed for resources the plugin manages itself.

## Example: Static File Server Plugin

A simplified form of the built-in `static` plugin demonstrating key Plugin API patterns. For a complete, production example of this API in action, read the plugin's open-source implementation in [`server/static.ts`](https://github.com/HarperFast/harper/blob/main/server/static.ts).

```js
export function handleApplication(scope) {
	const staticFiles = new Map();

	// React to config changes
	scope.options.on('change', (key, value, config) => {
		if (key[0] === 'files' || key[0] === 'urlPath') {
			staticFiles.clear();
			scope.logger.info(`Static files reset due to change in ${key.join('.')}`);
		}
	});

	// Handle file entry events
	scope.handleEntry((entry) => {
		if (entry.entryType === 'directory') return;

		switch (entry.eventType) {
			case 'add':
			case 'change':
				staticFiles.set(entry.urlPath, entry.contents);
				break;
			case 'unlink':
				staticFiles.delete(entry.urlPath);
				break;
		}
	});

	// Register HTTP middleware
	scope.server.http(
		(req, next) => {
			if (req.method !== 'GET') return next(req);

			const file = staticFiles.get(req.pathname);
			return file ? { statusCode: 200, body: file } : { statusCode: 404, body: 'File not found' };
		},
		{ runFirst: true }
	);
}
```

## Version History

- **v4.6.0** — Plugin API introduced (experimental)
- **v4.7.0** — Further improvements to the Plugin API
- **v5.1.3** — Shutdown awaits promises returned by `'close'` listeners; earlier releases emitted `'close'` without waiting, so async cleanup could be cut off by the worker exiting
