---
title: REST Headers
sidebar_position: 40
sidebar_label: 'Headers'
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

Collection responses to a [count request](./querying.md#pagination-and-total-count) additionally include `Content-Range`, `Range-Unit`, and `Preference-Applied` (<VersionBadge version="v5.3.0" />).

### `Harper-Index-Coverage`

<VersionBadge version="v5.3.0" />

A non-waiting request that uses a full-text index can include `Harper-Index-Coverage`. Its value is one of:

- `current; lag=0; tolerance=<requested-ms>`: the index covered current committed data at admission.
- `bounded; lag=<upper-bound-ms>; tolerance=<requested-ms>`: the admitted lag upper bound was within the requested tolerance.

Multiple native searches append one value each. The header certifies coverage when the search is admitted; it does not certify a later traversal. See [Full-text freshness controls](../full-text-search/querying.md#freshness-controls).

When CORS is enabled, Harper adds this header to `Access-Control-Expose-Headers` so browser clients can read it.

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

### Conditional Writes

<VersionBadge type="changed" version="v5.4.0" />

A `PUT`, `PATCH` or `DELETE` of a single table record honors `If-Match`, `If-None-Match` and `If-Unmodified-Since`. Harper checks the condition once against the stored record before it writes anything. A failed condition returns `412 Precondition Failed` and changes nothing.

```http
PATCH /MyTable/123
If-Match: "abc123"
Content-Type: application/json

{ "quantity": 4 }
```

`If-None-Match: *` creates the record only if it does not exist. Dates have one-second precision, so use the `ETag` for a version-level check.

Whether two requests that saw the same `ETag` can both succeed depends on the node. With [`rest.preconditionLocks`](./overview.md#configuration) at its default (`true`), on RocksDB:

| Where the record is                                                                                | Concurrent conditional writes that saw the same `ETag`                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A replicated table, with cluster record locks enabled (Harper Pro `replication.recordLocks`)       | Checked under the record's cluster lock, one request at a time: one succeeds, and the others get `412`. Right after a home node restarts or the home map changes, the next node to take the lock may not yet see the last write. |
| A table that is not replicated: Harper without replication, or a table declared `replicate: false` | One succeeds on that node. The others get `412`.                                                                                                                                                                                 |
| A replicated table, with cluster record locks not enabled                                          | All can succeed, and the last write wins. The condition is checked without a lock.                                                                                                                                               |

With `rest.preconditionLocks: false`, or on LMDB, every conditional write is checked without a lock. With cluster record locks enabled but no home map in place yet, a conditional write to a replicated table fails with `503`. In a cluster where only some nodes enable record locks, a conditional write on a node without them is not serialized against writes on the others.

### Accept-Encoding

When response compression is enabled with [`http.compressionThreshold`](../http/configuration.md#httpcompressionthreshold) (it is off by default), Harper Brotli-compresses responses for clients that include `br` in this header. Brotli is the only encoding Harper applies, so a client that accepts only `gzip` receives an uncompressed body:

```http
Accept-Encoding: gzip, br
```

Compression is particularly effective for JSON responses. For binary formats like CBOR, compression provides diminishing returns compared to the already-compact encoding.

### Prefer

<VersionBadge version="v5.3.0" />

Opt in to a total match count on a collection `GET`/`HEAD`, returned via the `Content-Range` response header for pagination:

```http
GET /Product/?category=software&limit(0,25)
Prefer: count=estimated
```

Accepts `count=exact` (precise, scans the full matched set) or `count=estimated` (fast, approximate). See [Pagination and Total Count](./querying.md#pagination-and-total-count) for the full request/response contract.

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
