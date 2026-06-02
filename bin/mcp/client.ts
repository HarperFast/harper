/**
 * Streamable HTTP MCP client over stdio. Implements the MCP rev 2025-06-18
 * transport from the client side: each line on stdin is a JSON-RPC frame,
 * POSTed to the server's `/mcp` endpoint; the response (JSON or SSE) is
 * parsed and emitted to stdout as line-delimited JSON-RPC. After the
 * `initialize` handshake completes, a long-lived GET request opens the
 * server-push SSE channel and forwards each notification to stdout.
 *
 * Sits between an MCP host (Claude Desktop, Cursor, Zed) and a running
 * Harper instance. The host treats this as a stdio-transport MCP server;
 * Harper sees a Streamable HTTP client. v1 keeps it simple — no
 * `Last-Event-ID` resumability, no multi-process session coordination.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { URL } from 'node:url';
import { loadCredentials, normalizeTarget } from '../cliCredentials.ts';
import type { McpCliOptions } from './options.ts';

function isJwtish(token: string | undefined): token is string {
	return typeof token === 'string' && token.split('.').length === 3;
}

interface HttpOptions {
	hostname?: string;
	port?: number | string;
	protocol: 'http:' | 'https:';
	socketPath?: string;
	rejectUnauthorized: boolean;
	authHeader?: string;
}

interface PostResult {
	statusCode: number;
	contentType: string;
	headers: http.IncomingHttpHeaders;
	bodyText: string; // for application/json
	sse?: AsyncIterable<SseFrame>;
}

interface SseFrame {
	event?: string;
	data: string;
	id?: string;
}

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

export interface BridgeOptions {
	connection: HttpOptions;
	mountPath: string;
	stdin?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	stderr?: NodeJS.WritableStream;
}

/**
 * Run the bridge until stdin closes (host disconnects) or the GET stream
 * errors. Returns a promise that resolves on graceful shutdown.
 */
export async function runBridge(opts: BridgeOptions): Promise<void> {
	const stdin = opts.stdin ?? process.stdin;
	const stdout = opts.stdout ?? process.stdout;
	const stderr = opts.stderr ?? process.stderr;
	const log = (msg: string): void => {
		stderr.write(`harper mcp: ${msg}\n`);
	};

	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	let getController: AbortController | undefined;

	const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
	const writeFrame = (frame: object): void => {
		stdout.write(JSON.stringify(frame) + '\n');
	};

	// stdin lines → POST /mcp
	const stdinDone: Promise<void> = (async () => {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let message: unknown;
			try {
				message = JSON.parse(trimmed);
			} catch (err) {
				log(`stdin line is not valid JSON, ignoring: ${(err as Error).message}`);
				continue;
			}
			try {
				const result = await postMessage(opts.connection, opts.mountPath, message, sessionId, protocolVersion);
				// Capture session id from initialize response.
				const newSid = headerString(result.headers, SESSION_HEADER);
				if (newSid && !sessionId) {
					sessionId = newSid;
					// If this is an initialize response, capture the protocol version
					// the server picked, then open the GET stream.
					const parsed = safeParse(result.bodyText);
					if (parsed && typeof parsed === 'object' && 'result' in (parsed as Record<string, unknown>)) {
						const r = (parsed as { result?: { protocolVersion?: unknown } }).result;
						if (r && typeof r.protocolVersion === 'string') protocolVersion = r.protocolVersion;
					}
					getController = openGetStream(opts.connection, opts.mountPath, sessionId, protocolVersion, writeFrame, log);
				}
				if (result.sse) {
					// Streaming POST response: each `message` event maps to a JSON-RPC frame.
					for await (const frame of result.sse) {
						if (frame.event && frame.event !== 'message') continue;
						const parsed = safeParse(frame.data);
						if (parsed) writeFrame(parsed as object);
					}
				} else if (result.bodyText) {
					const parsed = safeParse(result.bodyText);
					if (parsed) writeFrame(parsed as object);
				}
			} catch (err) {
				log(`POST failed: ${(err as Error).message}`);
				// Best-effort: emit a JSON-RPC error keyed to the original id so the
				// host doesn't hang waiting for a response.
				const id = (message as { id?: unknown })?.id ?? null;
				writeFrame({
					jsonrpc: '2.0',
					id,
					error: { code: -32603, message: (err as Error).message },
				});
			}
		}
	})();

	try {
		await stdinDone;
	} finally {
		getController?.abort();
	}
}

