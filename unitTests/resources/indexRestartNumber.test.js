/**
 * Regression coverage for the previously-dead `restartNumber` reindex trigger in
 * resources/databases.ts (issue #1359).
 *
 * table() re-triggers an index backfill when the persisted attribute descriptor's
 * `restartNumber` is older than the current restart generation
 * (`attributeDescriptor.restartNumber < manageThreads.restartNumber`). This is the
 * PID-reuse-robust crash detector: if a worker dies mid-index and the replacement
 * worker happens to reuse the old PID, the `indexingPID !== process.pid` check can't
 * tell them apart, but the monotonically-increasing restart generation can.
 *
 * Before this fix `restartNumber` was never persisted onto the descriptor, so the
 * comparison was always `undefined < N` (false) and the trigger never fired. These
 * tests assert the value is now (a) persisted while indexing is incomplete, (b)
 * cleared on clean completion, and (c) actually drives a re-trigger.
 */
require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { setMainIsWorker } = manageThreads;

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

// The per-attribute descriptor is persisted in Table.dbisDB keyed by the attribute's
// internal key; find it by name rather than reconstructing the key format.
function findDescriptor(Tbl, attrName) {
	for (const { key, value } of Tbl.dbisDB.getRange({ start: false })) {
		if (value && value.name === attrName) return { key, value };
	}
	return null;
}

describe('indexing crash-recovery: restartNumber re-trigger (#1359)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const DB = 'test';
	const N = 20;
	let savedRestart;

	beforeEach(() => {
		savedRestart = manageThreads.restartNumber;
	});
	afterEach(() => {
		manageThreads.restartNumber = savedRestart;
	});

	it('persists restartNumber on an incomplete (parked) index and clears it after a clean run', async () => {
		const TABLE = 'RN_SetThenClear';
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'k-' + i, tag: i % 2 ? 'odd' : 'even' });
		await last;

		// Add @indexed and force the backfill to PARK by rejecting some index puts with a permanent
		// (non-retryable) error. The park path preserves the in-progress markers, so the descriptor
		// should retain restartNumber set to the current generation.
		resetDatabases();
		Tbl = table({
			table: TABLE,
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
				if (++opCount % 7 === 0) return Promise.reject(new Error('simulated permanent index put failure'));
				return origPut(indexedValue, primaryKey, options);
			};
		}
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		const parked = findDescriptor(Tbl, 'tag');
		assert.ok(parked, 'tag descriptor should exist after a parked backfill');
		assert.equal(parked.value.indexingFailed, true, 'a parked index should be marked indexingFailed');
		assert.equal(
			parked.value.restartNumber,
			manageThreads.restartNumber,
			'restartNumber must be persisted (== current generation) while the index is incomplete'
		);

		// Simulate a clean restart: re-open without the failing mock. indexingFailed re-triggers the
		// backfill, which now completes cleanly and must CLEAR restartNumber.
		resetDatabases();
		const Tbl2 = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.ok(Tbl2.indexingOperation, 'parked index should re-trigger on restart');
		await Tbl2.indexingOperation;

		const done = findDescriptor(Tbl2, 'tag');
		assert.equal(done.value.restartNumber, undefined, 'restartNumber must be cleared after a clean completion');
		assert.equal(done.value.indexingFailed, undefined, 'indexingFailed must be cleared after a clean completion');
		const evens = await collect(Tbl2.search({ conditions: [{ attribute: 'tag', value: 'even' }] }));
		assert.equal(evens.length, N / 2, 'all rows should be indexed after the clean re-run');
	});

	it('re-triggers a backfill when persisted restartNumber is older than the current generation (and not when equal)', async () => {
		const TABLE = 'RN_Retrigger';
		setupTestDBPath();
		setMainIsWorker(true);

		let Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'r-' + i, tag: 'v-' + (i % 3) });
		await last;

		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const buildOp = Tbl.indexingOperation;
		if (buildOp) await buildOp;

		// Simulate an index whose descriptor was last written by an OLDER restart generation, with no
		// other trigger flags set, so restartNumber is the ONLY thing that can re-trigger. A re-trigger
		// is detected by table() installing a NEW indexingOperation promise (the promise carries across
		// resetDatabases, so identity — not truthiness — is the reliable signal; cf. the F1 test).
		const oldGen = manageThreads.restartNumber;
		const desc = findDescriptor(Tbl, 'tag');
		assert.ok(desc, 'tag descriptor should exist');
		desc.value.restartNumber = oldGen;
		delete desc.value.indexingFailed;
		delete desc.value.indexingPID;
		Tbl.dbisDB.putSync(desc.key, desc.value);

		// Control: current generation == persisted generation -> NO re-trigger (same promise).
		manageThreads.restartNumber = oldGen;
		resetDatabases();
		const TblSame = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.equal(
			TblSame.indexingOperation,
			buildOp,
			'must NOT re-trigger when persisted restartNumber equals the current generation'
		);

		// Re-assert the stale descriptor (the no-trigger path above does not rewrite it) and advance the
		// restart generation: persisted(oldGen) < current -> re-trigger (a new indexingOperation promise).
		const desc2 = findDescriptor(TblSame, 'tag');
		desc2.value.restartNumber = oldGen;
		delete desc2.value.indexingFailed;
		delete desc2.value.indexingPID;
		TblSame.dbisDB.putSync(desc2.key, desc2.value);

		manageThreads.restartNumber = oldGen + 1;
		resetDatabases();
		const TblNewGen = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		assert.notEqual(
			TblNewGen.indexingOperation,
			buildOp,
			'must re-trigger (new indexingOperation) when persisted restartNumber is older than the current generation'
		);
		assert.ok(TblNewGen.indexingOperation, 're-trigger should install an indexingOperation');
		await TblNewGen.indexingOperation;

		const after = findDescriptor(TblNewGen, 'tag');
		assert.equal(after.value.restartNumber, undefined, 'restartNumber cleared after the re-run completes');
		let total = 0;
		for (const v of ['v-0', 'v-1', 'v-2']) {
			total += (await collect(TblNewGen.search({ conditions: [{ attribute: 'tag', value: v }] }))).length;
		}
		assert.equal(total, N, 'all rows should be indexed after the restartNumber-triggered re-run');
	});
});
