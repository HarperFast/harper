---
title: Harper MCP CLI
---

# Harper MCP CLI

<VersionBadge version="v5.1.0" />

`harper mcp` is a stdio bridge that lets MCP hosts (Claude Desktop, Cursor, Zed, or any client that speaks the [stdio MCP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)) talk to a running Harper instance over Harper's Streamable HTTP MCP endpoint.

The CLI is bundled with Harper itself; if `harper` is on your `PATH`, so is `harper mcp`.

## Subcommands

```bash
harper mcp [subcommand] [flags]
```

| Subcommand     | Purpose                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| _(default)_    | Run the stdio bridge — JSON-RPC frames on stdin, responses on stdout, until stdin closes.        |
| `print-config` | Emit a paste-ready config block for an MCP host (`--client claude-desktop`, `cursor`, or `zed`). |
| `doctor`       | Connect, complete an `initialize` handshake, list tools, clean up; report each step.             |
| `help`         | Print the help text.                                                                             |

## Connection modes

`harper mcp` connects in one of two modes, chosen automatically based on whether `--target` is set:

### Local UDS (default)

With no `--target` flag, the CLI connects to the Harper running on the same host via the operations API Unix Domain Socket — the same socket `bin/cliOperations` uses. Filesystem permissions on the socket are the access gate; no credentials are required or sent.

The UDS path is derived from `operationsApi.network.domainSocket` in `harperdb-config.yaml` and is typically `<rootPath>/sockets/operations-server`.

### Network HTTPS / HTTP

`--target https://node.example.com:9926` connects over the network to a remote Harper. Credentials are resolved with this precedence (highest first):

1. `--bearer <token>` — explicit bearer token.
2. `--username` + `--password` — explicit Basic auth.
3. URL-embedded user/pass, e.g. `--target https://alice:pw@node:9926`.
4. Saved JWT from `~/.harperdb/credentials.json` for the resolved target (populated by `harper login`).

If none of these are present, the request goes out unauthenticated and Harper gates the response accordingly.

Use `--insecure` to skip TLS certificate validation (network mode only) — useful for local self-signed certs during development.

## Flags

| Flag                  | Default                       | Purpose                                                                           |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `--profile <name>`    | `application`                 | `operations` or `application`. Determines which MCP endpoint the CLI connects to. |
| `--target <url>`      | _(local UDS)_                 | Network endpoint. Switches the CLI into network mode.                             |
| `--mount-path <path>` | `/mcp`                        | Overrides the mount path. Match whatever `mcp.<profile>.mountPath` is set to.     |
| `--username <u>`      | _(none)_                      | Basic auth username (network mode).                                               |
| `--password <p>`      | _(none)_                      | Basic auth password (network mode).                                               |
| `--bearer <token>`    | _(none)_                      | Bearer token (network mode). Wins over `--username` / `--password`.               |
| `--insecure`          | _(off)_                       | Skip TLS certificate validation (network mode only).                              |
| `--client <name>`     | _(required for print-config)_ | `claude-desktop`, `cursor`, or `zed`.                                             |
| `--help`, `-h`        | _(off)_                       | Print the help text and exit.                                                     |

## `harper mcp` (the bridge)

The default subcommand runs until stdin closes. The expected use is to invoke it from an MCP host's configuration block (see [print-config](#harper-mcp-print-config) below). Each line of stdin is parsed as a JSON-RPC frame and POSTed to the Harper MCP endpoint; each response (whether JSON or SSE-streamed) is emitted to stdout as line-delimited JSON-RPC.

After the `initialize` handshake completes, the bridge opens a long-lived `GET /mcp` request — Harper's server-push channel — and forwards every `notifications/tools/list_changed` and `notifications/resources/list_changed` frame to stdout. The host sees one unified MCP stream.

Logs (status, errors, dropped invalid stdin lines) go to stderr so they never collide with the JSON-RPC channel.

## `harper mcp print-config`

Emits a paste-ready JSON block for the requested MCP host along with a comment indicating where to put it.

```bash
harper mcp print-config --client claude-desktop
```

Produces:

```text
# Target file: ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\Claude\claude_desktop_config.json (Windows)
{
  "mcpServers": {
    "harper": {
      "command": "harper",
      "args": ["mcp"]
    }
  }
}
# Note: Restart Claude Desktop after editing the file.
# Note: Merge into an existing `mcpServers` block if you already have one.
```

The generated `args` array reflects whatever flags you pass to `print-config` (other than `--client`). For instance:

```bash
harper mcp print-config --client cursor --target https://node.example.com:9926 --profile operations
```

emits a block whose `args` is `["mcp", "--profile", "operations", "--target", "https://node.example.com:9926"]`. This lets you generate fully-resolved config blocks for non-default deployments without hand-editing.

Supported clients:

- **`claude-desktop`** — Anthropic Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows).
- **`cursor`** — Cursor IDE (`~/.cursor/mcp.json`).
- **`zed`** — Zed editor (Zed `settings.json`, under `context_servers`).

## `harper mcp doctor`

Runs a three-step smoke check against the configured connection:

1. POST `initialize` — verifies the transport works and Harper accepts the handshake. Captures the negotiated protocol version and session id.
2. POST `tools/list` — verifies the session is usable and reports how many tools are visible to the authenticated user.
3. DELETE `/mcp` — cleans up the session. This step is allowed to fail (when `mcp.session.allowClientDelete` is `false` the server returns 405); overall doctor exit is still success.

Each step prints `[OK]` or `[FAIL]` with a short detail line. Exit code is `0` on success, `1` on any non-tolerable failure.

```bash
$ harper mcp doctor --target https://node.example.com:9926 --bearer $TOKEN
[OK  ] initialize - session=ab12... protocol=2025-06-18
[OK  ] tools/list - 14 tool(s) visible
[OK  ] session cleanup

All checks passed.
```

Use `doctor` as a quick "is the wire path healthy?" check before pointing a real MCP host at the server.
