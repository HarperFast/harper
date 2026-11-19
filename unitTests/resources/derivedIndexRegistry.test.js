const assert = require('node:assert');
const {
	acquireFullTextRetirementFence,
	derivedIndexWriteRejection,
	hasDerivedIndexRegistration,
	registerDerivedIndexTables,
	waitForFullTextRetirement,
	waitForFullTextRetirementLease,
} = require('#src/resources/derivedIndexRegistry');

function lockStore() {
	const held = new Set();
	return {
		status: 'open',
		tryLock(key) {
			if (held.has(key)) return false;
			held.add(key);
			return true;
		},
		unlock(key) {
			held.delete(key);
		},
	};
}

describe('derived index registration tracking', () => {
	it('counts registrations independently by audit store and table', () => {
		const firstStore = {};
		const secondStore = {};
		const releaseFirst = registerDerivedIndexTables(firstStore, [1, 2, 2]);
		const releaseSecond = registerDerivedIndexTables(firstStore, [1]);
		const releaseOtherStore = registerDerivedIndexTables(secondStore, [1]);

		assert.strictEqual(hasDerivedIndexRegistration(firstStore, 1), true);
		assert.strictEqual(hasDerivedIndexRegistration(firstStore, 2), true);
		assert.strictEqual(hasDerivedIndexRegistration(secondStore, 1), true);

		releaseFirst();
		assert.strictEqual(hasDerivedIndexRegistration(firstStore, 1), true);
		assert.strictEqual(hasDerivedIndexRegistration(firstStore, 2), false);

		releaseSecond();
		releaseSecond();
		assert.strictEqual(hasDerivedIndexRegistration(firstStore, 1), false);
		assert.strictEqual(hasDerivedIndexRegistration(secondStore, 1), true);

		releaseOtherStore();
		assert.strictEqual(hasDerivedIndexRegistration(secondStore, 1), false);
	});

	it('returns the first admission reason for a table and none once released', () => {
		const store = {};
		let reason;
		const releaseGated = registerDerivedIndexTables(store, [1], () => reason);
		const releaseOpen = registerDerivedIndexTables(store, [1, 2]);
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined);
		reason = 'behind';
		assert.strictEqual(derivedIndexWriteRejection(store, 1), 'behind');
		assert.strictEqual(derivedIndexWriteRejection(store, 2), undefined);
		releaseGated();
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined);
		assert.strictEqual(hasDerivedIndexRegistration(store, 1), true);
		releaseOpen();
		assert.strictEqual(hasDerivedIndexRegistration(store, 1), false);
	});

	it('cancels a retirement-fence wait when its owner is no longer current', async () => {
		const store = lockStore();
		const release = acquireFullTextRetirementFence(store, 'Product');
		try {
			assert.strictEqual(await waitForFullTextRetirement(store, 'Product', { shouldContinue: () => false }), false);
		} finally {
			release();
		}
	});

	it('rejects retirement-fence waits after the store starts closing', async () => {
		const store = lockStore();
		store.status = 'closing';
		await assert.rejects(waitForFullTextRetirement(store, 'Product'), /closing store/);
	});

	it('bounds retirement-fence waits', async () => {
		const store = lockStore();
		const release = acquireFullTextRetirementFence(store, 'Product');
		try {
			await assert.rejects(waitForFullTextRetirement(store, 'Product', { timeoutMilliseconds: 5 }), (error) => {
				assert.strictEqual(error.name, 'DerivedIndexLagError');
				assert.strictEqual(error.statusCode, 503);
				assert.strictEqual(error.retryable, true);
				return /Timed out waiting/.test(error.message);
			});
		} finally {
			release();
		}
	});

	it('hands a retirement fence directly to one waiter at a time', async () => {
		const store = lockStore();
		const releaseInitial = acquireFullTextRetirementFence(store, 'Product');
		// Waiters poll with independent backoff, so either may take the released fence first.
		const acquired = [];
		const releases = [];
		const waiters = [0, 1].map((waiter) =>
			waitForFullTextRetirementLease(store, 'Product').then((release) => {
				acquired.push(waiter);
				releases.push(release);
				return release;
			})
		);

		releaseInitial();
		try {
			const releaseWinner = await Promise.race(waiters);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.strictEqual(acquired.length, 1);
			const probe = acquireFullTextRetirementFence(store, 'Product');
			probe?.();
			assert.strictEqual(probe, undefined, 'the fence was free while a waiter held its lease');
			releaseWinner();
			const releaseLoser = await waiters[1 - acquired[0]];
			assert.strictEqual(acquired.length, 2);
			releaseLoser();
			const releaseAfter = acquireFullTextRetirementFence(store, 'Product');
			assert.strictEqual(typeof releaseAfter, 'function');
			releaseAfter();
		} finally {
			// A failed assertion must not leave the other waiter polling out its 70 s deadline.
			for (const release of releases) release();
			for (const release of await Promise.all(waiters)) release();
		}
	});
});
