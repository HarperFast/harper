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
Two HTTP stacks coexist:

- **Native layer** (`server/http.ts`) — direct socket handling for HTTP/1.1, HTTPS, HTTP/2, and WebSockets in one path; highest performance
- **Fastify layer** (`server/fastifyRoutes.ts`) — used for legacy custom functions; wraps Fastify with autoload

All inbound protocols (REST, GraphQL, MQTT, NATS, WebSockets) eventually resolve to the same **Resource interface**.

**Resources** (`resources/`)  
The universal abstraction. Everything that can be queried or mutated — database tables, caches, message topics, custom endpoints — extends `Resource` (`resources/Resource.ts`).

Static methods (`Resource.get`, `Resource.put`, `Resource.post`, `Resource.delete`, `Resource.patch`, `Resource.subscribe`) are the entry points and are automatically wrapped with `transactional()` for transaction management. Override instance methods (`get`, `put`, etc.) for custom behavior.

`Table.ts` is the database table implementation (~177KB) — the most complex file in the codebase.

**Data Layer** (`dataLayer/`)  
Legacy translation modules plus SQL translation (`sqlTranslator/`) via AlaSQL; these should be avoided. The storage engine is selectable via `HARPER_STORAGE_ENGINE=lmdb`.

**Configuration** (`config/`)  
YAML-based. `configUtils.js` parses config; `RootConfigWatcher.ts` enables hot reload. Environment variables override YAML values.

**Utility** (`utility/`)  
Logging, error types, helpers, async utilities.

---

## Key Patterns

**`transactional()` wrapper** — All static Resource methods go through this. It ensures async operations run inside a database transaction. Use `contextStorage` (AsyncLocalStorage) to access the current transaction context without passing it explicitly.

**Resource discovery** — A component's config file maps glob patterns to URL paths. Files matching a pattern become routable resources automatically; no explicit route registration is needed.

**Lazy loading** — GraphQL, secure sandboxing, and tarball extraction are imported on demand. Do not add top-level imports for these modules.

**TypeScript + type stripping** — Source files are `.ts` but Node.js runs them directly via type stripping in development. The `dist/` directory is the compiled production artifact. Both `.ts` and legacy `.js` files coexist; new code should be `.ts`.

**Minimal dependencies** — `dependencies.md` documents the rationale for every dependency. Adding a new dependency requires justification; implementing something ourselves is often preferred.

---

## Non-Obvious Constraints

- `Resource` static methods must stay wrapped with `transactional()` — removing this breaks transaction isolation.
- Worker threads (`server/threads/`) receive `workerData.noServerStart = true` to prevent recursive server startup; never start the server inside a worker.
- `contextStorage` (AsyncLocalStorage) carries per-request context (user, transaction) across async boundaries — this is how authorization and transactions work without explicit parameter threading.
- Tests under `unitTests/apiTests/` require the server to be stopped first (`node ./dist/bin/harper.js stop`) — `test:unit:apitests` does this automatically.
- `@export` annotation on a schema class auto-generates a REST API for that table — this is the primary developer-facing API.
- Test style: write new unit tests with `node:assert/strict` against real modules — **do not add new uses of `sinon` or `rewire`**. Older tests in `unitTests/security/` and `unitTests/utility/` still depend on them but they are not the target shape; match newer tests in `unitTests/config/*`, `unitTests/resources/*`, `unitTests/components/*`. If you can't write a test without stubbing, comment on the issue describing what's missing and stop — don't reach for sinon/rewire as a shortcut.
