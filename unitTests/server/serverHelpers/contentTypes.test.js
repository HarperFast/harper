'use strict';

const assert = require('node:assert');
const http = require('node:http');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const {
	contentTypes,
	findBestSerializer,
	waitForStreamStartup,
	discardSerializedStream,
} = require('#src/server/serverHelpers/contentTypes');
const { pipeBodyToResponse } = require('#src/server/http');

function streamToString(readable) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		readable.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		readable.on('end', () => resolve(Buffer.concat(chunks).toString()));
		readable.on('error', reject);
	});
}

describe('contentTypes – application/x-ndjson', function () {
	const handler = contentTypes.get('application/x-ndjson');
	const handlerAlias = contentTypes.get('application/ndjson');

	describe('registration', function () {
		it('registers application/x-ndjson', function () {
			assert.ok(handler, 'application/x-ndjson should be registered');
		});

		it('registers application/ndjson alias pointing to same handler', function () {
			assert.strictEqual(handlerAlias, handler, 'application/ndjson alias should reference the same handler object');
		});

		it('has q value of 0.7', function () {
			assert.strictEqual(handler.q, 0.7);
		});
	});

	describe('serialize (non-streaming)', function () {
		it('serializes a plain object as JSON followed by newline', function () {
			const result = handler.serialize({ a: 1, b: 'two' });
			assert.strictEqual(result, '{"a":1,"b":"two"}\n');
		});

		it('serializes an array as JSON followed by newline', function () {
			const result = handler.serialize([1, 2, 3]);
			assert.strictEqual(result, '[1,2,3]\n');
		});
	});

	describe('serializeStream – sync iterator', function () {
		it('emits one JSON line per item from a sync iterable', async function () {
			const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
			const readable = handler.serializeStream(items);
			const output = await streamToString(readable);
			const lines = output.trim().split('\n');
			assert.strictEqual(lines.length, 3);
			assert.deepStrictEqual(JSON.parse(lines[0]), { id: 1 });
			assert.deepStrictEqual(JSON.parse(lines[1]), { id: 2 });
			assert.deepStrictEqual(JSON.parse(lines[2]), { id: 3 });
		});

		it('emits one JSON line per element from a plain array (streaming path)', async function () {
			// Arrays are iterables, so they take the streaming path and each element becomes a line
			const readable = handler.serializeStream([{ a: 1 }, { a: 2 }]);
			const output = await streamToString(readable);
			const lines = output.trim().split('\n');
			assert.strictEqual(lines.length, 2);
			assert.deepStrictEqual(JSON.parse(lines[0]), { a: 1 });
			assert.deepStrictEqual(JSON.parse(lines[1]), { a: 2 });
		});

		it('serializes a scalar (non-iterable) as a single JSON line', function () {
			const result = handler.serializeStream({ x: 42 });
			// plain object with no Symbol.iterator – falls through to single serialize
			assert.strictEqual(result, '{"x":42}\n');
		});
	});

	describe('serializeStream – async iterator', function () {
		it('streams one JSON line per item from an async generator', async function () {
			async function* source() {
				yield { seq: 'a' };
				yield { seq: 'b' };
			}

			const readable = handler.serializeStream(source());
			const output = await streamToString(readable);
			const lines = output.trim().split('\n');
			assert.strictEqual(lines.length, 2);
			assert.deepStrictEqual(JSON.parse(lines[0]), { seq: 'a' });
			assert.deepStrictEqual(JSON.parse(lines[1]), { seq: 'b' });
		});

		it('surfaces an immediate first-step failure during startup', async function () {
			async function* source() {
				yield* [];
				throw new Error('startup failed');
			}

			const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
			await assert.rejects(waitForStreamStartup(readable), /startup failed/);
			assert.strictEqual(readable.destroyed, true);
		});

		it('writes a terminal error record after the startup window', async function () {
			async function* source() {
				await new Promise((resolve) => setTimeout(resolve, 10));
				yield* [];
				throw new Error('delayed failure');
			}

			const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
			await waitForStreamStartup(readable);
			assert.deepStrictEqual(JSON.parse((await streamToString(readable)).trim()), {
				$harperStreamError: { error: 'Error', message: 'delayed failure' },
			});
		});

		it('writes a terminal error record after the first item', async function () {
			async function* source() {
				yield { seq: 'a' };
				const error = new Error('mid-stream failure');
				error.statusCode = 409;
				throw error;
			}

			const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
			await waitForStreamStartup(readable);
			assert.deepStrictEqual(
				(await streamToString(readable))
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line)),
				[{ seq: 'a' }, { $harperStreamError: { error: 'Error', message: 'mid-stream failure', status: 409 } }]
			);
		});

		it('uses a stable error code when one is available', async function () {
			async function* source() {
				yield { seq: 'a' };
				const error = new Error('coded failure');
				error.code = 'STREAM_SOURCE_FAILED';
				throw error;
			}

			const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
			await waitForStreamStartup(readable);
			const records = (await streamToString(readable))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			assert.deepStrictEqual(records[1], {
				$harperStreamError: { error: 'STREAM_SOURCE_FAILED', message: 'coded failure' },
			});
		});

		it('uses an in-band error record for a mutating request even when the first step rejects immediately', async function () {
			async function* source() {
				yield* [];
				throw new Error('committed mutation failed');
			}

			const readable = handler.serializeStream(source(), undefined, { method: 'POST' });
			assert.deepStrictEqual(JSON.parse((await streamToString(readable)).trim()), {
				$harperStreamError: { error: 'Error', message: 'committed mutation failed' },
			});
		});

		it('does not start a generator for HEAD serialization', async function () {
			let nextCalled = false;
			let returned = false;
			const source = {
				[Symbol.asyncIterator]() {
					return {
						next() {
							nextCalled = true;
							return Promise.resolve({ value: { seq: 'a' }, done: false });
						},
						return() {
							returned = true;
							return Promise.resolve({ done: true });
						},
					};
				},
			};

			const readable = handler.serializeStream(source, undefined, { method: 'HEAD' });
			discardSerializedStream(readable);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(nextCalled, false);
			assert.strictEqual(returned, true);
		});
	});

	describe('deserialize', function () {
		it('parses a buffer of newline-delimited JSON into an array', function () {
			const input = Buffer.from('{"x":1}\n{"x":2}\n{"x":3}\n');
			const result = handler.deserialize(input);
			assert.deepStrictEqual(result, [{ x: 1 }, { x: 2 }, { x: 3 }]);
		});

		it('handles trailing whitespace / blank lines gracefully', function () {
			const input = Buffer.from('{"a":true}\n\n{"b":false}\n  \n');
			const result = handler.deserialize(input);
			assert.deepStrictEqual(result, [{ a: true }, { b: false }]);
		});

		it('handles interior whitespace-only lines without throwing', function () {
			const input = Buffer.from('{"a":1}\n   \n{"a":2}\n');
			const result = handler.deserialize(input);
			assert.deepStrictEqual(result, [{ a: 1 }, { a: 2 }]);
		});

		it('round-trips: serialize then deserialize recovers original object', function () {
			const original = { name: 'harper', version: 4 };
			const serialized = Buffer.from(handler.serialize(original));
			const [recovered] = handler.deserialize(serialized);
			assert.deepStrictEqual(recovered, original);
		});
	});

	describe('content negotiation via findBestSerializer', function () {
		it('selects application/x-ndjson when requested in Accept header', function () {
			const fakeRequest = { headers: { accept: 'application/x-ndjson' } };
			const { serializer, type } = findBestSerializer(fakeRequest);
			assert.strictEqual(type, 'application/x-ndjson');
			assert.strictEqual(serializer, handler);
		});

		it('selects application/ndjson alias when requested', function () {
			const fakeRequest = { headers: { accept: 'application/ndjson' } };
			const { type } = findBestSerializer(fakeRequest);
			assert.strictEqual(type, 'application/ndjson');
		});

		it('prefers application/cbor (q=1) over application/x-ndjson (q=0.7) when both offered', function () {
			const fakeRequest = { headers: { accept: 'application/x-ndjson, application/cbor' } };
			const { type } = findBestSerializer(fakeRequest);
			assert.strictEqual(type, 'application/cbor');
		});
	});
});

