/**
 * JSON-RPC 2.0 envelope parsing + error helpers for the MCP Streamable HTTP
 * transport (#614). The MCP wire format is one JSON-RPC message per HTTP body
 * (no batches in the 2025-06-18 revision — spec §transports).
 *
 * Spec: https://www.jsonrpc.org/specification
 */

export const JSONRPC_VERSION = '2.0';

/** Standard JSON-RPC 2.0 error codes (spec §5.1). */
export const ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccessResponse {
	jsonrpc: '2.0';
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: '2.0';
	id: JsonRpcId;
	error: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface ParseSuccess {
	ok: true;
	message: JsonRpcMessage;
}
export interface ParseFailure {
	ok: false;
	code: number;
	reason: string;
}
export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Validate a JSON-RPC envelope. Accepts either a raw UTF-8 JSON string
 * (e.g., from a streamed request body) or an already-parsed value (e.g.,
 * Fastify hands us a parsed object via its preParsing pipeline). Returns
 * either a typed message or a structured parse error that the caller maps
 * to a JSON-RPC error response. Never throws.
 */
export function parseMessage(body: string | unknown): ParseResult {
	let parsed: unknown;
	if (typeof body === 'string') {
		try {
			parsed = JSON.parse(body);
		} catch (err) {
			const fail: ParseFailure = { ok: false, code: ERROR_CODES.PARSE_ERROR, reason: (err as Error).message };
			return fail;
		}
	} else {
		parsed = body;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		// Batch requests (arrays) are not used in the MCP Streamable HTTP wire
		// format; rejecting them keeps the transport unambiguous.
		const fail: ParseFailure = { ok: false, code: ERROR_CODES.INVALID_REQUEST, reason: 'expected a JSON object' };
		return fail;
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.jsonrpc !== JSONRPC_VERSION) {
		const fail: ParseFailure = {
			ok: false,
			code: ERROR_CODES.INVALID_REQUEST,
			reason: `jsonrpc must be "${JSONRPC_VERSION}"`,
		};
		return fail;
	}
	const hasMethod = typeof obj.method === 'string';
	const hasResultOrError = 'result' in obj || 'error' in obj;
	if (!hasMethod && !hasResultOrError) {
		const fail: ParseFailure = {
			ok: false,
			code: ERROR_CODES.INVALID_REQUEST,
			reason: 'missing method, result, or error field',
		};
		return fail;
	}
	const success: ParseSuccess = { ok: true, message: parsed as JsonRpcMessage };
	return success;
}

/**
 * True if the message is a "fire-and-forget" frame from the client's
 * perspective — a notification (no `id`) or a response to a server-initiated
 * request (has `result` or `error`). Per MCP §transports point 4, both yield
 * HTTP 202 with no body.
 */
export function isClientFireAndForget(message: JsonRpcMessage): boolean {
	const hasId = 'id' in message;
	const hasResultOrError = 'result' in message || 'error' in message;
	return !hasId || hasResultOrError;
}

export function buildSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
	return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function buildError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
	const error: JsonRpcErrorObject = { code, message };
	if (data !== undefined) error.data = data;
	return { jsonrpc: JSONRPC_VERSION, id, error };
}
