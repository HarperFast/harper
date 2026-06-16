/**
 * Fastify adapter for the MCP transport core (operations port, #614).
 *
 * Maps Fastify's `(request, reply)` ↔ the transport's normalized
 * Request/Response shape. The route is registered with the
 * `authAndEnsureUserOnRequest` preValidation hook, so the authenticated
 * user lands on `request.hdb_user` before this handler runs.
 *
 * The MCP route installs a raw-body content-type parser (see
 * `registerMcpProfile`), so `request.body` arrives as the unparsed JSON
 * string and the transport's `parseMessage` is the single JSON-RPC parse
 * point for both profiles. This keeps the core framework-agnostic and lets a
 * malformed body surface as a JSON-RPC `-32700` frame rather than Fastify's
 * pre-handler 400 (#1317 S1).
 */
import { handleMcpRequest, type McpProfile, type NormRequest } from '../transport.ts';

interface FastifyLikeRequest {
	method: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
	/**
	 * `authAndEnsureUserOnRequest` sets the full user (incl. role + permission
	 * tree) on `req.hdb_user`. Used for session binding (`username`) and
	 * forwarded as the transport's `userObject` for resource/tool RBAC.
	 */
	hdb_user?: { username?: string; role?: unknown } | null;
}

interface FastifyLikeReply {
	code: (status: number) => FastifyLikeReply;
	header: (name: string, value: string) => FastifyLikeReply;
	send: (body?: unknown) => unknown;
}

export function createFastifyHandler(profile: McpProfile) {
	return async function mcpFastifyHandler(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<void> {
		const norm: NormRequest = {
			method: request.method,
			headers: normalizeHeaders(request.headers),
			// The MCP route installs a raw-body content-type parser (see
			// `registerMcpProfile`), so `request.body` is the unparsed JSON
			// string. The transport's `parseMessage` is the single JSON-RPC
			// parse point — a malformed body surfaces as a -32700 frame rather
			// than Fastify's pre-handler 400 (#1317 S1).
			body: request.body,
			user: request.hdb_user?.username ?? '',
			userObject: (request.hdb_user ?? undefined) as NormRequest['userObject'],
			profile,
		};

		const res = await handleMcpRequest(norm);

		reply.code(res.status);
		for (const [name, value] of Object.entries(res.headers)) {
			reply.header(name, value);
		}

		if (res.jsonBody !== undefined) {
			if (!res.headers['Content-Type'] && !res.headers['content-type']) {
				reply.header('Content-Type', 'application/json');
			}
			// Send a pre-serialized string (mirrors the Harper-HTTP adapter), NOT
			// the raw object. The MCP routes live in an encapsulated child plugin
			// (see registerMcpProfile), where Fastify's default object serializer
			// isn't applied and Harper's content-negotiation serializer is skipped
			// once Content-Type is set — so an object payload reaches @fastify/compress
			// unserialized and throws FST_ERR_REP_INVALID_PAYLOAD (#1317). Serializing
			// here keeps the transport the single source of the JSON-RPC wire bytes.
			reply.send(JSON.stringify(res.jsonBody));
			return;
		}

		if (res.sseIterable !== undefined) {
			// Reserved for #619 (server-push GET stream). Fastify will iterate
			// the async iterable and write SSE frames via the contentTypes
			// serializer at `server/serverHelpers/contentTypes.ts:128-162`.
			if (!res.headers['Content-Type'] && !res.headers['content-type']) {
				reply.header('Content-Type', 'text/event-stream');
			}
			reply.header('Cache-Control', 'no-store');
			reply.send(res.sseIterable);
			return;
		}

		// 202/204/4xx with empty body.
		reply.send();
	};
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
	}
	return out;
}
