require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RecordEncoder } = require('#src/resources/RecordEncoder');

// Regression for harper-pro#362 (and the #352 auth-path wedge).
//
// The replayLogs `case 'structures'` apply used to persist the shared-structure buffer to the PLAIN
// key Symbol.for('structures') on `primaryStore`. But the RocksDB decode read path
// (RecordEncoder.getStructures) reads `rootStore` at the COMPOSITE key [Symbol.for('structures'), name].
// So a structure delivered only via replication landed where getStructures never looks: records
// referencing it threw "Record id is not defined" and RecordEncoder.decode returned null, until a
// full-copy resync rewrote the row via saveStructures (composite key).
//
// The fix writes the replayed structures to the same composite key on the same rootStore that
// saveStructures/getStructures use. These tests prove that at the level that matters: a structure
// persisted at the composite key is visible to a cold decoder (and its records decode), while the
// same structure at the old plain key stays invisible (decode -> null). The plain-key case is the
// negative control demonstrating the fix is necessary, not cosmetic.

const STRUCTURES = Symbol.for('structures');

// Mirror the local `asBinary` helper in resources/replayLogs.ts: it wraps the raw structures buffer
// in msgpackr's binary-data marker so putSync stores the exact bytes rather than re-encoding them.
function asBinary(buffer) {
	return { ['\x10binary-data\x02']: buffer };
}

// Only meaningful for the RocksDB engine; on LMDB getStructures/saveStructures fall back to the
// store's own (non-composite-key) handling, so the composite-vs-plain distinction doesn't apply.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('replay structures land where the decoder reads them (harper-pro#362)', function () {
	if (isLMDB) return;

	let primaryStore, rootStore, name, compositeKey, recordBytes, structuresBuffer;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		const ReplayStruct = table({
			table: 'ReplayStruct362',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'type' }],
		});
		primaryStore = ReplayStruct.primaryStore;
		const encoder = primaryStore.decoder;
		rootStore = encoder.rootStore;
		name = encoder.name;
		compositeKey = [STRUCTURES, name];

		// Encoding a record mints a shared structure and persists it via saveStructures (composite key).
		// We capture both the record byte sequence and the durable structures buffer, then drive each
		// persistence path below from this captured state to model a node that received the record but
		// must source the structure purely from the store (no in-memory structure carried over).
		recordBytes = Buffer.from(encoder.encode({ name: 'price', type: 'Float' }));
		const persisted = rootStore.getBinarySync(compositeKey);
		assert.ok(persisted, 'precondition: encoding a record must persist the shared structure at the composite key');
		structuresBuffer = Buffer.from(persisted);
	});

	// A reader whose ONLY source of shared structures is the store at the composite key — i.e. a cold
	// reopen / a freshly-started node, with no in-memory decoder.structure carried over. This is what
	// getStructures resolves against, so it faithfully models the decode path that broke in #362.
	function coldReader() {
		const reader = new RecordEncoder({
			structures: [],
			getStructures() {
				const buffer = rootStore.getBinarySync(compositeKey);
				return buffer ? reader.decode(buffer) : undefined;
			},
			saveStructures() {},
		});
		reader.name = name;
		reader.rootStore = rootStore;
		reader.isRocksDB = true;
		return reader;
	}

	function clearComposite() {
		rootStore.removeSync(compositeKey);
	}

	it('with NO structure persisted anywhere, a cold decode yields null (the #362 symptom)', function () {
		// A record referencing a structure this node never received throws a missing-structure error
		// ("Record id is not defined") inside msgpackr, which RecordEncoder.decode swallows to null
		// (see harper#1163 handling, covered by recordEncoder.test.js's isMissingStructureError tests).
		clearComposite();
		const reader = coldReader();
		assert.strictEqual(reader.getStructures(), undefined, 'no structure should be visible');
		assert.strictEqual(
			reader.decode(Buffer.from(recordBytes)),
			null,
			'a record with no available structure decodes to null'
		);
	});

	it('FIX: structures persisted at the composite key are visible to a cold decoder and its records decode', function () {
		clearComposite();
		// Persist exactly the way the replayLogs fix does: composite key, on rootStore, inside a
		// retry-on-busy transaction, wrapped with asBinary.
		rootStore.transactionSync(() => rootStore.putSync(compositeKey, asBinary(structuresBuffer)), { retryOnBusy: true });

		const reader = coldReader();
		assert.deepStrictEqual(
			reader.getStructures(),
			[['name', 'type']],
			'getStructures must find the replayed structure at the composite key'
		);
		assert.deepStrictEqual(
			reader.decode(Buffer.from(recordBytes)),
			{ name: 'price', type: 'Float' },
			'a record referencing the replayed structure must decode to the real object, not null'
		);
	});

	it('NEGATIVE CONTROL (the bug): structures at the OLD plain key stay invisible — cold decode is null', function () {
		// Reproduce the pre-fix behavior: write the same buffer to the plain key on primaryStore (where
		// the old replay apply wrote it) and leave the composite key empty.
		clearComposite();
		primaryStore.putSync(STRUCTURES, asBinary(structuresBuffer));

		const reader = coldReader();
		assert.strictEqual(
			reader.getStructures(),
			undefined,
			'getStructures never consults the plain key, so the structure stays invisible'
		);
		assert.strictEqual(
			reader.decode(Buffer.from(recordBytes)),
			null,
			'this is the #362 wedge: the record decodes to null until a full-copy resync rewrites the composite key'
		);
	});
});

// The replay apply now writes the authoritative composite key the decoder reads, so it must carry
// saveStructures' downgrade guard: a stale/shorter replayed structures buffer must NOT overwrite a
// longer durable one (that would drop ids and make existing records decode to null).
// structuresWouldShrink is the predicate that refuses such a write.
describe('structuresWouldShrink — refuse a downgrade of the durable structures dictionary (harper-pro#362)', function () {
	const { structuresWouldShrink } = require('#src/resources/replayLogs');

	it('classic array form: a shorter replayed buffer would shrink (refuse); equal/longer does not', function () {
		assert.strictEqual(structuresWouldShrink([['a'], ['b'], ['c']], [['a'], ['b']]), true);
		assert.strictEqual(structuresWouldShrink([['a'], ['b']], [['a'], ['b']]), false);
		assert.strictEqual(structuresWouldShrink([['a'], ['b']], [['a'], ['b'], ['c']]), false);
	});

	it('named/typed Map form: fewer named OR fewer typed would shrink', function () {
		const map = (named, typed) =>
			new Map([
				['named', new Array(named)],
				['typed', new Array(typed)],
			]);
		assert.strictEqual(structuresWouldShrink(map(3, 2), map(2, 2)), true); // fewer named
		assert.strictEqual(structuresWouldShrink(map(3, 2), map(3, 1)), true); // fewer typed
		assert.strictEqual(structuresWouldShrink(map(3, 2), map(3, 2)), false); // equal
		assert.strictEqual(structuresWouldShrink(map(3, 2), map(4, 3)), false); // grown
	});

	it('a form change is treated as a shrink (conservative: keep the durable buffer)', function () {
		const emptyMap = new Map([
			['named', []],
			['typed', []],
		]);
		assert.strictEqual(structuresWouldShrink([['a']], emptyMap), true);
		assert.strictEqual(structuresWouldShrink(emptyMap, [['a']]), true);
	});
});
