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
  exactCount: false # serve Prefer: count=exact requests as estimates instead of scanning
```

<VersionBadge version="v5.3.0" /> `exactCount` (default `false`) controls whether the [pagination total-count](./querying.md#pagination-and-total-count) feature honors `Prefer: count=exact`. Because an exact count scans the full matched set, it is off by default and such requests are served as cheaper estimates; set it to `true` for this application's REST interface to enable exact counts.

## Tables and Their Automatic Endpoints

This section describes the **default table Resource** — the endpoints Harper registers automatically for a table, with no handler code of your own. Harper serves that default Resource only when **both** of the following are true:

1. The table is exported in a schema definition with [`@export`](../database/schema.md#export). This is always required.
2. REST is enabled for the application. `rest: true` must be present in `config.yaml` **whenever a configuration file exists** (see [Configuration](#configuration)); a component directory with no configuration file at all inherits `rest` from Harper's built-in default instead, as described below.

```graphql
# schema.graphql
type Product @table @export {
	id: Long @primaryKey
	name: String
	price: Float
}
```

```yaml
# config.yaml
graphqlSchema:
  files: schema.graphql
rest: true
```

Neither half is sufficient on its own. Without `@export` Harper registers no default Resource for the table, so it has no REST route and callers get `404`. Without REST enabled the REST handler is never registered for the application, so even an exported table does not respond to HTTP requests. Writing `rest: true` is what enables it in a `config.yaml` — the only way REST is enabled without that line is the no-configuration-file case below.

`@export` is how the **table itself** claims the URL. When a JavaScript subclass of `tables.MyTable` should own that URL instead, omit `@export` from the schema and export the class — the class claims the route and serves whatever it implements, and REST still has to be enabled. Leaving `@export` on the schema while also exporting a same-named subclass produces conflicting endpoints. See [Extending a Table](../resources/overview.md#extending-a-table).

:::note Components with no configuration file
Enabling REST is normally explicit, with one exception: a component directory that has **no configuration file at all**. Harper falls back to a built-in default for those, and that default enables `rest` and loads `*.graphql` from the component root — so a bare directory containing only a schema file does serve its exported tables without a `config.yaml`.

The fallback is all or nothing. As soon as a configuration file exists it is used verbatim, with no merge against the built-in default, so a `config.yaml` that omits `rest` turns REST off even though the same directory would have had it with no file present. If you add a configuration file, add `rest: true` with it.
:::

With both in place, the exported name becomes the base path (`Product` above, or the `name` argument of `@export`) and Harper serves the following endpoints on the application HTTP server port (default `9926`). No route definitions, controllers, or handler code are required.

| Endpoint                     | Description                                                                                                                                                             | Details                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `GET /Product`               | Describes the resource — table name, database, and declared attributes — plus an href to the record collection. No trailing slash.                                      | [GET](#get)                            |
| `GET /Product/`              | The record collection. Append query parameters to search, filter, sort, and page.                                                                                       | [GET](#get), [Querying](./querying.md) |
| `GET /Product/{id}`          | A single record by primary key; `404` when no such record exists.                                                                                                       | [GET](#get)                            |
| `GET /Product/{id}.property` | A single property of one record. Only properties declared in the schema.                                                                                                | [GET](#get)                            |
| `POST /Product/`             | Creates a record and responds `201`, with a Harper-assigned primary key when the body does not supply one. Requires the trailing slash — `POST /Product` returns `404`. | [POST](#post)                          |
| `PUT /Product/{id}`          | Creates or replaces the record at `{id}` (upsert). The stored record matches the body exactly — properties omitted from the body are **removed**.                       | [PUT](#put)                            |
| `PATCH /Product/{id}`        | Merges the body into the existing record, preserving unspecified properties. The merge is **shallow** — a nested object in the body replaces the stored one wholesale.  | [PATCH](#patch)                        |
| `DELETE /Product/{id}`       | Deletes the record at `{id}`.                                                                                                                                           | [DELETE](#delete)                      |
| `DELETE /Product/?query`     | Deletes every record matching the query. With no query parameters, this matches — and deletes — every record in the table.                                              | [DELETE](#delete)                      |

Notes on this surface:

- The trailing slash is significant throughout: `/Product` addresses the resource itself, `/Product/` addresses its collection of records. See [URL Structure](#url-structure).
- `HEAD` is served exactly as `GET` with the response body omitted. `QUERY` is accepted on the collection path (`QUERY /Product/`) and runs a search taken from the request body rather than the URL.
- A collection `POST` only generates a primary key when the body omits the table's primary-key property. If the body supplies one, Harper stores the record under that value rather than replacing it, and a `POST` to a key that already exists fails with `409` instead of overwriting.
- On a successful `POST`, the new record's primary key — supplied or generated — is returned in the `Location` response header. The header carries the bare key value, not a URL, so it is not a link to follow.
- `PUT` replaces the stored record, with three exceptions that Harper always applies: a [`@createdTime`](../database/schema.md#createdtime) attribute keeps the original record's value, an [`@updatedTime`](../database/schema.md#updatedtime) attribute is re-stamped with the time of the write, and the primary key is forced to match the `{id}` in the URL even if the body carries a different one.
- Enabling `rest` also registers [WebSocket](./websockets.md) subscriptions on these same resource paths **by default**. Setting `webSocket: false` under `rest` (see [Configuration](#configuration)) suppresses that registration while leaving REST itself serving.
- [Server-Sent Events](./server-sent-events.md) subscriptions are served on these same paths as well, negotiated per request with `Accept: text/event-stream`. They come with `rest` and are not affected by the `webSocket` option.
- Every **non-hidden** exported resource is included in the generated [OpenAPI](#openapi) document. A type marked [`@hidden`](../database/schema.md#hidden-type-directive), or a programmatic Resource with [`static hidden = true`](../resources/resource-api.md#static-hidden-boolean), is omitted from it.
- Custom resource classes exported from an application get the same URL structure and method mapping; they implement the methods themselves rather than inheriting the table behavior above. See [Resource API](../resources/resource-api.md).

## URL Structure

The REST interface follows a consistent URL structure:

| Path                                         | Description                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/my-resource`                               | Root path — returns a description of the resource (e.g., table metadata)                          |
| `/my-resource/`                              | Trailing slash indicates a collection — represents all records; append query parameters to search |
| `/my-resource/record-id`                     | A specific record identified by its primary key                                                   |
| `/my-resource/record-id/`                    | Trailing slash — the collection of records with the given id prefix                               |
| `/my-resource/record-id/with/multiple/parts` | Record id with multiple path segments                                                             |

