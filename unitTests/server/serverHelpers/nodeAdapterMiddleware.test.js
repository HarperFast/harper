'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { setTimeout: sleep } = require('node:timers/promises');
const onFinished = require('on-finished');
const onHeaders = require('on-headers');
const send = require('send');
const { Request } = require('#src/server/serverHelpers/Request');
const { toWriteHeadHeaders } = require('#src/server/serverHelpers/Headers');
const { pipeBodyToResponse } = require('#src/server/http');

// Base64 of random bytes: compressible enough for `compression` to engage, incompressible enough
// that the gzip output (about 75% of the input) also crosses the response stream's high-water mark
// (64 KiB on Node >= 22), so both the zlib input queue and the response body exert backpressure.
const BODY = Buffer.from(crypto.randomBytes(240 * 1024).toString('base64'));
const CHUNK_SIZE = 4096;

// Next.js vendors compression 1.7.4, which gates on `_header` / `_implicitHeader()`; 1.8 gates on
// `headersSent` / `writeHead()`. Both are the real package.
const COMPRESSION_VERSIONS = [
	['compression 1.8', require('compression')],
	['compression 1.7.4', require('compression-1.7')],
];

// A regression here stalls instead of throwing (harper#2527) and .mocharc.json disables mocha's
// timeout, so every wait is bounded.
function withTimeout(promise, waitingFor, ms = 5000) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${waitingFor}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Reads one chunk per macrotask so a producer overruns the high-water mark.
async function collectSlowly(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
		await sleep(1);
	}
	return Buffer.concat(chunks);
}

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function waitUntil(condition, waitingFor) {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${waitingFor}`);
		await sleep(1);
	}
}

async function serve(handler, run) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		return await run(server.address().port);
	} finally {
		server.close();
	}
}

function get(port, headers = {}) {
	return withTimeout(
		new Promise((resolve, reject) =>
			http.get({ host: '127.0.0.1', port, path: '/asset.txt', headers }, resolve).on('error', reject)
		),
		'the HTTP response'
	);
}

async function writeInChunks(res) {
	let backpressured = 0;
	let drained;
	res.on('drain', () => drained?.resolve());
	for (let offset = 0; offset < BODY.length; offset += CHUNK_SIZE) {
		if (!res.write(BODY.subarray(offset, offset + CHUNK_SIZE))) {
			backpressured++;
			drained = Promise.withResolvers();
			await withTimeout(drained.promise, "'drain' after write() returned false");
		}
	}
	res.end();
	return backpressured;
}

// Records whether the response's own write() (beneath any middleware patch) reported backpressure.
function observeResponseBackpressure(res) {
	const state = { backpressured: false };
	const write = res.write;
	res.write = function (...args) {
		const ok = write.apply(this, args);
		if (ok === false) state.backpressured = true;
		return ok;
	};
	return state;
}

describe('withNodeAdapter with real Node middleware', function () {
	const sockets = [];
	let fileDir;

	before(function () {
		fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-node-adapter-'));
		fs.writeFileSync(path.join(fileDir, 'asset.txt'), BODY);
	});
	after(function () {
		fs.rmSync(fileDir, { recursive: true, force: true });
	});
	afterEach(function () {
		for (const socket of sockets.splice(0)) socket.destroy();
	});

	function makeRequest(headers = {}) {
		const socket = new net.Socket();
		sockets.push(socket);
		return new Request(
			{
				method: 'GET',
				url: '/asset.txt',
				httpVersion: '1.1',
				headers: { 'host': 'example.com', 'accept-encoding': 'gzip', ...headers },
				socket,
				on() {
					return this;
				},
				pipe() {},
			},
			{}
		);
	}

	for (const [label, compression] of COMPRESSION_VERSIONS) {
		describe(label, function () {
			it('gzips a streamed body past the high-water mark with backpressure on zlib and the response', async function () {
				const request = makeRequest();
				let zlibBackpressure;
				let responseBackpressure;
				const responsePromise = request.withNodeAdapter((req, res) => {
					responseBackpressure = observeResponseBackpressure(res);
					compression()(req, res, async () => {
						res.setHeader('Content-Type', 'text/plain; charset=utf-8');
						zlibBackpressure = await writeInChunks(res);
					});
				});

				const { status, headers, body } = await withTimeout(responsePromise, 'response headers');
				assert.strictEqual(status, 200);
				assert.strictEqual(headers.get('content-encoding'), 'gzip');
				assert.strictEqual(headers.get('content-length'), undefined);
				assert.match(String(headers.get('vary')), /Accept-Encoding/);
				// Nothing reads yet, so the producer must stall on the response stream itself, not only on zlib.
				await waitUntil(() => responseBackpressure.backpressured, 'the response stream to report backpressure');

				const received = await withTimeout(collectSlowly(body), 'the response body');
				assert.ok(zlibBackpressure > 0, 'res.write() never returned false');
				assert.deepStrictEqual(zlib.gunzipSync(received), BODY);
			});

			it('serves a file past the high-water mark through send() without on-finished tearing it down', async function () {
				const request = makeRequest();
				const finished = Promise.withResolvers();
				let finishedEarly = false;
				const responsePromise = request.withNodeAdapter((req, res) => {
					onFinished(res, (error) => {
						finishedEarly = !res.writableEnded;
						finished.resolve(error);
					});
					compression()(req, res, () => {
						send(req, '/asset.txt', { root: fileDir }).pipe(res);
					});
				});

				const { status, headers, body } = await withTimeout(responsePromise, 'response headers');
				assert.strictEqual(status, 200);
				assert.match(headers.get('content-type'), /^text\/plain/);
				assert.ok(headers.get('etag'));
				assert.strictEqual(headers.get('content-encoding'), 'gzip');
				assert.strictEqual(
					headers.get('content-length'),
					undefined,
					'send() set Content-Length; compression removed it'
				);

				const received = await withTimeout(collectSlowly(body), 'the response body');
				assert.deepStrictEqual(zlib.gunzipSync(received), BODY);
				assert.strictEqual(await withTimeout(finished.promise, 'on-finished'), null);
				assert.strictEqual(finishedEarly, false, 'on-finished ran before the response ended');
			});

			it('passes a response the client cannot decode through unchanged', async function () {
				const request = makeRequest({ 'accept-encoding': 'identity' });
				let backpressured;
				const responsePromise = request.withNodeAdapter((req, res) => {
					compression()(req, res, async () => {
						res.setHeader('Content-Type', 'text/plain; charset=utf-8');
						backpressured = await writeInChunks(res);
					});
				});

				const { headers, body } = await withTimeout(responsePromise, 'response headers');
				assert.strictEqual(headers.get('content-encoding'), undefined);
				await waitUntil(() => backpressured === undefined && body.writableNeedDrain, 'the producer to stall');
				const received = await withTimeout(collectSlowly(body), 'the response body');
				assert.ok(backpressured > 0, 'res.write() never returned false');
				assert.deepStrictEqual(received, BODY);
			});

			it('delivers gzip bytes on the wire through ServerResponse and pipeBodyToResponse', async function () {
				await serve(
					async (nodeRequest, nodeResponse) => {
						const request = new Request(nodeRequest, nodeResponse);
						const { status, headers, body } = await request.withNodeAdapter((req, res) => {
							compression()(req, res, () => {
								send(req, '/asset.txt', { root: fileDir }).pipe(res);
							});
						});
						nodeResponse.writeHead(status, toWriteHeadHeaders(headers));
						pipeBodyToResponse(body, nodeResponse, '/asset.txt', 'GET', performance.now());
					},
					async (port) => {
						const response = await get(port, { 'accept-encoding': 'gzip' });
						assert.strictEqual(response.statusCode, 200);
						assert.strictEqual(response.headers['content-encoding'], 'gzip');
						assert.strictEqual(response.headers['content-length'], undefined);
						const received = await withTimeout(collectSlowly(response), 'the wire body');
						assert.deepStrictEqual(zlib.gunzipSync(received), BODY);
					}
				);
			});
		});
	}

	it('destroys the response and fires on-finished when the client disconnects mid-transfer on the wire', async function () {
		const closed = Promise.withResolvers();
		const finished = Promise.withResolvers();
		let request;
		await serve(
			async (nodeRequest, nodeResponse) => {
				request = new Request(nodeRequest, nodeResponse);
				const { status, headers, body } = await request.withNodeAdapter((req, res) => {
					onFinished(res, (error) => finished.resolve(error));
					res.once('close', () => closed.resolve());
					res.setHeader('Content-Type', 'application/octet-stream');
					res.write(BODY.subarray(0, CHUNK_SIZE));
				});
				nodeResponse.writeHead(status, toWriteHeadHeaders(headers));
				pipeBodyToResponse(body, nodeResponse, '/asset.txt', 'GET', performance.now());
			},
			async (port) => {
				const response = await get(port);
				await withTimeout(new Promise((resolve) => response.once('data', resolve)), 'the first chunk');
				response.destroy();
				await withTimeout(closed.promise, "'close' on the adapter response");
				await withTimeout(finished.promise, 'on-finished');
				assert.strictEqual(request.signal.aborted, true);
			}
		);
	});

	it('destroys the connection when a timeout set without a listener fires, as Node does', async function () {
		const closed = Promise.withResolvers();
		await serve(
			async (nodeRequest, nodeResponse) => {
				const request = new Request(nodeRequest, nodeResponse);
				const { status, headers, body } = await request.withNodeAdapter((req, res) => {
					res.once('close', () => closed.resolve());
					res.setTimeout(50);
					res.write('partial');
				});
				nodeResponse.writeHead(status, toWriteHeadHeaders(headers));
				pipeBodyToResponse(body, nodeResponse, '/asset.txt', 'GET', performance.now());
			},
			async (port) => {
				const response = await get(port);
				await withTimeout(new Promise((resolve) => response.once('close', resolve)), 'the connection to drop');
				assert.strictEqual(response.complete, false);
				await withTimeout(closed.promise, "'close' on the adapter response");
			}
		);
	});

	it("delivers a timeout to the response's own listener and leaves the connection to it", async function () {
		await serve(
			async (nodeRequest, nodeResponse) => {
				const request = new Request(nodeRequest, nodeResponse);
				const { status, headers, body } = await request.withNodeAdapter((req, res) => {
					res.setTimeout(50, () => res.end('late'));
					res.write('partial,');
				});
				nodeResponse.writeHead(status, toWriteHeadHeaders(headers));
				pipeBodyToResponse(body, nodeResponse, '/asset.txt', 'GET', performance.now());
			},
			async (port) => {
				const response = await get(port);
				const received = await withTimeout(collect(response), 'the wire body');
				assert.strictEqual(received.toString(), 'partial,late');
			}
		);
	});

	it('honors Writable backpressure and emits finish before close when a Readable is piped in', async function () {
		const request = makeRequest();
		const events = [];
		let backpressure;
		const responsePromise = request.withNodeAdapter((req, res) => {
			backpressure = observeResponseBackpressure(res);
			res.on('finish', () => events.push('finish'));
			res.on('close', () => events.push('close'));
			res.setHeader('Content-Type', 'application/octet-stream');
			const chunks = [];
			for (let offset = 0; offset < BODY.length; offset += CHUNK_SIZE)
				chunks.push(BODY.subarray(offset, offset + CHUNK_SIZE));
			Readable.from(chunks).pipe(res);
		});

		const { body } = await withTimeout(responsePromise, 'response headers');
		await waitUntil(() => backpressure.backpressured, 'the response stream to report backpressure');
		const received = await withTimeout(collectSlowly(body), 'the response body');
		assert.deepStrictEqual(received, BODY);
		assert.ok(backpressure.backpressured, 'write() never returned false');
		await sleep(1);
		assert.deepStrictEqual(events, ['finish', 'close']);
	});

	it('runs on-headers listeners inside _implicitHeader() before the headers resolve', async function () {
		const request = makeRequest();
		const order = [];
		const responsePromise = request.withNodeAdapter((req, res) => {
			onHeaders(res, () => {
				order.push('listener');
				res.setHeader('X-From-Listener', 'yes');
			});
			res.setHeader('Content-Type', 'text/plain');
			assert.strictEqual(res.headersSent, false);
			assert.strictEqual(res._header, null);
			res._implicitHeader();
			order.push('after _implicitHeader');
			assert.strictEqual(res.headersSent, true);
			assert.match(res._header, /^HTTP\/1\.1 200 OK\r\nContent-Type: text\/plain\r\nX-From-Listener: yes\r\n\r\n$/);
			res.end('ok');
		});

		const { headers } = await withTimeout(responsePromise, 'response headers');
		order.push('resolved');
		assert.deepStrictEqual(order, ['listener', 'after _implicitHeader', 'resolved']);
		assert.strictEqual(headers.get('x-from-listener'), 'yes');
	});

	it('accumulates appendHeader values and routes writeHead flat arrays through on-headers', async function () {
		const request = makeRequest();
		const responsePromise = request.withNodeAdapter((req, res) => {
			onHeaders(res, () => {});
			res.appendHeader('Set-Cookie', 'a=1');
			res.appendHeader('Set-Cookie', 'b=2');
			res.appendHeader('X-Single', 'one');
			res.writeHead(201, ['X-Flat', '1', 'X-Flat', '2']);
			res.end();
		});

		const { status, headers } = await withTimeout(responsePromise, 'response headers');
		assert.strictEqual(status, 201);
		assert.deepStrictEqual(headers.get('set-cookie'), ['a=1', 'b=2']);
		assert.strictEqual(headers.get('x-single'), 'one');
		assert.deepStrictEqual(headers.get('x-flat'), ['1', '2']);
	});

	it('exposes request headers on a plain object with Object.prototype', async function () {
		const request = makeRequest();
		const responsePromise = request.withNodeAdapter((req, res) => {
			assert.strictEqual(Object.getPrototypeOf(req.headers), Object.prototype);
			assert.strictEqual(Object.hasOwn(req.headers, 'accept-encoding'), true);
			res.end();
		});
		await withTimeout(responsePromise, 'response headers');
	});

	it('rejects header mutation after headers are sent, leaving the captured headers unchanged', async function () {
		const request = makeRequest();
		const responsePromise = request.withNodeAdapter((req, res) => {
			onHeaders(res, () => {});
			res.setHeader('Content-Type', 'text/plain');
			res.write('x');
			assert.throws(() => res.setHeader('X-Late', '1'), { code: 'ERR_HTTP_HEADERS_SENT' });
			assert.throws(() => res.appendHeader('X-Late', '1'), { code: 'ERR_HTTP_HEADERS_SENT' });
			assert.throws(() => res.removeHeader('Content-Type'), { code: 'ERR_HTTP_HEADERS_SENT' });
			// on-headers applies writeHead's headers through setHeader before the adapter's own no-op
			assert.throws(() => res.writeHead(500, { 'Content-Length': '1' }), { code: 'ERR_HTTP_HEADERS_SENT' });
			res.end();
		});

		const { status, headers, body } = await withTimeout(responsePromise, 'response headers');
		await withTimeout(collect(body), 'the response body');
		assert.strictEqual(status, 200);
		assert.strictEqual(headers.get('content-type'), 'text/plain');
		assert.strictEqual(headers.get('x-late'), undefined);
		assert.strictEqual(headers.get('content-length'), undefined);
	});

	it('survives a destroy immediately after writeHead and reports it through the body', async function () {
		const request = makeRequest();
		const responsePromise = request.withNodeAdapter((req, res) => {
			res.writeHead(200);
			res.destroy(new Error('connection reset'));
		});

		const { body } = await withTimeout(responsePromise, 'response headers');
		await assert.rejects(withTimeout(collect(body), 'the response body'), /connection reset/);
	});

	it('closes the response and rejects when the client disconnects before headers', async function () {
		const request = makeRequest();
		const closed = Promise.withResolvers();
		const responsePromise = request.withNodeAdapter((req, res) => {
			res.once('close', () => closed.resolve());
		});
		request._abort();

		await assert.rejects(withTimeout(responsePromise, 'rejection'), { name: 'AbortError' });
		await withTimeout(closed.promise, "'close' on the response");
	});

	it('closes the body without an error when the client disconnects during a stalled write', async function () {
		const request = makeRequest();
		const stalled = Promise.withResolvers();
		const responsePromise = request.withNodeAdapter((req, res) => {
			let offset = 0;
			while (res.write(BODY.subarray(offset, offset + CHUNK_SIZE))) offset += CHUNK_SIZE;
			stalled.resolve();
		});

		const { body } = await withTimeout(responsePromise, 'response headers');
		await withTimeout(stalled.promise, 'the producer to stall');
		request._abort();
		await assert.rejects(withTimeout(collect(body), 'the response body'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
		assert.strictEqual(body.errored, null);
	});
});
