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
		// outer's next() never resolves after its first call, so the stream stays open until an
		// explicit destroy() -- that's what has to close outer, not stream end. buildInner also
		// activates `sibling` when inner fails, standing in for another iterator concurrently
		// tracked in activeIterators (e.g. a sibling nested iterable elsewhere in the response).
		function runNestedFailureCase(buildInner) {
			let innerReturnCalled = false;
			let siblingReturnCalled = false;
			let outerReturnCalled = false;
			let stream;

			const sibling = {
				next: () => ({ done: false, value: 'sibling' }),
				return() {
					siblingReturnCalled = true;
					return { done: true };
				},
			};
			const activateSibling = () => stream.activeIterators.push(sibling);

			const inner = buildInner(activateSibling, () => {
				innerReturnCalled = true;
			});

			let outerCalls = 0;
			const outer = {
				[Symbol.iterator]() {
					return {
						next() {
							outerCalls++;
							if (outerCalls === 1) return { done: false, value: inner };
							return new Promise(() => {}); // outer stays active until destroy()
						},
						return() {
							outerReturnCalled = true;
							return { done: true };
						},
					};
				},
			};

			stream = streamAsJSON(outer);
			return new Promise((resolve, reject) => {
				let out = '';
				stream.on('error', reject);
				stream.on('data', (chunk) => {
					out += chunk;
					if (!out.includes('inner failure')) return;
					assert.strictEqual(stream.activeIterators.length, 2, 'outer and sibling remain tracked; inner must be gone');
					assert.ok(stream.activeIterators.includes(sibling));
					stream.destroy();
				});
				stream.on('close', () => {
					try {
						assert.strictEqual(outerReturnCalled, true, 'outer must still get return() on destroy');
						assert.strictEqual(
							siblingReturnCalled,
							true,
							'the unrelated active iterator must still get return() on destroy'
						);
						assert.strictEqual(innerReturnCalled, false, 'the already-failed iterator must not be returned again');
						resolve();
					} catch (error) {
						reject(error);
					}
				});
			});
		}

		it('removes the failed iterator by reference, not by its position in activeIterators, when a nested sync iterator throws', function () {
			return runNestedFailureCase((activateSibling, markInnerReturned) => ({
				[Symbol.iterator]() {
					return {
						next() {
							activateSibling();
							throw new Error('inner failure');
						},
						return: markInnerReturned,
					};
				},
			}));
		});

		it('removes the failed iterator by reference, not by its position in activeIterators, when a nested async iterator rejects', function () {
			return runNestedFailureCase((activateSibling, markInnerReturned) => ({
				[Symbol.asyncIterator]() {
					return {
						next() {
							activateSibling();
							return Promise.reject(new Error('inner failure'));
						},
						return: markInnerReturned,
					};
				},
			}));
		});
	});
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
