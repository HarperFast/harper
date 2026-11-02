/**
 * `http.maxRequestBodySize` on the MCP application endpoint (#3398), on the legs `application.test.ts` (one
 * 11 MB declared body + one 11 MB chunked body at the default limit) does not drive:
 *
 *   A  boundary, declared `Content-Length`: exactly LIMIT bytes is served (200, a JSON-RPC result), LIMIT+1 is
 *      refused with 413 + `{error:'payload_too_large'}` as `application/json`.
 *   B  boundary, chunked (no `Content-Length`): the same two values, streamed in several chunks.
 *   A2 declared precheck: `Content-Length: 5000000` with NO body bytes is answered 413 before any body arrives;
 *      a streamed-only check would wait for bytes that never come (pre-fix the adapter hung to the reader timeout).
 *   B2 chunk boundaries: 1-byte chunks at LIMIT / LIMIT+1, and a two-chunk split straddling the limit
 *      (40000 + 25536 = LIMIT → 200; 40000 + 25537 → 413), so the streamed counter is checked per chunk.
 *   C  connection state after a 413 on one keep-alive socket: an oversize declared (C1) and chunked (C2) body each
 *      followed by a valid request on the SAME socket, answered correctly (no desync, hang or close); the same two
 *      legs against REST (C3/C4) as the parity oracle.
 *   D  refusal order for callers without a valid principal: no credentials under / over the limit, wrong credentials
 *      over the limit (D2 must not be 200; D3 is 401 — credentials settle before the body is read).
 *   D4 what an anonymous MCP session reaches beyond initialize: the seeded row and a planted row stay denied.
 *   E  the other two body readers of one instance: REST PUT at LIMIT / LIMIT+1 (shared `getMaxRequestBodySize`),
 *      and the OPERATIONS-port `/mcp`, whose Fastify `bodyLimit` inherits `http.maxRequestBodySize` when
 *      `operationsApi.network.maxRequestBodySize` is unset (config/configUtils.ts spreads `http` into it).
 *   F  GET and DELETE `/mcp` with an oversize chunked body: refused or answered, never hung; the socket still serves.
 *
 * Red before #3398: A, B, A2, B2, C-MCP ×2, D (the application endpoint buffered any size). The C-REST, D4, E and F
 * arms are parity and liveness controls and pass on both builds. D2 accepts 401|413 and F accepts any 4xx (uWS
 * answers a GET body with 400), so neither pins the refusal order.
 *
 * Server: the Node http server, or uWebSockets.js when the run sets `HARPER_UWS_HTTP=1` (the CI uWS shard does);
 * the instance inherits it, and `mode` in the test names says which ran.
 *
 * Promoted from qa-explorer SQA-73 / SQA-74 (SP-53).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert';
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
	// loopback callers without credentials must NOT be the superuser, or arm D measures the admin
	authentication: { authorizeLocal: false },
};
const skipSuite = process.platform === 'win32';

function basic(user: string, pass: string): string {
	return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** A valid JSON-RPC initialize envelope padded with trailing spaces to exactly `bytes` bytes. */
