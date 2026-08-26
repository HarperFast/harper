'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { awaitRestart } = require('#src/components/awaitRestart');

const TIMERS = { idleTimeoutMs: 60, ceilingMs: 1000 };

/**
 * Run `body` with the timers it arms tracked, so a handle left behind is a hard failure rather than
 * something only a leak hunt would notice. Counting `process.getActiveResourcesInfo()` cannot do it:
 * the test runner's own timers land in the same tally.
 */
async function withTrackedTimers(body) {
	const live = new Set();
	const realSetTimeout = global.setTimeout;
	const realClearTimeout = global.clearTimeout;
	global.setTimeout = (...args) => {
		const timer = realSetTimeout(...args);
		live.add(timer);
		return timer;
	};
	global.clearTimeout = (timer) => {
		live.delete(timer);
		return realClearTimeout(timer);
	};
	try {
		return { result: await body(), live };
	} finally {
		global.setTimeout = realSetTimeout;
		global.clearTimeout = realClearTimeout;
		for (const timer of live) realClearTimeout(timer);
	}
}

describe('awaitRestart', () => {
	it('reports a finished restart with its counts', async () => {
		const outcome = await awaitRestart(async () => ({ workersKeptOnOldCode: 2, replacementsNotStarted: 1 }), TIMERS);
		assert.deepStrictEqual(outcome, { completed: true, workersKeptOnOldCode: 2, replacementsNotStarted: 1 });
	});

	it('treats a restart handed to another thread as not completed', async () => {
		const outcome = await awaitRestart(async () => undefined, TIMERS);
		assert.deepStrictEqual(outcome, { completed: false, handedOff: true });
	});

	it('reports a rejected restart without rejecting itself', async () => {
		const failure = new Error('no workers');
		const outcome = await awaitRestart(async () => {
			throw failure;
		}, TIMERS);
		assert.strictEqual(outcome.completed, false);
		assert.strictEqual(outcome.error, failure);
	});

	it('gives up once the restart stops reporting progress', async () => {
		const outcome = await awaitRestart(() => new Promise(() => {}), TIMERS);
		assert.deepStrictEqual(outcome, { completed: false, stalled: true });
	});

	it('keeps waiting while progress is reported', async () => {
		let finish;
		const outcome = await awaitRestart((onProgress) => {
			// Three progress reports spaced past the idle window: a stall would resolve first.
			const beat = setInterval(onProgress, 30);
			setTimeout(() => {
				clearInterval(beat);
				finish({ workersKeptOnOldCode: 0, replacementsNotStarted: 0 });
			}, 200);
			return new Promise((resolve) => {
				finish = resolve;
			});
		}, TIMERS);
		assert.strictEqual(outcome.completed, true);
	});

	it('honors a reported deadline longer than the idle window', async () => {
		const started = Date.now();
		const outcome = await awaitRestart((onProgress) => {
			// One report, as a draining worker sends: busy until well past the idle window.
			onProgress(Date.now() + 250);
			return new Promise(() => {});
		}, TIMERS);
		assert.deepStrictEqual(outcome, { completed: false, stalled: true });
		// Well past the 60ms idle window is the claim; the exact deadline is timer-precision noise.
		assert.ok(
			Date.now() - started >= TIMERS.idleTimeoutMs * 2,
			`the wait should have honored the deadline, gave up after ${Date.now() - started}ms`
		);
	});

	it('stops at the absolute ceiling even while progress keeps arriving', async () => {
		const started = Date.now();
		const outcome = await awaitRestart(
			(onProgress) => {
				setInterval(onProgress, 20).unref();
				return new Promise(() => {});
			},
			{ idleTimeoutMs: 60, ceilingMs: 150 }
		);
		assert.deepStrictEqual(outcome, { completed: false });
		assert.ok(Date.now() - started >= 120, `ceiling fired early, after ${Date.now() - started}ms`);
	});

	it('clears its timers and ignores progress once it has settled', async () => {
		const { result, live } = await withTrackedTimers(async () => {
			let reportProgress;
			const outcome = await awaitRestart((onProgress) => {
				reportProgress = onProgress;
				return Promise.resolve({});
			}, TIMERS);
			// restartWorkers keeps reporting as later workers exit; that must not re-arm anything.
			reportProgress(Date.now() + 60_000);
			return outcome;
		});
		assert.strictEqual(result.completed, true);
		assert.strictEqual(live.size, 0, 'awaitRestart left a timer armed after settling');
	});

	it('reports a synchronous throw from the restart rather than escaping', async () => {
		const failure = new Error('sync failure');
		const { result, live } = await withTrackedTimers(() =>
			awaitRestart(() => {
				throw failure;
			}, TIMERS)
		);
		assert.strictEqual(result.error, failure);
		assert.strictEqual(live.size, 0, 'awaitRestart left a timer armed after a synchronous throw');
	});
});
