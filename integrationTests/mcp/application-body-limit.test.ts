/**
 * `http.maxRequestBodySize` on the MCP application endpoint (#3398), beyond the default-limit case in
 * `application.test.ts`: the exact boundary for declared and chunked bodies, a declared length over the limit with
 * no body bytes (answered before any arrive), per-chunk counting, a valid request after an oversize body on the same
 * keep-alive socket (MCP and REST), refusal order for callers without a principal, the REST and operations-port
 * readers of the same instance, and GET/DELETE carrying an oversize body.
 *
 * The REST, operations-port and anonymous-session arms are parity and liveness controls, not regression anchors.
 * Runs on the Node http server, or on uWebSockets.js when the environment sets `HARPER_UWS_HTTP=1` as the CI uWS
 * shard does; the test names carry the server that ran.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-body-limit');
const LIMIT = 65_536;
const USE_UWS = process.env.HARPER_UWS_HTTP === '1';
const SERVER_CONFIG = {
	mcp: { operations: { mountPath: '/mcp' }, application: { mountPath: '/mcp' } },
	http: { maxRequestBodySize: LIMIT },
	// without this a loopback caller with no credentials is the super user, and arm D measures the admin
	authentication: { authorizeLocal: false },
};

function basic(user: string, pass: string): string {
	return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** A valid JSON-RPC initialize envelope padded with trailing spaces to exactly `bytes` bytes. */
function paddedInitialize(bytes: number, id = 1): Buffer {
	const core = JSON.stringify({
		jsonrpc: '2.0',
		id,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'body-limit', version: '0' } },
	});
	if (core.length > bytes) throw new Error(`initialize envelope (${core.length}) longer than ${bytes}`);
	return Buffer.concat([Buffer.from(core), Buffer.alloc(bytes - core.length, 0x20)]);
}

/** A valid REST record body padded with trailing spaces to exactly `bytes` bytes. */
function paddedRecord(bytes: number, id: string): Buffer {
	const core = JSON.stringify({ id, body: 'x' });
	return Buffer.concat([Buffer.from(core), Buffer.alloc(bytes - core.length, 0x20)]);
}

function chunkedStream(payload: Buffer, chunkSize: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= payload.length) return controller.close();
			controller.enqueue(payload.subarray(offset, Math.min(offset + chunkSize, payload.length)));
			offset += chunkSize;
		},
	});
}

/** Chunks of the given sizes, then one chunk with the remainder. */
function splitStream(payload: Buffer, ...sizes: number[]): ReadableStream<Uint8Array> {
	const parts: Buffer[] = [];
	let offset = 0;
	for (const size of sizes) {
		parts.push(payload.subarray(offset, offset + size));
		offset += size;
	}
	parts.push(payload.subarray(offset));
	return new ReadableStream({
		pull(controller) {
			const next = parts.shift();
			if (!next) return controller.close();
			controller.enqueue(next);
		},
	});
}

async function post(
	url: URL,
	body: Buffer | ReadableStream<Uint8Array>,
	headers: Record<string, string>,
	method = 'POST'
): Promise<{ status: number; contentType: string | null; connection: string | null; text: string }> {
	const init: RequestInit & { duplex?: 'half' } = { method, headers, body };
	if (!(body instanceof Buffer)) init.duplex = 'half';
	const res = await fetch(url, init);
	const text = await res.text();
	return {
		status: res.status,
		contentType: res.headers.get('content-type'),
		connection: res.headers.get('connection'),
		text,
	};
}

type RawResponse = { status: number; headers: Record<string, string>; body: string };

/**
 * Minimal HTTP/1.1 response reader for a raw keep-alive socket: parses `count` consecutive responses
 * (Content-Length or chunked framing) out of the byte stream, or rejects on close/timeout.
 */