function paddedInitialize(bytes: number, id = 1): Buffer {
	const core = JSON.stringify({
		jsonrpc: '2.0',
		id,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-body-limit', version: '0' } },
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

/** Two chunks: the first `firstBytes` bytes, then the remainder. */
function splitStream(payload: Buffer, firstBytes: number): ReadableStream<Uint8Array> {
	const parts = [payload.subarray(0, firstBytes), payload.subarray(firstBytes)];
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
						// trailer section ends with an empty line
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

suite('http.maxRequestBodySize on the MCP application endpoint', { skip: skipSuite }, (ctx: ContextWithHarper) => {
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
			const r = await fetch(new URL('/Doc73/', ctx.harper.httpURL), { headers: { authorization: auth } }).catch(
				() => undefined
			);
			if (r && r.status !== 404) break;
			if (Date.now() > deadline) throw new Error('fixture route never became ready');
			await sleep(250);
		}
		console.log(`mcp body limit: server=${mode} limit=${LIMIT}`);
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
		console.log(`A: 413 connection header = ${over.connection}`);
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
		// Pre-fix (main before #3398) the adapter waited for the body, so this request hung until the socket
		// timed out; the declared precheck answers at once. Bound: well under the 20 s reader timeout.
		const socket = await openSocket(appUrl);
		try {
			const pending = readResponses(socket, 1, 20_000);
			const started = Date.now();
			await write(socket, requestHead('POST', '/mcp', appUrl.host, { ...jsonHeaders, 'Content-Length': '5000000' }));
			const [r1] = await pending;
			const elapsed = Date.now() - started;
			console.log(`A2: declared 5000000, no body -> ${r1.status} in ${elapsed} ms :: ${r1.body.slice(0, 120)}`);
			strictEqual(r1.status, 413, `declared-oversize with no body: ${r1.status} ${r1.body.slice(0, 200)}`);
			strictEqual(JSON.parse(r1.body).error, 'payload_too_large');
			ok(elapsed < 5_000, `413 must not wait for body bytes that never arrive: ${elapsed} ms`);
		} finally {
			socket.destroy();
		}
	});

	test(`B2 [${mode}] chunk boundaries: 1-byte chunks and a split straddling the limit count per chunk`, async () => {
		const oneByteAt = await post(appUrl, chunkedStream(paddedInitialize(LIMIT, 21), 1), jsonHeaders);
		strictEqual(oneByteAt.status, 200, `1-byte chunks, LIMIT: ${oneByteAt.status} ${oneByteAt.text.slice(0, 160)}`);
		ok(JSON.parse(oneByteAt.text).result?.protocolVersion, '1-byte-chunked LIMIT-byte initialize returned a result');
		const oneByteOver = await post(appUrl, chunkedStream(paddedInitialize(LIMIT + 1, 22), 1), jsonHeaders);
		strictEqual(
			oneByteOver.status,
			413,
			`1-byte chunks, LIMIT+1: ${oneByteOver.status} ${oneByteOver.text.slice(0, 160)}`
		);
		strictEqual(JSON.parse(oneByteOver.text).error, 'payload_too_large');

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
		console.log(
			`B2: 1-byte LIMIT=${oneByteAt.status} LIMIT+1=${oneByteOver.status}; split ${FIRST}+rest LIMIT=${straddleAt.status} LIMIT+1=${straddleOver.status}`
		);
	});

	// --- C: connection state after a 413 on one keep-alive socket -------------------------------------
	const OVERSIZE = LIMIT * 4;
	const follow = (method: string, host: string, path: string, body: Buffer, extra: Record<string, string>) =>
		Buffer.concat([
			Buffer.from(requestHead(method, path, host, { ...extra, 'Content-Length': String(body.length) })),
			body,
		]);

	async function keepAliveAfter413(
		url: URL,
		path: string,
		first: 'declared' | 'chunked',
		followBody: Buffer,
		extra: Record<string, string>,
		method = 'POST'
	): Promise<RawResponse[]> {
		const socket = await openSocket(url);
		socket.setNoDelay(true);
		const host = url.host;
		try {
			const pending = readResponses(socket, 2, 20_000);
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
			await write(socket, follow(method, host, path, followBody, extra));
			return await pending;
		} finally {
			socket.destroy();
		}
	}

	for (const first of ['declared', 'chunked'] as const) {
		test(`C [${mode}] MCP: a valid request after an oversize ${first} body on the same socket is answered`, async () => {
			const [r1, r2] = await keepAliveAfter413(appUrl, '/mcp', first, paddedInitialize(512, 7), jsonHeaders);
			strictEqual(r1.status, 413, `first response: ${r1.status} ${r1.body.slice(0, 200)}`);
			console.log(
				`C/${first}: 413 headers connection=${r1.headers['connection']} content-length=${r1.headers['content-length']} te=${r1.headers['transfer-encoding']}`
			);
			strictEqual(r2.status, 200, `second response: ${r2.status} ${r2.body.slice(0, 200)}`);
			const frame = JSON.parse(r2.body);
			strictEqual(frame.id, 7, `second response answers the second request: ${r2.body.slice(0, 200)}`);
			ok(frame.result?.protocolVersion, `second response is an initialize result`);
		});

		test(`C [${mode}] REST parity: a valid request after an oversize ${first} body on the same socket is answered`, async () => {
			const restHeaders = { 'content-type': 'application/json', 'authorization': auth };
			const [r1, r2] = await keepAliveAfter413(
				new URL('/', ctx.harper.httpURL),
				`/Doc73/rest-${first}`,
				first,
				paddedRecord(512, `rest-${first}`),
				restHeaders,
				'PUT'
			);
			strictEqual(r1.status, 413, `REST first response: ${r1.status} ${r1.body.slice(0, 200)}`);
			console.log(
				`C-REST/${first}: 413 headers connection=${r1.headers['connection']} body=${JSON.stringify(r1.body.slice(0, 120))}`
			);
			ok(
				r2.status === 200 || r2.status === 201 || r2.status === 204,
				`REST second response: ${r2.status} ${r2.body.slice(0, 200)}`
			);
			const stored = await fetch(new URL(`/Doc73/rest-${first}`, ctx.harper.httpURL), {
				headers: { authorization: auth },
			});
			strictEqual(stored.status, 200, 'the follow-up PUT landed');
		});
	}

	// --- D: which refusal wins for a caller without a valid principal ----------------------------------
	test(`D [${mode}] refusal order: no credentials vs wrong credentials, under and over the limit`, async () => {
		const anon = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
		const wrong = { ...anon, authorization: basic('mcp_body_limit_nobody', 'wrong-pw') };
		const d1 = await post(appUrl, paddedInitialize(512), anon);
		const d2 = await post(appUrl, paddedInitialize(LIMIT + 1), anon);
		const d3 = await post(appUrl, paddedInitialize(LIMIT + 1), wrong);
		console.log(
			`D1 anon/under=${d1.status} D2 anon/over=${d2.status} D3 wrong/over=${d3.status} :: ${d1.text.slice(0, 80)} | ${d2.text.slice(0, 80)} | ${d3.text.slice(0, 80)}`
		);
		ok([200, 401].includes(d1.status), `anonymous under-limit initialize: ${d1.status} ${d1.text.slice(0, 120)}`);
		ok([401, 413].includes(d2.status), `anonymous oversize: ${d2.status}`);
		// an anonymous caller's size refusal must not come AFTER buffering: a 413 here means size was checked
		// before any principal check; a 401 means the auth layer refused first. Either is fine; 200 is not.
		notStrictEqual(d2.status, 200);
		ok([401, 413].includes(d3.status), `wrong-credential oversize: ${d3.status}`);
		// PR order: settleDeferredCredentialRejection runs before readBody, so wrong credentials win over size
		strictEqual(d3.status, 401, `wrong credentials are refused before the body is read`);
		// the instance still serves an authenticated caller afterwards
		const after = await post(appUrl, paddedInitialize(512, 9), jsonHeaders);
		strictEqual(after.status, 200);
	});

	test(`D4 [${mode}] what an anonymous MCP session can reach beyond initialize (recorded; data must stay denied)`, async () => {
		const anon = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
		const seed = await fetch(new URL('/Doc73/seed73', ctx.harper.httpURL), {
			method: 'PUT',
			headers: { 'content-type': 'application/json', 'authorization': auth },
			body: JSON.stringify({ id: 'seed73', body: 'secret-73' }),
		});
		ok([200, 201, 204].includes(seed.status), `seed PUT: ${seed.status}`);
		const init = await fetch(appUrl, { method: 'POST', headers: anon, body: paddedInitialize(512, 1) });
		const initText = await init.text();
		const sessionId = init.headers.get('mcp-session-id');
		console.log(
			`D4 anonymous initialize: ${init.status} session=${sessionId ? 'issued' : 'none'} ${initText.slice(0, 160)}`
		);
		if (init.status !== 200) {
			strictEqual(init.status, 401);
			return;
		}
		const protocolVersion = JSON.parse(initText).result.protocolVersion;
		const rpc = async (method: string, params: Record<string, unknown>, id: number) => {
			const r = await fetch(appUrl, {
				method: 'POST',
				headers: { ...anon, 'mcp-session-id': sessionId!, 'mcp-protocol-version': protocolVersion },
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
		const tools = await rpc('tools/list', {}, 2);
		const toolNames: string[] = tools.json?.result?.tools?.map((t: any) => t.name) ?? [];
		const resources = await rpc('resources/list', {}, 3);
		const uris: string[] = resources.json?.result?.resources?.map((r: any) => r.uri) ?? [];
		const schemaUri = uris.find((u) => u.startsWith('harper://schema/'));
		const schema = schemaUri ? await rpc('resources/read', { uri: schemaUri }, 4) : undefined;
		const get = await rpc('tools/call', { name: 'get_Doc73', arguments: { id: 'seed73' } }, 5);
		const create = await rpc('tools/call', { name: 'create_Doc73', arguments: { id: 'anon73', body: 'planted' } }, 6);
		console.log(
			`D4 anonymous: tools/list=${tools.status} tools=[${toolNames.join(',')}] resources/list=${resources.status} uris=[${uris.join(',')}] schema-read=${schema?.status} ${JSON.stringify(schema?.json?.result ?? schema?.json?.error ?? '').slice(0, 160)} get=${get.status} ${JSON.stringify(get.json?.result ?? get.json?.error ?? '').slice(0, 200)} create=${create.status} ${JSON.stringify(create.json?.result ?? create.json?.error ?? '').slice(0, 160)}`
		);
		const getText = JSON.stringify(get.json ?? get.text);
		ok(!getText.includes('secret-73'), `anonymous get_Doc73 must not return the seeded row: ${getText.slice(0, 300)}`);
		const planted = await fetch(new URL('/Doc73/anon73', ctx.harper.httpURL), { headers: { authorization: auth } });
		strictEqual(planted.status, 404, 'anonymous create_Doc73 must not land a row');
	});

	// --- E: the other two body readers on the same instance ---------------------------------------------
	test(`E [${mode}] REST honours the same LIMIT (shared getMaxRequestBodySize)`, async () => {
		const restHeaders = { 'content-type': 'application/json', 'authorization': auth };
		const at = await fetch(new URL('/Doc73/e-at', ctx.harper.httpURL), {
			method: 'PUT',
			headers: restHeaders,
			body: paddedRecord(LIMIT, 'e-at'),
		});
		ok(
			[200, 201, 204].includes(at.status),
			`REST PUT of exactly LIMIT bytes: ${at.status} ${(await at.text()).slice(0, 120)}`
		);
		const over = await fetch(new URL('/Doc73/e-over', ctx.harper.httpURL), {
			method: 'PUT',
			headers: restHeaders,
			body: paddedRecord(LIMIT + 1, 'e-over'),
		});
		const overText = await over.text();
		strictEqual(over.status, 413, `REST PUT of LIMIT+1 bytes: ${over.status} ${overText.slice(0, 120)}`);
		console.log(`E-REST 413 body: ${JSON.stringify(overText.slice(0, 160))}`);
		const missing = await fetch(new URL('/Doc73/e-over', ctx.harper.httpURL), { headers: { authorization: auth } });
		strictEqual(missing.status, 404, 'the refused PUT did not land');
	});

	test(`E [${mode}] operations-port /mcp: Fastify bodyLimit inherits http.maxRequestBodySize when operationsApi.network.maxRequestBodySize is unset`, async () => {
		// config/configUtils.ts:1225 — operationsApi.network = { ...http, ...operationsApi.network }, so the
		// "1 GB Fastify default" the PR body cites applies only when http.maxRequestBodySize is ALSO unset.
		const at = await post(opsUrl, paddedInitialize(LIMIT), jsonHeaders);
		strictEqual(at.status, 200, `operations initialize of exactly LIMIT bytes: ${at.status} ${at.text.slice(0, 160)}`);
		const r = await post(opsUrl, paddedInitialize(LIMIT + 1), jsonHeaders);
		console.log(`E-ops LIMIT+1 on operations /mcp: ${r.status} content-type=${r.contentType} ${r.text.slice(0, 160)}`);
		strictEqual(r.status, 413, `operations /mcp over the inherited limit: ${r.status}`);
	});

	// --- F: non-POST methods carrying an oversize body -----------------------------------------------------
	for (const method of ['GET', 'DELETE'] as const) {
		test(`F [${mode}] ${method} /mcp with an oversize chunked body is refused or answered, not hung, and the socket still serves`, async () => {
			const started = Date.now();
			const [r1, r2] = await keepAliveAfter413(
				appUrl,
				'/mcp',
				'chunked',
				paddedInitialize(512, 11),
				{ ...jsonHeaders, accept: 'text/event-stream, application/json' },
				method
			);
			console.log(
				`F/${method}: first=${r1.status} in ${Date.now() - started} ms :: ${r1.body.slice(0, 120)} | second(${method})=${r2.status} ${r2.body.slice(0, 100)}`
			);
			ok(r1.status >= 400 && r1.status < 500, `${method} with an oversize body: ${r1.status} ${r1.body.slice(0, 120)}`);
			ok(r2.status >= 200 && r2.status < 500, `follow-up ${method} on the same socket: ${r2.status}`);
		});
	}
});