<VersionBadge type="changed" version="v4.5.0" /> — Resources can be defined with nested paths and accessed by exact path without a trailing slash. The `id.property` dot syntax for accessing properties via URL is only applied to declared properties (see [below](#get)).

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

Returns a single property of a record. Only works for declared properties — a table's schema attributes, or a programmatic Resource's [`static properties`](../resources/resource-api.md#static-properties-recordstring-jsonschemafragment) <VersionBadge type="changed" version="v5.2.0" />. An undeclared name is treated as part of the record id instead. The suffixes `.json`, `.cbor`, `.msgpack`, and `.csv` are reserved as content-type selectors and take precedence, so a property with one of those names is not reachable this way.

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

Create a new record, or trigger a custom action. Handled by the resource's `post(data)` method. The new record's primary key is returned in the `Location` response header — the value the body supplied, if it carried the primary-key property, and otherwise a Harper-assigned key.

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

:::warning
The merge is **shallow** (top-level only). Preserving "unspecified properties" applies only to top-level attributes.

If the request body includes a nested object, that entire sub-object is **replaced** rather than deep-merged. Any omitted nested properties will be dropped.

**Example:**

- **Existing record:** `{"settings": {"theme": "light", "notifications": {"email": true}}}`
- **PATCH request body:** `{"settings": {"theme": "dark"}}`
- **Resulting record:** `{"settings": {"theme": "dark"}}` (the `notifications` object is lost)

To update a single nested field, you must either:

1. Read-modify-write the parent object.
2. Send the full nested object with the updated values.

Note that dot-path keys (e.g., "settings.theme") are stored literally as keys and are not interpreted as paths.
:::

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
