/**
 * MCP Streamable HTTP transport core — framework-agnostic.
 *
 * Takes a normalized request (method, headers, body, authenticated user,
 * profile) and returns a normalized response (status, headers, optional
 * JSON body or SSE iterable). The Fastify adapter (operations port) and
 * Harper-HTTP adapter (application port) each translate to/from this shape.
 *
 * All spec MUSTs from MCP §basic/transports (rev 2025-06-18) live here:
 *   - Origin validation
 *   - Mcp-Session-Id lifecycle
 *   - MCP-Protocol-Version enforcement
 *   - HTTP status code mapping (200/202/400/403/404/405)
 *   - JSON-RPC envelope parsing + standard error codes
 */
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import {
	ERROR_CODES,
	buildError,
	buildSuccess,
	isClientFireAndForget,
	parseMessage,
	type JsonRpcId,
	type JsonRpcMessage,
} from './jsonrpc.ts';
import {
	handleInitialize,
	handleInitialized,
	PROTOCOL_VERSION_BACKCOMPAT,
	SUPPORTED_PROTOCOL_VERSIONS,
} from './lifecycle.ts';
import { emitAuditEntry } from './audit.ts';
import { emitMcpLogToSession, isValidMcpLogLevel, setSessionLogLevel } from './logging.ts';
import { decodeCursor } from './pagination.ts';
import { seedSessionSnapshot } from './listChanged.ts';
import { tryAdmit } from './rateLimit.ts';
import { deleteSession, loadSession, saveSession, touchSession, type McpSessionRecord } from './session.ts';
import { listResources, listResourceTemplates, readResource } from './resources.ts';
import { registerSession, touchRegisteredSession } from './sessionRegistry.ts';
import { getTool, listTools, type AuthedUser, type ToolResult } from './toolRegistry.ts';

export type McpProfile = 'operations' | 'application';

export interface NormRequest {
	method: string;
	/** Lowercased header name → value. Adapters normalize before calling. */
	headers: Record<string, string | undefined>;
	/**
	 * The request body for JSON-RPC parsing. The two adapters deliver different
	 * shapes: the Harper-HTTP adapter passes the raw unparsed string (it reads the
	 * stream itself), while the Fastify adapter passes Fastify's already-parsed JS
	 * object (the S1 raw-body content-type parser was reverted because it stopped
	 * the MCP route from inheriting Harper's response serializers). Typed
	 * `string | unknown` because `parseMessage` handles both — it parses a string
	 * and passes a non-string (already-parsed) value through.
	 */
	body: string | unknown;
	/** Authenticated username from upstream auth pipeline. Used for session binding. */
	user: string;
	/**
	 * permission tree. Required for tools and resources RBAC enforcement.
	 * Adapters populate from `request.hdb_user` (Fastify) / `request.user`
	 * (Harper-HTTP). Tools/resources that gate on role return no matches
	 * when the object is absent.
	 */
	userObject?: AuthedUser;
	profile: McpProfile;
}

export interface NormResponse {
	status: number;
	headers: Record<string, string>;
	jsonBody?: unknown;
	sseIterable?: AsyncIterable<unknown>;
}

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';
const ORIGIN_HEADER = 'origin';
const ACCEPT_HEADER = 'accept';

/**
 * Main entry. Adapters call this and map the returned shape to their
 * native wire format. Any unhandled error from a downstream call (e.g., a
 * RocksDB I/O failure on the session table) is caught and reported as a
 * spec-conformant JSON-RPC Internal Error so clients see a structured
 * error envelope instead of an opaque framework 500.
 */
export async function handleMcpRequest(request: NormRequest): Promise<NormResponse> {
	try {
		if (!isOriginAllowed(request)) {
			return jsonResponse(403, { error: 'origin_not_allowed' });
		}
		if (request.method === 'POST') {
			// POST always yields a single JSON object in v1 (no per-request SSE).
			if (!acceptsMediaType(request.headers[ACCEPT_HEADER], 'application/json')) {
				return notAcceptableResponse('application/json');
			}
			return await handlePost(request);
		}
		if (request.method === 'GET') {
			// GET opens the server-push SSE channel.
			if (!acceptsMediaType(request.headers[ACCEPT_HEADER], 'text/event-stream')) {
				return notAcceptableResponse('text/event-stream');
			}
			return await handleGet(request);
		}
		if (request.method === 'DELETE') return await handleDelete(request);
		return { status: 405, headers: { Allow: currentlyAllowedMethods() } };
	} catch (err) {
		harperLogger.error(`MCP transport internal error: ${(err as Error).stack ?? (err as Error).message}`);
		return jsonRpcErrorResponse(500, null, ERROR_CODES.INTERNAL_ERROR, 'internal error');
	}
}

