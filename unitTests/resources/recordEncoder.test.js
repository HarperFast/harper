require('../testUtils');
const assert = require('assert');
const { RecordEncoder, IndexRecordEncoder } = require('#src/resources/RecordEncoder');
const env = require('#js/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

// In-memory shared structures (mirrors how a DBI shares the structures array under
// Symbol.for('structures')) so struct/record structures cross between encoder instances. We keep the
// live array reference rather than round-tripping through encode/decode, since msgpackr attaches
// bookkeeping to the structures array that a re-decode would strip.
function sharedStore() {
	let structures = [];
	return {
		save(s) {
			structures = s;
			return true;
		},
		get() {
			return structures;
		},
	};
}

function makeEncoder(store, extra) {
	return new RecordEncoder({
		// randomAccessStructure stays on regardless of the opt-out — reads must keep decoding typed
		// structs so existing data is still readable; only writes change.
		randomAccessStructure: true,
		getStructures: store.get,
		saveStructures: store.save,
		...extra,
	});
}

const record = { name: 'price', type: 'Float', indexed: true };

describe('RecordEncoder random-access fields opt-out (readOnlyStructures)', () => {
	it('writes typed random-access structs by default (random-access fields on)', () => {
		const store = sharedStore();
		const enc = makeEncoder(store);
		const bytes = enc.encode(record);
		assert.ok(bytes[0] >= 0x20 && bytes[0] < 0x40, `expected typed-struct header byte, got 0x${bytes[0].toString(16)}`);
	});

	it('writes classic shared structures when readOnlyStructures is set (opt-out)', () => {
		const store = sharedStore();
		const enc = makeEncoder(store, { readOnlyStructures: true });
		const bytes = enc.encode(record);
		assert.ok(
			bytes[0] >= 0x40 && bytes[0] < 0x80,
			`expected classic shared-structure byte, got 0x${bytes[0].toString(16)}`
		);
	});

	it('opt-out encoder still reads typed-struct data written before opting out', () => {
		// Existing data was written as typed structs; after the user opts out the same store must keep
		// decoding it (randomAccessStructure stays on), only new writes switch to classic.
		const store = sharedStore();
		const typedWriter = makeEncoder(store);
		const typedBytes = typedWriter.encode(record);
		assert.ok(typedBytes[0] >= 0x20 && typedBytes[0] < 0x40, 'precondition: typed-struct bytes');

		const optedOutReader = makeEncoder(store, { readOnlyStructures: true });
		const decoded = optedOutReader.decode(Buffer.from(typedBytes));
		assert.ok(decoded, 'typed-struct data should still decode (not swallowed to null)');
		assert.strictEqual(decoded.name, record.name);
		assert.strictEqual(decoded.type, record.type);
		assert.strictEqual(decoded.indexed, record.indexed);
	});

	it('classic records and typed structs round-trip together on the same store', () => {
		const store = sharedStore();
		const typedWriter = makeEncoder(store);
		const classicWriter = makeEncoder(store, { readOnlyStructures: true });
		const reader = makeEncoder(store);

		const a = { id: 1, kind: 'typed' };
		const b = { id: 2, kind: 'classic', extra: true };
		const typedBytes = typedWriter.encode(a);
		const classicBytes = classicWriter.encode(b);
		assert.ok(typedBytes[0] >= 0x20 && typedBytes[0] < 0x40, 'precondition: typed bytes');
		assert.ok(classicBytes[0] >= 0x40 && classicBytes[0] < 0x80, 'precondition: classic bytes');

		// Typed structs decode with the RecordObject prototype, classic records as plain objects; spread
		// to compare field values regardless of prototype.
		assert.deepStrictEqual({ ...reader.decode(Buffer.from(typedBytes)) }, a);
		assert.deepStrictEqual({ ...reader.decode(Buffer.from(classicBytes)) }, b);
	});

	it('IndexRecordEncoder keeps writing typed structs even with readOnlyStructures requested', () => {
		// Object-store indexes (HNSW) must stay in struct mode regardless of the table opt-out.
		const store = sharedStore();
		const enc = new IndexRecordEncoder({
			randomAccessStructure: true,
			readOnlyStructures: true,
			getStructures: store.get,
			saveStructures: store.save,
		});
		const bytes = enc.encode(record);
		assert.ok(
			bytes[0] >= 0x20 && bytes[0] < 0x40,
			`index encoder should ignore readOnlyStructures and write typed structs, got 0x${bytes[0].toString(16)}`
		);
	});

	it('decodes a classic record whose structure-id byte is 66 (0x42) when noMetadata is set', () => {
		// Regression: 66 (0x42) is classic shared-structure record-id #2 and also a rocksdb local-timestamp
		// marker. On a rocksdb store the prefix heuristic strips 8 bytes and corrupts the record, decoding
		// to null (the MQTT "publish non-JSON" failure). The audit store passes { noMetadata: true } to skip
		// the heuristic for values that have no on-disk timestamp prefix.
		const store = sharedStore();
		const writer = makeEncoder(store, { readOnlyStructures: true });
		// The 3rd distinct classic structure starts with byte 0x42; encode three shapes to reach it.
		writer.encode({ a: 1 });
		writer.encode({ b: 2, c: 3 });
		const target = { d: 4, e: 5, f: 6 };
		const bytes = Buffer.from(writer.encode(target));
		assert.strictEqual(bytes[0], 66, 'precondition: target record begins with structure-id byte 66 (0x42)');

		const reader = makeEncoder(store);
		// Warm up the structure cache with a normal (non-rocksdb) decode so getStructures isn't needed
		// once we flip isRocksDB below (the rocksdb getStructures path needs a rootStore we don't mock).
		assert.deepStrictEqual(reader.decode(bytes), target, 'baseline classic decode works');

		// Simulate the rocksdb decode path, where byte 66 collides with the local-timestamp marker.
		reader.isRocksDB = true;
		assert.deepStrictEqual(
			reader.decode(bytes, { noMetadata: true }),
			target,
			'with noMetadata the classic record still decodes correctly'
		);
		// Without noMetadata the rocksdb timestamp heuristic misreads byte 66 and corrupts the decode.
		assert.notDeepStrictEqual(
			reader.decode(bytes),
			target,
			'without noMetadata the 0x42 collision corrupts the decode (demonstrating why the flag is needed)'
		);
	});

	describe('storage.randomAccessFields config drives the default', () => {
		let previous;
		beforeEach(() => {
			previous = env.get(terms.CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS);
		});
		afterEach(() => {
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, previous);
		});

		it('writes classic structures when storage.randomAccessFields is false (no explicit option)', () => {
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, false);
			const enc = makeEncoder(sharedStore()); // no explicit readOnlyStructures
			const bytes = enc.encode(record);
			assert.ok(
				bytes[0] >= 0x40 && bytes[0] < 0x80,
				`config off should write classic structures, got 0x${bytes[0].toString(16)}`
			);
		});

		it('writes typed structs when storage.randomAccessFields is true', () => {
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, true);
			const enc = makeEncoder(sharedStore());
			const bytes = enc.encode(record);
			assert.ok(
				bytes[0] >= 0x20 && bytes[0] < 0x40,
				`config on should write typed structs, got 0x${bytes[0].toString(16)}`
			);
		});

		it('an explicit readOnlyStructures option overrides the config', () => {
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, false);
			const enc = makeEncoder(sharedStore(), { readOnlyStructures: false });
			const bytes = enc.encode(record);
			assert.ok(
				bytes[0] >= 0x20 && bytes[0] < 0x40,
				`explicit readOnlyStructures:false should keep typed structs despite config, got 0x${bytes[0].toString(16)}`
			);
		});
	});
});

