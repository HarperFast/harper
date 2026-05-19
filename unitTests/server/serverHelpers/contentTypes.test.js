'use strict';

const assert = require('node:assert');
const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const { contentTypes, findBestSerializer } = require('#src/server/serverHelpers/contentTypes');

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
