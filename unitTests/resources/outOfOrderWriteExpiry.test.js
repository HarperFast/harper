// A write older than the stored record (out-of-order delivery, or an explicit older timestamp) merges under
// the newer head and must leave the head's expiry, unless it changed the @expiresAt field; its audit entry
// keeps its own expiry. The @expiresAt sweep decides on the stored deadline that reads honor.
require('../testUtils');
const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { VERSION_REUSED } = require('#src/resources/RecordEncoder');
const {
	createBlob,
	getFilePathForBlob,
	getFileId,
	getBlobHoldStateForTesting,
	setDeletionDelay,
} = require('#src/resources/blob');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');

const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';
const SWEEP_INTERVAL_MS = 60_000;

describe(`An out-of-order write keeps the newer head's expiry (${ENGINE})`, function () {
	this.timeout(30_000);
	let tableCount = 0;
	const createdTables = [];

	function newTable(attributes, options) {
		const Table = table({
			table: `OutOfOrderExpiry${tableCount++}`,
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, ...attributes],
			...options,
		});
		createdTables.push(Table);
		return Table;
	}

	function auditEntryAt(Table, id, version) {
		for (const entry of Table.auditStore.getRange({ start: 0 }))
			if (entry.tableId === Table.tableId && entry.recordId === id && entry.version === version) return entry;
	}

	// a put at the current time, a patch at t2 = v0 + 100 that is the head, and t1 = v0 + 10 between them
	async function seedHead(Table, id, headExpiresAt) {
		await Table.put(id, { id, a: 'init', b: 'init' });
		const v0 = Table.primaryStore.getEntry(id).version;
		const t2 = v0 + 100;
		await Table.patch(
			id,
			{ a: 'from-t2' },
			headExpiresAt === undefined ? { timestamp: t2 } : { timestamp: t2, expiresAt: headExpiresAt }
		);
		return { t1: v0 + 10, t2 };
	}

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		setDeletionDelay(0);
	});

	afterEach(async function () {
		for (const Table of createdTables.splice(0)) await Table.closeMaintenance?.();
	});

	after(function () {
		setDeletionDelay(undefined);
	});

	it('an older write with a past expiresAt leaves a live head readable and logs its own expiry', async function () {
		const Table = newTable([{ name: 'a' }, { name: 'b' }]);
		const liveExpiresAt = Date.now() + 60_000;
		const staleExpiresAt = Date.now() - 5_000;
		const { t1 } = await seedHead(Table, 'rec', liveExpiresAt);

		await Table.patch('rec', { b: 'from-t1' }, { timestamp: t1, expiresAt: staleExpiresAt });

		const merged = Table.primaryStore.getEntry('rec');
		assert.deepEqual([merged.value.a, merged.value.b], ['from-t2', 'from-t1'], 'precondition: the write merged');
		assert.strictEqual(merged.expiresAt, liveExpiresAt);
		assert.deepEqual(await Table.get('rec'), { id: 'rec', a: 'from-t2', b: 'from-t1' });
		assert.ok(Table.primaryStore.getEntry('rec'), 'the read must not evict the live record');
		assert.strictEqual(auditEntryAt(Table, 'rec', t1)?.expiresAt, staleExpiresAt, 'the audit entry keeps its own');
	});

	it('an older write with no expiresAt neither strips nor shortens the head expiry', async function () {
		const NoDefault = newTable([{ name: 'a' }, { name: 'b' }]);
		const WithDefault = newTable([{ name: 'a' }, { name: 'b' }], { expiration: 60 });
		const liveExpiresAt = Date.now() + 60_000;
		const hourExpiresAt = Date.now() + 3_600_000;
		const noDefault = await seedHead(NoDefault, 'rec', liveExpiresAt);
		const withDefault = await seedHead(WithDefault, 'rec', hourExpiresAt);

		await NoDefault.patch('rec', { b: 'from-t1' }, { timestamp: noDefault.t1 });
		await WithDefault.patch('rec', { b: 'from-t1' }, { timestamp: withDefault.t1 });

		assert.strictEqual(NoDefault.primaryStore.getEntry('rec').expiresAt, liveExpiresAt, 'not stripped');
		assert.strictEqual(WithDefault.primaryStore.getEntry('rec').expiresAt, hourExpiresAt, 'not cut to the default');
		assert.equal(auditEntryAt(NoDefault, 'rec', noDefault.t1)?.expiresAt, undefined, 'the audit entry has none');
	});

	it('a head with no expiry stays without one, whatever the older write carried', async function () {
		const Table = newTable([{ name: 'a' }, { name: 'b' }]);
		const { t1 } = await seedHead(Table, 'rec');
		assert.strictEqual(Table.primaryStore.getEntry('rec').expiresAt, undefined, 'precondition: no expiry');

		await Table.patch('rec', { b: 'from-t1' }, { timestamp: t1, expiresAt: 0 });

		assert.strictEqual(Table.primaryStore.getEntry('rec').expiresAt, undefined);
		assert.strictEqual(auditEntryAt(Table, 'rec', t1)?.expiresAt, 0, 'epoch zero is an expiry in the audit entry');
	});

	it('an older write that sets the @expiresAt field the head left alone takes its expiry from it', async function () {
		const Table = newTable([{ name: 'a' }, { name: 'b' }, { name: 'deadline', expiresAt: true, indexed: true }]);
		const fieldDeadline = Date.now() + 120_000;
		const { t1 } = await seedHead(Table, 'rec', Date.now() + 60_000);

		await Table.patch('rec', { deadline: fieldDeadline }, { timestamp: t1 });

		const merged = Table.primaryStore.getEntry('rec');
		assert.strictEqual(merged.value.deadline, fieldDeadline, 'precondition: the field survived the merge');
		assert.strictEqual(merged.expiresAt, fieldDeadline);
	});

	it('an older write keeps the head expiry when a newer write already set the @expiresAt field', async function () {
		const Table = newTable([{ name: 'a' }, { name: 'deadline', expiresAt: true, indexed: true }]);
		await Table.put('rec', { id: 'rec', a: 'init' });
		const v0 = Table.primaryStore.getEntry('rec').version;
		const headDeadline = Date.now() + 60_000;
		await Table.patch('rec', { deadline: headDeadline }, { timestamp: v0 + 100 });

		await Table.patch('rec', { a: 'from-t1', deadline: Date.now() + 3_600_000 }, { timestamp: v0 + 10 });

		const merged = Table.primaryStore.getEntry('rec');
		assert.strictEqual(merged.value.deadline, headDeadline, 'precondition: the newer field won the merge');
		assert.strictEqual(merged.expiresAt, headDeadline);
	});

	it('two writes to the key in one older transaction decide against the same head on both engines', async function () {
		const Table = newTable([{ name: 'a' }, { name: 'b' }, { name: 'deadline', expiresAt: true, indexed: true }]);
		const fieldDeadline = Date.now() + 120_000;
		const explicitExpiresAt = Date.now() + 240_000;
		const { t1 } = await seedHead(Table, 'rec', Date.now() + 60_000);

		const context = { timestamp: t1 };
		await transaction(context, async () => {
			(await Table.getResource('rec', context))._writeUpdate('rec', { deadline: fieldDeadline }, false);
			(await Table.getResource('rec', context))._writeUpdate('rec', { b: 'from-t1' }, false, {
				expiresAt: explicitExpiresAt,
			});
		});

		const merged = Table.primaryStore.getEntry('rec');
		assert.deepEqual([merged.value.deadline, merged.value.b], [fieldDeadline, 'from-t1'], 'precondition: both merged');
		// the transaction changed the field the head left alone, so the later write's explicit expiry applies;
		// on RocksDB the second write would otherwise compare against the first one's staged field
		assert.strictEqual(merged.expiresAt, explicitExpiresAt);
	});

	it('an older write in a replicated frame keeps the expiry of the newer write staged before it', async function () {
		// only a RocksDB apply frame carries a version per write; LMDB applies a frame at one version
		if (ENGINE === 'lmdb') return this.skip();
		const Table = newTable([{ name: 'a' }, { name: 'b' }]);
		const origin = getIdOfRemoteNode('out-of-order-expiry-origin', Table.auditStore);
		await Table.put('rec', { id: 'rec', a: 'init', b: 'init' });
		const v0 = Table.primaryStore.getEntry('rec').version;
		const liveExpiresAt = Date.now() + 60_000;

		const context = { source: {}, sourceApply: true, timestamp: v0 + 200 };
		await transaction(context, async () => {
			const options = { isNotification: true, nodeId: origin };
			(await Table.getResource('rec', context))._writeUpdate('rec', { a: 'from-t2' }, false, {
				...options,
				version: v0 + 100,
				expiresAt: liveExpiresAt,
			});
			(await Table.getResource('rec', context))._writeUpdate('rec', { b: 'from-t1' }, false, {
				...options,
				version: v0 + 10,
				expiresAt: Date.now() - 5_000,
			});
		});

		const merged = Table.primaryStore.getEntry('rec');
		assert.deepEqual([merged.value.a, merged.value.b], ['from-t2', 'from-t1'], 'precondition: both merged');
		assert.strictEqual(merged.expiresAt, liveExpiresAt);
	});

	it('an older write in a replicated frame keeps the field expiry a newer write in the frame renewed', async function () {
		if (ENGINE === 'lmdb') return this.skip();
		const Table = newTable([{ name: 'a' }, { name: 'b' }, { name: 'deadline', expiresAt: true, indexed: true }]);
		const origin = getIdOfRemoteNode('out-of-order-expiry-origin', Table.auditStore);
		const fieldDeadline = Date.now() + 120_000;
		const { t1, t2 } = await seedHead(Table, 'rec', Date.now() + 60_000);

		const context = { source: {}, sourceApply: true, timestamp: t2 + 100 };
		await transaction(context, async () => {
			const options = { isNotification: true, nodeId: origin };
			(await Table.getResource('rec', context))._writeUpdate('rec', { deadline: fieldDeadline }, false, {
				...options,
				version: t1 + 50,
			});
			(await Table.getResource('rec', context))._writeUpdate('rec', { b: 'from-t1' }, false, {
				...options,
				version: t1,
				expiresAt: Date.now() - 5_000,
			});
		});

		const merged = Table.primaryStore.getEntry('rec');
		assert.deepEqual([merged.value.deadline, merged.value.b], [fieldDeadline, 'from-t1'], 'precondition: both merged');
		assert.strictEqual(merged.expiresAt, fieldDeadline, 'the same result as delivering the writes in two frames');
	});

	it('eviction skips a record an older write renewed through the @expiresAt field', async function () {
		const Table = newTable([
			{ name: 'a' },
			{ name: 'tag', indexed: true },
			{ name: 'blob', type: 'Blob' },
			{ name: 'deadline', expiresAt: true, indexed: true },
		]);
		const pastExpiresAt = Date.now() - 5_000;
		const liveDeadline = Date.now() + 60_000;
		await Table.put('blob-rec', { id: 'blob-rec', a: 'seed' });
		await Table.put('batch-rec', { id: 'batch-rec', a: 'seed' });
		await Table.put('canary', { id: 'canary', a: 'canary' }, { expiresAt: pastExpiresAt });
		const v0 = Table.primaryStore.getEntry('batch-rec').version;
		await Table.patch('blob-rec', { a: 'at-t2' }, { timestamp: v0 + 100, expiresAt: pastExpiresAt });
		await Table.patch('batch-rec', { a: 'at-t2' }, { timestamp: v0 + 100, expiresAt: pastExpiresAt });
		const blobBefore = Table.primaryStore.getEntry('blob-rec');
		const batchBefore = Table.primaryStore.getEntry('batch-rec');
		const canaryBefore = Table.primaryStore.getEntry('canary');

		const blob = await createBlob(randomBytes(20_000));
		await Table.patch('blob-rec', { tag: 'blob-renewed', blob, deadline: liveDeadline }, { timestamp: v0 + 10 });
		await Table.patch('batch-rec', { tag: 'batch-renewed', deadline: liveDeadline }, { timestamp: v0 + 10 });
		const blobFilePath = getFilePathForBlob(blob);
		assert.ok(blobFilePath && fs.existsSync(blobFilePath), 'precondition: the blob is file-backed');
		for (const id of ['blob-rec', 'batch-rec']) {
			const renewed = Table.primaryStore.getEntry(id);
			assert.strictEqual(renewed.expiresAt, liveDeadline, 'precondition: the field renewed the expiry');
			if (ENGINE === 'rocksdb') {
				assert.strictEqual(renewed.version, v0 + 100, 'precondition: RocksDB keeps the newer version');
				assert.ok(renewed.metadataFlags & VERSION_REUSED, 'precondition: the version is marked reused');
			}
		}

		await Table.evict('blob-rec', blobBefore.value, blobBefore.version, undefined, blobBefore.expiresAt);

		// the cleanup scan reads the pre-renewal entries: the blob record goes through evict(), the other through
		// the eviction batch on RocksDB
		const realGetRange = Table.primaryStore.getRange;
		let servedStaleSnapshot = false;
		Table.primaryStore.getRange = function (options) {
			if (!options?.lazy) return realGetRange.apply(this, arguments);
			if (servedStaleSnapshot) return [];
			servedStaleSnapshot = true;
			return [blobBefore, batchBefore, canaryBefore].map(({ key, value, version, expiresAt, metadataFlags }) => ({
				key,
				value,
				version,
				expiresAt,
				metadataFlags,
			}));
		};
		try {
			Table.setTTLExpiration({ expiration: 0.005, eviction: 0.005 });
			await waitFor(() => Table.primaryStore.getEntry('canary') === undefined, 5_000);
		} finally {
			Table.primaryStore.getRange = realGetRange;
			await Table.closeMaintenance();
		}

		assert.strictEqual(Table.primaryStore.getEntry('blob-rec')?.value.tag, 'blob-renewed');
		assert.strictEqual(Table.indices.tag.getValuesCount('blob-renewed'), 1);
		assert.ok(fs.existsSync(blobFilePath), 'the renewed record keeps its blob file');
		if (ENGINE === 'rocksdb')
			assert.strictEqual(
				getBlobHoldStateForTesting(Table.primaryStore.rootStore, getFileId(blob)).pendingReclamation,
				false
			);
		assert.strictEqual(Table.primaryStore.getEntry('batch-rec')?.value.tag, 'batch-renewed');
		assert.strictEqual(Table.indices.tag.getValuesCount('batch-renewed'), 1);
	});

	describe('the @expiresAt sweep', function () {
		// RocksDB's index has no getValues(key), so the sweep cannot run there yet (harper#1481); this stands
		// in for it so the eviction decision runs on both engines. A RocksDB key-only range still yields
		// { key, value } entries, so the sweep hands it an entry.
		function ensureIndexGetValues(index) {
			if (typeof index.getValues === 'function') return;
			index.getValues = (key) => [key.value];
		}

		async function captureSweep(Table) {
			await Table.closeMaintenance();
			const captured = [];
			const realSetInterval = globalThis.setInterval;
			globalThis.setInterval = (callback, interval, ...args) => {
				if (interval === SWEEP_INTERVAL_MS) captured.push(callback);
				return realSetInterval(callback, interval, ...args);
			};
			try {
				Table.resumeMaintenance();
			} finally {
				globalThis.setInterval = realSetInterval;
			}
			assert.strictEqual(captured.length, 1, 'precondition: resumeMaintenance() armed the @expiresAt sweep');
			return captured[0];
		}

		function sweptTable() {
			const Table = newTable([
				{ name: 'deadline', expiresAt: true, indexed: true },
				{ name: 'tag', indexed: true },
			]);
			ensureIndexGetValues(Table.indices.deadline);
			return Table;
		}

		it('keeps a record whose stored deadline overrides a past field, and evicts an expired one', async function () {
			const Table = sweptTable();
			const sweep = await captureSweep(Table);
			const pastField = Date.now() - 5_000;
			const futureExpiresAt = Date.now() + 60_000;
			await Table.put(
				'override',
				{ id: 'override', deadline: pastField - 1_000, tag: 'override' },
				{ expiresAt: futureExpiresAt }
			);
			await Table.put('z-expired', { id: 'z-expired', deadline: pastField, tag: 'expired' });
			assert.strictEqual(Table.primaryStore.getEntry('override').expiresAt, futureExpiresAt, 'precondition');
			assert.ok(await Table.get('override'), 'precondition: reads see the record as live');

			sweep();
			await waitFor(() => Table.primaryStore.getEntry('z-expired') === undefined, 5_000);

			assert.strictEqual(Table.primaryStore.getEntry('override')?.expiresAt, futureExpiresAt);
			assert.strictEqual(Table.indices.tag.getValuesCount('override'), 1);
		});

		it('evicts on the stored deadline when the field is a date string', async function () {
			const Table = sweptTable();
			const sweep = await captureSweep(Table);
			const pastMs = Date.now() - 6_000;
			await Table.put('iso', { id: 'iso', deadline: new Date(pastMs).toISOString(), tag: 'iso' });
			await Table.put('z-number', { id: 'z-number', deadline: pastMs + 1_000, tag: 'number' });
			assert.strictEqual(Table.primaryStore.getEntry('iso').expiresAt, pastMs, 'precondition: the deadline is stored');
			// The range scan stops at Date.now(), so it never reaches a string index key on its own; a numeric
			// key stands in so the sweep reaches the row.
			const index = Table.indices.deadline;
			if (typeof index.putSync === 'function') index.putSync(pastMs, 'iso');
			else await index.put(pastMs, 'iso');

			sweep();
			await waitFor(() => Table.primaryStore.getEntry('z-number') === undefined, 5_000);

			assert.strictEqual(Table.primaryStore.getEntry('iso'), undefined);
		});
	});
});
