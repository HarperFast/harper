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