function readResponses(socket: Socket, count: number, timeoutMs: number): Promise<RawResponse[]> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		const out: RawResponse[] = [];
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`timed out after ${timeoutMs} ms waiting for response ${out.length + 1}/${count}; buffered: ${JSON.stringify(buf.toString('latin1').slice(0, 300))}`
				)
			);
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			socket.off('data', onData);
			socket.off('close', onClose);
			socket.off('error', onError);
		};
		const onClose = () => {
			cleanup();
			reject(
				new Error(
					`socket closed after ${out.length}/${count} responses; buffered: ${JSON.stringify(buf.toString('latin1').slice(0, 300))}`
				)
			);
		};
		const onError = (e: Error) => {
			cleanup();
			reject(e);
		};
		const tryParse = (): boolean => {
			const headerEnd = buf.indexOf('\r\n\r\n');
			if (headerEnd < 0) return false;
			const head = buf.subarray(0, headerEnd).toString('latin1');
			const [statusLine, ...headerLines] = head.split('\r\n');
			const status = Number(statusLine.split(' ')[1]);
			const headers: Record<string, string> = {};
			for (const line of headerLines) {
				const i = line.indexOf(':');
				if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
			}
			let bodyStart = headerEnd + 4;
			let body: Buffer;
			let consumed: number;
			if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
				const parts: Buffer[] = [];
				let pos = bodyStart;
				for (;;) {
					const lineEnd = buf.indexOf('\r\n', pos);
					if (lineEnd < 0) return false;
					const size = parseInt(buf.subarray(pos, lineEnd).toString('latin1').split(';')[0], 16);
					if (Number.isNaN(size)) throw new Error(`bad chunk size at ${pos}`);
					pos = lineEnd + 2;
					if (size === 0) {
						const trailerEnd = buf.indexOf('\r\n', pos);
						if (trailerEnd < 0) return false;
						pos = trailerEnd + 2;
						break;
					}
					if (buf.length < pos + size + 2) return false;
					parts.push(buf.subarray(pos, pos + size));
					pos += size + 2;
				}
				body = Buffer.concat(parts);
				consumed = pos;
			} else {
				const len = Number(headers['content-length'] ?? 0);
				if (buf.length < bodyStart + len) return false;
				body = buf.subarray(bodyStart, bodyStart + len);
				consumed = bodyStart + len;
			}
			out.push({ status, headers, body: body.toString('utf8') });
			buf = buf.subarray(consumed);
			return true;
		};
		const onData = (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			try {
				while (out.length < count && tryParse()) {}
			} catch (e) {
				cleanup();
				return reject(e);
			}
			if (out.length >= count) {
				cleanup();
				resolve(out);
			}
		};
		socket.on('data', onData);
		socket.on('close', onClose);
		socket.on('error', onError);
	});
}

function openSocket(url: URL): Promise<Socket> {
	return new Promise((res, rej) => {
		const s = connect({ host: url.hostname, port: Number(url.port) }, () => res(s));
		s.once('error', rej);
	});
}

function write(socket: Socket, data: Buffer | string): Promise<void> {
	return new Promise((res, rej) => socket.write(data, (e) => (e ? rej(e) : res())));
}

