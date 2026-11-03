---
title: Content Types
---

<!-- Source: versioned_docs/version-4.7/reference/content-types.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/rest.md (content negotiation section) -->

# Content Types

Harper supports multiple content types (MIME types) for both HTTP request bodies and response bodies. Harper follows HTTP standards: use the `Content-Type` request header to specify the encoding of the request body, and use the `Accept` header to request a specific response format.

```http
Content-Type: application/cbor
Accept: application/cbor
```

All content types work with any standard Harper operation.

## Supported Formats

### JSON — `application/json`

JSON is the most widely used format, readable and easy to work with. It is well-supported across all HTTP tooling.

**Limitations**: JSON does not natively support all Harper data types — binary data, `Date`, `Map`, and `Set` values require special handling. JSON also produces larger payloads than binary formats.

**When to use**: Web development, debugging, interoperability with third-party clients, or when the standard JSON type set is sufficient. Pairing JSON with compression (`Accept-Encoding: gzip, br`) often yields compact network transfers due to favorable Huffman coding characteristics.

### CBOR — `application/cbor`

CBOR is the recommended format for most production use cases. It is a highly efficient binary format with native support for the full range of Harper data types, including binary data, typed dates, and explicit Maps/Sets.

**Advantages**: Very compact encoding, fast serialization, native streaming support (indefinite-length arrays for optimal time-to-first-byte on query results). Well-standardized with growing ecosystem support.

**When to use**: Production APIs, performance-sensitive applications, or any scenario requiring rich data types.

### MessagePack — `application/x-msgpack`

MessagePack is another efficient binary format similar to CBOR, with broader adoption in some ecosystems. It supports all Harper data types.

**Limitations**: MessagePack does not natively support streaming arrays, so query results are returned as a concatenated sequence of MessagePack objects. Decoders must be prepared to handle a sequence of values rather than a single document.

**When to use**: Systems with existing MessagePack support that don't have CBOR available, or when interoperability with MessagePack clients is required. CBOR is generally preferred when both are available.

### CSV — `text/csv`

Comma-separated values format, suitable for data export and spreadsheet import/export. CSV lacks hierarchical structure and explicit typing.

**When to use**: Ad-hoc data export, spreadsheet workflows, batch data processing. Not recommended for frequent or production API use.

## When a Streamed Response Fails

A collection query, or any resource that returns an iterable, is streamed: Harper sends the `200` status and headers, then writes records as it reads them. If reading fails after that, the status can no longer change, so JSON, NDJSON and Server-Sent Events report the failure in the body.

### JSON

<VersionBadge type="changed" version="v5.4.0" />

When a streamed JSON array fails partway through, Harper writes an `{"error": "<Name>: <message>"}` element, leaves out the closing `]`, and aborts the response. On HTTP/1.1 the connection closes without the final chunk; on HTTP/2 the stream is reset.

```
[{"id":1},{"id":2},{"error":"ReadSnapshotExpiredError: Read scan snapshot expired; ..."}
```

Treat a cut-off body as a failed read, even though the status was `200`. A network error while reading the body, or `response.json()` rejecting, means the result is incomplete. The `error` element is a best-effort diagnostic: if the client is not reading when the failure happens, it can be lost along with unread records. The abort always happens.

Before v5.4.0, Harper closed the array after the `error` element and ended the response normally, so a partial result parsed as a complete array.

A request that writes and then streams a result, such as a `POST` whose handler returns query results, has already committed its writes when the stream fails. Retrying it can apply them again. The `error` element includes `replicationUnconfirmed: true` when the writes committed locally but their replication was not confirmed, and `retryable: false` when the request should not be retried.

On RocksDB, a long streamed read can fail this way when the client stops reading for longer than [`storage.maxTransactionOpenTime`](../database/storage-tuning.md#storagemaxtransactionopentime).

### Other Formats

NDJSON and Server-Sent Events end a failed stream with a terminal record, unchanged in v5.4.0:

| Format                                                              | Terminal record                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| NDJSON (`application/x-ndjson`, `application/ndjson`)               | A final line `{"$harperStreamError": { ... }}`           |
| [Server-Sent Events](./server-sent-events.md) (`text/event-stream`) | An `event: harper-error` event whose `data` is `{ ... }` |

The object has `error` (the error code or class name), `message`, and, when they apply, `status`, `replicationUnconfirmed: true`, and `retryable: false`.

A MessagePack response writes no error record. Harper aborts it, and the body can end at a record boundary and look like a shorter, valid result, so treat a network error while reading as a failed read.

## Content Type via URL Extension

As an alternative to the `Accept` header, responses can be requested in a specific format using file-style URL extensions:

```http
GET /product/some-id.csv
GET /product/.msgpack?category=software
```

Using the `Accept` header is the recommended approach for clean, standard HTTP interactions.

## Custom Content Types

Harper's content type system is extensible. Custom handlers for any serialization format (XML, YAML, proprietary formats, etc.) can be registered in the [`contentTypes`](../components/javascript-environment.md#contenttypes) global Map.

## Storing Arbitrary Content Types

When a `PUT` or `POST` is made with a non-standard content type (e.g., `text/calendar`, `image/gif`), Harper stores the content as a record with `contentType` and `data` properties:

```http
PUT /my-resource/33
Content-Type: text/calendar

BEGIN:VCALENDAR
VERSION:2.0
...
```

This stores a record equivalent to:

```json
{ "contentType": "text/calendar", "data": "BEGIN:VCALENDAR\nVERSION:2.0\n..." }
```

Retrieving a record that has `contentType` and `data` properties returns the response with the specified `Content-Type` and body. If the content type is not from the `text` family, the data is treated as binary (a Node.js `Buffer`).

Use `application/octet-stream` for binary data or for uploading to a specific property:

```http
PUT /my-resource/33/image
Content-Type: image/gif

...image data...
```

## See Also

- [REST Overview](./overview.md) — HTTP methods and URL structure
- [Headers](./headers.md) — Content negotiation headers
- [Querying](./querying.md) — URL query syntax
