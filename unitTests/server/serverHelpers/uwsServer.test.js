/**
 * Unit tests for the uWS UDS adapter (server/serverHelpers/uwsServer.ts, #914).
 *
 * Exercises the request-construction and response-serialization paths of createUwsServer over a
 * real Unix domain socket, without booting Harper. uWebSockets.js is an optionalDependency (built
 * by CI); when it isn't installed for the current platform, the whole suite skips.
 */
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');

// A Readable that emits the given chunks one per read() tick (async), then ends.
function chunkStream(chunks) {
	let i = 0;
	return new Readable({
		read() {
			if (i >= chunks.length) return void this.push(null);
			const chunk = chunks[i++];
			setImmediate(() => this.push(chunk));
		},
	});
}

let createUwsServer;
let uwsAvailable = true;
try {
	require('uWebSockets.js');
	({ createUwsServer } = require('#src/server/serverHelpers/uwsServer'));
} catch {
	uwsAvailable = false;
}

// Issue an HTTP/1.1 request over a Unix domain socket and collect the full response.
function udsRequest(socketPath, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ socketPath, method, path: pathName, headers }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () =>
				resolve({
					status: res.statusCode,
					statusMessage: res.statusMessage,
					headers: res.headers,
					body: Buffer.concat(chunks),
				})
			);
		});
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

// Drain a UwsRequest body stream to a Buffer.
function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.body.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
		request.body.on('end', () => resolve(Buffer.concat(chunks)));
		request.body.on('error', reject);
	});
}

