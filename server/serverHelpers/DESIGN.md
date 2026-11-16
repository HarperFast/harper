## The dispatched API operation is carried on async context, never on the request (`server/serverHelpers/operationAuthorizationState.ts`)

`verifyPermsAST`'s token-scope check has to be told which top-level API operation the caller
invoked, because the scope is written in that namespace (`sql`, `export_local`, ...). Two things
make that awkward:

1. On the **direct-SQL** path, the object handed to `checkASTPermissions` _is_ the client's request
   body, and this check is the only table and token-scope gate there (`chooseOperation`'s `sql` branch
   is mutually exclusive with its `verifyPerms` call; only `verifyOperationsAllowlist` also runs). Any field read off that object is therefore a way to
   name whichever operation the caller's scope happens to allow and run arbitrary SQL under it.
   `jsonMessage.operation` is safe only because dispatch already routed on that same field, so it
   cannot disagree with the operation running. Never add another.
2. A **job** re-parses its SQL from the nested `search_operation` in a _different_ async context —
   `executeJob` persists the request and hands off to the job runner, and `jobs/jobProcess.ts` re-enters
   from the `hdb_job` record. So a store established around the originating request cannot reach
   it, and the re-parse would be judged as `sql` rather than as the job's own operation.

The carrier is therefore established **in the job worker**, by `runWithDispatchedOperation`, from
the same `request.operation` that `getOperationFunction` just resolved the handler from. That
identity is the whole basis for trusting it: the value naming the operation and the value selecting
the code cannot diverge. A new carrier must preserve that property — an added request property, a
`search_operation` field, or a persisted `parsed_sql_object` would not.

This lives in the same `AsyncLocalStorage` as the auth bypass rather than a second store, so
`processAST` reads the state once. `runWithOperationAuthorizationBypass` **preserves** an existing
carrier on both branches. That is deliberate and was initially got wrong: its enforced branch is not
a bypass, so a job handler dispatching a nested _authorized_ operation lands there, and dropping the
carrier would judge that job's re-parsed SQL as the inner `sql` and refuse it partway through its own
work. The consequence to know is the other direction — a nested dispatch inside a job is judged
against the **outer** job's operation for any `evaluateSQL` that does not pass through
`chooseOperation`. It allocates only when a carrier is present; with none, two shared frozen objects
serve the common path. All four stores are frozen, so `getOperationAuthorizationState()` cannot hand
a mutable one to a caller.

It has four call sites, and they are not all dispatch wrappers: `server.operation()`
(`serverUtilities.ts`), the ITC path (`registeredOperations.ts`), the legacy SQL engine
(`sqlEngine/diff/differential.ts`), and Harper's own `hdb_job` query (`server/jobs/jobs.ts`) — that
last one **is** reached from the ops-API dispatch, via `search_jobs_by_start_date` →
`handleGetJobsByStartDate` → `getJobsInDateRange`.

Harper's own internal SQL takes the bypass, not the carrier. `getJobsInDateRange` runs a fixed
`system.hdb_job` query through `evaluateSQL` beneath a handler the caller was already authorized for,
and `SqlSearchObject` hardcodes `operation: 'sql'` — so the same mismatch applies, but the answer
differs, and the reason is easy to get backwards. `verifyPermsAST`'s super_user early return is
`isSuperUser && !isSuSystemOperation`, so a `system` schema is **exempt** from it and the table check
genuinely runs. A carrier would therefore put Harper's own query through `hasPermissions` on
`system.hdb_job`, which passes only because `appendSystemTablesToRole` grants `system.*.read` to a
hydrated super_user — a super_user principal without an appended `permission.system` (an
impersonation payload, or any user not resolved through `security/user.ts`) would start getting 403s on an
operation it is entitled to. The bypass also states the actual intent: the statement is Harper's, not
the caller's. Wrap the individual statement, not the function — a later caller-dependent statement
must not inherit it.

A second body field has to be neutralized for any of this to hold: `evaluateSQL` trusts a supplied
`parsed_sql_object` verbatim and skips parsing, `chooseOperation` overwrites only the **top-level**
one, and `dataLayer/export.ts` hands the nested `search_operation` straight to `evaluateSQL`. So a
body-supplied `search_operation.parsed_sql_object` carrying `permissions_checked: true` would run an
arbitrary AST with the check skipped. `chooseOperation` deletes it, forcing the worker to re-parse
from the `sql` string that dispatch authorized — the nested object is never overwritten the way the
top-level one is, because nothing downstream should read one at all.

