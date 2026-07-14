require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// A schema @expiresAt attribute must be authoritative over the table-level expiration default, in both
// directions. Previously the field only armed a separate index-pruning sweep (which can only remove
// already-past records) and was never fed into the stored expiry metadata that governs read-hiding and
// the cleanup sweep, so a far-future field value could not extend past the table default. These tests
// assert the field value is stamped into the stored expiry metadata.
describe('@expiresAt attribute is authoritative over the table default', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	const makeTable = (name, expirationSeconds) =>
		table({
			table: name,
			database: 'test',
			...(expirationSeconds == null ? {} : { expiration: expirationSeconds }),
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
			],
		});

	const storedExpiresAt = async (Table, id) => {
		await Table.primaryStore.committed;
		return Table.primaryStore.getEntry(id)?.expiresAt;
	};

	it('extends: a far-future field overrides a short table default', async function () {
		const Table = makeTable('ExpiresAtExtend', 3);
		const fieldExpiresAt = Date.now() + 3_600_000; // 1h, far past the 3s table default
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt });
		assert.strictEqual(await storedExpiresAt(Table, 1), fieldExpiresAt);
	});

	it('shortens: a near-future field overrides a long table default', async function () {
		const Table = makeTable('ExpiresAtShorten', 3600);
		const fieldExpiresAt = Date.now() + 1_000; // 1s, well before the 1h table default
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt });
		assert.strictEqual(await storedExpiresAt(Table, 1), fieldExpiresAt);
	});

	it('falls back to the table default when the record has no field value', async function () {
		const Table = makeTable('ExpiresAtFallback', 100);
		const before = Date.now();
		await Table.put(1, { id: 1 });
		const stored = await storedExpiresAt(Table, 1);
		// table default is 100s; stored expiry should be ~now + 100s, not the field (absent)
		assert(stored >= before + 100_000 && stored <= Date.now() + 100_000, `unexpected stored expiresAt ${stored}`);
	});

	it('lets an explicit options.expiresAt override the field', async function () {
		const Table = makeTable('ExpiresAtOptionsOverride', 3);
		const optionExpiresAt = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt: Date.now() + 3_600_000 }, { expiresAt: optionExpiresAt });
		assert.strictEqual(await storedExpiresAt(Table, 1), optionExpiresAt);
	});

	it('keeps the field value across a patch that does not touch it', async function () {
		const Table = makeTable('ExpiresAtPatch', 3);
		const fieldExpiresAt = Date.now() + 3_600_000;
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt, name: 'first' });
		await Table.patch(1, { name: 'second' });
		assert.strictEqual(await storedExpiresAt(Table, 1), fieldExpiresAt);
	});

	it('ignores a negative field value and uses the table default (avoids the -1 sentinel collision)', async function () {
		const Table = makeTable('ExpiresAtNegative', 100);
		const before = Date.now();
		await Table.put(1, { id: 1, expiresAt: -1 });
		const stored = await storedExpiresAt(Table, 1);
		assert(stored >= before + 100_000 && stored <= Date.now() + 100_000, `unexpected stored expiresAt ${stored}`);
	});

	// End-to-end: stamping the field into the expiry metadata makes read-hiding enforce it on a
	// field-only table with no table default — the record is no longer served past its field time.
	// This also covers the RocksDB correctness half of #1481 (the field sweep is LMDB-only, so
	// pre-fix such records stayed live + readable indefinitely on the default engine).
	it('read-hides a field-only record whose @expiresAt has already passed', async function () {
		const Table = makeTable('ExpiresAtReadHide'); // no table-level expiration
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000 });
		await Table.primaryStore.committed;
		assert.strictEqual(await Table.get(1), null);
	});
});