function requestHead(method: string, path: string, host: string, headers: Record<string, string>): string {
	return (
		`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
		Object.entries(headers)
			.map(([k, v]) => `${k}: ${v}\r\n`)
			.join('') +
		'\r\n'
	);
}

suite('http.maxRequestBodySize on the MCP application endpoint', (ctx: ContextWithHarper) => {
	let appUrl: URL;
	let opsUrl: URL;
	let auth: string;
	let jsonHeaders: Record<string, string>;
	const mode = USE_UWS ? 'uws' : 'node';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: SERVER_CONFIG,
			env: USE_UWS ? { HARPER_UWS_HTTP: '1' } : {},
		});
		appUrl = new URL('/mcp', ctx.harper.httpURL);
		opsUrl = new URL('/mcp', ctx.harper.operationsAPIURL);
		auth = basic(ctx.harper.admin.username, ctx.harper.admin.password);
		jsonHeaders = {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
		};
		const deadline = Date.now() + 60_000;
		for (;;) {
			const r = await fetch(new URL('/LimitDoc/', ctx.harper.httpURL), { headers: { authorization: auth } }).catch(
				() => undefined
			);
			if (r && r.status !== 404) break;
			if (Date.now() > deadline) throw new Error('fixture route never became ready');
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test(`A [${mode}] declared Content-Length: LIMIT bytes served, LIMIT+1 refused with a JSON 413`, async () => {
		const at = await post(appUrl, paddedInitialize(LIMIT), jsonHeaders);
		strictEqual(at.status, 200, `exactly LIMIT bytes: ${at.status} ${at.text.slice(0, 200)}`);
		ok(
			JSON.parse(at.text).result?.protocolVersion,
			`LIMIT-byte initialize returned a result: ${at.text.slice(0, 200)}`
		);

		const over = await post(appUrl, paddedInitialize(LIMIT + 1), jsonHeaders);
		strictEqual(over.status, 413, `LIMIT+1 bytes: ${over.status} ${over.text.slice(0, 200)}`);
		ok((over.contentType ?? '').startsWith('application/json'), `413 content-type: ${over.contentType}`);
		const frame = JSON.parse(over.text);
		strictEqual(frame.error, 'payload_too_large');
		ok(String(frame.message).includes(String(LIMIT)), `413 message names the configured limit: ${frame.message}`);
	});

	test(`B [${mode}] chunked: LIMIT bytes served, LIMIT+1 refused with 413`, async () => {
		const at = await post(appUrl, chunkedStream(paddedInitialize(LIMIT, 2), 16_384), jsonHeaders);
		strictEqual(at.status, 200, `chunked LIMIT: ${at.status} ${at.text.slice(0, 200)}`);
		ok(JSON.parse(at.text).result?.protocolVersion, `chunked LIMIT-byte initialize returned a result`);

		const over = await post(appUrl, chunkedStream(paddedInitialize(LIMIT + 1, 3), 16_384), jsonHeaders);
		strictEqual(over.status, 413, `chunked LIMIT+1: ${over.status} ${over.text.slice(0, 200)}`);
		strictEqual(JSON.parse(over.text).error, 'payload_too_large');
	});

	test(`A2 [${mode}] declared Content-Length over the limit with NO body: 413 answered before any body byte`, async () => {
		const socket = await openSocket(appUrl);
		try {
			const pending = readResponses(socket, 1, 20_000);
			pending.catch(() => {});
			const started = Date.now();
			await write(socket, requestHead('POST', '/mcp', appUrl.host, { ...jsonHeaders, 'Content-Length': '5000000' }));
			const [r1] = await pending;
			const elapsed = Date.now() - started;
			strictEqual(r1.status, 413, `declared-oversize with no body: ${r1.status} ${r1.body.slice(0, 200)}`);
			strictEqual(JSON.parse(r1.body).error, 'payload_too_large');
			ok(elapsed < 5_000, `413 must not wait for body bytes that never arrive: ${elapsed} ms`);
		} finally {
			socket.destroy();
		}
	});

	test(`B2 [${mode}] chunk boundaries: the last byte alone, one byte over, and a split straddling the limit count per chunk`, async () => {
		const lastByteAt = await post(appUrl, splitStream(paddedInitialize(LIMIT, 21), LIMIT - 1), jsonHeaders);
		strictEqual(lastByteAt.status, 200, `[LIMIT-1, 1]: ${lastByteAt.status} ${lastByteAt.text.slice(0, 160)}`);
		ok(
			JSON.parse(lastByteAt.text).result?.protocolVersion,
			'a LIMIT-byte initialize ending in a 1-byte chunk returned a result'
		);
		const oneOver = await post(appUrl, splitStream(paddedInitialize(LIMIT + 1, 22), LIMIT - 1, 1), jsonHeaders);
		strictEqual(oneOver.status, 413, `[LIMIT-1, 1, 1]: ${oneOver.status} ${oneOver.text.slice(0, 160)}`);
		strictEqual(JSON.parse(oneOver.text).error, 'payload_too_large');

		const FIRST = 40_000;
		const straddleAt = await post(appUrl, splitStream(paddedInitialize(LIMIT, 23), FIRST), jsonHeaders);
		strictEqual(
			straddleAt.status,
			200,
			`split ${FIRST}+${LIMIT - FIRST}: ${straddleAt.status} ${straddleAt.text.slice(0, 160)}`
		);
		const straddleOver = await post(appUrl, splitStream(paddedInitialize(LIMIT + 1, 24), FIRST), jsonHeaders);
		strictEqual(
			straddleOver.status,
			413,
			`split ${FIRST}+${LIMIT + 1 - FIRST}: ${straddleOver.status} ${straddleOver.text.slice(0, 160)}`
		);
		strictEqual(JSON.parse(straddleOver.text).error, 'payload_too_large');
	});

	const OVERSIZE = LIMIT * 4;
	const follow = (method: string, host: string, path: string, body: Buffer, extra: Record<string, string>) =>
		Buffer.concat([
			Buffer.from(requestHead(method, path, host, { ...extra, 'Content-Length': String(body.length) })),
			body,
		]);

	/** One keep-alive socket: an oversize `first` body, then a valid follow-up request; returns both responses. */
	async function keepAliveAfter413(
		url: URL,
		path: string,
		first: 'declared' | 'chunked',
		followBody: Buffer,
		extra: Record<string, string>,
		method = 'POST',
		followMethod = method
	): Promise<RawResponse[]> {
		const socket = await openSocket(url);
		socket.setNoDelay(true);
		const host = url.host;
		try {
			const pending = readResponses(socket, 2, 20_000);
			pending.catch(() => {});
			const payload = Buffer.alloc(OVERSIZE, 0x20);
			if (first === 'declared') {
				await write(socket, requestHead(method, path, host, { ...extra, 'Content-Length': String(OVERSIZE) }));
				// the server may answer 413 while this body is still arriving; keep sending, as a real client would
				for (let off = 0; off < OVERSIZE; off += 16_384) {
					await write(socket, payload.subarray(off, off + 16_384));
					await sleep(5);
				}
			} else {
				await write(socket, requestHead(method, path, host, { ...extra, 'Transfer-Encoding': 'chunked' }));
				for (let off = 0; off < OVERSIZE; off += 16_384) {
					const chunk = payload.subarray(off, off + 16_384);
					await write(socket, `${chunk.length.toString(16)}\r\n`);
					await write(socket, chunk);
					await write(socket, '\r\n');
					await sleep(5);
				}
				await write(socket, '0\r\n\r\n');
			}
			await write(socket, follow(followMethod, host, path, followBody, extra));
			return await pending;
		} finally {
			socket.destroy();
		}
	}

	for (const first of ['declared', 'chunked'] as const) {
		test(`C [${mode}] MCP: a valid request after an oversize ${first} body on the same socket is answered`, async () => {
			const [r1, r2] = await keepAliveAfter413(appUrl, '/mcp', first, paddedInitialize(512, 7), jsonHeaders);
			strictEqual(r1.status, 413, `first response: ${r1.status} ${r1.body.slice(0, 200)}`);
			strictEqual(r2.status, 200, `second response: ${r2.status} ${r2.body.slice(0, 200)}`);
			const frame = JSON.parse(r2.body);
			strictEqual(frame.id, 7, `second response answers the second request: ${r2.body.slice(0, 200)}`);
			ok(frame.result?.protocolVersion, `second response is an initialize result`);
		});

		test(`C [${mode}] REST parity: a valid request after an oversize ${first} body on the same socket is answered`, async () => {
			const restHeaders = { 'content-type': 'application/json', 'authorization': auth };
			const [r1, r2] = await keepAliveAfter413(
				new URL('/', ctx.harper.httpURL),
				`/LimitDoc/rest-${first}`,
				first,
				paddedRecord(512, `rest-${first}`),
				restHeaders,
				'PUT'
			);
			strictEqual(r1.status, 413, `REST first response: ${r1.status} ${r1.body.slice(0, 200)}`);
			ok(
				r2.status === 200 || r2.status === 201 || r2.status === 204,
				`REST second response: ${r2.status} ${r2.body.slice(0, 200)}`
			);
			const stored = await fetch(new URL(`/LimitDoc/rest-${first}`, ctx.harper.httpURL), {
				headers: { authorization: auth },
			});
			strictEqual(stored.status, 200, 'the follow-up PUT landed');
		});
	}

	test(`D [${mode}] refusal order: an anonymous caller is refused on size, wrong credentials are refused before the body is read`, async () => {
		const anon = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
		const wrong = { ...anon, authorization: basic('body_limit_nobody', 'wrong-pw') };
		const d1 = await post(appUrl, paddedInitialize(512), anon);
		const d2 = await post(appUrl, paddedInitialize(LIMIT + 1), anon);
		const d3 = await post(appUrl, paddedInitialize(LIMIT + 1), wrong);
		strictEqual(d1.status, 200, `anonymous under-limit initialize: ${d1.status} ${d1.text.slice(0, 120)}`);
		strictEqual(d2.status, 413, `anonymous oversize: ${d2.status} ${d2.text.slice(0, 120)}`);
		strictEqual(JSON.parse(d2.text).error, 'payload_too_large');
		strictEqual(d3.status, 401, `wrong credentials are refused before the body is read: ${d3.status}`);
		const after = await post(appUrl, paddedInitialize(512, 9), jsonHeaders);
		strictEqual(after.status, 200);
	});

	test(`D4 [${mode}] an anonymous MCP session reaches nothing beyond initialize: data stays denied`, async () => {
		const anon = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
		const seed = await fetch(new URL('/LimitDoc/seeded-row', ctx.harper.httpURL), {
			method: 'PUT',
			headers: { 'content-type': 'application/json', 'authorization': auth },
			body: JSON.stringify({ id: 'seeded-row', body: 'secret-value' }),
		});
		ok([200, 201, 204].includes(seed.status), `seed PUT: ${seed.status}`);
		const session = async (headers: Record<string, string>) => {
			const init = await fetch(appUrl, { method: 'POST', headers, body: paddedInitialize(512, 1) });
			const initText = await init.text();
			strictEqual(init.status, 200, `initialize: ${init.status} ${initText.slice(0, 160)}`);
			const sessionId = init.headers.get('mcp-session-id');
			ok(sessionId, 'initialize issued a session id');
			const protocolVersion = JSON.parse(initText).result.protocolVersion;
			return async (method: string, params: Record<string, unknown>, id: number) => {
				const r = await fetch(appUrl, {
					method: 'POST',
					headers: { ...headers, 'mcp-session-id': sessionId!, 'mcp-protocol-version': protocolVersion },
					body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
				});
				const text = await r.text();
				let json: any;
				try {
					json = JSON.parse(text);
				} catch {
					json = undefined;
				}
				return { status: r.status, json, text };
			};
		};
		const toolNames = (r: { json: any }) => (r.json?.result?.tools ?? []).map((t: any) => t.name);
		const asAdmin = await session(jsonHeaders);
		const adminTools = toolNames(await asAdmin('tools/list', {}, 2));
		for (const name of ['get_LimitDoc', 'create_LimitDoc'])
			ok(adminTools.includes(name), `${name} is a generated tool: [${adminTools.join(',')}]`);
		const rpc = await session(anon);
		const tools = await rpc('tools/list', {}, 2);
		strictEqual(tools.status, 200, `tools/list for the anonymous session: ${tools.status} ${tools.text.slice(0, 160)}`);
		ok(Array.isArray(tools.json?.result?.tools), `tools/list did not answer with a list: ${tools.text.slice(0, 160)}`);
		deepStrictEqual(toolNames(tools), [], `an anonymous session sees tools: ${tools.text.slice(0, 160)}`);
		const get = await rpc('tools/call', { name: 'get_LimitDoc', arguments: { id: 'seeded-row' } }, 5);
		const create = await rpc(
			'tools/call',
			{ name: 'create_LimitDoc', arguments: { id: 'planted-row', body: 'planted' } },
			6
		);
		const refused = (r: { json: any; text: string }) =>
			r.json?.result?.isError === true && /unauthorized|permission|not allowed/i.test(r.text);
		ok(refused(get), `anonymous get_LimitDoc was not refused as unauthorized: ${get.text.slice(0, 300)}`);
		ok(refused(create), `anonymous create_LimitDoc was not refused as unauthorized: ${create.text.slice(0, 300)}`);
		ok(
			!JSON.stringify(get.json ?? get.text).includes('secret-value'),
			`anonymous get_LimitDoc returned the seeded row: ${get.text.slice(0, 300)}`
		);
		const planted = await fetch(new URL('/LimitDoc/planted-row', ctx.harper.httpURL), {
			headers: { authorization: auth },
		});
		strictEqual(planted.status, 404, 'anonymous create_LimitDoc must not land a row');
	});

	test(`E [${mode}] REST honours the same LIMIT (shared getMaxRequestBodySize)`, async () => {
		const restHeaders = { 'content-type': 'application/json', 'authorization': auth };
		const at = await fetch(new URL('/LimitDoc/e-at', ctx.harper.httpURL), {
			method: 'PUT',
			headers: restHeaders,
			body: paddedRecord(LIMIT, 'e-at'),
		});
		ok(
			[200, 201, 204].includes(at.status),
			`REST PUT of exactly LIMIT bytes: ${at.status} ${(await at.text()).slice(0, 120)}`
		);
		const over = await fetch(new URL('/LimitDoc/e-over', ctx.harper.httpURL), {
			method: 'PUT',
			headers: restHeaders,
			body: paddedRecord(LIMIT + 1, 'e-over'),
		});
		const overText = await over.text();
		strictEqual(over.status, 413, `REST PUT of LIMIT+1 bytes: ${over.status} ${overText.slice(0, 120)}`);
		const missing = await fetch(new URL('/LimitDoc/e-over', ctx.harper.httpURL), { headers: { authorization: auth } });
		strictEqual(missing.status, 404, 'the refused PUT did not land');
	});

	test(`E [${mode}] operations-port /mcp: Fastify bodyLimit inherits http.maxRequestBodySize when operationsApi.network.maxRequestBodySize is unset`, async () => {
		// operationsApi.network is `{ ...http, ...operationsApi.network }` (config/configUtils.ts), so Fastify's
		// 1 GB default applies only when http.maxRequestBodySize is also unset; Fastify's 413 has its own body shape
		const at = await post(opsUrl, paddedInitialize(LIMIT), jsonHeaders);
		strictEqual(at.status, 200, `operations initialize of exactly LIMIT bytes: ${at.status} ${at.text.slice(0, 160)}`);
		const r = await post(opsUrl, paddedInitialize(LIMIT + 1), jsonHeaders);
		strictEqual(r.status, 413, `operations /mcp over the inherited limit: ${r.status}`);
	});

	for (const method of ['GET', 'DELETE'] as const) {
		test(`F [${mode}] ${method} /mcp with an oversize chunked body is refused, not hung, and the socket still serves`, async () => {
			const [r1, r2] = await keepAliveAfter413(
				appUrl,
				'/mcp',
				'chunked',
				paddedInitialize(512, 11),
				{ ...jsonHeaders, accept: 'text/event-stream, application/json' },
				method,
				'POST'
			);
			// uWS does not hand a GET body to the handler, so that request is refused as a sessionless GET instead
			const expected = USE_UWS && method === 'GET' ? 400 : 413;
			strictEqual(r1.status, expected, `${method} with an oversize body: ${r1.status} ${r1.body.slice(0, 120)}`);
			if (expected === 413) strictEqual(JSON.parse(r1.body).error, 'payload_too_large');
			strictEqual(r2.status, 200, `follow-up POST on the same socket: ${r2.status} ${r2.body.slice(0, 200)}`);
			strictEqual(JSON.parse(r2.body).id, 11, `the follow-up is answered as itself: ${r2.body.slice(0, 200)}`);
		});
	}
});
