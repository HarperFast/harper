---
id: api
title: API
---

<!-- Source: harper resources/models/Models.ts, resources/models/types.ts (v5.1) -->

<VersionBadge version="v5.1.0" />

The `models` object exposes three methods. All of them accept an optional `model` option naming the configured logical model to use; when omitted, the logical name `default` is used. Calling a logical name with no configured backend, or asking a backend for a capability it does not support (for example, embeddings from a generation-only backend), throws an error — capability checks run up front, before any request is made.

## embed()

```typescript
models.embed(input: string | string[], options?: EmbedOpts): Promise<Float32Array[]>
```

Converts one or more strings into embedding vectors. The result is always an array of `Float32Array`, one per input string, in input order — including when a single string is passed.

```javascript
import { models } from 'harper';

const [single] = await models.embed('What is Harper?', { inputType: 'query' });
const batch = await models.embed(['first document', 'second document']);
```

| Option      | Type                      | Default     | Description                                                                                                                         |
| ----------- | ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | `string`                  | `'default'` | Logical name of a configured embedding model                                                                                        |
| `inputType` | `'document'` \| `'query'` | —           | Hint for models that distinguish document embeddings from query embeddings (e.g. `nomic-embed-text`); ignored by models that do not |
| `signal`    | `AbortSignal`             | —           | Cancels the call; composed with the backend's configured `requestTimeoutMs`                                                         |

## generate()

```typescript
models.generate(input: GenerateInput, options?: GenerateOpts): Promise<GenerateResult>
```

Generates a completion. The input may be:

- a `string` — shorthand for a single user message,
- an array of messages: `{ role: 'system' | 'user' | 'assistant' | 'tool', content: string }`,
- an object `{ messages, tools?, system? }` — the form required to declare [tools](./tool-calling) or pass a system prompt alongside the messages.

```javascript
const result = await models.generate(
	[
		{ role: 'system', content: 'You are a terse assistant.' },
		{ role: 'user', content: 'What is an HNSW index?' },
	],
	{ temperature: 0.2, maxTokens: 300 }
);
console.log(result.content);
```

| Option           | Type                                         | Default     | Description                                                                                            |
| ---------------- | -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `model`          | `string`                                     | `'default'` | Logical name of a configured generative model                                                          |
| `temperature`    | `number`                                     | backend     | Sampling temperature, passed through to the backend                                                    |
| `maxTokens`      | `number`                                     | backend     | Completion token limit, passed through to the backend                                                  |
| `responseFormat` | `'text'` \| `'json'` \| `{ schema: object }` | `'text'`    | Structured output. `{ schema }` requests output conforming to a JSON Schema; support varies by backend |
| `toolMode`       | `'return'` \| `'auto'`                       | `'return'`  | How tool calls are handled — see [Tool Calling](./tool-calling)                                        |
| `signal`         | `AbortSignal`                                | —           | Cancels the call; composed with the backend's configured `requestTimeoutMs`                            |

Additional options apply only when `toolMode: 'auto'`; they are documented in [Tool Calling](./tool-calling).

### GenerateResult

| Field          | Type                                                           | Description                                                                                                                                  |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`      | `string`                                                       | The generated text                                                                                                                           |
| `finishReason` | `'stop'` \| `'length'` \| `'tool_calls'` \| `'content_filter'` | Why generation stopped, normalized across backends                                                                                           |
| `toolCalls`    | `ToolCall[]`                                                   | Tool calls the model requested, when `finishReason` is `'tool_calls'` (each `{ id, name, arguments }`, with `arguments` parsed to an object) |
| `usage`        | `TokenUsage`                                                   | Token usage reported by the backend (`promptTokens`, `completionTokens`, …), when available                                                  |
| `trace`        | `ToolTraceEntry[]`                                             | Per-tool-invocation trace; only populated by the `toolMode: 'auto'` loop — see [Tool Calling](./tool-calling)                                |

## generateStream()

```typescript
models.generateStream(input: GenerateInput, options?: GenerateOpts): AsyncIterable<GenerateChunk>
```

Identical to `generate()` but yields the completion incrementally:

```javascript
let text = '';
for await (const chunk of models.generateStream('Write a haiku about databases.')) {
	if (chunk.deltaContent) text += chunk.deltaContent;
}
```

Each chunk may carry:

| Field            | Type                            | Description                                                                                          |
| ---------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `deltaContent`   | `string`                        | Text appended since the previous chunk                                                               |
| `deltaToolCalls` | `Partial<ToolCall>[]`           | Tool-call deltas; a backend may deliver the same tool call across several chunks with partial fields |
| `finishReason`   | same values as `GenerateResult` | Set on the final chunk only                                                                          |

Errors detected before the call starts (unknown model name, missing capability) throw synchronously; errors during generation propagate through the iterable.

## registerBackend()

<VersionBadge version="v5.1.15" />

```typescript
models.registerBackend(kind: 'embedding' | 'generative', id: string, backend: ModelBackend): void
```

Registers a custom backend under a logical name, selectable by the `model` option on later calls. This is the programmatic path for in-process or third-party backends; pair it with `defineBackend()` to build the backend from a few methods. The same functions are exported from `harper` as `registerBackend` / `defineBackend`. See [Custom backends](./backends#custom-backends) for the full guide.

## Errors and timeouts

- An unconfigured logical model name throws a not-found error. The error names the missing logical name only — it does not enumerate configured names.
- A capability mismatch (embedding call to a generation-only backend, tool declarations against a backend without tool support) throws before any request is made.
- Each backend supports a `requestTimeoutMs` configuration field; when set, it is composed with any caller-provided `signal` so whichever fires first cancels the request.
- Backend/network failures throw backend-specific errors with sanitized messages.

Every call — successful or failed — is recorded in the [model-call analytics](./analytics).
