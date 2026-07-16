require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('node:timers/promises');
const {
	watchCommitSettlement,
	robustBackoff,
	sweepCommitWatchdog,
	setCommitSettleTimeout,
	getCommitWatchdogCounts,
} = require('#src/resources/DatabaseTransaction');
const { constants } = require('@harperfast/rocksdb-js');

// Issue #1785: under CPU throttling, the native commit completion or the retry-backoff timer can be
// silently lost, orphaning the caller's commit promise forever. These tests cover the settlement
// watchdog that bounds both links: passthrough when links are healthy, recovery when they die.
describe('commit settlement watchdog (issue #1785)', () => {
	let previousTimeout;
	beforeEach(() => {
		previousTimeout = setCommitSettleTimeout(50);
	});
	afterEach(() => {
		setCommitSettleTimeout(previousTimeout);
		const counts = getCommitWatchdogCounts();
		assert.deepStrictEqual(counts, { commits: 0, backoffs: 0 }, 'registries must be empty after each test');
	});

	function deferred() {
		let resolve, reject;
		const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
		return { promise, resolve, reject };
	}
	const fakeTxn = (props) => ({ id: 1, ...props });
	const fakeDbTxn = (props) => ({ ...props });

	describe('watchCommitSettlement passthrough', () => {
		it('passes a resolution value through untouched, including the RETRY_NOW sentinel', async () => {
			const d1 = deferred();
			const wrapped1 = watchCommitSettlement(d1.promise, fakeTxn(), fakeDbTxn(), 'commit');
			d1.resolve(undefined);
			assert.strictEqual(await wrapped1, undefined);

			const d2 = deferred();
			const wrapped2 = watchCommitSettlement(d2.promise, fakeTxn(), fakeDbTxn(), 'commit');
			d2.resolve(constants.RETRY_NOW_VALUE);
			assert.strictEqual(await wrapped2, constants.RETRY_NOW_VALUE);
		});

		it('passes a rejection through with the same error identity', async () => {
			const d = deferred();
			const wrapped = watchCommitSettlement(d.promise, fakeTxn(), fakeDbTxn(), 'commit');
			const error = Object.assign(new Error('busy'), { code: 'ERR_BUSY' });
			d.reject(error);
			await assert.rejects(wrapped, (caught) => caught === error);
		});

		it('returns a non-thenable resolution unchanged without registering', () => {
			assert.strictEqual(watchCommitSettlement(undefined, fakeTxn(), fakeDbTxn(), 'commit'), undefined);
			assert.strictEqual(getCommitWatchdogCounts().commits, 0);
		});
	});

	describe('lost native completion recovery', () => {
		it('rejects with an outcome-unknown 503 when the completion never arrives and no outcome is exposed', async () => {
			const wrapped = watchCommitSettlement(deferred().promise, fakeTxn(), fakeDbTxn(), 'commit');
			sweepCommitWatchdog(performance.now() + 60);
			await assert.rejects(wrapped, (error) => {
				assert.strictEqual(error.statusCode, 503);
				assert.match(error.message, /outcome is unknown/);
				return true;
			});
		});

		it('swallows the late real settle after watchdog recovery (no double settle)', async () => {
			const d = deferred();
			const wrapped = watchCommitSettlement(d.promise, fakeTxn(), fakeDbTxn(), 'commit');
			sweepCommitWatchdog(performance.now() + 60);
			await assert.rejects(wrapped, /outcome is unknown/);
			d.resolve(undefined); // late arrival: once-guard must make this a no-op
			await delay(1);
			assert.strictEqual(getCommitWatchdogCounts().commits, 0);
		});

		it('swallows a late real rejection after watchdog recovery without an unhandled rejection', async () => {
			const d = deferred();
			const wrapped = watchCommitSettlement(d.promise, fakeTxn(), fakeDbTxn(), 'commit');
			sweepCommitWatchdog(performance.now() + 60);
			await assert.rejects(wrapped);
			d.reject(new Error('late failure'));
			await delay(1);
		});

		it('resolves as committed when the native txn exposes outcome=committed', async () => {
			const wrapped = watchCommitSettlement(
				deferred().promise,
				fakeTxn({ outcome: 'committed' }),
				fakeDbTxn(),
				'commit'
			);
			sweepCommitWatchdog(performance.now() + 60);
			assert.strictEqual(await wrapped, undefined);
		});

		it('resolves the RETRY_NOW sentinel when the native txn exposes outcome=retry-now', async () => {
			const wrapped = watchCommitSettlement(
				deferred().promise,
				fakeTxn({ outcome: 'retry-now' }),
				fakeDbTxn(),
				'commit'
			);
			sweepCommitWatchdog(performance.now() + 60);
			assert.strictEqual(await wrapped, constants.RETRY_NOW_VALUE);
		});

		it('resolves a lost abort completion (an abort loss cannot affect durability)', async () => {
			const wrapped = watchCommitSettlement(deferred().promise, fakeTxn(), fakeDbTxn(), 'abort');
			sweepCommitWatchdog(performance.now() + 60);
			assert.strictEqual(await wrapped, undefined);
		});

		it('keeps waiting for sourceApply transactions (never-drop invariant) and settles when the real completion arrives', async () => {
			const d = deferred();
			const wrapped = watchCommitSettlement(d.promise, fakeTxn(), fakeDbTxn({ sourceApply: true }), 'commit');
			sweepCommitWatchdog(performance.now() + 60);
			assert.strictEqual(getCommitWatchdogCounts().commits, 1, 'entry must be retained past the deadline');
			d.resolve(undefined);
			assert.strictEqual(await wrapped, undefined);
		});
	});

	describe('robustBackoff', () => {
		it('fires via the normal timer and resolves with the resume result', async () => {
			let resumed = 0;
			const result = await robustBackoff(5, () => {
				resumed++;
				return 'resumed';
			});
			assert.strictEqual(result, 'resumed');
			assert.strictEqual(resumed, 1);
		});

		it('recovers a lost timer via the sweeper, exactly once', async () => {
			let resumed = 0;
			// 60s timer stands in for a lost one: the sweeper must fire the resume long before it
			const pending = robustBackoff(60_000, () => {
				resumed++;
				return 'recovered';
			});
			sweepCommitWatchdog(performance.now() + 70_000);
			assert.strictEqual(await pending, 'recovered');
			assert.strictEqual(resumed, 1);
			sweepCommitWatchdog(performance.now() + 140_000); // once-guard: a second sweep must not resume again
			assert.strictEqual(resumed, 1);
		});

		it('does not recover a timer that is not yet past the grace window', async () => {
			let resumed = 0;
			const pending = robustBackoff(30, () => {
				resumed++;
				return 'ok';
			});
			sweepCommitWatchdog(performance.now()); // in-window sweep: due + grace not reached
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
	});
});
