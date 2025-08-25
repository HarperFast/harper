require('../test_utils');
const assert = require('assert');
const { throttle } = require('../../server/throttle');
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

		function testFunction(a, b) {
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
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms)); // wait for audit log removal and deletion
}
