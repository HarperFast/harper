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
							return new Promise(() => {}); // outer stays open until destroy()
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
				// nothing else keeps the event loop alive while outer's next() is stuck on a promise
				// that never resolves, so this timer must stay ref'd or Node exits before it can fire
				const timer = setTimeout(() => {
					stream.destroy();
					reject(new Error(`timed out waiting for ${JSON.stringify(EXPECTED_PREFIX)}, got ${JSON.stringify(out)}`));
				}, 2000);
				const settle = (fn) => {
					try {
						fn();
					} catch (error) {
						clearTimeout(timer);
						stream.destroy();
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

	describe('Destroying mid-stream', function () {
		it('settles an async iterator cleanup that rejects instead of leaving it unhandled', async function () {
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.prependListener('unhandledRejection', onUnhandled);
			let returned = false;
			try {
				const stream = streamAsJSON({
					[Symbol.asyncIterator]() {
						return {
							next: async () => (returned ? { done: true } : { done: false, value: 'x'.repeat(20000) }),
							return: async () => {
								returned = true;
								throw new Error('cleanup failed');
							},
						};
					},
				});
				await new Promise((resolve) => stream.once('data', resolve));
				stream.destroy();
				await delay(20);
				assert.strictEqual(returned, true);
				assert.deepStrictEqual(unhandled, []);
			} finally {
				process.removeListener('unhandledRejection', onUnhandled);
			}
		});

		it('closes an iterator with no return method, or whose cleanup throws, without failing the stream', async function () {
			const throwingReturn = {
				return() {
					throw new Error('sync cleanup failure');
				},
			};
			for (const extra of [{}, throwingReturn]) {
				let index = 0;
				const stream = streamAsJSON({
					[Symbol.iterator]() {
						return {
							next: () => (index++ < 5000 ? { done: false, value: 'y'.repeat(100) } : { done: true }),
							...extra,
						};
					},
				});
				const errors = [];
				stream.on('error', (error) => errors.push(error));
				const closed = new Promise((resolve) => stream.once('close', resolve));
				// destroyed from the first chunk, as a client disconnect would, before the iterator is exhausted
				stream.once('data', () => stream.destroy());
				await closed;
				assert.ok(index < 5000, 'the stream was not destroyed mid-iteration');
				assert.deepStrictEqual(errors, []);
			}
		});
	});
});

describe('Strict JSONStream', () => {
	const sinon = require('sinon');
	const harperLogger = require('#src/utility/logging/harper_logger');
	let logged;

	beforeEach(() => {
		logged = [];
		const capture = (...args) => logged.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))));
		sinon.stub(console, 'error').callsFake(capture);
		for (const level of ['warn', 'error', 'info']) sinon.stub(harperLogger, level).callsFake(capture);
	});

	afterEach(() => sinon.restore());

	function failureOf(stream) {
		return new Promise((resolve, reject) => {
			stream.on('data', () => {});
			stream.on('end', () => reject(new Error('the stream ended as if it succeeded')));
			stream.on('error', resolve);
			stream.on('close', () => reject(new Error('the stream closed without an error')));
		});
	}

	function assertNotLogged(marker) {
		assert.ok(!JSON.stringify(logged).includes(marker), `${marker} reached the log`);
	}

	function circular() {
		const value = {};
		value.self = value;
		return value;
	}

	it('fails on a cursor that rejects mid-stream, without logging its error', async () => {
		let index = 0;
		const cursor = {
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					if (index++ < 2) return { done: false, value: { index } };
					throw new Error('SECRET-ASYNC');
				},
			}),
		};
		const error = await failureOf(streamAsJSON(cursor, { strict: true }));
		assert.strictEqual(error.message, 'SECRET-ASYNC');
		assertNotLogged('SECRET-ASYNC');
	});

	it('fails on an iterator whose next throws, without logging its error', async () => {
		let index = 0;
		const iterable = {
			[Symbol.iterator]: () => ({
				next: () => {
					if (index++ < 2) return { done: false, value: index };
					throw new Error('SECRET-SYNC');
				},
			}),
		};
		const error = await failureOf(streamAsJSON(iterable, { strict: true }));
		assert.strictEqual(error.message, 'SECRET-SYNC');
		assertNotLogged('SECRET-SYNC');
	});

	it('fails on a rejected element, without logging its error', async () => {
		// rejects only once read, so nothing reports it as unhandled before the stream attaches
		const rejectedLater = {
			then: (resolve, reject) => Promise.reject(new Error('SECRET-ELEMENT')).then(resolve, reject),
		};
		const error = await failureOf(streamAsJSON([1, rejectedLater], { strict: true }));
		assert.strictEqual(error.message, 'SECRET-ELEMENT');
		assertNotLogged('SECRET-ELEMENT');
	});

	it('closes the producing iterator with return, not by throwing the serialization error into it', async () => {
		const calls = [];
		let index = 0;
		const iterable = {
			[Symbol.iterator]: () => ({
				next: () => ({ done: false, value: index++ === 0 ? circular() : index }),
				return: () => {
					calls.push('return');
					return { done: true };
				},
				throw: () => {
					calls.push('throw');
					return { done: true };
				},
			}),
		};
		await failureOf(streamAsJSON(iterable, { strict: true }));
		assert.deepStrictEqual(calls, ['return']);
	});

	it('logs only the class of a failing cleanup', async () => {
		let index = 0;
		const cursor = {
			[Symbol.asyncIterator]: () => ({
				next: async () => ({ done: false, value: index++ === 0 ? 1 : circular() }),
				return: async () => {
					throw new TypeError('SECRET-CLEANUP');
				},
			}),
		};
		await failureOf(streamAsJSON(cursor, { strict: true }));
		await delay(10);
		assert.ok(JSON.stringify(logged).includes('TypeError'), 'the cleanup failure was not logged');
		assertNotLogged('SECRET-CLEANUP');
	});
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
