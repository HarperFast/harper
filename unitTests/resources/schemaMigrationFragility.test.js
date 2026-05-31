/**
 * Probes for fragility in the schema-migration / reindexing code path in
 * resources/databases.ts. Each test targets a specific risk surface called out
 * during analysis of serent-canopy issue #135:
 *
 *  F2: per-record indexing errors inside `runIndexing` are caught and logged,
 *      but the loop CONTINUES to the next record, leaving silent gaps in the
 *      new index. A migration appears to "complete" successfully while queries
 *      miss records — exactly the user-observed fingerprint.
 *
 *  F3: a concurrent write that mutates a record AFTER `runIndexing` reads it
 *      but BEFORE `runIndexing` writes its index entry leaves the index with
 *      a stale (now-incorrect) composite key in addition to the correct one.
 *
 *  F1: the double-checked-locking in table() at databases.ts:1093-1133 reuses
 *      the `changed` variable computed before the exclusive lock, even after
 *      re-fetching the attribute descriptor inside the lock. A second thread
 *      can wastefully re-trigger a migration that the first thread already did.
 *      (Idempotent on disk, but spuriously bumps schemaVersion and re-runs the
 *      whole index scan.)
 *
 * These tests are designed to FAIL if the fragility manifests, so they
 * function as both diagnostics and regression guards.
 */
require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const fs = require('fs-extra');
const path = require('node:path');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { RocksDatabase } = require('@harperfast/rocksdb-js');

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

describe('schema-migration fragility: silent gaps when per-record indexing errors occur (F2)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const TABLE = 'F2SilentIndexGap';
	const DB = 'test';
	const N = 50;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		// Phase 1: write rows BEFORE the attribute is indexed.
		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) {
			last = Tbl.put({ id: 'k-' + i, tag: i % 2 === 0 ? 'even' : 'odd' });
		}
		await last;
	});

	it('completed indexing should reflect every existing row in the new index', async () => {
		resetDatabases();
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		const evens = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'even' }] }));
		const odds = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'odd' }] }));
		assert.equal(
			evens.length + odds.length,
			N,
			`expected ${N} rows total across the new index, got ${evens.length + odds.length}`
		);
	});

	it('reproduces a silent gap when a per-record index write rejects mid-flight', async () => {
		// Force a fresh migration cycle by recreating with a DIFFERENT attribute
		// name so a NEW index has to be backfilled.
		const TABLE2 = TABLE + 'WithThrowingIndex';
		resetDatabases();
		let Tbl = table({
			table: TABLE2,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		const VALUES = ['alpha', 'beta', 'gamma'];
		for (let i = 0; i < N; i++) {
			last = Tbl.put({ id: 't2-' + i, tag: VALUES[i % VALUES.length] });
		}
		await last;

		// Now add @indexed to tag. During runIndexing, intercept dbi.put calls
		// for some records to simulate transient errors (e.g. ERR_BUSY).
		resetDatabases();
		Tbl = table({
			table: TABLE2,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const tagIndex = Tbl.indices?.tag;
		if (tagIndex && typeof tagIndex.put === 'function') {
			const origPut = tagIndex.put.bind(tagIndex);
			let opCount = 0;
			tagIndex.put = function (indexedValue, primaryKey, options) {
				opCount++;
				// reject every 10th index put with a simulated transient error
				if (opCount % 10 === 0) {
					return Promise.reject(
						Object.assign(new Error('simulated transient index put failure'), { code: 'ERR_BUSY' })
					);
				}
				return origPut(indexedValue, primaryKey, options);
			};
		}
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		// With the fix, the index must NOT be silently complete when errors occurred.
		// The fix leaves isIndexing = true and sets indexingFailed = true so:
		//   (a) queries return 503 "not indexed yet" instead of a partial result set, and
		//   (b) the next restart (new PID) detects indexingFailed and re-triggers from checkpoint.
		//
		// Verify (a): search must throw, not silently return fewer rows.
		let caughtError;
		try {
			for (const v of VALUES) {
				await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: v }] }));
			}
		} catch (err) {
			caughtError = err;
		}
		assert.ok(
			caughtError,
			`Expected search to throw "not indexed yet" (503) after a partial migration with errors. ` +
				`Without the fix this returns a silent subset, making the bug invisible to callers.`
		);
		assert.ok(
			caughtError.message?.includes('not indexed yet') || caughtError.statusCode === 503,
			`Expected 503 "not indexed yet", got: ${caughtError.message}`
		);

		// Verify (b): indexingFailed is persisted so a restart-simulated re-call to table() retries.
		resetDatabases();
		// Re-open the same table — this time without any put mock, simulating a fresh process.
		// The indexingFailed flag on disk triggers a re-migration from the last checkpoint.
		const Tbl2 = table({
			table: TABLE2,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(
			Tbl2.indexingOperation,
			`After restart, table() should have detected indexingFailed and re-triggered runIndexing`
		);
		if (Tbl2.indexingOperation) await Tbl2.indexingOperation;

		// After the clean retry, all rows should be found.
		let viaIndex = 0;
		for (const v of VALUES) {
			const rows = await collect(Tbl2.search({ conditions: [{ attribute: 'tag', value: v }] }));
			viaIndex += rows.length;
		}
		assert.equal(viaIndex, N, `After restart-triggered retry, all ${N} rows should be indexed. Got ${viaIndex}.`);
	});
});