function openGetStream(
	connection: HttpOptions,
	mountPath: string,
	sessionId: string,
	protocolVersion: string | undefined,
	writeFrame: (frame: object) => void,
	log: (msg: string) => void
): AbortController {
	const controller = new AbortController();
	(async () => {
		try {
			// Pass `signal` straight into the underlying http.request so an
			// abort fired before/during connect-handshake terminates cleanly —
			// adding the listener post-await would miss that race.
			const { res } = await openRequest(
				connection,
				mountPath,
				'GET',
				{
					accept: 'text/event-stream',
					[SESSION_HEADER]: sessionId,
					...(protocolVersion ? { [PROTOCOL_HEADER]: protocolVersion } : {}),
				},
				undefined,
				controller.signal
			);
			if (res.statusCode !== 200) {
				log(`GET /mcp returned ${res.statusCode}; server-push notifications will not arrive`);
				res.resume();
				return;
			}
			for await (const frame of parseSseStream(res)) {
				if (frame.event && frame.event !== 'message') continue;
				const parsed = safeParse(frame.data);
				if (parsed) writeFrame(parsed as object);
			}
		} catch (err) {
			if ((err as { code?: string }).code === 'ABORT_ERR') return;
			log(`GET stream error: ${(err as Error).message}`);
		}
	})();
	return controller;
}

async function postMessage(
	connection: HttpOptions,
	mountPath: string,
	body: unknown,
	sessionId: string | undefined,
	protocolVersion: string | undefined
): Promise<PostResult> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'accept': 'application/json, text/event-stream',
	};
	if (sessionId) headers[SESSION_HEADER] = sessionId;
	if (protocolVersion) headers[PROTOCOL_HEADER] = protocolVersion;
	const { req, res } = await openRequest(connection, mountPath, 'POST', headers, JSON.stringify(body));
	const contentType = (res.headers['content-type'] ?? '').toString();
	if (contentType.startsWith('text/event-stream')) {
		return {
			statusCode: res.statusCode ?? 0,
			contentType,
			headers: res.headers,
			bodyText: '',
			sse: parseSseStream(res),
		};
	}
	const bodyText = await collectBody(res);
	req.destroy();
	return { statusCode: res.statusCode ?? 0, contentType, headers: res.headers, bodyText };
}

interface OpenedRequest {
	req: http.ClientRequest;
	res: http.IncomingMessage;
}

