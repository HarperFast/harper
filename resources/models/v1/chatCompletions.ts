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
import { toOpenAIError, badRequest } from './errors.ts';
import { translateMessages, translateTools, toGenerateInput, toGenerateOpts, toChatCompletion } from './translation.ts';
import type { OAIChatRequest } from './translation.ts';

type SseHandler = { serializeStream: (iterable: AsyncIterable<unknown>) => Readable };
const sseHandler = contentTypes.get('text/event-stream') as SseHandler;

// @ts-ignore — Resource base class is not typed for static dispatch; pattern mirrors login.ts
export class V1ChatCompletions extends Resource {
	static async post(_target: unknown, body: unknown, _request: unknown) {
		// REST.ts passes `request.data` directly, which is the (unawaited) streaming
		// JSON deserializer's Promise — awaiting here is a no-op for callers (e.g.
		// unit tests) that already pass a plain object.
		body = await body;
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return badRequest('Request body must be a JSON object');
		}
		const req = body as OAIChatRequest;

		if (!Array.isArray(req.messages) || req.messages.length === 0) {
			return badRequest("'messages' must be a non-empty array");
		}

		const model = typeof req.model === 'string' ? req.model : 'default';
		const messages = translateMessages(req.messages);
		const tools = req.tools?.length ? translateTools(req.tools) : undefined;
		const input = toGenerateInput(messages, tools);
		const opts = toGenerateOpts(req);

		try {
			if (req.stream) {
				const tokenStream = models.generateStream(input, opts);
				// serializeStream wraps the async iterable in a Node Readable so REST.ts
				// can return it without re-serialising. The `body` presence on the return
				// value skips REST.ts's own serialize() call (REST.ts:165-193).
				const readable = sseHandler.serializeStream(openaiStream(tokenStream, { model }));
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
}
