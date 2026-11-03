---
title: Module Loading
---

# Module Loading

<VersionBadge version="v5.0.0" />

By default, Harper loads each application's JavaScript through Node.js's [VM module API](https://nodejs.org/api/vm.html) rather than a plain `import()`. Every application gets its own module cache for the modules that loader handles, so two co-located applications can depend on different packages — or different versions of the same package — without colliding, and one application's module-scoped state is not visible to another. Dependencies that Harper routes to the native loader are the exception — see [Dependency Loading](#dependency-loading).

The loader is also what makes application context work. It gives each application a `harper` module scoped to that application: the `logger` it exports is tagged with the application name, and `config` reflects that application's own configuration. Under the VM loaders it additionally substitutes a constrained [`child_process`](./javascript-environment.md#child-processes) module.

Everything on this page is controlled by the `applications` section of `harper-config.yaml`:

```yaml
applications:
  lockdown: seal-after-load # seal-after-load (default) | seal | freeze-after-load | freeze | ses | none
  moduleLoader: vm-current-context # vm-current-context (default) | vm | native | compartment
  dependencyLoader: auto # auto (default) | app | native
  allowedDirectory: app # app (default) | any
  allowedSpawnCommands:
    - npm
    - node
  # allowedBuiltInModules: [] # if omitted, all Node.js built-ins are allowed
```

See [Configuration Options](../configuration/options.md#applications) for the settings in the context of the full configuration file.

:::note Defaults changed during v5

The defaults above are the ones a new install gets. Earlier v5 releases installed different values, and an upgrade keeps the values already in `harper-config.yaml`, so check that file before reasoning about which isolation model you are on:

| Setting            | v5.0.0 default | Current default                                                                |
| ------------------ | -------------- | ------------------------------------------------------------------------------ |
| `lockdown`         | `freeze`       | `seal-after-load`, since v5.4.0 (`freeze-after-load` from v5.0.2 through v5.3) |
| `moduleLoader`     | `vm`           | `vm-current-context`, since v5.1.0                                             |
| `allowedDirectory` | not available  | `app`, since v5.0.4                                                            |

The `moduleLoader` change matters most: on v5.0.x an application runs under `vm` with its own intrinsics, which is the mode that causes cross-context `instanceof` to fail.

:::

## Module Loader Modes

`moduleLoader` selects how application modules are loaded. The choice determines how much isolation you get, and it has consequences beyond isolation — notably whether application context is available at all, and whether Harper's constrained `child_process` reaches your code.

| Mode                           | Module cache | Intrinsics         | Global object  | Application context (`logger`, `config`) | Constrained `child_process` |
| ------------------------------ | ------------ | ------------------ | -------------- | ---------------------------------------- | --------------------------- |
| `vm-current-context` (default) | Per app\*    | Shared with Harper | Harper's       | Yes                                      | Yes                         |
| `vm`                           | Per app\*    | Separate per app   | Custom per app | Yes                                      | Yes                         |
| `native`                       | Shared       | Shared with Harper | Harper's       | No                                       | No                          |
| `compartment`                  | Per app\*    | SES-managed        | Custom per app | Yes                                      | No                          |

\* Applies to modules the application loader handles. Dependencies routed to the native loader share Node's module cache within the same worker; different workers have separate caches — see [Dependency Loading](#dependency-loading).

### `vm-current-context` (default)

<VersionBadge type="changed" version="v5.1.0" />

The VM module loader running in Harper's own context, and the default since v5.1.0 (v5.0.x defaulted to `vm`). Applications get their own module cache but share JavaScript intrinsics (`Object`, `Array`, `Promise`, and so on) with Harper.

Sharing intrinsics gives the best compatibility with packages that perform `instanceof` or other identity checks on values crossing the application/Harper boundary. It is the right choice for almost every application.

Applications in the same worker share its global object. An [isolated application](./applications.md#isolated-applications) runs in its own worker with separate globals. Also, [branched databases](./applications.md#branched-databases) make the application's `harper` imports of `databases` and `tables` resolve its forks, while the bare globals still reach the base databases. See [JavaScript Environment](./javascript-environment.md#module-formats) for the data-sharing rules.

### `vm`

The VM module loader running in a separate context per application, with its own intrinsics and a custom global object.

This is stronger isolation, but the separate intrinsics are a common source of subtle incompatibilities: cross-context `instanceof` returning `false`, locked-prototype mismatches, and similar. Choose it only if you specifically need per-application intrinsics.

### `native`

Standard Node.js `import()` with no VM loader. This restores pre-v5 behavior.

The trade-off is that application context is lost: there is no per-application module cache, no application-tagged `logger`, no per-application `config`, and no constrained `child_process`. Reach for it when the VM loader causes compatibility problems you cannot otherwise resolve — and consider whether [`dependencyLoader: native`](#dependency-loading) is the narrower fix first.

### `compartment`

SES `Compartment`-based loading, using the [`ses`](https://www.npmjs.com/package/ses) implementation of the proposed Compartment API. One compartment per application, created on demand because it is considerably heavier than the other modes.

Advanced; only needed for specialized sandboxing requirements.

:::warning Compartments bypass the constrained `child_process`

Compartments resolve built-in modules through Node directly. Harper's substituted `child_process` is not applied under this mode. The spawn allowlist, the mandatory `name` option, the single-process lock, and the `execSync` block all disappear together, so component code can spawn any command, once per worker thread. Keep process-spawning code under `vm-current-context` or `vm`.

:::

## Dependency Loading

`dependencyLoader` controls whether npm packages — dependencies installed from `package.json` — go through the application module loader or Node's.

- `auto` (default) — a package is loaded through the application loader only if it declares `harper` as a dependency. Everything else is loaded natively.
- `app` — always use the application module loader for packages.
- `native` — always use the native loader for packages, while first-party application source still goes through the VM loader.

The default is a deliberate compromise: packages that depend on `harper` want application context, and packages that do not are usually better off with Node's own loader. It has a consequence worth planning around — code factored out into an npm package that does not depend on `harper` will not receive Harper's constrained `child_process`, and so gets no allowlist, no lock, and one child process per worker thread rather than one per node. See [Child Processes](./javascript-environment.md#which-imports-get-the-substitute) for the full matrix.

`dependencyLoader: native` is the narrow fix when a package is incompatible with the VM loader. It keeps application context for your own code, unlike switching `moduleLoader` to `native`.

## Intrinsic Lockdown

<VersionBadge type="changed" version="v5.4.0" />

`lockdown` controls whether and when Harper locks the JavaScript intrinsics (the built-in constructors and their prototypes), which makes prototype pollution attacks harder. A typical pollution payload adds a property that every object then inherits, such as `__proto__.isAdmin`. Every mode except `none` blocks adding properties to the locked intrinsics (see [What is locked](#what-is-locked) for the exceptions). The modes differ in when they lock, and in whether code can still change a property that already exists.

| Mode                                                          | Locks by                                                                     | When                              | Add or delete a property | Assign to an existing writable property |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- | ------------------------ | --------------------------------------- |
| `seal-after-load` (default) <VersionBadge version="v5.4.0" /> | Sealing                                                                      | After all components have loaded  | Blocked                  | Allowed                                 |
| `seal` <VersionBadge version="v5.4.0" />                      | Sealing                                                                      | Before any application code loads | Blocked                  | Allowed                                 |
| `freeze-after-load`                                           | Freezing                                                                     | After all components have loaded  | Blocked                  | Blocked                                 |
| `freeze`                                                      | Freezing                                                                     | Before any application code loads | Blocked                  | Blocked                                 |
| `ses`                                                         | Full SES lockdown via the [`ses`](https://www.npmjs.com/package/ses) package | Before any application code loads | Blocked                  | Blocked                                 |
| `none`                                                        | Nothing                                                                      | -                                 | Allowed                  | Allowed                                 |

The table describes the locked intrinsics. The freeze modes leave `Function.prototype` extensible; see [What is locked](#what-is-locked).

`ses` is the strictest mode, and the most likely to break packages that change built-ins. Any other mode name, including a misspelled one, behaves like `freeze`.

### What is locked

The seal and freeze modes lock `Object`, `Array`, `Promise`, `BigInt`, `String`, `Number`, `Boolean`, `Symbol`, `RegExp`, `Date`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Math`, `JSON`, `Reflect`, `Atomics`, `SharedArrayBuffer`, `WeakRef`, and `FinalizationRegistry`, each with its prototype, plus `Function`. The seal modes also seal `Function.prototype`; the freeze modes leave it extensible. Every seal and freeze mode also replaces `Function.prototype.constructor` with a no-op before the first application module loads, including the after-load modes. Other built-ins, such as `Error` and the typed arrays, are not locked. Under [`moduleLoader: vm`](#vm), each application has its own `Object`, `Array`, and `Function`, and those are not locked.

### Sealing and freezing

Sealing stops properties from being added, deleted, or reconfigured: `Object.defineProperty` cannot make an existing property configurable, change whether it is enumerable, or turn it into a getter. Each property keeps its value and writability, so a writable property such as `Array.prototype.map` can still be assigned, and a read-only one such as `Math.PI` stays read-only. An object can shadow any inherited method by plain assignment (`obj.toString = fn`, `arr.push = fn`).

Freezing also makes every existing property read-only. That blocks changing a prototype method, and it also blocks shadowing one on an instance: assigning `arr.push = fn` throws in strict-mode code. Harper keeps a few commonly shadowed methods, such as `toString` and `Promise.prototype.then`, assignable on instances.

Because sealing leaves existing properties writable, a pollution payload that overwrites an existing method, such as `__proto__.toString`, still succeeds under the seal modes. That mostly breaks behavior (a denial of service) rather than granting access, and it is the trade the default accepts. Choose `freeze-after-load` when you want existing intrinsic properties to be unchangeable too.

`seal-after-load` replaced `freeze-after-load` as the default in v5.4.0 because frozen prototypes are slow on Node.js. With them, V8 takes a slow path for every store into an array hole (such as filling a `new Array(n)`) for all code on that thread, Harper's own included: in Harper's benchmark, msgpackr decoding inside a worker ran about four times slower under `freeze-after-load` than under `seal-after-load`. Sealing does not have that cost.

### Changes while components load

Under `seal-after-load` and `freeze-after-load`, a component or its dependencies can still extend an intrinsic while they load, as polyfills and libraries such as `reflect-metadata` do. Once all components have loaded, adding a property to a locked intrinsic by assignment throws a `TypeError` in strict-mode code (every ES module is strict) and is silently ignored in sloppy-mode code. `Object.defineProperty` throws in both. Under `seal` and `freeze`, the same applies from before the first application module loads.

### Upgrading and downgrading

New installs get `seal-after-load`. An upgrade keeps the value already in `harper-config.yaml`: an instance installed on v5.0.2 through v5.3 keeps `freeze-after-load` until you change it, and one installed on v5.0.0 or v5.0.1 keeps `freeze`. In a cluster, switch to a seal mode only after every node runs v5.4.0 or later. If the file has no `lockdown` value, as after an in-place upgrade from v4, Harper does not lock the intrinsics at all; set the value to turn lockdown on.

Before downgrading an instance that uses a seal mode to v5.0.1 through v5.3, set `lockdown: freeze-after-load` (added in v5.0.1, and the default from v5.0.2). Those releases do not recognize the seal modes, so they treat them as `freeze` and lock before any application code loads, and a dependency that extends an intrinsic while it loads then fails. Even with `freeze-after-load`, the older release freezes rather than seals, so code that assigns to an existing intrinsic property after load, which sealing allows, throws there. v5.0.0 has no after-load mode: on that release, only `none` lets a dependency extend an intrinsic while it loads.

## Allowed Directory

<VersionBadge version="v5.0.4" />

`allowedDirectory` restricts where application modules may be loaded from.

- `app` (default) — an application may only load modules from within its own directory tree. Loading from outside it throws `Can not load module at <path> outside of allowed path <path>`.
- `any` — no restriction.

The check resolves symlinks before comparing against the application's own directory. It applies to imports the application module loader handles; imports that Node's loader resolves are not subject to it, so treat this as a configuration guardrail rather than a security boundary.

Dev-mode installs set `allowedDirectory: any`, so local development is typically unaffected; production installs get `app`.

If an application legitimately needs to load files from outside its own directory in production:

```yaml
applications:
  allowedDirectory: any
```

## Allowed Built-in Modules

`allowedBuiltInModules` restricts which Node.js built-ins applications may import. If it is omitted, all built-ins are allowed — which is the default.

```yaml
applications:
  allowedBuiltInModules:
    - fs
    - path
    - http
```

Matching strips a `node:` prefix and compares the first path segment, so allowlisting `fs` also permits `node:fs/promises`. A built-in that is not on the list throws `Module <name> is not allowed to be imported` when the module is linked, not at the call site. The key is matched case-insensitively, so an existing `allowedBuiltinModules` in your configuration keeps working.

Like `allowedDirectory`, this applies to imports the application module loader handles rather than to every import an application can make — a configuration guardrail, not a security boundary.

Allowlisting `child_process` still yields Harper's constrained substitute under the VM loaders, not Node's unmodified module.

## Native Addons on Pointer-Compression Runtimes

<VersionBadge version="v5.4.0" />

Harper can run on a Node.js build with V8 pointer compression enabled (built with `--experimental-enable-pointer-compression`, so that `process.config.variables.v8_enable_pointer_compression` is `1`), which uses less JavaScript heap per thread. Pointer compression changes V8's C++ ABI without changing Node.js's module version. A native addon (`.node` file) that calls V8's C++ API directly, rather than Node-API, and was built for a standard Node.js therefore loads and then crashes the whole process the first time it is used.

On Harper Fabric, a cluster's plan selects its runtime: Free and Hobby tier clusters run on a pointer-compression runtime, and all other plans run a standard Node.js. No cluster setting switches the runtime. To run a Free or Hobby cluster on a standard Node.js, change the cluster to another plan, or contact Harper support. To confirm which runtime a cluster is on, read `process.config.variables.v8_enable_pointer_compression` from an application.

On a pointer-compression runtime, Harper checks native addons before they load, in every thread. That covers addons loaded by applications, by their dependencies, and by [`threads.preload` and `threads.preloadRequire`](../configuration/options.md#threads) modules. Harper refuses an addon that links V8's C++ API unless it was built for pointer compression. A 64-bit ELF addon whose symbol table cannot be read is refused too, unless one of the last two rules below admits it.

An addon loads when any of these holds:

- It uses only [Node-API](https://nodejs.org/api/n-api.html), which is ABI-stable across the flag: it imports no V8 C++ symbols. Most current addons are Node-API.
- node-gyp compiled it under this Node.js, for example with `npm rebuild <package> --build-from-source`, and it is loaded from inside that package's `build/` directory, such as node-gyp's usual `build/Release/`. That build's `build/config.gypi` must record `"v8_enable_pointer_compression": 1`, and the binary must be newer than it. Two cases need the marker below instead:
  - a binary copied elsewhere after building, as node-pre-gyp does;
  - a build whose files all share one modification time, such as a reproducible build with clamped timestamps.
- Its package directory contains a `.pointer-compression-build` file. The marker admits every native binary in the package without inspecting it. Add this marker only when all of them were built for pointer compression.

A refused addon fails to load with an `IncompatibleNativeAddonError`. The error names the file and its package, and lists the fixes:

- a Node-API version of the package;
- a build compiled for pointer compression;
- a rebuild from source under the running Node.js;
- a standard Node.js runtime.

The error carries `code: 'ERR_DLOPEN_FAILED'`, the code Node.js uses for an addon it cannot load. Packages that treat their native accelerator as optional, such as `cbor-x` and `msgpackr`, fall back to their JavaScript implementation on any load error.

The check has three limits:

- It inspects Linux (ELF) binaries only. Addons in other formats are left to Node.js and are not checked.
- Modules preloaded through `NODE_OPTIONS` run before Harper starts. Their addons are not checked. Load such modules with `threads.preload` or `threads.preloadRequire` instead.
- On a standard Node.js build, nothing changes.

## Choosing a Mode

For most applications the default is the right choice, and the settings on this page are worth changing only in response to a concrete problem.

- **A package breaks under the VM loader.** Try `dependencyLoader: native` first — it keeps application context for your own source. Fall back to `moduleLoader: native` only if the problem is in first-party code.
- **A dependency changes an intrinsic and now throws.** Under the default `seal-after-load`, a change throws only if it happens after components have loaded and adds or deletes a property, or reconfigures one with `Object.defineProperty` (for example, passing `configurable: true`); assigning to an existing writable property works at any time. Under the freeze modes, assigning to an existing property throws too. Assignments and deletions in sloppy-mode code are silently ignored instead; see [Changes while components load](#changes-while-components-load). `lockdown: none` is the temporary workaround; the durable fix is in the dependency.
- **`instanceof` fails on a value that crossed the Harper boundary.** You are on `vm`. Move to `vm-current-context`.
- **You need per-application intrinsics or a custom global.** `vm` is the mode that provides them; accept the compatibility cost.
- **You need to spawn a sidecar process.** Stay on a VM loader and keep the spawning code in component source, reached with `import`. See [Child Processes](./javascript-environment.md#child-processes).

## See Also

- [JavaScript Environment](./javascript-environment.md) — module formats, TypeScript support, and the `harper` API surface
- [Child Processes](./javascript-environment.md#child-processes) — the constrained `child_process` contract
- [Configuration Options](../configuration/options.md#applications) — the `applications` section in full
- [v5 Migration Guide](/release-notes/v5-lincoln/v5-migration#vm-module-loader) — what changed from v4 and how to cope
