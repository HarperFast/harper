require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase, dropDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { Transaction: RocksTransaction } = require('@harperfast/rocksdb-js');
const { asBinary } = require('lmdb');
const sinon = require('sinon');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { existsSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');

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

	const makeTable = (name, expirationSeconds, options = {}) =>
		table({
			table: name,
			database: 'test',
			...options,
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

	const captureExpirationSweep = (createTable) => {
		let runSweep;
		let sweepIntervalCount = 0;
		const realSetInterval = global.setInterval;
		const intervalStub = sinon.stub(global, 'setInterval').callsFake((callback, interval, ...args) => {
			if (interval === 60_000) {
				runSweep = callback;
				sweepIntervalCount++;
				return { unref() {} };
			}
			return realSetInterval(callback, interval, ...args);
		});
		let Table;
		try {
			Table = createTable();
		} finally {
			intervalStub.restore();
		}
		assert(runSweep, 'table creation should register the expiration sweep');
		assert.strictEqual(sweepIntervalCount, 1);
		return { Table, runSweep };
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

	it('canonicalizes supported expiration shapes in the index and in searches', async function () {
		const Table = makeTable('ExpiresAtCanonicalIndex');
		const expiresAt = Date.now() + 3_600_000;
		const values = [expiresAt, String(expiresAt), new Date(expiresAt).toISOString(), new Date(expiresAt)];
		for (let id = 0; id < values.length; id++) await Table.put(id, { id, expiresAt: values[id] });
		await Table.primaryStore.committed;

		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [0, 1, 2, 3]);
		for (const value of values) {
			const ids = [];
			for await (const record of Table.search({
				allowFullScan: false,
				conditions: [{ attribute: 'expiresAt', value }],
			})) {
				ids.push(record.id);
			}
			assert.deepStrictEqual(ids, [0, 1, 2, 3]);
		}
		Table.cleanup();
	});

	it('rebuilds a legacy expiration index into the canonical format', async function () {
		const tableName = 'ExpiresAtCanonicalRebuild';
		const Table = makeTable(tableName);
		const expiresAt = Date.now() + 3_600_000;
		const isoExpiresAt = new Date(expiresAt).toISOString();
		await Table.put(1, { id: 1, expiresAt: isoExpiresAt });
		await Table.primaryStore.committed;

		const attribute = Table.attributes.find((candidate) => candidate.name === 'expiresAt');
		const descriptor = Table.dbisDB.getSync(attribute.key);
		delete descriptor.expirationIndexVersion;
		await Table.dbisDB.put(attribute.key, descriptor);
		await Table.indices.expiresAt.clear();
		await Table.indices.expiresAt.put(isoExpiresAt, 1);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(isoExpiresAt)], [1]);

		const Reloaded = makeTable(tableName);
		await Reloaded.indexingOperation;
		assert.deepStrictEqual([...Reloaded.indices.expiresAt.getValues(isoExpiresAt)], []);
		assert.deepStrictEqual([...Reloaded.indices.expiresAt.getValues(expiresAt)], [1]);
		Table.cleanup();
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

	it('does not index or evict a field-only record without a valid expiration', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtNoExpiration'));
		await Table.put(1, { id: 1 });
		await Table.put(2, { id: 2, expiresAt: -1 });
		await Table.primaryStore.committed;
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(-1)], []);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.id, 1);
		assert.strictEqual(Table.primaryStore.getEntry(2)?.value.id, 2);
		Table.cleanup();
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

	it('enumerates exact Rocks index values for the expiration sweep', async function () {
		const Table = makeTable('ExpiresAtIndexValues');
		const expiresAt = Date.now() + 60_000;
		await Table.put(0, { id: 0, expiresAt: expiresAt - 1 });
		await Table.put(5, { id: 5, expiresAt: expiresAt - 1 });
		await Table.put(1, { id: 1, expiresAt });
		await Table.put(2, { id: 2, expiresAt });
		await Table.put(3, { id: 3, expiresAt: expiresAt + 1 });
		await Table.put([4, 'part'], { id: [4, 'part'], expiresAt: expiresAt + 2 });
		await Table.primaryStore.committed;

		const index = Table.indices.expiresAt;
		const expirationKeys = index.getRange({ start: true, values: false, end: expiresAt + 1, snapshot: false });
		assert.deepStrictEqual([...expirationKeys], [expiresAt - 1, expiresAt]);
		assert.deepStrictEqual([...expirationKeys], [expiresAt - 1, expiresAt]);
		assert.deepStrictEqual([...expirationKeys.map((value) => value)], [expiresAt - 1, expiresAt]);
		assert.deepStrictEqual(
			[...index.getRange({ start: true, values: false, end: expiresAt + 2, limit: 1, snapshot: false })],
			[expiresAt - 1]
		);
		assert.deepStrictEqual(
			[...index.getRange({ start: true, values: false, end: expiresAt + 2, offset: 1, limit: 2, snapshot: false })],
			[expiresAt, expiresAt + 1]
		);
		const sweepEntries = [];
		for (const key of expirationKeys) {
			for (const id of index.getValues(key)) sweepEntries.push([key, id]);
		}
		assert.deepStrictEqual(sweepEntries, [
			[expiresAt - 1, 0],
			[expiresAt - 1, 5],
			[expiresAt, 1],
			[expiresAt, 2],
		]);
		assert.deepStrictEqual(
			[...index.getValues(expiresAt)].sort((left, right) => left - right),
			[1, 2]
		);
		assert.deepStrictEqual([...index.getValues(expiresAt + 2)], [[4, 'part']]);

		const firstChunk = [...index.getCompositeRange({ end: expiresAt + 2, limit: 2 })];
		const cursor = firstChunk.at(-1).cursor;
		const savedCursor = structuredClone(cursor);
		assert.deepStrictEqual(
			[...index.getCompositeRange({ end: expiresAt + 2, limit: 20 })].map((entry) => entry.value),
			[0, 5, 1, 2, 3, [4, 'part']]
		);
		assert.deepStrictEqual(cursor, savedCursor);
		assert.deepStrictEqual(
			[...index.getCompositeRange({ after: cursor, end: expiresAt + 2, limit: 20 })].map((entry) => entry.value),
			[1, 2, 3, [4, 'part']]
		);
	});

	it('keeps exact Rocks index matching distinct for similar values', async function () {
		const Table = table({
			table: 'SimilarIndexValues',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
			],
		});
		await Table.put(1, { id: 1, label: 'hello' });
		await Table.put(4, { id: 4, label: 'hello' });
		await Table.put(2, { id: 2, label: 'hello world' });
		await Table.put(3, { id: 3, label: 'hell' });
		await Table.put([5, 'part'], { id: [5, 'part'], label: 'hello' });
		await Table.primaryStore.committed;

		const index = Table.indices.label;
		assert.deepStrictEqual([...index.getValues('hello')], [1, 4, [5, 'part']]);
		assert.deepStrictEqual([...index.getValues('hello', { offset: 1, limit: 1 })], [4]);
		assert.deepStrictEqual([...index.getValues('hello', { reverse: true })], [[5, 'part'], 4, 1]);
		assert.deepStrictEqual([...index.getValues('hello', { reverse: true, offset: 1, limit: 1 })], [4]);
		assert.deepStrictEqual([...index.getValues('hello world')], [2]);
		assert.deepStrictEqual([...index.getValues('hell')], [3]);
		assert.strictEqual(index.getValuesCount('hello'), 3);
		assert.strictEqual(index.getValuesCount('hello world'), 1);
		assert.strictEqual(index.getValuesCount('hell'), 1);

		const searchResults = [];
		for await (const record of Table.search({
			allowFullScan: false,
			conditions: [{ attribute: 'label', value: 'hello' }],
		})) {
			searchResults.push(record.id);
		}
		assert.deepStrictEqual(searchResults, [1, 4, [5, 'part']]);
	});

	it('physically evicts expired records and transactionally cleans dangling index entries', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtSweep'));

		const expiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt });
		await Table.put(2, { id: 2, expiresAt });
		await Table.put([3, 'part'], { id: [3, 'part'], expiresAt });
		await Table.primaryStore.committed;
		Table.primaryStore.removeSync(2);
		Table.primaryStore.removeSync([3, 'part']);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [1, 2, [3, 'part']]);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], []);
		Table.cleanup();
	});

	it('continues an expiration sweep beyond one RocksDB chunk', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtSweepContinuation'));
		const expiresAt = Date.now() - 1_000;
		await Promise.all(Array.from({ length: 505 }, (_, id) => Table.put(id, { id, expiresAt })));
		await Table.primaryStore.committed;

		await runSweep();
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], []);
		for (let id = 0; id < 505; id++) assert.strictEqual(Table.primaryStore.getEntry(id)?.value, undefined);
		Table.cleanup();
	});

	it('physically evicts an expired ISO-string value', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtIsoSweep'));
		const expiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt: new Date(expiresAt).toISOString() });
		await Table.primaryStore.committed;
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [1]);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], []);
		Table.cleanup();
	});

	it('removes a stale expired key while preserving a refreshed record and its current key', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtStaleKey'));
		const expired = Date.now() - 1_000;
		const current = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt: current });
		await Table.primaryStore.committed;
		Table.indices.expiresAt.put(expired, 1);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.expiresAt, current);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expired)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(current)], [1]);
		Table.cleanup();
	});

	it('keeps a blob file when an expired-record eviction conflicts', async function () {
		const { Table, runSweep } = captureExpirationSweep(() =>
			table({
				table: 'ExpiresAtBlobConflict',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
					{ name: 'payload', type: 'Blob' },
				],
			})
		);
		const blob = createBlob(Buffer.alloc(20_000, 7));
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: blob });
		await Table.primaryStore.committed;
		const filePath = getFilePathForBlob(blob);
		assert(filePath);
		assert(existsSync(filePath));
		const blobEntry = Table.primaryStore.getEntry(1);
		await Table.evict(1, undefined, blobEntry.version);
		assert(Table.primaryStore.getEntry(1)?.value, 'an eviction without the record value must fail safe');
		assert(existsSync(filePath));

		setDeletionDelay(0);
		const commitStub = sinon
			.stub(RocksTransaction.prototype, 'commit')
			.rejects(Object.assign(new Error('injected optimistic conflict'), { code: 'ERR_BUSY' }));
		let commitRestored = false;
		try {
			await runSweep();
			await delay(25);
			assert(Table.primaryStore.getEntry(1)?.value, 'the failed eviction must leave the record intact');
			assert(existsSync(filePath), 'a failed eviction must leave the referenced blob file intact');
			commitStub.restore();
			commitRestored = true;

			await runSweep();
			assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
			await waitFor(() => !existsSync(filePath), {
				message: 'a committed eviction must remove its blob file',
			});
		} finally {
			if (!commitRestored) commitStub.restore();
			setDeletionDelay(500);
			Table.cleanup();
		}
	});

	it('preserves a blob record refreshed before its eviction transaction starts', async function () {
		const Table = table({
			table: 'ExpiresAtBlobRefreshRace',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		const oldBlob = createBlob(Buffer.alloc(20_000, 5));
		const freshBlob = createBlob(Buffer.alloc(20_000, 6));
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: oldBlob });
		await Table.primaryStore.committed;
		const expiredEntry = Table.primaryStore.getEntry(1);

		const freshExpiresAt = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt: freshExpiresAt, payload: freshBlob });
		await Table.primaryStore.committed;
		assert.notStrictEqual(Table.primaryStore.getEntry(1).version, expiredEntry.version);
		await Table.evict(1, expiredEntry.value, expiredEntry.version);

		const refreshed = Table.primaryStore.getEntry(1)?.value;
		assert.strictEqual(refreshed.expiresAt, freshExpiresAt);
		assert.strictEqual(refreshed.payload.id, freshBlob.id);
		assert(existsSync(getFilePathForBlob(freshBlob)), 'the refreshed record must retain its blob file');
		Table.cleanup();
	});

	it('stops a running expiration sweep when the table is cleaned up', async function () {
		const { Table, runSweep } = captureExpirationSweep(() =>
			table({
				table: 'ExpiresAtSweepCancellation',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
					{ name: 'payload', type: 'Blob' },
				],
			})
		);
		const expiresAt = Date.now() - 1_000;
		await Table.put('a', { id: 'a', expiresAt, payload: createBlob(Buffer.alloc(20_000, 3)) });
		await Table.put('b', { id: 'b', expiresAt, payload: createBlob(Buffer.alloc(20_000, 4)) });
		await Table.primaryStore.committed;
		const [, secondEntry] = [...Table.indices.expiresAt.getCompositeRange({ end: Date.now(), limit: 2 })];
		assert(secondEntry, 'the sweep should have a second entry to skip');

		const originalEvict = Table.evict;
		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		const evictStub = sinon.stub(Table, 'evict').callsFake(async function (...args) {
			evictionStarted = true;
			await blockedEviction;
			return originalEvict.apply(this, args);
		});
		try {
			const sweep = runSweep();
			await waitFor(() => evictionStarted, { message: 'the first eviction should start' });
			Table.cleanup();
			releaseEviction();
			await sweep;
		} finally {
			releaseEviction();
			evictStub.restore();
		}

		assert(Table.primaryStore.getEntry(secondEntry.value)?.value, 'cleanup must stop the sweep before its next entry');
	});

	it('waits for an active expiration sweep before dropping a table', async function () {
		const { Table, runSweep } = captureExpirationSweep(() =>
			table({
				table: 'ExpiresAtTableDrop',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
					{ name: 'payload', type: 'Blob' },
				],
			})
		);
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: createBlob(Buffer.alloc(20_000, 8)) });
		await Table.primaryStore.committed;

		const originalEvict = Table.evict;
		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		const evictStub = sinon.stub(Table, 'evict').callsFake(async function (...args) {
			evictionStarted = true;
			await blockedEviction;
			return originalEvict.apply(this, args);
		});
		try {
			const sweep = runSweep();
			await waitFor(() => evictionStarted, { message: 'the eviction should start' });
			let dropResolved = false;
			const drop = Table.dropTable().then(() => (dropResolved = true));
			await delay(10);
			assert.strictEqual(dropResolved, false, 'drop must wait for the active sweep');
			releaseEviction();
			await Promise.all([sweep, drop]);
		} finally {
			releaseEviction();
			evictStub.restore();
		}
	});

	it('waits for an active expiration sweep before closing a database', async function () {
		const database = 'ExpiresAtDatabaseClose';
		const { Table, runSweep } = captureExpirationSweep(() =>
			table({
				table: 'expiring',
				database,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
					{ name: 'payload', type: 'Blob' },
				],
			})
		);
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: createBlob(Buffer.alloc(20_000, 9)) });
		await Table.primaryStore.committed;

		const originalEvict = Table.evict;
		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		const evictStub = sinon.stub(Table, 'evict').callsFake(async function (...args) {
			evictionStarted = true;
			await blockedEviction;
			return originalEvict.apply(this, args);
		});
		try {
			const sweep = runSweep();
			await waitFor(() => evictionStarted, { message: 'the eviction should start' });
			let closeResolved = false;
			const close = closeDatabase(database).then(() => (closeResolved = true));
			await delay(10);
			assert.strictEqual(closeResolved, false, 'close must wait for the active sweep');
			releaseEviction();
			await Promise.all([sweep, close]);
		} finally {
			releaseEviction();
			evictStub.restore();
		}
	});

	it('cleanup drains the primary cleanup scan and prevents writes from rearming it', async function () {
		const Table = table({
			table: 'PrimaryCleanupDrain',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		let runCleanup;
		const realSetTimeout = global.setTimeout;
		const timeoutStub = sinon.stub(global, 'setTimeout').callsFake((callback, timeout, ...args) => {
			if (!runCleanup) {
				runCleanup = callback;
				return { unref() {} };
			}
			return realSetTimeout(callback, timeout, ...args);
		});
		Table.setTTLExpiration({ scanInterval: 100 });
		assert(runCleanup);
		await Table.put(1, { id: 1, payload: createBlob(Buffer.alloc(20_000, 11)) }, { expiresAt: Date.now() - 1_000 });
		await Table.primaryStore.committed;

		const originalEvict = Table.evict;
		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		const evictStub = sinon.stub(Table, 'evict').callsFake(async function (...args) {
			evictionStarted = true;
			await blockedEviction;
			return originalEvict.apply(this, args);
		});
		try {
			const scan = runCleanup();
			await waitFor(() => evictionStarted, { message: 'the primary cleanup scan should start eviction' });
			let cleanupResolved = false;
			const cleanup = Table.cleanup().then(() => (cleanupResolved = true));
			await delay(10);
			assert.strictEqual(cleanupResolved, false);
			releaseEviction();
			await Promise.all([scan, cleanup]);
			const timerCount = timeoutStub.callCount;
			await Table.put(2, { id: 2 }, { expiresAt: Date.now() + 60_000 });
			assert.strictEqual(timeoutStub.callCount, timerCount, 'cleanup must prevent a write from rearming the scan');
		} finally {
			releaseEviction();
			evictStub.restore();
			timeoutStub.restore();
		}
	});

	it('waits for an active expiration sweep before destroying a database', async function () {
		const database = 'ExpiresAtDatabaseDrop';
		const { Table, runSweep } = captureExpirationSweep(() =>
			table({
				table: 'expiring',
				database,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
					{ name: 'payload', type: 'Blob' },
				],
			})
		);
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: createBlob(Buffer.alloc(20_000, 10)) });
		await Table.primaryStore.committed;

		const originalEvict = Table.evict;
		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		const evictStub = sinon.stub(Table, 'evict').callsFake(async function (...args) {
			evictionStarted = true;
			await blockedEviction;
			return originalEvict.apply(this, args);
		});
		try {
			const sweep = runSweep();
			await waitFor(() => evictionStarted, { message: 'the eviction should start' });
			let dropResolved = false;
			const drop = dropDatabase(database).then(() => (dropResolved = true));
			await delay(10);
			assert.strictEqual(dropResolved, false, 'drop must wait for the active sweep');
			releaseEviction();
			await Promise.all([sweep, drop]);
		} finally {
			releaseEviction();
			evictStub.restore();
		}
	});

	it('preserves retained tombstones while removing their dangling expiration index entries', async function () {
		const { Table, runSweep } = captureExpirationSweep(() =>
			makeTable('ExpiresAtTombstoneSweep', undefined, { audit: true })
		);

		const expiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt });
		await Table.delete(1);
		await Table.primaryStore.committed;
		const tombstone = Table.primaryStore.getEntry(1);
		assert(tombstone);
		assert.strictEqual(tombstone.value, null);
		const tombstoneMetadata = {
			version: tombstone.version,
			expiresAt: tombstone.expiresAt,
			metadataFlags: tombstone.metadataFlags,
			residencyId: tombstone.residencyId,
		};
		Table.indices.expiresAt.put(expiresAt, 1);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [1]);

		await runSweep();
		const retained = Table.primaryStore.getEntry(1);
		assert(retained);
		assert.strictEqual(retained.value, null);
		assert.deepStrictEqual(
			{
				version: retained.version,
				expiresAt: retained.expiresAt,
				metadataFlags: retained.metadataFlags,
				residencyId: retained.residencyId,
			},
			tombstoneMetadata
		);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], []);
		Table.cleanup();
	});

	it('conflicts dangling cleanup with a concurrent primary resurrection', async function () {
		const Table = makeTable('ExpiresAtDanglingConflict');
		const expiresAt = Date.now() + 60_000;
		Table.indices.expiresAt.put(expiresAt, 1);

		const transaction = new RocksTransaction(Table.primaryStore.store);
		const options = { transaction };
		assert.strictEqual(Table.primaryStore.getEntry(1, options), undefined);
		Table.primaryStore.removeSync(1, options);
		Table.indices.expiresAt.remove(expiresAt, 1, options);
		await Table.put(1, { id: 1, expiresAt });
		await assert.rejects(transaction.commit(), (error) => error?.code === 'ERR_BUSY');

		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.id, 1);
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.expiresAt, expiresAt);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [1]);
		Table.cleanup();
	});

	it('keeps a resurrection and its index when the real sweep cleanup conflicts', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtSweepConflict'));
		const expiresAt = Date.now() - 1_000;
		Table.indices.expiresAt.put(expiresAt, 1);

		const originalCommit = RocksTransaction.prototype.commit;
		let injected = false;
		const commitStub = sinon.stub(RocksTransaction.prototype, 'commit').callsFake(async function (...args) {
			if (!injected) {
				injected = true;
				await Table.put(1, { id: 1, expiresAt, name: 'resurrected' });
			}
			return originalCommit.apply(this, args);
		});
		try {
			await runSweep();
		} finally {
			commitStub.restore();
		}

		assert(injected);
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.name, 'resurrected');
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [1]);
		Table.cleanup();
	});

	it('does not remove a refreshed expiration key when stale-key cleanup conflicts', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtStaleConflict'));
		const expired = Date.now() - 1_000;
		const current = Date.now() + 60_000;
		const refreshed = current + 60_000;
		await Table.put(1, { id: 1, expiresAt: current });
		await Table.primaryStore.committed;
		Table.indices.expiresAt.put(expired, 1);

		const originalCommit = RocksTransaction.prototype.commit;
		let injected = false;
		const commitStub = sinon.stub(RocksTransaction.prototype, 'commit').callsFake(async function (...args) {
			if (!injected) {
				injected = true;
				await Table.put(1, { id: 1, expiresAt: refreshed });
			}
			return originalCommit.apply(this, args);
		});
		try {
			await runSweep();
		} finally {
			commitStub.restore();
		}

		assert(injected);
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.expiresAt, refreshed);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(refreshed)], [1]);
		await runSweep();
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expired)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(refreshed)], [1]);
		Table.cleanup();
	});

	it('conflicts retained-tombstone cleanup with a concurrent primary resurrection', async function () {
		const Table = makeTable('ExpiresAtTombstoneConflict', undefined, { audit: true });
		const expiresAt = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt });
		await Table.delete(1);
		await Table.primaryStore.committed;
		Table.indices.expiresAt.put(expiresAt, 1);

		const transaction = new RocksTransaction(Table.primaryStore.store);
		const options = { transaction };
		const tombstone = Table.primaryStore.getEntry(1, options);
		assert.strictEqual(tombstone.value, null);
		const encodedTombstone = Table.primaryStore.getBinarySync(1, options);
		Table.primaryStore.putSync(1, asBinary(encodedTombstone), options);
		Table.indices.expiresAt.remove(expiresAt, 1, options);
		await Table.put(1, { id: 1, expiresAt, name: 'resurrected' });
		await assert.rejects(transaction.commit(), (error) => error?.code === 'ERR_BUSY');

		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.name, 'resurrected');
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], [1]);
		Table.cleanup();
	});
});

