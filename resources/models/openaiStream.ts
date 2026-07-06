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
	data: OpenAIChunk | string;
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
	const toolAssembly = new Map<string, { index: number; name?: string; arguments: object }>();

	const chunk = (delta: OpenAIDelta, finish: OpenAIFinishReason | null): OpenAIStreamMessage => ({
		data: {
			id,
			object: 'chat.completion.chunk',
			created,
			model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		},
	});

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
				const existing = toolAssembly.get(incoming.id) ?? { index: toolAssembly.size, arguments: {} };
				if (incoming.name) existing.name = incoming.name;
				if (incoming.arguments) existing.arguments = { ...existing.arguments, ...incoming.arguments };
				toolAssembly.set(incoming.id, existing);
			}
		}
		if (token.finishReason) finishReason = token.finishReason;
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
