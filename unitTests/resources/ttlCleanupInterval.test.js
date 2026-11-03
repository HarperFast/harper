require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { makeTable } = require('#src/resources/Table');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { setTimeout: sleep } = require('node:timers/promises');

// The cleanup scan is what removes an expired record: reads return it until then. Its interval has to come
// from the table's TTL whichever way the TTL was set. A worker that learns of a table from the catalog (a
// table created at runtime on another thread, or any table after a restart) arms it with the number form.
describe('TTL cleanup scan interval', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	// the table as a worker that only loaded it from the catalog sees it
	const hydrate = (Declared, name, { expirationMS, evictionMS }) =>
		makeTable({
			primaryStore: Declared.primaryStore,
			auditStore: Declared.auditStore,
			audit: false,
			expirationMS,
			evictionMS,
			tableName: name,
			tableId: Declared.primaryStore.tableId,
			primaryKey: 'id',
			databasePath: 'test',
			databaseName: 'test',
			indices: {},
			attributes: [{ name: 'id', isPrimaryKey: true }],
			dbisDB: Declared.dbisDB,
		});
	const stored = (Table, id) => Table.primaryStore.getEntry(id) !== undefined;

	it('a table loaded from the catalog evicts on its expiration, not daily', async () => {
		const Declared = table({
			table: 'TtlHydrated',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const Hydrated = hydrate(Declared, 'TtlHydrated', { expirationMS: 50 });
		try {
			await Hydrated.put(1, { id: 1 });
			await Hydrated.primaryStore.committed;
			assert(stored(Hydrated, 1));
			await waitFor(() => !stored(Hydrated, 1), { timeout: 5000, message: 'the expired record was never evicted' });
		} finally {
			Hydrated.cleanup();
		}
	});

	it('the number form derives the interval from the new expiration', async () => {
		const Table = table({ table: 'TtlNumberForm', database: 'test', attributes: [{ name: 'id', isPrimaryKey: true }] });
		Table.setTTLExpiration(3600);
		Table.setTTLExpiration(0.05);
		await Table.put(1, { id: 1 });
		await Table.primaryStore.committed;
		await waitFor(() => !stored(Table, 1), { timeout: 5000, message: 'the expired record was never evicted' });
	});

	it('an expired record stays queryable until the scan evicts it', async () => {
		const Table = table({
			table: 'TtlGrace',
			database: 'test',
			expiration: 0.05,
			eviction: 2,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'kind', indexed: true },
			],
		});
		await Table.put(1, { id: 1, kind: 'a' });
		await Table.primaryStore.committed;
		const { expiresAt } = Table.primaryStore.getEntry(1);
		await sleep(expiresAt + 10 - Date.now());
		const rows = [];
		for await (const row of Table.search({ conditions: [{ attribute: 'kind', value: 'a' }] })) rows.push(row);
		assert(Date.now() < expiresAt + 2_000, 'the query ran after the eviction window opened');
		assert.deepStrictEqual(
			rows.map((row) => row.id),
			[1]
		);
		assert(stored(Table, 1), 'a query does not evict');
		await waitFor(() => !stored(Table, 1), { timeout: 10_000, message: 'the expired record was never evicted' });
	});

	it('the number form keeps a configured scanInterval', () => {
		const Table = table({
			table: 'TtlScanInterval',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const originalSetTimeout = global.setTimeout;
		const delays = [];
		global.setTimeout = (callback, delay, ...args) => {
			delays.push(delay);
			return originalSetTimeout(callback, delay, ...args);
		};
		try {
			Table.setTTLExpiration({ expiration: 0.05, scanInterval: 3600 });
			delays.length = 0;
			Table.setTTLExpiration(0.01);
		} finally {
			global.setTimeout = originalSetTimeout;
		}
		// rescheduled only if the interval changed; a derived 2.5ms interval would have rescheduled
		assert.deepStrictEqual(delays, []);
	});

	it('an eviction-only table loaded from the catalog arms the scan', () => {
		const Declared = table({
			table: 'TtlEvictionOnly',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const originalSetTimeout = global.setTimeout;
		const delays = [];
		global.setTimeout = (callback, delay, ...args) => {
			delays.push(delay);
			return originalSetTimeout(callback, delay, ...args);
		};
		let Hydrated;
		try {
			Hydrated = hydrate(Declared, 'TtlEvictionOnly', { evictionMS: 40_000 });
		} finally {
			global.setTimeout = originalSetTimeout;
		}
		try {
			assert.strictEqual(Hydrated.expirationMS, 0);
			// the first scan lands within one interval, a quarter of the eviction window
			assert.strictEqual(delays.length, 1);
			assert(delays[0] <= 10_000, `the first scan is ${delays[0]}ms out`);
		} finally {
			Hydrated.cleanup();
		}
	});
});
