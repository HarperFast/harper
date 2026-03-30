---
id: configuration
title: HTTP Configuration
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (http section - primary) -->
<!-- Source: release-notes/v4-tucker/4.1.0.md (confirmed sessionAffinity introduction) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed http section expansion, compressionThreshold, securePort, tls section) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed http2 support) -->

The `http` section in `harperdb-config.yaml` controls the built-in HTTP server that serves REST, WebSocket, component, and Operations API traffic.

Harper must be restarted for configuration changes to take effect.

## Ports

### `http.port`

Type: `integer`

Default: `9926`

The port the HTTP server listens on. This is the primary port for REST, WebSocket, MQTT-over-WebSocket, and component traffic.

### `http.securePort`

Type: `integer`

Default: `null`

The port for HTTPS connections. Requires a valid `tls` section configured with certificate and key. When set, Harper accepts both plaintext (`http.port`) and TLS connections (`http.securePort`) simultaneously.

## TLS

TLS is configured in its own top-level `tls` section in `harperdb-config.yaml`, separate from the `http` section. It is shared by the HTTP server (HTTPS), the MQTT broker (secure MQTT), and any TLS socket servers. See [TLS Configuration](./tls) for all options including multi-domain (SNI) certificates and the Operations API override.

To enable HTTPS, set `http.securePort` and add a `tls` block:

```yaml
http:
  securePort: 9927

tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

## HTTP/2

### `http.http2`

Added in: v4.5.0

Type: `boolean`

Default: `false`

Enables HTTP/2 for all API endpoints. HTTP/2 requires TLS, so `http.securePort` must also be set.

```yaml
http:
  http2: true
  securePort: 9927
```

## Timeouts and Limits

### `http.headersTimeout`

Type: `integer`

Default: `60000` (ms)

Maximum time in milliseconds the server waits to receive the complete HTTP headers for a request.

### `http.keepAliveTimeout`

Type: `integer`

Default: `30000` (ms)

Milliseconds of inactivity after which the server closes an idle keep-alive connection.

### `http.timeout`

Type: `integer`

Default: `120000` (ms)

Maximum time in milliseconds before a request times out.

### `http.maxHeaderSize`

Type: `integer`

Default: `16394` (bytes)

Maximum allowed size of HTTP request headers.

### `http.requestQueueLimit`

Type: `integer`

Default: `20000` (ms)

The maximum estimated request queue time in milliseconds. When the queue exceeds this limit, requests are rejected with HTTP 503.

## Compression

### `http.compressionThreshold`

Added in: v4.2.0

Type: `number`

Default: `1200` (bytes)

For clients that support Brotli encoding (`Accept-Encoding: br`), responses larger than this threshold are compressed. Streaming query responses are always compressed for supporting clients, regardless of this setting (since their size is unknown upfront).

```yaml
http:
  compressionThreshold: 1200
```

## CORS

### `http.cors`

Type: `boolean`

Default: `true`

Enables Cross-Origin Resource Sharing, allowing requests from different origins.

### `http.corsAccessList`

Type: `string[]`

Default: `null`

An array of allowed origin domains when CORS is enabled. When `null`, all origins are allowed.

```yaml
http:
  cors: true
  corsAccessList:
    - https://example.com
    - https://app.example.com
```

### `http.corsAccessControlAllowHeaders`

Added in: v4.5.0

Type: `string`

Default: `"Accept, Content-Type, Authorization"`

Comma-separated list of headers allowed in the [`Access-Control-Allow-Headers`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers) response header for OPTIONS (preflight) requests.

## Session Affinity

### `http.sessionAffinity`

Added in: v4.1.0

Type: `string`

Default: `null`

Routes repeated requests from the same client to the same worker thread. This can improve caching locality and provide fairness in request handling.

Accepted values:

- `ip` — Route by the remote IP address. Use this when Harper is the public-facing server and each client has a distinct IP.
- `<header-name>` — Route by the value of any HTTP header (e.g., `Authorization`). Use this when Harper is behind a proxy where all requests share the same source IP.

```yaml
http:
  sessionAffinity: ip
```

:::caution
If Harper is behind a reverse proxy and you use `ip`, all requests will share the proxy's IP and will be routed to a single thread. Use a header-based value instead.
:::

## mTLS

### `http.mtls`

Added in: v4.3.0

Type: `boolean | object`

Default: `false`

Enables mutual TLS (mTLS) authentication for HTTP connections. When set to `true`, client certificates are verified against the CA specified in `tls.certificateAuthority`. Authenticated connections use the `CN` (common name) from the certificate subject as the Harper username.

```yaml
http:
  mtls: true