/**
 * Per-profile Origin validation (the MCP §transports Security Warning: servers
 * MUST validate Origin to defend against DNS rebinding). We satisfy the MUST by
 * tying Origin enforcement to Harper's existing CORS config (parity with
 * security/auth.ts:65) — a disallowed Origin gets a 403:
 *   - CORS disabled in config ⇒ accept any Origin (don't gate on it at all).
 *   - CORS enabled with empty/unset allow-list ⇒ accept any.
 *   - CORS enabled with allow-list ⇒ match exactly OR honor a `'*'` wildcard.
 *   - Missing Origin header ⇒ accept (curl, server-to-server, no DNS-rebinding
 *     vector exists when the request isn't browser-initiated).
 *
 * SECURE DEFAULT (#1317 S4): any deployment exposing MCP to browsers beyond
 * loopback should enable CORS with an explicit allow-list (`http.cors` +
 * `http.corsAccessList` for the application profile; `operationsApi.network.*`
 * for operations) — that is what turns on DNS-rebinding protection. The default
 * (CORS off) is appropriate only for localhost-only / non-browser clients.
 */
function isOriginAllowed(request: NormRequest): boolean {
	const origin = request.headers[ORIGIN_HEADER];
	if (!origin) return true;
	const corsEnabled =
		request.profile === 'operations'
			? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS)
			: env.get(CONFIG_PARAMS.HTTP_CORS);
	if (!corsEnabled) return true;
	const list =
		request.profile === 'operations'
			? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST)
			: env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST);
	if (!Array.isArray(list) || list.length === 0) return true;
	return list.includes(origin) || list.includes('*');
}

/**
 * Content negotiation against the media type this endpoint produces.
 *
 * The MCP Streamable HTTP spec makes the `Accept` header a CLIENT
 * requirement (POST clients MUST accept `application/json` + `text/event-stream`;
 * GET clients MUST accept `text/event-stream`) and leaves server-side
 * enforcement as a MAY. We honor explicit negotiation: a client that sends an
 * `Accept` excluding both the produced type and a matching wildcard gets a 406.
 * An ABSENT `Accept` is treated as "accept anything" (allowed) — many
 * non-browser MCP clients omit it, and HTTP treats a missing `Accept` as any.
 */
function acceptsMediaType(acceptHeader: string | undefined, produced: string): boolean {
	if (!acceptHeader) return true;
	const topLevelType = produced.split('/')[0];
	const typeWildcard = `${topLevelType}/*`;
	return acceptHeader
		.split(',')
		.map((part) => part.split(';')[0].trim().toLowerCase())
		.some((mediaType) => mediaType === produced || mediaType === '*/*' || mediaType === typeWildcard);
}

function notAcceptableResponse(produced: string): NormResponse {
	return {
		status: 406,
		headers: { 'Content-Type': 'application/json' },
		jsonBody: {
			error: 'not_acceptable',
			message: `MCP endpoint produces ${produced}; set the Accept header accordingly`,
		},
	};
}

