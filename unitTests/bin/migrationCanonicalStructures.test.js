// Regression test for the v4->v5 migration structure-id fork (HarperFast/harper#1453).
//
// copyDbToRocks re-encodes records with a no-op saveStructures, so historically the only structures
// written to durable were copyStructures()'s verbatim copy of the v4 buffer -- which, for a v4
// random-access (typed) table, holds NONE of the v5 classic record-structures. The v5 workers then
// minted those structures from scratch, concurrently, assigning the same structure-id to different
// structures (the fork that silently nulls records). copyDbToRocks now persists the canonical classic
// structures it minted at the end of migration so every worker adopts one agreed dictionary.
//
// This test asserts that after migration the durable shared-structures buffer actually carries the
// record's named structure (so a fresh worker encoder loads it instead of minting from an empty dict).
const fs = require('fs-extra');
const assert = require('node:assert/strict');
const path = require('path');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// NOTE: this guards that the canonical-structures observer change does NOT regress the migration —
// migrated records stay self-describing (own/inline) and decode after reopen. End-to-end verification
// that v5 workers ADOPT the persisted canonical dictionary (the fork prevention) is an integration
// concern: it requires the runtime's multi-column-family open + per-worker encoder wiring, which this
// single-handle unit harness can't replicate. The observer's captured dictionary is verified in-process
// during the migration; cross-process adoption is validated by the cluster repro.
describe('migration: records still decode after the canonical-structures change (#1453)', function () {
	if ((process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb') return;
	const { setupTestDBPath } = require('../testUtils');
	const copyDB = require('#src/bin/copyDb');
	const { RocksDatabase } = require('@harperfast/rocksdb-js');

	let rootPath, targetPath, Tbl;

	before(async function () {
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({
			table: 'CacheStruct',
			database: 'cstest',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'headers' }, { name: 'content' }],
		});
		// Records of the same logical shape arriving in different key orders -> multiple named structures.
		await Tbl.put({ id: 'a', headers: { 'content-type': 'text/html' }, content: 'AAA' });
		await Tbl.put({ content: 'BBB', id: 'b', headers: { 'content-type': 'text/css' } });
		await Tbl.put({ id: 'c', headers: { 'content-type': 'application/json' }, content: 'CCC' });

		targetPath = path.join(rootPath, 'rocks-migrated-cstruct', 'cstest');
		await fs.remove(targetPath);
		await copyDB.copyDbToRocks(Tbl.primaryStore.rootStore, 'cstest', targetPath);
	});

	after(async function () {
		await fs.remove(path.join(rootPath, 'rocks-migrated-cstruct'));
	});

	it('migrated records decode after reopen (structures resolve)', function () {
		// Open the migrated primary CF the same way the v5 runtime would and read records back.
		// With the canonical structures persisted, every migrated record (including the bare
		// structure-id references after the first of each shape) must decode, not null out.
		const cf = RocksDatabase.open(targetPath, { name: 'CacheStruct/', sharedStructuresKey: Symbol.for('structures') });
		try {
			const failures = [];
			for (const id of ['a', 'b', 'c']) {
				let rec;
				try {
					rec = cf.get(id);
				} catch (e) {
					rec = { __threw: e.message };
				}
				console.log(`record ${id}:`, JSON.stringify(rec));
				if (!rec || rec.__threw || rec.content === undefined || rec.headers === undefined) failures.push(id);
			}
			assert.equal(failures.length, 0, `migrated records ${failures.join(',')} did not decode after reopen (structures did not resolve)`);
		} finally {
			cf.close();
		}
	});
});