describe('RecordEncoder structure dictionary cap (no two-byte over-cap corruption)', () => {
	// Regression: harper's default maxOwnStructures must keep msgpackr on the one-byte record path
	// (maxOwnStructures + the default maxSharedStructures of 32 must stay <= 64). A larger value (the
	// prior 256) flips on the two-byte path, which mis-serializes over-cap "own" structures when a
	// shared-structures store is present — records written after a table exceeds the shared cap become
	// undecodable ("Record id is not defined for N"), on both the typed default and the
	// randomAccessFields=false opt-out. These write far more distinct shapes than the shared cap through
	// a shared store and assert every record still decodes.
	function diverseRecords(count) {
		const records = [];
		for (let i = 0; i < count; i++) {
			const rec = { id: i };
			const attrCount = 1 + (i % 6);
			for (let a = 0; a < attrCount; a++) rec['attr_' + ((i * 7 + a) % 200)] = i % 2 ? 's' + i : i;
			records.push(rec);
		}
		return records;
	}

	function assertAllDecode(extra) {
		const store = sharedStore();
		const writer = makeEncoder(store, extra);
		const reader = makeEncoder(store, extra);
		const records = diverseRecords(500); // far exceeds the 32 shared-structure cap
		const buffers = records.map((r) => Buffer.from(writer.encode(r)));
		let failures = 0;
		for (let i = 0; i < buffers.length; i++) {
			const decoded = reader.decode(buffers[i]);
			if (!decoded || decoded.id !== records[i].id) failures++;
		}
		assert.strictEqual(failures, 0, `all ${records.length} records should decode after exceeding the shared cap`);
	}

	it('decodes every record past the shared cap on the typed path (default)', () => {
		assertAllDecode(undefined);
	});

	it('decodes every record past the shared cap with randomAccessFields off (readOnlyStructures)', () => {
		assertAllDecode({ readOnlyStructures: true });
	});
});
