/**
 * `openaiStream()` — format an internal `generateStream()` token iterator into the
 * OpenAI-compatible Server-Sent Events shape so unmodified OpenAI / LangChain.js /
 * Vercel AI SDK clients can consume a Harper chat-completions stream (#514, #510).
 *
 * The yielded `{ data }` messages pass through Harper's existing `text/event-stream`
 * serializer (`server/serverHelpers/contentTypes.ts`) unchanged: an object `data`
 * is JSON-stringified to `data: {json}\n\n`, and the terminal `{ data: '[DONE]' }`
 * sentinel serializes to `data: [DONE]\n\n` — exactly OpenAI's wire format. We emit
 * NO SSE `event:` or `id:` lines: OpenAI's stream is `data:`-only and the completion
 * id lives inside the JSON payload, not as an SSE field.
 */

import { randomUUID } from 'node:crypto';
import type { GenerateChunk, GenerateResult } from './types.ts';

type OpenAIFinishReason = GenerateResult['finishReason'];

export interface OpenAIStreamOptions {
	/** Advertised model name echoed back on every chunk. */
	model?: string;
	/** Reuse a caller-supplied completion id across all chunks; one is generated when omitted. */
	id?: string;
	/**
	 * Map a mid-stream backend error to an OpenAI error body for a final `data: {error}`
	 * SSE frame. Lets the v1 gateway reuse its `toOpenAIError` mapping without this generic
	 * formatter depending on the v1 layer. When omitted, a generic server_error body is emitted.
	 */
	formatError?: (err: unknown) => OpenAIErrorFrameBody;
}

// Bounds on per-stream tool-call assembly. The backend supplies both the call ids and the
// argument fields, and this runs on a public HTTP path, so neither can be unbounded. Overflow
// terminates the stream through the same sanitized error-frame path as any backend failure.
const MAX_TOOL_CALLS_PER_STREAM = 256;
const MAX_TOOL_ARGUMENT_KEYS = 1024;

/** Signals that a stream exceeded the tool-assembly bounds; surfaced as an SSE error frame. */
class ToolAssemblyOverflowError extends Error {
	statusCode = 502;
}

/** Count only the keys `source` adds to `target`, so accumulation stays O(delta), not O(total). */
function assignCountingNewKeys(target: object, source: object): number {
	let added = 0;
	for (const key in source) {
		if (!(key in target)) added++;
		(target as Record<string, unknown>)[key] = (source as Record<string, unknown>)[key];
	}
	return added;
}

/** OpenAI streaming error body (`{ message, type, code, param }` under an `error` key). */
export interface OpenAIErrorFrameBody {
	message: string;
	type: string;
	code: string | null;
	param: string | null;
}

