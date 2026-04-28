---
title: Extension API
---

<!-- Source: versioned_docs/version-4.7/reference/components/extensions.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (new extension API with dynamic reloading) -->

# Extension API

> As of Harper v4.6, a new iteration of the extension system called **Plugins** was released. Plugins simplify the API and are recommended for new extension development. See the [Plugin API](./plugin-api.md) reference. Both extensions and plugins are supported; extensions are not yet deprecated.

Extensions are components that provide reusable building blocks for applications. There are two key types:

- **Resource Extensions** — Handle specific files or directories
- **Protocol Extensions** — More advanced extensions that can return a Resource Extension; primarily used for implementing higher-level protocols and custom networking handlers

An extension is distinguished from a plain component by implementing one or more of the Resource Extension or Protocol Extension API methods.

## Declaring an Extension

All extensions must define a `config.yaml` with an `extensionModule` option pointing to the extension source code (path resolves from the module root directory):

```yaml
extensionModule: ./extension.js
```

If written in TypeScript or another compiled language, point to the built output:

```yaml
extensionModule: ./dist/index.js
```

## Resource Extension

A Resource Extension processes specific files or directories. It is comprised of four function exports:

| Method              | Thread             | Timing                    |
| ------------------- | ------------------ | ------------------------- |
| `handleFile()`      | All worker threads | Executed on every restart |
| `handleDirectory()` | All worker threads | Executed on every restart |
| `setupFile()`       | Main thread only   | Once, at initial start    |
| `setupDirectory()`  | Main thread only   | Once, at initial start    |

> **Important**: `harper restart` only restarts worker threads. Code in `setupFile()` and `setupDirectory()` runs only when Harper fully shuts down and starts again—not on `deploy` or `restart`.

`handleFile()` and `setupFile()` have identical signatures. `handleDirectory()` and `setupDirectory()` have identical signatures.

### Resource Extension Configuration

Resource Extensions can be configured with `files` and `urlPath` options in `config.yaml`:

- `files` — `string | string[] | FilesOptionObject` _(required)_ — Glob pattern(s) determining which files and directories are resolved. Harper uses [fast-glob](https://github.com/mrmlnc/fast-glob) for matching.
  - `source` — `string | string[]` _(required when object form)_ — Glob pattern string(s)
  - `only` — `'all' | 'files' | 'directories'` _(optional)_ — Restrict matching to a single entry type. Defaults to `'all'`
  - `ignore` — `string[]` _(optional)_ — Patterns to exclude from matches

- `urlPath` — `string` _(optional)_ — Base URL path prepended to resolved entries
  - Starting with `./` (e.g., `'./static/'`) prepends the component name to the URL path
  - Value of `.` uses the component name as the base path
  - `..` is invalid and causes an error
  - Leading/trailing slashes are handled automatically (`/static/`, `static/`, and `/static` are equivalent)

Examples:

```yaml
# Serve HTML files from web/ at the /static/ URL path
static:
  files: 'web/*.html'
  urlPath: 'static'

# Load all GraphQL schemas from src/schema/
graphqlSchema:
  files: 'src/schema/*.graphql'

# Match files in web/, excluding web/images/
static:
  files:
    source: 'web/**/*'
    ignore: ['web/images']

# Match only files (not directories)
myExtension:
  files:
    source: 'dir/**/*'
    only: 'files'
```

### Resource Extension API

At minimum, a Resource Extension must implement one of the four methods. As a standalone extension, export them directly:

```js
// ESM
export function handleFile() {}
export function setupDirectory() {}

// CJS
function handleDirectory() {}
function setupFile() {}
module.exports = { handleDirectory, setupFile };
```

When returned by a Protocol Extension, define them on the returned object:

```js
export function start() {
	return {
		handleFile() {},
	};
}
```

#### `handleFile(contents, urlPath, absolutePath, resources): void | Promise<void>`

#### `setupFile(contents, urlPath, absolutePath, resources): void | Promise<void>`

Process individual files. Can be async.

Parameters:

- `contents` — `Buffer` — File contents
- `urlPath` — `string` — Recommended URL path for the file
- `absolutePath` — `string` — Absolute filesystem path
- `resources` — `Object` — Currently loaded resources

#### `handleDirectory(urlPath, absolutePath, resources): boolean | void | Promise<boolean | void>`

#### `setupDirectory(urlPath, absolutePath, resources): boolean | void | Promise<boolean | void>`

Process directories. Can be async.

If the function returns a truthy value, the component loading sequence ends and no other entries in the directory are processed.

Parameters:

- `urlPath` — `string` — Recommended URL path for the directory
- `absolutePath` — `string` — Absolute filesystem path
- `resources` — `Object` — Currently loaded resources

## Protocol Extension

A Protocol Extension is a more advanced form of Resource Extension, primarily used for implementing higher-level protocols (e.g., building and running a Next.js project) or adding custom networking handlers.

Protocol Extensions use the [`server`](../http/api.md) global API for custom networking.

### Protocol Extension Configuration

In addition to the `files`, `urlPath`, and `package` options, Protocol Extensions accept any additional configuration options defined under the extension name in `config.yaml`. These options are passed through to the `options` object of `start()` and `startOnMainThread()`.

Many protocol extensions accept `port` and `securePort` options for configuring networking handlers.

Example using `@harperdb/nextjs`:

```yaml
'@harperdb/nextjs':
  package: '@harperdb/nextjs'
  files: './'
  prebuilt: true
  dev: false
```

### Protocol Extension API

A Protocol Extension defines up to two methods:

| Method                | Thread             | Timing                    |
| --------------------- | ------------------ | ------------------------- |
| `start()`             | All worker threads | Executed on every restart |
| `startOnMainThread()` | Main thread only   | Once, at initial start    |

Both methods receive the same `options` object and can return a Resource Extension (an object with any of the Resource Extension methods).

#### `start(options): ResourceExtension | Promise<ResourceExtension>`

#### `startOnMainThread(options): ResourceExtension | Promise<ResourceExtension>`

Parameters:

- `options` — `Object` — Extension configuration options from `config.yaml`

Returns: An object implementing any of the Resource Extension methods

## Version History

- **v4.2.0** — Extension system introduced as part of the component architecture
- **v4.6.0** — New extension API with support for dynamic reloading; Plugin API introduced as the recommended alternative
