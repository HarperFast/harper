---
section: 'Security'
---

### Forwarded Permission Denials Keep Their Detail

A permission denial from an operation that runs on a different thread than the one that received the request now carries the same detail as a denial raised on the receiving thread: `unauthorized_access` and `invalid_schema_items` next to `error`. That covers an operation a component registers with `server.registerOperation()` and calls over the Operations API, and a main-thread operation such as `agent_prompt` called from application code with `server.operation()`. Before, these denials answered with `error` alone, so what a client could read depended on which thread ran the operation. The status code is unchanged, and so is every other error that crosses threads. See [`server.operation`](/reference/v5/http/api#serveroperationoperation-context-authorize).