What is untestable is not the carrier's contract — unit tests cover that by calling
`runWithDispatchedOperation` directly — but that `jobProcess` is what establishes it. Delete that call
and those tests stay green. The carrier only changes an outcome through `tokenScopeDenial`, which is
inert unless the principal carries `tokenOperations`, and that property has exactly one origin: an
OIDC trust-policy exchange, for which there is no integration harness.

Three different mechanisms are easy to conflate here. `tokenOperations` above is the **OIDC token
operation scope** (#2174). An **inline-role scoped token** (`create_authentication_tokens` with a
`role` object) is not the same thing and cannot substitute, because `createScopedToken` mints it
`super_user: false`, so it cannot invoke a `requires_su` operation such as `export_local` at all.
**Table permissions** are a third, and also cannot substitute — see the system-schema exemption
above. See #2298.

## `chooseOperation` authorizes the invoked operation against the authenticated principal (`server/serverHelpers/serverUtilities.ts`)

`verifyPerms` takes a request-shaped object and reads _both_ halves of the permission question off it: the principal from `hdb_user`, and the tables from `schema`/`database`/`table`/`records`. `chooseOperation` used to hand it `json.search_operation` — a caller-supplied field — which made both halves body-controlled. Fixing one half and not the other is not a fix: with an empty `search_operation` the table map is empty, and `hasPermissions` iterating nothing authorizes everything. Regression cover: `integrationTests/security/choose-operation-authz.test.ts`.

Four rules hold this together, and all four are load-bearing:

**The principal comes from authentication.** Authentication sets only the _top-level_ `hdb_user`, and `validateRequestBodyProperties` inspects only top-level keys, so a nested `hdb_user` must be overwritten, never backfilled `if (!...)`. All four callers of `chooseOperation` (`serverHandlers`, `serverUtilities.operation`, `registeredOperations` worker forwarding, MCP) set the top-level principal before dispatch, which is why this belongs here rather than only at the HTTP boundary.

**`search_operation` is the permission subject only for the operations that consume it.** `dataLayer/export.ts` is its sole consumer (`export_local`, `export_to_s3`); for any other operation the substitution checks the nested tables while the handler runs against the top-level ones, so it is gated on the operation name. It must also be an object naming one of export's supported operations (`search_by_value`/`search_by_hash`/`search_by_conditions`/`sql`) — a primitive, `{}`, or an unsupported operation is a request-time 400, not a wrapped 500 or an asynchronously-failed job.

**One check cannot authorize both the outer export and its nested query.** The outer op's own `verifyPerms` returns before any table check — `export_local`/`export_to_s3` are `requires_su`, and a role that lists the operation in `operations` is granted at gate 2 (an explicit listing of an SU-only operation is a deliberate grant). The job worker then runs `search_operation` through `searchByValue`/`searchByHash`/`searchByConditions`, none of which check permissions. So the outer invocation is authorized first, and then the nested search is authorized additively against its _real_ search handler (`getOperationFunction(search_operation)`) and the authenticated principal — otherwise a role granted `export_local` could export a table it holds no grant on. A nested `sql` search takes the SQL branch instead, but the same two-part shape holds: the outer export op runs through `verifyPerms` (so its `requires_su` gate, the `operations` allowlist, and the export token scope all apply, exactly as on the non-SQL path — SQL must not be a way around the requires_su gate), the statement must be a `SELECT` because export is read-only, and `checkASTPermissions` then covers the statement's tables. A direct `sql` call has no outer job op, so there the `operations` allowlist alone is the operation-invocation check.

**`parsed_sql_object` is dispatch state, never client input.** The export worker re-reads it off the same caller-supplied nested object (`evaluateSQL`), and it carries `permissions_checked`, so a body-supplied one runs an AST no check ever saw. It is deleted from the nested object at dispatch, and stripped from the top-level object before this dispatch's own parse is assigned. Only the direct-SQL path consumes the top-level `parsed_sql_object`; a job re-parses off `search_operation`, so setting it for a job would be inert. The bypass/`apiOperation` decision is carried on async-context state (`getOperationAuthorizationState`), not on the request body, and `processAST` honors the denial `checkASTPermissions` computes — a `PermissionResponseObject` has no `length`, so the guard tests the object itself rather than `.length` (which always refused nothing).

The SQL and job paths are additive rather than exclusive: `verifyPermsAST` validates only the statement's tables and attributes, never the `operations` allowlist or `requires_su`, and a table-free statement gives it nothing to validate — so the allowlist check and the AST check both run for a SQL-carrying request, and the nested-search check runs alongside the outer export check for a job.

