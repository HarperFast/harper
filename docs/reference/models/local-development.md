---
id: local-development
title: Local Development
---

<!-- Source: harper resources/models/bootstrap.ts, resources/models/backendRegistry.ts, components/ollama, components/openai (v5.1) -->

<VersionBadge version="v5.1.0" />

The models API is designed so the same application code runs unchanged against local models during development and hosted providers in production. Application code addresses models by [logical name](./overview#configuration); which physical backend a logical name resolves to is decided by each instance's configuration. Setting up local development is therefore a configuration exercise: give the logical names your application uses a backend you can run on your own machine — no API keys, no network egress, no code changes.

## A local configuration

[Ollama](https://ollama.com) is the shortest path to local models: install it, pull an embedding model and a generation model, and point the default logical names at it. The [`ollama` backend](./backends#ollama) needs no credentials.

```bash
ollama pull nomic-embed-text
ollama pull llama3.2
```

```yaml
# harper-config.yaml (development)
models:
  embedding:
    default:
      backend: ollama
      host: localhost:11434
      model: nomic-embed-text:latest
  generative:
    default:
      backend: ollama
      host: localhost:11434
      model: llama3.2
```

The matching production configuration maps the same logical names to hosted providers, with credentials supplied by [environment-variable indirection](./overview#credentials):

```yaml
# harper-config.yaml (production)
models:
  embedding:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: text-embedding-3-small
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
```

Application code is identical in both environments:

```javascript
import { models } from 'harper';

const [vector] = await models.embed('What is Harper?');
const reply = await models.generate('Summarize this record.');
```

The [`@embed` schema directive](../database/schema#embed), [tool calling](./tool-calling), [fallback groups](./routing#fallback-groups), and [analytics](./analytics) all address models the same way, so they carry across the swap too — subject to the parity caveats below.

## Parity caveats

Two things do not automatically carry across a backend swap:

**Tool support.** The `ollama` backend does not advertise the `tools` capability, so a `generate()` call that declares tools fails up front against it (see [Backends](./backends#ollama)). If your application uses [tool calling](./tool-calling), run an OpenAI-compatible local server with tool calling enabled and select it with the [`openai` backend's `baseUrl` field](./backends#openai). Two things have to be true for this to work.

First, the server itself must have tool calling switched on. The `openai` backend always advertises the `tools` capability, so Harper's up-front capability check passes regardless of what the server can actually do — a server that cannot parse tool calls fails at request time instead. With [vLLM](https://docs.vllm.ai), that means serving a tool-capable model with automatic tool choice enabled and the tool-call parser that matches the model family — see [vLLM's tool-calling guide](https://docs.vllm.ai/en/latest/features/tool_calling.html) for the model–parser pairings:

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct --enable-auto-tool-choice --tool-call-parser hermes
```

Second, the `openai` backend requires a non-empty `apiKey` even when the local server does not authenticate — supply any placeholder. Harper's startup warning about a literal value in a credential field is expected and harmless for a local endpoint:

```yaml
models:
  generative:
    default:
      backend: openai
      baseUrl: http://localhost:8000/v1
      apiKey: local-dev
      model: Qwen/Qwen2.5-7B-Instruct
```

**Embedding compatibility.** Embedding vectors are only comparable within a single model's vector space, and models differ in dimensionality. Vectors written locally with one embedding model cannot be meaningfully searched against vectors produced in production by another — which matters whenever embedded data, or an [HNSW index](../database/schema#vector-indexing) built from [`@embed`](../database/schema#embed) vectors, moves between environments. Where embedded data crosses environments, use the same embedding model in both — for example, an open model served by Ollama locally and by an OpenAI-compatible host in production — or re-embed after the move.

## Per-environment configuration

Each Harper instance reads its own configuration file, so the simplest arrangement is a development config with local backends and a production config with hosted ones. Where baking a config file into an image is awkward — containerized or orchestrated deployments — the `models` block can be supplied from the environment with [`HARPER_CONFIG`](../configuration/overview#harper_config), which merges exactly the keys it names over the config file:

```bash
export HARPER_CONFIG='{"models":{"embedding":{"default":{"backend":"openai","apiKey":"${OPENAI_API_KEY}","model":"text-embedding-3-small"}},"generative":{"default":{"backend":"openai","apiKey":"${OPENAI_API_KEY}","model":"gpt-4o"}}}}'
```

The `${OPENAI_API_KEY}` placeholder is resolved by Harper at startup, not by the shell — the single quotes are deliberate.

Because the merge is key-by-key and cannot remove keys, use `HARPER_CONFIG` to supply a `models` block the config file does not define (as above), or to override fields within an entry that keeps the same backend — a model name, a credential. Do not use it to switch an existing entry to a different backend: keys the override does not name stay in place, and a leftover field from the old backend — `host` from an `ollama` entry, say — is an unrecognized field on the new backend's entry, which [fails configuration validation](./overview#startup-behavior) and prevents startup. To swap backends between environments, swap the config file (or define every model entry through `HARPER_CONFIG` and keep the file's `models` block empty), and cover both the `embedding` and `generative` maps — an override that names only one leaves the other pointed wherever the file pointed it.

While iterating on configuration, remember the [startup behavior](./overview#startup-behavior) split: a structurally invalid entry fails configuration validation and prevents startup, while a registration-time error — such as an unreachable backend module — is logged and skipped, and calls to that logical name then throw as unconfigured. If a model works in one environment and throws "not configured" in another, check the startup log for a skipped registration.

## Offline and CI stubs

<VersionBadge version="v5.1.15" />

When tests must run with no model server at all, register an in-process stub as a [custom backend](./backends#custom-backends) under the logical names the application uses. A registered backend shadows a configuration entry with the same name, so the stub wins regardless of what the config file says:

```javascript
import { models } from 'harper';

models.registerBackend(
	'generative',
	'default',
	models.defineBackend({
		name: 'stub',
		async generate() {
			return { status: 'completed', output: { content: 'stub reply', finishReason: 'stop' } };
		},
	})
);
```

The stub still exercises routing, accounting, and [analytics](./analytics) — only the inference itself is faked.

Two scoping notes. `defineBackend` derives `generate` from a supplied `generateStream` (by draining the stream), but not the reverse — if the suite calls `generateStream()`, give the stub a `generateStream` implementation. And a backend registered under `'generative'` serves only generation: `embed()` resolves the `'embedding'` registry, so embedding tests need their own stub registered with `models.registerBackend('embedding', 'default', …)`.

As with any registered backend, register the stub during component initialization (for example, in `handleApplication`) rather than at a test file's top level: each worker thread keeps its own registry, so registration must run in every thread that serves requests — see [`registerBackend()`](./backends#registerbackend).
