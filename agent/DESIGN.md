# agent/ — Design notes

The built-in Harper agent component.

**Read this when:** changing the agent's toolset, the `http_fetch` tool, what `set_agent_config` can patch, or how a run records and caps model usage.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## `http_fetch` egress is fixed at boot and checked on every hop (`agent/tools/httpFetchTool.ts`)

The agent reads untrusted text (table rows, logs, component source) with the same toolset that can send HTTP, so `agent.httpFetch` is the operator's bound on where that text can make `http_fetch` send. It bounds that tool only, not every egress path the agent's operations tools might open. Two things keep the bound from being widened (harper#2974):

- **Boot-time only.** `startOnMainThread` builds the tool once from the boot config and `compose()` reuses that instance. Nothing reads the policy from `liveConfig`, and `set_agent_config` rejects an `httpFetch` patch. Like every other `agent_*` key, it is in `CONFIG_PARAMS` (`agent_httpFetch`, `agent_httpFetch_allow`) for env vars, CLI flags and `set_configuration`. Those write the config file and take effect on restart, and `set_configuration` is a destructive operation outside the agent's default toolset. The name `http_fetch` is reserved in `composeToolset`: with the tool disabled, no registry or extra tool can take its place.
- **Every hop is checked before it is sent.** `fetchCheckingRedirects` follows redirects itself (`redirect: 'manual'`) and runs `checkHttpFetchTarget` on each `Location`. Letting `fetch` follow would send the request before any check could see it. The hop step mirrors fetch's own method, body and credential-header rules, which the redirect tests in `unitTests/agent/httpFetchTool.test.js` pin.

Host matching compares canonical forms. Targets and allow entries both go through `URL` host parsing, so case, IDNA and IPv4 shorthand compare equal. The metadata and link-local blocklist checks IP literals with `net.BlockList`, which also catches their IPv4-mapped IPv6 spellings. Allow entries compare as strings, so an IPv4 entry does not admit its IPv4-mapped form; that direction fails closed. The check is by host name only. A permitted name that resolves to an internal address is not caught.

## Spend caps are folded from the transcript and fail closed (`agent/budget.ts`, `agent/loop.ts`)

`agent.maxTokens` and `agent.maxCostUsd` bound a session, not a run: `approve_agent_action` and a follow-up `agent_prompt` each start a new `runAgent`, so a per-run counter (which is what `maxTurns` is) would reset on every resume (harper#3040). Three rules keep the caps honest:

- **Usage lives on the call it describes.** Each assistant message carries the `usage` its `generate` reported and its `costUsd`, in the same write as the message. Session totals are folded from the transcript by `summarizeSessionUsage`, never stored, so they cannot drift from the calls. A total stays present only while every assistant message reported it, so a backend that reports nothing, an unpriced model, or a message written before usage was recorded makes that total unmeasured, not zero.
- **Unmeasured stops the session.** `budgetViolation` treats a cap whose total is unmeasured as violated. Checked before `consumeResolvedApprovals` (so a cap lowered during a pause stops an approved action from running) and after every call.
- **A stop leaves a sendable transcript.** `endRun` appends the assistant turn, a response for every tool call or resolved approval (`budget_exceeded`, or `denied_by_operator` for a denial), and the terminal status in one write; a crash cannot leave tool calls without responses, which the provider would reject on the next call.

What a cap does not bound, by construction: one call can cross it (it is a stop-after-call threshold), a failed attempt before a model fallback is not counted (failure records carry no usage), and an unpriced model is detected only after its first call. Pinned by `unitTests/agent/loop.test.js` and `integrationTests/server/agent-budget.test.ts`.
