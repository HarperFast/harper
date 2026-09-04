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
  lockdown: freeze-after-load # freeze-after-load (default) | freeze | ses | none
  moduleLoader: vm-current-context # vm-current-context (default) | vm | native | compartment
  dependencyLoader: auto # auto (default) | app | native
  allowedDirectory: app # app (default) | any
  allowedSpawnCommands:
    - npm
    - node
  # allowedBuiltInModules: [] # if omitted, all Node.js built-ins are allowed
```

See [Configuration Options](../configuration/options.md#applications) for the settings in the context of the full configuration file.

:::note Defaults changed during v5.0

The defaults above are the current ones. Earlier v5.0 releases behaved differently, so check your version before reasoning about which isolation model you are on:

| Setting            | v5.0.0 default | Current default                    |
| ------------------ | -------------- | ---------------------------------- |
| `lockdown`         | `freeze`       | `freeze-after-load`, since v5.0.2  |
| `moduleLoader`     | `vm`           | `vm-current-context`, since v5.1.0 |
| `allowedDirectory` | not available  | `app`, since v5.0.4                |

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

\* Applies to modules the application loader handles. Dependencies routed to the native loader share Node's process-wide cache — see [Dependency Loading](#dependency-loading).

### `vm-current-context` (default)

<VersionBadge type="changed" version="v5.1.0" />

The VM module loader running in Harper's own context, and the default since v5.1.0 (v5.0.x defaulted to `vm`). Applications get their own module cache but share JavaScript intrinsics (`Object`, `Array`, `Promise`, and so on) with Harper.

Sharing intrinsics gives the best compatibility with packages that perform `instanceof` or other identity checks on values crossing the application/Harper boundary. It is the right choice for almost every application.

Because there is no separate global object, `tables`, `databases`, and the other Harper APIs are the same live, process-wide objects whether you reach them as globals or as `harper` imports. See [JavaScript Environment](./javascript-environment.md#module-formats) for what that means in practice.

### `vm`

The VM module loader running in a separate context per application, with its own intrinsics and a custom global object.

This is stronger isolation, but the separate intrinsics are a common source of subtle incompatibilities: cross-context `instanceof` returning `false`, frozen-prototype mismatches, and similar. Choose it only if you specifically need per-application intrinsics.

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

`lockdown` controls whether JavaScript intrinsics are frozen, which protects against prototype pollution attacks.

- `freeze-after-load` (default) — freeze intrinsics after all components have loaded, so component initialization can still modify them.
- `freeze` — freeze intrinsics before any application code loads.
- `ses` — full SES lockdown via the `ses` package. Strictest, and the most likely to break packages that mutate built-ins.
- `none` — no lockdown.

Under the default, application code or a dependency that modifies an intrinsic prototype at runtime — after startup — throws a `TypeError`. If a dependency does this and you need a temporary workaround, set `lockdown: none`.

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

## Choosing a Mode

For most applications the default is the right choice, and the settings on this page are worth changing only in response to a concrete problem.

- **A package breaks under the VM loader.** Try `dependencyLoader: native` first — it keeps application context for your own source. Fall back to `moduleLoader: native` only if the problem is in first-party code.
- **A dependency mutates an intrinsic prototype and now throws.** `lockdown: none` is the temporary workaround; the durable fix is in the dependency.
- **`instanceof` fails on a value that crossed the Harper boundary.** You are on `vm`. Move to `vm-current-context`.
- **You need per-application intrinsics or a custom global.** `vm` is the mode that provides them; accept the compatibility cost.
- **You need to spawn a sidecar process.** Stay on a VM loader and keep the spawning code in component source, reached with `import`. See [Child Processes](./javascript-environment.md#child-processes).

## See Also

- [JavaScript Environment](./javascript-environment.md) — module formats, TypeScript support, and the `harper` API surface
- [Child Processes](./javascript-environment.md#child-processes) — the constrained `child_process` contract
- [Configuration Options](../configuration/options.md#applications) — the `applications` section in full
- [v5 Migration Guide](/release-notes/v5-lincoln/v5-migration#vm-module-loader) — what changed from v4 and how to cope