describe('contentTypes – text/event-stream (SSE)', function () {
	const handler = contentTypes.get('text/event-stream');

	it('serializes each line of string data as a separate data field', function () {
		const serialized = handler.serialize({ event: 'payload', data: 'first\nsecond\rthird\r\n' });
		assert.strictEqual(serialized, 'event: payload\ndata: first\ndata: second\ndata: third\ndata: \n\n');
		assert.strictEqual(handler.serialize('first\nsecond'), 'data: first\ndata: second\n\n');
		assert.strictEqual(handler.serialize(Symbol('first\nsecond')), 'data: Symbol(first\ndata: second)\n\n');
	});

	it('serializes multiline data after normalizing a native subscription message', function () {
		assert.strictEqual(
			handler.serialize({ value: 'first\nsecond', type: 'update', timestamp: 1 }),
			'event: update\ndata: first\ndata: second\nid: 1\n\n'
		);
		assert.strictEqual(
			handler.serialize({ value: 0, type: 'update', timestamp: 1 }),
			'event: update\ndata: 0\nid: 1\n\n'
		);
	});

	// #1628: a finite async generator streamed to natural completion must close the SSE
	// stream cleanly. transformIterable used to hand the terminal `{ value: undefined,
	// done: true }` step to serialize(), which threw on `undefined.acknowledge` — hanging
	// the response and raising an uncaughtException. The infinite-subscription case never
	// reaches a terminal step, so this went unnoticed.
	it('streams a finite async generator to completion without hanging or throwing', async function () {
		async function* source() {
			yield { seq: 'a' };
			yield { seq: 'b' };
		}
		const readable = handler.serializeStream(source());
		const output = await streamToString(readable);
		const events = output
			.split('\n\n')
			.filter(Boolean)
			.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
		assert.deepStrictEqual(events, [{ seq: 'a' }, { seq: 'b' }]);
	});

	it('streams a finite sync iterable to completion without hanging or throwing', async function () {
		const readable = handler.serializeStream([{ n: 1 }, { n: 2 }]);
		const output = await streamToString(readable);
		const events = output
			.split('\n\n')
			.filter(Boolean)
			.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
		assert.deepStrictEqual(events, [{ n: 1 }, { n: 2 }]);
	});

	it('surfaces an immediate first-step failure during startup', async function () {
		async function* source() {
			yield* [];
			throw new Error('startup failed');
		}

		const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
		await assert.rejects(waitForStreamStartup(readable), /startup failed/);
		assert.strictEqual(readable.destroyed, true);
	});

	it('writes a named terminal error event after the startup window', async function () {
		async function* source() {
			await new Promise((resolve) => setTimeout(resolve, 10));
			yield* [];
			throw new Error('delayed failure');
		}

		const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
		await waitForStreamStartup(readable);
		assert.strictEqual(
			await streamToString(readable),
			'event: harper-error\ndata: {"error":"Error","message":"delayed failure"}\n\n'
		);
	});

	it('does not acknowledge the first message until the stream is consumed', async function () {
		let acknowledged = false;
		async function* source() {
			yield { seq: 'a', acknowledge: () => (acknowledged = true) };
		}

		const readable = handler.serializeStream(source(), undefined, { method: 'GET' });
		await waitForStreamStartup(readable);
		assert.strictEqual(acknowledged, false);
		await streamToString(readable);
		assert.strictEqual(acknowledged, true);
	});

	it('does not acknowledge a pending first message after cancellation', async function () {
		let resolveStep;
		let acknowledged = false;
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise((resolve) => (resolveStep = resolve)),
					return: () => Promise.resolve({ done: true }),
				};
			},
		};

		const readable = handler.serializeStream(source, undefined, { method: 'GET' });
		discardSerializedStream(readable);
		resolveStep({ value: { acknowledge: () => (acknowledged = true) }, done: false });
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(acknowledged, false);
	});

	it('ends the response without hanging or raising an uncaughtException when the generator throws mid-stream', async function () {
		async function* source() {
			yield { seq: 'a' };
			yield { seq: 'b' };
			throw new Error('boom');
		}

		let uncaughtError;
		const onUncaughtException = (error) => {
			uncaughtError = error;
		};
		process.on('uncaughtException', onUncaughtException);

		const server = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			const body = handler.serializeStream(source());
			pipeBodyToResponse(body, res, '/throw-test', 'CONNECT', performance.now());
		});

		try {
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			const { port } = server.address();

			const output = await new Promise((resolve) => {
				const chunks = [];
				const request = http.get(`http://127.0.0.1:${port}/`, (res) => {
					res.on('data', (chunk) => chunks.push(chunk));
					// the pre-error chunks ('seq: a'/'seq: b') are already flushed by the time the
					// generator throws, so any of these terminal events still lets us verify them
					res.on('end', () => resolve(Buffer.concat(chunks).toString()));
					res.on('error', () => resolve(Buffer.concat(chunks).toString()));
					res.on('close', () => resolve(Buffer.concat(chunks).toString()));
				});
				request.on('error', () => resolve(Buffer.concat(chunks).toString()));
			});

			assert.strictEqual(
				output,
				'data: {"seq":"a"}\n\ndata: {"seq":"b"}\n\nevent: harper-error\ndata: {"error":"Error","message":"boom"}\n\n'
			);
			assert.strictEqual(uncaughtError, undefined, 'generator rejection must not escape as an uncaughtException');
		} finally {
			process.removeListener('uncaughtException', onUncaughtException);
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

describe('contentTypes – an operations-server error to a request that negotiates an event stream', function () {
	const Fastify = require('fastify');
	const { Readable } = require('node:stream');
	const { decode: decodeCbor } = require('cbor-x');
	const { registerContentHandlers } = require('#src/server/serverHelpers/contentTypes');
	const { serverErrorHandler } = require('#js/server/serverHelpers/serverHandlers');

	// The shape chooseOperation throws when the role allowlist refuses an operation.
	const refusal = {
		error: 'This operation is not authorized due to role restrictions and/or invalid database items',
		unauthorized_access: ["Operation 'deploy_component' is not permitted for this role's operations configuration"],
		invalid_schema_items: [],
	};
	const failure = (statusCode, http_resp_msg = refusal) => Object.assign(new Error(), { statusCode, http_resp_msg });

	let app;
	async function serve(handler, hook) {
		app = Fastify();
		registerContentHandlers(app);
		app.setErrorHandler(serverErrorHandler);
		if (hook) app.addHook('preValidation', hook);
		app.post('/', handler);
		await app.ready();
	}
	const post = (accept) =>
		app.inject({ method: 'POST', url: '/', headers: { accept }, payload: { operation: 'deploy_component' } });

	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	for (const statusCode of [400, 401, 403, 500]) {
		it(`answers a ${statusCode} as JSON, not as an event stream`, async function () {
			await serve(async () => {
				throw failure(statusCode);
			});
			const res = await post('text/event-stream');
			assert.strictEqual(res.statusCode, statusCode);
			assert.match(res.headers['content-type'], /^application\/json/);
			assert.deepStrictEqual(JSON.parse(res.body), refusal);
		});
	}

	it('answers a refusal from a request hook as JSON too', async function () {
		await serve(
			async () => ({ ok: true }),
			(request, reply, done) => done(Object.assign(new Error('Login failed'), { statusCode: 401 }))
		);
		const res = await post('text/event-stream');
		assert.strictEqual(res.statusCode, 401);
		assert.match(res.headers['content-type'], /^application\/json/);
		assert.deepStrictEqual(JSON.parse(res.body), { error: 'Login failed' });
	});

	it('still negotiates an event stream for a successful reply', async function () {
		await serve(async () => ({ ok: true }));
		const res = await post('text/event-stream');
		assert.strictEqual(res.statusCode, 200);
		assert.match(res.headers['content-type'], /^text\/event-stream/);
		assert.strictEqual(res.body, 'data: {"ok":true}\n\n');
	});

	it('leaves a stream that set its own event-stream type alone, error events included', async function () {
		const body = 'event: error\ndata: {"message":"install failed"}\n\n';
		await serve(async (request, reply) => {
			reply.header('Content-Type', 'text/event-stream');
			return Readable.from([body]);
		});
		const res = await post('text/event-stream');
		assert.strictEqual(res.statusCode, 200);
		assert.match(res.headers['content-type'], /^text\/event-stream/);
		assert.strictEqual(res.body, body);
	});

	it('leaves an error with an explicit type alone', async function () {
		await serve(async (request, reply) => reply.code(403).type('text/plain').send('refused'));
		const res = await post('text/event-stream');
		assert.strictEqual(res.statusCode, 403);
		assert.match(res.headers['content-type'], /^text\/plain/);
		assert.strictEqual(res.body, 'refused');
	});

	for (const accept of ['application/cbor', 'application/cbor, text/event-stream;q=0.1']) {
		it(`still answers an error as CBOR when that is negotiated (${accept})`, async function () {
			await serve(async () => {
				throw failure(403);
			});
			const res = await post(accept);
			assert.strictEqual(res.statusCode, 403);
			assert.match(res.headers['content-type'], /^application\/cbor/);
			assert.deepStrictEqual(decodeCbor(res.rawPayload), refusal);
		});
	}
});
