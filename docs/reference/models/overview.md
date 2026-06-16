---
id: overview
title: Models
---

<!-- Source: harper resources/models/Models.ts, resources/models/types.ts, resources/models/bootstrap.ts (v5.1) -->

<VersionBadge version="v5.1.0" />

Harper provides a unified API for calling AI models — text embeddings and text generation — from application code. Models are configured by an operator under logical names; application code requests a model by its logical name and Harper routes the call to the configured backend (Ollama, OpenAI, Anthropic, or Amazon Bedrock). Swapping providers is a configuration change, not a code change.

The API is exposed as a single process-wide `models` object:

```javascript
import { models } from 'harper';

const [vector] = await models.embed('What is Harper?');
const reply = await models.generate('Describe the Harper resource API in one sentence.');
```

The same object is available as `scope.models` in component scopes and as the `models` global. All three refer to the same instance.

The API surface is three methods:

| Method                                                           | Purpose                                    |
| ---------------------------------------------------------------- | ------------------------------------------ |
| [`models.embed(input, options?)`](./api#embed)                   | Convert text to embedding vectors          |
| [`models.generate(input, options?)`](./api#generate)             | Generate a completion for a prompt or chat |
| [`models.generateStream(input, options?)`](./api#generatestream) | Stream a completion as it is produced      |

Generation supports [tool calling](./tool-calling), including a built-in agent loop (`toolMode: 'auto'`) that resolves tool calls in-process. Tables can compute embedding vectors automatically at write time with the [`@embed` schema directive](../database/schema#embed), and vectors can be searched with [HNSW vector indexes](../database/schema#vector-indexing). Every model call is recorded for [observability and usage accounting](./analytics).

## Configuration

Models are configured in the `models` section of `harper-config.yaml`, split by capability into `embedding` and `generative` maps. Each key is a logical model name; each entry names a `backend` plus backend-specific settings:

```yaml
models:
  embedding:
    default:
      backend: ollama
      host: localhost:11434
      model: nomic-embed-text:latest
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
    fast:
      backend: ollama
      model: mistral:7b
```

The logical name `default` is used when application code does not pass an explicit `model` option. Calling a logical name that is not configured throws an error.

See [Backends](./backends) for the full set of configuration fields supported by each backend.

### Credentials

String values in model entries support environment-variable indirection with `${VAR_NAME}` syntax, resolved at startup. Use this for API keys rather than placing the literal key in the configuration file — Harper logs a warning at startup when a credential field contains a literal value. If the referenced environment variable is unset, the placeholder is left as-is; for credential fields the backend rejects the unresolved placeholder at startup, while other fields (such as `host` or `model`) carry the literal placeholder into requests — surfacing as per-request failures rather than a startup error. Indirection applies to string-typed fields only; numeric fields such as `requestTimeoutMs` must be literal values.

### Startup behavior

Model entries are registered when Harper boots, before components load, so `models` is usable from component initialization onward.

Model entries are validated with the rest of the configuration file at startup: a structurally invalid entry — a missing required field such as `apiKey`, an unrecognized field name, or a wrong value type — fails configuration validation and prevents Harper from starting, like any other configuration error. Errors at registration time (for example, an unrecognized `backend` name) are logged and skipped without blocking startup or other model entries.
