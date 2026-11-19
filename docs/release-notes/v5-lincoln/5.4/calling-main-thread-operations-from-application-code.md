---
section: 'Built-in Agent'
order: 90
---

### Calling the Agent's Operations From Application Code

`server.operation()` called from application code now reaches operations that only the main thread registers, such as `agent_prompt`, `get_agent_session` and `get_agent_config`. Applications load on worker threads, where these calls used to fail with `Operation '<name>' not found` although the same operation answered over the Operations API. The call is sent to the main thread, which applies the operation's permission check and returns the result. Such a call does not join the caller's transaction, and a streamed result is refused. See [`server.operation`](/reference/v5/http/api#serveroperationoperation-context-authorize).
