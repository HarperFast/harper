---
title: MCP Overview
---

# MCP

Harper ships a built-in [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server (rev 2025-06-18, Streamable HTTP transport) that exposes your application to LLM clients as a set of tools. Every exported Resource and every allowed Harper operation becomes a callable tool, with descriptions, input/output schemas, and annotations generated automatically from your schema and class metadata.

This section covers what those generated tool descriptors contain and where each field comes from.

## Profiles

Harper exposes two MCP profiles, each on its own port:

- **Operations profile** — one tool per Harper operation that passes the `mcp.operations.allow` / `deny` filter. The default allow list is read-only and intentionally narrow (`describe_*`, `list_*`, `search_*`, plus an explicit set of safe getters).
- **Application profile** — verb tools (`get_*`, `search_*`, `create_*`, `update_*`, `patch_*`, `delete_*`) for every exported Resource, plus any custom tools declared via `static mcpTools`.

## In this section

| Page                                            | Description                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| [Tool Metadata](./tool-metadata.md)             | What fields appear on each generated tool descriptor and their sources  |

## See also

- [Writing quality MCP and OpenAPI descriptions](/learn/developers/mcp-and-openapi-metadata) — authoring how-to for tool and attribute descriptions
- [Schema reference: docstrings and `@hidden`](/reference/v5/database/schema) — the GraphQL surface that feeds MCP metadata
- [Resource API reference: class-level metadata](/reference/v5/resources/resource-api#class-level-metadata-for-mcp-and-openapi) — the programmatic surface
