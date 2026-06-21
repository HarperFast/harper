/**
 * Harper-HTTP adapter for the MCP transport core (application port, #614).
 *
 * Maps Harper's HTTP handler signature `(request, nextHandler) => { status,
 * headers, body }` to/from the transport's normalized Request/Response.
 * Auth runs upstream via `{ after: 'authentication' }` on the registration,
 * so `request.user` is already populated when this handler fires.
 *
 * SSE responses (reserved for #619) are returned as `{ body: iterable,
 * headers: { 'content-type': 'text/event-stream' } }`. Harper's serializer
 * at `server/serverHelpers/contentTypes.ts:128-162` picks the SSE writer
 * automatically and pipes the iterable to the wire.
 */
import { handleMcpRequest, type McpProfile, type NormRequest, type NormResponse } from '../transport.ts';
import { toSseStream, type SseFrameSource } from '../sse.ts';

/**
 * The inbound body as Harper hands it to a custom HTTP handler: a Node-stream
 * event emitter (`server/serverHelpers/Request.ts` `RequestBody`). Only the
 * event API is guaranteed — `RequestBody` does not implement
 * `Symbol.asyncIterator`, so we must read via `.on()` here (see `readBody`).
 */
interface BodyStream {
	on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
	on(event: 'error', listener: (err: Error) => void): unknown;
	on(event: 'close', listener: () => void): unknown;
}

interface HarperHttpRequest {
	method: string;
	headers: Iterable<[string, string | string[]]> & { get?: (name: string) => string | undefined };
	body?: BodyStream;
	/**
	 * Full user object as Harper's auth pipeline attaches it (includes role +
	 * permission tree). Transport reads `username` for session binding and
	 * forwards the full object as `userObject` for resource/tool RBAC.
	 */
	user?: { username?: string; role?: unknown };
	isWebSocket?: boolean;
}

interface HarperHttpResponse {
	status: number;
	headers: Record<string, string>;
	body?: unknown;
}

export function createHarperHttpHandler(profile: McpProfile) {
	return async function mcpHarperHttpHandler(
		request: HarperHttpRequest,
		nextHandler: (req: HarperHttpRequest) => unknown
	): Promise<HarperHttpResponse | unknown> {
		// WebSocket upgrades aren't ours — let the next handler take it.
		if (request.isWebSocket) return nextHandler(request);

		const norm: NormRequest = {
			method: request.method,
			headers: normalizeHeaders(request.headers),
			body: await readBody(request.body),
			user: request.user?.username ?? '',
			userObject: request.user as NormRequest['userObject'],
			profile,
		};

		const res = await handleMcpRequest(norm);
		return toHarperResponse(res);
	};
}

function normalizeHeaders(headers: HarperHttpRequest['headers']): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [name, value] of headers) {
		out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
	}
	return out;
}

/**
 * Read the full request body to a UTF-8 string via the Node stream event API.
 *
 * Harper wraps the inbound body in a `RequestBody` (server/serverHelpers/
 * Request.ts) that exposes `.on()`/`.pipe()` — the same contract every other
 * inbound-body consumer in Harper reads through (e.g. the content-type
 * deserializers at `server/serverHelpers/contentTypes.ts`). Harper's
 * `RequestBody` historically exposed only `.on()`/`.pipe()`, so a `for await`
 * over it threw `TypeError: body is not async iterable` and 500'd every request
 * (#1317). This PR also adds `Symbol.asyncIterator` to `RequestBody`, but we
 * still read via the event API here because it's the canonical, always-present
 * contract that every other inbound-body consumer uses — async iteration isn't
 * guaranteed on every body wrapper.
 */
function readBody(body: BodyStream | undefined): Promise<string> {
	if (!body) return Promise.resolve('');
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let settled = false;
		body.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
		body.on('end', () => {
			settled = true;
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		body.on('error', (err) => {
			settled = true;
			reject(err);
		});
		// On a premature client disconnect `IncomingMessage` emits 'close' without
		// 'end' or 'error', so without this the promise would hang forever and the
		// buffered chunks leak. On normal completion 'close' fires after 'end',
		// where `settled` is already true, so this is a no-op.
		body.on('close', () => {
			if (!settled) reject(Object.assign(new Error('request aborted'), { code: 'ECONNRESET' }));
		});
	});
}

function toHarperResponse(res: NormResponse): HarperHttpResponse {
	const headers = { ...res.headers };

	if (res.jsonBody !== undefined) {
		if (!headers['Content-Type'] && !headers['content-type']) {
			headers['Content-Type'] = 'application/json';
		}
		return {
			status: res.status,
			headers,
			body: JSON.stringify(res.jsonBody),
		};
	}

	if (res.sseIterable !== undefined) {
		if (!headers['Content-Type'] && !headers['content-type']) {
			headers['Content-Type'] = 'text/event-stream';
		}
		if (!headers['Cache-Control'] && !headers['cache-control']) {
			headers['Cache-Control'] = 'no-store';
		}
		// Frame the raw IterableEventQueue into a primed SSE Readable. Harper's
		// HTTP server pipes a Readable directly but (a) won't serialize the
		// queue's objects to SSE text and (b) defers header transmission until the
		// first body byte — so without the primed comment the GET hangs with
		// headers unsent until a push fires. See `sse.ts`.
		return {
			status: res.status,
			headers,
			body: toSseStream(res.sseIterable as unknown as SseFrameSource),
		};
	}

	return { status: res.status, headers };
}
