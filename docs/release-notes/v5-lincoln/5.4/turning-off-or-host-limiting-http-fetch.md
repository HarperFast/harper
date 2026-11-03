---
section: 'Built-in Agent'
order: 10
---

### Turning Off or Host-Limiting `http_fetch`

`agent.httpFetch` sets whether the built-in agent has its `http_fetch` tool: `false` removes it, and `{ allow: [...] }` refuses any request whose host is not on the list. It is read at startup only, and `set_agent_config` rejects it. `http_fetch` now also checks every redirect hop before following it, in every mode. See [Restricting `http_fetch`](/reference/v5/configuration/options#restricting-http_fetch).
