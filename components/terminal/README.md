# Interactive terminal component (PROTOTYPE)

A super_user-only PTY exposed over a WebSocket on the instance's **operations
API port**, so Studio can render an `xterm.js` terminal that runs _inside_ the
instance container.

> **Status: prototype for team discussion.** Ships alongside the Studio
> prototype on `claude/instance-terminal-prototype`. Not wired into any release
> config, off by default, and carries deliberate scoping shortcuts (see
> Security below).

## Why this exists

It's the first, smallest slice of the "Claude in the container" direction: a
live shell in Studio. More importantly it establishes the **authenticated,
super_user-gated WebSocket channel** that the planned live-log-stream and
Node-inspector-bridge features will reuse.

## How to enable

Add a `terminal:` block to the instance's root config:

```yaml
terminal:
  enabled: true # required — off by default
  # shell: /bin/bash     # default: $SHELL, else bash
  # cwd: /path            # default: instance root
  # idleTimeoutMs: 600000 # default: 10 minutes
  # maxSessions: 10       # default: 10 concurrent PTYs
```

`node-pty` is an optional native dependency — install it in the instance image
(declared in `optionalDependencies`).

## Architecture

- **Operations port, main thread.** `server/operationsServer.ts` calls
  `registerTerminalWebSocket({ nodeServer: app.server, config })` while building
  the operations Fastify server — the same place the MCP operations profile is
  registered — gated on `terminal.enabled`. This attaches a `/terminal` upgrade
  handler to the operations node server. There is no `handleApplication` and no
  worker-thread/app-port registration: the terminal lives on the operations
  security boundary, deliberately separate from the application data port.
- A dedicated `ws` `WebSocketServer({ noServer: true })` owns subprotocol
  negotiation (`handleProtocols` → `harper-terminal`) and the handshake; we drive
  `handleUpgrade` from the node server's `upgrade` event for the `/terminal` path
  only, leaving any other upgrade untouched.

## Authentication — first-message auth (no `security/auth.ts` change)

Browsers can't set an `Authorization` header on `new WebSocket()`, and a token
in the handshake subprotocol leaks into request headers that intermediaries may
log. So the socket is accepted **unauthenticated**, and the client's **first
frame** carries the credential:

```
a{"token":"<operation-token-jwt>"}      // or
a{"username":"...","password":"..."}
```

The upgrade handler validates it (`validateOperationToken`, or
`server.authenticateUser` for basic), asserts `super_user`, and only then spawns
the PTY. A 5s timer closes the socket if no valid auth arrives. Because auth is
handled here, the shared auth middleware is untouched — smaller blast radius than
the subprotocol-bearer approach.

## Wire protocol

Kept in sync with `studio/src/features/instance/terminal/wire.ts`.

Client → server (text frames, first char is an opcode):

| Frame     | Meaning                                                           |
| --------- | ----------------------------------------------------------------- |
| `a<json>` | auth — **must be first**. `{ token }` or `{ username, password }` |
| `i<data>` | stdin — bytes after the opcode are written to the PTY             |
| `r<json>` | resize — JSON `{ "cols": <int>, "rows": <int> }`                  |

Server → client: raw PTY output as text frames (no opcode); `close(code, reason)`
on shell exit, idle, or a policy rejection.

Close codes: `4401` unauthenticated, `4403` not super_user, `4408` idle/auth
timeout, `4429` session limit, `4500` backend error, `1000` shell exit.

## Security notes (for review — deliberately unfinished)

- **First-message auth** keeps the token out of handshake headers, but the token
  still travels over the (TLS-encrypted) socket. Fine over `wss`.
- **Direct connections only.** The Fabric Connect proxy buffers streamed
  responses and can't carry a WebSocket, so this only works when Studio has a
  _direct_ connection to the instance — the same limitation as the existing
  log/deploy SSE tails. Studio gates the UI on `isDirectConnection`.
- **Privilege.** The shell runs on the operations (main) thread and inherits its
  user and environment. No cgroup/user-namespace confinement, no per-user quota
  beyond `maxSessions`. Production wants real sandboxing and a durable audit
  trail (today: notify-level open/close/deny log lines tagged `terminal`).
