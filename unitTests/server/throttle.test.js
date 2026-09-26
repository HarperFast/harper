require('../testUtils.js');
const assert = require('assert');
const { throttle } = require('#src/server/throttle');
const { setTimeout: delay } = require('node:timers/promises');
describe('throttle test', () => {
	it('will throttle calls to a function', async () => {
		let calledCount = 0;
		let throttledFunction = throttle(testFunction);
		for (let i = 0; i < 10; i++) {
			assert.equal(await throttledFunction(i, i), i + i);
		}
		assert.equal(calledCount, 10);
		let lastPromise;
		for (let i = 0; i < 10; i++) {
			lastPromise = throttledFunction(i, i);
		}
		await lastPromise;
		assert.equal(calledCount, 20);
		function testFunction(a, b) {
			calledCount++;
			return a + b;
		}
	});
	it('will limit the queue length of throttled functions', async () => {
		let limitReached = false;
		let throttledFunction = throttle(
			testFunction,
			() => {
				limitReached = true;
			},
			20
		);
		for (let i = 0; i < 20; i++) {
			throttledFunction(i, i);
			// let a queue build up and then test cycling through the queue
			if (i > 10) await delay(2);
		}
		assert(limitReached);

		function testFunction(_a, _b) {
			let start = performance.now();
			while (performance.now() < start + 10) {}
		}
	});
	it('warns once per interval when the queue limit sheds a call, naming the queue', async () => {
		const { logger } = require('#src/utility/logging/logger');
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = function (message, ...rest) {
			if (String(message).startsWith('Rejecting queued calls (test queue)')) warnings.push(message);
			else originalWarn?.call(this, message, ...rest);
		};
		try {
			let shed = 0;
			let throttledFunction = throttle(
				testFunction,
				() => {
					shed++;
				},
				20,
				'test queue'
			);
			for (let i = 0; i < 20; i++) {
				throttledFunction(i, i);
				if (i > 10) await delay(2);
			}
			assert(shed > 1, `expected more than one shed, got ${shed}`);
			assert.equal(warnings.length, 1);
			assert.match(
				warnings[0],
				/^Rejecting queued calls \(test queue\): \d+ already queued at ~\d+ms per event cycle, an estimated wait past the 20ms limit$/
			);
		} finally {
			logger.warn = originalWarn;
		}
		function testFunction(_a, _b) {
			let start = performance.now();
			while (performance.now() < start + 10) {}
		}
	});
	it('throttled calls propagate errors', async () => {
		let returned = 0;
		let throttledFunction = throttle(errorFunction);
		for (let i = 0; i < 10; i++) {
			try {
				await throttledFunction();
				returned++;
			} catch (error) {
				assert.equal(error.message, 'test error');
			}
		}
		assert.equal(returned, 0);
		function errorFunction() {
			throw new Error('test error');
		}
	});
});
