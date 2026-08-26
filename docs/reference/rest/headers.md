---
title: REST Headers
---

<!-- Source: versioned_docs/version-4.7/reference/headers.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/rest.md (ETag/conditional request headers) -->

# REST Headers

Harper's REST interface uses standard HTTP headers for content negotiation, caching, and performance instrumentation.

## Response Headers

These headers are included in all Harper REST API responses:

| Header          | Example Value      | Description                                                                                                                                                                                               |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server-timing` | `db;dur=7.165`     | Duration of the operation in milliseconds. Follows the [Server-Timing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Server-Timing) standard and can be consumed by network monitoring tools. |
| `content-type`  | `application/json` | MIME type of the returned content, negotiated based on the `Accept` request header.                                                                                                                       |
| `etag`          | `"abc123"`         | Encoded version/last-modification time of the returned record. Used for conditional requests.                                                                                                             |
| `location`      | `/MyTable/new-id`  | Returned on `POST` responses. Contains the path to the newly created record.                                                                                                                              |

## Cache-Control

<VersionBadge version="v5.2.0" />

Harper applies a tiered Cache-Control policy to REST responses.

### Anonymous reads

For tables (or JS resource classes) that declare a `cacheControl` value, Harper emits that value verbatim on anonymous (unauthenticated) GET/HEAD `200`/`304` responses:

```
Cache-Control: public, max-age=60
```

See [`@table(cacheControl: "...")`](../database/schema.md#cachecontrol) for how to declare this value in your schema.

### Authenticated reads (identity floor)

Any response where a principal was resolved — or where credentials were rejected (including `401` and the login-redirect `302`) — receives an identity floor regardless of any table declaration:

```
Cache-Control: private, no-cache
Vary: Authorization
```

When cookie-based sessions are in use, `Cookie` is appended to `Vary`.

An app may explicitly set a `public` or `s-maxage` directive in a resource handler to opt an authenticated response into shared caching (per RFC 9111). The opt-in is trusted, except on `401` responses: a rejected request always receives `private, no-cache`.

### CORS responses

When CORS is enabled, responses that reflect an `Origin` header also emit `Vary: Origin` so that shared caches key correctly by origin. See [CORS configuration](../http/configuration.md#cors).

## Request Headers

### Content-Type

Specifies the format of the request body (for `PUT`, `PATCH`, `POST`):

```http
Content-Type: application/json
Content-Type: application/cbor
Content-Type: application/x-msgpack
Content-Type: text/csv
```

See [Content Types](./content-types.md) for the full list of supported formats.

### Accept

Specifies the preferred response format:

```http
Accept: application/json
Accept: application/cbor
Accept: application/x-msgpack
Accept: text/csv
```

### If-None-Match

Used for conditional GET requests. Provide the `ETag` value from a previous response to avoid re-fetching unchanged data:

```http
GET /MyTable/123
If-None-Match: "abc123"
```

If the record has not changed, Harper returns `304 Not Modified` with no body. This avoids serialization and network transfer overhead and works seamlessly with browser caches and external HTTP caches.

### Accept-Encoding

Harper supports standard HTTP compression. Including this header enables compressed responses:

```http
Accept-Encoding: gzip, br
```

Compression is particularly effective for JSON responses. For binary formats like CBOR, compression provides diminishing returns compared to the already-compact encoding.

### Authorization

Credentials for authenticating requests. See [Security Overview](../security/overview.md) for details on supported authentication mechanisms (Basic, JWT, mTLS).

### Sec-WebSocket-Protocol

When connecting via WebSocket for MQTT, the sub-protocol must be set to `mqtt` as required by the MQTT specification:

```http
Sec-WebSocket-Protocol: mqtt
```

## Content Type via URL Extension

As an alternative to the `Accept` header, content types can be specified using file-style extensions in the URL path:

```http
GET /product/some-id.csv
GET /product/.msgpack?category=software
```

This is not recommended for production use — prefer the `Accept` header for clean, standard HTTP interactions.

## See Also

- [REST Overview](./overview.md) — HTTP methods and URL structure
- [Content Types](./content-types.md) — Supported encoding formats
- [Security Overview](../security/overview.md) — Authentication headers and mechanisms
- [Response Header Hardening](../security/response-headers.md) — Adding browser security headers and cache-control to Harper responses (from a custom Resource, or at your own edge)
