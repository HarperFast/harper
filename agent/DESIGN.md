# agent/ — Design notes

The built-in Harper agent component.

**Read this when:** changing the agent's toolset, the `http_fetch` tool, what `set_agent_config` can patch, or how tool results reach the transcript.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## `http_fetch` egress is fixed at boot and checked on every hop (`agent/tools/httpFetchTool.ts`)

The agent reads untrusted text (table rows, logs, component source) with the same toolset that can send HTTP, so `agent.httpFetch` is the operator's bound on where that text can make `http_fetch` send. It bounds that tool only, not every egress path the agent's operations tools might open. Two things keep the bound from being widened (harper#2974):

- **Boot-time only.** `startOnMainThread` builds the tool once from the boot config and `compose()` reuses that instance. Nothing reads the policy from `liveConfig`, and `set_agent_config` rejects an `httpFetch` patch. Like every other `agent_*` key, it is in `CONFIG_PARAMS` (`agent_httpFetch`, `agent_httpFetch_allow`) for env vars, CLI flags and `set_configuration`. Those write the config file and take effect on restart, and `set_configuration` is a destructive operation outside the agent's default toolset. The name `http_fetch` is reserved in `composeToolset`: with the tool disabled, no registry or extra tool can take its place.
- **Every hop is checked before it is sent.** `fetchCheckingRedirects` follows redirects itself (`redirect: 'manual'`) and runs `checkHttpFetchTarget` on each `Location`. Letting `fetch` follow would send the request before any check could see it. The hop step mirrors fetch's own method, body and credential-header rules, which the redirect tests in `unitTests/agent/httpFetchTool.test.js` pin.

Host matching compares canonical forms. Targets and allow entries both go through `URL` host parsing, so case, IDNA and IPv4 shorthand compare equal. The metadata and link-local blocklist checks IP literals with `net.BlockList`, which also catches their IPv4-mapped IPv6 spellings. Allow entries compare as strings, so an IPv4 entry does not admit its IPv4-mapped form; that direction fails closed. The check is by host name only. A permitted name that resolves to an internal address is not caught.

## Tool results are capped where they are stored; a context-window rejection shrinks the newest once (`agent/loop.ts`)

Every request replays the whole transcript, so one oversized tool result fails every later request and the session cannot continue (harper#3068). Two rules keep a session continuable:

- **Nothing over `agent.maxToolResultBytes` is appended.** `invokeTool` passes every observation, tool errors included, through `serializeToolResult`, which cuts on a UTF-8 boundary. The cap applies at append time, not when a request is built, because the session row is rewritten whole on every append. The fs read tools page at half the cap (`ctx.maxResultBytes`) so the loop never cuts one of their pages. Registry, inspector and MCP tools rely on the loop cap alone.
- **A context-window rejection shrinks, then retries once.** Backends own provider wording. They set `contextWindowExceeded` on their error (`isContextWindowRejection`, `resources/models/backendHelpers.ts`), and the loop reads only `isContextWindowExceeded`. It cuts each result over 2 KiB in the newest run of tool messages that has one down to a 2 KiB head, then retries. Selecting by size makes the step idempotent and reaches a result stored before a later prompt. It is best effort: a long prompt or history ends the run `error` with a `lastError` saying so. `Models.generate` surfaces the first candidate's error, so a rejection from a fallback candidate behind an unrelated primary failure is not recovered.

The system prompt is sent only as `input.system`. The backends hoist or prepend it, so an inline copy would be sent twice.
