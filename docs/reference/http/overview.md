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

Added in: v4.1.0 (worker threads for HTTP requests)

Changed in: v4.2.0 (switched from process-per-thread model with session-affinity delegation to `SO_REUSEPORT` socket sharing)

In previous versions: Session-affinity based socket delegation was used to route requests. This has been deprecated in favor of `SO_REUSEPORT`.

## Request Handling

Harper uses a layered middleware chain for HTTP request processing. Components and applications can add handlers to this chain using the [`server.http()`](./api#serverhttplistener-options) API. Handlers are called in order; each handler can either process the request and return a `Response`, or pass it along to the next handler with `next(request)`.

Request and response objects follow the [WHATWG Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) conventions (`Request` and `Response` classes), providing good composability for layered middleware and clean mapping to REST resource handlers.

## Protocols Served

The HTTP server handles multiple protocols on the same port:

- **REST** — CRUD operations on Harper resources via standard HTTP methods
- **WebSockets** — Real-time bidirectional connections (via `server.ws()`)
- **MQTT over WebSocket** — MQTT clients connecting over WebSocket (sub-protocol `mqtt`)
- **Server-Sent Events** — Streaming updates to browser clients
- **Operations API** — Management API (configurable to share or use separate port)

## TLS / HTTPS

HTTPS support is enabled by setting `http.securePort` in `harperdb-config.yaml` and configuring the `tls` section with a certificate and private key. The same `tls` configuration is shared by HTTPS and MQTT secure connections.

See [Configuration](./configuration) for TLS options and [Security](../security/overview.md) for certificate management details.

## HTTP/2

Added in: v4.5.0

HTTP/2 can be enabled with the `http2: true` option in `harperdb-config.yaml`. When enabled, HTTP/2 applies to all API endpoints served on `http.securePort` (HTTP/2 requires TLS).

## Compression

Harper automatically compresses HTTP responses using Brotli for clients that advertise `Accept-Encoding: br`. Compression applies when the response body exceeds the configured `compressionThreshold` (default 1200 bytes). Streaming query responses are always compressed for clients that support it (since their size is not known upfront).

## Logging

HTTP request logging is not enabled by default. To enable it, add an `http.logging` block to your configuration. See [Configuration](./configuration#logging) for details.

## Related

- [HTTP Configuration](./configuration)
- [HTTP API](./api)
- [REST Overview](../rest/overview.md)
- [Security Overview](../security/overview.md)
