/**
 * `POST /v1/embeddings` — OpenAI-compatible embedding endpoint (#631).
 *
 * Maps OpenAI's `{ model, input }` request body to `scope.models.embed()` and
 * returns `{ object: 'list', data: [...], model, usage }` per the OpenAI wire spec.
 */

import { Resource } from '../../Resource.ts';
import { models } from '../Models.ts';
import { toOpenAIError, badRequest, authorizeV1Request } from './errors.ts';
import { toEmbedOpts, toEmbedResponse } from './translation.ts';

// Cap batched input, matching OpenAI's own 2048-item limit. The endpoint is
// super_user-only and off by default, so this is a sanity bound (avoid an
// unbounded fan-out to the backend), not a security control.
const MAX_EMBEDDING_INPUTS = 2048;

// @ts-ignore — Resource base class is not typed for static dispatch; pattern mirrors login.ts
export class V1Embeddings extends Resource {
	static async post(_target: unknown, body: Record<string, unknown>, request: unknown) {
		const authError = authorizeV1Request(request as any);
		if (authError) return authError;

		// REST.ts passes `request.data` directly, which is the (unawaited) streaming
		// JSON deserializer's Promise — awaiting here is a no-op for callers (e.g.
		// unit tests) that already pass a plain object. A malformed JSON body rejects
		// this promise, which is a client error, not a 500 (matches chatCompletions).
		try {
			body = await body;
		} catch (err) {
			return badRequest(`Could not parse request body: ${err instanceof Error ? err.message : 'invalid JSON'}`);
		}
		if (!body || typeof body !== 'object' || Array.isArray(body))
			return badRequest('Request body must be a JSON object');
		const raw = body as Record<string, unknown>;

		const input = raw.input;
		if (input === undefined || input === null) return badRequest("'input' is required");
		if (typeof input !== 'string' && !Array.isArray(input)) {
			return badRequest("'input' must be a string or array of strings");
		}
		if (Array.isArray(input) && !input.every((v) => typeof v === 'string')) {
			return badRequest("'input' array elements must be strings");
		}
		if (Array.isArray(input) && input.length > MAX_EMBEDDING_INPUTS) {
			return badRequest(`'input' array must not exceed ${MAX_EMBEDDING_INPUTS} items`);
		}

		const model = typeof raw.model === 'string' ? raw.model : 'default';
		const opts = toEmbedOpts(raw as any);

		try {
			const vecs = await models.embed(input as string | string[], opts);
			return toEmbedResponse(vecs, model);
		} catch (err) {
			return toOpenAIError(err);
		}
	}
}
