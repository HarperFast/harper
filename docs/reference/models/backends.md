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

The model identifier's vendor prefix (`anthropic.`, `meta.`, `amazon.titan-`, `cohere.`) determines the request/response format Harper uses. Tool support depends on the underlying model family. Bedrock embedding APIs accept one text per request, so batch `embed()` calls are issued sequentially.
