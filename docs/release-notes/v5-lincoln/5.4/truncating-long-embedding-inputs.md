---
section: 'Models'
order: 20
---

### Truncating Long Embedding Inputs

`models.embed(input, { truncate: true })` cuts each input to what the embedding model accepts, keeping the start of the text and any task prefix, instead of failing on an input longer than the model's context window. Only a backend that can truncate serves such a call: Ollama, Bedrock Cohere embed v3 and v4, and OpenAI-compatible embedding entries that set the new `truncation: vllm` for a vLLM 0.18 or later endpoint. If no candidate can, the call fails before any request is sent. Calls without the option send the same requests as before. Custom backends declare the capability with `defineBackend({ truncate: true })`. The `@embed` directive and the `/v1/embeddings` endpoint do not expose the option yet. See [Truncating long inputs](/reference/v5/models/api#truncating-long-inputs).
