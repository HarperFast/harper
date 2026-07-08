# server/ — Navigation Guide

This layer accepts inbound traffic on every supported protocol (HTTP/1.1, HTTP/2, HTTPS, WebSockets, MQTT, NATS) and routes it through to the Resource layer.

**Read this when:** you're touching request/response, protocol handling, middleware ordering, or WebSocket upgrade behavior.

> **Navigation convention.** This guide references code by **symbol name** (function/const). Use your editor's go-to-symbol or `grep -n '<name>' server/<file>` to jump. Line numbers drift; symbols don't.

---

## Three HTTP stacks coexist — know which one

| Stack                         | File                  | Used for                                                                                                                                                                                        |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native**                    | `http.ts`             | Direct socket handling for application-level HTTP/1.1, HTTPS, HTTP/2, and WebSockets. Highest performance. This is the path most user requests take (REST, GraphQL, custom resource endpoints). |
| **Operations API**            | `operationsServer.ts` | Fastify-based JSON operations API (`{operation: 'create_table', ...}`). Internal/admin surface — not on the hot path for application data.                                                      |
| **Custom Functions (legacy)** | `fastifyRoutes.ts`    | Legacy custom functions only. Wraps Fastify with autoload. Don't add new code here.                                                                                                             |

A request entering `http.ts` does **not** go through Fastify. The two `handleApplication(scope)` functions (one in each Fastify file) load independently from component config.

---

## File overview

### Core dispatch

