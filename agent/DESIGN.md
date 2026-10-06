# agent/ — Design notes

The built-in Harper agent component.

**Read this when:** changing the agent's toolset, the `http_fetch` tool, what `set_agent_config` can patch, or how the loop ends a run.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## `http_fetch` egress is fixed at boot and checked on every hop (`agent/tools/httpFetchTool.ts`)

The agent reads untrusted text (table rows, logs, component source) with the same toolset that can send HTTP, so `agent.httpFetch` is the operator's bound on where that text can make `http_fetch` send. It bounds that tool only, not every egress path the agent's operations tools might open. Two things keep the bound from being widened (harper#2974):

- **Boot-time only.** `startOnMainThread` builds the tool once from the boot config and `compose()` reuses that instance. Nothing reads the policy from `liveConfig`, and `set_agent_config` rejects an `httpFetch` patch. Like every other `agent_*` key, it is in `CONFIG_PARAMS` (`agent_httpFetch`, `agent_httpFetch_allow`) for env vars, CLI flags and `set_configuration`. Those write the config file and take effect on restart, and `set_configuration` is a destructive operation outside the agent's default toolset. The name `http_fetch` is reserved in `composeToolset`: with the tool disabled, no registry or extra tool can take its place.
- **Every hop is checked before it is sent.** `fetchCheckingRedirects` follows redirects itself (`redirect: 'manual'`) and runs `checkHttpFetchTarget` on each `Location`. Letting `fetch` follow would send the request before any check could see it. The hop step mirrors fetch's own method, body and credential-header rules, which the redirect tests in `unitTests/agent/httpFetchTool.test.js` pin.

Host matching compares canonical forms. Targets and allow entries both go through `URL` host parsing, so case, IDNA and IPv4 shorthand compare equal. The metadata and link-local blocklist checks IP literals with `net.BlockList`, which also catches their IPv4-mapped IPv6 spellings. Allow entries compare as strings, so an IPv4 entry does not admit its IPv4-mapped form; that direction fails closed. The check is by host name only. A permitted name that resolves to an internal address is not caught.

## A turn that did not finish is rejected before anything is recorded (`agent/loop.ts`)

Callers poll `get_agent_session` and read `completed` as success, so `completed` with no `lastError` must mean a natural, non-empty final answer (harper#3039). The `maxTurns` ceiling is the one documented exception: it ends `completed` and sets `lastError`. `rejectTurn` runs right after each `generate` and ends the run `error` when the backend reports `length` or `content_filter`, when it reports `tool_calls` but no call parsed, or when a reply has neither text nor tool calls.

- **Nothing from a rejected turn is appended.** Partial text would read as the answer. Tool calls recorded without their responses would make the session's next request invalid, and a truncated call carries truncated arguments, so none is executed or queued for approval. The rejection is one status write, so there is no partial state to recover.
- **Tool calls still dispatch on `stop`.** Only the explicit cut-short reasons block dispatch. `synthesizeGenerateFromStream` (`resources/models/backendRegistry.ts`) reports `stop` for a stream-only backend that emits no finish reason, so gating dispatch on `tool_calls` would stop such a backend from calling tools at all.

The rule only works if backends report truncation. Anthropic's `model_context_window_exceeded` maps to `length` and `refusal` to `content_filter` in `components/anthropic` and in `components/bedrock`'s Anthropic path. `agent.maxTokens` (default 16384) is sent on every request, so truncation is rarer, but the check above is what keeps it visible.
