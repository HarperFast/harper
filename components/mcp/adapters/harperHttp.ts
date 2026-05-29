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

interface HarperHttpRequest {
	method: string;
	headers: Iterable<[string, string | string[]]> & { get?: (name: string) => string | undefined };
	body?: AsyncIterable<Buffer | string>;
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

async function readBody(body: AsyncIterable<Buffer | string> | undefined): Promise<string> {
	if (!body) return '';
	const chunks: Buffer[] = [];
	for await (const chunk of body) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
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
		return {
			status: res.status,
			headers,
			body: res.sseIterable,
		};
	}

	return { status: res.status, headers };
}
