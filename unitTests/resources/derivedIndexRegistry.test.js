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
			await assert.rejects(
				waitForFullTextRetirement(store, 'Product', { timeoutMilliseconds: 5 }),
				/Timed out waiting/
			);
		} finally {
			release();
		}
	});

	it('hands a retirement fence directly to one waiter at a time', async () => {
		const store = lockStore();
		const releaseInitial = acquireFullTextRetirementFence(store, 'Product');
		const first = waitForFullTextRetirementLease(store, 'Product');
		await new Promise((resolve) => setImmediate(resolve));
		let secondAcquired = false;
		const second = waitForFullTextRetirementLease(store, 'Product').then((release) => {
			secondAcquired = true;
			return release;
		});

		releaseInitial();
		const releaseFirst = await first;
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(secondAcquired, false);
		releaseFirst();
		const releaseSecond = await second;
		assert.strictEqual(typeof releaseSecond, 'function');
		releaseSecond();
	});
});
