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

Whether you reach them as globals or as `harper` imports, `tables`, `databases`, and the other APIs are the **same live, process-wide objects** — Harper runs as a single process, so a record written through one component is immediately visible to every other. The automatic link points `harper` at the **running** installation (not a separately-installed copy), so `import { tables } from 'harper'` resolves to that live runtime from any module Harper loads. Application module contexts are seeded from the same process globals, not given an isolated set of these objects.

This includes bundler-built code. A Vite **server-side-render** entry, for example, can read data straight from Harper and render it into the HTML (no client-side fetch):

```typescript
import { tables } from 'harper';

export async function render(url: string): Promise<string> {
	const product = await tables.Product.get(idFromUrl(url));
	return renderToString(/* <App product={product} /> */);
}
```

When bundling for SSR, keep `harper` external so it resolves to the runtime instead of being bundled (symlinked dependencies are not reliably auto-externalized) — e.g. `ssr: { external: ['harper'] }` in `vite.config`.

## TypeScript Support

Harper runs `.ts` files directly via Node.js's built-in [type stripping](https://nodejs.org/api/typescript.html#type-stripping). No build step or transpiler is required.

Requirements and conventions:

- **Node.js 22.6 or later.** Type stripping is unavailable on earlier versions.
- **Use the `.ts` extension on the source files** referenced from `config.yaml`. The `jsResource` plugin loads `.js` and `.ts` files; point its `files` glob at the `.ts` files you want loaded:
  ```yaml
  jsResource:
    files: 'resources/*.ts'
  ```
- **Use explicit `.ts` extensions in imports** between local modules. Node's loader does not resolve `'./helper'` to `'./helper.ts'`:
  ```typescript
  import { helper } from './helper.ts';
  ```
- **Only type-stripping is performed.** Enum values, namespaces with runtime semantics, and other features that require code transformation are not supported — declarations and type annotations are simply removed.

Type imports from the `harper` package work as usual:

```typescript
import { type RequestTargetOrId, Resource, tables } from 'harper';

export class MyResource extends Resource {
	async get(target?: RequestTargetOrId): Promise<{ message: string }> {
		return { message: 'Hello from TS' };
	}
}
```

## Harper API

The following objects and functions are available as exports from the `harper` package (and also available as global variables).

### `tables`

An object whose properties are the tables in the default database (`data`). Each table defined in `schema.graphql` is accessible as a property and implements the Resource API.

See [Database API](../database/api.md) for full reference.

:::note Server-side table reads run in a trusted context
Calls to `tables.X.get()`, `tables.X.search()`, and equivalent `databases.<database>.<table>` methods from within resource code execute in a **trusted system context** and do **not** re-apply the target table's `allowRead` guard or role-level `attribute_permissions`. This is by design — server-side code is responsible for its own authorization checks. A computed attribute or custom resource that cross-reads a protected table can return raw data regardless of the caller's role. Do not expose protected data through a computed attribute when access depends on the caller. Instead, use a custom resource and apply authorization explicitly (e.g. call `this.getCurrentUser()` in a `Resource` method, or use `getUser()`, and enforce the relevant restrictions before returning the data).
:::

### `databases`

An object containing all databases defined in Harper. Each database is an object of its tables — `databases.data` is always equivalent to `tables`.

See [Database API](../database/api.md) for full reference.

### `transaction(fn)` {#transaction}

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

### `secrets`

A read-only, name→value map of the scoped secrets granted to the current component (plus any `process.env`-resolved values it declared). Read secrets from the encrypted [secrets store](../security/secrets.md) without them landing in `process.env`:

```javascript
import { secrets } from 'harper';

const { STRIPE_KEY } = secrets;
```

A module-top-level destructure is the recommended idiom — it binds correctly under every component loader. See [Secrets](../security/secrets.md) for full reference.

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

### Current Working Directory

Harper has a multi-threaded server architecture and uses the harper data root path as the current working directory. Components should not and cannot change the current working directory, and must not use `process.chdir()` or any package that does.