(uwsAvailable ? describe : describe.skip)('uWS UDS adapter (createUwsServer)', function () {
	let server;
	let socketPath;

	const handler = async (request) => {
		switch (request.pathname) {
			case '/echo':
				return { status: 200, body: await readBody(request) };
			case '/headers':
				return {
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(request.headers.get('x-dup')),
				};
			case '/sse':
				return {
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
					body: chunkStream(['data: a\n\n', 'data: b\n\n', 'data: c\n\n']),
				};
			case '/stream':
				return {
					status: 200,
					headers: { 'content-type': 'application/octet-stream' },
					body: chunkStream(['X', 'Y', 'Z']),
				};
			case '/bigstream': {
				const chunk = Buffer.alloc(64 * 1024, 0x61); // 64 KiB of 'a'
				return { status: 200, body: chunkStream(Array.from({ length: 64 }, () => chunk)) }; // 4 MiB total
			}
			case '/method':
				return { status: 200, body: 'method=' + request.method };
			case '/boom':
				throw new Error('kaboom');
			case '/teapot':
				return { status: 429 };
			case '/miss':
				return undefined;
			default:
				return { status: 200, body: 'root' };
		}
	};

	before(async function () {
		socketPath = path.join(os.tmpdir(), `uws-adapter-test-${process.pid}.sock`);
		if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
		server = await createUwsServer({ socketPath, handler });
	});

	after(function () {
		if (server) server.close();
		if (socketPath && fs.existsSync(socketPath)) {
			try {
				fs.unlinkSync(socketPath);
			} catch {
				/* best effort */
			}
		}
	});

	it('serves a bodyless GET', async function () {
		const res = await udsRequest(socketPath, { method: 'GET', pathName: '/' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.toString(), 'root');
	});

	it('completes a bodyless OPTIONS without hanging', async function () {
		const res = await udsRequest(socketPath, { method: 'OPTIONS', pathName: '/method' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.toString(), 'method=OPTIONS');
	});

	it('round-trips a multi-chunk POST body byte-for-byte (no ArrayBuffer aliasing)', async function () {
		const payload = Buffer.allocUnsafe(2 * 1024 * 1024);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const res = await udsRequest(socketPath, {
			method: 'POST',
			pathName: '/echo',
			headers: { 'content-length': payload.length },
			body: payload,
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.length, payload.length);
		assert.ok(res.body.equals(payload), 'echoed body must match sent body exactly');
	});

	it('routes a body-bearing QUERY request through the body path', async function () {
		const res = await udsRequest(socketPath, {
			method: 'QUERY',
			pathName: '/echo',
			headers: { 'content-length': 5 },
			body: 'hello',
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.toString(), 'hello');
	});

	it('rejects a body over maxBodyBytes with 413', async function () {
		const overLimitSocket = path.join(os.tmpdir(), `uws-413-test-${process.pid}.sock`);
		if (fs.existsSync(overLimitSocket)) fs.unlinkSync(overLimitSocket);
		const overLimitServer = await createUwsServer({
			socketPath: overLimitSocket,
			maxBodyBytes: 1024,
			handler: async (request) => ({ status: 200, body: await readBody(request) }),
		});
		try {
			const res = await udsRequest(overLimitSocket, {
				method: 'POST',
				pathName: '/echo',
				headers: { 'content-length': 8192 },
				body: Buffer.alloc(8192),
			});
			assert.strictEqual(res.status, 413);
		} finally {
			overLimitServer.close();
			try {
				fs.unlinkSync(overLimitSocket);
			} catch {
				/* best effort */
			}
		}
	});

	it('preserves duplicate request headers as an array', async function () {
		const res = await udsRequest(socketPath, {
			method: 'GET',
			pathName: '/headers',
			headers: { 'x-dup': ['a', 'b'] },
		});
		assert.deepStrictEqual(JSON.parse(res.body.toString()), ['a', 'b']);
	});

	it('streams a text/event-stream (SSE) body, flushing headers up front', async function () {
		const res = await udsRequest(socketPath, { pathName: '/sse' });
		assert.strictEqual(res.status, 200);
		assert.match(res.headers['content-type'], /text\/event-stream/);
		const body = res.body.toString();
		assert.ok(body.startsWith(':\n\n'), 'SSE stream is opened with a comment to flush headers');
		assert.ok(body.includes('data: a\n\n') && body.includes('data: c\n\n'), 'all events delivered');
	});

	it('streams a non-SSE Readable body intact', async function () {
		const res = await udsRequest(socketPath, { pathName: '/stream' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.toString(), 'XYZ');
	});

	it('streams a large body with backpressure, byte-for-byte', async function () {
		const res = await udsRequest(socketPath, { pathName: '/bigstream' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.length, 4 * 1024 * 1024);
		assert.ok(res.body.equals(Buffer.alloc(4 * 1024 * 1024, 0x61)), 'streamed bytes intact under backpressure');
	});

	it('returns 404 when the handler yields no response', async function () {
		const res = await udsRequest(socketPath, { pathName: '/miss' });
		assert.strictEqual(res.status, 404);
	});

	it('maps a thrown handler error to 500 with a reason phrase and message', async function () {
		const res = await udsRequest(socketPath, { pathName: '/boom' });
		assert.strictEqual(res.status, 500);
		assert.ok(res.statusMessage && res.statusMessage.length > 0, 'reason phrase must be non-empty');
		assert.match(res.body.toString(), /kaboom/);
	});

	it('emits a non-empty reason phrase for a less-common status code', async function () {
		const res = await udsRequest(socketPath, { pathName: '/teapot' });
		assert.strictEqual(res.status, 429);
		assert.strictEqual(res.statusMessage, 'Too Many Requests');
	});
});

let WebSocket;
try {
	({ WebSocket } = require('ws'));
} catch {
	/* ws is a core dependency; skip if somehow absent */
}

(uwsAvailable && WebSocket ? describe : describe.skip)(
	'uWS WebSocket adapter (createUwsServer wsHandler)',
	function () {
		let server;
		const port = 34100 + (process.pid % 1500); // avoid collisions across concurrent suites
		const opened = [];

		before(async function () {
			server = await createUwsServer({
				port,
				handler: async () => ({ status: 200, body: 'http' }),
				wsHandler: (ws, upgrade) => {
					opened.push({ url: upgrade.url, auth: upgrade.headers.authorization, ip: upgrade.ip });
					ws.on('message', (data) => ws.send(Buffer.concat([Buffer.from('echo:'), data])));
					ws.send('welcome'); // text frame
				},
			});
		});

		after(function () {
			if (server) server.close();
		});

		it('serves plain HTTP on the same port as WebSocket', async function () {
			const body = await new Promise((resolve, reject) => {
				http
					.request({ host: '127.0.0.1', port, path: '/' }, (res) => {
						const chunks = [];
						res.on('data', (c) => chunks.push(c));
						res.on('end', () => resolve(Buffer.concat(chunks).toString()));
					})
					.on('error', reject)
					.end();
			});
			assert.strictEqual(body, 'http');
		});

		it('accepts an upgrade, exposes url/headers/ip, and round-trips text and binary frames', function (done) {
			const client = new WebSocket(`ws://127.0.0.1:${port}/sub?x=1`, { headers: { authorization: 'Bearer t' } });
			const frames = [];
			client.on('open', () => client.send(Buffer.from([1, 2, 3])));
			client.on('message', (data, isBinary) => {
				frames.push({ isBinary, data: Buffer.from(data) });
				if (frames.length >= 2) client.close(1000, 'bye');
			});
			client.on('error', done);
			client.on('close', (code) => {
				try {
					assert.strictEqual(opened[0].url, '/sub?x=1');
					assert.strictEqual(opened[0].auth, 'Bearer t');
					assert.strictEqual(opened[0].ip, '127.0.0.1');
					assert.strictEqual(frames[0].data.toString(), 'welcome');
					assert.ok(frames[1].data.equals(Buffer.concat([Buffer.from('echo:'), Buffer.from([1, 2, 3])])));
					assert.strictEqual(code, 1000);
					done();
				} catch (error) {
					done(error);
				}
			});
		});
	}
);
