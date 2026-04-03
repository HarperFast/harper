---
title: REST Overview
---

<!-- Source: versioned_docs/version-4.7/developers/rest.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/components/built-in-extensions.md (rest plugin config options) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (REST interface introduced) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (URL path improvements, directURLMapping, record count removal) -->

# REST Overview

<VersionBadge version="v4.2.0" />

Harper provides a powerful, efficient, and standard-compliant HTTP REST interface for interacting with tables and other resources. The REST interface is the recommended interface for data access, querying, and manipulation over HTTP, providing the best performance and HTTP interoperability with different clients.

## How the REST Interface Works

Harper's REST interface exposes database tables and custom resources as RESTful endpoints. Tables are **not** exported by default; they must be explicitly exported in a schema definition. The name of the exported resource defines the base of the endpoint path, served on the application HTTP server port (default `9926`).

For more on defining schemas and exporting resources, see [Database / Schema](../database/schema.md).

## Configuration

Enable the REST interface by adding the `rest` plugin to your application's `config.yaml`:

```yaml
rest: true
```

**Options**:

```yaml
rest:
  lastModified: true # enables Last-Modified response header support
  webSocket: false # disables automatic WebSocket support (enabled by default)
```

## URL Structure

The REST interface follows a consistent URL structure:

| Path                                         | Description                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/my-resource`                               | Root path — returns a description of the resource (e.g., table metadata)                          |
| `/my-resource/`                              | Trailing slash indicates a collection — represents all records; append query parameters to search |
| `/my-resource/record-id`                     | A specific record identified by its primary key                                                   |
| `/my-resource/record-id/`                    | Trailing slash — the collection of records with the given id prefix                               |
| `/my-resource/record-id/with/multiple/parts` | Record id with multiple path segments                                                             |

<VersionBadge type="changed" version="v4.5.0" /> — Resources can be defined with nested paths and accessed by exact path without a trailing slash. The `id.property` dot syntax for accessing properties via URL is only applied to properties declared in a schema.

## HTTP Methods

REST operations map to HTTP methods following uniform interface principles:

### GET

Retrieve a record or perform a search. Handled by the resource's `get()` method.

```http
GET /MyTable/123
```

Returns the record with primary key `123`.

```http
GET /MyTable/?name=Harper
```

Returns records matching `name=Harper`. See [Querying](./querying.md) for the full query syntax.

```http
GET /MyTable/123.propertyName
```

Returns a single property of a record. Only works for properties declared in the schema.

#### Conditional Requests and Caching

GET responses include an `ETag` header encoding the record's version/last-modification time. Clients with a cached copy can include `If-None-Match` on subsequent requests. If the record hasn't changed, Harper returns `304 Not Modified` with no body — avoiding serialization and network transfer overhead.

### PUT

Create or replace a record with a specified primary key (upsert semantics). Handled by the resource's `put(record)` method. The stored record will exactly match the submitted body — any properties not included in the body are removed from the previous record.

```http
PUT /MyTable/123
Content-Type: application/json

{ "name": "some data" }
```

Creates or replaces the record with primary key `123`.

### POST

Create a new record without specifying a primary key, or trigger a custom action. Handled by the resource's `post(data)` method. The auto-assigned primary key is returned in the `Location` response header.

```http
POST /MyTable/
Content-Type: application/json

{ "name": "some data" }
```

### PATCH

Partially update a record, merging only the provided properties (CRDT-style update). Unspecified properties are preserved.

<VersionBadge version="v4.3.0" />

```http
PATCH /MyTable/123
Content-Type: application/json

{ "status": "active" }
```

### DELETE

Delete a specific record or all records matching a query.

```http
DELETE /MyTable/123
```

Deletes the record with primary key `123`.

```http
DELETE /MyTable/?status=archived
```

Deletes all records matching `status=archived`.

## Content Types

Harper supports multiple content types for both request bodies and responses. Use the `Content-Type` header for request bodies and the `Accept` header to request a specific response format.

See [Content Types](./content-types.md) for the full list of supported formats and encoding recommendations.

## OpenAPI

<VersionBadge version="v4.3.0" />

Harper automatically generates an OpenAPI specification for all resources exported via a schema. This endpoint is available at:

```http
GET /openapi
```

## See Also

- [Querying](./querying.md) — Full URL query syntax, operators, and examples
- [Headers](./headers.md) — HTTP headers used by the REST interface
- [Content Types](./content-types.md) — Supported formats (JSON, CBOR, MessagePack, CSV)
- [WebSockets](./websockets.md) — Real-time connections via WebSocket
- [Server-Sent Events](./server-sent-events.md) — One-way streaming via SSE
- [HTTP Server](../http/overview.md) — Underlying HTTP server configuration
- [Database / Schema](../database/schema.md) — How to define and export resources
