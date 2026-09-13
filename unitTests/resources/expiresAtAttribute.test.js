require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { makeTable: makeTableResource } = require('#src/resources/Table');
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

	it('accepts a Date field value', async function () {
		const Table = makeTable('ExpiresAtDate', 3);
		const fieldExpiresAt = Date.now() + 3_600_000;
		await Table.put(1, { id: 1, expiresAt: new Date(fieldExpiresAt) });
		assert.strictEqual(await storedExpiresAt(Table, 1), fieldExpiresAt);
	});

	it('accepts an ISO-string field value', async function () {
		const Table = makeTable('ExpiresAtIso', 3);
		const fieldExpiresAt = Date.now() + 3_600_000;
		await Table.put(1, { id: 1, expiresAt: new Date(fieldExpiresAt).toISOString() });
		assert.strictEqual(await storedExpiresAt(Table, 1), fieldExpiresAt);
	});

	it('ignores non-timestamp field values (boolean / empty string) and uses the table default', async function () {
		const Bool = makeTable('ExpiresAtBool', 100);
		const Empty = makeTable('ExpiresAtEmpty', 100);
		const before = Date.now();
		await Bool.put(1, { id: 1, expiresAt: true });
		await Empty.put(1, { id: 1, expiresAt: '' });
		for (const T of [Bool, Empty]) {
			const stored = await storedExpiresAt(T, 1);
			assert(stored >= before + 100_000 && stored <= Date.now() + 100_000, `unexpected stored expiresAt ${stored}`);
		}
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

	it('refreshes @expiresAt behavior when a live table is redeclared', async function () {
		const Table = table({
			table: 'ExpiresAtRedeclared',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const Redeclared = table({
			table: 'ExpiresAtRedeclared',
			database: 'test',
			isolatedApplicationOwner: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
			],
		});
		assert.strictEqual(Redeclared, Table);
		const expiresAt = Date.now() - 1_000;
		await Redeclared.put(1, { id: 1, expiresAt });
		assert.strictEqual(await storedExpiresAt(Redeclared, 1), expiresAt);
		assert.strictEqual(await Redeclared.get(1), null);
	});

	// A worker that only hydrated a table from the catalog has no cleanup scan armed: setTTLExpiration
	// runs at construction only when an expiration is set, and an eviction-only table persists
	// expiration 0. When an isolated application then redeclares that table with just an @expiresAt
	// attribute, the declaration preserves the loaded configuration -- so the loaded eviction is the
	// only thing left that can arm the scan, and without it those records are never physically evicted.
	it('arms a preserved eviction cleanup on an ownership-only redeclaration', () => {
		const Declared = table({
			table: 'EvictionOnlyDeclared',
			database: 'test',
			eviction: 40,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(Declared.evictionMS, 40_000);
		// the same table as a worker that only hydrated it sees it: eviction from the persisted
		// metadata, and no setTTLExpiration call of its own
		const hydrated = (evictionMS) =>
			makeTableResource({
				primaryStore: Declared.primaryStore,
				auditStore: Declared.auditStore,
				audit: false,
				evictionMS,
				tableName: `EvictionOnlyHydrated-${evictionMS}`,
				tableId: Declared.primaryStore.tableId,
				primaryKey: 'id',
				databasePath: 'test',
				databaseName: 'test',
				indices: {},
				attributes: [{ name: 'id', isPrimaryKey: true }],
				dbisDB: Declared.dbisDB,
			});
		const cleanupTimersArmedBy = (Table) => {
			const originalSetTimeout = global.setTimeout;
			let timers = 0;
			global.setTimeout = (callback, delay, ...args) => {
				timers++;
				return originalSetTimeout(callback, delay, ...args);
			};
			try {
				Table.setTTLExpiration({ fromSchema: true, isolatedApplicationOwner: true });
			} finally {
				global.setTimeout = originalSetTimeout;
			}
			return timers;
		};
		assert.strictEqual(cleanupTimersArmedBy(hydrated(40_000)), 1, 'the preserved eviction arms the cleanup scan');
		assert.strictEqual(cleanupTimersArmedBy(hydrated(0)), 0, 'with nothing loaded to clean up, none is armed');
	});

	it('arms one @expiresAt interval initially and when a live table gains the attribute', async () => {
		const originalSetInterval = global.setInterval;
		const originalSetTimeout = global.setTimeout;
		let expirationIntervals = 0;
		let cleanupTimers = 0;
		global.setInterval = (callback, delay, ...args) => {
			if (delay === 60_000) expirationIntervals++;
			return originalSetInterval(callback, delay, ...args);
		};
		global.setTimeout = (callback, delay, ...args) => {
			cleanupTimers++;
			return originalSetTimeout(callback, delay, ...args);
		};
		try {
			const beforeInitialDeclaration = expirationIntervals;
			table({
				table: 'ExpiresAtInitialInterval',
				database: 'test',
				expiration: 60,
				isolatedApplicationOwner: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			});
			assert.strictEqual(expirationIntervals, beforeInitialDeclaration + 1);

			table({
				table: 'ExpiresAtAddedAfterTtl',
				database: 'test',
				expiration: 60,
				isolatedApplicationOwner: true,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const before = expirationIntervals;
			const AddedAfterTtl = table({
				table: 'ExpiresAtAddedAfterTtl',
				database: 'test',
				isolatedApplicationOwner: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			});
			assert.strictEqual(expirationIntervals, before + 1);
			assert.strictEqual(AddedAfterTtl.expirationMS, 60_000, 'ownership-only redeclaration preserves loaded TTL');
			const beforeDefaultExpiry = Date.now();
			await AddedAfterTtl.put(1, { id: 1 });
			const storedDefaultExpiry = await storedExpiresAt(AddedAfterTtl, 1);
			assert(
				storedDefaultExpiry >= beforeDefaultExpiry + 60_000 && storedDefaultExpiry <= Date.now() + 60_000,
				`unexpected retained default expiry ${storedDefaultExpiry}`
			);

			const beforeSharedDeclarationTimers = cleanupTimers;
			table({
				table: 'ExpiresAtAddedToSharedTable',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const beforeSharedRedeclaration = expirationIntervals;
			table({
				table: 'ExpiresAtAddedToSharedTable',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			});
			assert.strictEqual(expirationIntervals, beforeSharedRedeclaration + 1);
			assert.strictEqual(
				cleanupTimers,
				beforeSharedDeclarationTimers,
				'field-only declarations do not create a default table cleanup timer'
			);
		} finally {
			global.setInterval = originalSetInterval;
			global.setTimeout = originalSetTimeout;
		}
	});
});
