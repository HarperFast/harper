require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const {
	table,
	databases,
	getDatabases,
	resetDatabases,
	armTableCleanupScans,
	scopedTableFactory,
} = require('#src/resources/databases');
const { makeTable } = require('#src/resources/Table');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { setTimeout: sleep } = require('node:timers/promises');

async function timersArmedBy(run, settleMs = 0) {
	const originalSetTimeout = global.setTimeout;
	const delays = [];
	global.setTimeout = (callback, delay, ...args) => {
		delays.push(delay);
		return originalSetTimeout(callback, delay, ...args);
	};
	try {
		run();
		if (settleMs) await sleep(settleMs);
	} finally {
		global.setTimeout = originalSetTimeout;
	}
	return delays;
}
// the TTLs these tests clear scan every 15 s or less
const isDailyCadence = (delay) => (delay > 15_000 && delay <= 86_400_000) || isNextDailySlot(delay);
// a first daily scan with nothing pending lands on the next whole day since the start of the year
function isNextDailySlot(delay) {
	const startOfYear = new Date();
	startOfYear.setMonth(0, 1);
	startOfYear.setHours(0, 0, 0); // keeps the milliseconds, as scheduleCleanup does
	const now = Date.now();
	const slot = Math.ceil((now - startOfYear.getTime()) / 86_400_000) * 86_400_000 + startOfYear.getTime();
	return Math.abs(delay - (slot - now)) < 5000;
}

