'use strict';

require('../testUtils.js').preTestPrep();
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { httpServer, makeUwsHandler } = require('#src/server/http');

let nextPort = 19620;

// The body the uWS handler hands the adapter for each kind of body a handler returns.
describe('uWS handler response bodies', function () {
	function handlerReturning(body) {
		const port = nextPort++;
		httpServer(() => ({ status: 200, body }), { port, name: `uwsBodies${port}` });
		const handle = makeUwsHandler(port, false);
		return () => Promise.resolve(handle({ method: 'GET', url: '/', headers: new Headers(), isAborted: false }));
	}

	for (const [kind, body] of [
		['a string', 'text'],
		['a Buffer', Buffer.from('bytes')],
		['a Uint8Array', new Uint8Array([1, 2, 3])],
	]) {
		it(`passes ${kind} through as the same object`, async function () {
			const response = await handlerReturning(body)();
			assert.strictEqual(response.body, body);
			assert.strictEqual(response.status, 200);
		});
	}

	for (const [kind, body] of [
		['null', null],
		['undefined', undefined],
	]) {
		it(`sends no body for ${kind}`, async function () {
			assert.strictEqual((await handlerReturning(body)()).body, null);
		});
	}

	it('resolves a promised body', async function () {
		assert.strictEqual((await handlerReturning(Promise.resolve('later'))()).body, 'later');
	});

	it('collapses a sync iterable into one buffer', async function () {
		assert.deepStrictEqual((await handlerReturning(['a', 'b'])()).body, Buffer.from('ab'));
	});

	it('streams an async iterable', async function () {
		const body = (async function* () {
			yield 'x';
		})();
		assert.ok((await handlerReturning(body)()).body instanceof Readable);
	});
});