## Child Processes

Harper substitutes its own `child_process` module into components that need to launch a helper binary or a sidecar process. The substitute adds two things on top of Node's API: a command allowlist, and a node-wide single-process lock keyed by a name you supply.

```javascript
import { spawn } from 'node:child_process';

const agent = spawn('datadog-agent', ['run'], {
	name: 'datadog-agent',
	version: 3,
});
```

### Which imports get the substitute

The substitution happens in Harper's module loader, so it only reaches code that loader handles:

| How the module is reached                                                                                                                                          | What you get                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `import` from component source under `applications.moduleLoader: vm-current-context` (the default) or `vm`                                                         | Harper's constrained module |
| Dynamic `import('node:child_process')` from component source under those same loaders, including from CommonJS                                                     | Harper's constrained module |
| `require('node:child_process')`                                                                                                                                    | Node's unmodified module    |
| Any import under `applications.moduleLoader: compartment`                                                                                                          | Node's unmodified module    |
| Any import under `applications.moduleLoader: native`                                                                                                               | Node's unmodified module    |
| A dependency loaded by the native loader — with the default `applications.dependencyLoader: auto` that is any package which does not list `harper` as a dependency | Node's unmodified module    |

Two consequences are worth planning around. A supervisor factored into an npm package that does not depend on `harper` receives the real `child_process`: no allowlist, no lock, and one child per worker thread rather than one per node. And under `compartment` the substitute is bypassed entirely — that loader resolves built-ins through Node directly, so the allowlist, the mandatory `name`, the single-process lock, and the `execSync` block all disappear together. Keep process-spawning code in component source, reached with `import`, under one of the VM loaders.

### Which functions are usable

| Function   | Status                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `spawn`    | Supported. Subject to the allowlist and the `name` lock.                                       |
| `execFile` | Supported. Subject to the allowlist and the `name` lock.                                       |
| `fork`     | Supported and exempt from the allowlist, since it launches Node itself. Still requires `name`. |
| `exec`     | Not usable. See below.                                                                         |
| `execSync` | Always throws. Harper does not permit synchronous spawning.                                    |

Nothing else Node's `child_process` exports is present. `spawnSync`, `execFileSync`, `ChildProcess`, and the rest are absent from the substituted module, so a named import of one fails when the module is linked rather than at the call site.

The substitute takes `(command, args, options, callback)` positionally for every wrapped function, but Node's `exec` signature is `exec(command[, options][, callback])`. So `exec('ffmpeg -version', { name: 'ffmpeg' })` puts the options object in the `args` slot and throws for a missing `name`, while shifting it into the `options` slot to satisfy that check produces a call Node's own `exec` rejects with `ERR_INVALID_ARG_TYPE`. Use `execFile` (whose signature does line up) or `spawn` instead.

### Allowlist

