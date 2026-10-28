'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const fastify = require('fastify');
const fastifyCompress = require('@fastify/compress');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { reqBodyValidationHandler, serverErrorHandler } = require('#src/server/serverHelpers/serverHandlers');
const requestTimePlugin = require('#src/server/serverHelpers/requestTimePlugin').default;
const { registerContentHandlers } = require('#src/server/serverHelpers/contentTypes');

const INVALID_JSON = 'Invalid JSON.';
const MISSING_OPERATION = "Request body must include an 'operation' property.";

function invoke(req) {
	const calls = [];
	reqBodyValidationHandler(req, {}, (...args) => calls.push(args));
	return calls;
}

describe('reqBodyValidationHandler()', () => {
	const rejected = [
		['no body', undefined, INVALID_JSON],
		['a null body', null, INVALID_JSON],
		['an empty object', {}, INVALID_JSON],
		['an empty array', [], INVALID_JSON],
		['an empty string', '', INVALID_JSON],
		['a string', 'Operation: create_schema', INVALID_JSON],
		['a number', 5, INVALID_JSON],
		['zero', 0, INVALID_JSON],
		['true', true, INVALID_JSON],
		['false', false, INVALID_JSON],
		['an object without an operation', { schema: 'new schema value' }, MISSING_OPERATION],
		['a null operation', { operation: null }, MISSING_OPERATION],
		['a non-empty array', [1], MISSING_OPERATION],
	];

	for (const [description, body, message] of rejected) {
		it(`rejects ${description} with exactly one 400 callback`, () => {
			const calls = invoke({ body });

			assert.equal(calls.length, 1, `done() must be signalled once, got ${calls.length}`);
			const [error, data] = calls[0];
			assert.equal(error.statusCode, 400);
			assert.equal(error.http_resp_msg, message);
			assert.equal(data, null);
		});
	}

	it('does not enumerate a non-object body', () => {
		let enumerated = false;
		const body = new Proxy(function () {}, {
			ownKeys(target) {
				enumerated = true;
				return Reflect.ownKeys(target);
			},
		});
		assert.equal(typeof body, 'function');

		const calls = invoke({ body });

		assert.equal(enumerated, false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0].http_resp_msg, INVALID_JSON);
	});

	for (const operation of ['describe_all', '', 0, false]) {
		it(`passes a body whose operation is ${JSON.stringify(operation)} on with a single successful callback`, () => {
			assert.deepEqual(invoke({ body: { operation } }), [[]]);
		});
	}
});

describe('reqBodyValidationHandler() in the operations API Fastify wiring', () => {
	let app;
	let port;
	let nextHookCalls;
	let routeCalls;
	let warnings;
	let rejections;
	let inheritedRejectionListeners;
	const onRejection = (reason) => rejections.push(reason?.code ?? reason?.message ?? String(reason));

	function post(body) {
		return new Promise((resolve, reject) => {
			const request = http.request(
				{
					host: '127.0.0.1',
					port,
					method: 'POST',
					path: '/',
					agent: false,
					timeout: 5000,
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(body),
						'accept-encoding': 'gzip',
					},
				},
				(response) => {
					const chunks = [];
					response.on('data', (chunk) => chunks.push(chunk));
					response.on('end', () =>
						resolve({ statusCode: response.statusCode, text: Buffer.concat(chunks).toString() })
					);
					response.on('error', reject);
				}
			);
			request.on('timeout', () => request.destroy(new Error('request timed out')));
			request.on('error', reject);
			request.end(body);
		});
	}

	before(async () => {
		// testUtils and mocha rethrow a stray rejection into whichever test is running; this suite records it instead
		inheritedRejectionListeners = process.listeners('unhandledRejection');
		process.removeAllListeners('unhandledRejection');
		process.on('unhandledRejection', onRejection);
		warnings = [];
		app = fastify({ logger: { level: 'warn', stream: { write: (line) => warnings.push(line) } } });
		app.setErrorHandler(serverErrorHandler);
		// the same async onSend hooks the operations server registers keep `reply.sent` false after a rejection
		app.register(requestTimePlugin);
		app.register(fastifyCompress);
		registerContentHandlers(app);
		app.post(
			'/',
			{
				preValidation: [
					reqBodyValidationHandler,
					(req, reply, done) => {
						nextHookCalls++;
						done();
					},
				],
				config: { isOperation: true },
			},
			async () => {
				routeCalls++;
				return { ok: true };
			}
		);
		await app.listen({ port: 0, host: '127.0.0.1' });
		port = app.server.address().port;
	});

	beforeEach(() => {
		nextHookCalls = 0;
		routeCalls = 0;
		warnings.length = 0;
		rejections = [];
	});

	after(async () => {
		process.off('unhandledRejection', onRejection);
		for (const listener of inheritedRejectionListeners) process.on('unhandledRejection', listener);
		await app?.close();
	});

	const refused = [
		['an empty object', '{}', INVALID_JSON],
		['an object without an operation', '{"x":1}', MISSING_OPERATION],
		['null', 'null', INVALID_JSON],
		['an empty array', '[]', INVALID_JSON],
		['a string', '"a string"', INVALID_JSON],
		['a number', '5', INVALID_JSON],
	];

	for (const [description, payload, message] of refused) {
		it(`answers ${description} with one 400 and never reaches the next hook or the route`, async () => {
			const response = await post(payload);
			// a duplicate completion lands in the same tick as the first; the wait covers the late failures it causes
			await sleep(100);

			assert.equal(response.statusCode, 400);
			assert.deepEqual(JSON.parse(response.text), { error: message });
			assert.equal(nextHookCalls, 0, 'the hook after the validator ran for a rejected body');
			assert.equal(routeCalls, 0);
			assert.deepEqual(rejections, []);
			assert.deepEqual(warnings, []);
		});
	}

	it('runs the next hook and the route once for a valid body', async () => {
		const response = await post('{"operation":"describe_all"}');
		await sleep(100);

		assert.equal(response.statusCode, 200);
		assert.deepEqual(JSON.parse(response.text), { ok: true });
		assert.equal(nextHookCalls, 1);
		assert.equal(routeCalls, 1);
		assert.deepEqual(rejections, []);
		assert.deepEqual(warnings, []);
	});
});
