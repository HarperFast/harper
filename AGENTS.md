# AGENTS.md

This file provides guidance when working with code in this repository.

---

## What This Is

Harper is a Node.js unified development platform that fuses a document database (RocksDB-backed), in-memory cache, application runtime, and messaging broker (WebSockets, MQTT, NATS) into a single in-process runtime. This directory is the open-source core (`harper` npm package, Apache-2.0), which is the base for the enterprise `harper-pro` wrapper above it.

---

## Commands

```bash
# Build
npm run build              # TypeScript → dist/ via tsconfig.build.json
npm run build:watch        # Incremental watch build

# Lint / Format
npm run lint               # oxlint (warnings = errors)
npm run lint:fix           # Auto-fix
npm run format:write       # Prettier

# Test — run specific suites
npm run test:unit                  # All unit tests (mocha)
npm run test:unit:main             # Core unit tests (excludes apiTests, lmdb, resources)
npm run test:unit:resources        # Resource layer tests
npm run test:unit:server           # Server layer tests
npm run test:unit:dataLayer        # Data layer tests
npm run test:unit:components       # Component/plugin system tests
npm run test:unit:security         # Security tests
npm run test:unit:apitests         # API tests (stops running server first)
npm run test:unit:lmdb             # LMDB storage engine tests
npm run test:integration           # Full integration test suite
```

Run a single test file directly:

```bash
npx mocha unitTests/resources/mytest.js
```

TypeScript is stripped at runtime via `--conditions=typestrip` (Node.js native type stripping) — no compilation required for development. Use `npm run test:unit:typestrip` to run tests with this mode.

