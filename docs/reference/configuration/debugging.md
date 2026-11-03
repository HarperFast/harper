---
title: Worker Thread Debugging
---

# Worker Thread Debugging

Harper runs as a main thread plus a pool of worker threads (configurable via `threads.count`). The `threads.debug` option exposes the Node.js inspector on each thread so you can attach Chrome DevTools, VS Code, or any [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP) client to step through component code, inspect heap state, or capture CPU profiles.

For the worker thread architecture, see [Architecture Overview](../database/overview.md#architecture-overview).

## Enabling the Debugger

The simplest form starts the inspector on the main thread at the default port (`9229`):

```yaml
threads:
  debug: true
```

For per-thread debugging, expand to an object:

```yaml
threads:
  debug:
    startingPort: 9229
    host: 127.0.0.1
    waitForDebugger: false
```

| Property          | Type      | Default     | Description                                                                                                                                                  |
| ----------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `port`            | `integer` | `9229`      | Port for the main thread inspector. Use this when you only need to debug startup or main-thread behavior.                                                    |
| `startingPort`    | `integer` | _(none)_    | When set, each worker thread gets a sequential inspector port starting from this value. Thread N uses port `startingPort + N`. The main thread keeps `port`. |
| `host`            | `string`  | `127.0.0.1` | Interface the inspector binds to. Leave on loopback in production; use `0.0.0.0` only when tunneling over SSH or operating in a trusted network.             |
| `waitForDebugger` | `boolean` | `false`     | Pause each thread at startup until a debugger attaches. Useful for catching bugs that occur during component initialization.                                 |

## Attaching Chrome DevTools

1. Set `threads.debug.startingPort: 9230` (so worker threads use 9230, 9231, … and the main thread keeps 9229).
2. Start Harper.
3. Open `chrome://inspect` in Chrome.
4. Click **Configure** and add `localhost:9229`, `localhost:9230`, … for each thread you want to inspect.
5. The threads appear under **Remote Target**. Click **inspect** to open DevTools for that thread.

## Attaching VS Code

Add an entry per thread to `.vscode/launch.json`. The example below attaches to the main thread and two workers:

```json
{
	"version": "0.2.0",
	"configurations": [
		{ "type": "node", "request": "attach", "name": "Harper main", "port": 9229 },
		{ "type": "node", "request": "attach", "name": "Harper worker 1", "port": 9230 },
		{ "type": "node", "request": "attach", "name": "Harper worker 2", "port": 9231 }
	],
	"compounds": [
		{ "name": "Harper (all threads)", "configurations": ["Harper main", "Harper worker 1", "Harper worker 2"] }
	]
}
```

Run the compound configuration to attach to every thread at once.

## Debugging Remote Instances

Inspector ports must remain on `127.0.0.1` in production. To reach them from a developer workstation, tunnel each port over SSH:

```bash
ssh -L 9229:127.0.0.1:9229 \
    -L 9230:127.0.0.1:9230 \
    -L 9231:127.0.0.1:9231 \
    harper.example.com
```

Then point Chrome DevTools or VS Code at `localhost:9229–9231` as if they were local.

## Waiting for the Debugger at Startup

When a bug only reproduces during component initialization, set `waitForDebugger: true`. Each thread starts paused on its first line until a debugger attaches and resumes execution. This is also the safest way to debug an initialization sequence that completes too quickly to manually attach.

```yaml
threads:
  debug:
    startingPort: 9230
    waitForDebugger: true
```

**Health checks and load balancers** will fail while the threads are paused — only enable `waitForDebugger` in dedicated debug environments.

## Heap Snapshots Near the Limit

### `threads.heapSnapshotNearLimit`

Type: `boolean`

Default: `false`

When the V8 heap approaches the limit set by `threads.maxHeapMemory`, the thread writes a `.heapsnapshot` file to the Harper root directory before the process exits with an out-of-memory error. The snapshot can be loaded into Chrome DevTools (Memory tab → **Load profile**) to identify retained objects responsible for the leak.

```yaml
threads:
  maxHeapMemory: 1024
  heapSnapshotNearLimit: true
```

Snapshots can be large (often a sizable fraction of the heap limit) and writing them blocks the thread briefly — leave disabled for normal operation and enable only when investigating an out-of-memory pattern.

## Source Maps in Stack Traces

<VersionBadge type="changed" version="v5.4.0" />

Stack traces from Harper's core point at its compiled JavaScript under `dist/`. To map them back to the TypeScript sources, enable source maps with the Node.js `--enable-source-maps` flag, set through `NODE_OPTIONS`:

```bash
NODE_OPTIONS=--enable-source-maps harper
```

Harper passes the setting on to every worker thread (not under Bun). Source maps cost memory: Node.js keeps every loaded module's source map on every thread, several megabytes per thread.

The setting applies to modules Node.js loads itself: Harper's core, application code loaded natively (for example with `applications.moduleLoader: native`), and the npm packages that Harper loads natively (under the default `applications.dependencyLoader: auto`, every package that does not depend on Harper; see [Dependency Loading](../components/module-loading.md#dependency-loading)). Harper's VM-based loaders (`vm-current-context`, the default, as well as `vm` and `compartment`) do not apply source maps either way.

On Fabric clusters that Harper hosts, you do not set the process environment, so `NODE_OPTIONS` is not available there. Stack traces from application code on the default loader are the same either way; those from Harper's core and from natively loaded packages stay unmapped.

Before v5.4.0, source maps were always enabled.

## Related

- [Configuration Options — `threads`](./options.md#threads) — full thread configuration reference
- [Architecture Overview](../database/overview.md#architecture-overview) — how worker threads fit into Harper
- [Node.js Inspector documentation](https://nodejs.org/en/learn/getting-started/debugging) — debugger protocol details
- [Node.js `--enable-source-maps`](https://nodejs.org/api/cli.html#--enable-source-maps) — how Node.js applies source maps to stack traces
