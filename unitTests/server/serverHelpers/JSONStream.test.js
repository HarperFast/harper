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
		// `activeIterators` behaves as a LIFO stack under normal depth-first traversal, so the
		// failed entry is always last anyway. `sibling` is injected directly to put a second,
		// unrelated entry on the list, exercising the one case where removal has to go by
		// identity rather than position.
		const EXPECTED_PREFIX = '[[{"error":"Error: inner failure"}]';

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
							return new Promise(() => {}); // never resolves: outer stays open until destroy()
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
				// outer's pending promise is the only thing keeping this stream (and this test) alive;
				// this timer must NOT be unref()'d, or Node exits before it ever fires, silently
				// turning a serialization regression into an unattributed whole-run failure instead
				// of a failure of this test
				const timer = setTimeout(() => {
					reject(new Error(`timed out waiting for ${JSON.stringify(EXPECTED_PREFIX)}, got ${JSON.stringify(out)}`));
				}, 2000);
				const settle = (fn) => {
					try {
						fn();
					} catch (error) {
						clearTimeout(timer);
						reject(error);
					}
				};
				stream.on('error', (error) => {
					clearTimeout(timer);
					reject(error);
				});
				stream.on('data', (chunk) => {
					out += chunk;
					if (out !== EXPECTED_PREFIX) return;
					settle(() => {
						assert.strictEqual(
							stream.activeIterators.length,
							2,
							'outer and sibling remain tracked; inner must be gone'
						);
						assert.ok(stream.activeIterators.includes(sibling));
						stream.destroy();
					});
				});
				stream.on('close', () => {
					clearTimeout(timer);
					settle(() => {
						assert.strictEqual(outerReturnCalled, true, 'outer must still get return() on destroy');
						assert.strictEqual(
							siblingReturnCalled,
							true,
							'the unrelated active iterator must still get return() on destroy'
						);
						assert.strictEqual(innerReturnCalled, false, 'the already-failed iterator must not be returned again');
						resolve();
					});
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