async function handlePost(request: NormRequest): Promise<NormResponse> {
	const parsed = parseMessage(request.body);
	if (parsed.ok !== true) {
		// Explicit cast: tsconfig has `strict: false`, so TS can't narrow
		// discriminated unions from `parsed.ok !== true`. Without the cast it
		// errors TS2339 on `parsed.code` / `parsed.reason`. (Verified during
		// review; the alternative — enabling strict mode — is repo-wide.)
		const fail = parsed as { ok: false; code: number; reason: string };
		return jsonRpcErrorResponse(400, null, fail.code, fail.reason);
	}
	const message = parsed.message;
	const messageId: JsonRpcId = 'id' in message ? message.id : null;
	const method = 'method' in message ? message.method : undefined;

	if (method === 'initialize') return dispatchInitialize(request, message, messageId);

	const sessionId = request.headers[SESSION_HEADER];
	if (!sessionId) {
		return jsonRpcErrorResponse(400, messageId, ERROR_CODES.INVALID_REQUEST, 'missing Mcp-Session-Id header');
	}
	let session = await loadSession(sessionId);
	if (!session) {
		// Terminated, expired, or never existed. Spec mandates 404 so the
		// client knows to drop the id and re-initialize.
		return { status: 404, headers: {} };
	}

	const protocolCheck = validateProtocolHeader(request.headers[PROTOCOL_HEADER], session.protocolVersion);
	if (protocolCheck.ok !== true) {
		const fail = protocolCheck as { ok: false; reason: string };
		return jsonRpcErrorResponse(400, messageId, ERROR_CODES.INVALID_REQUEST, fail.reason);
	}

	if (session.user !== request.user) {
		// Defense-in-depth against session-id leaks: id was created for a
		// different user. Mask the session id in logs — even though it's not
		// a credential in MCP, leaking it to an attacker with log access would
		// enable session-jacking once paired with a valid token.
		harperLogger.warn(
			`MCP session ${maskSessionId(sessionId)} presented by user ${request.user} but bound to ${session.user}`
		);
		return { status: 403, headers: {} };
	}

	// Sliding-window idle reset. Awaited (not fire-and-forget) so a concurrent
	// DELETE that arrives mid-request can't be resurrected by a late put. Adopt
	// the touched copy (fresh `lastActivity`) so any later save in this request
	// — `handleInitialized`, `dispatchSetLevel` — persists the current activity
	// time instead of rolling it back to the load-time value.
	session = await touchSession(session);

	// Fire-and-forget frames (notifications + client responses) always 202.
	if (isClientFireAndForget(message)) {
		if (method === 'notifications/initialized') {
			await handleInitialized(session);
		}
		return { status: 202, headers: {} };
	}

	// Request with id + method (and not 'initialize'): route to the known
	// method handlers below. Anything we don't handle yet returns a
	// spec-conformant Method-not-found error.
	if (method === 'tools/list') return dispatchToolsList(request, session, message, messageId);
	if (method === 'tools/call') return dispatchToolsCall(request, session, message, messageId);
	if (method === 'resources/list') return dispatchResourcesList(request, message, messageId);
	if (method === 'resources/templates/list') return dispatchResourceTemplatesList(request, messageId);
	if (method === 'resources/read') return dispatchResourcesRead(request, message, messageId);
	if (method === 'logging/setLevel') return dispatchSetLevel(session, message, messageId);
	// `ping` (base-protocol liveness) → empty result. Routed here, after session
	// validation, so a stale/expired/wrong-user session surfaces the normal
	// 404/403 rather than being masked by an unconditional success. A ping sent
	// as a notification is handled by the fire-and-forget 202 path above.
	if (method === 'ping') return jsonResponse(200, buildSuccess(messageId, {}));
	return jsonResponse(
		200,
		buildError(messageId, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method ?? '<missing>'}`)
	);
}

async function dispatchInitialize(
	request: NormRequest,
	message: JsonRpcMessage,
	messageId: JsonRpcId
): Promise<NormResponse> {
	const params = 'params' in message ? (message.params as { protocolVersion?: unknown } | undefined) : undefined;
	const outcome = await handleInitialize(params, request.user);
	if (outcome.ok !== true) {
		const fail = outcome as { ok: false; reason: string; supportedVersions: readonly string[] };
		return jsonRpcErrorResponse(400, messageId, ERROR_CODES.INVALID_PARAMS, fail.reason, {
			supportedVersions: fail.supportedVersions,
		});
	}
	return {
		status: 200,
		headers: { 'Mcp-Session-Id': outcome.session.id },
		jsonBody: buildSuccess(messageId, outcome.result),
	};
}

/**
 * `logging/setLevel` — record the session's minimum severity for
 * `notifications/message`. Returns an empty result on success. Backs the
 * advertised `logging` capability (previously advertised but unimplemented).
 */
async function dispatchSetLevel(
	session: McpSessionRecord,
	message: JsonRpcMessage,
	messageId: JsonRpcId
): Promise<NormResponse> {
	const params = 'params' in message ? (message.params as { level?: unknown } | undefined) : undefined;
	const level = params?.level;
	if (!isValidMcpLogLevel(level)) {
		return jsonResponse(
			200,
			buildError(
				messageId,
				ERROR_CODES.INVALID_PARAMS,
				'logging/setLevel requires params.level to be an RFC 5424 level'
			)
		);
	}
	// Persist on the durable session record (survives an SSE reconnect, expires
	// with the session TTL) AND apply to the live SSE record if the stream is
	// already open so it takes effect immediately.
	//
	// Per-worker caveat (v1): if this POST landed on a different worker than the
	// one holding the session's GET/SSE stream, only the durable record is
	// updated now; the SSE-owning worker picks the level up the next time it
	// seeds from the record (reconnect). This matches the existing per-worker
	// limitation of the whole MCP server-push channel — listChanged's
	// tools/resources list_changed notifications only reach sessions registered
	// on the worker where the change fires. Cross-worker push is a separate,
	// subsystem-wide design item (tracked in the MCP design-doc issue).
	session.logLevel = level;
	await saveSession(session);
	setSessionLogLevel(session.id, level);
	return jsonResponse(200, buildSuccess(messageId, {}));
}

async function handleGet(request: NormRequest): Promise<NormResponse> {
	// Server-push channel for `notifications/{tools,resources}/list_changed`
	// (#619). The client opens GET /mcp after `initialize`; we keep the SSE
	// connection alive for the lifetime of the session and push frames as
	// role/schema events fire. Per the spec, idle sessions get HTTP 404 on
	// the next POST after eviction — the GET stream itself just closes when
	// the session record is deleted (via unregisterSession).
	const sessionId = request.headers[SESSION_HEADER];
	if (!sessionId) {
		return { status: 400, headers: {} };
	}
	const session = await loadSession(sessionId);
	if (!session) {
		return { status: 404, headers: {} };
	}
	if (session.user !== request.user) {
		return { status: 403, headers: {} };
	}
	const protocolCheck = validateProtocolHeader(request.headers[PROTOCOL_HEADER], session.protocolVersion);
	if (protocolCheck.ok !== true) {
		const fail = protocolCheck as { ok: false; reason: string };
		return {
			status: 400,
			headers: {},
			jsonBody: { error: { message: fail.reason } },
		};
	}
	const record = registerSession(sessionId, request.profile, effectiveUser(request));
	// Seed the live record with any previously-set logging level so a reconnect
	// (or a setLevel that preceded this stream) keeps delivering notifications/message.
	// (A fresh record's logLevel is already undefined, so a direct assign is safe.)
	record.logLevel = session.logLevel;
	seedSessionSnapshot(sessionId);
	return {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
		sseIterable: record.queue,
	};
}

const DEFAULT_MAX_TOOLS = 200;
const DEFAULT_RESOURCE_PAGE_LIMIT = 200;

function profileMaxTools(profile: McpProfile): number {
	const key = profile === 'operations' ? CONFIG_PARAMS.MCP_OPERATIONS_MAXTOOLS : CONFIG_PARAMS.MCP_APPLICATION_MAXTOOLS;
	const value = env.get(key);
	return typeof value === 'number' && value > 0 ? value : DEFAULT_MAX_TOOLS;
}

function effectiveUser(request: NormRequest): AuthedUser {
	return request.userObject ?? { username: request.user };
}

/** Sentinel: a cursor was supplied on the request but failed to decode. */
const INVALID_CURSOR = Symbol('invalid-cursor');

/**
 * Resolve a list request's `params.cursor` to a pagination offset:
 *   - absent / non-string  → `undefined` (fresh first-page request)
 *   - valid opaque cursor  → numeric offset
 *   - present but malformed → `INVALID_CURSOR` (caller returns `-32602`)
 *
 * Per MCP §server/utilities/pagination cursors are opaque; an unrecognized
 * cursor is a client error, not a silent restart from offset 0 (#1317 S2).
 */
function decodeRequestCursor(rawCursor: unknown): number | undefined | typeof INVALID_CURSOR {
	if (typeof rawCursor !== 'string') return undefined;
	const offset = decodeCursor(rawCursor);
	return offset === null ? INVALID_CURSOR : offset;
}

function dispatchToolsList(
	request: NormRequest,
	session: McpSessionRecord,
	message: JsonRpcMessage,
	messageId: JsonRpcId
): NormResponse {
	const params = 'params' in message ? (message.params as { cursor?: unknown } | undefined) : undefined;
	const offset = decodeRequestCursor(params?.cursor);
	if (offset === INVALID_CURSOR) {
		return jsonResponse(200, buildError(messageId, ERROR_CODES.INVALID_PARAMS, 'invalid pagination cursor'));
	}
	const limit = profileMaxTools(request.profile);
	const { tools, nextCursor } = listTools({
		user: effectiveUser(request),
		profile: request.profile,
		sessionId: session.id,
		offset,
		limit,
	});
	const result: { tools: unknown[]; nextCursor?: string } = { tools };
	if (nextCursor) result.nextCursor = nextCursor;
	return jsonResponse(200, buildSuccess(messageId, result));
}

async function dispatchToolsCall(
	request: NormRequest,
	session: McpSessionRecord,
	message: JsonRpcMessage,
	messageId: JsonRpcId
): Promise<NormResponse> {
	const params =
		'params' in message ? (message.params as { name?: unknown; arguments?: unknown } | undefined) : undefined;
	const name = typeof params?.name === 'string' ? params.name : undefined;
	if (!name) {
		return jsonResponse(200, buildError(messageId, ERROR_CODES.INVALID_PARAMS, 'tools/call requires params.name'));
	}
	const tool = getTool(name);
	if (!tool || tool.profile !== request.profile) {
		return jsonResponse(200, buildError(messageId, ERROR_CODES.METHOD_NOT_FOUND, `Unknown tool: ${name}`));
	}

	const args = params?.arguments ?? {};
	const callStartedAt = Date.now();
	const user = effectiveUser(request);
	// Keep the SSE registry's idle-prune from sweeping this session: tools/call
	// activity counts as "alive" even if the GET stream is dormant between
	// listChanged events.
	touchRegisteredSession(session.id);

	// Rate limit check — admit-or-deny BEFORE invoking the handler. Failures
	// surface as `isError: true` with `kind: 'rate_limited'` (NOT a JSON-RPC
	// error) so the LLM sees and can back off / try later.
	const decision = tryAdmit(session.id, name, request.profile);
	if (!decision.allowed) {
		// Non-strict tsconfig doesn't narrow the discriminated union here.
		const denied = decision as { allowed: false; reason: string };
		const toolResult: ToolResult = {
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						kind: 'rate_limited',
						scope: denied.reason,
						tool: name,
						message: `MCP ${denied.reason} rate limit reached; back off and try again`,
					}),
				},
			],
		};
		emitAuditEntry({
			timestamp: new Date(callStartedAt).toISOString(),
			profile: request.profile,
			sessionId: session.id,
			tool: name,
			user: user.username ?? request.user,
			args: args as object,
			status: 'rate_limited',
			durationMs: 0,
		});
		// Surface the throttle to a client that opted into logging, so it can
		// back off rather than only inferring from the isError tool result.
		emitMcpLogToSession(
			session.id,
			'notice',
			{ kind: 'rate_limited', tool: name, scope: denied.reason },
			'mcp.rateLimit'
		);
		return jsonResponse(200, buildSuccess(messageId, toolResult));
	}

	let toolResult: ToolResult;
	let status: 'ok' | 'isError' = 'ok';
	let errorMessage: string | undefined;
	try {
		toolResult = await tool.handler(args, {
			user,
			profile: request.profile,
			sessionId: session.id,
		});
		if (toolResult?.isError) status = 'isError';
	} catch (err) {
		// Per MCP §server/tools → Error Handling: tool-execution errors come
		// back as a successful JSON-RPC result with isError:true so the LLM
		// can see and adapt. Stack traces stay in the server log; only the
		// message goes to the wire (Harper-style hygiene).
		const errMsg = (err as Error).message ?? 'tool execution failed';
		harperLogger.warn(`MCP tools/call ${name} threw: ${(err as Error).stack ?? errMsg}`);
		errorMessage = errMsg;
		status = 'isError';
		toolResult = {
			isError: true,
			content: [
				{
					type: 'text',
					text: JSON.stringify({ kind: 'harper_error', message: errMsg }),
				},
			],
		};
	} finally {
		decision.release();
	}
	emitAuditEntry({
		timestamp: new Date(callStartedAt).toISOString(),
		profile: request.profile,
		sessionId: session.id,
		tool: name,
		user: user.username ?? request.user,
		args: args as object,
		status,
		durationMs: Date.now() - callStartedAt,
		...(errorMessage ? { errorMessage } : {}),
	});
	return jsonResponse(200, buildSuccess(messageId, toolResult));
}

function dispatchResourcesList(request: NormRequest, message: JsonRpcMessage, messageId: JsonRpcId): NormResponse {
	const params = 'params' in message ? (message.params as { cursor?: unknown } | undefined) : undefined;
	const offset = decodeRequestCursor(params?.cursor);
	if (offset === INVALID_CURSOR) {
		return jsonResponse(200, buildError(messageId, ERROR_CODES.INVALID_PARAMS, 'invalid pagination cursor'));
	}
	const result = listResources({
		user: effectiveUser(request),
		profile: request.profile,
		offset,
		limit: DEFAULT_RESOURCE_PAGE_LIMIT,
	});
	const body: { resources: unknown[]; nextCursor?: string } = { resources: result.resources };
	if (result.nextCursor) body.nextCursor = result.nextCursor;
	return jsonResponse(200, buildSuccess(messageId, body));
}

function dispatchResourceTemplatesList(request: NormRequest, messageId: JsonRpcId): NormResponse {
	const templates = listResourceTemplates(request.profile);
	return jsonResponse(200, buildSuccess(messageId, { resourceTemplates: templates }));
}

async function dispatchResourcesRead(
	request: NormRequest,
	message: JsonRpcMessage,
	messageId: JsonRpcId
): Promise<NormResponse> {
	const params = 'params' in message ? (message.params as { uri?: unknown } | undefined) : undefined;
	const uri = typeof params?.uri === 'string' ? params.uri : undefined;
	if (!uri) {
		return jsonResponse(200, buildError(messageId, ERROR_CODES.INVALID_PARAMS, 'resources/read requires params.uri'));
	}
	const outcome = await readResource({ uri, user: effectiveUser(request), profile: request.profile });
	if (outcome.ok !== true) {
		const fail = outcome as { ok: false; reason: string };
		// Per MCP §server/resources, "resource not found" and access-control
		// failures are protocol errors, not isError tool results — resources/*
		// returns JSON-RPC errors rather than success-with-isError. We pick
		// -32602 (Invalid params) for bad inputs and -32601 (Method not found)
		// for unknown resources, matching the spec's mapping for analogous
		// situations and the precedent already in place for tools/call.
		const code = /not found|no resource matches/.test(fail.reason)
			? ERROR_CODES.METHOD_NOT_FOUND
			: ERROR_CODES.INVALID_PARAMS;
		return jsonResponse(200, buildError(messageId, code, fail.reason));
	}
	return jsonResponse(200, buildSuccess(messageId, { contents: outcome.contents }));
}

async function handleDelete(request: NormRequest): Promise<NormResponse> {
	const allow = env.get(CONFIG_PARAMS.MCP_SESSION_ALLOWCLIENTDELETE);
	if (allow !== true) {
		return { status: 405, headers: { Allow: currentlyAllowedMethods() } };
	}
	const sessionId = request.headers[SESSION_HEADER];
	if (!sessionId) {
		return { status: 400, headers: {} };
	}
	const session = await loadSession(sessionId);
	if (!session) {
		return { status: 404, headers: {} };
	}
	if (session.user !== request.user) {
		return { status: 403, headers: {} };
	}
	await deleteSession(sessionId);
	return { status: 204, headers: {} };
}

function validateProtocolHeader(
	headerValue: string | undefined,
	sessionVersion: string
): { ok: true } | { ok: false; reason: string } {
	// Per spec compatibility rule: missing header is treated as 2025-03-26.
	const effective = headerValue ?? PROTOCOL_VERSION_BACKCOMPAT;
	if (!SUPPORTED_PROTOCOL_VERSIONS.includes(effective as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
		return { ok: false, reason: `unsupported MCP-Protocol-Version: ${effective}` };
	}
	if (effective !== sessionVersion) {
		return {
			ok: false,
			reason: `MCP-Protocol-Version mismatch: session negotiated ${sessionVersion}, request sent ${effective}`,
		};
	}
	return { ok: true };
}

function jsonResponse(status: number, body: unknown): NormResponse {
	return {
		status,
		headers: { 'Content-Type': 'application/json' },
		jsonBody: body,
	};
}

function jsonRpcErrorResponse(
	status: number,
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown
): NormResponse {
	return {
		status,
		headers: { 'Content-Type': 'application/json' },
		jsonBody: buildError(id, code, message, data),
	};
}

/**
 * Mask an MCP session id for log output. Sessions aren't credentials in the
 * strict sense, but a leaked id paired with a stolen token enables session
 * jacking, so we don't print the full value in routine logs.
 */
function maskSessionId(id: string): string {
	if (id.length <= 8) return '***';
	return `${id.slice(0, 8)}…`;
}

/**
 * Build the `Allow` header value for a 405 response. Per RFC 9110 §9.1 the
 * server MUST list only currently-supported methods. In v1, POST is always
 * supported; GET opens the server-push SSE channel for
 * `notifications/{tools,resources}/list_changed`; DELETE is conditional on
 * `mcp.session.allowClientDelete`.
 */
function currentlyAllowedMethods(): string {
	const allow = ['POST', 'GET'];
	if (env.get(CONFIG_PARAMS.MCP_SESSION_ALLOWCLIENTDELETE) === true) allow.push('DELETE');
	return allow.join(', ');
}
