const assert = require('node:assert');
const { hasDerivedIndexRegistration, registerDerivedIndexTables } = require('#src/resources/derivedIndexRegistry');

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
});
