'use strict';

const testUtils = require('../../testUtils.js');
const { streamAsJSON } = require('#src/server/serverHelpers/JSONStream');
testUtils.preTestPrep();

const assert = require('assert');
function streamToJSON(stream) {
	return new Promise((resolve, reject) => {
		let buffers = [];
		stream.on('data', function (d) {
			buffers.push(d);
		});
		stream.on('end', function () {
			try {
				resolve(JSON.parse(Buffer.concat(buffers)));
			} catch (error) {
				reject(error);
			}
		});
		stream.on('error', reject);
	});
}
describe('Test JSONStream module ', () => {
	describe(`Streaming`, function () {
		it('Streams object', async function () {
			let input = { foo: 'bar' };
			let stream = streamAsJSON(input);
			assert.deepStrictEqual(await streamToJSON(stream), input);
		});
		it('Streams array', async function () {
			let input = [{ foo: 'bar' }, { foo: 'bar2' }];
			let stream = streamAsJSON(input);
			assert.deepStrictEqual(await streamToJSON(stream), input);
		});
		it('Streams generator', async function () {
			let expected = [{ foo: 'bar' }, { foo: 'bar2' }];
			function* generateObjects() {
				yield { foo: 'bar' };
				yield { foo: 'bar2' };
			}
			let stream = streamAsJSON(generateObjects());
			assert.deepStrictEqual(await streamToJSON(stream), expected);
		});
		it('Streams async generator', async function () {
			let expected = [{ foo: 'bar' }, { foo: 'bar2' }];
			async function* generateObjects() {
				await delay(1);
				yield { foo: 'bar' };
				await delay(1);
				yield { foo: 'bar2' };
				await delay(1);
			}
			let stream = streamAsJSON(generateObjects());
			assert.deepStrictEqual(await streamToJSON(stream), expected);
		});
	});
	describe('Failed iterator bookkeeping', function () {
		it('removes the failed iterator by reference, not by its position in activeIterators, when a nested iterator throws', async function () {
			// outer yields a single nested iterable (inner) whose next() throws. While handling
			// that failure, another, unrelated iterator (sibling) becomes concurrently active --
			// e.g. a sibling nested iterable tracked elsewhere in the same response. The failed
			// iterator must be the one removed from activeIterators, and the still-active sibling
			// must be left alone (and still get return() called on it when the stream is destroyed).
			let innerReturnCalled = false;
			let siblingReturnCalled = false;
			let stream;

			const sibling = {
				next: () => ({ done: false, value: 'sibling' }),
				return() {
					siblingReturnCalled = true;
					return { done: true };
				},
			};

			const inner = {
				[Symbol.iterator]() {
					return {
						next() {
							stream.activeIterators.push(sibling);
							throw new Error('inner failure');
						},
						return() {
							innerReturnCalled = true;
							return { done: true };
						},
					};
				},
			};

			const outer = {
				[Symbol.iterator]() {
					let yielded = false;
					return {
						next() {
							if (!yielded) {
								yielded = true;
								return { done: false, value: inner };
							}
							return { done: true };
						},
					};
				},
			};

			stream = streamAsJSON(outer);
			let result = await streamToJSON(stream);
			assert.deepStrictEqual(result, [[{ error: 'Error: inner failure' }]]);

			// the failed iterator must be gone, and the unrelated active one must remain tracked
			assert.deepStrictEqual(stream.activeIterators, [sibling]);

			stream.destroy();
			assert.strictEqual(siblingReturnCalled, true, 'the still-active sibling must get return() on destroy');
			assert.strictEqual(innerReturnCalled, false, 'the already-failed iterator must not be returned again');
		});
	});
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
