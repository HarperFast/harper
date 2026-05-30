---
title: Migrating from the External MCP Server
---

# Migrating from the External MCP Server

<VersionBadge version="v5.1.0" />

Earlier deployments of Harper used the standalone [`HarperFast/mcp-server`](https://github.com/HarperFast/mcp-server) addon — a separate Node.js process that wrapped Harper's Operations API and exposed MCP over stdio. With v5.1, MCP is now a first-class **built-in** server-side surface; the external addon is deprecated and will be archived alongside this release.

This page covers what changes for you and how to migrate.

## What changed

| Concern                      | External `mcp-server` addon                      | Built-in MCP (v5.1+)                                                                            |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Deployment                   | Separate Node.js process spawned by the LLM host | In-process inside Harper; nothing else to install or run                                        |
| Transport                    | stdio only                                       | Streamable HTTP (POST + GET-SSE) **plus** stdio via `harper mcp`                                |
| Authentication               | Operations API JWT, passed via env var           | Harper's native Basic / JWT / mTLS / UDS-via-filesystem-perms                                   |
| Tool surface                 | Hand-curated wrapper around the Operations API   | Operations profile + Application profile (Resources walker)                                     |
| Resource exposure            | None                                             | `harper://about`, `harper://operations`, `harper://schema/*`, `harper://openapi`, `https://...` |
| `notifications/list_changed` | Not supported                                    | Supported per-session on both profiles                                                          |
| Rate limiting                | Not present                                      | Per-session, per-tool token-bucket on both profiles                                             |
| Audit logging                | Operations API audit log only                    | Dedicated `mcp.audit` category with credential redaction                                        |
| Per-attribute permissions    | Not honored in the tool surface                  | Narrowed at schema-derivation time                                                              |
| Config                       | Env vars + addon's own JSON                      | Top-level `mcp:` block in `harperdb-config.yaml`                                                |

## Migration checklist

### 1. Enable the built-in MCP surface

Add an `mcp:` block to `harperdb-config.yaml`. The minimal "turn it on" form is:

```yaml
mcp:
  operations: {}
  application: {}
```

If you only need the operation-wrapper functionality the external addon provided (which is roughly what `mcp.operations` does), the operations block alone is enough:

```yaml
mcp:
  operations: {}
```

See [MCP Configuration](./configuration.md) for the full set of knobs.

### 2. Switch your MCP host to `harper mcp`

The `harper mcp` CLI ships with Harper itself — see [Harper MCP CLI](./cli.md). For Claude Desktop, the new config block is:

```json
{
	"mcpServers": {
		"harper": {
			"command": "harper",
			"args": ["mcp"]
		}
	}
}
```

`harper mcp print-config --client claude-desktop|cursor|zed` emits paste-ready blocks for the three supported hosts.

By default the CLI connects to the local Harper via the operations API UDS — no credentials, gated by filesystem permissions on the socket. For a remote Harper, add `--target https://node.example.com:9926` and either supply credentials with `--bearer` / `--username` + `--password`, or run `harper login https://node.example.com:9926` once and let `harper mcp` pick up the saved JWT automatically.

### 3. Audit the operations exposed to your LLM

The built-in default-allow list is intentionally narrower than the external addon's wrapper. If your agents rely on operations outside `describe_*` / `list_*` / `search_*` / `system_information` / `read_log` / `read_audit_log` / `get_job` / `get_status` / `get_analytics` / `get_metrics`, add them explicitly to `mcp.operations.allow`. See the [Default-allow list](./tools-and-resources.md#default-allow-list) and the rationale for excluding `get_*` as a glob (it would pull in `get_configuration`, `get_components`, etc., which can return secrets).

### 4. Decommission the addon

Once your MCP hosts are pointing at `harper mcp` and tools are dispatching correctly:

- Stop the separate `mcp-server` process.
- Remove the addon's config block from your MCP host's `mcpServers` (replaced in step 2).
- Remove the `mcp-server` package from any deployment scripts.

## Differences to watch for

- **Operation names are unchanged.** A tool that the external addon called `search_by_value` is still `search_by_value` in the built-in MCP server.
- **Result envelopes differ slightly.** The built-in MCP server wraps operation results in MCP's `result.content[]` (with a `type: 'text'` JSON-encoded entry) per spec. Hosts that consume the raw operation JSON directly will need to parse it out of `content[0].text`.
- **Permission filtering is now enforced at `tools/list` time** — users see only operations their role can invoke. The external addon listed everything and let the dispatch fail.
- **Sessions are real now.** Each MCP host opens an `Mcp-Session-Id` session, can hold an SSE channel open for notifications, and is cleaned up on idle eviction. The external addon was stateless per-request.

## After migration

- Validate with `harper mcp doctor --target <your-endpoint>` from any machine. The output gives an OK/FAIL line per handshake step.
- If your agents need richer per-resource invocation (`get_<resource>`, `search_<resource>`, etc., generated from your application's exported `Resource` classes), enable `mcp.application` as well — that surface has no equivalent in the external addon.
