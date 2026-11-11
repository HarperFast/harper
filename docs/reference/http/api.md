---
id: api
title: HTTP API
sidebar_position: 30
sidebar_label: 'API'
---

<!-- Source: versioned_docs/version-4.7/reference/globals.md (server global - primary) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed server.authenticateUser introduction) -->

The `server` global object is available in all Harper component code. It provides access to the HTTP server middleware chain, WebSocket server, authentication, resource registry, and cluster information.

## `server.http(listener, options)`

Add a handler to the HTTP request middleware chain.

```ts
server.http(listener: RequestListener, options?: HttpOptions): HttpServer[]
```

Returns an array of `HttpServer` instances based on the `options.port` and `options.securePort` values.

**Example:**

```js
server.http(
	(request, next) => {
		if (request.url === '/graphql') return handleGraphQLRequest(request);
		return next(request);
	},
	{ runFirst: true }
);
```

### `RequestListener`

```ts
type RequestListener = (request: Request, next: RequestListener) => Promise<Response>;
```

To continue the middleware chain, call `next(request)`. To short-circuit, return a `Response` (or `Response`-like object) directly.

### `HttpOptions`

<VersionBadge version="v5.1.0" /> (`name`, `before`, `after`, `urlPath`, and `host`)

| Property     | Type    | Default                      | Description                                                                                                                                                                                              |
| ------------ | ------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | string  | Registering component's name | Name this middleware entry so other entries can position themselves relative to it                                                                                                                       |
| `before`     | string  | -                            | Run this entry before the named middleware entry                                                                                                                                                         |
| `after`      | string  | -                            | Run this entry after the named middleware entry                                                                                                                                                          |
| `urlPath`    | string  | -                            | Only handle requests whose pathname matches this prefix on a segment boundary (`/api` matches `/api` and `/api/x`, not `/apinews`). Harper removes the prefix before passing the request to the handler. |
| `host`       | string  | -                            | Only handle requests whose `Host` header matches this virtual hostname (case-insensitive, port ignored). IPv6 hosts are given as a bare literal (`::1`), not bracketed.                                  |
| `runFirst`   | boolean | `false`                      | Deprecated. Insert this handler at the front of the chain. Use `before` or `after` for explicit ordering.                                                                                                |
| `port`       | number  | `http.port`                  | Target the HTTP server on this port                                                                                                                                                                      |
| `securePort` | number  | `http.securePort`            | Target the HTTPS server on this port                                                                                                                                                                     |

`host` and `urlPath` create a routed middleware chain. When both are present, both must match. Harper selects the most specific matching chain in this order: host and path, host only, then path only. Longer path prefixes take precedence. A request that matches no routed chain uses the default chain.

```js
server.http(handleAdminRequest, {
	name: 'admin',
	host: 'admin.example.com',
	urlPath: '/api',
	after: 'authentication',
});
```

For this example, a request to `https://admin.example.com/api/users` reaches `handleAdminRequest` with a pathname of `/users`.

### `HttpServer`

