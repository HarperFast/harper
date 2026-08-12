/**
 * Unit tests for the uWS UDS adapter (server/serverHelpers/uwsServer.ts, #914).
 *
 * Exercises the request-construction and response-serialization paths of createUwsServer over a
 * real Unix domain socket, without booting Harper. uWebSockets.js is an optional peer (installed
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
//
// A server that responds early (e.g. 413 for an over-limit body) is allowed to close the connection
// before the client has finished flushing the request body — correct per HTTP, but it races the
// client's outstanding write against the close. Node's http client normally forwards any socket error
// straight to `req`'s own 'error' event — except for the specific window right after a keep-alive
// response finishes, where the client detaches its listener before handing the socket back to the
// agent's free-connection pool and reattaching one (`responseKeepAlive` in Node's `_http_client.js`,
// which has its own upstream `// TODO(ronag): ... the socket has no 'error' handler` comment on exactly
// this gap). A write that fails in that window is unhandled and becomes an uncaught exception
// attributed to whichever test happens to be running — that's the macOS flake this helper exists to
// close. `agent: false` below is therefore the primary fix: without connection pooling, the gap window
// never opens. The socket-level listener is retained as a second layer, in case an equivalent
// unhandled-window exists on a platform/libuv path this can't be verified against from Linux.
//
// Settles exactly once, from whichever channel gets there first:
//   - `req`'s own 'error' event, for as long as the request is attached to its socket (covers
//     everything that can happen before or during a normal response, including a pre-response
//     failure like a missing socket path).
//   - a socket-level 'error' listener, described above. EPIPE/ECONNRESET are exactly the expected
//     shape of the write-vs-close race and are swallowed once the promise has settled; a sibling
//     delivery of the same event that already settled the promise a moment earlier is a no-op, so
//     this can't double-fire for a single error. An unrelated error arriving after settlement can't
//     reject an already-settled promise either way, so it's unavoidably absorbed — logged via
//     udsRequestWarnings (asserted empty in this file's `after`) rather than disappearing silently.
//   - `req`'s 'close' event, if the connection closes without either of the above (e.g. the server
//     commits headers and then aborts mid-body) — otherwise that would hang until Mocha's timeout.
//
// Uses a fresh connection per call (`agent: false`) rather than Node's default keep-alive pooling, both
// for the reason above and because this file issues many requests against the same socketPath, and a
// shared pooled socket would carry the socket listener across requests and accumulate one per call.
// Errors udsRequest couldn't fail the promise with because it arrived after settlement — see the
// helper's docblock. Asserted empty in this file's `after`, so a genuinely broken transport still
// fails the run instead of scrolling past as a log line nobody reads.
const udsRequestWarnings = [];

function udsRequest(socketPath, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		// Node's own socket-error forwarding to `req` always runs before our 'socket' listener below sees
		// the same event (both fire synchronously within one 'error' emission), so an ordinary pre-response
		// failure settles the promise via `req.on('error')` a moment before our listener also observes it —
		// that's an echo of an event already handled, not a new one. `settledThisTick` distinguishes that
		// from a genuinely late arrival (the queued microtask clears it once the current synchronous
		// dispatch is done), so only the latter is worth logging.
		let settledThisTick = false;
		const settleResolve = (value) => {
			if (settled) return;
			settled = true;
			settledThisTick = true;
			queueMicrotask(() => {
				settledThisTick = false;
			});
			resolve(value);
		};
		const settleReject = (err) => {
			if (settled) return;
			settled = true;
			settledThisTick = true;
			queueMicrotask(() => {
				settledThisTick = false;
			});
			reject(err);
		};
		const req = http.request({ socketPath, method, path: pathName, headers, agent: false }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () =>
				settleResolve({
					status: res.statusCode,
					statusMessage: res.statusMessage,
					headers: res.headers,
					body: Buffer.concat(chunks),
				})
			);
		});
		req.on('socket', (socket) => {
			socket.on('error', (err) => {
				if (settled) {
					if (!settledThisTick && err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
						udsRequestWarnings.push(err);
					}
					return;
				}
				if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
				settleReject(err);
			});
		});
		req.on('error', settleReject);
		req.once('close', () => {
			if (!settled) settleReject(new Error('connection closed before response completed'));
		});
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
	let onDispatch; // set per-test to observe when the handler is dispatched

	const handler = async (request) => {
		switch (request.pathname) {
			case '/echo':
				return { status: 200, body: await readBody(request) };
			case '/early':
				// Signal dispatch synchronously (before draining the body) so a test can prove the handler
				// runs while the request body is still arriving — i.e. the body streams, not fully buffered.
				onDispatch?.();
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
			case '/ip':
				return { status: 200, body: String(request.ip) };
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
		assert.deepStrictEqual(udsRequestWarnings, [], 'udsRequest saw an unexpected post-settlement socket error');
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

	it('dispatches the handler before the request body ends (streamed, not fully buffered)', async function () {
		let resolveDispatched;
		const dispatched = new Promise((resolve) => (resolveDispatched = resolve));
		onDispatch = resolveDispatched;
		try {
			// Chunked POST (no content-length): write a first chunk but do NOT end the request yet.
			const req = http.request({ socketPath, method: 'POST', path: '/early' });
			const responded = new Promise((resolve, reject) => {
				req.on('response', (res) => {
					res.resume();
					res.on('end', () => resolve(res.statusCode));
				});
				req.on('error', reject);
			});
			req.flushHeaders(); // put the request on the wire now so uWS routes it without waiting for end()
			req.write('first-chunk');
			// If the body were fully buffered before dispatch, the handler could not run until we end the
			// request — so this resolves only because the request streamed straight through.
			await Promise.race([
				dispatched,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('handler was not dispatched before the body ended')), 2000)
				),
			]);
			req.end('-last-chunk'); // now complete the upload so readBody() resolves and the response is sent
			assert.strictEqual(await responded, 200);
		} finally {
			onDispatch = undefined;
		}
	});

	it('rejects with the underlying error when the connection fails before any response', async function () {
		const missingSocket = path.join(os.tmpdir(), `uws-no-such-socket-${process.pid}.sock`);
		await assert.rejects(udsRequest(missingSocket, { pathName: '/' }), (err) => {
			assert.strictEqual(err.code, 'ENOENT');
			return true;
		});
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
			// A real over-limit upload is always this shape: production's default maxBodyBytes is 100 MiB
			// (server/serverHelpers/uwsServer.ts), so every 413 in practice happens while the client still
			// has bytes queued to send — the write-vs-close race udsRequest is built to tolerate.
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

	it('falls back to X-Forwarded-For for request.ip on the UDS path (no socket peer address)', async function () {
		// On the symphony-fronted UDS path the socket carries no client address, so the trusted proxy's
		// X-Forwarded-For is the authoritative source of request.ip.
		const res = await udsRequest(socketPath, {
			pathName: '/ip',
			headers: { 'x-forwarded-for': '203.0.113.7' },
		});
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.toString(), '203.0.113.7');
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
				handler: async (req) => ({
					status: 200,
					body: req.pathname === '/ip' ? String(req.ip) : req.pathname === '/head' ? 'should-be-suppressed' : 'http',
				}),
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

		it('populates request.ip from the TCP peer address', async function () {
			const body = await new Promise((resolve, reject) => {
				http
					.request({ host: '127.0.0.1', port, path: '/ip' }, (res) => {
						const chunks = [];
						res.on('data', (c) => chunks.push(c));
						res.on('end', () => resolve(Buffer.concat(chunks).toString()));
					})
					.on('error', reject)
					.end();
			});
			assert.strictEqual(body, '127.0.0.1');
		});

		it('does not let a spoofed X-Forwarded-For override the authoritative TCP peer address', async function () {
			// On the direct-TCP path the socket peer IP is authoritative; a client-supplied X-Forwarded-For
			// must be ignored, or a direct client could spoof `127.0.0.1` to satisfy local auth.
			const body = await new Promise((resolve, reject) => {
				http
					.request({ host: '127.0.0.1', port, path: '/ip', headers: { 'x-forwarded-for': '1.2.3.4' } }, (res) => {
						const chunks = [];
						res.on('data', (c) => chunks.push(c));
						res.on('end', () => resolve(Buffer.concat(chunks).toString()));
					})
					.on('error', reject)
					.end();
			});
			assert.strictEqual(body, '127.0.0.1', 'client-supplied XFF must not override the socket peer IP');
		});

		it('suppresses the body for a HEAD request', async function () {
			const res = await new Promise((resolve, reject) => {
				const req = http.request({ host: '127.0.0.1', port, path: '/head', method: 'HEAD' }, (r) => {
					const chunks = [];
					r.on('data', (c) => chunks.push(c));
					r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
				});
				req.on('error', reject);
				req.end();
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.length, 0);
		});

		it('enforces wsMaxPayload by closing a connection that sends an oversized frame', async function () {
			// Regression: registerWsBehavior passed `maxPayload` to app.ws(), but uWS's option key is
			// `maxPayloadLength`, so the configured cap was silently ignored (uWS's 16 KiB default applied).
			const cappedPort = port + 1;
			const cappedServer = await createUwsServer({
				port: cappedPort,
				handler: async () => ({ status: 200, body: 'http' }),
				wsHandler: (ws) => ws.on('message', (data) => ws.send(data)),
				wsMaxPayload: 64,
			});
			try {
				const client = new WebSocket(`ws://127.0.0.1:${cappedPort}/`);
				await new Promise((resolve, reject) => {
					client.on('open', resolve);
					client.on('error', reject);
				});
				const closed = new Promise((resolve) => client.on('close', (code) => resolve(code)));
				client.send(Buffer.alloc(1024));
				const code = await Promise.race([
					closed,
					new Promise((resolve) => setTimeout(() => resolve('no-close'), 2000).unref()),
				]);
				assert.notStrictEqual(code, 'no-close', 'oversized frame must close the connection');
			} finally {
				cappedServer.close();
			}
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
