---
id: api
title: HTTP API
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

<VersionBadge version="v5.2.0" /> (`name`, `before`, `after`, `urlPath`, and `host`)

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

| Property         | Type                                                                  | Description                                                                                                                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`            | string                                                                | The request target (path + query string), e.g. `/path?query=string`                                                                                                                                                                                                                                                                  |
| `method`         | string                                                                | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, etc.                                                                                                                                                                                                                                                                                    |
| `headers`        | [`Headers`](https://developer.mozilla.org/en-US/docs/Web/API/Headers) | Request headers                                                                                                                                                                                                                                                                                                                      |
| `pathname`       | string                                                                | Path portion of the URL, without query string                                                                                                                                                                                                                                                                                        |
| `protocol`       | string                                                                | `http` or `https`. Behind a TLS-terminating proxy that forwards PROXY protocol v2, this reflects the client's original scheme even though the proxy-to-Harper hop is plaintext.                                                                                                                                                      |
| `data`           | any                                                                   | Deserialized body, based on `Content-Type` header                                                                                                                                                                                                                                                                                    |
| `ip`             | string                                                                | Remote IP address of the client (or last proxy)                                                                                                                                                                                                                                                                                      |
| `host`           | string                                                                | Host from the request headers                                                                                                                                                                                                                                                                                                        |
| `session`        | object                                                                | Current cookie-based session (a `Table` record instance). Update with `request.session.update({ key: value })`. A cookie is set automatically the first time a session is updated or a login occurs.                                                                                                                                 |
| `connectionInfo` | object \| undefined                                                   | TLS facts a fronting proxy forwarded over PROXY protocol v2 — negotiated ALPN, SNI, TLS version/cipher, the client's JA3/JA4 fingerprint, and the verified mTLS client certificate chain. `undefined` for a direct connection or one without a v2 header. See [Connection info](#connection-info). <VersionBadge version="v5.2.0" /> |

### Connection info

<VersionBadge version="v5.2.0" />

When Harper runs behind a TLS-terminating proxy (for example, Harper Fabric's Symphony edge), the TLS handshake happens at the proxy, so facts about the client's TLS connection — its fingerprint, negotiated protocol, and any client certificate — are otherwise invisible to your application. When the proxy is configured to forward them over PROXY protocol v2, Harper decodes them and exposes them on `request.connectionInfo`:

```ts
interface ConnectionInfo {
	alpn?: string; // negotiated ALPN protocol, e.g. "h2"
	authority?: string; // SNI hostname from the ClientHello
	tls?: {
		version?: string; // e.g. "TLSv1.3"
		cipher?: string; // negotiated cipher suite
		verified?: boolean; // a client certificate was presented and the proxy verified it
	};
	ja3?: string; // JA3 fingerprint (32-char MD5 hex)
	ja4?: string; // JA4 fingerprint
	clientCertChain?: Buffer[]; // verified mTLS client certificate chain (DER, leaf first)
}
```

`request.connectionInfo` is `undefined` unless a PROXY v2 header was decoded; each field is present only when the proxy actually forwarded it. Reading the client's JA4 fingerprint — e.g. to make a bot or abuse decision — is simply:

```javascript
class Origin {
	get(request) {
		const ja4 = request.connectionInfo?.ja4;
		if (ja4 && abuseList.has(ja4)) throw new Error('blocked');
		return fetch(request);
	}
}
```

**Trust and mTLS.** `connectionInfo` is populated only from the trusted proxy-protocol channel (Harper Fabric's per-worker Unix domain socket, writable only by the local proxy) — never from a request header, so a client cannot forge it. `tls.verified` reflects the proxy's verify bit: it can be `true` even when `clientCertChain` is absent (a proxy may verify a certificate but omit an oversized chain). For gating on a verified mTLS client identity, use the parsed [`request.peerCertificate`](../security/certificate-verification.md) and the connection's authenticated user, not `connectionInfo.tls.verified` alone.

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

| Property                    | Type                                      | Description                                                                                                                        |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `serialize(data)`           | `(any) => Buffer \| Uint8Array \| string` | Serialize data for a response                                                                                                      |
| `serializeStream(data)`     | `(any) => ReadableStream`                 | Serialize as a stream (for async iterables or large data)                                                                          |
| `deserialize(buffer)`       | `(Buffer \| string) => any`               | Deserialize an incoming request body. Used when `deserializeStream` is absent. String for `text/*` types, Buffer for binary types. |
| `deserializeStream(stream)` | `(ReadableStream) => any`                 | Deserialize an incoming request stream                                                                                             |
| `q`                         | number (0–1)                              | Quality indicator for content negotiation. Defaults to `1`.                                                                        |

---

## Related

- [HTTP Overview](./overview)
- [HTTP Configuration](./configuration)
- [REST Overview](../rest/overview.md)
- [Security API](../security/api.md)
