---
section: 'Built-in Agent'
order: 20
---

### Cut-Off Agent Replies End the Run `error`

A model reply that did not finish now ends the agent session `error`, with the reason in `lastError`, instead of `completed`. That covers a reply cut off at the output-token cap or at the model's context window, one stopped by a content filter or a refusal, one that asks for tool calls of which none could be parsed, and an empty reply. Nothing from that reply reaches the transcript, and its tool calls are neither run nor queued for approval. Its usage is still kept on the session, and counts toward the agent's spend caps. The new `agent.maxTokens` (default `16384`) is sent with every model request the agent makes; lower it for a model whose own output limit is smaller, or the provider rejects each request. See [`agent`](/reference/v5/configuration/options#agent) and [Agent](/reference/v5/operations-api/operations#agent).
