'use strict';

const assert = require('node:assert');
const harperLogger =
	require('#src/utility/logging/harper_logger').default || require('#src/utility/logging/harper_logger');
const {
	sampleWorkerELU,
	PINNED_ELU_UTILIZATION_THRESHOLD,
	PINNED_ELU_SUSTAINED_TICKS,
} = require('#js/server/threads/manageThreads');

function makeFakeWorker(threadId, { initialActiveMs = 0, initialIdleMs = 1 } = {}) {
	let idle = initialIdleMs;
	let active = initialActiveMs;
	let forcedDelta;
	return {
		threadId,
		performance: {
			eventLoopUtilization(current, previous) {
				if (current === undefined) return { idle, active, utilization: active / (active + idle) };
				if (forcedDelta) {
					const delta = forcedDelta;
					forcedDelta = undefined;
					return delta;
				}
				const deltaIdle = current.idle - previous.idle;
				const deltaActive = current.active - previous.active;
				return { idle: deltaIdle, active: deltaActive, utilization: deltaActive / (deltaActive + deltaIdle) };
			},
		},
		pushTick(utilization) {
			active += utilization * 1000;
			idle += (1 - utilization) * 1000;
		},
		forceNextDelta(delta) {
			active += delta.active;
			idle += delta.idle;
			forcedDelta = delta;
		},
	};
}

function runTicks(worker, utilizations) {
	if (!worker.primed) {
		sampleWorkerELU(worker);
		worker.primed = true;
	}
	for (const utilization of utilizations) {
		worker.pushTick(utilization);
		sampleWorkerELU(worker);
	}
}

describe('pinned worker event-loop utilization warning', () => {
	let warnings;
	let originalWarn;
	beforeEach(() => {
		warnings = [];
		originalWarn = harperLogger.warn;
		harperLogger.warn = (message) => warnings.push(message);
	});
	afterEach(() => {
		harperLogger.warn = originalWarn;
	});

	it('does not warn while utilization stays below the threshold', () => {
		const worker = makeFakeWorker(1);
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS + 10).fill(PINNED_ELU_UTILIZATION_THRESHOLD - 0.01));
		assert.deepStrictEqual(warnings, []);
	});

	it('warns exactly once when utilization stays pinned for the sustained tick count, not once per tick', () => {
		const worker = makeFakeWorker(2);
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS + 5).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		assert.strictEqual(warnings.length, 1);
		assert.match(warnings[0], /Worker thread 2 event loop utilization has been pinned/);
	});

	it('does not warn if a dip resets the streak before the sustained tick count is reached', () => {
		const worker = makeFakeWorker(3);
		const almostPinned = new Array(PINNED_ELU_SUSTAINED_TICKS - 1).fill(PINNED_ELU_UTILIZATION_THRESHOLD);
		runTicks(worker, [...almostPinned, PINNED_ELU_UTILIZATION_THRESHOLD - 0.01, ...almostPinned]);
		assert.deepStrictEqual(warnings, []);
	});

	it('logs a recovery warning once utilization drops back below the threshold after a warned episode', () => {
		const worker = makeFakeWorker(4);
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		assert.strictEqual(warnings.length, 1);
		runTicks(worker, [PINNED_ELU_UTILIZATION_THRESHOLD - 0.01]);
		assert.strictEqual(warnings.length, 2);
		assert.match(warnings[1], /Worker thread 4 event loop utilization has recovered/);
		runTicks(worker, new Array(5).fill(0));
		assert.strictEqual(warnings.length, 2);
	});

	it('warns again for a second sustained episode after a recovered one', () => {
		const worker = makeFakeWorker(5);
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		runTicks(worker, [PINNED_ELU_UTILIZATION_THRESHOLD - 0.01]);
		assert.strictEqual(warnings.length, 2);
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		assert.strictEqual(warnings.length, 3);
		assert.match(warnings[2], /Worker thread 5 event loop utilization has been pinned/);
	});

	it('does not count a saturated first-ever sample toward the streak', () => {
		const worker = makeFakeWorker(6, { initialActiveMs: 60_000 });
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS - 1).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		assert.deepStrictEqual(warnings, []);
		runTicks(worker, [PINNED_ELU_UTILIZATION_THRESHOLD]);
		assert.strictEqual(warnings.length, 1);
	});

	it('ignores an out-of-range sample without resetting or completing the streak', () => {
		const worker = makeFakeWorker(7);
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS - 1).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		worker.forceNextDelta({ idle: -1, active: 1001, utilization: 1001 });
		sampleWorkerELU(worker);
		assert.deepStrictEqual(warnings, []);
		runTicks(worker, [PINNED_ELU_UTILIZATION_THRESHOLD]);
		assert.strictEqual(warnings.length, 1);
	});

	it('excludes a pre-online placeholder sample and the first real sample after it', () => {
		const worker = makeFakeWorker(8, { initialActiveMs: 0, initialIdleMs: 0 });
		sampleWorkerELU(worker);
		worker.primed = true;
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		assert.deepStrictEqual(warnings, []);
		runTicks(worker, [PINNED_ELU_UTILIZATION_THRESHOLD]);
		assert.strictEqual(warnings.length, 1);
	});

	it('names the worker by name and application when set', () => {
		const worker = makeFakeWorker(9);
		worker.name = 'http';
		worker.application = 'my-app';
		runTicks(worker, new Array(PINNED_ELU_SUSTAINED_TICKS).fill(PINNED_ELU_UTILIZATION_THRESHOLD));
		assert.match(warnings[0], /Worker thread 9 \(http\/my-app\) event loop/);
	});
});