function openRequest(
	connection: HttpOptions,
	mountPath: string,
	method: 'GET' | 'POST',
	headers: Record<string, string>,
	body?: string,
	signal?: AbortSignal
): Promise<OpenedRequest> {
	return new Promise((resolve, reject) => {
		const isHttps = connection.protocol === 'https:';
		const lib = isHttps ? https : http;
		const reqHeaders: Record<string, string> = { ...headers };
		if (connection.authHeader) reqHeaders.authorization = connection.authHeader;
		const reqOptions: http.RequestOptions = {
			method,
			path: mountPath,
			headers: reqHeaders,
			signal,
		};
		if (connection.socketPath) {
			reqOptions.socketPath = connection.socketPath;
		} else {
			reqOptions.hostname = connection.hostname;
			reqOptions.port = connection.port;
		}
		if (isHttps) {
			(reqOptions as https.RequestOptions).rejectUnauthorized = connection.rejectUnauthorized;
		}
		const req = lib.request(reqOptions, (res) => {
			resolve({ req, res });
		});
		req.on('error', (err) => reject(err));
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function collectBody(res: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of res) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * Minimal SSE stream parser per WHATWG (server-sent events). MCP uses only
 * the `event`, `data`, and `id` fields; we ignore `retry` and comments.
 * Multi-line `data:` blocks are joined with `\n`.
 *
 * Two correctness details:
 *   - `StringDecoder` preserves multi-byte UTF-8 sequences that straddle
 *     chunk boundaries — naive `chunk.toString('utf8')` would corrupt
 *     them.
 *   - Strip `\r` so the `\n\n` event delimiter matches whether the server
 *     emits LF or CRLF line endings (HTTP/SSE often uses CRLF).
 */
async function* parseSseStream(stream: NodeJS.ReadableStream): AsyncIterable<SseFrame> {
	let buffer = '';
	const decoder = new StringDecoder('utf8');
	for await (const chunk of stream) {
		const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
		buffer += text.replace(/\r/g, '');
		let idx: number;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const frame = parseSseFrame(raw);
			if (frame) yield frame;
		}
	}
	const tail = decoder.end();
	if (tail) buffer += tail.replace(/\r/g, '');
	if (buffer.trim().length > 0) {
		const frame = parseSseFrame(buffer);
		if (frame) yield frame;
	}
}

function parseSseFrame(raw: string): SseFrame | null {
	const lines = raw.split(/\r?\n/);
	let event: string | undefined;
	let dataLines: string[] = [];
	let id: string | undefined;
	for (const line of lines) {
		if (!line || line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		else if (field === 'data') dataLines.push(value);
		else if (field === 'id') id = value;
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join('\n'), id };
}

function headerString(headers: http.IncomingHttpHeaders, key: string): string | undefined {
	const v = headers[key.toLowerCase()];
	if (Array.isArray(v)) return v[0];
	return v;
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Resolve `--target` / UDS path + creds → HttpOptions.
 *
 * UDS-mode caveat: only the **operations** profile is reachable via the
 * local Unix Domain Socket. The application profile is mounted on the
 * application HTTP server (the same listener that serves your REST
 * endpoints), which doesn't expose a UDS in v1. Selecting
 * `--profile application` without `--target` is a user error — we throw
 * here rather than silently routing to the operations UDS (which would
 * misleadingly return the operations tool list under super_user auth).
 */
export function resolveConnection(opts: McpCliOptions): HttpOptions {
	if (opts.target) {
		let parsed: URL;
		try {
			parsed = new URL(opts.target);
		} catch {
			parsed = new URL(`https://${opts.target}`);
		}
		const proto = parsed.protocol === 'http:' ? 'http:' : 'https:';
		const authHeader = computeAuthHeader(opts, parsed);
		return {
			protocol: proto,
			hostname: parsed.hostname,
			port: parsed.port || (proto === 'https:' ? 443 : 80),
			rejectUnauthorized: opts.rejectUnauthorized,
			authHeader,
		};
	}
	if (opts.profile === 'application') {
		throw new Error(
			'harper mcp: --profile application requires --target https://<host>:<port>. ' +
				'The application MCP endpoint is mounted on the application HTTP server, which ' +
				'does not expose a local UDS in v1.'
		);
	}
	// UDS path resolution mirrors bin/cliOperations.ts:150.
	const { getConfigPath } = require('../../config/configUtils');
	const terms = require('../../utility/hdbTerms');
	const socketPath = getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET);
	return {
		protocol: 'http:',
		socketPath,
		rejectUnauthorized: true,
		authHeader: undefined,
	};
}

/**
 * Precedence (highest first):
 *   1. --bearer <token>
 *   2. --username + --password
 *   3. URL embedded user/pass (https://user:pw@host)
 *   4. Saved JWT from `~/.harperdb/credentials.json` for the resolved target
 *      (populated by `harper login` — same flow `bin/cliOperations.ts` uses).
 *
 * Returning undefined here means "no creds in scope"; the request goes out
 * unauthenticated and the server gates accordingly.
 */
function computeAuthHeader(opts: McpCliOptions, parsed: URL): string | undefined {
	if (opts.bearer) return `Bearer ${opts.bearer}`;
	const u = opts.username ?? parsed.username;
	const p = opts.password ?? parsed.password;
	if (u) return `Basic ${Buffer.from(`${u}:${p ?? ''}`).toString('base64')}`;
	try {
		const all = loadCredentials();
		// Same lookup key shape `harper login` / cliOperations writes/reads:
		// `normalizeTarget(<user-supplied URL>)`.
		const lookup = normalizeTarget(opts.target!);
		const tokens = all.targets?.[lookup];
		if (tokens?.operation_token && isJwtish(tokens.operation_token)) {
			return `Bearer ${tokens.operation_token}`;
		}
	} catch {
		// Missing / unreadable credentials file is non-fatal — fall through to anonymous.
	}
	return undefined;
}
