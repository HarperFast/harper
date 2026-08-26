'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { awaitRestart } = require('#src/components/awaitRestart');

const TIMERS = { idleTimeoutMs: 60, ceilingMs: 1000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
		assert.ok(
			Date.now() - started >= 250,
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
		assert.ok(Date.now() - started >= 150, 'ceiling should not fire early');
	});

	it('does not leave a timer holding the event loop open', async () => {
		await awaitRestart(async () => ({}), TIMERS);
		// A leaked idle/ceiling timer would keep firing after the outcome settled.
		await sleep(TIMERS.idleTimeoutMs * 2);
	});
});
