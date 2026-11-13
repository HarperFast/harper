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
import {
	credentialRejectionResponse,
	getDeferredCredentialRejection,
	ownAuthenticationChallenge,
	settleDeferredCredentialRejection,
} from '../../../security/deferredAuthentication.ts';
import harperLogger from '../../../utility/logging/harper_logger.ts';
import { getBearerValidators } from '../../../server/Server.ts';
import type { Headers } from '../../../server/serverHelpers/Headers.ts';
import { toSseStream, type SseFrameSource } from '../sse.ts';
import { getMaxRequestBodySize } from '../../../server/serverHelpers/contentTypes.ts';
import { ClientError } from '../../../utility/errors/hdbError.ts';

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
	/** Client socket IP (Harper Request getter; present on Node and Bun). */
	ip?: string;
	/** 'http' | 'https' (Harper Request getter; honors the PROXY v2 TLS flag on the UDS mirror). */
	protocol?: string;
	/** Host header / HTTP/2 :authority (Harper Request getter). */
	host?: string;
}

interface HarperHttpResponse {
	status: number;
	headers: Record<string, string>;
	body?: unknown;
}

export interface McpAuthentication {
	required: boolean;
	resourceMetadata?: string;
}

const AUTHENTICATION_OPTIONAL: McpAuthentication = Object.freeze({ required: false });

export function createHarperHttpHandler(
	profile: McpProfile,
	authentication: McpAuthentication = AUTHENTICATION_OPTIONAL
) {
	const requirePrincipal = authentication.required === true;
	return async function mcpHarperHttpHandler(
		request: HarperHttpRequest,
		nextHandler: (req: HarperHttpRequest) => unknown
	): Promise<HarperHttpResponse | unknown> {
		// WebSocket upgrades aren't ours — let the next handler take it.
		if (request.isWebSocket) return nextHandler(request);

		const settledCredentialRejection = settleDeferredCredentialRejection(request);
		if (settledCredentialRejection) {
			discardBody(request.body);
			if (getDeferredCredentialRejection(request).strategy === 'Bearer') {
				nameResourceMetadata(settledCredentialRejection.headers, request, authentication, true);
			}
			return settledCredentialRejection;
		}
		const username = request.user?.username ?? '';
		if (requirePrincipal && !username && request.method !== 'OPTIONS') {
			discardBody(request.body);
			const response = credentialRejectionResponse(request, 401, 'Authentication required', 'Bearer', false);
			nameResourceMetadata(response.headers, request, authentication, false);
			return ownAuthenticationChallenge(response);
		}

		const headers = normalizeHeaders(request.headers);
		let body: string;
		try {
			body = await readBody(request.body, getMaxRequestBodySize(), headers['content-length']);
		} catch (error) {
			if (error instanceof ClientError && error.statusCode === 413) {
				return {
					status: 413,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ error: 'payload_too_large', message: error.message }),
				};
			}
			throw error;
		}

		// uWS passes X-Forwarded-Proto through verbatim (e.g. `ws`), and only an http(s) base
		// makes valid harper+rest:// and OpenAPI URLs; anything else falls back to the config guess.
		const protocol = request.protocol === 'http' || request.protocol === 'https' ? request.protocol : undefined;
		const norm: NormRequest = {
			method: request.method,
			headers,
			body,
			user: username,
			userObject: request.user as NormRequest['userObject'],
			profile,
			clientIp: request.ip,
			baseUrl: protocol && request.host ? `${protocol}://${request.host}` : undefined,
		};

		const res = await handleMcpRequest(norm);
		return toHarperResponse(res);
	};
}

let warnedNoResourceMetadata = false;

/**
 * Names the RFC 9728 protected-resource metadata in a 401's Bearer challenge. The configured URL is authoritative;
 * otherwise the active Bearer validators' declarations count only when they all name the same URL, because
 * registrations are worker-global and load in no fixed order, so a disagreement could send a client to an
 * authorization server that does not protect this mount. Read per 401: a validator's plugin can load after this
 * mount and unregister on reload.
 */
function nameResourceMetadata(
	headers: Headers,
	request: HarperHttpRequest,
	authentication: McpAuthentication,
	credentialRejected: boolean
): void {
	const resourceMetadata = authentication.resourceMetadata ?? declaredResourceMetadata();
	if (!resourceMetadata && authentication.required && !warnedNoResourceMetadata) {
		warnedNoResourceMetadata = true;
		harperLogger.warn(
			'MCP application profile requires authentication but has no single protected-resource metadata URL: set ' +
				'mcp.application.authentication.resourceMetadata, or have every Bearer validator that declares a challenge name the same URL'
		);
	}
	if (resourceMetadata) {
		headers.set(
			'WWW-Authenticate',
			credentialRejected
				? `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"`
				: `Bearer resource_metadata="${resourceMetadata}"`
		);
	} else if (!authentication.required) {
		return;
	}
	// not CORS-safelisted, and a browser client has to read it to find the authorization server
	if (request.headers.get?.('origin')) headers.append('Access-Control-Expose-Headers', 'WWW-Authenticate', true);
}

function declaredResourceMetadata(): string | undefined {
	let declared: string | undefined;
	for (const entry of getBearerValidators()) {
		if (!entry.active || !entry.challenge) continue;
		if (declared === undefined) declared = entry.challenge.resourceMetadata;
		else if (declared !== entry.challenge.resourceMetadata) return undefined;
	}
	return declared;
}

function ignore(): void {}

/**
 * Lets an unread body flow and be dropped once the request is answered without it. A uWS body is a push stream
 * with no backpressure, so unread chunks of a long upload would otherwise queue in memory until it ends.
 */
function discardBody(body: BodyStream | undefined): void {
	if (!body) return;
	body.on('error', ignore);
	body.on('data', ignore);
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
function readBody(body: BodyStream | undefined, maxBytes: number, declaredLength?: string): Promise<string> {
	if (!body) return Promise.resolve('');
	return new Promise((resolve, reject) => {
		let chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		// Listeners are attached even for a declared oversize so the stream flows and discards: the uWS
		// body is a paused Readable that otherwise buffers the whole upload.
		if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
			settled = true;
			reject(bodyTooLarge(maxBytes));
		}
		body.on('data', (chunk) => {
			if (settled) return;
			const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
			size += buffer.length;
			if (size > maxBytes) {
				settled = true;
				chunks = [];
				reject(bodyTooLarge(maxBytes));
				return;
			}
			chunks.push(buffer);
		});
		body.on('end', () => {
			if (settled) return;
			settled = true;
			const text = Buffer.concat(chunks).toString('utf8');
			chunks = [];
			resolve(text);
		});
		body.on('error', (err) => {
			if (settled) return;
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

function bodyTooLarge(maxBytes: number): ClientError {
	return new ClientError(`Request body too large, maximum size is ${maxBytes} bytes`, 413);
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