A Node.js [`http.Server`](https://nodejs.org/api/http.html#class-httpserver) or [`https.SecureServer`](https://nodejs.org/api/https.html#class-httpsserver) instance.

---

## `Request`

A `Request` object is passed to HTTP middleware handlers and direct static REST handlers. It follows the [WHATWG `Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request) API with additional Harper-specific properties.

### Properties

| Property          | Type                                                                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | string                                                                | The request target (path + query string), e.g. `/path?query=string`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `method`          | string                                                                | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `headers`         | [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers) | Request headers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pathname`        | string                                                                | Path portion of the URL, without query string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `protocol`        | string                                                                | `http` or `https`. On the Node runtime, behind a TLS-terminating proxy that forwards the PROXY v2 SSL TLV, this reflects the client's original scheme even though the proxy-to-Harper hop is plaintext; a proxy forwarding only address info (no SSL TLV) still reads as `http`. Bun and uWebSockets derive this from `X-Forwarded-Proto`/the listener's secure flag instead, independent of the SSL TLV. <VersionBadge type="changed" version="v5.2.0" />                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `data`            | any                                                                   | Deserialized body, based on `Content-Type` header                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ip`              | string                                                                | Remote IP address of the client (or last proxy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `host`            | string                                                                | Host from the request headers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session`         | object                                                                | Current cookie-based session (a `Table` record instance). Update with `request.session.update({ key: value })`. A cookie is set automatically the first time a session is updated or a login occurs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `connectionInfo`  | object \| undefined                                                   | TLS facts a fronting proxy forwarded over PROXY protocol v2 — negotiated ALPN, SNI, TLS version/cipher, the client's JA3/JA4 fingerprint, and the client's mTLS certificate chain (presented, not necessarily verified — see below). `undefined` for a direct connection or one without a v2 header. See [Connection info](#connection-info). <VersionBadge version="v5.2.0" />                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `authorized`      | boolean \| undefined                                                  | Whether the client's certificate passed TLS verification — Node's `socket.authorized`. On a directly-terminated connection this is verification against Harper's configured certificate authorities (`tls.certificateAuthority`, or a certificate record marked as an authority — see [Certificate Verification](../security/certificate-verification.md)); behind Harper Fabric's proxy-protocol UDS mirror it instead reflects Symphony's own, separately configured client CA, forwarded as a single trust bit (see [Trust and mTLS](#connection-info)). `false` for an unverified or absent client certificate on either path, including a mirrored connection where the proxy verified the client but omitted its oversized chain. `undefined` on a plain (non-TLS, non-mirrored) connection, and always `undefined` on Bun and uWebSockets. <VersionBadge type="changed" version="v5.2.0" />                                                                                                                                                                                                                                                                               |
| `peerCertificate` | object \| null                                                        | The client's TLS peer certificate — Node's `socket.getPeerCertificate(true)`, cached after the first read. On a direct connection this is Node's full certificate object. `issuerCertificate` is present only when Node can resolve the issuer, so it's absent on a resumed TLS session, on Node.js 26.8.0/26.8.1, and when the issuer is in neither the client's sent chain nor Harper's trusted CAs (for example, an unverified client when mTLS is optional) — check it before reading its fields; behind the Fabric UDS mirror it's a smaller object parsed from the forwarded chain (subject, issuer, subjectaltname, validity, serial number, fingerprints, `raw`, `issuerCertificate` — no `pubkey`, `bits`, `modulus`, `ca`, or `ext_key_usage`, though `raw` can be re-parsed for those). An empty object (`{}`) if no certificate was presented, if the proxy verified the certificate but omitted the chain, or if the forwarded leaf fails to parse (rare, but possible even when `authorized` is `true`); `null` on a connection with no TLS/mTLS support at this layer, and always `null` on Bun and uWebSockets. <VersionBadge type="changed" version="v5.2.0" /> |

### Connection info

<VersionBadge version="v5.2.0" />

When Harper runs behind a TLS-terminating proxy (for example, Harper Fabric's Symphony edge), the TLS handshake happens at the proxy, so facts about the client's TLS connection — its fingerprint, negotiated protocol, and any client certificate — are otherwise invisible to your application. Harper Fabric's proxy-protocol Unix domain socket mirrors decode this from a forwarded PROXY protocol v2 header and expose it on `request.connectionInfo`; a PROXY v2 header sent to an ordinary `http.port`/`securePort` listener isn't decoded (and isn't valid HTTP, so the connection fails).

```ts
interface ConnectionInfo {
	alpn?: string; // negotiated ALPN protocol, e.g. "h2" — raw, unvalidated
	authority?: string; // SNI hostname from the ClientHello — raw, unvalidated
	tls?: {
		version?: string; // e.g. "TLSv1.3"
		cipher?: string; // negotiated cipher suite
		verified?: boolean; // a client certificate was presented and the proxy verified it
	};
	ja3?: string; // JA3 fingerprint (32-char MD5 hex) — raw, unvalidated
	ja4?: string; // JA4 fingerprint — raw, unvalidated
	clientCertChain?: Buffer[]; // client certificate chain (DER, leaf first) — presented, not necessarily verified; check tls.verified
}
```

`request.connectionInfo` is `undefined` unless a PROXY v2 header carrying TLS facts was decoded; each field is present only when the proxy actually forwarded it. On the Bun and uWebSockets runtimes it is always `undefined`. `alpn`, `authority`, `ja3`, and `ja4` are string-decoded from the TLV payload with no grammar or length validation beyond the header's own bounds, so validate them before placing them in response headers, logs, cache keys, or other security-sensitive contexts. Reading the client's JA4 fingerprint — e.g. to make a bot or abuse decision — is simply:

```javascript
class Origin {
	get(request) {
		const ja4 = request.connectionInfo?.ja4;
		if (ja4 && abuseList.has(ja4)) return new Response('blocked', { status: 403 });
		return fetch(request);
	}
}
```

**Trust and mTLS.** `connectionInfo` is populated only from the trusted proxy-protocol channel (Harper Fabric's per-worker Unix domain socket, writable only by the local proxy) — never from a request header, so the channel itself cannot be forged by a client (its _contents_ are client-controlled, per above). `clientCertChain` and `tls.verified` are independent signals, not one another's proof: a chain is attached whenever the client presented a certificate, whether or not the proxy verified it, and `tls.verified` can be `true` while `clientCertChain` is absent (a proxy may verify a certificate but omit an oversized chain). Treating chain presence alone as proof of a verified client accepts unverified certificates. For gating on a verified mTLS client, use [`request.authorized`](#properties) rather than `connectionInfo.tls.verified` or `clientCertChain` presence alone — it's `false` (not just absent) for an unverified or absent client certificate on either path, including a mirrored chain the proxy verified but omitted. `authorized` reflects chain trust only. Revocation is checked separately, by Harper's mTLS authentication and only when `http.mtls` is configured (see [Certificate Verification](../security/certificate-verification.md)), so in your own middleware a revoked certificate can still read `authorized: true`. The proxy path verifies against Symphony's own, separately configured client CA, not Harper's own configured certificate authorities. A directly-terminated `authorized: true` and a mirrored `authorized: true` therefore aren't guaranteed to share a trust root, even though both gate the same way. To read the certificate itself, [`request.peerCertificate`](#properties) is populated the same way, but the mirror's version carries fewer fields than a direct connection's (see the table). Like `connectionInfo`, both are Node-runtime only: `request.authorized` and `request.peerCertificate` are always `undefined`/`null` on Bun and uWebSockets.

### Methods

#### `request.login(username, password)`

```ts
login(username: string, password: string): Promise<void>
```

Authenticates the user by username and password. On success, creates a session and sets a cookie on the response. Rejects if authentication fails.

#### `request.sendEarlyHints(link, headers?)`

```ts
sendEarlyHints(link: string, headers?: object): void
```

Sends an [Early Hints](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/103) (HTTP 103) response before the final response. Useful in cache resolution functions to hint at preloadable resources:

```javascript
class Origin {
	async get(request) {
		this.getContext().requestContext.sendEarlyHints('<link rel="preload" href="/my-resource" as="fetch">');
		return fetch(request);
	}
}
Cache.sourcedFrom(Origin);
```

### Low-Level Node.js Access

:::caution
These properties expose the raw Node.js request/response objects and should be used with caution. Using them can break other middleware handlers that depend on the layered `Request`/`Response` pattern.
:::

| Property        | Description                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `_nodeRequest`  | Underlying [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) |
| `_nodeResponse` | Underlying [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse)   |

---

## `Response`

REST method handlers can return:

- **Data directly** — Serialized using Harper's content negotiation
- **A `Response` object** — The WHATWG [`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response)
- **A `Response`-like object** — A plain object with the following properties:

| Property  | Type                                                                  | Description                                       |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `status`  | number                                                                | HTTP status code (e.g. `200`, `404`)              |
| `headers` | [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers) | Response headers                                  |
| `data`    | any                                                                   | Response data, serialized via content negotiation |
| `body`    | Buffer \| string \| ReadableStream \| Blob                            | Raw response body (alternative to `data`)         |

---

## `server.ws(listener, options)`

Add a handler to the WebSocket connection middleware chain.

```ts
server.ws(listener: WsListener, options?: WsOptions): HttpServer[]
```

**Example:**

```js
server.ws((ws, request, chainCompletion) => {
	chainCompletion.then(() => {
		ws.on('message', (data) => console.log('received:', data));
		ws.send('hello');
	});
});
```

### `WsListener`

```ts
type WsListener = (ws: WebSocket, request: Request, chainCompletion: Promise<void>, next: WsListener) => Promise<void>;
```

| Parameter         | Description                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ws`              | [`WebSocket`](https://github.com/websockets/ws/blob/main/doc/ws.md#class-websocket) instance                              |
| `request`         | Harper `Request` object from the upgrade event                                                                            |
| `chainCompletion` | `Promise` that resolves when the HTTP request chain finishes. Await before sending to ensure the HTTP request is handled. |
| `next`            | Continue chain: `next(ws, request, chainCompletion)`                                                                      |

### `WsOptions`

WsOptions supports the same options as [HttpOptions](#httpoptions), plus:

| Property     | Type   | Default | Description                                     |
| ------------ | ------ | ------- | ----------------------------------------------- |
| `maxPayload` | number | 100 MB  | Maximum WebSocket message size accepted by `ws` |

---

## `server.upgrade(listener, options)`

Add a handler to the HTTP server `upgrade` event. Use this to delegate upgrade events to an external WebSocket server.

```ts
server.upgrade(listener: UpgradeListener, options?: UpgradeOptions): void
```

**Example** (from the Harper Next.js component):

```js
server.upgrade(
	(request, socket, head, next) => {
		if (request.url === '/_next/webpack-hmr') {
			return upgradeHandler(request, socket, head).then(() => {
				request.__harperRequestUpgraded = true;
				next(request, socket, head);
			});
		}
		return next(request, socket, head);
	},
	{ runFirst: true }
);
```

When `server.ws()` is registered, Harper adds a default upgrade handler. The default handler sets `request.__harperRequestUpgraded = true` after upgrading, and checks for this flag before upgrading again (so external upgrade handlers can detect whether Harper has already handled the upgrade).

### `UpgradeListener`

```ts
type UpgradeListener = (request: IncomingMessage, socket: Socket, head: Buffer, next: UpgradeListener) => void;
```

### `UpgradeOptions`

UpgradeOptions supports the same options as [HttpOptions](#httpoptions).

---

## `server.socket(listener, options)`

Create a raw TCP or TLS socket server.

```ts
server.socket(listener: ConnectionListener, options: SocketOptions): SocketServer
```

Only one socket server is created per call. A `securePort` takes precedence over `port`.

### `ConnectionListener`

Node.js connection listener as in [`net.createServer`](https://nodejs.org/api/net.html#netcreateserveroptions-connectionlistener) or [`tls.createServer`](https://nodejs.org/api/tls.html#tlscreateserveroptions-secureconnectionlistener).

### `SocketOptions`

| Property     | Type   | Description                                                                |
| ------------ | ------ | -------------------------------------------------------------------------- |
| `port`       | number | Port for a [`net.Server`](https://nodejs.org/api/net.html#class-netserver) |
| `securePort` | number | Port for a [`tls.Server`](https://nodejs.org/api/tls.html#class-tlsserver) |

### `SocketServer`

A Node.js [`net.Server`](https://nodejs.org/api/net.html#class-netserver) or [`tls.Server`](https://nodejs.org/api/tls.html#class-tlsserver) instance.

---

## `server.authenticateUser(username, password)`

<VersionBadge version="v4.5.0" />

```ts
server.authenticateUser(username: string, password: string): Promise<User>
```

Returns the user object for the given username after verifying the password. Throws if the password is incorrect.

Use this when you need to explicitly verify a user's credentials (e.g., in a custom login endpoint). For lookup without password verification, use [`server.getUser()`](#servergetuserusername).

---

## `server.getUser(username)`

```ts
server.getUser(username: string): Promise<User>
```

Returns the user object for the given username without verifying credentials. Use for authorization checks when the user is already authenticated.

When a client certificate names the user and `server.getUser` is overridden, Harper authenticates the request or MQTT connection with a shallow copy of a plain-object result, so later changes to the returned object's top-level properties do not reach it. Any other object, such as a class instance, is used as returned, and its live subscriptions need a role.

---

## `server.registerBearerValidator(validator, options?)`

<VersionBadge version="v5.4.0" />

```ts
server.registerBearerValidator(
	validator: (token: string, request: Request, signal: AbortSignal) => BearerValidatorResult | Promise<BearerValidatorResult>,
	options?: { timeoutMs?: number }
): () => void
```

Lets a component accept `Authorization: Bearer` tokens that Harper did not issue, such as access tokens from the component's own OAuth authorization server. A token a validator accepts sets `request.user` before routing, so every Harper-owned route on the application port — REST, GraphQL, WebSocket and MQTT-over-WebSocket, and MCP — authorizes it like any other Harper user.

Harper checks its own operation and refresh tokens first. A Bearer token Harper rejects as invalid is offered to each registered validator in registration order, until one claims it. Validators do not run on a dedicated operations API port. Applications load in no fixed order, so a validator should claim only tokens it can identify, for example by issuer.

A validator returns one of:

| Return                                         | Result                                                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null` or `undefined`                          | Not this validator's token. The next validator runs; if none claims it, the token is treated as unrecognized (see [Authentication and fallthrough](./overview.md#authentication-and-fallthrough)). |
| `{ username, authExpiresAt?, authCacheable? }` | Authenticate as the Harper user `username`, resolved through [`server.getUser()`](#servergetuserusername), with that user's own role.                                                              |

The object may contain only these fields; any other field, including `role`, fails the request. Permissions always come from the user's role. A user that `server.getUser()` cannot find, or one without a role, is rejected like an unknown user.

- `authExpiresAt` - epoch seconds when the authentication expires: the cached result is dropped, live subscriptions opened with the token end, and its MQTT last-will message is no longer published. It must be at most a year ahead, or the request fails; when omitted, it is 5 minutes after authentication. If the token is a JWT, Harper also caps it at the token's `exp` claim and refuses the token once that has passed, even when the validator accepted it. Harper does not verify the JWT, so the validator must still check expiry, and should return the verified expiry here.
- `authCacheable` - `false` to run the validator on every request. Otherwise Harper caches the result by the `Authorization` header and reuses it on every route until `authExpiresAt` or the next [`authentication.cacheTTL`](../security/configuration.md#cachettl) flush (every 30 seconds by default), whichever comes first. A validator whose answer depends on the request (for example a token bound to one resource's audience) must return `false`.

Because results are cached, a revoked token can still be accepted on new requests for up to one `authentication.cacheTTL` period, plus the time an authentication already in progress takes to finish. Return `authCacheable: false` if a revoked token must be refused on the next request. Harper does not run the validator again for live subscriptions opened with the token: they run until `authExpiresAt`, so return an earlier `authExpiresAt` if they must end sooner.

To refuse a token the validator recognizes (wrong audience, revoked, expired), throw `credentialRejectionError(message, 401)` or a `markCredentialRejection(error)`-tagged error, both exported from `harper`. That is reported like a rejected Harper token. Any other thrown error, a result that breaks the rules above, or exceeding `timeoutMs` fails the request with a generic `401` and logs the error server-side. Any throw ends the chain, so later validators do not run: catch errors from verifying a token another issuer may own, and return `null` instead.

`options.timeoutMs` limits each call to the validator: a positive number of milliseconds up to `60000`, default `5000`. Registering with any other value throws a `TypeError`. The validators and the `server.getUser()` lookup of a returned username also share one deadline per request, equal to the largest `timeoutMs` among the registered validators: if one validator takes 3 seconds to decline, the next has what remains. When a limit runs out, the request fails with a generic `401`, and a validator still running has its `signal` aborted; pass `signal` to `fetch` or other I/O the validator starts. A limit cannot interrupt synchronous work.

A request authenticated this way cannot call `create_authentication_tokens` to mint a scoped token, or ordinary tokens without a username and password; see [Create Authentication Tokens](../security/jwt-authentication.md#create-authentication-tokens).

The returned function unregisters the validator. Registrations last for the life of the worker thread. A plugin that registers through the `scope.server` passed to `handleApplication` has them removed if that load fails.

```js
import { server, credentialRejectionError } from 'harper';

server.registerBearerValidator(async (token, request, signal) => {
	const claims = await verifyMyAccessToken(token, { signal }); // returns null for tokens this issuer did not sign
	if (!claims) return null;
	if (claims.aud !== 'https://api.example.com') throw credentialRejectionError('wrong audience', 401);
	return { username: claims.harper_user, authExpiresAt: claims.exp };
});
```

---

## `server.resources`

The central registry of all resources exported for REST, MQTT, and other protocols.

### `server.resources.set(name, resource, exportTypes?)`

Register a resource:

```js
class NewResource extends Resource {}
server.resources.set('NewResource', NewResource);

// Limit to specific protocols:
server.resources.set('NewResource', NewResource, { rest: true, mqtt: false });
```

### `server.resources.getMatch(path, exportType?)`

Find a resource matching a path:

```js
server.resources.getMatch('/NewResource/some-id');
server.resources.getMatch('/NewResource/some-id', 'rest');
```

---

## `server.operation(operation, context?, authorize?)`

Execute an [Operations API](../operations-api/overview.md) operation programmatically.

```ts
server.operation(operation: object, context?: { username: string }, authorize?: boolean): Promise<any>
```

| Parameter   | Type                   | Description                                          |
| ----------- | ---------------------- | ---------------------------------------------------- |
| `operation` | object                 | Operations API request body                          |
| `context`   | `{ username: string }` | Optional: execute as this user                       |
| `authorize` | boolean                | Whether to apply authorization. Defaults to `false`. |

An operation runs on the thread that registered it. Built-in operations run on the calling thread. An operation registered only on the main thread, such as the [built-in agent's](../operations-api/operations.md#agent), is sent there from a worker thread and its result is returned to the caller, so application code can call it in-process. The main thread applies the operation's permission check to the `context` user when `authorize` is `true`.

A call that runs on another thread differs from a local one in these ways:

- It does not join the caller's transaction. What it commits stays committed if the caller's transaction later aborts, and it cannot see the caller's uncommitted writes.
- The request and the result are copied between threads, so they must be structured-cloneable. A streamed result is refused with status `501`.
- It fails with status `503` if no answer arrives within `operationsApi.network.timeout` (120 seconds by default). The operation may still have run, so do not repeat a call that is not safe to repeat.
- A failure arrives as an error with the operation's message, `statusCode`, and its `code` and `retryable` fields when the operation set them.

---

## `server.recordAnalytics(value, metric, path?, method?, type?)`

Record a metric into Harper's analytics system.

```ts
server.recordAnalytics(value: number, metric: string, path?: string, method?: string, type?: string): void
```

| Parameter | Description                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| `value`   | Numeric value (e.g. duration in ms, bytes)                                   |
| `metric`  | Metric name                                                                  |
| `path`    | Optional URL path for grouping (omit per-record IDs — use the resource name) |
| `method`  | Optional HTTP method for grouping                                            |
| `type`    | Optional type for grouping                                                   |

Metrics are aggregated and available via the [analytics API](../analytics/overview.md).

---

## `server.config`

The parsed `harper-config.yaml` configuration object. Read-only access to Harper's current runtime configuration.

---

## `server.nodes`

Returns an array of node objects registered in the cluster.

## `server.shards`

Returns a map of shard number to an array of associated nodes.

## `server.hostname`

Returns the hostname of the current node.

## `server.contentTypes`

Returns the `Map` of registered content type handlers. Same as the global [`contentTypes`](#contenttypes) object.

---

## `contentTypes`

A [`Map`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map) of content type handlers for HTTP request/response serialization. Harper uses content negotiation: the `Content-Type` header selects the deserializer for incoming requests, and the `Accept` header selects the serializer for responses.

### Built-in Content Types

| MIME type             | Description        |
| --------------------- | ------------------ |
| `application/json`    | JSON               |
| `application/cbor`    | CBOR               |
| `application/msgpack` | MessagePack        |
| `text/csv`            | CSV                |
| `text/event-stream`   | Server-Sent Events |

### Custom Content Type Handlers

Register or replace a handler by setting it on the `contentTypes` map:

```js
import { contentTypes } from 'harper';

contentTypes.set('text/xml', {
	serialize(data) {
		return '<root>' + serialize(data) + '</root>';
	},
	q: 0.8, // quality: lower = less preferred during content negotiation
});
```

### Handler Interface

| Property                | Type                                                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serialize(data)`       | `(any) => Buffer \| Uint8Array \| string \| Readable`                | Serialize a complete response body. Used when the response body is not iterable, or when the handler defines no `serializeStream`. Most handlers return a string or a `Buffer`; the built-in `text/csv` handler returns a [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable), which Harper streams to the response.                                                                          |
| `serializeStream(data)` | `(any) => Readable \| Iterable \| AsyncIterable \| Buffer \| string` | Serialize a streaming response body. Called once per response with the whole iterable (not once per chunk), and only when the response body is an object that is iterable or async iterable. A Node.js [`Readable`](https://nodejs.org/api/stream.html#class-streamreadable) is the usual return, but it is not the only one — see [Return values from `serializeStream`](#return-values-from-serializestream). |
| `deserialize(buffer)`   | `(Buffer) => any`                                                    | Deserialize an incoming request body. Harper always passes a `Buffer`, including for `text/*` types — a text handler calls `buffer.toString()` itself.                                                                                                                                                                                                                                                          |
| `q`                     | number (0–1)                                                         | Quality indicator for content negotiation. Defaults to `1`.                                                                                                                                                                                                                                                                                                                                                     |

#### Return values from `serializeStream`

`serializeStream` may return a `Readable`, any iterable or async iterable (a generator, for example), a `Buffer`, or a string. Harper writes all of these to the response: a `Readable` is piped, an iterable is wrapped with `Readable.from()`, and a `Buffer` or string is sent as the whole body.

A `Readable` is the usual return, but the non-stream forms are not theoretical. Harper picks `serializeStream` over `serialize` whenever the response body is iterable, and a plain array is iterable — so a resource that returns an array reaches `serializeStream` even when there is nothing to stream incrementally. A handler can serialize the value in one shot in that case: the built-in `application/x-msgpack` handler streams only non-array iterables, and returns a packed `Buffer` for a plain array.

Harper's own `ContentTypeHandler` TypeScript interface is currently narrower than this runtime contract, so a typed handler returning a `Readable` or an iterable may need a cast.

<VersionBadge type="changed" version="v5.3.0" /> Every return form above is also compressed when response compression is enabled (`http.compressionThreshold` set to a non-zero value) and the client sends `Accept-Encoding: br`: a returned `Buffer` or string is compressed as a whole body when its `length` exceeds the threshold (a string's `length` counts UTF-16 code units, not UTF-8 bytes, so a non-ASCII string can be over the threshold in bytes and still be sent uncompressed), and a returned `Readable` or iterable is compressed as a stream. Before v5.3.0, a `Buffer`, string, or generator return failed with `TypeError: stream.pipe is not a function` under compression, so a handler targeting older releases should return a `Readable` — `Readable.from([value])` wraps an already-serialized value.

---

## Related

- [HTTP Overview](./overview)
- [HTTP Configuration](./configuration)
- [REST Overview](../rest/overview.md)
- [Security API](../security/api.md)
