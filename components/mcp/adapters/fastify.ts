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
import type { ServerResponse } from 'node:http';
import { handleMcpRequest, type McpProfile, type NormRequest } from '../transport.ts';
import { toSseStream, type SseFrameSource } from '../sse.ts';

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
	/** Headers accumulated so far (e.g. CORS headers set by `@fastify/cors`). */
	getHeaders: () => Record<string, number | string | string[] | undefined>;
	/** Take ownership of the response; Fastify will not send it. Used for SSE. */
	hijack: () => void;
	/** The underlying Node response, written to directly for SSE streaming. */
	raw: ServerResponse;
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

		if (res.sseIterable !== undefined) {
			// Server-push GET stream (#619). `reply.send(stream)` does not reliably
			// stream SSE on the operations Fastify — it pulls one chunk then stalls,
			// so frames pushed onto the queue are never flushed. Take over the raw
			// socket instead: write + flush headers immediately, then pipe the framed
			// SSE Readable directly. `hijack()` stops Fastify from touching the
			// response. (The Harper-HTTP adapter pipes a stream fine, so this divergence
			// is Fastify-specific.)
			//
			// Tradeoff: hijack bypasses Fastify's onSend/onResponse hooks for this
			// request, so per-request completion logging/metrics don't fire until the
			// long-lived stream closes. Acceptable for an SSE channel (auth + the MCP
			// handler already ran above); this is the standard Fastify SSE pattern.
			const raw = reply.raw;
			// Start from the headers Fastify hooks already accumulated (e.g.
			// `@fastify/cors` adds Access-Control-Allow-Origin / Vary on the reply
			// before this handler runs). Hijacking bypasses Fastify's send path, so
			// these must be copied onto the raw response or a CORS-allowed browser
			// client gets its SSE GET blocked.
			const sseHeaders: Record<string, number | string | string[] | undefined> = { ...reply.getHeaders() };
			for (const [name, value] of Object.entries(res.headers)) sseHeaders[name] = value;
			sseHeaders['Content-Type'] = res.headers['Content-Type'] ?? res.headers['content-type'] ?? 'text/event-stream';
			sseHeaders['Cache-Control'] = res.headers['Cache-Control'] ?? res.headers['cache-control'] ?? 'no-store';
			reply.hijack();
			raw.writeHead(res.status, sseHeaders);
			raw.flushHeaders?.();
			const stream = toSseStream(res.sseIterable as unknown as SseFrameSource);
			// An unhandled `'error'` on either side of the pipe would crash the worker.
			// `pipe()` does not forward errors in either direction, so guard both: a
			// source error destroys the raw socket, and a socket error (e.g. the client
			// resetting the connection mid-write) destroys the stream.
			stream.on('error', () => raw.destroy());
			raw.on('error', () => stream.destroy());
			stream.pipe(raw);
			raw.on('close', () => stream.destroy());
			return;
		}

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
