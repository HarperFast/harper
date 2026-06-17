require('../testUtils');
const assert = require('assert');
const { RecordEncoder } = require('#src/resources/RecordEncoder');
const { Encoder } = require('msgpackr');

// Shared structures persisted as an encoded buffer (mirrors how a DBI stores them under
// Symbol.for('structures')), so struct/record structures cross between encoder instances.
function sharedStore() {
	let buf;
	const meta = new Encoder();
	return {
		save(s) {
			buf = meta.encode(s);
			return true;
		},
		get() {
			return buf ? meta.decode(buf) : undefined;
		},
	};
}

function makeEncoder(store) {
	return new RecordEncoder({
		structures: [],
		// false = msgpackr named-structures path (records start in 0x40-0x5f), which is the path
		// the failing production records take.
		randomAccessStructure: false,
		getStructures: store.get,
		saveStructures: store.save,
	});
}

// Minimal RocksDB-ish rootStore for the saveStructures CAS path. The wrapped buffer holds the
// encoded structures blob; CAS reads it before each save and writes through txn.putSync on commit.
function rocksRoot() {
	let buf;
	const meta = new Encoder();
	return {
		store: {
			transactionSync(fn) {
				return fn({
					getBinarySync: () => buf,
					putSync: (_key, value) => {
						buf = meta.encode(value);
					},
				});
			},
			getBinarySync: () => undefined,
		},
		get: () => (buf ? meta.decode(buf) : undefined),
	};
}

function makeRocksEncoder(root) {
	const enc = new RecordEncoder({
		structures: [],
		randomAccessStructure: false,
		getStructures: root.get,
		saveStructures: () => true,
	});
	enc.isRocksDB = true;
	enc.rootStore = root.store;
	return enc;
}

