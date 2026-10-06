# agent/ — Design notes

The built-in Harper agent component.

**Read this when:** changing the agent's toolset, the `http_fetch` tool, or what `set_agent_config` can patch.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## `http_fetch` egress is fixed at boot and checked on every hop (`agent/tools/httpFetchTool.ts`)

The agent reads untrusted text (table rows, logs, component source) with the same toolset that can send HTTP, so `agent.httpFetch` is the operator's bound on where that text can make `http_fetch` send. It bounds that tool only, not every egress path the agent's operations tools might open. Two things keep the bound from being widened (harper#2974):

- **Boot-time only.** `startOnMainThread` builds the tool once from the boot config and `compose()` reuses that instance. Nothing reads the policy from `liveConfig`, and `set_agent_config` rejects an `httpFetch` patch. Like every other `agent_*` key, it is in `CONFIG_PARAMS` (`agent_httpFetch`, `agent_httpFetch_allow`) for env vars, CLI flags and `set_configuration`. Those write the config file and take effect on restart, and `set_configuration` is a destructive operation outside the agent's default toolset. The name `http_fetch` is reserved in `composeToolset`: with the tool disabled, no registry or extra tool can take its place.
- **Every hop is checked before it is sent.** `fetchCheckingRedirects` follows redirects itself (`redirect: 'manual'`) and runs `checkHttpFetchTarget` on each `Location`. Letting `fetch` follow would send the request before any check could see it. The hop step mirrors fetch's own method, body and credential-header rules, which the redirect tests in `unitTests/agent/httpFetchTool.test.js` pin.

Host matching compares canonical forms. Targets and allow entries both go through `URL` host parsing, so case, IDNA and IPv4 shorthand compare equal. The metadata and link-local blocklist checks IP literals with `net.BlockList`, which also catches their IPv4-mapped IPv6 spellings. Allow entries compare as strings, so an IPv4 entry does not admit its IPv4-mapped form; that direction fails closed. The check is by host name only. A permitted name that resolves to an internal address is not caught.