| File                             | Purpose                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server.ts`                      | Defines the `Server` interface — the contract that protocol plugins use to register listeners. Has `socket()`, `http()`, `ws()`, `upgrade()`, `contentTypes`, `getUser()`, `operation()`, `replication`, etc. |
| `http.ts`                        | Native HTTP/WS server. Registration entry points (`onRequest`, `onUpgrade`, `onWebSocket`), per-port middleware chains, UDS support, PROXY protocol. **See section map below.**                               |
| `middlewareChain.ts`             | Topological sort respecting `before`/`after` constraints on listener registrations (`topoSort`). Falls back to registration order on cycle.                                                                   |
| `REST.ts`                        | Resource-routed REST handler: URL → `Resource.getResource()` → method dispatch + content negotiation.                                                                                                         |
| `graphqlQuerying.ts`             | GraphQL query/mutation/subscription execution against Resources.                                                                                                                                              |
| `mqtt.ts`                        | MQTT broker (connect/sub/pub mapped onto Resource interface).                                                                                                                                                 |
| `DurableSubscriptionsSession.ts` | Persistent subscription state (resume across reconnects).                                                                                                                                                     |

### Operations & Fastify

| File                  | Purpose                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `operationsServer.ts` | Boots Fastify for operations API. `buildServer()` constructs the server; `handler()` parses `{operation: ...}` and dispatches. |
| `fastifyRoutes.ts`    | Legacy custom functions. Discovers routes from each component's `routes/` folder.                                              |

### Helpers

| File                                       | Purpose                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `serverHelpers/Request.ts`                 | Wraps `IncomingMessage` with Harper-specific fields (user, response, headers).  |
| `serverHelpers/Headers.ts`                 | Header mutation/merge utilities.                                                |
| `serverHelpers/contentTypes.ts`            | (de)serialization registry; `serialize`, `serializeMessage`, `getDeserializer`. |
| `serverHelpers/serverUtilities.ts`         | `OperationDefinition` and shared helpers.                                       |
| `serverHelpers/OperationFunctionObject.ts` | Wraps an operation handler with metadata.                                       |
| `serverHelpers/JSONStream.ts`              | Streaming JSON output for large responses.                                      |
| `nodeName.ts`                              | Resolves this node's name (config → hostname).                                  |
| `static.ts`                                | Static file serving for component-bundled assets.                               |
| `throttle.ts`                              | Per-IP / per-user request throttling.                                           |
| `storageReclamation.ts`                    | Disk-pressure signals to downstream consumers.                                  |
| `serverRegistry.ts`                        | Trivial registry export.                                                        |
| `status/`                                  | Server status reporting (cluster status, per-port info).                        |

### Threads

| File                       | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `threads/socketRouter.ts`  | Routes accepted sockets to worker threads based on port. |
| `threads/manageThreads.js` | Thread pool lifecycle.                                   |
| `threads/threadServer.js`  | Worker entry point — receives sockets via IPC.           |
| `threads/itc.js`           | Inter-thread comms primitives.                           |
| `transactionLogCooling.ts` | Main-thread timer that cools transaction-log mmaps.      |

> Workers receive `workerData.noServerStart = true` — never start the server inside a worker.

### Where periodic maintenance runs (main thread vs last worker)

Single-instance background tasks pick their thread by what state they touch:

- **Last worker** (`getWorkerIndex() === getWorkerCount() - 1`) — for tasks that operate on **worker-resident JS state**: audit cleanup (`resources/auditStore.ts`) and disk reclamation (`storageReclamation.ts`) walk per-store objects that only exist in a worker.
- **Main thread** (`isMainThread`) — for tasks that drive a **process-global native singleton** and need no JS state. `transactionLogCooling.ts` is the example: rocksdb-js's transaction-log registry is one C++ static shared across all worker threads, so any thread cools every log. The main thread is chosen because it is the only thread that lives for the whole process — a worker-driven timer would stall whenever that worker is recycled.

---

## `http.ts` — symbol map

Every entry is a top-level function or named const. Jump via go-to-symbol or `grep -n 'function <name>' server/http.ts`.

| Symbol                                                                                      | What it does                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `registerUdsCleanupPaths`, `cleanupUdsFiles`, `writeUdsMetadata`, `cleanupSocketsDirectory` | UDS socket / metadata file lifecycle.                                                                                                                                                      |
| `handleApplication(scope)`                                                                  | Component entry point — captures `httpOptions` for the scope.                                                                                                                              |
| `getHttpOptions()`                                                                          | Returns the current scope's `HttpOptions`.                                                                                                                                                 |
| `deliverSocket()`                                                                           | IPC-delivered socket handoff from `socketRouter`.                                                                                                                                          |
| `proxyRequest()`                                                                            | Cross-port request routing.                                                                                                                                                                |
| `registerServer()`                                                                          | Records a server for a port in the `SERVERS` map.                                                                                                                                          |
| `getPorts()`                                                                                | Resolves listener options → list of `{port, secure}`.                                                                                                                                      |
| `httpServer()`                                                                              | Main listener registration entry point.                                                                                                                                                    |
| `getHTTPServer(port, secure, options)`                                                      | **The largest function in the file.** Creates/retrieves the underlying Node HTTP/HTTPS server. Wires `request`, `upgrade`, error handlers, TLS context, and the per-port middleware chain. |
| `makeCallbackChain()`                                                                       | Builds the per-port handler chain via `middlewareChain.topoSort`.                                                                                                                          |
| `unhandled()`                                                                               | Terminal 404 handler.                                                                                                                                                                      |
| `onRequest()`                                                                               | Thin alias of `httpServer({requestOnly: true})`.                                                                                                                                           |
| `onUpgrade()` / `upgradeListeners` (const)                                                  | Register HTTP upgrade listener; underlying list.                                                                                                                                           |
| `onWebSocket()` / `websocketListeners` (const)                                              | Register WebSocket listener; auto-adds default upgrade handler the first time it runs for a port. Underlying list of registrations.                                                        |
| `enableProxyProtocol()`                                                                     | PROXY v1 parsing (Node 24+-compatible workaround).                                                                                                                                         |
| `defaultNotFound()`                                                                         | Default 404 response.                                                                                                                                                                      |
| `logRequest()`                                                                              | Per-request access log line.                                                                                                                                                               |
| `getRequestId()`                                                                            | Generates the per-request correlation ID.                                                                                                                                                  |

### Middleware ordering (`before` / `after`)

Components register listeners with optional `before: 'name'` / `after: 'name'` options. `middlewareChain.topoSort` resolves order; cycles fall back to registration order with a warning. Three lists hold the registrations:

- `httpResponders` — request handlers
- `upgradeListeners` (in `http.ts`)
- `websocketListeners` (in `http.ts`)

The default WebSocket upgrade handler is registered automatically inside `onWebSocket()` the first time it runs for a given port.

---

## Resource ↔ HTTP boundary

`REST.ts → http(request, nextHandler)` is the chief integration point: it takes a `Request`, asks the `Resources` registry for a match, builds a `RequestTarget`, and dispatches into the Resource class's static method. Cache headers are translated to `request.expiresAt` / `onlyIfCached` / `noCache` flags within the same function.

---

## "Where is X" cheat sheet

| Question                                            | Where                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| Where do I register a new HTTP handler?             | `http.ts → httpServer()` (or `onRequest()` for the request-only form) |
| Where do I register a WebSocket handler?            | `http.ts → onWebSocket()`                                             |
| How does `before`/`after` middleware ordering work? | `middlewareChain.ts → topoSort`                                       |
| Where does PROXY protocol get parsed?               | `http.ts → enableProxyProtocol`                                       |
| Where is the REST request → Resource dispatch?      | `REST.ts → http()`                                                    |
| Where is the operations API request handled?        | `operationsServer.ts → handler`                                       |
| How are content types (de)serialized?               | `serverHelpers/contentTypes.ts`                                       |
| Where do durable subscriptions live?                | `DurableSubscriptionsSession.ts`                                      |
| How are sockets dispatched to worker threads?       | `threads/socketRouter.ts`                                             |
| Where is the Operations API wired into Fastify?     | `operationsServer.ts → buildServer`                                   |

---

## Conventions

- Don't add new code to `fastifyRoutes.ts` — it's the legacy custom-functions path.
- New protocol plugins implement the `Server` interface (in `Server.ts`) and register via `onRequest`/`onUpgrade`/`onWebSocket`.
- Always pass `name` when registering a listener with `before`/`after` — anonymous entries can't be ordered against.
- Tests live in `../unitTests/server/`.
