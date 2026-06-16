---
id: tool-calling
title: Tool Calling
---

<!-- Source: harper resources/models/agentLoop.ts, resources/models/types.ts (v5.1) -->

<VersionBadge version="v5.1.0" />

Generative models can be given tools — functions the model may request calls to while producing a response. Tools are declared on the input object (they are model-facing content, like messages), and the `toolMode` option selects who resolves them:

- **`toolMode: 'return'`** (default) — `generate()` returns as soon as the model requests tool calls; your code dispatches them and continues the conversation.
- **`toolMode: 'auto'`** — Harper runs an in-process loop: it dispatches each requested tool to a handler you supply, feeds results back to the model, and repeats until the model produces a final answer or a budget is exhausted.

Tool calling requires a backend that supports tools (see the [backend capability table](./backends)). Declaring tools against a backend without tool support fails up front rather than silently dropping the tools.

## Declaring tools

Use the object form of the generation input. Each tool has a name, a description, and a JSON Schema for its arguments:

```javascript
const input = {
	system: 'You are a helpful assistant.',
	messages: [{ role: 'user', content: 'What is the weather in Denver?' }],
	tools: [
		{
			name: 'get_weather',
			description: 'Get the current weather for a city.',
			parameters: {
				type: 'object',
				properties: { city: { type: 'string' } },
				required: ['city'],
			},
		},
	],
};
```

## toolMode: 'return'

The model's requested calls come back on the result, and `finishReason` is `'tool_calls'`. Your code runs the tools, appends the results as `tool`-role messages, and calls `generate()` again:

```javascript
const result = await models.generate(input);
if (result.finishReason === 'tool_calls') {
	const followUp = [...input.messages, { role: 'assistant', content: result.content, toolCalls: result.toolCalls }];
	for (const call of result.toolCalls) {
		const output = await getWeather(call.arguments); // your dispatch
		followUp.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(output) });
	}
	const final = await models.generate({ ...input, messages: followUp });
}
```

`ToolCall.arguments` is always a parsed object — backends that deliver stringified JSON normalize it before returning.

## toolMode: 'auto'

Supply handlers keyed by tool name and Harper resolves the calls in-process:

```javascript
const result = await models.generate(input, {
	toolMode: 'auto',
	toolHandlers: {
		get_weather: async ({ city }, ctx) => fetchWeather(city, { signal: ctx.signal }),
	},
	maxToolIterations: 5,
	includeToolTrace: true,
});
console.log(result.content); // final answer, tool round-trips already resolved
```

A handler receives the parsed arguments and a context object `{ signal, accounting }`. The `signal` is the composed cancellation signal for the iteration — it fires if the caller aborts or a budget trips, so long-running handlers should honor it. The handler's return value is JSON-serialized and fed back to the model; a thrown error is routed by `toolErrorMode` (below).

`generateStream()` supports `toolMode: 'auto'` as well: content deltas stream out as each round produces them, and `finishReason` is emitted exactly once, on the final chunk of the final round.

### Options

All options below apply only with `toolMode: 'auto'`.

| Option               | Type                          | Default      | Description                                                                                                                                                                                                                        |
| -------------------- | ----------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolHandlers`       | `Record<string, ToolHandler>` | —            | Dispatch table keyed by tool name. A tool declared in `tools` with no handler here is a configuration error (400)                                                                                                                  |
| `maxToolIterations`  | `number`                      | `10`         | Hard cap on model → tools → model rounds                                                                                                                                                                                           |
| `maxToolTokens`      | `number`                      | —            | Cumulative prompt+completion token cap across rounds. Best-effort: requires the backend to report usage; if it does not, Harper warns once and `maxToolIterations` remains the bound. Not supported on `generateStream()` (throws) |
| `toolParallelism`    | `'parallel'` \| `'serial'`    | `'parallel'` | When one round requests multiple tool calls, run handlers concurrently or in order                                                                                                                                                 |
| `toolResultMaxBytes` | `number`                      | `65536`      | Per-result byte cap (JSON-stringified). Larger results are truncated with a marker; the model sees the truncated form, the trace records the original size                                                                         |
| `toolErrorMode`      | `'recover'` \| `'abort'`      | `'recover'`  | `'recover'` feeds a handler error back to the model as the tool result so it can react; `'abort'` stops the loop and throws with the trace attached                                                                                |
| `includeToolTrace`   | `boolean`                     | `false`      | Populate `result.trace` with one entry per tool invocation (iteration, name, arguments, result size, duration, error)                                                                                                              |
| `conversation`       | `ConversationAppender`        | —            | Optional persistence hook — see below                                                                                                                                                                                              |

### Budgets and errors

When `maxToolIterations` or `maxToolTokens` is exhausted, the loop throws a budget-exceeded error (HTTP status 429) carrying a `partialTrace` of everything that ran — the trace is attached on error paths regardless of `includeToolTrace`. With `toolErrorMode: 'abort'`, a handler failure throws an error carrying the same trace.

If the model requests a tool name that was never declared in `tools` (a hallucinated tool), the call is treated as a tool error and routed by `toolErrorMode` — with `'recover'`, the model is told the tool is unknown and can correct itself.

### Conversation persistence

The `conversation` option accepts any object with an `append(turn)` method returning a promise. The loop awaits `append` for each new turn it produces — assistant turns (with their tool calls) and tool-result turns — in order, giving the appender back-pressure over the loop. The caller's own input messages are not echoed back through the hook. Appenders should catch their own recoverable failures; a throw from `append` becomes the loop's terminal error.

### Reserved options

`toolArgValidation` (`'strict'` / `'lenient'` JSON Schema validation of tool arguments), `maxCostUsd`, and `conversationId` exist on the type surface but are not functional in 5.1 — the validation modes and streaming token budgets throw a `501` error, and the cost cap has no rate card behind it yet. Don't rely on them.