```

For granular control, specify an object:

| Property                  | Type              | Default        | Description                                                                                                                                                |
| ------------------------- | ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                    | string            | (CN from cert) | Authenticate all mTLS connections as this specific user. Set to `null` to skip credential-based authentication (requires combining with `required: true`). |
| `required`                | boolean           | `false`        | Reject any connection that does not provide a valid client certificate.                                                                                    |
| `certificateVerification` | boolean \| object | `false`        | Enable CRL/OCSP certificate revocation checking. See below.                                                                                                |

### `http.mtls.certificateVerification`

Added in: v4.7.0 (OCSP support)

Type: `boolean | object`

Default: `false`

When mTLS is enabled, Harper can verify the revocation status of client certificates using CRL (Certificate Revocation List) and/or OCSP (Online Certificate Status Protocol). Disabled by default; must be explicitly enabled for environments that require certificate revocation checking.

Set to `true` to enable with all defaults, or configure as an object:

**Global:**

- `failureMode` — `'fail-closed'` (default) | `'fail-open'`. Whether to reject or allow connections when revocation checking fails.

**CRL** (enabled by default when `certificateVerification` is enabled):

- `crl.enabled` — boolean, default `true`
- `crl.timeout` — ms to wait for CRL download, default `10000`
- `crl.cacheTtl` — ms to cache CRL, default `86400000` (24h)
- `crl.gracePeriod` — ms grace period after CRL `nextUpdate`, default `86400000` (24h)
- `crl.failureMode` — CRL-specific failure mode

**OCSP** (enabled by default as CRL fallback):

- `ocsp.enabled` — boolean, default `true`
- `ocsp.timeout` — ms to wait for OCSP response, default `5000`
- `ocsp.cacheTtl` — ms to cache successful responses, default `3600000` (1h)
- `ocsp.errorCacheTtl` — ms to cache errors, default `300000` (5m)
- `ocsp.failureMode` — OCSP-specific failure mode

Harper uses a CRL-first strategy with OCSP fallback. If both fail, the configured `failureMode` is applied.

**Examples:**

```yaml
# Basic mTLS, no revocation checking
http:
  mtls: true

# mTLS with revocation checking (recommended for production)
http:
  mtls:
    certificateVerification: true

# Require mTLS for all connections + revocation checking
http:
  mtls:
    required: true
    certificateVerification: true

# Custom verification settings
http:
  mtls:
    certificateVerification:
      failureMode: fail-closed
      crl:
        timeout: 15000
        cacheTtl: 43200000
      ocsp:
        timeout: 8000
        cacheTtl: 7200000
```

## Logging

HTTP request logging is disabled by default. Enabling the `http.logging` block turns on request logging.

### `http.logging`

Added in: v4.6.0

Type: `object`

Default: disabled

```yaml
http:
  logging:
    level: info # info = all requests, warn = 4xx+, error = 5xx
    path: ~/hdb/log/http.log
    timing: true # log request timing
    headers: false # log request headers (verbose)
    id: true # assign and log a unique request ID
```

The `level` controls which requests are logged:

- `info` (or more verbose) — All HTTP requests
- `warn` — Requests with status 400 or above
- `error` — Requests with status 500 or above

## Complete Example

```yaml
http:
  port: 9926
  securePort: 9927
  http2: true
  cors: true
  corsAccessList:
    - null
  compressionThreshold: 1200
  headersTimeout: 60000
  keepAliveTimeout: 30000
  timeout: 120000
  maxHeaderSize: 16384
  requestQueueLimit: 20000
  sessionAffinity: null
  mtls: false
  logging:
    level: warn
    path: ~/hdb/log/http.log
    timing: true

# tls is a top-level section — see TLS Configuration
tls:
  certificate: ~/hdb/keys/certificate.pem
  certificateAuthority: ~/hdb/keys/ca.pem
  privateKey: ~/hdb/keys/privateKey.pem
```

## Related

- [HTTP Overview](./overview)
- [HTTP API](./api)
- [TLS Configuration](./tls)
- [Security Overview](../security/overview.md)
- [Configuration Overview](../configuration/overview.md)
