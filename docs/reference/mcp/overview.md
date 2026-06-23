---
title: MCP Overview
---

# MCP Overview

<VersionBadge version="v5.1.0" />

Harper implements the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) as a first-class server-side surface, letting large-language-model hosts (Claude Desktop, Cursor, Zed, custom agents) discover and invoke Harper operations, resources, and tables through a standard wire protocol. The MCP server runs in-process inside Harper — there is no separate addon, no sidecar, and no out-of-process broker.

## What MCP gives you

- **Tool discovery and invocation.** LLM hosts get a typed list of operations they can call (`tools/list`) and a uniform JSON-RPC invocation envelope (`tools/call`). Per-tool input schemas come from Harper's operation catalog (operations profile) or from your `Table.attributes` and exported `Resource` classes (application profile).
- **Resource exposure.** Synthetic `harper://` URIs surface metadata (server info, OpenAPI document, table schemas, operations catalog), and `https://` URIs mirror your application's REST surface so hosts can resolve real REST endpoints in-process.
- **Server-push notifications.** `notifications/tools/list_changed` and `notifications/resources/list_changed` fire over an open Server-Sent Events channel when role mutations or schema changes alter what a session can see.
- **Resource subscriptions.** <VersionBadge version="v5.1.10" /> Subscribe to a row-backed application resource with `resources/subscribe` and receive a `notifications/resources/updated` push whenever that record (or table) changes, driven by Harper's audit-log change feed. See [Resource Subscriptions](./subscriptions.md).
- **Resumable notification streams.** <VersionBadge version="v5.1.10" /> A dropped GET-SSE connection can reconnect with a `Last-Event-ID` header and replay the notifications it missed from a bounded per-session buffer, so a brief network blip doesn't lose `list_changed` / `resources/updated` events. See [Resource Subscriptions](./subscriptions.md#resuming-a-dropped-stream).
- **Per-session bookkeeping.** Sessions persist for the configured idle window; `Mcp-Session-Id` ties JSON-RPC requests, GET-SSE notifications, and the optional DELETE-session cleanup together.
- **Built-in auth and RBAC.** Harper's existing Basic, JWT, and mTLS authentication paths run unchanged on the MCP endpoint. Tool and resource visibility is filtered through your role's `permission` block (`super_user`, `structure_user`, per-operation, per-table, per-attribute).
- **Audit + rate limits.** Every `tools/call` writes to Harper's audit log (with credential redaction); per-session and per-tool token-bucket rate limits prevent a runaway agent from overwhelming a Harper worker.

## Protocol versions supported

| Version      | Status     | Notes                                                                                  |
| ------------ | ---------- | -------------------------------------------------------------------------------------- |
| `2025-06-18` | Preferred  | The version Harper reports in the `initialize` response.                               |
| `2025-03-26` | Backcompat | Accepted for clients that pin to the earlier rev.                                      |
| Other        | Negotiated | Per spec, Harper responds with the preferred version; clients downgrade or disconnect. |

The negotiation behavior follows the MCP spec's "server MUST respond with a value it does support" rule, so newer SDKs (which may default to a later protocol version Harper does not yet implement) connect cleanly by accepting the downgrade.

## The two profiles

Harper exposes MCP through one or two profiles, each mounted on its own endpoint and gated by its own config block. A profile is enabled if its sub-block exists in `mcp:` config — there is no separate `enabled` flag.

### Operations profile (`mcp.operations`)

Wraps Harper's operation catalog (the same set of operations the REST `/operation` endpoint and the legacy `OPERATIONS_API` accept). Mounts on the **operations server** (default port `9925`).

- Default-allowed surface (read-only): `describe_*`, `list_*`, `search_*`, plus an explicit safe-getter list (`get_job`, `get_status`, `get_analytics`, `get_metrics`), `system_information`, `read_log`, `read_audit_log`.
- Operators opt destructive or sensitive operations in via `mcp.operations.allow`. Destructive operations carry `destructiveHint: true` so well-behaved MCP clients can prompt before invoking.
- Tool dispatch goes through the same `chooseOperation` + `processLocalTransaction` path as REST `/operation` — `verifyPerms` runs unchanged.

### Application profile (`mcp.application`)

Walks your application's exported `Resource` classes and generates one MCP tool per implemented REST verb. Mounts on the **application HTTP server** (the same listener that serves your REST endpoints).

- For each exported Resource, Harper emits `get_<name>`, `search_<name>`, `create_<name>`, `update_<name>`, and `delete_<name>` tools when the corresponding verb is implemented on the prototype.
- Input schemas are derived from `Table.attributes` and narrowed by your role's `attribute_permissions`.
- Components can opt non-verb instance methods into the MCP surface by declaring a static `mcpTools` array on the Resource class.
- A Resource is excluded from the MCP surface when its registration sets `exportTypes.mcp = false`.

See [MCP Tools and Resources](./tools-and-resources.md) for the full generation rules and visibility model.

## What's next

- **Configuration** — see [MCP Configuration](./configuration.md) for the full set of config knobs.
- **CLI** — see [Harper MCP CLI](./cli.md) for the `harper mcp` subcommand that bridges stdio MCP hosts (Claude Desktop, Cursor, Zed) to a running Harper instance.
- **Migration** — if you are coming from the `HarperFast/mcp-server` external addon, see [MCP Migration](./migration.md).
- **Tool metadata** — see [Tool Metadata](./tool-metadata.md) for what fields appear on each generated tool descriptor and where the data comes from.

## Out of scope for v1

The following items are explicitly deferred to a follow-on release:

- OAuth 2.1 PRM (Protected Resource Metadata) authorization.
- Cross-worker session sharing (each MCP session is bound to the worker that accepted the GET stream).
- TypeScript type reflection into JSON Schema for custom `mcpTools` entries (schemas are hand-authored).
- Global REST/operations rate limiting — only per-session/per-tool limits apply on the MCP surface.
