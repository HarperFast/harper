require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table: createTable, closeDatabase, dropDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { Transaction: RocksTransaction } = require('@harperfast/rocksdb-js');
const { asBinary } = require('lmdb');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { existsSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');
const { HAS_EXPIRATION_DECISION } = require('#src/resources/auditStore');
const {
	TABLE_COMMIT_ADMISSION,
	TABLE_COMMIT_RELEASE,
	trackedTransactionCountForTests,
} = require('#src/resources/DatabaseTransaction');
const { LMDBTransaction } = require('#src/resources/LMDBTransaction');
const { transaction } = require('#src/resources/transaction');
const harperLogger = require('#src/utility/logging/harper_logger');

const activeTables = new Set();
const table = (options) => {
	const Table = createTable(options);
	activeTables.add(Table);
	return Table;
};

afterEach(async function () {
	const tables = [...activeTables];
	activeTables.clear();
	await Promise.all(tables.map((Table) => Table.cleanup()));
});

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
		const Table = createTable();
		return {
			Table,
			runSweep: (testHooks) => Table.runRecordExpirationSweepForTests(testHooks),
		};
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
		const fieldExpiresAt = optionExpiresAt + 3_600_000;
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt }, { expiresAt: optionExpiresAt });
		assert.strictEqual(await storedExpiresAt(Table, 1), optionExpiresAt);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(optionExpiresAt)], [1]);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], []);
		const matchingOverride = [];
		for await (const record of Table.search({
			allowFullScan: false,
			conditions: [{ attribute: 'expiresAt', value: optionExpiresAt }],
		})) {
			matchingOverride.push(record);
		}
		assert.strictEqual(matchingOverride.length, 1);
		assert.strictEqual(matchingOverride[0].expiresAt, fieldExpiresAt);
		const fullScanMismatch = [];
		for await (const record of Table.search({
			allowFullScan: true,
			conditions: [{ attribute: 'expiresAt', comparator: 'ne', value: optionExpiresAt }],
		})) {
			fullScanMismatch.push(record);
		}
		assert.deepStrictEqual(fullScanMismatch, []);
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
		const noExpiryField = expiresAt + 60_000;
		const isoExpiresAt = new Date(expiresAt).toISOString();
		await Table.put(1, { id: 1, expiresAt: isoExpiresAt });
		await Table.put(2, { id: 2, expiresAt: noExpiryField }, { expiresAt: -1 });
		await Table.primaryStore.committed;

		const attribute = Table.attributes.find((candidate) => candidate.name === 'expiresAt');
		const descriptor = Table.dbisDB.getSync(attribute.key);
		delete descriptor.expirationIndexVersion;
		await Table.dbisDB.put(attribute.key, descriptor);
		await Table.indices.expiresAt.clear();
		await Table.indices.expiresAt.put(isoExpiresAt, 1);
		await Table.indices.expiresAt.put(noExpiryField, 2);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(isoExpiresAt)], [1]);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(noExpiryField)], [2]);

		const Reloaded = makeTable(tableName);
		await Reloaded.indexingOperation;
		assert.deepStrictEqual([...Reloaded.indices.expiresAt.getValues(isoExpiresAt)], []);
		assert.deepStrictEqual([...Reloaded.indices.expiresAt.getValues(expiresAt)], [1]);
		assert.deepStrictEqual([...Reloaded.indices.expiresAt.getValues(noExpiryField)], []);
		Table.cleanup();
	});

	it('preserves expiration for legacy rows that have a field but no stored metadata', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtLegacyMetadata'));
		const expiresAt = Date.now() - 1_000;
		const record = { id: 1, expiresAt: new Date(expiresAt).toISOString() };
		Table.primaryStore.putSync(1, record);
		Table.indices.expiresAt.put(expiresAt, 1);
		assert.strictEqual(Table.primaryStore.getEntry(1).expiresAt, undefined);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], []);
		Table.cleanup();
	});

	it('removes a legacy field-derived index entry when the row is updated', async function () {
		const Table = makeTable('ExpiresAtLegacyUpdate');
		const oldExpiresAt = Date.now() + 3_600_000;
		const newExpiresAt = oldExpiresAt + 3_600_000;
		Table.primaryStore.putSync(1, { id: 1, expiresAt: new Date(oldExpiresAt).toISOString() });
		Table.indices.expiresAt.put(oldExpiresAt, 1);

		await Table.put(1, { id: 1, expiresAt: newExpiresAt });
		await Table.primaryStore.committed;
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(oldExpiresAt)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(newExpiresAt)], [1]);
		Table.cleanup();
	});

	it('uses source context rather than the returned field for cache expiration', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtSourceFill', 3_600));
		const contextExpiresAt = Date.now() - 1_000;
		const fieldExpiresAt = contextExpiresAt + 3_600_000;
		Table.sourcedFrom({
			get(id, context) {
				context.expiresAt = new Date(contextExpiresAt).toISOString();
				return { id, expiresAt: new Date(fieldExpiresAt).toISOString() };
			},
		});

		await Table.get(1);
		await waitFor(() => Table.primaryStore.getEntry(1)?.value, { message: 'source fill should be stored' });
		await Table.primaryStore.committed;
		assert.strictEqual(Table.primaryStore.getEntry(1).expiresAt, contextExpiresAt);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(contextExpiresAt)], [1]);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], []);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
	});

	it('does not reinterpret a source no-expiration decision as a legacy field expiration', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtSourceNoExpiration'));
		const fieldExpiresAt = Date.now() - 1_000;
		Table.sourcedFrom({
			get(id) {
				return { id, expiresAt: fieldExpiresAt, name: 'source' };
			},
		});

		await Table.get(1);
		await waitFor(() => Table.primaryStore.getEntry(1)?.value, { message: 'source fill should be stored' });
		await Table.primaryStore.committed;
		const sourceEntry = Table.primaryStore.getEntry(1);
		assert.strictEqual(sourceEntry.expiresAt, undefined);
		assert.ok(sourceEntry.metadataFlags & HAS_EXPIRATION_DECISION);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], []);
		const fullScanResults = [];
		for await (const record of Table.search({
			allowFullScan: true,
			conditions: [
				{ attribute: 'id', value: 1 },
				{ attribute: 'expiresAt', value: fieldExpiresAt },
			],
		})) {
			fullScanResults.push(record.id);
		}
		assert.deepStrictEqual(fullScanResults, []);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value.name, 'source');

		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt, name: 'local' });
		await Table.primaryStore.committed;
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], [1]);
		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
	});

	it('propagates an explicit no-expiration decision through current and live subscriptions', async function () {
		const Source = makeTable('ExpiresAtDecisionSource', undefined, { audit: true });
		const fieldExpiresAt = Date.now() - 1_000;
		await Source.put(1, { id: 1, expiresAt: fieldExpiresAt }, { expiresAt: -1 });
		await Source.primaryStore.committed;

		const currentSubscription = await Source.subscribe({ isCollection: true });
		const currentEvents = [];
		currentSubscription.on('data', (event) => currentEvents.push(event));
		await waitFor(() => currentEvents.some((event) => event.id === 1), { message: 'current event should arrive' });
		const currentEvent = currentEvents.find((event) => event.id === 1);
		assert.strictEqual(currentEvent.expirationDecisionPresent, true);
		assert.strictEqual(currentEvent.expiresAt, undefined);
		await currentSubscription.return?.();

		const Target = makeTable('ExpiresAtDecisionTarget');
		Target.sourcedFrom(Source, { intermediateSource: true });
		await Source.put(2, { id: 2, expiresAt: fieldExpiresAt }, { expiresAt: -1 });
		await waitFor(() => Target.primaryStore.getEntry(2)?.value, { message: 'live event should be applied' });
		await Target.primaryStore.committed;
		const targetEntry = Target.primaryStore.getEntry(2);
		assert.strictEqual(targetEntry.expiresAt, undefined);
		assert.ok(targetEntry.metadataFlags & HAS_EXPIRATION_DECISION);
		assert.deepStrictEqual([...Target.indices.expiresAt.getValues(fieldExpiresAt)], []);
	});

	it('preserves an explicit no-expiration decision across publish and invalidate', async function () {
		const Table = makeTable('ExpiresAtDecisionLifecycle', undefined, { audit: true });
		const fieldExpiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt }, { expiresAt: -1 });
		await Table.publish(1, { message: 'refresh' });
		await Table.primaryStore.committed;

		let entry = Table.primaryStore.getEntry(1);
		assert.strictEqual(entry.expiresAt, undefined);
		assert.ok(entry.metadataFlags & HAS_EXPIRATION_DECISION);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], []);

		await Table.invalidate(1);
		await Table.primaryStore.committed;
		entry = Table.primaryStore.getEntry(1);
		assert.strictEqual(entry.expiresAt, undefined);
		assert.ok(entry.metadataFlags & HAS_EXPIRATION_DECISION);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], []);
	});

	it('normalizes publish expiration overrides and updates the expiration index', async function () {
		const Table = makeTable('ExpiresAtPublishOverride', undefined, { audit: true });
		const originalExpiresAt = Date.now() + 60_000;
		const optionExpiresAt = originalExpiresAt + 60_000;
		const contextExpiresAt = optionExpiresAt + 60_000;
		await Table.put(1, { id: 1, expiresAt: originalExpiresAt });
		await Table.publish(1, { message: 'option' }, { expiresAt: new Date(optionExpiresAt).toISOString() });
		await Table.primaryStore.committed;
		assert.strictEqual(Table.primaryStore.getEntry(1).expiresAt, optionExpiresAt);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(originalExpiresAt)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(optionExpiresAt)], [1]);

		const context = { expiresAt: new Date(contextExpiresAt) };
		const resource = new Table(1, context);
		await transaction(context, () => resource._writePublish(1, { message: 'context' }));
		await Table.primaryStore.committed;
		assert.strictEqual(Table.primaryStore.getEntry(1).expiresAt, contextExpiresAt);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(optionExpiresAt)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(contextExpiresAt)], [1]);
	});

	it('invalidates a frozen replay record without mutating it', async function () {
		const Table = makeTable('ExpiresAtFrozenInvalidate', undefined, { audit: true });
		const fieldExpiresAt = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt });
		const context = {};
		const resource = await Table.getResource(1, context, { ensureLoaded: true });
		const replayRecord = Object.freeze({ id: 1, expiresAt: fieldExpiresAt });
		await transaction(context, () => resource._writeInvalidate(1, replayRecord));
		assert.strictEqual(Object.isFrozen(replayRecord), true);
		assert.ok(Table.primaryStore.getEntry(1).metadataFlags);
	});

	it('re-arms both expiration sweeps after cleanup is resumed', async function () {
		const Table = makeTable('ExpiresAtResumeCleanup', undefined, { scanInterval: 100 });
		assert.deepStrictEqual(Table.cleanupStateForTests(), {
			closed: false,
			cleanupScheduled: true,
			nextCleanupScheduled: Table.cleanupStateForTests().nextCleanupScheduled,
			expirationScheduled: true,
		});
		await Table.cleanup();
		assert.deepStrictEqual(Table.cleanupStateForTests(), {
			closed: true,
			cleanupScheduled: false,
			nextCleanupScheduled: undefined,
			expirationScheduled: false,
		});
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000 });
		assert.deepStrictEqual(Table.cleanupStateForTests(), {
			closed: true,
			cleanupScheduled: false,
			nextCleanupScheduled: undefined,
			expirationScheduled: false,
		});
		Table.resumeCleanup();
		assert.deepStrictEqual(Table.cleanupStateForTests(), {
			closed: false,
			cleanupScheduled: true,
			nextCleanupScheduled: Table.cleanupStateForTests().nextCleanupScheduled,
			expirationScheduled: true,
		});
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
		const trackedBeforeRead = trackedTransactionCountForTests();
		assert.strictEqual(await Table.get(1), null);
		await waitFor(() => trackedTransactionCountForTests() === trackedBeforeRead, {
			message: 'read-path eviction should release its internal Rocks transaction',
		});

		await Table.put(2, { id: 2, expiresAt: Date.now() + 60_000 });
		await Table.primaryStore.committed;
		const staleEntry = Table.primaryStore.getEntry(2);
		await Table.patch(2, { refreshed: true });
		assert.strictEqual(Table.primaryStore.ifVersion, undefined, 'premise: this regression must exercise RocksDB');
		await Table.evict(2, staleEntry.value, staleEntry.version);
		assert.strictEqual(
			trackedTransactionCountForTests(),
			trackedBeforeRead,
			'a version-mismatched eviction should release its internal Rocks transaction'
		);
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

	it('retries a conflicting Rocks eviction batch', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtBatchConflict'));
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000 });
		await Table.primaryStore.committed;
		let commitAttempts = 0;

		await runSweep({
			beforeBatchCommit() {
				commitAttempts++;
				if (commitAttempts === 1) throw Object.assign(new Error('injected optimistic conflict'), { code: 'ERR_BUSY' });
			},
		});

		assert.strictEqual(commitAttempts, 2, 'the conflicting batch should be re-staged and committed once');
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
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

	it('removes both the encountered and canonical expiration keys when evicting a record', async function () {
		const { Table, runSweep } = captureExpirationSweep(() => makeTable('ExpiresAtExactKeyEviction'));
		const canonical = Date.now() - 1_000;
		const encountered = canonical - 1_000;
		await Table.put(1, { id: 1, expiresAt: canonical });
		await Table.primaryStore.committed;
		Table.indices.expiresAt.put(encountered, 1);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(encountered)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(canonical)], []);
	});

	it('removes both expiration keys when physically evicting a blob record', async function () {
		const { Table, runSweep } = captureExpirationSweep(() =>
			table({
				table: 'ExpiresAtExactBlobKeyEviction',
				database: 'expires-at-exact-blob-key-eviction',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
					{ name: 'payload', type: 'Blob' },
				],
			})
		);
		const canonical = Date.now() - 1_000;
		const encountered = canonical - 1_000;
		const blob = createBlob(Buffer.alloc(20_000, 12));
		await Table.put(1, { id: 1, expiresAt: canonical, payload: blob });
		await Table.primaryStore.committed;
		Table.indices.expiresAt.put(encountered, 1);

		setDeletionDelay(0);
		try {
			await runSweep();
			assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
			assert.deepStrictEqual([...Table.indices.expiresAt.getValues(encountered)], []);
			assert.deepStrictEqual([...Table.indices.expiresAt.getValues(canonical)], []);
			await waitFor(() => !existsSync(getFilePathForBlob(blob)), {
				timeout: 5_000,
				message: 'physical eviction should unlink the blob',
			});
		} finally {
			setDeletionDelay(500);
		}
	});

	it('snapshots lazy Rocks metadata before eviction updates recycle the decode buffer', async function () {
		const Table = table({
			table: 'ExpiresAtLazyBlobEviction',
			database: 'expires-at-lazy-blob-eviction',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		const blob = createBlob(Buffer.alloc(20_000, 13));
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: blob });
		await Table.primaryStore.committed;
		const storedEntry = Table.primaryStore.getEntry(1);
		const filePath = getFilePathForBlob(blob);
		const lazyState = {
			version: storedEntry.version,
			expiresAt: storedEntry.expiresAt,
			metadataFlags: storedEntry.metadataFlags,
		};
		let lazyMetadataReads = 0;
		const originalGetEntry = Table.primaryStore.getEntry.bind(Table.primaryStore);
		const originalIndexRemove = Table.indices.expiresAt.remove.bind(Table.indices.expiresAt);
		Table.primaryStore.getEntry = (id, options) =>
			options?.lazy
				? {
						get version() {
							return lazyState.version;
						},
						get expiresAt() {
							return lazyState.expiresAt;
						},
						get metadataFlags() {
							lazyMetadataReads++;
							return lazyState.metadataFlags;
						},
						get key() {
							return id;
						},
					}
				: originalGetEntry(id, options);
		Table.indices.expiresAt.remove = (...args) => {
			lazyState.metadataFlags = 0;
			return originalIndexRemove(...args);
		};

		setDeletionDelay(0);
		try {
			assert.strictEqual(Table.primaryStore.ifVersion, undefined, 'premise: this must exercise RocksDB eviction');
			await Table.evict(1, storedEntry.value, storedEntry.version);
			assert.strictEqual(lazyMetadataReads, 1, 'eviction must consume lazy metadata only while creating the snapshot');
			await waitFor(() => !existsSync(filePath), {
				timeout: 5_000,
				message: 'eviction should use the snapshotted blob metadata after index writes',
			});
		} finally {
			Table.primaryStore.getEntry = originalGetEntry;
			Table.indices.expiresAt.remove = originalIndexRemove;
			setDeletionDelay(500);
		}
	});

	it('keeps a blob when eviction lacks the record and unlinks it after a committed eviction', async function () {
		const Table = table({
			table: 'ExpiresAtBlobFailSafe',
			database: 'expires-at-blob-fail-safe',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		const blob = createBlob(Buffer.alloc(20_000, 7));
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000, payload: blob });
		await Table.primaryStore.committed;
		const filePath = getFilePathForBlob(blob);
		const entry = Table.primaryStore.getEntry(1);

		await Table.evict(1, undefined, entry.version);
		assert(Table.primaryStore.getEntry(1)?.value, 'eviction without the record must fail safe');
		assert(existsSync(filePath), 'fail-safe eviction must keep the referenced blob');

		setDeletionDelay(0);
		try {
			await Table.evict(1, entry.value, entry.version);
			assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
			await waitFor(() => !existsSync(filePath), {
				timeout: 5_000,
				message: 'committed eviction should unlink the blob',
			});
		} finally {
			setDeletionDelay(500);
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

		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		try {
			const sweep = runSweep({
				beforeEvict: async () => {
					evictionStarted = true;
					await blockedEviction;
				},
			});
			await waitFor(() => evictionStarted, { message: 'the first eviction should start' });
			Table.cleanup();
			releaseEviction();
			await sweep;
		} finally {
			releaseEviction();
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

		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		try {
			const sweep = runSweep({
				beforeEvict: async () => {
					evictionStarted = true;
					await blockedEviction;
				},
			});
			await waitFor(() => evictionStarted, { message: 'the eviction should start' });
			let dropResolved = false;
			const drop = Table.dropTable().then(() => (dropResolved = true));
			await delay(10);
			assert.strictEqual(dropResolved, false, 'drop must wait for the active sweep');
			releaseEviction();
			await Promise.all([sweep, drop]);
		} finally {
			releaseEviction();
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

		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		try {
			const sweep = runSweep({
				beforeEvict: async () => {
					evictionStarted = true;
					await blockedEviction;
				},
			});
			await waitFor(() => evictionStarted, { message: 'the eviction should start' });
			let closeResolved = false;
			const close = closeDatabase(database).then(() => (closeResolved = true));
			await delay(10);
			assert.strictEqual(closeResolved, false, 'close must wait for the active sweep');
			releaseEviction();
			await Promise.all([sweep, close]);
		} finally {
			releaseEviction();
		}
	});

	it('cleanup drains the primary cleanup scan', async function () {
		const Table = table({
			table: 'PrimaryCleanupDrain',
			database: 'test',
			expiration: 1,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'payload', type: 'Blob' },
			],
		});
		await Table.put(1, { id: 1, payload: createBlob(Buffer.alloc(20_000, 11)) }, { expiresAt: Date.now() - 1_000 });
		await Table.primaryStore.committed;

		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		try {
			const scan = Table.runPrimaryCleanupScanForTests({
				beforeEvict: async () => {
					evictionStarted = true;
					await blockedEviction;
				},
			});
			await waitFor(() => evictionStarted, { message: 'the primary cleanup scan should start eviction' });
			let cleanupResolved = false;
			const cleanup = Table.cleanup().then(() => (cleanupResolved = true));
			await delay(10);
			assert.strictEqual(cleanupResolved, false);
			releaseEviction();
			await Promise.all([scan, cleanup]);
		} finally {
			releaseEviction();
		}
	});

	it('drains an in-flight batch when the primary scan exits with an error', async function () {
		const Table = table({
			table: 'PrimaryCleanupErrorDrain',
			database: 'test',
			expiration: 1,
			scanInterval: 3_600,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const expiresAt = Date.now() - 1_000;
		await Promise.all(Array.from({ length: 100 }, (_, id) => Table.put(id, { id }, { expiresAt })));
		await Table.primaryStore.committed;

		let releaseCommit;
		let commitStarted = false;
		const blockedCommit = new Promise((resolve) => (releaseCommit = resolve));
		let scanResolved = false;
		try {
			const scan = Table.runPrimaryCleanupScanForTests({
				beforeBatchCommit: async () => {
					commitStarted = true;
					await blockedCommit;
				},
				afterBatchQueued() {
					throw new Error('injected scan failure');
				},
			}).then(() => (scanResolved = true));
			await waitFor(() => commitStarted, { message: 'the eviction batch should start committing' });
			await delay(10);
			assert.strictEqual(scanResolved, false, 'the scan must drain its batch after the injected failure');
			releaseCommit();
			await scan;
		} finally {
			releaseCommit();
		}
	});

	it('settles an immediate cleanup request when cleanup cancels its timer', async function () {
		const Table = table({
			table: 'CleanupTimerSettlement',
			database: 'test',
			expiration: 60,
			scanInterval: 3_600,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const scheduled = Table.scheduleCleanupForTests(2);
		assert(scheduled, 'an explicit reclamation request should return its queued scan');
		const cleanup = Table.cleanup();
		const settled = await Promise.race([scheduled.then(() => true), delay(100).then(() => false)]);
		assert.strictEqual(settled, true, 'cleanup must not strand a promise owned by a cleared timer');
		await cleanup;
	});

	it('keeps the recurring timer finite for full-disk reclamation priority', async function () {
		const Table = table({
			table: 'FullDiskCleanupSchedule',
			database: 'test',
			expiration: 60,
			scanInterval: 3_600,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const scheduled = Table.scheduleCleanupForTests(Infinity);
		assert(scheduled, 'a full-disk reclamation request should queue an immediate scan');
		assert(
			Number.isFinite(Table.cleanupStateForTests().nextCleanupScheduled),
			'the recurring cleanup deadline must stay finite'
		);
		await scheduled;
	});

	it('waits for an admitted ordinary commit before closing a database', async function () {
		const database = 'OrdinaryCommitCloseDrain';
		const Table = table({
			table: 'records',
			database,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const originalAdmission = Table.primaryStore[TABLE_COMMIT_ADMISSION];
		const originalRelease = Table.primaryStore[TABLE_COMMIT_RELEASE];
		let admitted = false;
		let releaseCommit;
		const blockedRelease = new Promise((resolve) => (releaseCommit = resolve));
		Table.primaryStore[TABLE_COMMIT_ADMISSION] = () => {
			originalAdmission();
			admitted = true;
			return true;
		};
		Table.primaryStore[TABLE_COMMIT_RELEASE] = async () => {
			await blockedRelease;
			originalRelease();
		};
		try {
			const put = Table.put(1, { id: 1 });
			await waitFor(() => admitted, { message: 'the ordinary write should enter the table commit barrier' });
			let closeResolved = false;
			const close = closeDatabase(database).then(() => (closeResolved = true));
			await delay(10);
			assert.strictEqual(closeResolved, false, 'close must wait for the admitted ordinary commit');
			releaseCommit();
			await Promise.all([put, close]);
		} finally {
			releaseCommit();
			Table.primaryStore[TABLE_COMMIT_ADMISSION] = originalAdmission;
			Table.primaryStore[TABLE_COMMIT_RELEASE] = originalRelease;
		}
	});

	it('ignores an unmatched commit release without wedging later drop quiescence', async function () {
		const Table = makeTable('ExpiresAtCommitReleaseFloor');
		const admit = Table.primaryStore[TABLE_COMMIT_ADMISSION];
		const release = Table.primaryStore[TABLE_COMMIT_RELEASE];
		const originalError = harperLogger.error;
		const errors = [];
		harperLogger.error = (...args) => errors.push(args);
		try {
			release();
			assert.ok(errors.some(([message]) => /unmatched table commit release/.test(message)));
			assert.strictEqual(admit(), true);
			let quiesced = false;
			const quiesce = Table.quiesceForDrop().then(() => (quiesced = true));
			await delay(10);
			assert.strictEqual(quiesced, false, 'quiescence must still wait for the balanced admission');
			release();
			await quiesce;
		} finally {
			harperLogger.error = originalError;
			Table.abortDropQuiesce();
		}
	});

	it('joins read-path eviction to drop quiescence and skips eviction after quiescence starts', async function () {
		const Table = makeTable('ExpiresAtReadEvictionQuiesce');
		const expiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt });
		await Table.primaryStore.committed;
		const entry = Table.primaryStore.getEntry(1);
		const originalAdmission = Table.primaryStore[TABLE_COMMIT_ADMISSION];
		const originalRelease = Table.primaryStore[TABLE_COMMIT_RELEASE];
		let admitted = false;
		let releaseEviction;
		const blockedRelease = new Promise((resolve) => (releaseEviction = resolve));
		Table.primaryStore[TABLE_COMMIT_ADMISSION] = (...args) => {
			const result = originalAdmission(...args);
			if (result !== false) admitted = true;
			return result;
		};
		Table.primaryStore[TABLE_COMMIT_RELEASE] = async () => {
			await blockedRelease;
			originalRelease();
		};
		try {
			const eviction = Table.evict(1, entry.value, entry.version);
			await waitFor(() => admitted, { message: 'read-path eviction should enter the commit barrier' });
			let quiesced = false;
			const quiesce = Table.quiesceForDrop().then(() => (quiesced = true));
			await delay(10);
			assert.strictEqual(quiesced, false, 'drop quiescence must wait for an admitted eviction');
			releaseEviction();
			await Promise.all([eviction, quiesce]);

			await assert.doesNotReject(Table.evict(1, entry.value, entry.version));
		} finally {
			releaseEviction();
			Table.primaryStore[TABLE_COMMIT_ADMISSION] = originalAdmission;
			Table.primaryStore[TABLE_COMMIT_RELEASE] = originalRelease;
			Table.abortDropQuiesce();
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

		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		try {
			const sweep = runSweep({
				beforeEvict: async () => {
					evictionStarted = true;
					await blockedEviction;
				},
			});
			await waitFor(() => evictionStarted, { message: 'the eviction should start' });
			let dropResolved = false;
			const drop = dropDatabase(database).then(() => (dropResolved = true));
			await delay(10);
			assert.strictEqual(dropResolved, false, 'drop must wait for the active sweep');
			releaseEviction();
			await Promise.all([sweep, drop]);
		} finally {
			releaseEviction();
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

		let injected = false;
		await runSweep({
			beforeBatchCommit: async () => {
				if (injected) return;
				injected = true;
				await Table.put(1, { id: 1, expiresAt, name: 'resurrected' });
			},
		});

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

		let injected = false;
		await runSweep({
			beforeBatchCommit: async () => {
				if (injected) return;
				injected = true;
				await Table.put(1, { id: 1, expiresAt: refreshed });
			},
		});

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

	const captureExpirationSweep = (name) => {
		const Table = table({
			table: name,
			database: 'lmdb-expiration-drain',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
			],
		});
		return {
			Table,
			runSweep: (testHooks) => Table.runRecordExpirationSweepForTests(testHooks),
		};
	};

	it('persists an explicit no-expiration decision without indexing the public field', async function () {
		const { Table } = captureExpirationSweep('LmdbExpirationDecision');
		const fieldExpiresAt = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt: fieldExpiresAt }, { expiresAt: -1 });
		await Table.primaryStore.committed;
		const entry = Table.primaryStore.getEntry(1);
		assert.strictEqual(entry.expiresAt, undefined);
		assert.ok(entry.metadataFlags & HAS_EXPIRATION_DECISION);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(fieldExpiresAt)], []);
	});

	it('settles read-path eviction when admission throws', async function () {
		const { Table } = captureExpirationSweep('LmdbExpirationAdmissionFailure');
		const expiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt });
		await Table.primaryStore.committed;
		const entry = Table.primaryStore.getEntry(1);
		const originalAdmission = Table.primaryStore[TABLE_COMMIT_ADMISSION];
		Table.primaryStore[TABLE_COMMIT_ADMISSION] = () => {
			throw new Error('injected admission failure');
		};
		try {
			await assert.doesNotReject(Table.evict(1, entry.value, entry.version));
		} finally {
			Table.primaryStore[TABLE_COMMIT_ADMISSION] = originalAdmission;
		}
	});

	it('aborts and settles read-path eviction when LMDB commit throws synchronously', async function () {
		const { Table } = captureExpirationSweep('LmdbExpirationCommitFailure');
		const expiresAt = Date.now() - 1_000;
		await Table.put(1, { id: 1, expiresAt });
		await Table.primaryStore.committed;
		const entry = Table.primaryStore.getEntry(1);
		const originalCommit = LMDBTransaction.prototype.commit;
		const originalAbort = LMDBTransaction.prototype.abort;
		let aborted = false;
		LMDBTransaction.prototype.commit = () => {
			throw new Error('injected commit failure');
		};
		LMDBTransaction.prototype.abort = function () {
			aborted = true;
			return originalAbort.call(this);
		};
		try {
			await assert.doesNotReject(Table.evict(1, entry.value, entry.version));
			assert.strictEqual(aborted, true);
		} finally {
			LMDBTransaction.prototype.commit = originalCommit;
			LMDBTransaction.prototype.abort = originalAbort;
		}
	});

	it('evicts ISO expirations and repairs stale keys', async function () {
		const { Table, runSweep } = captureExpirationSweep('LmdbExpirationCorrectness');
		const expired = Date.now() - 1_000;
		const current = Date.now() + 60_000;
		await Table.put(1, { id: 1, expiresAt: new Date(expired).toISOString() });
		await Table.put(2, { id: 2, expiresAt: current });
		await Table.primaryStore.committed;
		const encountered = expired - 1_000;
		await Table.indices.expiresAt.put(expired, 2);
		await Table.indices.expiresAt.put(encountered, 1);

		await runSweep();
		assert.strictEqual(Table.primaryStore.getEntry(1)?.value, undefined);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expired)], []);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(encountered)], []);
		assert.strictEqual(Table.primaryStore.getEntry(2)?.value.expiresAt, current);
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(current)], [2]);
		Table.cleanup();
	});

	it('paginates duplicate expiration values across bounded chunks', async function () {
		const { Table, runSweep } = captureExpirationSweep('LmdbExpirationPagination');
		const expiresAt = Date.now() - 1_000;
		for (let id = 0; id < 205; id++) await Table.put(id, { id, expiresAt });
		await Table.primaryStore.committed;

		await runSweep();
		assert.deepStrictEqual([...Table.indices.expiresAt.getValues(expiresAt)], []);
		for (let id = 0; id < 205; id++) assert.strictEqual(Table.primaryStore.getEntry(id)?.value, undefined);
	});

	it('does not resolve cleanup while LMDB eviction writes are active', async function () {
		const { Table, runSweep } = captureExpirationSweep('LmdbExpirationDrain');
		await Table.put(1, { id: 1, expiresAt: Date.now() - 1_000 });
		await Table.primaryStore.committed;

		let releaseEviction;
		let evictionStarted = false;
		const blockedEviction = new Promise((resolve) => (releaseEviction = resolve));
		try {
			const sweep = runSweep({
				beforeEvict: async () => {
					evictionStarted = true;
					await blockedEviction;
				},
			});
			await waitFor(() => evictionStarted, { message: 'LMDB eviction should start' });
			let cleanupResolved = false;
			const cleanup = Table.cleanup().then(() => (cleanupResolved = true));
			await delay(10);
			assert.strictEqual(cleanupResolved, false);
			releaseEviction();
			await Promise.all([sweep, cleanup]);
		} finally {
			releaseEviction();
		}
	});
});