## `withNodeAdapter()`'s response is the body `PassThrough` it resolves with (`server/serverHelpers/NodeAdapterResponse.ts`)

`Request.withNodeAdapter(handler)` gives third-party Node middleware an `IncomingMessage`/`ServerResponse` pair and resolves `{ status, headers, body }` once headers are committed. The response is `NodeAdapterResponse extends PassThrough`, and that same stream is the resolved `body`: `write()`'s return value, `'drain'`, `'finish'`, `'close'`, `writableEnded`/`writableFinished` and destroy propagation are Node's own rather than events forwarded from a second stream, which is what `Readable.pipe`, `compression`'s buffered `res.on('drain')` and Next.js's response writer depend on past the high-water mark (#2527). Invariants that middleware exercises and the unit test `unitTests/server/serverHelpers/nodeAdapterMiddleware.test.js` pins against the real `compression` 1.8 (its `compression-1.7` arm, meant for the 1.7.4 that Next.js vendors, has resolved to 1.8.2 since #2877, so 1.7.4 is currently untested), `send`, `on-finished` and `on-headers`:

- **Headers commit exactly once, through `this.writeHead`.** `write()`, `end()`, `flushHeaders()` and `_implicitHeader()` all reach `this.writeHead(this.statusCode)` by property lookup, so a `writeHead` that `on-headers` replaced on the instance runs its listeners (the ones that set `Content-Encoding` and remove `Content-Length`) before the promise resolves. After commit, `setHeader`/`appendHeader`/`removeHeader` and a second `writeHead` throw `ERR_HTTP_HEADERS_SENT` as Node's do; `_header` (which `compression` ≤ 1.7 tests instead of `headersSent`) and `finished` (which `on-finished` tests) derive from that state.
- **The adapter owns the `'error'` listener.** A `destroy(err)` right after `writeHead()` emits before the awaiting caller can attach one; the error stays in the stream's `errored` state for `pipeline()`, `finished()` or async iteration. Client disconnect (`Request.signal`) destroys the response without an error after headers (a plain premature close, which `pipeBodyToResponse` treats as routine) and rejects the promise with the abort reason before them; a handler that throws or rejects before ending the response destroys it, and one that fails after `end()` is logged at warn.
- **Header names are case-insensitive on removal too.** `Headers.delete` lowercases like `set`/`get`/`has`; the inherited `Map.delete` silently left `send`'s `Content-Length` on a gzip body (truncated transfers).
- **Every piped chunk reaches `write()` by property lookup.** Node 26.11's `Readable.pipe` fast path (nodejs/node#66182) calls `_write()` directly when pipe's listener is a byte-mode source's only `'data'` listener, so `compression`'s instance patch of `res.write` was skipped for most chunks of `send(...).pipe(res)`: raw bytes inside the gzip stream, or a stall once `compression` had routed pipe's `'drain'` to its idle zlib stream. On runtimes that have the fast path (`'writeKnownBuffer' in Writable`, a static it added) the response adds an inert `'data'` listener to each byte-mode core `Readable` on `'pipe'`, which fails the fast path's single-listener check, and removes it on `'unpipe'` through a listener prepended in the constructor: pipe's own cleanup resumes a source awaiting `'drain'` while any `'data'` listener remains, which would leave an unpiped source flowing into nothing. Object-mode and decoded sources, and legacy `Stream.prototype.pipe` (which never emits `'unpipe'`), are skipped. Remove it once every supported Node 26 release dispatches pipe through an overridden `write()`.
- **Express is not a target.** `express`'s `app.handle()` replaces the response's prototype with one rooted at `http.ServerResponse.prototype`, which no Writable-derived response survives, and would do the same to the request `Proxy`'s target, Harper's real `IncomingMessage`. Middleware that duck-types the response (Next.js, `compression`, `send`, `serve-static`, `finalhandler`, h3, fastify) is the supported surface.

## A WebSocket close reason must be bounded to 123 bytes (`server/serverHelpers/webSocketCloseReason.ts`)

`ws` throws a `RangeError` when a close reason exceeds 123 bytes — the control-frame payload minus the
status code — and every close site Harper has reaches it from a rejection handler, where that throw
surfaces as an unhandled rejection rather than a failed close. Two of the reasons are outside Harper's
control: a `server.getUser` override's rejection text, and `request.pathname` in REST's no-resource
close. So every `ws.close()` carrying a dynamic reason goes through `toCloseReason()`, which truncates
on a code-point boundary (harper#2703).

The `ClassName: message` in a close reason is deliberate and not something to sanitize: the class name is
Harper's error code, and `errorToString` is the correct renderer for client-visible error text — see
AGENTS.md, "An error's class name is its error code". Only an internal fault's _message_ is replaced, by
`AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL`. The three terminal HTTP handlers (Node and Bun in
`server/http.ts`, uWS in `server/serverHelpers/uwsServer.ts`) must agree on that rendering; uWS rendered
the bare message until harper#2703, so the same error carried an error code on two runtimes and not the third.

REST settles a credential rejection _before_ its route lookup, so a rejected client gets the unauthorized
close rather than `1011 No resource was found` — which would otherwise disclose whether the resource exists.

## `serverErrorHandler` skips what `handlePostRequest` already logged (`server/serverHelpers/serverHandlers.ts`)

`handlePostRequest` logs every error it throws, at error level or the error's own higher `fatal`/`notify`, and records it against its request; `serverErrorHandler`, which Fastify calls next with the same request, skips that error. Keep the log in `handlePostRequest` rather than moving it to the handler: `serverErrorHandler` logs an error with no `logLevel` of its own at info, below the default `warn`, so most operation errors would disappear from a default log; and a custom-function route that catches `hdbCore.request()`'s rejection never reaches the handler at all. The record is keyed by request, not by error, so an error object that surfaces again in another request is still logged there.

So a failure raised before the operation runs — a refusal from `chooseOperation`, a rejected request body — gets one Error line (a refusal also writes `chooseOperation`'s own `403 from operation …` and `User '…' is not permitted to …` lines; the Error line is the one that says why). An error the operation throws while it runs does not: `callOperationFunctionAsAwait` (`utility/OperationFunctionCaller.ts`) logs it, after an `Error calling operation: <handler>` line, and rethrows, and `handlePostRequest` logs it again. Its log is the only one for the callers that do not log — `server.operation()` from a component, the MCP operations tool, the SSE branch of `handlePostRequest` — so giving execution errors a single owner means deciding it for each of those, not dropping one log.

## Response compression dispatches on the serialized output, with one brotli policy (`server/serverHelpers/contentTypes.ts`)

With `http.compressionThreshold` non-zero (the shipped default is 0, off) and `Accept-Encoding: br`, `serialize()` compresses. It chooses between `serialize` and `serializeStream` by the _input_ (iterable or not), but it chooses how to compress by what the serializer _returned_: a `serializeStream` handler may return a complete body (the built-in msgpack handler returns `pack(data)` for a plain array; third-party `server.contentTypes` handlers may return strings or generators). A string or byte body takes the single-buffer path, where the threshold applies; a Readable is compressed as-is; any other iterable is adapted with `Readable.from`, as `http.ts` does for uncompressed iterable bodies. Piping a non-stream failed the request (#2421).

The compressor is attached with `stream.pipeline`, not `.pipe()`: `.pipe()` does not forward a source error, so a source failing mid-stream left the compressor open and the response hanging. With `pipeline` the failure destroys the compressor, which the transport reports and closes abruptly ([A streamed response is completed only when its source ends cleanly](../DESIGN.md#a-streamed-response-is-completed-only-when-its-source-ends-cleanly-serverhttpts-serverserverhelpersuwsserverts)).

Both compressor call sites take their parameters from `brotliOptions(contentType)`. Node's brotli default is quality 11, which compresses at about 1–2 MB/s — seconds of libuv-pool CPU for a multi-megabyte response — while quality 2 runs at 400–600 MB/s for a third to a half more bytes than 11 on JSON. A second call site with its own parameters is how the single-buffer path came to run at quality 11 while the stream path ran at 2; keep one definition. The operations API's Fastify compression (`operationsServer.ts`) is configured separately.

### Configured JSON codec identity

`serverHelpers/contentTypes.ts` starts with the direct default BigInt codec functions, selects from available configuration at module end, and refreshes once through `onStartup` before listeners bind. The same initializer selects the response-compression threshold, preserving main's direct value lookup on each response rather than a lazy getter. This preserves direct serializer identity for shared-message encoding and removes codec-selection wrappers from each REST response and subscription message. The refresh only replaces media entries that still use the prior default; component-provided serializers remain intact. Native cycles can postpone configuration availability until startup. JSONStream's existing streaming and BigInt behavior is preserved.

## An event-stream field value is one line (`server/serverHelpers/contentTypes.ts`)

SSE has no escape for a field value: a CR or LF ends the field, so an `event`, `id` or `retry` value carrying one would add fields or a whole event. The `text/event-stream` serializer strips CR/LF from `event` and `id`, writes `retry` only when it is all ASCII digits (a client ignores any other value), and splits `data` into one `data:` line per line. Values are still coerced with `'' + value` (`valueOf` first), not `String()`, so an `event` or `id` without a line break serializes exactly as before; `retry` changes only for values a client ignores. Enforced by the SSE tests in `unitTests/server/serverHelpers/contentTypes.test.js` and the `LineBreakFieldsPayload` case in `integrationTests/server/qa702-sse-event-data.test.ts`.

## uWS and PROXY v2 peer-address text is Node's `socket.remoteAddress` text (`server/serverHelpers/peerAddress.ts`)

uWS and PROXY v2 TCP6 headers hand Harper raw address bytes. `formatPeerAddress` writes them as libuv's `inet_ntop` does, so a uWS peer's `request.ip` reads as the same peer's does on Node (`::1`; `::ffff:127.0.0.1` for an IPv4 client of a dual-stack listener), and so does a PROXY v2 TCP6 source. PROXY v1 passes the proxy's own text through. `unitTests/server/serverHelpers/peerAddress.test.js` pins it against `net.SocketAddress`. One gap: Node appends `%<zone>` to a link-local peer, and raw bytes carry no scope id. Local trust compares exact forms through `isLocalPeerAddress` (`127.0.0.x`, `::ffff:127.0.0.x`, `::1`), never a substring, because the Node form of IPv4-compatible `::7f00:1` is `::127.0.0.1`.

## An unread multipart upload is discarded once its response has finished (`server/serverHelpers/multipartParser.ts`)

`parseMultipartRequest` hands the route the file part as soon as it starts, and busboy reads the request, so Node counts the body as consumed and never discards it (`req._dump()` runs only for a request nothing reads). A route that answered without reading the part — a refusal in `deployComponent`, a `preValidation` failure such as a missing `operation`, an unknown operation — left busboy's backpressure holding the socket, so a client that kept sending (curl does while the connection stays alive) stalled for good after its answer. The CLI never saw it because it exits on the error.

`releaseUnreadUpload`, an `onResponse` hook that `registerContentHandlers` installs beside the parser, discards the rest of such a request: it unpipes and destroys busboy and resumes the parser's input, so Node reads the remaining bytes without parsing them and the connection stays reusable. Response completion is the point because a route may return a lazy stream that reads the payload while the response is sent; operation settlement is too early. A route keeps the part by reading it before its response finishes (piping, iterating, a `data` or `readable` listener); one it took but never started is discarded, and so is one it destroys before its end, even after the response (the part's `'close'` re-enters the discard). A pipe that loses its destination after the response, to a destination error or an `unpipe()`, leaves the part paused but not destroyed, so no `'close'` comes; while a part it handed out is still held after the response, the hook re-checks one tick after the part's own `unpipe()`, which every lost pipe ends in, or after its `data` listener is removed (#3096). The `unpipe()` is what Node 24.0 and 22.18 leave to go on: their pipe cleanup removes that listener without emitting `removeListener`. Only `data`: a reader looping on `once(part, 'readable')` holds no listener between reads. `pause` is no signal, because a part already paused by backpressure emits none. A consumer that pauses with its `data` listener still attached still holds the part, and the request timeout bounds that. A busboy error after the hand-off, such as a malformed trailer, discards the rest too, since Node unpipes an errored destination, and so does a file part the parser refuses for its name, which never reaches the route: its 400 goes out and the rest is not parsed. A request still arriving a second after its response is destroyed, unless its body has fully arrived by then (the connection may already carry the next request): a bounded grace period for the client to read the answer, chosen over closing at once (a reset can lose the response, RFC 9112 §9.6) and over draining until the request timeout, which `0` disables. The discarded rest still passes through any `preParsing` transform, such as `@fastify/compress`'s decompressor, for at most that second: its `pump` would destroy the request if the transform were torn down instead. The state is keyed by the Fastify request rather than `request.body.payload`, and the grace targets `request.raw`, which a `preParsing` transform can stand in front of. Every part busboy emits gets an `'error'` listener before anything touches it, so an abort after the hand-off is never an uncaught exception.

Node's `http` client is a misleading probe here: after a complete response arrives while its request waits for `'drain'`, it never resumes writing, although the server has read every byte it sent. The tests use raw sockets: `unitTests/server/serverHelpers/multipartParser.test.js`, the socket cases in `unitTests/server/serverHelpers/contentTypes.test.js`, and `integrationTests/deploy/deploy-multipart-stream.test.ts`.
