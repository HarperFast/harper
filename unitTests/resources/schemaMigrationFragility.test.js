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
const assert = require('node:assert');
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

	it('parks the index (does not silently complete) when a per-record index write fails permanently', async () => {
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

		// Now add @indexed to tag. During runIndexing, intercept dbi.put calls for some records to
		// simulate a permanent (non-retryable) per-record error — which must park the index, not
		// silently complete. (Transient ERR_BUSY/ERR_TRY_AGAIN errors are retried instead; see the
		// next test.)
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
				// reject every 10th index put with a permanent (non-retryable) error
				if (opCount % 10 === 0) {
					return Promise.reject(new Error('simulated permanent index put failure'));
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

	it('retries transient ERR_BUSY index write errors instead of parking the index', async () => {
		// Same fragility setup, but the injected error is a TRANSIENT ERR_BUSY (RocksDB write
		// contention). The backfill should retry it with bounded backoff and complete cleanly in a
		// single pass — no park, no 503, no restart needed.
		const TABLE3 = TABLE + 'WithTransientIndex';
		resetDatabases();
		let Tbl = table({
			table: TABLE3,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		const VALUES = ['alpha', 'beta', 'gamma'];
		for (let i = 0; i < N; i++) {
			last = Tbl.put({ id: 't3-' + i, tag: VALUES[i % VALUES.length] });
		}
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE3,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const tagIndex = Tbl.indices?.tag;
		let injected = 0;
		const failedKeys = new Set();
		if (tagIndex && typeof tagIndex.put === 'function') {
			const origPut = tagIndex.put.bind(tagIndex);
			tagIndex.put = function (indexedValue, primaryKey, options) {
				// Fail a handful of keys exactly once with a TRANSIENT ERR_BUSY — alternating a
				// SYNCHRONOUS throw (the RocksIndexStore putSync path) and an async rejection so both
				// retry branches are exercised. On the in-process retry pass the key is no longer in
				// the fail set, so the put succeeds and the backfill completes cleanly (no park, no 503).
				const targeted = /-(?:4|14|24|34|44)$/.test(String(primaryKey));
				if (targeted && !failedKeys.has(primaryKey)) {
					failedKeys.add(primaryKey);
					injected++;
					const err = Object.assign(new Error('simulated transient index put failure'), { code: 'ERR_BUSY' });
					if (injected % 2 === 1) throw err;
					return Promise.reject(err);
				}
				return origPut(indexedValue, primaryKey, options);
			};
		}
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		assert.ok(injected > 0, 'expected the test to inject at least one transient ERR_BUSY');

		// The retry should have completed the backfill cleanly: search must NOT throw 503 (would throw
		// if the index were parked), and every row must be present in the new index.
		let total = 0;
		for (const v of VALUES) {
			const rows = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: v }] }));
			total += rows.length;
		}
		assert.equal(total, N, `transient errors should be retried and all ${N} rows indexed; got ${total}`);
	});

	it('retried transient errors re-cover rows that the intra-pass checkpoint advanced past (no gap)', async () => {
		// Regression guard for the failure mode that sank the per-put retry approach: the intra-pass
		// checkpoint advances `lastIndexedKey` every 100 rows, even past a put that later fails. If a
		// retry resumed from that checkpoint it would skip the failed early row, leaving a silent gap.
		// The pass-level retry instead re-runs from the pass start, re-reading every row.
		const TABLE4 = TABLE + 'CheckpointGap';
		const M = 250; // > 100 so the checkpoint fires and advances past the early failing row
		resetDatabases();
		let Tbl = table({
			table: TABLE4,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		const VALUES = ['alpha', 'beta', 'gamma'];
		for (let i = 0; i < M; i++) {
			// zero-padded so lexicographic key order matches numeric order and the targeted row is
			// reliably scanned early (before the first 100-row checkpoint).
			last = Tbl.put({ id: 't4-' + String(i).padStart(3, '0'), tag: VALUES[i % VALUES.length] });
		}
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE4,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const tagIndex = Tbl.indices?.tag;
		let injected = 0;
		const failedKeys = new Set();
		if (tagIndex && typeof tagIndex.put === 'function') {
			const origPut = tagIndex.put.bind(tagIndex);
			tagIndex.put = function (indexedValue, primaryKey, options) {
				// Fail one EARLY row once (transiently). The checkpoint at row 100/200 advances the
				// resume point well past it, so only a from-pass-start retry can re-cover it.
				if (String(primaryKey).endsWith('t4-005') && !failedKeys.has(primaryKey)) {
					failedKeys.add(primaryKey);
					injected++;
					return Promise.reject(
						Object.assign(new Error('simulated transient index put failure'), { code: 'ERR_BUSY' })
					);
				}
				return origPut(indexedValue, primaryKey, options);
			};
		}
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		assert.ok(injected > 0, 'expected the test to inject a transient ERR_BUSY on the early row');

		let total = 0;
		for (const v of VALUES) {
			const rows = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: v }] }));
			total += rows.length;
		}
		assert.equal(
			total,
			M,
			`all ${M} rows must be indexed after retry — a resume-from-checkpoint retry would skip the ` +
				`early failed row, leaving a gap. Got ${total}.`
		);
		// And the specific early row must be findable by its indexed value.
		const earlyRows = await collect(
			Tbl.search({ conditions: [{ attribute: 'tag', value: VALUES[5 % VALUES.length] }] })
		);
		assert.ok(
			earlyRows.some((r) => r.id === 't4-005'),
			'the early row that failed transiently must be present in the index after the retry'
		);
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

