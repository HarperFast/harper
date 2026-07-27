---
id: overview
title: HTTP Server
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (http section - primary) -->
<!-- Source: versioned_docs/version-4.7/reference/globals.md (server global) -->
<!-- Source: release-notes/v4-tucker/4.1.0.md (confirmed worker threads introduction) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed SO_REUSEPORT / socket management changes) -->

Harper includes a built-in HTTP server that serves as the primary interface for REST, WebSocket, MQTT-over-WebSocket, and component-defined endpoints. The same server handles all application traffic on a configurable port (default `9926`).

## Architecture

Harper's HTTP server is multi-threaded. Each thread runs an independent copy of the HTTP stack, and incoming connections are distributed across threads using `SO_REUSEPORT` socket sharing — the most performant mechanism available for multi-threaded socket handling.

<VersionBadge version="v4.1.0" /> (worker threads for HTTP requests)

<VersionBadge type="changed" version="v4.2.0" /> (switched from process-per-thread model with session-affinity delegation to `SO_REUSEPORT` socket sharing)

In previous versions: Session-affinity based socket delegation was used to route requests. This has been deprecated in favor of `SO_REUSEPORT`.

## Request Handling

Harper uses a layered middleware chain for HTTP request processing. Components and applications can add handlers to this chain using the [`server.http()`](./api#serverhttplistener-options) API. Handlers are called in order; each handler can either process the request and return a `Response`, or pass it along to the next handler with `next(request)`.

Request and response objects follow the [WHATWG Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) conventions (`Request` and `Response` classes), providing good composability for layered middleware and clean mapping to REST resource handlers.

### Middleware routing

<VersionBadge version="v5.2.0" />

Harper can route middleware by URL prefix, virtual hostname, or both, with no dispatch code in the application. Where an application is served is a deployment concern, so declare it on that application's entry in the root `harper-config.yaml`:

```yaml
# harper-config.yaml
my-app:
  host: api.example.com
  urlPath: /v1
```

Every handler the application registers — HTTP, WebSocket, and upgrade — is then served under `api.example.com/v1`, and Harper removes `/v1` from the pathname before invoking the chain. Requests that match no routed chain use the default middleware chain.

Because routing lives in the root config, the same application package can be mounted at a different hostname or path per environment without editing the application. The entry does not need a `package` — routing applies to any application in the components root, however it was deployed.

You can also set it at deploy time:

```bash
harper deploy project=my-app package=@my/app host=api.example.com urlPath=/v1
```

#### Routing individual plugins

A plugin's own `urlPath` sets where it sits **within** the application, and is configured in the application's `config.yaml`:

```yaml
# my-app/config.yaml
static:
  files: 'web/**'
  urlPath: assets
```

The application's mount composes with it rather than replacing it, so app-internal structure survives being relocated. With the root config above, the static files are served at `api.example.com/v1/assets/`. A plugin that configures no `urlPath` of its own is served at the mount itself (`api.example.com/v1`).

An application can also set `host` per plugin, but a `host` on the root-config entry overrides it — the operator's choice of hostname wins over one the application shipped.

Handlers see the request with the mount already removed from the pathname, so application code addresses itself mount-relative and does not need to know where it is mounted.

#### What a mount does not do

A mount is a routing prefix, not an isolation boundary:

- **It does not namespace resources.** Exported tables live in one instance-wide registry, so a table exported by one application is reachable through any mounted REST route, not only its own.
- **It does not constrain legacy Fastify routes by host.** `fastifyRoutes` registers as a global fallback outside the routed middleware chain, so those routes answer on every hostname. A `urlPath` mount does apply (it becomes the Fastify route prefix); a `host` mount does not, and Harper logs a warning when a host-mounted application declares `fastifyRoutes`. Port them to `server.http()` for host routing.

Host matching ignores the port and is case-insensitive. IPv6 hosts are configured as a bare literal (`::1`), not bracketed.

Custom components can configure the same behavior programmatically with `server.http(listener, { host, urlPath })`. See [`HttpOptions`](./api#httpoptions) for matching priority and middleware ordering options.

## Protocols Served

The HTTP server handles multiple protocols on the same port:

- **REST** — CRUD operations on Harper resources via standard HTTP methods
- **WebSockets** — Real-time bidirectional connections (via `server.ws()`)
- **MQTT over WebSocket** — MQTT clients connecting over WebSocket (sub-protocol `mqtt`)
- **Server-Sent Events** — Streaming updates to browser clients
- **Operations API** — Management API (configurable to share or use separate port)

## TLS / HTTPS

HTTPS support is enabled by setting `http.securePort` in `harper-config.yaml` and configuring the `tls` section with a certificate and private key. The same `tls` configuration is shared by HTTPS and MQTT secure connections.

See [Configuration](./configuration) for TLS options and [Security](../security/overview.md) for certificate management details.

## HTTP/2

<VersionBadge version="v4.5.0" />

HTTP/2 can be enabled with the `http2: true` option in `harper-config.yaml`. When enabled, HTTP/2 applies to all API endpoints served on `http.securePort` (HTTP/2 requires TLS).

## Compression

Harper automatically compresses HTTP responses using Brotli for clients that advertise `Accept-Encoding: br`. Compression applies when the response body exceeds the configured `compressionThreshold` (default 1200 bytes). Streaming query responses are always compressed for clients that support it (since their size is not known upfront).

## Logging

HTTP request logging is not enabled by default. To enable it, add an `http.logging` block to your configuration. See [Configuration](./configuration#logging) for details.

## Related

- [HTTP Configuration](./configuration)
- [HTTP API](./api)
- [REST Overview](../rest/overview.md)
- [Security Overview](../security/overview.md)