describe('RecordEncoder sharedStructures dictionary divergence (harper#1337)', () => {
	it('records that reference a struct id become undecodable when the dictionary at that id is replaced', () => {
		// Writer A persists its shape; writer B (separate store) persists a different shape at the same
		// id; the reader loads writer B's store. Writer A's record now references the wrong shape on
		// decode, exactly mirroring the cluster-side failure where the on-disk dictionary diverges from
		// what some records were written against.
		const storeA = sharedStore();
		const bytesA = Buffer.from(makeEncoder(storeA).encode({ runId: 'r-1', vu: 'v-1', iter: 'paused' }));
		assert.ok(
			bytesA[0] >= 0x40 && bytesA[0] < 0x60,
			`expected named-struct ref byte 0x40-0x5f, got 0x${bytesA[0].toString(16)}`
		);

		const storeB = sharedStore();
		makeEncoder(storeB).encode({ alpha: 1, beta: 2 });

		const reader = makeEncoder({ save: () => true, get: storeB.get });
		let result, caught;
		try {
			result = reader.decode(bytesA);
		} catch (e) {
			caught = e;
		}
		// RecordEncoder.decode is non-fatal: it returns null and logs internally. The on-disk record
		// silently drops out of query results, which is the production symptom.
		assert.ok(caught != null || result === null, `expected decode to fail; got ${JSON.stringify(result)}`);
	});

	it('decodes fine when writer and reader share the same store', () => {
		const store = sharedStore();
		const record = { runId: 'r-1', vu: 'v-1', iter: 'active' };
		const bytes = Buffer.from(makeEncoder(store).encode(record));
		const decoded = makeEncoder(store).decode(bytes);
		assert.ok(decoded);
		assert.strictEqual(decoded.runId, record.runId);
		assert.strictEqual(decoded.vu, record.vu);
		assert.strictEqual(decoded.iter, record.iter);
	});

	it('strict-extension CAS rejects a save that replaces an existing structure at the same index', () => {
		// Length matches but the entry at index 0 differs. msgpackr's default length-only check would
		// accept this and silently corrupt anything writer A's records reference; the fix must reject.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);

		assert.strictEqual(enc.saveStructures([['runId', 'vu', 'iter']], 0), true);
		assert.strictEqual(enc.saveStructures([['alpha', 'beta', 'gamma']], 1), false);
		assert.deepStrictEqual(root.get(), [['runId', 'vu', 'iter']], 'disk should still hold writer A structures');

		// Strict extension is accepted; the prefix matches and a new entry is appended.
		assert.strictEqual(
			enc.saveStructures(
				[
					['runId', 'vu', 'iter'],
					['alpha', 'beta', 'gamma'],
				],
				1
			),
			true
		);
	});

	it('strict-extension CAS catches replacement at a non-zero index', () => {
		// Guard against a regression in the comparison-loop bounds: a later writer replaces a middle
		// entry while preserving entries 0..i-1 and i+1..N.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		assert.strictEqual(enc.saveStructures([['a'], ['b'], ['c']], 0), true);
		assert.strictEqual(enc.saveStructures([['a'], ['X'], ['c']], 3), false);
		assert.deepStrictEqual(root.get(), [['a'], ['b'], ['c']]);
	});

	it('strict-extension CAS accepts a strict suffix extension', () => {
		// Belt-and-braces happy path: an off-by-one in the loop could silently reject legitimate
		// extensions and break normal write throughput.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		assert.strictEqual(enc.saveStructures([['a'], ['b'], ['c']], 0), true);
		const extended = [['a'], ['b'], ['c'], ['d'], ['e']];
		assert.strictEqual(enc.saveStructures(extended, 3), true);
		assert.deepStrictEqual(root.get(), extended);
	});

	it('strict-extension CAS rejects a type mismatch at an existing index', () => {
		// existing entry is an array, new save puts a non-array at the same index. The !Array.isArray()
		// guard catches it rather than throwing.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		assert.strictEqual(enc.saveStructures([['a', 'b']], 0), true);
		assert.strictEqual(enc.saveStructures(['notAnArray'], 1), false);
	});

	it('strict-extension CAS accepts Array→Map upgrade when named entries match', () => {
		// structon switches the persisted format from plain Array (named-only) to a Map with
		// 'named'/'typed' keys the moment the first typedStruct is minted. A naive index-into-existing
		// loop would treat the Map's missing numeric properties as a deletion and falsely reject the
		// receiver-side save, which is exactly the regression that left during-window markers stuck on
		// the patched cluster.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		assert.strictEqual(enc.saveStructures([['runId', 'vu']], 0), true);
		const upgraded = new Map();
		upgraded.set('named', [['runId', 'vu']]);
		upgraded.set('typed', [[['Long', 4, 'a']]]);
		assert.strictEqual(enc.saveStructures(upgraded, 1), true);
		const persisted = root.get();
		assert.deepStrictEqual(persisted.get('named'), [['runId', 'vu']]);
		assert.deepStrictEqual(persisted.get('typed'), [[['Long', 4, 'a']]]);
	});

	it('strict-extension CAS rejects a Map upgrade that mutates an existing named entry', () => {
		// Array→Map is fine when the named prefix matches; it must still reject when named[0]
		// disagrees, because that is the silent-corruption case dressed up in the upgrade format.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		assert.strictEqual(enc.saveStructures([['runId', 'vu']], 0), true);
		const conflicting = new Map();
		conflicting.set('named', [['alpha', 'beta']]);
		conflicting.set('typed', [[['Long', 4, 'a']]]);
		assert.strictEqual(enc.saveStructures(conflicting, 1), false);
		assert.deepStrictEqual(root.get(), [['runId', 'vu']]);
	});

	it('strict-extension CAS accepts an append to typed structures in Map form', () => {
		// Two saves in Map form where the second extends typed by one entry; identical [type,size,key]
		// triples come from different array literals so a reference-equality element check would
		// falsely reject. Recursive shape compare handles the nested form. structon attaches a function
		// isCompatible when saving Map form (the numeric fallback assumes Array shape), so the test
		// mirrors that real-world call shape.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		const first = new Map();
		first.set('named', [['runId']]);
		first.set('typed', [[['Long', 4, 'a']]]);
		assert.strictEqual(
			enc.saveStructures(first, () => true),
			true
		);
		const second = new Map();
		second.set('named', [['runId']]);
		second.set('typed', [[['Long', 4, 'a']], [['Long', 4, 'b']]]);
		assert.strictEqual(
			enc.saveStructures(second, () => true),
			true
		);
	});

	it('strict-extension CAS rejects a typed-structure replacement at an existing id', () => {
		// Concurrent writers both mint a typed struct at the same nextId; one must lose so the loser's
		// records get re-packed against the persisted shape.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		const first = new Map();
		first.set('named', []);
		first.set('typed', [[['Long', 4, 'a']]]);
		assert.strictEqual(
			enc.saveStructures(first, () => true),
			true
		);
		const conflicting = new Map();
		conflicting.set('named', []);
		conflicting.set('typed', [[['Long', 4, 'b']]]);
		assert.strictEqual(
			enc.saveStructures(conflicting, () => true),
			false
		);
	});

	it('strict-extension CAS handles plain-object form (Map round-tripped via mapsAsObjects)', () => {
		// msgpackr decodes Maps as plain objects under mapsAsObjects:true. RecordEncoder uses Map-form
		// natively, but defensive normalization keeps the check correct even if the persisted form
		// comes back as {named, typed}.
		const root = rocksRoot();
		const enc = makeRocksEncoder(root);
		const first = new Map();
		first.set('named', [['runId']]);
		first.set('typed', [[['Long', 4, 'a']]]);
		assert.strictEqual(
			enc.saveStructures(first, () => true),
			true
		);
		// Replace the persisted Map with the plain-object form to simulate a mapsAsObjects round-trip.
		root.store.transactionSync((txn) =>
			txn.putSync([Symbol.for('structures'), enc.name], { named: [['runId']], typed: [[['Long', 4, 'a']]] })
		);
		const extended = new Map();
		extended.set('named', [['runId']]);
		extended.set('typed', [[['Long', 4, 'a']], [['Long', 4, 'b']]]);
		assert.strictEqual(
			enc.saveStructures(extended, () => true),
			true
		);
	});

	// End-to-end retry-flow coverage (encode → save → CAS reject → msgpackr re-pack → decode against
	// the new disk state) lives in harper-pro's integrationTests/cluster/multiShapeReplicationConvergence.test.mjs,
	// which exercises a real RocksDB-backed encoder with 4-thread writers and varying optional-field
	// combinations. Mocking the rootStore well enough to satisfy both the save path and the
	// blob-resolving decode path basically rebuilds the storage layer.
});
