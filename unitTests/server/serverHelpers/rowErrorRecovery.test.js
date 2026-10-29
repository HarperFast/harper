'use strict';

const assert = require('node:assert');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const Fastify = require('fastify');
const { ExtendedIterable } = require('@harperfast/extended-iterable');
const { serialize, registerContentHandlers } = require('#src/server/serverHelpers/contentTypes');
const { serverErrorHandler } = require('#src/server/serverHelpers/serverHandlers');
const { ReadSnapshotExpiredError, ServerError } = require('#src/utility/errors/hdbError');

// Rows 1..3; the per-row map throws (or rejects) at row 2, the way a nested read inside a row transform does.
function rowsFailingAt2(error, { asynchronous = false } = {}) {
	const perRow = (id) => {
		if (id === 2) {
			if (asynchronous) return Promise.reject(error);
			throw error;
		}
		return { id };
	};
	return new ExtendedIterable([1, 2, 3]).map(perRow);
}

function respond(iterable, accept) {
	const request = { headers: { accept } };
	return serialize(iterable, request, { headers: { set() {} } });
}

function drain(readable) {
	return new Promise((resolve) => {
		const chunks = [];
		let failure;
		readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
		readable.on('error', (error) => (failure = error));
		readable.on('close', () => resolve({ body: Buffer.concat(chunks).toString(), failure }));
	});
}

const ordinary = () => Object.assign(new Error('row 2 failed'), { partialObject: { id: 2 } });
const unavailableRow = () =>
	Object.assign(new ServerError('source unavailable for row 2', 503), { partialObject: { id: 2 } });

for (const asynchronous of [false, true]) {
	describe(`serialize() with a per-row map that ${asynchronous ? 'rejects' : 'throws'}`, function () {
		it('keeps a row-local error as an in-band item carrying the primary key', async function () {
			const { body, failure } = await drain(respond(rowsFailingAt2(ordinary(), { asynchronous }), 'application/json'));
			assert.strictEqual(failure, undefined);
			assert.deepStrictEqual(JSON.parse(body), [
				{ id: 1 },
				{ error: 'Error', message: 'row 2 failed', id: 2 },
				{ id: 3 },
			]);
		});

		it('keeps a row-local 503 as an in-band item, since a status says nothing about scope', async function () {
			const { body, failure } = await drain(
				respond(rowsFailingAt2(unavailableRow(), { asynchronous }), 'application/json')
			);
			assert.strictEqual(failure, undefined);
			assert.strictEqual(JSON.parse(body).length, 3);
		});

		it('aborts a JSON array when the read snapshot has expired', async function () {
			const expired = new ReadSnapshotExpiredError();
			const { body, failure } = await drain(respond(rowsFailingAt2(expired, { asynchronous }), 'application/json'));
			assert.strictEqual(failure, expired);
			assert.ok(!body.endsWith(']'), `the array must not be closed: ${body}`);
			assert.ok(body.startsWith('[{"id":1}'));
			assert.ok(!body.includes('{"id":3}'), 'no row is written after the failure');
		});

		it('fails a CSV response when the read snapshot has expired', async function () {
			this.timeout(5000);
			const expired = new ReadSnapshotExpiredError();
			const { failure } = await drain(respond(rowsFailingAt2(expired, { asynchronous }), 'text/csv'));
			assert.strictEqual(failure, expired);
		});

		for (const accept of ['application/x-ndjson', 'application/ndjson']) {
			it(`ends ${accept} with its terminal record when the read snapshot has expired`, async function () {
				const { body } = await drain(respond(rowsFailingAt2(new ReadSnapshotExpiredError(), { asynchronous }), accept));
				const lines = body.trim().split('\n').map(JSON.parse);
				assert.deepStrictEqual(lines[0], { id: 1 });
				assert.strictEqual(lines[1].$harperStreamError.error, 'ReadSnapshotExpiredError');
				assert.strictEqual(lines.length, 2);
			});
		}
	});
}

describe('the operations API serializer hook with a per-row map that throws', function () {
	let app;
	async function serve(iterable) {
		app = Fastify();
		registerContentHandlers(app);
		app.setErrorHandler(serverErrorHandler);
		app.post('/', async () => iterable);
		await app.ready();
	}
	const post = (accept) => app.inject({ method: 'POST', url: '/', headers: { accept }, payload: {} });

	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	it('keeps a row-local error as an in-band JSON item', async function () {
		await serve(rowsFailingAt2(ordinary()));
		const res = await post('application/json');
		assert.strictEqual(res.statusCode, 200);
		assert.deepStrictEqual(JSON.parse(res.body), [
			{ id: 1 },
			{ error: 'Error', message: 'row 2 failed', id: 2 },
			{ id: 3 },
		]);
	});

	for (const accept of ['application/x-ndjson', 'application/ndjson']) {
		it(`ends ${accept} with its terminal record rather than recovering the row`, async function () {
			await serve(rowsFailingAt2(ordinary()));
			const res = await post(accept);
			const lines = res.body.trim().split('\n').map(JSON.parse);
			assert.deepStrictEqual(lines[0], { id: 1 });
			assert.strictEqual(lines[1].$harperStreamError.message, 'row 2 failed');
			assert.strictEqual(lines.length, 2);
		});
	}

	it('does not close the JSON array when the read snapshot has expired', async function () {
		await serve(rowsFailingAt2(new ReadSnapshotExpiredError()));
		const outcome = await post('application/json').then(
			(res) => res.body,
			(error) => `rejected: ${error.message}`
		);
		assert.ok(!outcome.endsWith(']'), `the array must not be closed: ${outcome}`);
		assert.ok(!outcome.includes('"id":3'), 'no row is written after the failure');
	});
});