**Test timing:** prefer condition-waits over fixed `delay(N)` sleeps. `await delay(N); assert(sideEffectHappened)` races against loaded runners and is the root cause of a class of flakiness (#1138). Use the shared `waitFor(condition, timeout?, interval?)` helper in `unitTests/waitFor.js` to poll until the actual condition holds. Reserve fixed sleeps for genuinely modeling elapsed time (TTL/expiry windows) or asserting a non-event (that something has _not_ happened yet).

---

## Architecture

### Layers (top to bottom)

**Components** (`components/`)  
The plugin/application loader. Applications export a `handleApplication(scope)` function. `Scope` is the primary object passed to apps; it exposes:

- `scope.options` — `OptionsWatcher` for live-reloaded YAML config
- `scope.resources` — access to database tables and registered resources
- `scope.server` — the HTTP server handle

Files within a component are discovered via micromatch glob patterns and automatically mapped to URL paths.

**Server** (`server/`)  
Multiple HTTP entry points coexist:

- **Native layer** (`server/http.ts`) — direct socket handling for application-level HTTP/1.1, HTTPS, HTTP/2, and WebSockets in one path; highest performance. Most user traffic goes through here.
- **Operations API** (`server/operationsServer.ts`) — Fastify-based JSON operations API (`{operation: 'create_table', ...}`); internal/admin surface.
- **Custom Functions (legacy)** (`server/fastifyRoutes.ts`) — legacy Fastify autoload for user-defined routes. Don't add new code here.

All inbound protocols (REST, GraphQL, MQTT, NATS, WebSockets) eventually resolve to the same **Resource interface**. See `server/DESIGN.md` for the file-by-file map and the `http.ts` section index.

**Resources** (`resources/`)  
The universal abstraction. Everything that can be queried or mutated — database tables, caches, message topics, custom endpoints — extends `Resource` (`resources/Resource.ts`).

Static methods (`Resource.get`, `Resource.put`, `Resource.post`, `Resource.delete`, `Resource.patch`, `Resource.subscribe`) are the entry points and are automatically wrapped with `transactional()` for transaction management. Override instance methods (`get`, `put`, etc.) for custom behavior.

`Table.ts` is the database table implementation (4744 lines, one giant `makeTable()` factory) — the most complex file in the codebase. **Use `resources/DESIGN.md` as a section index instead of reading top-to-bottom.**

**Data Layer** (`dataLayer/`)  
Legacy translation modules plus SQL translation (`sqlTranslator/`) via AlaSQL; these should be avoided. The storage engine is selectable via `HARPER_STORAGE_ENGINE=lmdb`.

**Configuration** (`config/`)  
YAML-based. `configUtils.js` parses config; `RootConfigWatcher.ts` enables hot reload. Environment variables override YAML values.

**Utility** (`utility/`)  
Logging, error types, helpers, async utilities. Most-used: `utility/hdbTerms.ts` (global constants), `utility/logging/harper_logger.js`, `utility/errors/hdbError.js`.

---

## Repository map

Use this to land in the right folder before grepping. Every top-level folder is listed; deeper docs are noted where they exist.

### Source — covered above

- **`components/`** — plugin/app loader. Entry: `Scope.ts`, `OptionsWatcher.ts`. Tests: `unitTests/components/`.
- **`server/`** — HTTP/WS/MQTT/etc. Entry: `operationsServer.ts` (boot), `http.ts` (native HTTP). **See [server/DESIGN.md](server/DESIGN.md).** Tests: `unitTests/server/`.
- **`resources/`** — universal Resource abstraction; tables. Entry: `Resource.ts`, `Table.ts`. **See [resources/DESIGN.md](resources/DESIGN.md).** Tests: `unitTests/resources/`.
- **`dataLayer/`** — legacy translation modules (`insert.js`, `search.js`, `update.js`). **Avoid for new code.** Tests: `unitTests/dataLayer/`.
- **`config/`** — YAML config + hot reload. Entry: `configUtils.js`, `RootConfigWatcher.ts`. Tests: `unitTests/config/`.
- **`utility/`** — logging, errors, helpers. Tests: `unitTests/utility/`.

### Other source folders

- **`bin/`** — CLI entry points. `harper.js` is the executable; `run.js` initializes and runs the server; `cliOperations.js` translates CLI args → API operations. Tests: `unitTests/bin/`. **Don't look here for** business logic.
- **`security/`** — auth, authz, certificate handling, context. Entry: `jsLoader.ts` exposes `getContext()`, `getResponse()`, `getUser()`; `user.ts` for User/Role; `certificateVerification/` for TLS validation; `data_objects/` for permission/role models. Tests: `unitTests/security/`.
- **`sqlTranslator/`** — SQL → internal operations via AlaSQL AST. Entry: `sqlTranslator/index.js` exports `evaluateSQL`, `processAST`, `convertSQLToAST`, `checkASTPermissions`. **Legacy — avoid for new code.** Tests: `unitTests/sqlTranslator/`.
- **`validation/`** — input shape validation (Joi + `validate.js`). Entry: `validationWrapper.js`. **Not authorization** — that's in `security/`. Tests: `unitTests/validation/`.
- **`upgrade/`** — version-upgrade orchestration. Entry: `directivesManager.js` exports `processDirectives()`. Per-version logic in `directives/`. Tests: `integrationTests/upgrade/`.
- **`launchServiceScripts/`** — thin launchers that delegate to `server/operationsServer.ts`. `checkNodeVersion.js` is the pre-flight Node version check.
- **`json/`** — system schema definitions. `systemSchema.json` defines built-in tables (`hdb_user`, `hdb_role`, `hdb_permission`). Loaded at startup; no code.

### Non-source

- **`bin/`** — covered above (it's source).
- **`benchmarks/`** — HNSW vector-search benchmark only (`hnsw-search.js`). Stand-alone; not part of CI.
- **`build-tools/`** — shell scripts for the build pipeline (`build.sh`, `build-studio.sh`, `download-prebuilds.js`). No tests.
- **`dev/`** — single dev utility (`sync-commits.js`) for cross-repo commit syncing. Not runtime.
- **`integrationTests/`** — end-to-end tests against a built distribution. Run with `npm run test:integration` / `npm run test:integration:all`. Subdirs mirror source. See `integrationTests/README.md`.
- **`unitTests/`** — Mocha unit tests; subdir per source layer. Run with `npm run test:unit:<layer>`.
- **`static/`** — assets only: `defaultConfig.yaml`, `ascii_logo.txt`.

### Top-level docs to consult

- **[DESIGN.md](DESIGN.md)** — running list of non-obvious internals (RecordObject prototype, getFromSource timing, blob orphan cleanup). Read this before debugging anything record-store-related.
- **[dependencies.md](dependencies.md)** — rationale for every npm dependency. Required reading before adding a new package.
- **[storage-format.md](storage-format.md)** — on-disk layout (RocksDB/LMDB).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — contribution workflow.

---

## Detailed navigation

For megafiles and complex subsystems, jump to the section index instead of reading top-to-bottom:

| If you are touching…                                   | Read first                                 |
| ------------------------------------------------------ | ------------------------------------------ |
| Anything in `resources/` (especially `Table.ts`)       | [resources/DESIGN.md](resources/DESIGN.md) |
| HTTP/WS/MQTT, middleware ordering, content types       | [server/DESIGN.md](server/DESIGN.md)       |
| Record-store internals (commit timing, blobs, encoder) | [DESIGN.md](DESIGN.md)                     |
| Adding a dependency                                    | [dependencies.md](dependencies.md)         |

---

## Key Patterns

**`transactional()` wrapper** — All static Resource methods go through this. It ensures async operations run inside a database transaction. Use `contextStorage` (AsyncLocalStorage) to access the current transaction context without passing it explicitly.

**Resource discovery** — A component's config file maps glob patterns to URL paths. Files matching a pattern become routable resources automatically; no explicit route registration is needed.

**Lazy loading** — GraphQL, secure sandboxing, and tarball extraction are imported on demand. Do not add top-level imports for these modules.

**TypeScript + type stripping** — Source files are `.ts` but Node.js runs them directly via type stripping in development. The `dist/` directory is the compiled production artifact. Both `.ts` and legacy `.js` files coexist; new code should be `.ts`.

**Minimal dependencies** — `dependencies.md` documents the rationale for every dependency. Adding a new dependency requires justification; implementing something ourselves is often preferred.

---

## Git / Worktree Setup — Read Before Any Git Operation

This repo lives as a submodule of `harper-pro`. The submodule's git data directory is at
`../harper-pro/.git/modules/core/` (relative to this repo's root). That directory must contain
**only git metadata** — `objects/`, `refs/`, `config`, `HEAD`, etc.

**Known recurring failure mode:** If `../harper-pro/.git/modules/core/config` is ever absent or
replaced by a directory, git silently treats the git data dir as its own work tree. The next
`git checkout` deposits source files there — including a `config/` directory from the harper
source tree — which permanently shadows git's config file. Every subsequent agent then hits
`fatal: unknown error occurred while reading the configuration files` and the cycle repeats.

**Rules to prevent recurrence:**

- Never run `git submodule deinit core` + re-init from the `harper-pro` parent — it regenerates
  the module config without the required `core.worktree` setting.
- Never run `git checkout` or `git reset` while your working directory is inside
  `harper-pro/.git/modules/core/`.
- If you ever recreate `../harper-pro/.git/modules/core/config` from scratch, it **must** include:
  ```
  [core]
      worktree = ../../../core
  ```
- If you see source-tree files (e.g. `server/`, `resources/`, `config/`) appearing inside
  `../harper-pro/.git/modules/core/`, stop immediately and remove them — they are corrupting the
  git data directory.

---

## Non-Obvious Constraints

- `Resource` static methods must stay wrapped with `transactional()` — removing this breaks transaction isolation.
- Worker threads (`server/threads/`) receive `workerData.noServerStart = true` to prevent recursive server startup; never start the server inside a worker.
- `contextStorage` (AsyncLocalStorage) carries per-request context (user, transaction) across async boundaries — this is how authorization and transactions work without explicit parameter threading.
- Tests under `unitTests/apiTests/` require the server to be stopped first (`node ./dist/bin/harper.js stop`) — `test:unit:apitests` does this automatically.
- `@export` annotation on a schema class auto-generates a REST API for that table — this is the primary developer-facing API.
- Test style: write new unit tests with `assert` (the bare `node:assert` module) against real modules — **do not add new uses of `sinon` or `rewire`**. Use plain `assert`, **not** `node:assert/strict` — strict mode's deep-equality and coercion rules cause more friction and surprising failures than they prevent; plain `assert` is the house style. Older tests in `unitTests/security/` and `unitTests/utility/` still depend on them but they are not the target shape; match newer tests in `unitTests/config/*`, `unitTests/resources/*`, `unitTests/components/*`. If you can't write a test without stubbing, comment on the issue describing what's missing and stop — don't reach for sinon/rewire as a shortcut.
