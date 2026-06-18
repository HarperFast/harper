---
title: MCP Configuration
---

# MCP Configuration

<VersionBadge version="v5.1.0" />

All MCP configuration lives under the top-level `mcp:` block in `harperdb-config.yaml`. Each profile (`operations`, `application`) is enabled by the **presence** of its sub-block — there is no separate `enabled` flag. A minimal "turn it on" config is therefore just:

```yaml
mcp:
  operations: {}
  application: {}
```

That boots both profiles with default settings: the operations profile mounts at `/mcp` on the operations server, the application profile mounts at `/mcp` on the application HTTP server, and the default allow lists / rate limits apply.

## `mcp.operations.*`

Configures the operations-profile MCP endpoint that wraps Harper's operation catalog.

### `mcp.operations.mountPath`

Type: `string`

Default: `/mcp`

URL path the MCP endpoint mounts on. Change it if `/mcp` collides with another route in your application.

### `mcp.operations.allow`

Type: `array<string>` (glob patterns or literal operation names)

Default: `['describe_*', 'list_*', 'search_*', 'get_job', 'get_status', 'get_analytics', 'get_metrics', 'system_information', 'read_log', 'read_audit_log']`

Operations exposed as MCP tools. Glob `*` matches any sequence of characters; literal names match exactly. Setting `allow` **replaces** the default list; it does not merge. To add destructive or sensitive operations to the surface (e.g. `set_configuration`, `drop_table`), include them here explicitly.

The default list intentionally avoids `get_*` as a glob because that pulls in `get_configuration` (which can return TLS / S3 / authentication secrets), `get_components` / `get_component_file` / `get_custom_function*` (which return component source that can embed secrets), `get_backup`, and `get_deployment*`. These are all gated by `verifyPerms` at dispatch, but defaulting to "expose them to an LLM if a super_user calls them" is the wrong default — opt them in deliberately.

### `mcp.operations.deny`

Type: `array<string>` (glob patterns or literal operation names)

Default: `[]`

Operations to filter out **after** the allow list has been applied. Useful for taking back a single operation that a broad allow glob would otherwise expose.

### `mcp.operations.maxTools`

Type: `integer` (minimum 1)

Default: `200`

Maximum number of tools returned in a single `tools/list` response page. The MCP cursor is used to page through any overflow.

### `mcp.operations.rateLimit.*`

See [`mcp.<profile>.rateLimit.*`](#mcpprofileratelimit) below — the schema is identical for both profiles.

Default per-profile values for `operations`: `perToolPerSecond: 10`, `perToolBurst: 20`, `sessionConcurrency: 25`, `sessionPerSecond: 100`.

## `mcp.application.*`

Configures the application-profile MCP endpoint that walks your exported `Resource` classes. All `mcp.operations.*` keys above also apply here; the additional knob is:

### `mcp.application.searchMaxResults`

Type: `integer` (minimum 1)

Default: `1000`

Hard cap on the number of records a generated `search_<resource>` tool can return per call. Clients still pass `limit`, but the server clamps to this ceiling regardless of what the client requests — bounded to keep a runaway agent from exhausting memory.

Default per-profile rate-limit values for `application`: `perToolPerSecond: 25`, `perToolBurst: 50`, `sessionConcurrency: 50`, `sessionPerSecond: 200`.

## `mcp.<profile>.rateLimit.*`

Per-session, per-tool token-bucket rate limits. A bucket exists per `(session, tool)` pair plus one per-session bucket across all tools. When either bucket is exhausted, `tools/call` returns `result.isError = true` with `kind: "rate_limited"` — **not** a JSON-RPC error — so the LLM can read the message and back off without the transport tearing down.

### `mcp.<profile>.rateLimit.perToolPerSecond`

Type: `number` (minimum 0)

Default: `10` (operations) / `25` (application)

Sustained rate at which the per-tool token bucket refills. Set to `0` to disable per-tool throttling on this profile.

### `mcp.<profile>.rateLimit.perToolBurst`

Type: `number` (minimum 0)

Default: `20` (operations) / `50` (application)

Burst capacity of the per-tool token bucket — how many back-to-back calls a single tool can absorb before sustained-rate refill kicks in.

### `mcp.<profile>.rateLimit.sessionConcurrency`

Type: `integer` (minimum 0)

Default: `25` (operations) / `50` (application)

Maximum number of `tools/call` invocations a single session may have in flight at once. Subsequent attempts return `kind: "rate_limited"` with `scope: "concurrency"`.

### `mcp.<profile>.rateLimit.sessionPerSecond`

Type: `number` (minimum 0)

Default: `100` (operations) / `200` (application)

Sustained per-session rate across **all** tools combined. Protects a worker from a single session that spreads its calls across many distinct tools (and so would otherwise dodge `perTool*`).

## `mcp.session.*`

Settings that apply to MCP session lifecycle on both profiles.

### `mcp.session.idleTimeoutSeconds`

Type: `integer` (minimum 1)

Default: `1800` (30 minutes)

Idle window after which a session record in `system.mcp_session` is TTL-evicted. The next request bearing the evicted session id receives HTTP 404 and the client is expected to re-`initialize`.

### `mcp.session.allowClientDelete`

Type: `boolean`

Default: `false`

When `true`, Harper accepts client-issued `DELETE /mcp` requests that explicitly terminate a session. When `false` (the default), `DELETE` returns 405 with an `Allow` header — sessions only end via idle eviction or explicit server-side cleanup.

## Security: Origin validation

The MCP endpoint validates the request `Origin` header to defend against DNS-rebinding attacks (a requirement of the MCP Streamable HTTP transport). Validation reuses each profile's existing CORS configuration rather than introducing a separate MCP setting:

- When CORS is **disabled** — or enabled with a `*` (wildcard) allow-list — any `Origin` is accepted. This is appropriate for localhost-only or non-browser clients, where no DNS-rebinding vector exists.
- When CORS is **enabled** with an explicit allow-list, a request whose `Origin` is not in the list is rejected with `403 Forbidden`.
- A request with no `Origin` header at all (for example `curl` or server-to-server traffic) is always accepted — DNS rebinding only applies to browser-initiated requests.

**Secure default:** any deployment that exposes the MCP endpoint to browsers beyond loopback should enable CORS with an explicit (non-`*`) allow-list — that is what activates Origin-based DNS-rebinding protection.

The two profiles ship with **different CORS defaults**, but both accept any `Origin` out of the box:

- Application profile (HTTP port): `http.cors` + `http.corsAccessList`. Default: CORS **disabled**, so any `Origin` is accepted.
- Operations profile (operations port): `operationsApi.network.cors` + `operationsApi.network.corsAccessList`. Default: CORS **enabled with a `*` allow-list**, so any `Origin` is still accepted until you replace `*` with explicit origins.

## Example

A common deployment pattern that locks down the operations profile to a small explicit set, enables MCP DELETE for graceful client logout, and raises per-tool throughput for the application profile:

```yaml
mcp:
  operations:
    allow:
      - describe_all
      - describe_database
      - system_information
      - get_job
    rateLimit:
      perToolPerSecond: 5
      perToolBurst: 10
  application:
    searchMaxResults: 500
    rateLimit:
      perToolPerSecond: 50
      perToolBurst: 100
  session:
    idleTimeoutSeconds: 3600
    allowClientDelete: true
```
