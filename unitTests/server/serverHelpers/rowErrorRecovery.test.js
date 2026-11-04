'use strict';

const assert = require('node:assert');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const Fastify = require('fastify');
const { decode } = require('cbor-x');
const { unpackMultiple } = require('../../packageBindings.mts').packageBindings('msgpackr');
const { ExtendedIterable } = require('@harperfast/extended-iterable');
const { serialize, registerContentHandlers } = require('#src/server/serverHelpers/contentTypes');
const { serverErrorHandler } = require('#src/server/serverHelpers/serverHandlers');
const { ReadSnapshotExpiredError, ServerError } = require('#src/utility/errors/hdbError');

function rowsFailingAt(failingId, error, { asynchronous = false, columns, withName = false } = {}) {
	const perRow = (id) => {
		if (id === failingId) {
			if (asynchronous) return Promise.reject(error);
			throw error;
		}
		return withName ? { id, name: `n${id}` } : { id };
	};
	const iterable = new ExtendedIterable([1, 2, 3]).map(perRow);
	if (columns) iterable.getColumns = () => columns;
	return iterable;
}

function rowsFailingAt2(error, options) {
	return rowsFailingAt(2, error, options);
}

function respond(iterable, accept) {
	const request = { headers: { accept } };
	return serialize(iterable, request, { headers: { set() {} } });
}

function drain(readable) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let failure;
		const deadline = setTimeout(() => {
			readable.destroy();
			reject(new Error('the stream neither ended nor failed within 5s'));
		}, 5000);
		readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
		readable.on('error', (error) => (failure = error));
		readable.on('close', () => {
			clearTimeout(deadline);
			const raw = Buffer.concat(chunks);
			resolve({ body: raw.toString(), raw, failure });
		});
	});
}

const ordinary = (id = 2) => Object.assign(new Error(`row ${id} failed`), { partialObject: { id } });
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

		it('keeps a row-local error as an in-band CBOR item carrying the primary key', async function () {
			const { raw, failure } = await drain(respond(rowsFailingAt2(ordinary(), { asynchronous }), 'application/cbor'));
			assert.strictEqual(failure, undefined);
			assert.deepStrictEqual(decode(raw), [{ id: 1 }, { error: 'Error', message: 'row 2 failed', id: 2 }, { id: 3 }]);
		});

		it('keeps a row-local error as an in-band MessagePack item carrying the primary key', async function () {
			const { raw, failure } = await drain(
				respond(rowsFailingAt2(ordinary(), { asynchronous }), 'application/x-msgpack')
			);
			assert.strictEqual(failure, undefined);
			assert.deepStrictEqual(unpackMultiple(raw), [
				{ id: 1 },
				{ error: 'Error', message: 'row 2 failed', id: 2 },
				{ id: 3 },
			]);
		});

		it('keeps a row-local error as an in-band CSV row carrying the primary key and error columns when present', async function () {
			const firstRowFailed = await drain(
				respond(rowsFailingAt(1, ordinary(1), { asynchronous, withName: true }), 'text/csv')
			);
			assert.strictEqual(firstRowFailed.failure, undefined);
			assert.deepStrictEqual(firstRowFailed.body.trim().split('\n'), [
				'"error","message","id"',
				'"Error","row 1 failed",1',
				',,2',
				',,3',
			]);

			const defaultColumns = await drain(
				respond(rowsFailingAt2(ordinary(), { asynchronous, withName: true, columns: ['id', 'name'] }), 'text/csv')
			);
			assert.strictEqual(defaultColumns.failure, undefined);
			assert.deepStrictEqual(defaultColumns.body.trim().split('\n'), ['"id","name"', '1,"n1"', '2,', '3,"n3"']);

			const withErrorColumns = await drain(
				respond(
					rowsFailingAt2(ordinary(), { asynchronous, withName: true, columns: ['id', 'name', 'error', 'message'] }),
					'text/csv'
				)
			);
			assert.strictEqual(withErrorColumns.failure, undefined);
			assert.deepStrictEqual(withErrorColumns.body.trim().split('\n'), [
				'"id","name","error","message"',
				'1,"n1",,',
				'2,,"Error","row 2 failed"',
				'3,"n3",,',
			]);
		});

		it('recovers a thrown non-Error object with default error name and stringified message', async function () {
			const nonError = { toString: () => 'row 2 non-Error fault', partialObject: { id: 2 } };
			const { body, failure } = await drain(respond(rowsFailingAt2(nonError, { asynchronous }), 'application/json'));
			assert.strictEqual(failure, undefined);
			assert.deepStrictEqual(JSON.parse(body), [
				{ id: 1 },
				{ id: 2, error: 'Error', message: 'row 2 non-Error fault' },
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

	it('keeps a row-local error as an in-band CBOR item', async function () {
		await serve(rowsFailingAt2(ordinary()));
		const res = await post('application/cbor');
		assert.strictEqual(res.statusCode, 200);
		assert.deepStrictEqual(decode(res.rawPayload), [
			{ id: 1 },
			{ error: 'Error', message: 'row 2 failed', id: 2 },
			{ id: 3 },
		]);
	});

	it('keeps a row-local error as an in-band MessagePack item', async function () {
		await serve(rowsFailingAt2(ordinary()));
		const res = await post('application/x-msgpack');
		assert.strictEqual(res.statusCode, 200);
		assert.deepStrictEqual(unpackMultiple(res.rawPayload), [
			{ id: 1 },
			{ error: 'Error', message: 'row 2 failed', id: 2 },
			{ id: 3 },
		]);
	});

	it('keeps a row-local error as an in-band CSV row', async function () {
		await serve(rowsFailingAt(1, ordinary(1), { withName: true }));
		const res = await post('text/csv');
		assert.strictEqual(res.statusCode, 200);
		assert.deepStrictEqual(res.body.trim().split('\n'), [
			'"error","message","id"',
			'"Error","row 1 failed",1',
			',,2',
			',,3',
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
			(res) => `${res.statusCode} ${res.body}`,
			(error) => `rejected: ${error.message}`
		);
		assert.strictEqual(outcome, 'rejected: response destroyed before completion');
	});
});