Every call except `fork` is checked against [`applications.allowedSpawnCommands`](../configuration/options.md#applications) before anything else:

- The check is an exact match on the first space-separated token of `command`. `'node'` matches an allowlisted `node`; `'/usr/local/bin/node'` does not, and a path containing a space can never match.
- The list is read once at startup. Changing it requires a restart.
- Because only the first token is matched, the allowlist is not an argument or injection barrier. If you pass `shell: true`, everything after the first token reaches a shell unchecked — treat the command string as trusted input regardless of the allowlist.

### One process per node: the `name` option

Harper runs a pool of worker threads, and component code runs on each of them. Without coordination, a component that spawns a sidecar would start one per thread. Harper prevents that with a PID-file lock, which is why `name` is mandatory:

- **`name` (string, required).** Spawning without it throws, on `fork` as well as the allowlisted functions.
- The lock file is `<rootPath>/pids/<name>.pid`. Line 1 is the child's PID; line 2, when `version` was passed, is the version.
- Exactly one caller wins the lock and spawns a real child process. Every other caller — other threads, and later calls with the same name — receives an `ExistingProcessWrapper` for the already-running process.
- The name is the whole key. It is not namespaced per component and it is interpolated into the path unsanitized, so two independently installed components that both pick `agent` share one lock and adopt each other's process, and a name containing `../` places the lock file outside `<rootPath>/pids/` entirely. Use a literal, path-safe name prefixed with your component's name — never one derived from configuration or any other input.
- When the real child exits, the thread that spawned it removes the PID file, so the next spawn call starts a fresh process.
- If a PID file survives an unclean shutdown, Harper recovers it by checking whether the recorded PID is still alive: if it is not, the stale file is removed and the next caller spawns normally. If the operating system has recycled that PID onto an unrelated process, Harper treats that process as the sidecar: it adopts it when you pass no `version`, and sends it `SIGTERM` when the `version` you pass does not match the recorded one. Another reason to keep the name unique.

### Replacing a running process: the `version` option

<VersionBadge version="v5.0.2" />

`version` lets a component replace a process it started earlier — after an upgrade, for example — instead of adopting it.

- **`version` must be an integer.** Line 2 of the PID file is parsed with `parseInt`, and the comparison is a strict `!==` against the value you pass. A string `'3'` never equals the parsed `3`, so every call kills the running child and respawns it, forever. There is no validation of this; pass a number.
- The comparison is equality, not ordering: a version lower than the recorded one also triggers replacement.
- On a mismatch Harper signals the running process (`SIGTERM`), removes the PID file, and re-acquires the lock so the new version spawns.
- Omitting `version` means "adopt whatever is running under this name".

The handoff is not graceful, and replacement is the least robust part of this contract. Harper does not wait for the outgoing process to exit before starting the replacement, so a sidecar that holds a listening socket or an exclusive file lock must tolerate an overlapping predecessor. The outgoing process's exit handler also removes the PID file by path rather than by PID, so it can delete the lock the replacement just wrote — after which a later spawn call sees no lock and starts a second process alongside it. Prefer restarting the component (or the node) over relying on in-place version replacement for anything that cannot tolerate a duplicate.

### What `spawn` returns

The lock winner gets a real [`ChildProcess`](https://nodejs.org/api/child_process.html#class-childprocess). Everyone else gets an `ExistingProcessWrapper`, which is deliberately narrow:

| Member          | Notes                                                       |
| --------------- | ----------------------------------------------------------- |
| `pid`           | PID of the process that is actually running                 |
| `kill(signal?)` | Signals that process; returns `false` if it is already gone |
| `unref()`       | Stops the liveness poll — see below                         |
| `'exit'` event  | Emitted with `(null, null)` once the process is gone        |

It does **not** have `stdout`, `stderr`, `stdin`, or `spawnargs` — those properties are simply absent, so reading one yields `undefined` and using it (`child.stdout.on(...)`) throws a `TypeError` on exactly the threads that lost the race, which is most of them. A component that reads the child's output must do so only on the thread that owns the real `ChildProcess`. Because `spawnargs` reads as `undefined` rather than throwing, it is the practical way to tell the two apart. It tests an internal detail rather than a discriminator Harper promises: it works only because the wrapper does not define `spawnargs` today, and a release that added the property would silently send every losing thread down the real-`ChildProcess` branch. Re-check it when you upgrade.

```javascript
const child = spawn('datadog-agent', ['run'], { name: 'datadog-agent', version: 3 });

if (child.spawnargs) {
	child.stdout.on('data', (chunk) => logger.info(chunk.toString()));
} else {
	child.unref();
}
```

The wrapper detects the process going away by polling it once a second with a `setInterval` that Harper does not unref, so a thread that never calls `unref()` keeps its event loop alive and delays shutdown. That same interval is the only source of the `'exit'` event, so the two members are mutually exclusive: once you call `unref()`, the wrapper will never emit `'exit'`. Pick one — watch the process, or release the timer.
