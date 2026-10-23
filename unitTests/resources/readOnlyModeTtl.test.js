require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, __setReadOnlyModeForTest } = require('#src/resources/databases');
const auditStore = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

// harper#474 follow-up: TTL expiry is a storage writer that never reaches transaction admission.
// These run on handles that are still writable with the flag flipped, so a missing guard shows up
// as a record or index entry that actually disappears. Stores opened read-only are covered by
// integrationTests/server/read-only-mode-ttl.test.ts. Runs on whichever engine HARPER_STORAGE_ENGINE selects.
describe('read-only mode does not evict expired records', () => {
	const isLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
	let tableSeq = 0;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	afterEach(() => __setReadOnlyModeForTest(undefined));

	const PAST = () => Date.now() - 60_000;
	const FUTURE = () => Date.now() + 3_600_000;

	function makeTable(options = {}) {
		return table({
			table: `ReadOnlyTtl${++tableSeq}`,
			database: 'test',
			expiration: 3600,
			eviction: 3600, // expired but not evictable, so only a read or a deliberate re-arm can evict
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
			...options,
		});
	}

	async function seed(Table, id, name, expiresAt) {
		await Table.put(id, { id, name }, { expiresAt });
		await waitFor(() => Table.primaryStore.getEntry(id));
	}

	const indexed = (Table, name) => Table.indices.name.getValuesCount(name);

	describe('reads', () => {
		let Table;
		before(async function () {
			Table = makeTable();
			await seed(Table, 'expired', 'read', PAST());
			await seed(Table, 'live', 'read', FUTURE());
		});

		it('get treats an expired record as absent and leaves it, its index entry and its cached entry alone', async function () {
			const held = Table.primaryStore.getEntry('expired');
			const version = held.version;
			__setReadOnlyModeForTest(true);
			for (let i = 0; i < 3; i++) assert.ok((await Table.get('expired')) == null);
			assert.strictEqual((await Table.get('live')).name, 'read');
			await delay(50);
			const after = Table.primaryStore.getEntry('expired');
			assert.ok(after?.value, 'the expired record must still be stored');
			assert.strictEqual(after.version, version);
			assert.ok(held.value, 'the cached entry must not be nulled');
			assert.strictEqual(indexed(Table, 'read'), 2);
		});

		it('search omits an expired record, by index and by scan, without touching storage', async function () {
			__setReadOnlyModeForTest(true);
			for (let i = 0; i < 2; i++) {
				const byIndex = [];
				for await (const record of Table.search({ conditions: [{ attribute: 'name', value: 'read' }] }))
					byIndex.push(record.id);
				assert.deepStrictEqual(byIndex, ['live']);
				const byScan = [];
				for await (const record of Table.search({})) byScan.push(record.id);
				assert.deepStrictEqual(byScan, ['live']);
			}
			await delay(50);
			assert.ok(Table.primaryStore.getEntry('expired')?.value);
			assert.strictEqual(indexed(Table, 'read'), 2);
		});

		it('evict() resolves without removing the record or its index entry', async function () {
			const entry = Table.primaryStore.getEntry('expired');
			__setReadOnlyModeForTest(true);
			const eviction = Table.evict('expired', entry.value, entry.version);
			assert.strictEqual(typeof eviction?.then, 'function');
			await eviction;
			assert.ok(Table.primaryStore.getEntry('expired')?.value);
			assert.strictEqual(indexed(Table, 'read'), 2);
		});

		it('still evicts on read once the flag is off (writable behavior is unchanged)', async function () {
			assert.ok((await Table.get('expired')) == null);
			await waitFor(() => Table.primaryStore.getEntry('expired') === undefined);
			await waitFor(() => indexed(Table, 'read') === 1);
			assert.strictEqual((await Table.get('live')).name, 'read');
		});
	});

	describe('cleanup scan', () => {
		let Table;
		let originalRetention;
		before(async function () {
			originalRetention = auditStore.auditRetention;
			// LMDB keeps deletion tombstones only where nothing audits them; RocksDB always sweeps them
			Table = makeTable(isLmdb ? { audit: false } : {});
			await seed(Table, 'expired', 'scan', PAST());
			await seed(Table, 'live', 'scan', FUTURE());
			if (isLmdb) {
				await Table.primaryStore.put('deleted', null, Date.now() - 100_000);
			} else {
				await seed(Table, 'deleted', 'scan-deleted', FUTURE());
				await Table.delete('deleted');
			}
			await waitFor(() => Table.primaryStore.getEntry('deleted')?.value === null);
		});
		after(() => auditStore.setAuditRetention(originalRetention));

		it('is not armed by a read-only process, and is once the flag is off', async function () {
			await Table.closeMaintenance();
			auditStore.setAuditRetention(-1000); // the tombstone is now past retention
			__setReadOnlyModeForTest(true);
			Table.resumeMaintenance();
			Table.setTTLExpiration({ expiration: 0.005, eviction: 0.005 });
			await delay(500);
			assert.ok(Table.primaryStore.getEntry('expired')?.value, 'expired record');
			assert.strictEqual(Table.primaryStore.getEntry('deleted')?.value, null, 'tombstone');
			assert.strictEqual(indexed(Table, 'scan'), 2);

			__setReadOnlyModeForTest(undefined);
			await Table.closeMaintenance();
			Table.resumeMaintenance();
			Table.setTTLExpiration({ expiration: 0.005, eviction: 0.005 });
			await waitFor(() => Table.primaryStore.getEntry('expired') === undefined, 5000);
			await waitFor(() => Table.primaryStore.getEntry('deleted') === undefined, 5000);
			assert.ok(Table.primaryStore.getEntry('live')?.value);
		});
	});

	describe('expiresAt sweep', () => {
		it('is not armed by a read-only process, and is once the flag is off', async function () {
			const Table = table({
				table: `ReadOnlyTtlSweep${++tableSeq}`,
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			});
			await Table.put('expired', { id: 'expired', expiresAt: PAST() });
			await waitFor(() => Table.primaryStore.getEntry('expired'));
			await Table.closeMaintenance();

			// the sweep's own interval is the only thing that runs it, and a read-only process must not start it
			const sweeps = [];
			const realSetInterval = globalThis.setInterval;
			globalThis.setInterval = (callback, interval, ...args) => {
				const timer = realSetInterval(callback, interval, ...args);
				sweeps.push({ callback, timer });
				return timer;
			};
			try {
				__setReadOnlyModeForTest(true);
				Table.resumeMaintenance();
				assert.strictEqual(sweeps.length, 0, 'a read-only process must not arm the expiration sweep');

				__setReadOnlyModeForTest(undefined);
				await Table.closeMaintenance();
				Table.resumeMaintenance();
				assert.strictEqual(sweeps.length, 1, 'a writable process arms the expiration sweep');
				// RocksDB's index stores have no getValues(), which the sweep calls, so only LMDB's sweep can evict
				if (isLmdb) {
					sweeps[0].callback();
					await waitFor(() => Table.primaryStore.getEntry('expired') === undefined, 5000);
				}
			} finally {
				globalThis.setInterval = realSetInterval;
				await Table.closeMaintenance();
			}
		});
	});
});