// The cleanup scan is what removes an expired record: reads return it until then. Its interval has to come
// from the table's TTL whichever way the TTL was set. A worker that learns of a table from the catalog (a
// table created at runtime on another thread, or any table after a restart) arms it with the number form.
describe('TTL cleanup scan interval', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	const databaseName = 'ttl_cleanup_interval';
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
			databasePath: databaseName,
			databaseName,
			indices: {},
			attributes: [{ name: 'id', isPrimaryKey: true }],
			dbisDB: Declared.dbisDB,
		});
	const stored = (Table, id) => Table.primaryStore.getEntry(id) !== undefined;

	it('a table loaded from the catalog evicts on its expiration, not daily', async () => {
		const Declared = table({
			table: 'TtlHydrated',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Declared.put(1, { id: 1 }, { expiresAt: Date.now() - 1000 });
		await Declared.primaryStore.committed;
		const entry = Declared.primaryStore.getEntry(1);
		assert(entry);
		assert(entry.expiresAt < Date.now());
		const Hydrated = hydrate(Declared, 'TtlHydrated', { expirationMS: 50 });
		try {
			assert.strictEqual(Hydrated.expirationMS, 50);
			await waitFor(() => !stored(Hydrated, 1), { timeout: 5000, message: 'the expired record was never evicted' });
		} finally {
			Hydrated.cleanup();
			Declared.cleanup();
		}
	});

	it('the number form derives the interval from the new expiration', async () => {
		const Table = table({
			table: 'TtlNumberForm',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		try {
			Table.setTTLExpiration(3600);
			Table.setTTLExpiration(1);
			await Table.put(1, { id: 1 });
			await Table.primaryStore.committed;
			assert(stored(Table, 1));
			await waitFor(() => !stored(Table, 1), { timeout: 5000, message: 'the expired record was never evicted' });
		} finally {
			Table.cleanup();
		}
	});

	it('an expired record stays queryable until the scan evicts it', async () => {
		const Table = table({
			table: 'TtlGrace',
			database: databaseName,
			expiration: 0.05,
			eviction: 2,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'kind', indexed: true },
			],
		});
		try {
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
		} finally {
			Table.cleanup();
		}
	});

	it("an isolated application's schema without a TTL leaves the scan for one application code set (QA-5424)", async () => {
		const definition = {
			table: 'TtlIsolatedApplicationKept',
			database: databaseName,
			expiration: null,
			eviction: null,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		};
		// the table as a previous start left it; application code (jsResource) then loads before the schema
		const Table = table({ table: definition.table, database: databaseName, attributes: definition.attributes });
		const isolatedTable = scopedTableFactory(undefined, true);
		try {
			Table.sourcedFrom({ get: (id) => ({ id }) }, { expiration: 0.5 });
			isolatedTable(definition);
			isolatedTable(definition);
			assert.strictEqual(Table.expirationMS, 500);
			await Table.put(1, { id: 1 });
			await Table.primaryStore.committed;
			assert(stored(Table, 1));
			await waitFor(() => !stored(Table, 1), { timeout: 5000, message: 'the expired record was never evicted' });
		} finally {
			Table.cleanup();
		}
	});

	it('the number form keeps a configured scanInterval', () => {
		const Table = table({
			table: 'TtlScanInterval',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const originalSetTimeout = global.setTimeout;
		const delays = [];
		global.setTimeout = (callback, delay, ...args) => {
			delays.push(delay);
			return originalSetTimeout(callback, delay, ...args);
		};
		try {
			try {
				Table.setTTLExpiration({ expiration: 0.05, scanInterval: 3600 });
				delays.length = 0;
				Table.setTTLExpiration(0.01);
			} finally {
				global.setTimeout = originalSetTimeout;
			}
			// rescheduled only if the interval changed; a derived 2.5ms interval would have rescheduled
			assert.deepStrictEqual(delays, []);
		} finally {
			Table.cleanup();
		}
	});

	it('an eviction-only table loaded from the catalog arms the scan', () => {
		const Declared = table({
			table: 'TtlEvictionOnly',
			database: databaseName,
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
	it('an eviction-only TTL adopted from the catalog arms the scan (#3935)', async () => {
		const Declared = table({
			table: 'TtlAdoptedEvictionOnly',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const Hydrated = hydrate(Declared, 'TtlAdoptedEvictionOnly', {});
		try {
			const delays = await timersArmedBy(() => Hydrated._adoptCatalogExpiration(0, 0.05));
			assert.strictEqual(Hydrated.expirationMS, 0);
			assert.strictEqual(Hydrated.evictionMS, 50);
			assert.strictEqual(delays.length, 1, 'adopting an eviction-only TTL must arm the scan');
			await Hydrated.put(1, { id: 1 }, { expiresAt: Date.now() });
			await Hydrated.primaryStore.committed;
			await waitFor(() => !stored(Hydrated, 1), { timeout: 5000, message: 'the evictable record was never evicted' });
		} finally {
			Hydrated.cleanup();
		}
	});

	it('adopting a cleared TTL leaves the scan at the daily default (#3934)', async () => {
		const Declared = table({
			table: 'TtlAdoptedClear',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const Hydrated = hydrate(Declared, 'TtlAdoptedClear', { expirationMS: 60_000 });
		try {
			const delays = await timersArmedBy(() => Hydrated._adoptCatalogExpiration(undefined, undefined), 200);
			assert.strictEqual(Hydrated.expirationMS, 0);
			assert.strictEqual(Hydrated.evictionMS, 0);
			assert(delays.some(isDailyCadence), `no daily scan armed: ${delays}`);
		} finally {
			Hydrated.cleanup();
		}
	});

	it('clearing a TTL with zeros keeps a scan for per-record expiry instead of disabling it', async () => {
		const Table = table({
			table: 'TtlZeroed',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		try {
			Table.setTTLExpiration({ expiration: 60 });
			const delays = await timersArmedBy(() => Table.setTTLExpiration({ expiration: 0, eviction: 0 }), 200);
			assert(delays.some(isDailyCadence), `the scan was disabled instead of moved to the daily default: ${delays}`);
		} finally {
			Table.cleanup();
		}
	});

	it('rejects a negative or non-finite value without applying any of it (#3935)', () => {
		const Table = table({
			table: 'TtlRejected',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		try {
			Table.setTTLExpiration({ expiration: 10, eviction: 5 });
			for (const opts of [
				{ expiration: 1, eviction: -1 },
				{ expiration: -1, eviction: 1 },
				{ expiration: 1, scanInterval: -1 },
				{ expiration: Infinity },
				{ expiration: Number.NaN },
				-1,
			]) {
				assert.throws(
					() => Table.setTTLExpiration(opts),
					/must be a non-negative number of seconds/,
					JSON.stringify(opts)
				);
				assert.strictEqual(Table.expirationMS, 10_000, `${JSON.stringify(opts)} changed the expiration`);
				assert.strictEqual(Table.evictionMS, 5_000, `${JSON.stringify(opts)} changed the eviction`);
			}
		} finally {
			Table.cleanup();
		}
	});

	it('a table loaded before the main thread became a worker arms its scan once it is one (#2831)', async () => {
		const tableName = 'TtlLoadedBeforePromotion';
		const definition = { table: tableName, database: databaseName, attributes: [{ name: 'id', isPrimaryKey: true }] };
		const Declared = table(definition);
		// a restart: the row outlives this class, whose scan stops with it; the TTL comes after the commit, so
		// no scan of this class can reach the row
		const expiresAt = Date.now() + 1000;
		await Declared.put(1, { id: 1 }, { expiresAt });
		await Declared.primaryStore.committed;
		table({ ...definition, expiration: 0.05 });
		Declared.cleanup();
		delete databases[databaseName][tableName];
		let Loaded;
		try {
			// threads: 0 loads every table on the main thread before setMainIsWorker(true)
			setMainIsWorker(false);
			resetDatabases();
			Loaded = getDatabases()[databaseName][tableName];
		} finally {
			setMainIsWorker(true);
		}
		try {
			assert.strictEqual(Loaded.expirationMS, 50);
			await sleep(Math.max(0, expiresAt + 300 - Date.now()));
			assert(stored(Loaded, 1), 'a scan ran although no thread owned it at load');
			armTableCleanupScans();
			await waitFor(() => !stored(Loaded, 1), { timeout: 5000, message: 'the expired record was never evicted' });
		} finally {
			Loaded.cleanup();
		}
	});

	it('a TTL cleared once the main thread is a worker still scans the rows it stamped (#2831, #3934)', async () => {
		const Declared = table({
			table: 'TtlClearedAfterPromotion',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		let Hydrated;
		try {
			// threads: 0 loads the table before the main thread owns any scan, then the schema clears its TTL
			setMainIsWorker(false);
			Hydrated = hydrate(Declared, 'TtlClearedAfterPromotion', { expirationMS: 60_000 });
		} finally {
			setMainIsWorker(true);
		}
		try {
			const delays = await timersArmedBy(
				() => Hydrated.setTTLExpiration({ expiration: 0, eviction: 0, fromSchema: true }),
				200
			);
			assert(delays.some(isDailyCadence), `no scan armed for the rows the cleared TTL stamped: ${delays}`);
		} finally {
			Hydrated.cleanup();
		}
	});

	it('keeps a scan for rows a cleared TTL stamped after a restart (#3934)', async () => {
		const tableName = 'TtlClearedThenRestarted';
		const attributes = () => [{ name: 'id', isPrimaryKey: true }];
		const Declared = table({ table: tableName, database: databaseName, expiration: 60, attributes: attributes() });
		table({ table: tableName, database: databaseName, expiration: 0, attributes: attributes() });
		if (Declared.dbisDB.committed) await Declared.dbisDB.committed;
		const primaryRow = Declared.dbisDB.getSync(`${tableName}/`) ?? Declared.dbisDB.getSync(`${tableName}/id`);
		assert.strictEqual(primaryRow.expiryScan, true, JSON.stringify(primaryRow));
		Declared.cleanup();
		delete databases[databaseName][tableName];
		let Restarted;
		try {
			// loaded with no scan owner, so the only timer below is the one this table arms
			setMainIsWorker(false);
			resetDatabases();
			Restarted = getDatabases()[databaseName][tableName];
		} finally {
			setMainIsWorker(true);
		}
		try {
			assert(!Restarted.expirationMS);
			const delays = await timersArmedBy(() => Restarted._armCleanupScan());
			assert(delays.length === 1 && isNextDailySlot(delays[0]), `no daily scan armed: ${delays}`);
		} finally {
			Restarted.cleanup();
		}
	});

	it('a loaded class arms the scan when a reload finds the catalog marked expiryScan', async () => {
		const Declared = table({
			table: 'TtlReloadExpiryScan',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const Hydrated = hydrate(Declared, 'TtlReloadExpiryScan', {});
		try {
			const delays = await timersArmedBy(() => Hydrated._adoptCatalogExpiration(undefined, undefined, true));
			assert(delays.length === 1 && isNextDailySlot(delays[0]), `no daily scan armed: ${delays}`);
		} finally {
			Hydrated.cleanup();
		}
	});

	it('keeps a scan for rows a cleared TTL stamped when maintenance resumes (#3934)', async () => {
		const Table = table({
			table: 'TtlClearedThenResumed',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		try {
			Table.setTTLExpiration({ expiration: 60 });
			Table.setTTLExpiration({ expiration: 0, eviction: 0 });
			await Table.closeMaintenance();
			const delays = await timersArmedBy(() => Table.resumeMaintenance());
			assert(delays.some(isDailyCadence), `resuming maintenance armed no scan: ${delays}`);
		} finally {
			Table.cleanup();
		}
	});

	it('arms no scan for a table with no TTL', async () => {
		const Table = table({
			table: 'TtlNoneToArm',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		try {
			assert.deepStrictEqual(await timersArmedBy(() => Table._armCleanupScan()), []);
		} finally {
			Table.cleanup();
		}
	});

	it('arms system tables too, which databases does not enumerate', () => {
		const systemTables = Object.values(databases.system);
		assert(systemTables.length > 0);
		assert(!Object.keys(databases).includes('system'), 'the system database is enumerable now; simplify this test');
		const armed = new Set();
		const originals = systemTables.map((Table) => [Table, Table._armCleanupScan]);
		for (const Table of systemTables) Table._armCleanupScan = () => armed.add(Table);
		try {
			armTableCleanupScans();
		} finally {
			for (const [Table, original] of originals) Table._armCleanupScan = original;
		}
		assert.strictEqual(armed.size, systemTables.length);
	});
});
