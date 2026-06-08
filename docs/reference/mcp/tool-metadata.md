---
title: MCP tool payload sourcing
---

# MCP tool payload sourcing

Harper's MCP server publishes tools via the Model Context Protocol (rev 2025-06-18, Streamable HTTP transport). This page is a reference for what fields appear on each generated tool descriptor and where the data comes from. For authoring guidance, see the [Writing quality MCP and OpenAPI descriptions](../../learn/developers/mcp-and-openapi-metadata) how-to.

## Tool descriptor fields

Per the MCP spec, every tool descriptor returned from `tools/list` carries:

| Field          | Required | Purpose                                                                                          |
| -------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`         | yes      | Machine identifier used by `tools/call`                                                          |
| `description`  | yes      | LLM-facing prose explaining what the tool does and when to pick it over siblings                 |
| `inputSchema`  | yes      | JSON Schema for the arguments the tool accepts                                                   |
| `outputSchema` | no       | JSON Schema for the data the tool returns (added in spec rev 2025-06-18)                         |
| `annotations`  | no       | Hints for clients: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title` |

Harper populates each from a different source depending on the tool's profile and origin.

## Profiles

Harper exposes two MCP profiles, each with its own port and registration loop:

- **Operations profile** — registers one MCP tool per Harper operation that survives the `mcp.operations.allow` / `deny` filter. Walks `OPERATION_FUNCTION_MAP`. The default allow list is read-only and intentionally narrow: `describe_*`, `list_*`, `search_*`, plus an explicit list of safe getters.
- **Application profile** — registers verb tools (`get_*`, `search_*`, `create_*`, `update_*`, `patch_*`, `delete_*`) for every exported Resource, plus any custom tools declared via `static mcpTools`.

## Sourcing per profile

### Operations profile

For operations tools, the descriptor fields are sourced from:

| Field                         | Source                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | Operation name (from `OPERATION_FUNCTION_MAP` key)                                                                                              |
| `description`                 | Hand-authored entry in the operations descriptions catalog; falls back to a generic template when an operator opts in a non-cataloged operation |
| `inputSchema`                 | Hand-curated JSON Schema in the operations input-schemas catalog; falls back to `{ type: 'object', additionalProperties: true }`                |
| `annotations.readOnlyHint`    | `true` if the operation matches a read-only prefix (`describe_`, `list_`, `search_`, `get_`, `read_`) or is the literal `system_information`    |
| `annotations.destructiveHint` | `true` for operations in the curated destructive set (`drop_*`, `delete_*`, `restart`, `set_configuration`, etc.)                               |
| `annotations.idempotentHint`  | Default empty; opt-in per operation after end-to-end verification that the second call produces the same observable outcome                     |

Operations registered outside core (for example, `cluster_status` from harper-pro) don't have catalog entries; they fall back to the generic description template until the per-operation metadata registry lands.

### Application profile — verb tools

For verb tools generated from exported Resources:

| Field                         | Source                                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | `${verb}_${sanitized-path}` (e.g. `get_Product`, `search_Customer`)                                                                                                                            |
| `description`                 | Composed: `[ResourceClass.description \n\n] ${verb sentence} ${runtime RBAC note}`                                                                                                             |
| `inputSchema`                 | Derived per verb from `ResourceClass.attributes` and the caller's `attribute_permissions`. Per-attribute `description` propagates to `inputSchema.properties[*].description`                   |
| `outputSchema`                | Derived per verb from `ResourceClass.attributes` for `get_*` / `create_*` / `update_*` / `patch_*`. `delete_*` returns `{ deleted: true, <pk> }`. `search_*` deliberately omits `outputSchema` |
| `annotations.readOnlyHint`    | `true` on `get_*` and `search_*`                                                                                                                                                               |
| `annotations.destructiveHint` | `true` on `delete_*`                                                                                                                                                                           |
| `annotations.idempotentHint`  | `true` on `update_*` (PUT semantics); other verbs default off                                                                                                                                  |

