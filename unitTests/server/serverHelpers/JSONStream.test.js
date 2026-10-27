'use strict';

const testUtils = require('../../testUtils.js');
const { streamAsJSON } = require('#src/server/serverHelpers/JSONStream');
const { waitFor } = require('../../waitFor');
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
	describe('Failure ends the stream with an error, never a clean end', function () {
		function collect(stream) {
			return new Promise((resolve) => {
				let out = '';
				let error;
				let ended = false;
				stream.on('data', (chunk) => (out += chunk));
				stream.on('error', (streamError) => (error = streamError));
				stream.on('end', () => (ended = true));
				stream.on('close', () => resolve({ out, error, ended }));
			});
		}
		function assertFailed(result, expectedOutput, message) {
			assert.strictEqual(result.ended, false, 'a failed stream must not end cleanly');
			assert.strictEqual(result.error?.message, message);
			assert.strictEqual(result.out, expectedOutput);
			assert.throws(() => JSON.parse(result.out), SyntaxError);
		}

		it('a sync iterator throwing mid-stream', async function () {
			function* rows() {
				yield { n: 0 };
				yield { n: 1 };
				throw new Error('boom');
			}
			assertFailed(await collect(streamAsJSON(rows())), '[{"n":0},{"n":1},{"error":"Error: boom"}', 'boom');
		});

		it('an async iterator rejecting mid-stream', async function () {
			async function* rows() {
				yield { n: 0 };
				await delay(1);
				throw new Error('boom');
			}
			assertFailed(await collect(streamAsJSON(rows())), '[{"n":0},{"error":"Error: boom"}', 'boom');
		});

		it('an iterator throwing before its first row', async function () {
			async function* rows() {
				throw new Error('boom');
			}
			assertFailed(await collect(streamAsJSON(rows())), '[{"error":"Error: boom"}', 'boom');
		});

		it('keeps the outcome flags on the diagnostic element', async function () {
			const failure = Object.assign(new Error('Peer timeout'), { replicationUnconfirmed: true, retryable: false });
			function* rows() {
				yield { n: 0 };
				throw failure;
			}
			assertFailed(
				await collect(streamAsJSON(rows())),
				'[{"n":0},{"error":"Error: Peer timeout","replicationUnconfirmed":true,"retryable":false}',
				'Peer timeout'
			);
		});

		it('a rejected promise element', async function () {
			function* rows() {
				yield { n: 0 };
				yield Promise.reject(new Error('boom'));
				yield { n: 2 };
			}
			assertFailed(await collect(streamAsJSON(rows())), '[{"n":0},{"error":"Error: boom"}', 'boom');
		});

		it('a row that fails to serialize', async function () {
			function* rows() {
				yield { n: 0 };
				yield {
					toJSON() {
						throw new Error('boom');
					},
				};
				yield { n: 2 };
			}
			assertFailed(await collect(streamAsJSON(rows())), '[{"n":0},{"error":"Error: boom"}', 'boom');
		});

		it('fails while its consumer is backpressured, without closing the failed iterator again', async function () {
			const rows = [];
			let returned = false;
			const iterable = {
				[Symbol.iterator]() {
					return {
						next() {
							if (rows.length) return { done: false, value: rows.shift() };
							throw new Error('z'.repeat(4000));
						},
						return() {
							returned = true;
							return { done: true };
						},
					};
				},
			};
			const stream = streamAsJSON(iterable);
			// row a flushes at once under the high-water mark; row b stays buffered until the long diagnostic
			// flushes it and pushes the readable past the mark
			rows.push({ a: 'x'.repeat(stream.readableHighWaterMark - 5000) }, { b: 'y'.repeat(6000) });
			let streamError;
			stream.on('error', (error) => (streamError = error));
			stream.read(0);
			await waitFor(() => streamError, { message: 'the stream must fail without being drained' });
			assert.strictEqual(streamError.message, 'z'.repeat(4000));
			assert.strictEqual(returned, false);
		});

		it('a falsy thrown value still fails with an error', async function () {
			function* rows() {
				yield { n: 0 };
				throw '';
			}
			const result = await collect(streamAsJSON(rows()));
			assert.strictEqual(result.ended, false);
			assert.ok(result.error instanceof Error);
		});

		it('reports an external destroy error and hands it to the active iterator', async function () {
			let thrown;
			const rows = {
				[Symbol.iterator]() {
					return {
						next: () => new Promise(() => {}),
						throw(error) {
							thrown = error;
							return { done: true };
						},
					};
				},
			};
			const stream = streamAsJSON(rows);
			const result = collect(stream);
			stream.resume();
			await delay(5);
			const external = new Error('client went away');
			stream.destroy(external);
			assert.strictEqual((await result).error, external);
			assert.strictEqual(thrown, external);
		});

		for (const [name, cleanup] of [
			[
				'throws',
				() => {
					throw new Error('cleanup failed');
				},
			],
			['rejects', () => Promise.reject(new Error('cleanup failed'))],
			['is missing', undefined],
		]) {
			it(`still fails the stream when an enclosing iterator's return() ${name}`, async function () {
				const unhandled = [];
				const onUnhandled = (reason) => unhandled.push(reason);
				process.on('unhandledRejection', onUnhandled);
				try {
					function* inner() {
						throw new Error('inner failure');
					}
					let calls = 0;
					const outer = {
						[Symbol.iterator]() {
							return {
								next: () => (calls++ === 0 ? { done: false, value: inner() } : { done: true }),
								return: cleanup,
							};
						},
					};
					assertFailed(await collect(streamAsJSON(outer)), '[[{"error":"Error: inner failure"}', 'inner failure');
					await delay(10);
					assert.deepStrictEqual(unhandled, []);
				} finally {
					process.off('unhandledRejection', onUnhandled);
				}
			});
		}
	});
	describe('Failed iterator bookkeeping', function () {
		// `activeIterators` behaves as a LIFO stack under normal depth-first traversal, so the
		// failed entry is always last anyway. `sibling` is injected directly to put a second,
		// unrelated entry on the list, exercising the one case where removal has to go by
		// identity rather than position.
		const EXPECTED_OUTPUT = '[[{"error":"Error: inner failure"}';

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
							throw new Error('the outer iterator must not advance past a failed element');
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
				let streamError;
				let trackedAtFailure;
				const timer = setTimeout(() => {
					stream.destroy();
					reject(new Error(`timed out waiting for the stream to fail, got ${JSON.stringify(out)}`));
				}, 2000);
				stream.on('data', (chunk) => {
					out += chunk;
				});
				stream.on('error', (error) => {
					streamError = error;
					trackedAtFailure = [...stream.activeIterators];
				});
				stream.on('end', () => reject(new Error('a failed stream must not end cleanly')));
				stream.on('close', () => {
					clearTimeout(timer);
					try {
						assert.strictEqual(out, EXPECTED_OUTPUT, 'the error element is written and neither array is closed');
						assert.strictEqual(streamError?.message, 'inner failure');
						assert.strictEqual(trackedAtFailure.length, 2, 'outer and sibling remain tracked; inner must be gone');
						assert.ok(trackedAtFailure.includes(sibling));
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
