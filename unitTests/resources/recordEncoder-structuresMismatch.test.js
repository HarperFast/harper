// Regression for HarperFast/harper#1337: a record encoded against one
// sharedStructures snapshot becomes undecodable when the dictionary on disk
// is replaced with a different shape at the same struct id.
//
// In the cluster we observed records in Campaign/ CF that started with the
// metadata-prefix + bare struct-ref byte (e.g. 0x43) and depended on an
// in-memory sharedStructures dictionary to interpret the value bytes. When
// the dictionary that getStructures() returns disagrees with what was used at
// encode time, msgpackr decodes against the wrong shape and throws the exact
// production error: "Data read, but end of buffer not reached <partial>".
//
// The failure mode is silent corruption: no client-side error, no operator
// alert, no automated reconciliation. Records on disk are unreadable until
// the dictionary is restored or each record is re-encoded with inline defs.
//
// See: https://github.com/HarperFast/harper/issues/1337

require('../testUtils');
const assert = require('assert');
const { RecordEncoder } = require('#src/resources/RecordEncoder');
const { Encoder } = require('msgpackr');

// A shared, mutable "disk" for the structures buffer. Mirrors the way DBIs
// hold the sharedStructures blob under Symbol.for('structures').
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
		raw: () => buf,
		setRaw: (b) => {
			buf = b;
		},
	};
}

function makeEncoder(store) {
	return new RecordEncoder({
		structures: [],
		// false = msgpackr named-structures path (records start in 0x40-0x5f), which is
		// the path the failing production records take.
		randomAccessStructure: false,
		getStructures: store.get,
		saveStructures: store.save,
	});
}

