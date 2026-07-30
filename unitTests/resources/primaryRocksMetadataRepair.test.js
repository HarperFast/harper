// Regression guards for the PrimaryRocksDatabase read-path halves of HarperFast/harper#2012:
// 1. a [timestamp][no flags word] record (metadataFlags === 0) must not leak the decode
//    wrapper as the record value — the gate on METADATA must be presence, not truthiness;
// 2. a metadata-less record (e.g. stored by the broken migration) must still get the
//    structPrototype repair on point reads, matching getRange and the LMDB wrapper.
require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs-extra');
const { setupTestDBPath } = require('../testUtils');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { Packr } = require('msgpackr');
const { RecordEncoder, RecordObject, setNextEncoding } = require('#src/resources/RecordEncoder');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('PrimaryRocksDatabase metadata repair (#2012)', function () {
	let dbPath, root, store, rawStore;

	before(function () {
		if (isLMDB) return this.skip();
		dbPath = path.join(setupTestDBPath(), 'rocks-metadata-repair');
		fs.removeSync(dbPath);
		root = RocksDatabase.open(dbPath, {});
		store = new PrimaryRocksDatabase(dbPath, {
			name: 'RepairTest/',
			encoder: { Encoder: RecordEncoder },
		}).open();
		store.initStore(root);
		rawStore = RocksDatabase.open(dbPath, { name: 'RepairTest/', encoding: false });
	});

	after(function () {
		rawStore?.close();
		store?.close();
		root?.close();
	});

	it('timestamp-only record (flags word absent) reads as a record, not the decode wrapper', async function () {
		const version = Date.now() + 0.5;
		setNextEncoding(version, -1, -1, -1, 0);
		await store.put('noflags', { alpha: 1, beta: 2 }, version);

		const entry = store.getEntry('noflags');
		assert.equal(entry.version, version);
		assert.deepEqual(Object.keys(entry.value), ['alpha', 'beta']);
		assert.equal(entry.value.value, undefined, 'decode wrapper leaked as the record value');
		assert(entry.value instanceof RecordObject);

		for (const rangeEntry of store.getRange({ start: 'noflags', end: 'noflags~' })) {
			assert.equal(rangeEntry.version, version);
			assert.deepEqual(Object.keys(rangeEntry.value), ['alpha', 'beta']);
			assert(rangeEntry.value instanceof RecordObject);
		}
	});

	it('metadata-less record gets the prototype repair on point reads', async function () {
		// plain msgpackr record-ext bytes with no prefix — the layout the broken migration produced
		const packr = new Packr();
		await rawStore.put('legacy', packr.encode({ gamma: 3, delta: 4 }));

		const entry = store.getEntry('legacy');
		assert.deepEqual({ ...entry.value }, { gamma: 3, delta: 4 });
		assert(entry.value instanceof RecordObject, 'point read returned a prototype-less plain object');
		assert.equal(entry.version, undefined);

		const viaGet = store.getSync('legacy');
		assert(viaGet instanceof RecordObject);
	});
});
