require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('lmdb');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const { OpenDBIObject } = require('#src/utility/lmdb/OpenDBIObject');
const OpenEnvironmentObject = require('#src/utility/lmdb/OpenEnvironmentObject').default;
const harperLogger = require('#js/utility/logging/harper_logger');

// Each engine opens its store directly, so one run covers all three save paths regardless of
// HARPER_STORAGE_ENGINE. `saveStore` is the store whose transactionSync runs the structure save;
// `saveDepth` is how deeply that call is nested in the write's own transactionSync calls.
function openRocks(dir, { randomAccessStructure = true } = {}) {
	const db = PrimaryRocksDatabase.open(dir, {
		...new OpenDBIObject(false, true),
		randomAccessStructure,
		disableWAL: false,
		name: 'Shapes',
	});
	db.encoder.useVersions = false;
	return {
		db,
		saveStore: db,
		saveDepth: 0,
		put: (key, value) => db.putSync(key, value),
		get: (key) => db.getSync(key),
		getBinary: (key) => db.getBinarySync(key),
		close: () => db.close(),
	};
}
const engines = [
	{ name: 'RocksDB, store-local structures (rocksStore)', canAbort: true, open: openRocks },
	{
		name: 'RocksDB, table structures in the root store (initStore)',
		canAbort: true,
		open(dir) {
			const rootDb = PrimaryRocksDatabase.open(dir, {
				...new OpenDBIObject(false, false),
				randomAccessStructure: false,
				disableWAL: false,
				name: '__dbis__',
			});
			rootDb.encoder.useVersions = false;
			const db = PrimaryRocksDatabase.open(dir, {
				...new OpenDBIObject(false, true),
				randomAccessStructure: true,
				disableWAL: false,
				name: 'Shapes',
			});
			db.initStore(rootDb);
			return {
				db,
				saveStore: rootDb,
				saveDepth: 0,
				put: (key, value) => db.putSync(key, value),
				get: (key) => db.getSync(key),
				getBinary: (key) => db.getBinarySync(key),
				close: () => {
					db.close();
					rootDb.close();
				},
			};
		},
	},
	{
		name: 'LMDB',
		// lmdb-js's saver has no swallowed-abort result: `undefined` is its commit.
		canAbort: false,
		open(dir) {
			const env = open(new OpenEnvironmentObject(dir));
			const db = env.openDB('Shapes', { ...new OpenDBIObject(false, false), randomAccessStructure: true });
			db.encoder.useVersions = false;
			return {
				db,
				saveStore: db,
				saveDepth: 1,
				put: (key, value) => db.putSync(key, value),
				get: (key) => db.get(key),
				getBinary: (key) => db.getBinary(key),
				close: () => env.close(),
			};
		},
	},
];

const abortSave = () => undefined;
const throwInSave = () => {
	throw new Error('injected structure-save failure');
};

function failSaves(handle, ...faults) {
	const store = handle.saveStore;
	const original = store.transactionSync;
	let depth = 0;
	store.transactionSync = function (callback, options) {
		if (faults.length > 0 && depth === handle.saveDepth) return faults.shift()();
		depth++;
		try {
			return original.call(this, callback, options);
		} finally {
			depth--;
		}
	};
	return () => {
		store.transactionSync = original;
		assert.strictEqual(faults.length, 0, 'precondition: every injected structure-save fault was reached');
	};
}

