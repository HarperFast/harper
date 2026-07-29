'use strict';

const assert = require('node:assert');

const { waitUntilConfirmedGone } = require('#src/server/threads/manageThreads');

// waitUntilConfirmedGone backs manageThreads.js's Windows dead-worker process-group cleanup: a
// nonzero taskkill result is ambiguous between a real failure and the target having already
// exited before /PID was evaluated, so termination must not be confirmed on that alone. These
// tests drive the retry loop directly with injected callbacks — no real Windows process needed.
describe('waitUntilConfirmedGone', () => {
	it('returns immediately once termination is attempted successfully', async () => {
		let terminationAttempts = 0;
		let aliveChecks = 0;
		await waitUntilConfirmedGone(
			async () => {
				terminationAttempts++;
				return true;
			},
			async () => {
				aliveChecks++;
				return true;
			},
			1
		);
		assert.equal(terminationAttempts, 1);
		assert.equal(aliveChecks, 0);
	});

	it('accepts a failed termination attempt once the tree is independently confirmed gone', async () => {
		await waitUntilConfirmedGone(
			async () => false,
			async () => false,
			1
		);
	});

	it('keeps retrying while termination fails and the tree is still confirmed alive', async () => {
		let attempts = 0;
		await waitUntilConfirmedGone(
			async () => {
				attempts++;
				return attempts >= 3;
			},
			async () => true,
			1
		);
		assert.equal(attempts, 3);
	});

	it('does not treat unknown liveness (null) as confirmed gone', async () => {
		// Only an explicit `false` may end the wait; termination never succeeds here, so if a null
		// (unknown) reading were ever mistaken for "confirmed gone", this would resolve after a
		// single round instead of the 3 rounds it takes for treeIsAlive to report false.
		let aliveChecks = 0;
		await waitUntilConfirmedGone(
			async () => false,
			async () => {
				aliveChecks++;
				return aliveChecks < 3 ? null : false;
			},
			1
		);
		assert.equal(aliveChecks, 3);
	});
});
