---
id: backends
title: Backends
---

<!-- Source: harper components/ollama, components/openai, components/anthropic, components/bedrock (v5.1) -->

<VersionBadge version="v5.1.0" />

Four model backends ship with Harper. Each model entry in the [`models` configuration](./overview#configuration) selects one with its `backend` field.

| Backend     | Embeddings | Generation | Streaming | Tools           |
| ----------- | ---------- | ---------- | --------- | --------------- |
| `ollama`    | ✓          | ✓          | ✓         | —               |
| `openai`    | ✓          | ✓          | ✓         | ✓               |
| `anthropic` | —          | ✓          | ✓         | ✓               |
| `bedrock`   | ✓          | ✓          | ✓         | varies by model |

All backends support these common fields:

| Field              | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `backend`          | Which backend to use (required)                                                                      |
| `model`            | Provider-side model identifier (e.g. `gpt-4o`) used when a call does not pass its own `model` option |
| `requestTimeoutMs` | Per-request timeout in milliseconds; composed with any caller-provided `AbortSignal`                 |

## Ollama

Calls a local or remote [Ollama](https://ollama.com) server. No credentials.

```yaml
models:
  embedding:
    default:
      backend: ollama
      host: localhost:11434
      model: nomic-embed-text:latest
  generative:
    local:
      backend: ollama
      host: ollama.internal:11434
      model: mistral:7b
```

| Field   | Default           | Description                                                                                                     |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `host`  | `localhost:11434` | Ollama server origin. A scheme-less value is treated as `http://`; a full origin (`https://…`) is used as given |
| `model` | —                 | Ollama model name, e.g. `nomic-embed-text:latest`, `mistral:7b`                                                 |

When embedding with `nomic-embed-text`, the `inputType` option (`'document'` / `'query'`) is applied using the model's task prefixes; other models ignore it.

The Ollama backend does not advertise tool support — declaring tools against it fails up front.

## OpenAI

Calls the OpenAI API — or any service exposing an OpenAI-compatible API with bearer-token authentication, by pointing `baseUrl` at it. This includes vLLM's OpenAI-compatible server, Google's Gemini OpenAI-compatible endpoint, Azure OpenAI's `/openai/v1` endpoint, and hosted gateways such as OpenRouter or Together AI.

```yaml
models:
  embedding:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: text-embedding-3-large
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
    vllm:
      backend: openai
      apiKey: ${VLLM_API_KEY}
      baseUrl: http://vllm.internal:8000/v1
      model: meta-llama/Llama-3.1-8B-Instruct
```

| Field          | Default                     | Description                                                                        |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `apiKey`       | — (required)                | API key, sent as a bearer token. Use `${VAR}` indirection                          |
| `baseUrl`      | `https://api.openai.com/v1` | API root; point at any OpenAI-compatible endpoint                                  |
| `model`        | —                           | Model name, e.g. `gpt-4o`, `text-embedding-3-large`                                |
| `organization` | —                           | Sent as the `OpenAI-Organization` header, for keys spanning multiple organizations |

`responseFormat: 'json'` maps to OpenAI's JSON mode and `responseFormat: { schema }` to strict structured outputs (`json_schema`); OpenAI-compatible servers vary in their support for these.

## Anthropic

Calls the Anthropic Messages API. Generation only — Anthropic does not offer an embeddings API.

```yaml
models:
  generative:
    claude:
      backend: anthropic
      apiKey: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-6
```

| Field     | Default                     | Description                             |
| --------- | --------------------------- | --------------------------------------- |
| `apiKey`  | — (required)                | API key, sent as the `x-api-key` header |
| `baseUrl` | `https://api.anthropic.com` | API root                                |
| `model`   | —                           | Model name, e.g. `claude-sonnet-4-6`    |

The Anthropic API requires a completion token limit on every request; when a call does not pass `maxTokens`, Harper sends `4096`.

## Amazon Bedrock

Calls AWS Bedrock. Credentials come from the standard AWS SDK chain (environment variables, shared credentials file, IAM instance/task roles) — there is no `apiKey` field.

The AWS SDK is not bundled with Harper. Install it in your project to use this backend:

```bash
npm install @aws-sdk/client-bedrock-runtime
```

```yaml
models:
  embedding:
    titan:
      backend: bedrock
      region: us-east-1
      model: amazon.titan-embed-text-v2:0
  generative:
    claude:
      backend: bedrock
      region: us-east-1
      model: anthropic.claude-sonnet-4-5-20250929-v1:0
```

| Field    | Default      | Description                                                            |
| -------- | ------------ | ---------------------------------------------------------------------- |
| `region` | — (required) | AWS region hosting the Bedrock models                                  |
| `model`  | —            | Bedrock model identifier; the vendor prefix selects the request format |

The model identifier's vendor prefix (`anthropic.`, `meta.`, `amazon.titan-`, `cohere.`, `mistral.`) determines the request/response format Harper uses; an unrecognized prefix is rejected with an error. Tool support depends on the underlying model family. Bedrock embedding APIs accept one text per request, so batch `embed()` calls are issued sequentially.

## Custom backends

<VersionBadge version="v5.1.15" />

Beyond the four built-ins, a component or application can register its own backend — including an in-process one that runs inference locally instead of calling an HTTP service. A registered backend is selected by its logical name through the same `model` option as a configured backend.

Custom backends are registered programmatically; the `backend` field in the [`models` configuration](./overview#configuration) selects only the built-ins above.

### defineBackend()

```typescript
models.defineBackend(spec: DefineBackendSpec): ModelBackend
```

A method on `models` (reachable as `models.defineBackend(...)` / `scope.models.defineBackend(...)`). Builds a `ModelBackend` from the methods it implements. `capabilities()` is derived from which of `embed` / `generate` / `generateStream` are supplied; `tools` and `adapters` cannot be inferred from method presence, so declare them explicitly.

| Field            | Type       | Default | Description                                                          |
| ---------------- | ---------- | ------- | -------------------------------------------------------------------- |
| `name`           | `string`   | —       | Backend name, used in analytics and error messages (required)        |
| `embed`          | `function` | —       | `embed(input, opts)` implementation, if the backend embeds           |
| `generate`       | `function` | —       | `generate(input, opts)` implementation, if the backend generates     |
| `generateStream` | `function` | —       | `generateStream(input, opts)` implementation, if the backend streams |
| `tools`          | `boolean`  | `false` | Whether `generate` supports tool calls                               |
| `adapters`       | `boolean`  | `false` | Whether the backend supports per-call adapter selection              |

`embed` and `generate` return the shape the built-in backends return: `{ status: 'completed', output, usage? }`, where `output` is `Float32Array[]` for `embed` and `{ content, finishReason }` for `generate`. `generateStream` is an async generator yielding incremental `{ deltaContent?, deltaToolCalls?, finishReason? }` chunks — the same [`generateStream()`](./api#generatestream) shape, not a wrapped result. At least one method must be supplied. A backend that supplies only `generateStream` still satisfies `generate()`: Harper drains the stream into a single result.

### registerBackend()

```typescript
models.registerBackend(kind: 'embedding' | 'generative', id: string, backend: ModelBackend): void
```

Registers `backend` under the logical name `id` for the given `kind`. A method on `models` (reachable as `models.registerBackend(...)` / `scope.models.registerBackend(...)`). Register during component initialization (for example, in `handleApplication`) so the backend is in place before requests arrive; the registry is process-wide, so each worker thread that loads the component registers its own instance.

Use a provider-namespaced `id` (e.g. `local:bge-small`) to avoid collisions when more than one component registers backends.

```javascript
import { models } from 'harper';
import { init, embed } from 'some-local-embedding-library';

await init();

models.registerBackend(
	'embedding',
	'local:bge-small',
	models.defineBackend({
		name: 'local:bge-small',
		async embed(input) {
			const texts = Array.isArray(input) ? input : [input];
			const vectors = await embed(texts);
			return { status: 'completed', output: vectors.map((v) => Float32Array.from(v)) };
		},
	})
);

// Selected like any other model:
const [vector] = await models.embed('What is Harper?', { model: 'local:bge-small' });
```

A registered backend takes precedence over a configuration entry with the same logical name, because registration runs after the configuration is loaded. A backend whose `capabilities()` disagrees with the methods it actually implements is registered as-is and fails at call time — `defineBackend()` keeps the two consistent.