interface OpenAIToolCallDelta {
	index: number;
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface OpenAIDelta {
	role?: 'assistant';
	content?: string;
	tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: Array<{ index: number; delta: OpenAIDelta; finish_reason: OpenAIFinishReason | null }>;
}

/** SSE message envelope consumed by Harper's `text/event-stream` serializer. */
export interface OpenAIStreamMessage {
	data: OpenAIChunk | { error: OpenAIErrorFrameBody } | string;
}

/**
 * Wrap a `GenerateChunk` async iterable as OpenAI `chat.completion.chunk` SSE messages,
 * terminated by the `[DONE]` sentinel. Content deltas stream inline; tool calls are
 * assembled and flushed once (see the tool-call note below).
 */
export async function* openaiStream(
	tokens: AsyncIterable<GenerateChunk>,
	opts: OpenAIStreamOptions = {}
): AsyncGenerator<OpenAIStreamMessage> {
	const id = opts.id ?? `chatcmpl-${randomUUID().replaceAll('-', '')}`;
	const created = Math.floor(Date.now() / 1000);
	const model = opts.model ?? '';

	let roleSent = false;
	let finishReason: OpenAIFinishReason | undefined;

	// Tool-call assembly. Backends pre-parse arguments to objects and may re-send the
	// same id with partial fields (see `mergeToolCallDelta` in agentLoop.ts), so we
	// accumulate by id here and emit each call's arguments as ONE stringified blob.
	// Emitting incremental fragments would corrupt the OpenAI client's concatenation
	// (`{"a":1}` + `{"b":2}` → invalid JSON) — Harper's already-buffered upstream model
	// means we cannot faithfully reproduce per-token argument fragments anyway.
	const toolAssembly = new Map<string, { index: number; name?: string; arguments: object; argumentCount: number }>();

	const chunk = (delta: OpenAIDelta, finish: OpenAIFinishReason | null): OpenAIStreamMessage => ({
		data: {
			id,
			object: 'chat.completion.chunk',
			created,
			model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		},
	});

	try {
		for await (const token of tokens) {
			if (token.deltaContent !== undefined) {
				const delta: OpenAIDelta = {};
				if (!roleSent) {
					delta.role = 'assistant';
					roleSent = true;
				}
				delta.content = token.deltaContent;
				yield chunk(delta, null);
			}
			if (token.deltaToolCalls) {
				for (const incoming of token.deltaToolCalls) {
					if (!incoming.id) continue;
					let existing = toolAssembly.get(incoming.id);
					if (!existing) {
						// Cap distinct calls per stream: ids come from the backend, and an
						// unbounded map on a public HTTP path is a memory risk.
						if (toolAssembly.size >= MAX_TOOL_CALLS_PER_STREAM) {
							throw new ToolAssemblyOverflowError(`stream exceeded ${MAX_TOOL_CALLS_PER_STREAM} tool calls`);
						}
						// Null-prototype: arguments come from JSON.parse, so a field literally
						// named `__proto__` is an own property. Object.assign uses [[Set]], which
						// on an ordinary object would hit Object.prototype's inherited `__proto__`
						// setter and silently drop the field (the previous spread did not).
						existing = { index: toolAssembly.size, arguments: Object.create(null), argumentCount: 0 };
						toolAssembly.set(incoming.id, existing);
					}
					if (incoming.name) existing.name = incoming.name;
					// Guard the contract (`ToolCall.arguments` is an object): a string would be
					// assigned index-wise, inflating the field count from characters.
					if (incoming.arguments && typeof incoming.arguments === 'object') {
						// Mutate rather than re-spread — spreading copied every previously
						// accumulated property on each partial delta (O(n²) as fields grow) — and
						// count only newly-introduced keys so the bound check stays O(delta) too.
						existing.argumentCount += assignCountingNewKeys(existing.arguments, incoming.arguments);
						if (existing.argumentCount > MAX_TOOL_ARGUMENT_KEYS) {
							throw new ToolAssemblyOverflowError(`tool call arguments exceeded ${MAX_TOOL_ARGUMENT_KEYS} fields`);
						}
					}
				}
			}
			if (token.finishReason) finishReason = token.finishReason;
		}
	} catch (err) {
		// The backend can throw partway through the stream (Models#wrapStream re-throws
		// mid-stream backend errors). Headers/200 are already flushed, so this can't be an
		// HTTP error status — emit a final OpenAI-shaped `data: {error}` frame so SDK clients
		// see a parseable error (matching the non-streaming path) instead of an abrupt socket
		// close. OpenAI terminates the stream on error and sends no `[DONE]`, so we do the same.
		const error = opts.formatError
			? opts.formatError(err)
			: { message: 'Internal server error', type: 'server_error', code: null, param: null };
		yield { data: { error } };
		return;
	}

	if (toolAssembly.size > 0) {
		const toolCalls: OpenAIToolCallDelta[] = [];
		for (const [callId, call] of toolAssembly) {
			toolCalls.push({
				index: call.index,
				id: callId,
				type: 'function',
				function: { name: call.name ?? '', arguments: JSON.stringify(call.arguments) },
			});
		}
		const delta: OpenAIDelta = {};
		if (!roleSent) {
			delta.role = 'assistant';
			roleSent = true;
		}
		delta.tool_calls = toolCalls;
		yield chunk(delta, null);
	}

	const finish: OpenAIFinishReason = finishReason ?? (toolAssembly.size > 0 ? 'tool_calls' : 'stop');
	const terminalDelta: OpenAIDelta = {};
	if (!roleSent) terminalDelta.role = 'assistant';
	yield chunk(terminalDelta, finish);

	yield { data: '[DONE]' };
}