describe('RecordEncoder discards structures from a structure save that did not commit', () => {
	let tmpDir;
	let warnings, errors, restoreWarn, restoreError;
	const handles = [];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-struct-rollback-'));
		warnings = [];
		errors = [];
		restoreWarn = harperLogger.warn;
		restoreError = harperLogger.error;
		harperLogger.warn = (...args) => warnings.push(args);
		harperLogger.error = (...args) => errors.push(args);
	});

	afterEach(() => {
		harperLogger.warn = restoreWarn;
		harperLogger.error = restoreError;
		while (handles.length) {
			try {
				handles.pop().close();
			} catch {}
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function assertNoDecodeFailures() {
		assert.deepStrictEqual(warnings, [], 'no missing-structure warnings');
		assert.deepStrictEqual(errors, [], 'no decode errors');
	}

	function assertTypedRecord(handle, key) {
		const raw = handle.getBinary(key);
		assert.ok(
			raw[0] >= 0x20 && raw[0] < 0x40,
			`${key} must be a typed record, got leading byte 0x${raw[0].toString(16)}`
		);
	}

	for (const engine of engines) {
		describe(engine.name, () => {
			const openHandle = () => {
				const handle = engine.open(tmpDir);
				handles.push(handle);
				return handle;
			};
			const reopen = (...toClose) => {
				for (const handle of toClose) {
					handle.close();
					handles.splice(handles.indexOf(handle), 1);
				}
				return openHandle();
			};

			if (engine.canAbort) {
				it('persists the first typed structure when its save transaction aborts', () => {
					const writer = openHandle();
					const restore = failSaves(writer, abortSave);
					writer.put('k1', { a: 1, b: 2 });
					restore();
					assertTypedRecord(writer, 'k1');

					const reader = reopen(writer);
					assert.deepEqual(reader.get('k1'), { a: 1, b: 2 });
					assertNoDecodeFailures();
				});

				it('keeps durable typed structures when a later mint aborts', () => {
					const writer = openHandle();
					writer.put('k0', { x: 1, y: 2 });
					const restore = failSaves(writer, abortSave);
					writer.put('k1', { alpha: 1, beta: 2 });
					restore();
					writer.put('k2', { x: 3, y: 4 });

					const reader = reopen(writer);
					assert.deepEqual(reader.get('k0'), { x: 1, y: 2 });
					assert.deepEqual(reader.get('k1'), { alpha: 1, beta: 2 });
					assert.deepEqual(reader.get('k2'), { x: 3, y: 4 });
					assert.strictEqual(reader.db.encoder.getStructureCounts().typed, 2);
					assertNoDecodeFailures();
				});

				it('throws when the retry after an abort fails too, and the next write persists', () => {
					// A swallowed abort comes from teardown; the re-pack's save then throws.
					const writer = openHandle();
					const restore = failSaves(writer, abortSave, throwInSave);
					assert.throws(() => writer.put('bad', { a: 1, b: 2 }), /injected structure-save failure/);
					restore();
					writer.put('good', { a: 1, b: 2 });

					const reader = reopen(writer);
					assert.deepEqual(reader.get('good'), { a: 1, b: 2 });
					assertNoDecodeFailures();
				});
			}

			it('persists the first typed structure when its save throws', () => {
				const writer = openHandle();
				const restore = failSaves(writer, throwInSave);
				assert.throws(() => writer.put('bad', { alpha: 1, beta: 2 }), /injected structure-save failure/);
				restore();
				writer.put('good', { alpha: 1, beta: 2 });
				assertTypedRecord(writer, 'good');

				const reader = reopen(writer);
				assert.deepEqual(reader.get('good'), { alpha: 1, beta: 2 });
				assertNoDecodeFailures();
			});

			it('re-mints a typed structure whose save lost to a classic-only dictionary', () => {
				// Classic-only dictionaries are saved without their typed half, and structon's reload of
				// that form keeps the encoder's own typed structures, including the one that lost. An
				// encoder whose first load found nothing reloads before every encode, so the writer loads
				// a non-empty dictionary first to hold one the peer can then outdate.
				const writer = openHandle();
				const peer = openHandle();
				peer.put('p0', [{ n: 1 }]);
				writer.put('w0', [{ m: 1 }]);
				peer.put('p1', [{ o: 1 }]);
				writer.put('w1', { alpha: 1, beta: 2 });
				assertTypedRecord(writer, 'w1');

				const reader = reopen(writer, peer);
				assert.deepEqual(reader.get('p0'), [{ n: 1 }]);
				assert.deepEqual(reader.get('w0'), [{ m: 1 }]);
				assert.deepEqual(reader.get('p1'), [{ o: 1 }]);
				assert.deepEqual(reader.get('w1'), { alpha: 1, beta: 2 });
				assertNoDecodeFailures();
			});

			it("keeps durable typed structures through a failed mint and reads a peer's reuse of its id", () => {
				const writer = openHandle();
				const peer = openHandle();
				writer.put('k0', { x: 1, y: 2 });
				const restore = failSaves(writer, throwInSave);
				assert.throws(() => writer.put('bad', { alpha: 1, beta: 2 }), /injected structure-save failure/);
				restore();
				// The peer mints the id the failed save would have taken, for a different shape.
				peer.put('kp', { p: 'hello', q: 'world' });
				assert.deepEqual(writer.get('kp'), { p: 'hello', q: 'world' }, 'read before the writer encodes again');
				writer.put('k2', { alpha: 1, beta: 2 });

				const reader = reopen(writer, peer);
				assert.deepEqual(reader.get('k0'), { x: 1, y: 2 });
				assert.deepEqual(reader.get('kp'), { p: 'hello', q: 'world' });
				assert.deepEqual(reader.get('k2'), { alpha: 1, beta: 2 });
				assert.strictEqual(reader.db.encoder.getStructureCounts().typed, 3);
				assertNoDecodeFailures();
			});
		});
	}

	describe('LMDB (saver delegated to lmdb-js)', () => {
		it('records a structure update only for a committed save, and a failure leaves a pending one', () => {
			const writer = engines[2].open(tmpDir);
			const peer = engines[2].open(tmpDir);
			handles.push(writer, peer);
			writer.put('w0', { z: 1 });
			peer.put('p0', { y: 1 });
			writer.put('w1', { id: '1', a: 'first' });
			assert.ok(writer.db.encoder.structureUpdate, 'a committed save (lmdb-js returns undefined) records it');

			// The peer's dictionary predates w1, so its save of the same shape is declined and the
			// re-pack finds the shape in the reloaded dictionary without saving.
			peer.db.encoder.structureUpdate = undefined;
			peer.put('p1', { id: '2', a: 'second' });
			assert.strictEqual(peer.db.encoder.structureUpdate, undefined, 'a declined save records no structure update');
			assert.deepEqual(writer.get('p1'), { id: '2', a: 'second' });

			const restore = failSaves(writer, throwInSave);
			assert.throws(() => writer.put('w2', { other: 1 }), /injected structure-save failure/);
			restore();
			assert.ok(writer.db.encoder.structureUpdate, 'a failed save leaves the earlier unconsumed update');
			assertNoDecodeFailures();
		});
	});

	it('persists classic structures when their save transaction aborts (RocksDB, typed encoding off)', () => {
		const writer = openRocks(tmpDir, { randomAccessStructure: false });
		handles.push(writer);
		const restore = failSaves(writer, abortSave);
		writer.put('c1', { a: 1, b: 2 });
		restore();
		writer.close();
		handles.pop();

		const reader = openRocks(tmpDir, { randomAccessStructure: false });
		handles.push(reader);
		assert.deepEqual(reader.get('c1'), { a: 1, b: 2 });
		assertNoDecodeFailures();
	});
});