describe('LMDB @expiresAt cleanup draining', function () {
	if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('does not resolve cleanup while LMDB eviction writes are active', async function () {
		let runSweep;
		const realSetInterval = global.setInterval;
		const intervalStub = sinon.stub(global, 'setInterval').callsFake((callback, interval, ...args) => {
			if (interval === 60_000) {
				runSweep = callback;
				return { unref() {} };
			}
			return realSetInterval(callback, interval, ...args);
		});
		let Table;
		try {
			Table = table({
				table: 'LmdbExpirationDrain',
				database: 'lmdb-expiration-drain',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			});
		} finally {
			intervalStub.restore();
		}
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000 });
		await Table.primaryStore.committed;

		const originalEvict = Table.evict;
		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		const evictStub = sinon.stub(Table, 'evict').callsFake(async function (...args) {
			evictionStarted = true;
			await blockedEviction;
			return originalEvict.apply(this, args);
		});
		try {
			const sweep = runSweep();
			await waitFor(() => evictionStarted, { message: 'LMDB eviction should start' });
			let cleanupResolved = false;
			const cleanup = Table.cleanup().then(() => (cleanupResolved = true));
			await delay(10);
			assert.strictEqual(cleanupResolved, false);
			releaseEviction();
			await Promise.all([sweep, cleanup]);
		} finally {
			releaseEviction();
			evictStub.restore();
		}
	});
});
