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
const { ACTION_32_BIT } = require('#src/resources/auditStore');
const { createBlob, encodeBlobsWithFilePath } = require('#src/resources/blob');
const {
	RecordEncoder,
	RecordObject,
	setNextEncoding,
	stageRawPrimaryEncoding,
} = require('#src/resources/RecordEncoder');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

function asBinary(buffer) {
	return { ['\x10binary-data\x02']: buffer };
}

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
		assert.strictEqual(entry.version, version);
		assert.deepStrictEqual(Object.keys(entry.value), ['alpha', 'beta']);
		assert.strictEqual(entry.value.value, undefined, 'decode wrapper leaked as the record value');
		assert(entry.value instanceof RecordObject);

		for (const rangeEntry of store.getRange({ start: 'noflags', end: 'noflags~' })) {
			assert.strictEqual(rangeEntry.version, version);
			assert.deepStrictEqual(Object.keys(rangeEntry.value), ['alpha', 'beta']);
			assert(rangeEntry.value instanceof RecordObject);
		}
	});

	it('metadata-less record gets the prototype repair on point reads', async function () {
		// plain msgpackr record-ext bytes with no prefix — the layout the broken migration produced
		const packr = new Packr();
		await rawStore.put('legacy', packr.encode({ gamma: 3, delta: 4 }));

		const entry = store.getEntry('legacy');
		assert.deepStrictEqual({ ...entry.value }, { gamma: 3, delta: 4 });
		assert(entry.value instanceof RecordObject, 'point read returned a prototype-less plain object');
		assert.strictEqual(entry.version, undefined);

		const viaGet = store.getSync('legacy');
		assert(viaGet instanceof RecordObject);
	});
});

describe('PrimaryRocksDatabase raw-write versioning (#1762)', function () {
	let dbPath, root, store, rawStore;

	before(function () {
		if (isLMDB) return this.skip();
		dbPath = path.join(setupTestDBPath(), 'rocks-raw-write-versioning');
		fs.removeSync(dbPath);
		root = RocksDatabase.open(dbPath, {});
		store = new PrimaryRocksDatabase(dbPath, {
			name: 'RawWriteTest/',
			encoder: { Encoder: RecordEncoder },
			useVersions: true,
			sharedStructuresKey: Symbol.for('structures'),
		}).open();
		store.initStore(root);
		rawStore = RocksDatabase.open(dbPath, { name: 'RawWriteTest/', encoding: false });
	});

	after(function () {
		rawStore?.close();
		store?.close();
		root?.close();
	});

	it('does not stage metadata for an encoder that is not initialized for RocksDB', function () {
		assert.strictEqual(stageRawPrimaryEncoding({ useVersions: true, isRocksDB: false }, 123), false);
	});

	it('versions mixed-shape raw puts before classic structure id 0x42 can collide', function () {
		for (let copy = 1; copy <= 2; copy++) {
			store.putSync(`failure-${copy}`, {
				backend: 'unknown',
				method: 'generate',
				model: 'missing',
				success: false,
				error_code: 'backend_not_found',
			});
		}
		for (let copy = 1; copy <= 2; copy++) {
			store.putSync(`generate-${copy}`, {
				backend: 'deterministic',
				method: 'generate',
				model: 'probe',
				success: true,
				prompt_tokens: 1,
				completion_tokens: 1,
			});
		}
		for (let copy = 1; copy <= 2; copy++) {
			store.putSync(`stream-${copy}`, {
				backend: 'deterministic',
				method: 'generateStream',
				model: 'probe',
				success: true,
			});
		}

		const bytes = rawStore.getBinarySync('stream-2');
		assert.strictEqual(bytes.readUint32BE(8), ACTION_32_BIT << 24, 'raw write must include a zero flags word');
		assert.strictEqual(
			bytes[12],
			0x42,
			`precondition: stream shape must use classic structure id 0x42; bytes=${bytes.toString('hex')}`
		);
		assert.deepStrictEqual(
			{ ...store.getSync('stream-2') },
			{ backend: 'deterministic', method: 'generateStream', model: 'probe', success: true }
		);
		assert(store.getEntry('stream-2').version > 0);
	});

	it('uses a positional version verbatim for sync raw puts', function () {
		const version = 1_800_000_000_000.25;
		store.putSync('explicit-version', { source: 'legacy-call-shape' }, version);
		assert.strictEqual(store.getEntry('explicit-version').version, version);
	});

	it('uses a positional version verbatim for async raw puts', async function () {
		const version = 1_800_000_000_000.5;
		await store.put('explicit-async-version', { source: 'async-call-shape' }, version);
		assert.strictEqual(store.getEntry('explicit-async-version').version, version);
	});

	it('replaces an unusable explicit version with a monotonic version', function () {
		store.putSync('zero-version', { source: 'legacy-zero' }, 0);
		assert(store.getEntry('zero-version').version > 0);
	});

	it('does not replace metadata already staged by recordUpdater', function () {
		const stagedVersion = 1_800_000_000_001.5;
		setNextEncoding(stagedVersion, 0);
		store.putSync('staged-version', { source: 'record-updater' }, { version: stagedVersion + 1 });
		assert.strictEqual(store.getEntry('staged-version').version, stagedVersion);
	});

	it('does not inherit a stale blob flag on a wrapper-staged raw write', function () {
		const blob = createBlob(Buffer.from('prior write'));
		blob.saveInRecord = true;
		encodeBlobsWithFilePath(() => store.encoder.encode({ blob }), 99, root);
		store.putSync('after-blob', { source: 'raw-write' });
		assert.strictEqual(rawStore.getBinarySync('after-blob').readUint32BE(8), ACTION_32_BIT << 24);
	});

	it('clears wrapper metadata when a raw binary write bypasses the encoder', function () {
		const buffer = Buffer.from([1, 2, 3]);
		store.putSync('binary', asBinary(buffer), 123);
		assert.deepStrictEqual(rawStore.getBinarySync('binary'), buffer);
		store.putSync('after-binary', { source: 'next-write' });
		assert.notStrictEqual(store.getEntry('after-binary').version, 123);
	});

	it('clears wrapper metadata when the store rejects before encoding', function () {
		const closed = new PrimaryRocksDatabase(dbPath, {
			name: 'ClosedRawWriteTest/',
			encoder: { Encoder: RecordEncoder },
		});
		closed.initStore(root);
		assert.throws(() => closed.putSync('closed', { source: 'failure' }, 456), /Database not open/);
		store.putSync('after-failure', { source: 'next-write' });
		assert.notStrictEqual(store.getEntry('after-failure').version, 456);
	});
});
