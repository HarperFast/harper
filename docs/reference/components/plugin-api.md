---
title: Plugin API
---

<!-- Source: versioned_docs/version-4.7/reference/components/plugins.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (Plugin API introduced) -->
<!-- Source: release-notes/v4-tucker/4.7.0.md (further plugin API improvements) -->

# Plugin API

<VersionBadge version="v4.6.0" /> (experimental)

> The Plugin API is **experimental**. It is the recommended approach for building new extensions, and is intended to replace the [Extension API](./extension-api.md) in the future. Both systems are supported simultaneously.

The Plugin API is a new iteration of the extension system that simplifies the interface. Instead of defining multiple methods (`start`, `startOnMainThread`, `handleFile`, `setupFile`, `handleDirectory`, `setupDirectory`), a plugin exports a single `handleApplication` method.

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
- `urlPath` — `string` _(optional)_ — Base URL path prepended to resolved `files` entries. Cannot contain `..`. If starts with `./` or is `.`, the plugin name is automatically prepended
- `timeout` — `number` _(optional)_ — Timeout in milliseconds for plugin operations. Takes precedence over the plugin's `defaultTimeout` and the system default (30 seconds)

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

All classes and types are exported from the `harperdb` package:

```typescript
import type { Scope, Config } from 'harperdb';
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

- **`'close'`** — Emitted after `scope.close()` is called
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

Closes all associated entry handlers and the `scope.options` instance, emits `'close'`, and removes all listeners.

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

## Example: Static File Server Plugin

A simplified form of the built-in `static` extension demonstrating key Plugin API patterns:

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
