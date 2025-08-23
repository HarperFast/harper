require('../test_utils');
const assert = require('assert');
const { throttle } = require('../../server/throttle');
describe('throttle test', () => {
	it('will throttle calls to a function', async () => {
		let calledCount = 0;
		let limitReached = false;
		let throttledFunction = throttle(testFunction, () => {
			limitReached = true;
		});
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
		for (let i = 0; i < 50; i++) {
			throttledFunction(i, i);
		}
		assert(limitReached);

		function testFunction(a, b) {
			calledCount++;
			return a + b;
		}
	});
});
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms)); // wait for audit log removal and deletion
}
