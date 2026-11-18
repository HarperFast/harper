/** The SEP-2127 server card at `<mountPath>/server-card`; why its route runs no authentication: `DESIGN.md`. */
import { createHash } from 'node:crypto';
import { applicationServerCard, type CompleteServerCardInfo } from './applicationInfo.ts';
import { SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './lifecycle.ts';
import { evaluatePreconditions } from '../../server/serverHelpers/preconditions.ts';
import { normalizeUrlPath } from '../../server/middlewareChain.ts';

const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET',
	// beyond the SEP's list, the headers an MCP client in a browser attaches anyway, so its preflight succeeds
	'Access-Control-Allow-Headers': 'Content-Type, If-None-Match, Authorization, MCP-Protocol-Version',
	'Access-Control-Expose-Headers': 'ETag',
};

interface CardRequest {
	method: string;
	pathname?: string;
	originalPathname?: string;
	protocol?: string;
	host?: string;
	isWebSocket?: boolean;
	headers: { get?: (name: string) => string | undefined };
	body?: { on(event: string, listener: (...args: unknown[]) => void): unknown };
}

interface CardResponse {
	status: number;
	headers: Record<string, string>;
	body?: string;
}

const CARD_SUFFIX = '/server-card';

// Left relative when `mountPath` is, so `Scope` resolves the card's route exactly as it resolves the mount's.
export function serverCardUrlPath(mountPath: string): string {
	return `${mountPath.replace(/\/+$/, '')}${CARD_SUFFIX}`;
}

export function createServerCardHandler(mountPath: string) {
	const fallbackEndpointPath = normalizeUrlPath(mountPath) ?? '/';
	// The card without `remotes` is serialized and hashed once per card, and the last full response is kept. Without
	// a configured `url` the remote comes from the requested authority, which the client chooses, so a new authority
	// costs only the `remotes` suffix and the hash of a short string.
	let cached:
		{ generation: number; base: string; baseHash: string; remote?: string; etag?: string; body?: string } | undefined;

	return function mcpServerCardHandler(
		request: CardRequest,
		nextHandler: (request: CardRequest) => unknown
	): CardResponse | unknown {
		if (request.isWebSocket || (request.pathname !== undefined && request.pathname !== '/')) {
			return nextHandler(request);
		}
		if (request.method === 'OPTIONS') return { status: 204, headers: { ...CORS_HEADERS } };
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			request.body?.on('error', ignore);
			request.body?.on('data', ignore);
			return { status: 405, headers: { ...CORS_HEADERS, Allow: 'GET, HEAD, OPTIONS' } };
		}
		const { card, generation } = applicationServerCard();
		if (!card) return { status: 404, headers: { ...CORS_HEADERS } };

		if (!cached || cached.generation !== generation) {
			const base = JSON.stringify(cardDocument(card));
			cached = { generation, base, baseHash: createHash('sha256').update(base).digest('base64url') };
		}
		const remote = card.url ?? requestedEndpoint(request, fallbackEndpointPath);
		if (cached.etag === undefined || cached.remote !== remote) {
			const remotes = remote
				? JSON.stringify([
						{ type: 'streamable-http', url: remote, supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS },
					])
				: undefined;
			cached.remote = remote;
			cached.etag = `"${createHash('sha256')
				.update(cached.baseHash)
				.update(remotes ?? '')
				.digest('base64url')}"`;
			cached.body = remotes ? `${cached.base.slice(0, -1)},"remotes":${remotes}}` : cached.base;
		}
		const { etag, body } = cached;
		const headers: Record<string, string> = {
			...CORS_HEADERS,
			'Content-Type': SERVER_CARD_MEDIA_TYPE,
			'Cache-Control': 'public, max-age=3600',
			'ETag': etag,
		};
		if (!card.url) headers.Vary = 'Host, X-Forwarded-Proto';

		let precondition: number | undefined;
		try {
			precondition = evaluatePreconditions(
				{ 'if-none-match': request.headers.get?.('if-none-match') },
				request.method,
				true,
				etag
			);
		} catch {
			return { status: 400, headers: { ...CORS_HEADERS } };
		}
		if (precondition === 304) return { status: 304, headers };
		return request.method === 'HEAD' ? { status: 200, headers } : { status: 200, headers, body };
	};
}

function ignore(): void {}

function requestedEndpoint(request: CardRequest, fallbackEndpointPath: string): string | undefined {
	const protocol = request.protocol === 'http' || request.protocol === 'https' ? request.protocol : undefined;
	if (!protocol || !request.host) return undefined;
	const original = request.originalPathname?.replace(/\/+$/, '');
	const endpointPath = original?.endsWith(CARD_SUFFIX)
		? original.slice(0, -CARD_SUFFIX.length) || '/'
		: fallbackEndpointPath;
	return `${protocol}://${request.host}${endpointPath}`;
}

function cardDocument(card: CompleteServerCardInfo): Record<string, unknown> {
	return {
		$schema: SERVER_CARD_SCHEMA,
		name: card.name,
		...(card.title ? { title: card.title } : {}),
		description: card.description,
		version: card.version ?? SERVER_INFO.version,
		...(card.websiteUrl ? { websiteUrl: card.websiteUrl } : {}),
		...(card.icons ? { icons: card.icons } : {}),
	};
}