describe('RecordEncoder sharedStructures dictionary divergence (harper#1337)', () => {
	it('records that reference a struct id become undecodable when the dictionary at that id is replaced', () => {
		// Writer A encodes a record with one shape, persists its structures.
		const storeA = sharedStore();
		const writerA = makeEncoder(storeA);
		const recordA = { runId: 'r-1', vu: 'v-1', iter: 'paused' };
		const bytesA = Buffer.from(writerA.encode(recordA));

		// Sanity: writer A actually persisted some structures, and its record bytes
		// land in the named-struct ref range (0x40-0x5f) so they depend on the dictionary.
		assert.ok(storeA.get()?.length > 0, 'writer A should have persisted structures');
		assert.ok(
			bytesA[0] >= 0x40 && bytesA[0] < 0x60,
			`expected named-struct ref byte 0x40-0x5f, got 0x${bytesA[0].toString(16)}`
		);

		// Writer B encodes a different shape against a fresh store (simulating a
		// concurrent encoder instance that started before seeing writer A's save,
		// or a post-restart fresh thread). Writer B's structure mints at id 0
		// with a different shape than writer A's id 0.
		const storeB = sharedStore();
		const writerB = makeEncoder(storeB);
		const recordB = { alpha: 1, beta: 2 };
		writerB.encode(recordB);

		// The "disk" then ends up holding writer B's structures (the cluster
		// observation: post-rollout, the on-disk dictionary disagrees with what
		// some records on disk were written against).
		const reader = makeEncoder({
			save: () => true,
			get: storeB.get,
			raw: storeB.raw,
			setRaw: storeB.setRaw,
		});

		// Decoding writer A's record against writer B's dictionary should fail.
		// The decoder reads the bytes as if they were the wrong shape, fills in
		// the wrong field names, then chokes on the extra bytes.
		let result;
		let caught;
		try {
			result = reader.decode(bytesA);
		} catch (e) {
			caught = e;
		}

		// RecordEncoder.decode is non-fatal: it returns null and logs the error
		// internally (see RecordEncoder.ts:432). The on-disk record is dropped from
		// query results — silent data loss, which is exactly the production symptom.
		assert.ok(
			caught != null || result === null,
			`expected decode to fail (return null or throw); got ${JSON.stringify(result)}`
		);
	});

	it('a fresh decoder finds the inline-defining record to repopulate its dictionary on iterator read', () => {
		// Counter-case: a record that carries its own inline struct definition
		// (the d4 72 form) decodes regardless of what's on disk, because it
		// teaches the decoder its own shape inline. This is why the working
		// records in production decode fine — they were emitted before the
		// dictionary diverged and the encoder hadn't yet switched to ref-only.
		const store = sharedStore();
		const writer = makeEncoder(store);
		const record = { runId: 'r-1', vu: 'v-1', iter: 'active' };
		const bytes = Buffer.from(writer.encode(record));

		// A reader that knows about the structures decodes fine.
		const reader = makeEncoder(store);
		const decoded = reader.decode(bytes);
		assert.ok(decoded, 'record should decode when the structure is available');
		assert.strictEqual(decoded.runId, record.runId);
		assert.strictEqual(decoded.vu, record.vu);
		assert.strictEqual(decoded.iter, record.iter);
	});

	it('strict-extension CAS rejects a save that would replace an existing structure at the same index', () => {
		// Direct check of the fix: saveStructures must reject any incoming
		// structures array that differs from existing on an index that already
		// has content. msgpackr's pack() loop sees the false return and re-packs
		// the record at the next free id, so the on-disk record always references
		// a structure that's actually persisted under that id.
		//
		// This test uses Harper's saveStructures hook directly (the production
		// surface for RocksDB-backed stores) rather than racing two encoders,
		// so it stays deterministic and fast.

		let buf;
		const meta = new Encoder();
		// A minimal RocksDB-ish rootStore that backs the save into a single buffer
		// via transactionSync (synchronous, no real DB needed for the CAS logic).
		const rootStore = {
			transactionSync(fn) {
				return fn({
					getBinarySync: () => buf,
					putSync: (_key, value) => {
						buf = meta.encode(value);
					},
				});
			},
		};

		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: false,
			getStructures: () => (buf ? meta.decode(buf) : undefined),
			saveStructures: () => true, // overridden via rootStore wiring below
		});
		// Wire up the RocksDB code path: isRocksDB=true, rootStore set,
		// and the saveStructures override that lives in the constructor uses these.
		enc.isRocksDB = true;
		enc.rootStore = rootStore;

		// Writer A's first save: nothing on disk, accept.
		const structuresA = [['runId', 'vu', 'iter']];
		const okA = enc.saveStructures(structuresA, 0);
		assert.strictEqual(okA, true, 'first save should be accepted (disk empty)');
		assert.deepStrictEqual(meta.decode(buf), structuresA, 'disk should hold writer A structures');

		// Writer B comes along with a DIFFERENT shape at the same index 0.
		// Length matches (both 1), so msgpackr's length-only check would accept this
		// and silently corrupt anything writer A's records reference. The fix must
		// reject it.
		const structuresB = [['alpha', 'beta', 'gamma']];
		const okB = enc.saveStructures(structuresB, 1);
		assert.strictEqual(
			okB,
			false,
			'save that would replace existing structure at index 0 with a different shape must be rejected'
		);
		assert.deepStrictEqual(meta.decode(buf), structuresA, 'disk should still hold writer A structures');

		// A save that strictly EXTENDS the existing dictionary is accepted.
		const structuresExtended = [['runId', 'vu', 'iter'], ['alpha', 'beta', 'gamma']];
		const okExt = enc.saveStructures(structuresExtended, 1);
		assert.strictEqual(okExt, true, 'save that extends existing structures should be accepted');
		assert.deepStrictEqual(meta.decode(buf), structuresExtended, 'disk should now hold extended structures');
	});

	it('strict-extension CAS catches replacement at a non-zero index', () => {
		// The check loops over every existing entry, not just index 0. Catch a
		// regression in the loop bounds where a later writer replaces a middle
		// entry while preserving entries 0..i-1 and i+1..N.
		let buf;
		const meta = new Encoder();
		const rootStore = {
			transactionSync(fn) {
				return fn({
					getBinarySync: () => buf,
					putSync: (_key, value) => {
						buf = meta.encode(value);
					},
				});
			},
		};
		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: false,
			getStructures: () => (buf ? meta.decode(buf) : undefined),
			saveStructures: () => true,
		});
		enc.isRocksDB = true;
		enc.rootStore = rootStore;

		const original = [['a'], ['b'], ['c']];
		assert.strictEqual(enc.saveStructures(original, 0), true);

		// Same length, same entries at index 0 and 2, DIFFERENT entry at index 1.
		const mutated = [['a'], ['X'], ['c']];
		assert.strictEqual(
			enc.saveStructures(mutated, 3),
			false,
			'replacement at index 1 (mid-array) must be rejected even when length matches'
		);
		assert.deepStrictEqual(meta.decode(buf), original, 'disk should still hold the original structures');
	});

	it('strict-extension CAS accepts a strict suffix extension', () => {
		// Belt-and-braces: an off-by-one in the comparison loop could reject
		// legitimate extensions and break normal write throughput. Verify the
		// happy path explicitly.
		let buf;
		const meta = new Encoder();
		const rootStore = {
			transactionSync(fn) {
				return fn({
					getBinarySync: () => buf,
					putSync: (_key, value) => {
						buf = meta.encode(value);
					},
				});
			},
		};
		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: false,
			getStructures: () => (buf ? meta.decode(buf) : undefined),
			saveStructures: () => true,
		});
		enc.isRocksDB = true;
		enc.rootStore = rootStore;

		// Establish a 3-entry baseline on disk.
		assert.strictEqual(enc.saveStructures([['a'], ['b'], ['c']], 0), true);

		// Append two entries — same prefix [a, b, c], plus [d] and [e].
		const extended = [['a'], ['b'], ['c'], ['d'], ['e']];
		assert.strictEqual(
			enc.saveStructures(extended, 3),
			true,
			'strict extension (existing prefix preserved, new entries appended) must be accepted'
		);
		assert.deepStrictEqual(meta.decode(buf), extended);
	});

	it('strict-extension CAS rejects a type mismatch at an existing index', () => {
		// If an existing entry is an array (the expected shape for a structure
		// definition) but a new save puts a non-array at the same index, that's
		// a corruption attempt; reject. The current implementation falls into
		// the `!Array.isArray(...)` guard rather than throwing.
		let buf;
		const meta = new Encoder();
		const rootStore = {
			transactionSync(fn) {
				return fn({
					getBinarySync: () => buf,
					putSync: (_key, value) => {
						buf = meta.encode(value);
					},
				});
			},
		};
		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: false,
			getStructures: () => (buf ? meta.decode(buf) : undefined),
			saveStructures: () => true,
		});
		enc.isRocksDB = true;
		enc.rootStore = rootStore;

		assert.strictEqual(enc.saveStructures([['a', 'b']], 0), true);
		// Same length, but the new entry at index 0 is a string instead of an array.
		const mutated = ['notAnArray'];
		assert.strictEqual(
			enc.saveStructures(mutated, 1),
			false,
			'type-mismatch save (array → non-array at same index) must be rejected'
		);
	});

	// Note on end-to-end coverage: validating that msgpackr's pack() re-pack
	// loop fires correctly on our `false` return and produces records that
	// decode against the new disk state needs a real RocksDB-backed encoder
	// (the decode path uses rootStore.getBinarySync to resolve blob
	// references, which a mock doesn't satisfy without basically rebuilding
	// the store). That validation lives in harper-pro's
	// `integrationTests/cluster/multiShapeReplicationConvergence.test.mjs`
	// where two-node mesh + 4-thread writers + varying optional-field
	// combinations exercise the full encode→save→CAS→re-pack→decode loop
	// with the actual storage layer. The four CAS tests above are the
	// per-condition slices of that flow.
});
