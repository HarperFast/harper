---
id: backends
title: Backends
---

<!-- Source: harper components/ollama, components/openai, components/anthropic, components/bedrock (v5.1) -->

<VersionBadge version="v5.1.0" />

Four provider backends ship with Harper, serving `embedding` and `generative` entries. Each model entry in the [`models` configuration](./overview#configuration) selects one with its `backend` field. `decision` entries are served by the built-in [generative decision adapter](#generative-decision-adapter) or by a [custom decision backend](#decision-backends).

| Backend     | Embeddings | Generation | Streaming | Tools           | Schema output |
| ----------- | ---------- | ---------- | --------- | --------------- | ------------- |
| `ollama`    | ✓          | ✓          | ✓         | —               | ✓             |
| `openai`    | ✓          | ✓          | ✓         | ✓               | ✓             |
| `anthropic` | —          | ✓          | ✓         | ✓               | —             |
| `bedrock`   | ✓          | ✓          | ✓         | varies by model | —             |

"Schema output" is the `structuredOutput` capability: whether Harper sends `responseFormat: { schema }` to the provider as a decoding constraint. It says what Harper sends, not what a remote endpoint honors — an OpenAI-compatible server behind `baseUrl` that ignores `response_format` still reads as ✓, and it is the operator's job to know.

All backends support these common fields:

| Field              | Description                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`          | Which backend to use (required)                                                                                                                                                                                            |
| `model`            | Provider-side model identifier (e.g. `gpt-4o`) used when a call does not pass its own `model` option                                                                                                                       |
| `requestTimeoutMs` | Per-request timeout in milliseconds; composed with any caller-provided `AbortSignal`                                                                                                                                       |
| `revision`         | From v5.3.1, a non-secret label for the deployment behind the entry, for [calibration](./calibration#when-the-deployment-changes-but-the-configuration-does-not); change it when the same settings reach a different model |

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

## Generative decision adapter

<VersionBadge version="v5.3.0" />

Serves [`models.decide()`](./api#decide) over any configured generative model, so decisions work without a dedicated decision backend. It is selected with `backend: generative` under `models.decision` and is the only built-in for that kind; the four provider backends are rejected under `decision`, and `generative` is rejected under `embedding` or `generative`.

```yaml
models:
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
  decision:
    default:
      backend: generative
      generative: default
      scoring: auto
      samples: 5
```

| Field                     | Default     | Description                                                                                                                                                                                   |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generative`              | `'default'` | Logical name of the generative model to score or sample, resolved at call time — a reload of that entry is picked up without touching the decision entry                                      |
| `scoring`                 | `'auto'`    | `auto` scores from the generative backend's log-probabilities when it implements [`scoreChoices`](#scoring-generative-backends) and votes otherwise; `score` never votes; `vote` never scores |
| `samples`                 | `5`         | Completions per voted decision, 1 to 25, validated at startup. A voted distribution is the vote frequency, so `samples` sets its granularity                                                  |
| `concurrency`             | `5`         | Completions or scoring calls in flight at once, 1 to 25                                                                                                                                       |
| `temperature`             | backend     | Sampling temperature passed to every vote sample; higher values spread the votes. Not sent when scoring                                                                                       |
| `requestTimeoutMs`        | —           | Budget for the whole decision, composed with the caller's `AbortSignal`                                                                                                                       |
| `requireStructuredOutput` | `true`      | Route each sample only to a generative candidate with the `structuredOutput` capability. `false` allows a prompt-only backend, whose replies are parsed leniently                             |

With `scoring: auto`, the adapter first asks whether the `generative` logical name routes to a backend that implements `scoreChoices`: [OpenAI](#openai) does, from chat `logprobs`; [Ollama](#ollama), [Anthropic](#anthropic), and [Amazon Bedrock](#amazon-bedrock) do not, and a [custom backend](#scoring-generative-backends) may. If it does, each leaf of the schema — each field of an object schema — is scored in one call: the backend returns a log-likelihood for every allowed value and the adapter normalizes them into the distribution, so the probabilities are finer than vote counts and a decision costs one call per leaf rather than `samples` completions. A backend may decline a call it cannot score — OpenAI does for more than 20 allowed values in a leaf (it reports `maxScoredChoices: 20`, so under `scoring: auto` a schema with a larger leaf votes without any scoring attempt), for a model that refuses `logprobs`, for a completion that carries no log-probabilities, when none of the alternatives it returns is a label, and when the probability outside its returned alternatives could outrank the leading label. A decline is not a failure: the scoring call is routed like any other, so a [fallback group](./routing#fallback-groups) on the generative name hands the call to its next scoring candidate, and only when every candidate has declined does the adapter discard any leaf it had already scored and vote the whole decision under the same budget. A decision is never part scored, part voted, and the [analytics](./analytics) rows show which path ran. Any other failure — a provider error, a malformed response — is tried against the next scoring candidate too; when no candidate succeeds and at least one failed, the decision fails with that failure rather than turning into a vote. `scoring: score` fails the decision on a decline too, and `scoring: vote` always votes. `calibrated` is always `false` on either path: scores and vote frequencies are estimates, not calibrated probabilities.

The OpenAI backend lists the allowed values under the labels `A` to `T`, one per line, asks for one token with `top_logprobs: 20`, and scores each label from the alternatives returned for that token, combining spellings of the same letter. A label absent from the alternatives is placed only when the probability the list leaves over is smaller than the leading label's, so a value absent from the list is never the chosen one; the absent values then share the leftover probability equally, so together they never exceed it and each stays below the leader, and when the list leaves nothing over they sit far below its smallest entry, finite so the vector still normalizes. Every score is still an estimate: a listed value's own unlisted spellings can add up to the leftover to it, so two listed values closer than that may be ordered wrongly. A model that refuses `logprobs`, by a 400 whose `param` is `logprobs` or whose message names the parameter as unsupported, or by a completion that carries no log-probabilities at all, has scoring switched off until the configuration reloads (any other 400, such as an oversized prompt, is an ordinary failure and leaves scoring on), and the backend then reports `scoreChoices: false` for it, so later decisions vote without an attempt; a reasoning model that rejects log-probabilities does not pay a refused request before every vote.

The adapter serves [no-match scores](./api#no-match-scores) on both paths. When voting, each leaf that set `noMatch: true` is answered as an object with `value` and `noMatch` properties (the closest allowed value, and whether none of them truly fits), and its score is the share of samples that said no match; a sample without the boolean fails the decision. When scoring, the leaf gets one extra choice, "(none of the listed values)", whose share of the scores is `noMatch`, and the allowed values are renormalized without it; that extra choice counts toward the backend's limit, so an OpenAI leaf with 20 allowed values is voted rather than scored once it sets `noMatch: true`. The adapter's no-match scores are not calibrated.

When voting, the adapter translates the decision schema into a JSON Schema, asks the generative model for `samples` completions with `responseFormat: { schema }`, parses each one, and reports each allowed value's share of the votes as its probability — including zero for values that received none. The state is part of every sample's prompt, so a decision costs `samples` times its tokens. By default every sample requires the `structuredOutput` capability, so it is routed only to a generative candidate that sends the schema as a decoding constraint ([OpenAI](#openai) and [Ollama](#ollama)); a fallback group falls through to such a candidate, and a group with none fails with a capability error before any completion is requested. Set `requireStructuredOutput: false` on the decision entry to sample a prompt-only backend such as [Anthropic](#anthropic) or [Amazon Bedrock](#amazon-bedrock), whose current integrations ignore `responseFormat` and answer from the prompt alone. The adapter tolerates a code fence or brace-free prose around the JSON object, and ignores extra properties. A sample whose required values are missing or outside the allowed set fails the whole decision rather than being dropped from the vote. Any samples still in flight are cancelled first.

Each vote sample flows through `models.generate()` and each scoring call through the same routing as a `generate` call, so each is routed, recorded, and billed as a call of its own — a `generate` or a `scoreChoices` row in [analytics](./analytics); the `decide` row carries the decision's latency but no token counts, so tokens are never counted twice.

## Decision backends

<VersionBadge version="v5.3.0" />

A `decision` backend implements `decide(state, schema, opts)` and returns the distribution over the schema's allowed values. Fine-tuned classifiers, zero-shot NLI models, cross-encoders, and hosted decision models fit this shape without pretending to be a `generative` backend. Register one programmatically with [`defineBackend()`](#definebackend) and [`registerBackend('decision', …)`](#registerbackend), or select it from `models.decision` config as a [config-selectable backend](#config-selectable-backends):

```yaml
models:
  decision:
    default:
      backend: '@acme/harper-decision'
      apiKey: ${ACME_API_KEY}
      fallback: [llm]
    llm:
      backend: generative
```

The backend returns `{ status: 'completed', output, usage? }` where `output` is:

- for a leaf schema, `{ distribution: [{ value, probability }, …], calibrated?, signature? }`: one entry for every allowed value, with probabilities that sum to one;
- for an object schema, `{ fields: { [property]: { distribution } }, calibrated?, signature? }`: one such distribution per property.

A leaf that sets `noMatch: true` also needs `noMatch`, a number from 0 to 1, in its output (at the root for a leaf schema, in that property's entry for an object schema), and only a backend defined with `noMatch: true` is routed such a call. A `noMatch` on a leaf that did not ask for one is ignored.

Harper derives `value` and `probability` from the distribution, sorts it, and validates it against the schema before returning a `Decision`; a backend may supply `value` too; it must be a most-probable outcome, and on a tie it leads the distribution. An output that is incomplete, out of set, or does not sum to one is treated as a backend failure, so the next candidate in the [fallback group](./routing#fallback-groups) is tried. `calibrated` on the output overrides the backend's declared `calibrated` capability for that call, for object schemas too. When the caller passed `requires: ['calibrated']` and the output reports `calibrated: false`, that attempt is recorded as a failure after the request and the next candidate is tried. An optional `signature` string names the configuration that produced the scores (sampling, scoring method, prompt revision); it is stored with the [decision record](./analytics#durable-decisions) so calibration can be keyed per configuration. The built-in adapter reports its generative logical name, scoring mode, sample count and temperature, and from v5.3.1, while calibration is on, a fingerprint of the generative entry that served the decision, so a model or `revision` change on that entry changes it.

## Scoring generative backends

<VersionBadge version="v5.3.0" />

A `generative` backend may also implement `scoreChoices(input, choices, opts)`, which the [generative decision adapter](#generative-decision-adapter) uses to score a decision from the model's own likelihoods instead of voting. `input` is the decision prompt in the shape `generate` takes, `choices` is a leaf's allowed values as strings in schema order, and `opts` carries the caller's `signal` and accounting context. It returns `{ status: 'completed', output: { logLikelihoods }, usage? }` with one finite, unnormalized log-likelihood per choice in the same order; Harper normalizes them, and treats a result that is not one finite number per choice as a backend failure. For a call the backend cannot score, throw an error whose `name` is `'ChoiceScoringUnsupportedError'`, with a `usage` property when the attempt consumed tokens: the attempt is recorded as `scoring_unsupported` with those tokens, the next scoring candidate in the [fallback group](./routing#fallback-groups) is tried, and when every candidate declines the adapter votes under `scoring: auto`. Any other error is a failure: the next candidate is tried, and if every candidate fails the failure, not a decline, is what surfaces. A backend built with [`defineBackend()`](#definebackend) derives the `scoreChoices` capability from the method's presence; a hand-written backend declares it in `capabilities()`.

## Custom backends

<VersionBadge version="v5.1.15" />

Beyond the four built-ins, a component or application can register its own backend — including an in-process one that runs inference locally instead of calling an HTTP service. A registered backend is selected by its logical name through the same `model` option as a configured backend.

Custom backends can be added two ways: **registered programmatically** (below), or **selected in config** by pointing the `backend` field at a module — see [Config-selectable backends](#config-selectable-backends).

### defineBackend()

<VersionBadge type="changed" version="v5.3.0" />

```typescript
models.defineBackend(spec: DefineBackendSpec): ModelBackend
```

A method on `models` (reachable as `models.defineBackend(...)` / `scope.models.defineBackend(...)`). Builds a `ModelBackend` from the methods it implements. `capabilities()` is derived from which of `embed` / `generate` / `generateStream` / `decide` / `scoreChoices` are supplied; `tools`, `adapters`, `calibrated`, `structuredOutput`, `noMatch` and `calibratedNoMatch` cannot be inferred from method presence, so declare them explicitly; a backend that leaves them out is never routed calls that require them. `maxScoredChoices` is a limit rather than a capability: leave it out when `scoreChoices` accepts any number of choices.

| Field               | Type       | Default | Description                                                                                                                                                          |
| ------------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | `string`   | —       | Backend name, used in analytics and error messages (required)                                                                                                        |
| `embed`             | `function` | —       | `embed(input, opts)` implementation, if the backend embeds                                                                                                           |
| `generate`          | `function` | —       | `generate(input, opts)` implementation, if the backend generates                                                                                                     |
| `generateStream`    | `function` | —       | `generateStream(input, opts)` implementation, if the backend streams                                                                                                 |
| `decide`            | `function` | —       | `decide(state, schema, opts)` implementation, if the backend decides — see [Decision backends](#decision-backends)                                                   |
| `scoreChoices`      | `function` | —       | `scoreChoices(input, choices, opts)` implementation, if the backend scores closed-set alternatives — see [Scoring generative backends](#scoring-generative-backends) |
| `maxScoredChoices`  | `number`   | —       | The most choices one `scoreChoices` call accepts; a call above it is declined without a request. Must be a positive integer                                          |
| `tools`             | `boolean`  | `false` | Whether `generate` supports tool calls                                                                                                                               |
| `adapters`          | `boolean`  | `false` | Whether the backend supports per-call adapter selection                                                                                                              |
| `calibrated`        | `boolean`  | `false` | Whether the probabilities `decide` returns are calibrated; selectable with `requires: ['calibrated']`                                                                |
| `structuredOutput`  | `boolean`  | `false` | Whether `generate` sends `responseFormat: { schema }` as a decoding constraint; selectable with `requires: ['structuredOutput']`                                     |
| `noMatch`           | `boolean`  | `false` | Whether `decide` returns a no-match score for leaves that set `noMatch: true`; required by such a call                                                               |
| `calibratedNoMatch` | `boolean`  | `false` | Whether that no-match score is calibrated; required with `calibrated` by an opted-in call that requires `calibrated`                                                 |

`embed`, `generate`, and `decide` return the shape the built-in backends return: `{ status: 'completed', output, usage? }`, where `output` is `Float32Array[]` for `embed`, `{ content, finishReason }` for `generate`, and a distribution (or per-field distributions) for `decide`. `generateStream` is an async generator yielding incremental `{ deltaContent?, deltaToolCalls?, finishReason? }` chunks — the same [`generateStream()`](./api#generatestream) shape, not a wrapped result. At least one method must be supplied. A backend that supplies only `generateStream` still satisfies `generate()`: Harper drains the stream into a single result.

### registerBackend()

<VersionBadge type="changed" version="v5.3.0" />

```typescript
models.registerBackend(kind: 'embedding' | 'generative' | 'decision', id: string, backend: ModelBackend): void
```

Registers `backend` under the logical name `id` for the given `kind`; an `embedding` backend must implement `embed`, a `generative` backend `generate` or `generateStream`, and a `decision` backend `decide`. A method on `models` (reachable as `models.registerBackend(...)` / `scope.models.registerBackend(...)`). Register during component initialization (for example, in `handleApplication`) so the backend is in place before requests arrive; the registry is process-wide, so each worker thread that loads the component registers its own instance.

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

### Config-selectable backends

A `backend` value in the [`models` configuration](./overview#configuration) that isn't a built-in name is resolved as a **module specifier** and imported at startup; the module's default export — or a `register` export — is a factory that registers the backend. This lets an operator select a custom backend entirely from config, the same way the built-ins are selected.

```yaml
models:
  embedding:
    default:
      backend: '@acme/embedder' # an installed package
      model: bge-small
```

The `backend` specifier is resolved as:

- a **bare package** (`@acme/embedder`) — resolved from the Harper instance's `node_modules`; install the backend as a dependency. Preferred, since it carries no filesystem path and travels with the deployment.
- an **instance-root-relative path** (`./backends/local.js`) — resolved against the Harper instance root.
- an **absolute path**.

The factory has the signature `({ logicalName, kind, config }) => void | Promise<void>` and registers via [`models.registerBackend`](#registerbackend); it receives the config entry with `${VAR}` placeholders already resolved, and `kind` is `embedding`, `generative`, or `decision` according to the map the entry sits in. A `backend` that is neither a built-in nor an importable module is logged and skipped at startup, leaving other entries unaffected.
