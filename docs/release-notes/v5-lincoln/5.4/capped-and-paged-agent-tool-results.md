---
section: 'Built-in Agent'
order: 50
---

### Capped and Paged Agent Tool Results

The built-in agent added every tool result to its conversation in full, so one large result, such as a log read whole, could fill the model's context window and leave the session unusable. A tool result is now cut to `agent.maxToolResultBytes` (default `65536`) before it is stored, and `read_file` pages through a file by line, with no size limit, returning a cursor (`nextLine`, `nextOffset`) to continue from. When a provider still rejects a request as too long for the model, the agent cuts the most recent tool results to 2 KiB and retries once, and prompting a session left unusable by an earlier version usually recovers it the same way. The agent also stops sending its system prompt twice per request. See [When a conversation outgrows the model's context window](/reference/v5/operations-api/operations#when-a-conversation-outgrows-the-models-context-window).
