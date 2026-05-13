# server/ — Navigation Guide

This layer accepts inbound traffic on every supported protocol (HTTP/1.1, HTTP/2, HTTPS, WebSockets, MQTT, NATS) and routes it through to the Resource layer.

**Read this when:** you're touching request/response, protocol handling, middleware ordering, or WebSocket upgrade behavior.

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

| File                             | Lines | Purpose                                                                                                                                                                                                       |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server.ts`                      | 100   | Defines the `Server` interface — the contract that protocol plugins use to register listeners. Has `socket()`, `http()`, `ws()`, `upgrade()`, `contentTypes`, `getUser()`, `operation()`, `replication`, etc. |
| `http.ts`                        | 838   | Native HTTP/WS server. Registration entry points (`onRequest`, `onUpgrade`, `onWebSocket`), per-port middleware chains, UDS support, PROXY protocol.                                                          |
| `middlewareChain.ts`             | 270   | Topological sort respecting `before`/`after` constraints on listener registrations. Falls back to registration order on cycle.                                                                                |
| `REST.ts`                        | 434   | Resource-routed REST handler: URL → `Resource.getResource()` → method dispatch + content negotiation.                                                                                                         |
| `graphqlQuerying.ts`             | 701   | GraphQL query/mutation/subscription execution against Resources.                                                                                                                                              |
| `mqtt.ts`                        | 506   | MQTT broker (connect/sub/pub mapped onto Resource interface).                                                                                                                                                 |
| `DurableSubscriptionsSession.ts` | 507   | Persistent subscription state (resume across reconnects).                                                                                                                                                     |

### Operations & Fastify

| File                  | Lines | Purpose                                                                                            |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `operationsServer.ts` | 313   | Boots Fastify for operations API. `handler()` (line 246) parses `{operation: ...}` and dispatches. |
| `fastifyRoutes.ts`    | 206   | Legacy custom functions. Discovers routes from each component's `routes/` folder.                  |

### Helpers

| File                                       | Lines | Purpose                                                                         |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------- |
| `serverHelpers/Request.ts`                 | —     | Wraps `IncomingMessage` with Harper-specific fields (user, response, headers).  |
| `serverHelpers/Headers.ts`                 | —     | Header mutation/merge utilities.                                                |
| `serverHelpers/contentTypes.ts`            | —     | (de)serialization registry; `serialize`, `serializeMessage`, `getDeserializer`. |
| `serverHelpers/serverUtilities.ts`         | —     | `OperationDefinition` and shared helpers.                                       |
| `serverHelpers/OperationFunctionObject.ts` | —     | Wraps an operation handler with metadata.                                       |
| `serverHelpers/JSONStream.ts`              | —     | Streaming JSON output for large responses.                                      |
| `nodeName.ts`                              | 85    | Resolves this node's name (config → hostname).                                  |
| `static.ts`                                | 187   | Static file serving for component-bundled assets.                               |
| `throttle.ts`                              | 91    | Per-IP / per-user request throttling.                                           |
| `storageReclamation.ts`                    | 81    | Disk-pressure signals to downstream consumers.                                  |
| `serverRegistry.ts`                        | 8     | Trivial registry export.                                                        |
| `status/`                                  | —     | Server status reporting (cluster status, per-port info).                        |

### Threads

| File                       | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `threads/socketRouter.ts`  | Routes accepted sockets to worker threads based on port. |
| `threads/manageThreads.js` | Thread pool lifecycle.                                   |
| `threads/threadServer.js`  | Worker entry point — receives sockets via IPC.           |
| `threads/itc.js`           | Inter-thread comms primitives.                           |

> Workers receive `workerData.noServerStart = true` — never start the server inside a worker.

---

## `http.ts` section index (838 lines)

| Section                                                                                                                                                                                                                               | Line   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| UDS metadata (`registerUdsCleanupPaths`, `writeUdsMetadata`, `cleanupSocketsDirectory`)                                                                                                                                               | 53–122 |
| `handleApplication(scope)` (component entry)                                                                                                                                                                                          | 123    |
| `getHttpOptions()`                                                                                                                                                                                                                    | 130    |
| `deliverSocket()` — IPC-delivered socket handoff                                                                                                                                                                                      | 134    |
| `proxyRequest()` — cross-port request routing                                                                                                                                                                                         | 171    |
| `registerServer()`                                                                                                                                                                                                                    | 221    |
| `getPorts()`                                                                                                                                                                                                                          | 248    |
| `httpServer()` — main listener registration                                                                                                                                                                                           | 274    |
| `getHTTPServer(port, secure, options)` — creates/retrieves the underlying Node HTTP/HTTPS server. **The largest function (~283 lines)** — wires `request`, `upgrade`, error handlers, TLS context, and the per-port middleware chain. | 299    |
| `makeCallbackChain()` — builds the per-port handler chain via `middlewareChain.topoSort`                                                                                                                                              | 582    |
| `unhandled()` — terminal 404 handler                                                                                                                                                                                                  | 595    |
| `onRequest()` — thin alias of `httpServer({requestOnly: true})`                                                                                                                                                                       | 606    |
| `onUpgrade()` — register HTTP upgrade listener                                                                                                                                                                                        | 625    |
| `onWebSocket()` — register WebSocket listener; auto-adds default upgrade handler                                                                                                                                                      | 662    |
| `enableProxyProtocol()` — PROXY v1 parsing (Node 24+-compatible workaround)                                                                                                                                                           | 743    |
| `defaultNotFound()`                                                                                                                                                                                                                   | 800    |
| `logRequest()`                                                                                                                                                                                                                        | 808    |
| `getRequestId()`                                                                                                                                                                                                                      | 830    |

### Middleware ordering (`before`/`after`)

Components register listeners with optional `before: 'name'` / `after: 'name'` options. `middlewareChain.topoSort` resolves order; cycles fall back to registration order with a warning. Listener registration happens in three lists:

- `httpResponders` — request handlers
- `upgradeListeners` (line 622)
- `websocketListeners` (line 654)

The default WebSocket upgrade handler is registered automatically the first time `onWebSocket()` runs for a port (line 693).

---

## Resource ↔ HTTP boundary

`REST.ts:22` (`http(request, nextHandler)`) is the chief integration point: it takes a `Request`, asks the `Resources` registry for a match, builds a `RequestTarget`, and dispatches into the Resource class's static method. Cache headers are translated to `request.expiresAt` / `onlyIfCached` / `noCache` flags (`REST.ts:46–73`).

---

## "Where is X" cheat sheet

| Question                                            | File:line                                                       |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Where do I register a new HTTP handler?             | `http.ts:274` (`httpServer()`) or `http.ts:606` (`onRequest()`) |
| Where do I register a WebSocket handler?            | `http.ts:662` (`onWebSocket()`)                                 |
| How does `before`/`after` middleware ordering work? | `middlewareChain.ts:21` (`topoSort`)                            |
| Where does PROXY protocol get parsed?               | `http.ts:743`                                                   |
| Where is the REST request → Resource dispatch?      | `REST.ts:22`                                                    |
| Where is the operations API request handled?        | `operationsServer.ts:246` (`handler()`)                         |
| How are content types (de)serialized?               | `serverHelpers/contentTypes.ts`                                 |
| Where do durable subscriptions live?                | `DurableSubscriptionsSession.ts`                                |
| How are sockets dispatched to worker threads?       | `threads/socketRouter.ts`                                       |
| Where is the Operations API wired into Fastify?     | `operationsServer.ts:138` (`buildServer`)                       |

---

## Conventions

- Don't add new code to `fastifyRoutes.ts` — it's the legacy custom-functions path.
- New protocol plugins implement `Server` (`Server.ts:21`) and register via `onRequest`/`onUpgrade`/`onWebSocket`.
- Always pass `name` when registering a listener with `before`/`after` — anonymous entries can't be ordered against.
- Tests live in `../unitTests/server/`.
