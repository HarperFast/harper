/**
 * Fastify adapter for the MCP transport core (operations port, #614).
 *
 * Maps Fastify's `(request, reply)` ↔ the transport's normalized
 * Request/Response shape. The route is registered with the
 * `authAndEnsureUserOnRequest` preValidation hook, so the authenticated
 * user lands on `request.hdb_user` before this handler runs.
 *
 * Fastify auto-parses the JSON request body into an object; the transport
 * core's `parseMessage` accepts both strings and parsed values, so we pass it
 * through directly. (A malformed operations-profile body is therefore rejected
 * by Fastify with an HTTP 400 before this handler runs — spec-permitted for the
 * Streamable HTTP transport; the application profile reads the raw body and
 * returns a JSON-RPC `-32700` frame instead. See #1317 S1.)
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
			// Fastify has already parsed the JSON body into an object; the
			// transport core's parseMessage accepts both strings and parsed
			// values, so pass it through directly.
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
			reply.send(res.jsonBody);
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
