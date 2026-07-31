// Regression guard for the v4->v5 migration structure-id fork fix (HarperFast/harper#1453).
//
// copyDbToRocks now runs a separate observer encoder to build + persist the canonical v5 classic
// structures, while leaving the migration encoder own/inline so the migrated records stay
// self-describing. This guards that the change does NOT regress the migration: every record still
// decodes after reopen. (Cross-process worker ADOPTION of the persisted dictionary -- the actual fork
// prevention -- needs the runtime's multi-CF open + per-worker encoder wiring, which this single-handle
// harness can't replicate; that is validated by the cluster repro. See the NOTE on the describe below.)
const fs = require('fs-extra');
const assert = require('node:assert');
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
const { setupTestDBPath } = require('../testUtils');
const copyDB = require('#src/bin/copyDb');
const { RocksDatabase } = require('@harperfast/rocksdb-js');

const isLMDB = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';

describe('migration: records still decode after the canonical-structures change (#1453)', function () {
	let rootPath, targetPath, Tbl;

	before(async function () {
		// this.skip() (not a bare return in the describe body) so the gate is visible as pending
		if (!isLMDB) return this.skip();
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
		if (rootPath) await fs.remove(path.join(rootPath, 'rocks-migrated-cstruct'));
	});

	it('migrated records decode after reopen (structures resolve)', function () {
		// Open the migrated primary CF the same way the v5 runtime would and read records back.
		// With the canonical structures persisted, every migrated record (including the bare
		// structure-id references after the first of each shape) must decode, not null out.
		// RecordEncoder is required since #2012: migrated records carry the version/metadata
		// prefix again, which a plain msgpackr decoder cannot strip. (v5.1 has no
		// PrimaryRocksDatabase; decode returns the metadata wrapper { value, version, ... }.)
		const { RecordEncoder } = require('#src/resources/RecordEncoder');
		const cf = RocksDatabase.open(targetPath, {
			name: 'CacheStruct/',
			sharedStructuresKey: Symbol.for('structures'),
			encoder: { Encoder: RecordEncoder },
		});
		cf.encoder.isRocksDB = true;
		try {
			const failures = [];
			for (const id of ['a', 'b', 'c']) {
				let rec;
				try {
					const decoded = cf.encoder.decode(cf.getBinarySync(id));
					rec = decoded?.value ?? decoded;
				} catch (e) {
					rec = { __threw: e.message };
				}
				console.log(`record ${id}:`, JSON.stringify(rec));
				if (!rec || rec.__threw || rec.content === undefined || rec.headers === undefined) failures.push(id);
			}
			assert.strictEqual(
				failures.length,
				0,
				`migrated records ${failures.join(',')} did not decode after reopen (structures did not resolve)`
			);
		} finally {
			cf.close();
		}
	});
});
