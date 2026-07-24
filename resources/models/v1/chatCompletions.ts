/**
 * `POST /v1/chat/completions` — OpenAI-compatible chat endpoint (#631).
 *
 * SSE serving-path note: the OpenAI SDK sends `Accept: application/json` for
 * ALL requests including streaming ones (`client.ts:1160` in the SDK source).
 * Harper's REST layer dispatches `Accept: text/event-stream` as CONNECT, and
 * everything else as the HTTP method. So `stream: true` from an OpenAI SDK
 * client reaches this `post()` handler, NOT `connect()`. We detect the `stream`
 * flag in the body and return `{ body: Readable }` which REST.ts bypasses
 * serialisation on (REST.ts:165-193) — exactly like any SSE resource response,
 * but initiated from `post()` rather than `connect()`.
 */

import type { Readable } from 'node:stream';
import { contentTypes } from '../../../server/serverHelpers/contentTypes.ts';
import { Resource } from '../../Resource.ts';
import { models } from '../Models.ts';
import { openaiStream } from '../openaiStream.ts';
import { toOpenAIError, badRequest, authorizeV1Request } from './errors.ts';
import {
	translateMessages,
	translateTools,
	toGenerateInput,
	toGenerateOpts,
	toChatCompletion,
	validateChatRequest,
} from './translation.ts';
import type { OAIChatRequest } from './translation.ts';

type SseHandler = { serializeStream: (iterable: AsyncIterable<unknown>) => Readable };
const sseHandler = contentTypes.get('text/event-stream') as SseHandler;

// @ts-ignore — Resource base class is not typed for static dispatch; pattern mirrors login.ts
export class V1ChatCompletions extends Resource {
	static async post(_target: unknown, body: unknown, request: unknown) {
		const authError = authorizeV1Request(request as any);
		if (authError) return authError;

		// REST.ts passes `request.data` directly, which is the (unawaited) streaming
		// JSON deserializer's Promise — awaiting here is a no-op for callers (e.g.
		// unit tests) that already pass a plain object. A malformed JSON body rejects
		// this promise, which is a client error, not a 500.
		try {
			body = await body;
		} catch (err) {
			return badRequest(`Could not parse request body: ${err instanceof Error ? err.message : 'invalid JSON'}`);
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return badRequest('Request body must be a JSON object');
		}
		const req = body as OAIChatRequest;

		// Validate the nested wire shapes before mapping: the mappers assume well-formed
		// input, so an unvalidated `messages:[null]` / `tools:[{}]` would throw a TypeError
		// and surface as an RFC 9457 500 instead of an OpenAI 400.
		const invalid = validateChatRequest(req);
		if (invalid) return badRequest(invalid);

		const model = typeof req.model === 'string' ? req.model : 'default';

		try {
			const messages = translateMessages(req.messages);
			// tool_choice: 'none' means "do not call tools" — the only faithful way to honor
			// that against a returns-tool-calls backend is to not offer the tools at all.
			// 'required'/named selection are rejected in validateChatRequest.
			const tools = req.tool_choice === 'none' || !req.tools?.length ? undefined : translateTools(req.tools);
			const input = toGenerateInput(messages, tools);
			const opts = toGenerateOpts(req);
			if (req.stream) {
				const tokenStream = models.generateStream(input, opts);
				// serializeStream wraps the async iterable in a Node Readable so REST.ts
				// can return it without re-serialising. The `body` presence on the return
				// value skips REST.ts's own serialize() call (REST.ts:165-193).
				// formatError reuses the non-streaming error mapping so a mid-stream backend
				// failure reaches the client as an OpenAI-shaped SSE error frame.
				const readable = sseHandler.serializeStream(
					openaiStream(tokenStream, { model, formatError: (err) => toOpenAIError(err).data.error })
				);
				return {
					status: 200,
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'X-Accel-Buffering': 'no',
					},
					body: readable,
				};
			}

			const result = await models.generate(input, opts);
			return toChatCompletion(result, model);
		} catch (err) {
			return toOpenAIError(err);
		}
	}

	/**
	 * A client that sends an explicit `Accept: text/event-stream` with its POST is
	 * dispatched by REST as CONNECT (REST.ts), not POST. The OpenAI SDK happens to send
	 * `Accept: application/json` even when streaming, but other valid SSE clients do not.
	 *
	 * Without this override the request reached `Resource`'s default `connect`, whose
	 * instance path returns `subscribe()` — an empty `IterableEventQueue` — so the client
	 * got a 200 SSE response that stayed open forever emitting nothing, rather than an
	 * error it could act on.
	 *
	 * REST passes `null` as the CONNECT body (`resource.connect(target, null, request)`),
	 * so the parsed body is taken off the request and handed to the same `post()`
	 * implementation — one code path, identical validation and error shaping.
	 *
	 * `connect` is also reachable from the WebSocket handler with a different signature
	 * (`resourceRequest, incomingMessages, request`), where there is no `request.data`;
	 * that case is rejected as a client error rather than returning an envelope the WS
	 * path would fail to iterate.
	 */
	static async connect(target: unknown, _data: unknown, request: unknown) {
		const data = (request as { data?: unknown })?.data;
		if (data === undefined) {
			return badRequest('This endpoint requires a JSON request body; WebSocket connections are not supported');
		}
		return this.post(target, data, request);
	}
}
