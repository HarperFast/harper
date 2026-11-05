---
section: 'Built-in Agent'
order: 60
---

### Spend Caps for the Built-in Agent

The agent records the usage of each model call on its session, and `get_agent_session` and `list_agent_sessions` report a session's totals as `usage`. Two caps bound a whole session, across every run in it: the new `agent.maxSessionTokens`, and `agent.maxCostUsd`, which is now enforced from model pricing and no longer defaults to `5.00`. A reply the agent rejects, such as one cut off at `agent.maxTokens`, still counts toward a cap, though it stays out of the transcript. A session at a cap makes no further model call: it ends `error`, or `completed` with `lastError` naming the cap when the call that reached it was the final answer. A cap that cannot be measured stops the session rather than letting it run uncapped. Caps count calls that return: a call that fails, even one the provider billed, is not counted. If your configuration already sets `agent.maxCostUsd`, declare `pricing` on the generative entry the agent uses, and start new sessions: a session created before 5.4.0 recorded no usage, so it cannot be continued under a cap. See [Agent spend caps](/reference/v5/configuration/options#agent-spend-caps).
