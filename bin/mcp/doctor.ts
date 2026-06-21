/**
 * `harper mcp doctor` — quick connectivity + handshake smoke check.
 *
 * Steps:
 *   1. Resolve connection (UDS or network).
 *   2. POST an `initialize` request.
 *   3. Read the response, capture Mcp-Session-Id.
 *   4. POST a `tools/list` and confirm a JSON-RPC result comes back.
 *   5. DELETE the session (if allowed) for cleanup.
 *
 * Each step prints a line to stdout (one line = one OK/FAIL). Exit code
 * is 0 on full success, 1 if any step fails.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { McpCliOptions } from './options.ts';
import { resolveConnection } from './client.ts';

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_VERSION = '2025-06-18';

export interface DoctorResult {
	ok: boolean;
	steps: ReadonlyArray<{ name: string; ok: boolean; detail?: string }>;
}

export async function runDoctor(opts: McpCliOptions): Promise<DoctorResult> {
	const connection = resolveConnection(opts);
	const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

	// Step 1: initialize.
	let sessionId: string | undefined;
	let protocolVersion = PROTOCOL_VERSION;
	try {
		const res = await postJson(connection, opts.mountPath, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'harper-mcp-doctor', version: '1.0.0' },
			},
		});
		if (res.statusCode !== 200) {
			steps.push({ name: 'initialize', ok: false, detail: `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}` });
			return finalize(steps);
		}
		const sid = res.headers[SESSION_HEADER];
		sessionId = Array.isArray(sid) ? sid[0] : sid;
		const parsed = JSON.parse(res.body);
		if (parsed?.error) {
			steps.push({ name: 'initialize', ok: false, detail: `JSON-RPC error: ${parsed.error.message}` });
			return finalize(steps);
		}
		if (typeof parsed?.result?.protocolVersion === 'string') protocolVersion = parsed.result.protocolVersion;
		steps.push({ name: 'initialize', ok: true, detail: `session=${sessionId} protocol=${protocolVersion}` });
	} catch (err) {
		steps.push({ name: 'initialize', ok: false, detail: (err as Error).message });
		return finalize(steps);
	}

	// Step 2: tools/list (validates the session works for real dispatch).
	try {
		const res = await postJson(
			connection,
			opts.mountPath,
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
			sessionId,
			protocolVersion
		);
		if (res.statusCode !== 200) {
			steps.push({ name: 'tools/list', ok: false, detail: `HTTP ${res.statusCode}` });
			return finalize(steps);
		}
		const parsed = JSON.parse(res.body);
		if (parsed?.error) {
			steps.push({ name: 'tools/list', ok: false, detail: `JSON-RPC error: ${parsed.error.message}` });
			return finalize(steps);
		}
		const count = Array.isArray(parsed?.result?.tools) ? parsed.result.tools.length : 0;
		steps.push({ name: 'tools/list', ok: true, detail: `${count} tool(s) visible` });
	} catch (err) {
		steps.push({ name: 'tools/list', ok: false, detail: (err as Error).message });
		return finalize(steps);
	}

	// Step 3: DELETE the session. Tolerated to fail (some configs disable it
	// with allowClientDelete=false → 405). Either way the doctor overall is
	// still OK if initialize + tools/list passed.
	try {
		const del = await sendDelete(connection, opts.mountPath, sessionId!, protocolVersion);
		if (del.statusCode >= 200 && del.statusCode < 300) {
			steps.push({ name: 'session cleanup', ok: true });
		} else {
			steps.push({ name: 'session cleanup', ok: false, detail: `HTTP ${del.statusCode}` });
		}
	} catch (err) {
		steps.push({ name: 'session cleanup', ok: false, detail: (err as Error).message });
	}

	return finalize(steps);
}

function finalize(steps: ReadonlyArray<{ name: string; ok: boolean; detail?: string }>): DoctorResult {
	const ok = steps.every((s) => s.ok || s.name === 'session cleanup');
	return { ok, steps };
}

interface SimpleResponse {
	statusCode: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function postJson(
	connection: ReturnType<typeof resolveConnection>,
	mountPath: string,
	body: object,
	sessionId?: string,
	protocolVersion?: string
): Promise<SimpleResponse> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'accept': 'application/json, text/event-stream',
	};
	if (sessionId) headers[SESSION_HEADER] = sessionId;
	if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
	return rawRequest(connection, mountPath, 'POST', headers, JSON.stringify(body));
}

function sendDelete(
	connection: ReturnType<typeof resolveConnection>,
	mountPath: string,
	sessionId: string,
	protocolVersion: string
): Promise<SimpleResponse> {
	return rawRequest(connection, mountPath, 'DELETE', {
		[SESSION_HEADER]: sessionId,
		'mcp-protocol-version': protocolVersion,
	});
}

function rawRequest(
	connection: ReturnType<typeof resolveConnection>,
	mountPath: string,
	method: 'POST' | 'DELETE',
	headers: Record<string, string>,
	body?: string
): Promise<SimpleResponse> {
	return new Promise((resolve, reject) => {
		const isHttps = connection.protocol === 'https:';
		const lib = isHttps ? https : http;
		const reqHeaders: Record<string, string> = { ...headers };
		if (connection.authHeader) reqHeaders.authorization = connection.authHeader;
		const reqOpts: http.RequestOptions = {
			method,
			path: mountPath,
			headers: reqHeaders,
		};
		if (connection.socketPath) {
			reqOpts.socketPath = connection.socketPath;
		} else {
			reqOpts.hostname = connection.hostname;
			reqOpts.port = connection.port;
		}
		if (isHttps) (reqOpts as https.RequestOptions).rejectUnauthorized = connection.rejectUnauthorized;
		const req = lib.request(reqOpts, async (res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of res) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
			resolve({
				statusCode: res.statusCode ?? 0,
				headers: res.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			});
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

export function formatDoctorReport(result: DoctorResult, stdout: NodeJS.WritableStream = process.stdout): void {
	for (const s of result.steps) {
		const tag = s.ok ? 'OK  ' : 'FAIL';
		stdout.write(`[${tag}] ${s.name}${s.detail ? ' — ' + s.detail : ''}\n`);
	}
	stdout.write(result.ok ? '\nAll checks passed.\n' : '\nDoctor reported failures; see above.\n');
}
