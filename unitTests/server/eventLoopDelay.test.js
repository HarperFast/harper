'use strict';

const assert = require('node:assert');
const {
	startEventLoopDelayMonitor,
	stopEventLoopDelayMonitor,
	readEventLoopDelay,
	eventLoopDelayFromHistogram,
} = require('#src/server/eventLoopDelay');
const { setTimeout: delay } = require('node:timers/promises');

const MS = 1e6;

describe('event loop delay monitor', () => {
	after(() => stopEventLoopDelayMonitor());

	it('reports the delay above the sampling interval in milliseconds', () => {
		assert.deepStrictEqual(eventLoopDelayFromHistogram({ count: 3, mean: 25 * MS, max: 60 * MS }, 20), {
			mean: 5,
			maxDelay: 40,
			count: 3,
		});
	});

	it('clamps timer jitter below the interval to zero', () => {
		assert.deepStrictEqual(eventLoopDelayFromHistogram({ count: 2, mean: 19.5 * MS, max: 19.9 * MS }, 20), {
			mean: 0,
			maxDelay: 0,
			count: 2,
		});
	});

	it('reports nothing for an empty histogram', () => {
		assert.strictEqual(eventLoopDelayFromHistogram({ count: 0, mean: NaN, max: 0 }, 20), undefined);
	});

	it('records a blocked event loop and starts over on every read', async () => {
		assert.strictEqual(startEventLoopDelayMonitor(), true);
		assert.strictEqual(startEventLoopDelayMonitor(), true);
		await delay(60);
		readEventLoopDelay();
		// the first firing after a reset only seeds the interval, so give it one before blocking
		await delay(30);
		const start = performance.now();
		while (performance.now() - start < 100) {}
		await delay(50);
		const blocked = readEventLoopDelay();
		assert.ok(blocked.count >= 1, `samples were taken: ${JSON.stringify(blocked)}`);
		assert.ok(blocked.maxDelay >= 50, `the 100ms block was seen: ${JSON.stringify(blocked)}`);
		assert.ok(blocked.mean <= blocked.maxDelay);
		assert.strictEqual(readEventLoopDelay(), undefined);
	});
});
