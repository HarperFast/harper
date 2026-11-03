---
section: 'Built-in Agent'
order: 70
---

### Agent Cancellation and Limits

`cancel_agent_run` now answers every pending approval with a `cancelled_by_operator` result in the same write that marks the session `aborted`, so an approved action that has not started never runs, then or on the session's next prompt, and the session stays `aborted` even when a run was mid-step. The 409s `agent_prompt` returns for a busy session or a cancel now carry a `code` and `retryable`, so a client can tell a prompt it may resend from one already saved, and `get_agent_session` and `list_agent_sessions` report `runInFlight`. `agent.maxTurns` is now validated as a positive integer at startup and by `set_agent_config`, where a value such as `null` used to make every later run end without a model call; a bare `maxTurns:` in the configuration file now fails the agent's start. See [`cancel_agent_run`](/reference/v5/operations-api/operations#cancel_agent_run).