describe('schema-migration fragility: stale index entry from concurrent write during reindex (F3)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const TABLE = 'F3ConcurrentWriteRace';
	const DB = 'test';
	const N = 200;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) {
			last = Tbl.put({ id: 'c-' + i, tag: 'old' });
		}
		await last;
	});

	it('search by new value should not also return rows under the old value after concurrent updates during reindex', async () => {
		resetDatabases();
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});

		// While runIndexing is happening, update half the rows to a new value.
		// runIndexing started but yielded the event turn at setImmediate; we
		// kick concurrent updates immediately to overlap with the backfill scan.
		const updates = [];
		for (let i = 0; i < N; i += 2) {
			updates.push(Tbl.put({ id: 'c-' + i, tag: 'new' }));
		}
		await Promise.all(updates);
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		const oldRows = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'old' }] }));
		const newRows = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'new' }] }));

		// After the race: half should be 'new', half 'old'.
		assert.equal(newRows.length, N / 2, `expected ${N / 2} rows with tag=new, got ${newRows.length}`);
		assert.equal(oldRows.length, N / 2, `expected ${N / 2} rows with tag=old, got ${oldRows.length}`);

		// Cross-check: no row should appear under BOTH values in the index.
		const newIds = new Set(newRows.map((r) => r.id));
		const oldIds = new Set(oldRows.map((r) => r.id));
		const overlap = [...newIds].filter((id) => oldIds.has(id));
		assert.equal(
			overlap.length,
			0,
			`F3 fingerprint: ${overlap.length} rows appear under BOTH tag values in the index — a concurrent write left a stale composite key behind from runIndexing.`
		);
	});
});

describe('schema-migration fragility: outer catch does not persist indexingFailed when clear() throws (F4)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const TABLE = 'F4OuterCatchPersistFailed';
	const DB = 'test';
	const N = 5;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) {
			last = Tbl.put({ id: 'f4-' + i, tag: 'v-' + i });
		}
		await last;
	});

	it('outer catch should persist indexingFailed when clear() throws before the record scan', async () => {
		resetDatabases();
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});

		// Intercept clear() on the tag index dbi to simulate ERR_COLUMN_FAMILY_DROPPED.
		// This throws before the record scan begins, hitting the outer catch in runIndexing.
		const tagIndex = Tbl.indices?.tag;
		if (tagIndex && typeof tagIndex.clear === 'function') {
			tagIndex.clear = async function () {
				throw Object.assign(new Error('simulated clear failure: column family dropped'), {
					code: 'ERR_COLUMN_FAMILY_DROPPED',
				});
			};
		}

		// Wait for runIndexing to finish (the outer catch swallows the error).
		if (Tbl.indexingOperation) await Tbl.indexingOperation.catch(() => {});

		// Verify: simulate restart by resetting and re-opening.
		// The outer catch should have persisted indexingFailed=true in the attribute descriptor.
		// A clean re-open should detect this and re-trigger runIndexing.
		resetDatabases();
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(
			Tbl2.indexingOperation,
			'F4 fingerprint: outer catch did not persist indexingFailed — ' +
				'table() on "restart" did not re-trigger runIndexing, so isIndexing would be stuck forever.'
		);
		if (Tbl2.indexingOperation) await Tbl2.indexingOperation;

		// After a clean retry, all rows should be indexed.
		const rows = await collect(Tbl2.search({ conditions: [{ attribute: 'tag', value: 'v-0' }] }));
		assert.equal(rows.length, 1, `Expected 1 row indexed after clean re-run, got ${rows.length}`);
	});
});

