const assert = require('node:assert');
const {
	derivedIndexWriteRejection,
	hasDerivedIndexRegistration,
	registerDerivedIndexTables,
} = require('#src/resources/derivedIndexRegistry');

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
});
