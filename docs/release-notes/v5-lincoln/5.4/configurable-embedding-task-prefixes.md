---
section: 'Models'
order: 30
---

### Configurable Embedding Task Prefixes

OpenAI embedding entries can opt into `inputPrefixes.document` and `.query` to prepend exact task instructions when a call supplies `inputType`. This supports Nomic v1/v1.5 retrieval prefixes through OpenAI-compatible endpoints. Existing entries keep their input unchanged until configured; changing document input text requires re-embedding stored documents. See [Embedding task prefixes](/reference/v5/models/backends#embedding-task-prefixes).
