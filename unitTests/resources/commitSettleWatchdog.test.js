require('../testUtils');
const assert = require('node:assert/strict');
const { robustBackoff, sweepBackoffWatches, getBackoffWatchCount } = require('#src/resources/DatabaseTransaction');

// Issue #1785: under CPU throttling, a commit retry-backoff's one-shot setTimeout continuation can
// be silently severed, orphaning the caller's commit promise forever. robustBackoff registers each
// backoff so the long-transaction monitor's sweep can fire a lost one; these tests cover the
// normal path, the recovery path, and the once-guard between them.
describe('commit retry-backoff recovery (issue #1785)', () => {
	afterEach(() => {
		assert.strictEqual(getBackoffWatchCount(), 0, 'backoff registry must be empty after each test');
	});

	it('fires via the normal timer and resolves with the resume result', async () => {
		let resumed = 0;
		const result = await robustBackoff(5, () => {
			resumed++;
			return 'resumed';
		});
		assert.strictEqual(result, 'resumed');
		assert.strictEqual(resumed, 1);
	});

	it('adopts a promise-returning resume, settling with its eventual value', async () => {
		const result = await robustBackoff(5, () => Promise.resolve('eventual'));
		assert.strictEqual(result, 'eventual');
	});

	it('recovers a lost timer via the sweep, exactly once', async () => {
		let resumed = 0;
		// a 60s timer stands in for a lost one: the sweep must fire the resume long before it
		const pending = robustBackoff(60_000, () => {
			resumed++;
			return 'recovered';
		});
		sweepBackoffWatches(performance.now() + 70_000);
		assert.strictEqual(await pending, 'recovered');
		assert.strictEqual(resumed, 1);
		sweepBackoffWatches(performance.now() + 140_000); // once-guard: a second sweep must not resume again
		assert.strictEqual(resumed, 1);
	});

	it('does not recover a timer that is not yet past the grace window', async () => {
		let resumed = 0;
		const pending = robustBackoff(30, () => {
			resumed++;
			return 'ok';
		});
		sweepBackoffWatches(performance.now()); // in-window sweep: due + grace not reached
		assert.strictEqual(resumed, 0);
		assert.strictEqual(await pending, 'ok'); // real timer still fires
	});

	it('rejects when the resume callback throws synchronously', async () => {
		const failure = new Error('resume failed');
		await assert.rejects(
			robustBackoff(5, () => {
				throw failure;
			}),
			(caught) => caught === failure
		);
	});

	it('a sweep-recovered resume that throws rejects the backoff promise', async () => {
		const failure = new Error('recovered resume failed');
		const pending = robustBackoff(60_000, () => {
			throw failure;
		});
		sweepBackoffWatches(performance.now() + 70_000);
		await assert.rejects(pending, (caught) => caught === failure);
	});
});
