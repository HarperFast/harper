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
	it('does not shed a burst on cycle times measured before its queue last drained', async function () {
		this.timeout(10000);
		let ran = 0;
		let shed = 0;
		const throttledFunction = throttle(
			() => ran++,
			() => shed++,
			1000
		);
		// each setImmediate crosses the throttle's drain callback, so every call below starts its own backlog
		throttledFunction();
		busyWait(500);
		await new Promise(setImmediate);
		for (let i = 0; i < 5; i++) {
			throttledFunction();
			await new Promise(setImmediate);
		}
		const burst = [];
		for (let i = 0; i < 60; i++) burst.push(throttledFunction());
		await Promise.all(burst);
		assert.equal(shed, 0);
		assert.equal(ran, 66);
	});
	it("does not shed one throttle's burst on another throttle's slow cycle", async function () {
		this.timeout(10000);
		let shed = 0;
		const slowQueue = throttle(() => {});
		const burstQueue = throttle(
			() => {},
			() => shed++,
			1000
		);
		slowQueue();
		busyWait(500);
		await new Promise(setImmediate);
		const burst = [];
		for (let i = 0; i < 60; i++) burst.push(burstQueue());
		await Promise.all(burst);
		assert.equal(shed, 0);
	});
	it("keeps shedding a real backlog while another throttle's queue drains", async function () {
		this.timeout(10000);
		let shed = 0;
		const backlogged = throttle(
			() => busyWait(10),
			() => shed++,
			100
		);
		const draining = throttle(() => {});
		const accepted = [];
		for (let i = 0; i < 30; i++) accepted.push(backlogged());
		for (let i = 0; i < 5; i++) {
			draining();
			await new Promise(setImmediate);
		}
		backlogged();
		assert.equal(shed, 1);
		await Promise.all(accepted);
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

function busyWait(ms) {
	const start = performance.now();
	while (performance.now() < start + ms) {}
}
