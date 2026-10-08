# agent/ — Design notes

The built-in Harper agent component.

**Read this when:** changing the agent's toolset, the `http_fetch` tool, the filesystem tools or their scopes, what `set_agent_config` can patch, or how the loop ends a run.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## `http_fetch` egress is fixed at boot and checked on every hop (`agent/tools/httpFetchTool.ts`)

The agent reads untrusted text (table rows, logs, component source) with the same toolset that can send HTTP, so `agent.httpFetch` is the operator's bound on where that text can make `http_fetch` send. It bounds that tool only, not every egress path the agent's operations tools might open. Two things keep the bound from being widened (harper#2974):

- **Boot-time only.** `startOnMainThread` builds the tool once from the boot config and `compose()` reuses that instance. Nothing reads the policy from `liveConfig`, and `set_agent_config` rejects an `httpFetch` patch. Like every other `agent_*` key, it is in `CONFIG_PARAMS` (`agent_httpFetch`, `agent_httpFetch_allow`) for env vars, CLI flags and `set_configuration`. Those write the config file and take effect on restart, and `set_configuration` is a destructive operation outside the agent's default toolset. The name `http_fetch` is reserved in `composeToolset`: with the tool disabled, no registry or extra tool can take its place.
- **Every hop is checked before it is sent.** `fetchCheckingRedirects` follows redirects itself (`redirect: 'manual'`) and runs `checkHttpFetchTarget` on each `Location`. Letting `fetch` follow would send the request before any check could see it. The hop step mirrors fetch's own method, body and credential-header rules, which the redirect tests in `unitTests/agent/httpFetchTool.test.js` pin.

Host matching compares canonical forms. Targets and allow entries both go through `URL` host parsing, so case, IDNA and IPv4 shorthand compare equal. The metadata and link-local blocklist checks IP literals with `net.BlockList`, which also catches their IPv4-mapped IPv6 spellings. Allow entries compare as strings, so an IPv4 entry does not admit its IPv4-mapped form; that direction fails closed. The check is by host name only. A permitted name that resolves to an internal address is not caught.

## The fs tools never return key material, and `config` is the config file (`agent/tools/fsTools.ts`)

Everything an fs tool returns enters the model's context, and the session transcript is persisted and replicated, so a read is an exfiltration path even with `http_fetch` off (harper#3041). Two rules hold whatever scope or override is in force:

- **Scopes are fixed at boot and narrow by default.** `resolveScopes` makes `config` the Harper config file alone (`configFile`), canonicalized so a symlinked config file is its target: `resolveScoped` admits only that file, and `list_dir`/`grep_files` never enumerate or walk it, even if it is swapped for a directory later. `agent.configScope` replaces that target with another file or directory, so the config file stays in scope only if the new target contains it; a target that is neither leaves the scope unavailable rather than guessing. `set_agent_config` rejects `httpFetch`, `componentsScope` and `configScope`, because a patch that cannot take effect must not look applied.
- **Key material is refused in every scope.** `keyDirs` (`<rootPath>/keys`, `<rootPath>/ssh`) are resolved to real paths on every call, like scope roots, so a symlinked root, a key directory that is or later becomes a link, and a Windows short name all compare equal. They refuse reads and writes. Reads also refuse `*.pem`, `*.key` and `.jwtPass` by name, any returned text holding a PEM private-key armor line, and a `tail_file` of a file that ends inside a key (its last armor line is a BEGIN, looking a few bytes before its read window so a cut armor line still counts). The armor check covers an inline `tls.privateKey` in the config file (`readPEM` accepts one). `grep_files` skips such files and prunes key directories instead of failing. A key with no armor and no key file name passes, so the path rules are the guarantee and the armor check is the backstop.

The rules bound the fs tools only: an operations tool returns its own text unfiltered (`read_log` is in the default set), and the config file can still hold non-PEM secrets (model `apiKey`, storage credentials). The narrowed default limits the read surface; it does not make what remains safe to show a model.

## A turn that did not finish is rejected before anything is recorded (`agent/loop.ts`)

Callers poll `get_agent_session` and read `completed` as success, so `completed` with no `lastError` must mean a natural, non-empty final answer (harper#3039). The `maxTurns` ceiling is the one documented exception: it ends `completed` and sets `lastError`. `rejectTurn` runs right after each `generate` and ends the run `error` when the backend reports `length` or `content_filter`, when it reports `tool_calls` but no call parsed, or when a reply has neither text nor tool calls.

- **Nothing from a rejected turn is appended.** Partial text would read as the answer. Tool calls recorded without their responses would make the session's next request invalid, and a truncated call carries truncated arguments, so none is executed or queued for approval. The rejection is one status write, so there is no partial state to recover.
- **Tool calls still dispatch on `stop`.** Only the explicit cut-short reasons block dispatch. `synthesizeGenerateFromStream` (`resources/models/backendRegistry.ts`) reports `stop` for a stream-only backend that emits no finish reason, so gating dispatch on `tool_calls` would stop such a backend from calling tools at all. The cost: truncation from such a backend is invisible here, and the guarantee holds only for backends that report it. The four built-in backends implement `generate` and do.

The rule only works if backends report truncation. Anthropic's `model_context_window_exceeded` maps to `length` and `refusal` to `content_filter` in `components/anthropic` and in `components/bedrock`'s Anthropic path. `agent.maxTokens` (default 16384) is sent on every request, so truncation is rarer, but the check above is what keeps it visible.