describe('schema-migration fragility: non-indexed attributes missing from table.attributes after resetDatabases() (RE-7)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const DB = 're7NonIndexedAttrs';
	const TABLE = 'Pet';
	const testRoot = path.resolve(__dirname, '../envDir/re7NonIndexedAttrs');
	const dbDir = path.join(testRoot, terms.DATABASES_DIR_NAME);

	before(async () => {
		setMainIsWorker(true);
		await fs.remove(testRoot);
		await fs.mkdirp(dbDir);
		env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, testRoot);
		env.setProperty(terms.CONFIG_PARAMS.ROOTPATH, testRoot);
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, dbDir);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});

		resetDatabases();
		// Initial schema: only the primary key — simulates the main thread's stale view
		// before a worker restart expands the schema.
		table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		// Simulate a worker restart writing the expanded schema to attributesDbi.
		// table() updates BOTH in-memory Table.attributes AND attributesDbi, so after
		// this call attributesDbi has all four attributes.
		table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'breed' }, { name: 'age' }],
		});
		// Re-create the stale main-thread state: reset in-memory Table.attributes back to
		// [id] only, while attributesDbi still has all four.  This is exactly the mismatch
		// that exists on the main thread after a worker restarts and writes a new schema —
		// the main thread's Table.attributes hasn't been updated yet.
		const staleTable = getDatabases()[DB]?.[TABLE];
		staleTable.attributes.splice(0, staleTable.attributes.length, { name: 'id', isPrimaryKey: true });
		// Simulate the ITC schema-change handler calling resetDatabases() in the main thread
		// (the path that describe_database goes through).  Without the fix, initStores()
		// only re-syncs indexed/pk attributes and the non-indexed fields stay missing.
		resetDatabases();
	});

	after(async () => {
		await fs.remove(testRoot);
	});

	it('table.attributes includes all non-indexed fields after resetDatabases()', () => {
		const tbl = getDatabases()[DB]?.[TABLE];
		assert.ok(tbl, `${DB}.${TABLE} should be registered after resetDatabases()`);
		const attrNames = tbl.attributes.map((a) => a.name);
		assert.ok(attrNames.includes('name'), `expected "name" in attributes, got: ${attrNames}`);
		assert.ok(attrNames.includes('breed'), `expected "breed" in attributes, got: ${attrNames}`);
		assert.ok(attrNames.includes('age'), `expected "age" in attributes, got: ${attrNames}`);
	});

	it('removes non-indexed attributes dropped from the schema after resetDatabases()', () => {
		// Simulate schema shrinking (field removal), then another resetDatabases().
		table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		// table() updates in-memory Table.attributes directly (databases.ts:997), so after the
		// call above the in-memory state is already [id, name].  Re-create the stale main-thread
		// view — still holding the old [id, name, breed, age] — so that the removal loop in
		// initStores() actually needs to drop breed and age.  Two adjacent removals (breed AND
		// age) also guard against a regression of the splice-while-iterating bug: splicing the
		// array being iterated by `for...of` skipped the next element, so the loop must collect
		// removals first and apply them after the iteration.
		const tblForRemoval = getDatabases()[DB]?.[TABLE];
		tblForRemoval.attributes.splice(
			0,
			tblForRemoval.attributes.length,
			{ name: 'id', isPrimaryKey: true },
			{ name: 'name' },
			{ name: 'breed' },
			{ name: 'age' }
		);
		resetDatabases();
		const tbl = getDatabases()[DB]?.[TABLE];
		const attrNames = tbl.attributes.map((a) => a.name);
		assert.ok(attrNames.includes('name'), `expected "name" in attributes`);
		assert.ok(!attrNames.includes('breed'), `"breed" should be removed, got: ${attrNames}`);
		assert.ok(!attrNames.includes('age'), `"age" should be removed, got: ${attrNames}`);
	});

	it('preserves runtime-only relationship attributes across resetDatabases()', () => {
		// Relationship attrs are runtime-only — table()'s persistence loop skips them
		// (databases.ts:1138, `if (attribute.relationship) continue`), so they are present in
		// table.attributes but never written to attributesDbi.  After resetDatabases(),
		// initStores() rebuilds `attributes` from attributesDbi only — so the relationship attr
		// won't appear there.  The removal loop must not drop it; otherwise updatedAttributes()
		// would strip the resolver/search support and downstream GraphQL nested queries return
		// undefined (the integration symptom: graphql-querying-test "handles query by nested
		// attribute" assertions).
		table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const tblWithRel = getDatabases()[DB]?.[TABLE];
		// Inject a runtime-only relationship attribute, mirroring what graphql.ts does after
		// parsing a `@relationship` directive — these never round-trip through attributesDbi.
		tblWithRel.attributes.push({ name: 'related', relationship: { from: 'relatedId' } });
		resetDatabases();
		const tbl = getDatabases()[DB]?.[TABLE];
		const attrNames = tbl.attributes.map((a) => a.name);
		assert.ok(
			attrNames.includes('related'),
			`relationship attribute "related" should survive resetDatabases() but was dropped — got: ${attrNames}`
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