`static description` and `static properties` on the Resource class override the auto-derived values. `static outputSchemas[verb]` overrides per-verb output schemas. `static mcp.annotations[verb]` overrides annotations per verb. `static hidden === true` suppresses the entire Resource from MCP listing.

### Application profile — custom `mcpTools`

For tools declared via `static mcpTools`:

| Field          | Source                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | `def.name` from the `mcpTools` entry                                                                                                               |
| `description`  | `def.description` from the entry; falls back to a generic template if omitted (with a warn-once log at registration)                               |
| `inputSchema`  | `def.inputSchema` from the entry; falls back to `{ type: 'object', additionalProperties: true }` if omitted (with a warn-once log at registration) |
| `outputSchema` | `def.outputSchema` from the entry (optional; no fallback)                                                                                          |
| `annotations`  | `def.annotations` from the entry (optional pass-through)                                                                                           |

Custom tools have no per-user listing filter beyond authentication — the Resource's instance method is responsible for whatever RBAC it needs to enforce.

## Sample descriptors

### `get_Product` (with docstrings)

Given a `Product` table with type-level and field-level docstrings:

```json
{
	"name": "get_Product",
	"description": "Product catalog row — what shows up in the storefront listing, search, and inventory feeds. One row per SKU.\n\nFetches a single Product record by sku. Runtime RBAC (allowGet) enforces per-record access at call time.",
	"inputSchema": {
		"type": "object",
		"properties": {
			"id": { "type": "string", "description": "Primary key (sku)." },
			"get_attributes": { "type": "array", "items": { "type": "string" } }
		},
		"required": ["id"]
	},
	"outputSchema": {
		"type": "object",
		"properties": {
			"sku": { "type": "string", "description": "Stock keeping unit — globally unique across catalogs." },
			"name": { "type": "string", "description": "Display name shown in the storefront." },
			"priceCents": { "type": "integer", "description": "Retail price in cents (USD)." }
		},
		"required": ["sku", "name", "priceCents"],
		"additionalProperties": false
	},
	"annotations": { "readOnlyHint": true }
}
```

### `add_user` (operations profile)

```json
{
	"name": "add_user",
	"description": "Creates a new Harper user with username, password, and role. Requires super_user. Username is immutable after creation — use drop_user + add_user to rename.",
	"inputSchema": {
		"type": "object",
		"properties": {
			"username": { "type": "string" },
			"password": { "type": "string" },
			"role": { "type": "string", "description": "Role name. Use list_roles to discover available roles." },
			"active": { "type": "boolean", "default": true }
		},
		"required": ["username", "password", "role"]
	}
}
```

Note that `add_user` does NOT carry `idempotentHint: true`. Under MCP semantics this would claim the second call produces the same observable outcome — but `add_user("bob")` on first call returns the created user and on second call returns an "already exists" error. Different observable outcomes → not idempotent.

## `harper://*` resources

Harper also publishes a small set of synthetic resources via the MCP `resources/list` endpoint:

| URI                            | Profile     | Description                                           |
| ------------------------------ | ----------- | ----------------------------------------------------- |
| `harper://about`               | both        | Server version, profile, MCP protocol versions        |
| `harper://operations`          | operations  | User-filtered operations catalog                      |
| `harper://openapi`             | application | Full OpenAPI 3.0.3 document                           |
| `harper://schema/{db}/{table}` | application | Per-table schema, filtered by `attribute_permissions` |
| `https://{host}/{path}`        | application | Application HTTP Resources, in-process                |

For `harper://schema/{db}/{table}` and `https://{host}/{path}` entries, the descriptor description prepends `Table.description` / `ResourceClass.description` when present.

## See also

- [Writing quality MCP and OpenAPI descriptions](../../learn/developers/mcp-and-openapi-metadata) — authoring how-to
- [Schema reference: docstrings and `@hidden`](../database/schema) — GraphQL surface
- [Resource API reference: class-level metadata](../resources/resource-api#class-level-metadata-for-mcp-and-openapi) — programmatic surface