describe('schema-migration fragility: stale `changed` reused after re-fetch under lock (F1)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const TABLE = 'F1StaleChangedFlag';
	const DB = 'test';

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < 5; i++) {
			last = Tbl.put({ id: 'f1-' + i, tag: 'val-' + i });
		}
		await last;
	});

	it('two back-to-back table() calls with the indexed attribute should not double-trigger runIndexing', async () => {
		resetDatabases();
		// First call: triggers migration.
		const Tbl1 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const firstIndexingOp = Tbl1.indexingOperation;
		assert.ok(firstIndexingOp, 'first table() call should have triggered indexingOperation');

		// Second call: should be a no-op since descriptor on disk already reflects the indexed=true state.
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});

		// If F1 manifests, the second call sees `changed=false` BEFORE the lock (descriptor in
		// memory may match), but after re-fetching, it'd still see no change. So this specific
		// test case is most informative when the descriptor change isn't yet flushed. The expected
		// invariant: indexingOperation should be the SAME promise (deduplication) or `undefined`
		// (no new migration). A NEW promise reference indicates a redundant re-trigger.
		const secondIndexingOp = Tbl2.indexingOperation;
		// Allow either same-promise OR undefined; flag a new promise as redundant.
		const redundant = secondIndexingOp && secondIndexingOp !== firstIndexingOp;
		await firstIndexingOp;
		if (secondIndexingOp) await secondIndexingOp;

		// This assertion may pass under F1 (since the on-disk descriptor has been updated by
		// the time the second call's re-fetch happens) — F1 is the bug shape but in practice
		// the re-fetch races with the disk write inside the same thread. In a multi-worker
		// scenario, two concurrent table() calls is the real repro case and is harder to
		// exercise in a single-process unit test.
		assert.ok(
			!redundant,
			'F1 fingerprint: second table() call triggered a redundant runIndexing — stale `changed` reused after re-fetch under lock.'
		);
	});
});

describe('schema-migration fragility: stale store reused after LMDB to RocksDB engine migration (F4)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const DB = 'F4EngineRebind';
	const TABLE = 'Widget';
	const testRoot = path.resolve(__dirname, '../envDir/f4EngineRebind');
	const dbDir = path.join(testRoot, terms.DATABASES_DIR_NAME);
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
	const originalEngine = process.env.HARPER_STORAGE_ENGINE;
	let preReloadStore;

	before(async () => {
		setMainIsWorker(true);
		await fs.remove(testRoot);
		await fs.mkdirp(dbDir);
		env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, testRoot);
		env.setProperty(terms.CONFIG_PARAMS.ROOTPATH, testRoot);
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, dbDir);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});

		process.env.HARPER_STORAGE_ENGINE = 'lmdb';
		resetDatabases();
		const lmdbTable = table({ table: TABLE, database: DB, attributes });
		await lmdbTable.put({ id: 'k', name: 'from-lmdb' });
		const staleTable = getDatabases()[DB][TABLE];

		// post-migration state: RocksDB on disk, stale LMDB table still in the registry
		process.env.HARPER_STORAGE_ENGINE = 'rocksdb';
		delete getDatabases()[DB];
		await fs.remove(path.join(dbDir, `${DB}.mdb`));
		await fs.remove(path.join(dbDir, `${DB}.mdb-lock`));
		const rocksTable = table({ table: TABLE, database: DB, attributes });
		await rocksTable.put({ id: 'k', name: 'from-rocks' });
		getDatabases()[DB][TABLE] = staleTable;
		preReloadStore = getDatabases()[DB][TABLE].primaryStore;

		resetDatabases();
	});

	after(async () => {
		if (originalEngine === undefined) delete process.env.HARPER_STORAGE_ENGINE;
		else process.env.HARPER_STORAGE_ENGINE = originalEngine;
		await fs.remove(testRoot);
	});

	it('starts from a stale LMDB-backed table while the data on disk is RocksDB', () => {
		assert.ok(!(preReloadStore.rootStore instanceof RocksDatabase), 'pre-reload table should be LMDB-backed');
		assert.ok(preReloadStore.path.endsWith('.mdb'), `pre-reload path should be .mdb, got ${preReloadStore.path}`);
	});

	it('rebinds the registry table to the RocksDB store on reload', () => {
		const reloaded = getDatabases()[DB]?.[TABLE];
		assert.ok(reloaded, `${DB}.${TABLE} should still be registered after reload`);
		assert.ok(
			reloaded.primaryStore.rootStore instanceof RocksDatabase,
			'primaryStore should be backed by RocksDatabase'
		);
		const p = reloaded.primaryStore.path;
		assert.ok(!p.endsWith('.mdb'), `primaryStore.path should be a RocksDB directory, got ${p}`);
		assert.ok(fs.statSync(p).isDirectory(), `${p} should be a directory`);
	});
});
