require('../testUtils');
const assert = require('assert');
const { RecordEncoder, isMissingStructureError } = require('#src/resources/RecordEncoder');
const harperLogger = require('#src/utility/logging/harper_logger');
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

function makeEncoder(randomAccessStructure, store) {
	return new RecordEncoder({
		structures: [],
		randomAccessStructure,
		getStructures: store.get,
		saveStructures: store.save,
	});
}

const record = { name: 'price', type: 'Float', indexed: true };

describe('RecordEncoder struct-mode gating', () => {
	it('non-primary (randomAccessStructure off) writes records mode and bails the struct write hook', () => {
		const store = sharedStore();
		const enc = makeEncoder(false, store);
		assert.strictEqual(typeof enc._writeStruct, 'function', 'struct write hook should remain a function');
		assert.strictEqual(enc._writeStruct(), 0, 'struct write hook should bail (return 0) so objects use records mode');
		const bytes = enc.encode(record);
		assert.ok(bytes[0] < 0x20 || bytes[0] >= 0x40, `expected records-mode byte, got 0x${bytes[0].toString(16)}`);
		assert.ok(Array.isArray(store.get()), 'structures should be saved as a plain array (struct-unaware readable)');
	});

	it('primary (randomAccessStructure on) writes struct mode', () => {
		const store = sharedStore();
		const enc = makeEncoder(true, store);
		assert.notStrictEqual(enc._writeStruct, undefined, 'struct write hook should be set for primary DBIs');
		const bytes = enc.encode(record);
		assert.ok(bytes[0] >= 0x20 && bytes[0] < 0x40, `expected struct header byte, got 0x${bytes[0].toString(16)}`);
	});

	it('records-mode output decodes on a struct-unaware msgpackr decoder (downgrade-safe)', () => {
		const store = sharedStore();
		const enc = makeEncoder(false, store);
		const bytes = enc.encode(record);
		const plain = new Encoder({ useRecords: true, structures: store.get() || [] });
		assert.deepStrictEqual(plain.decode(Buffer.from(bytes)), record);
	});

	it('non-primary encoder round-trips top-level scalar integers in the struct-header range (0x20-0x3f)', () => {
		// Regression: clearing the struct write hook would emit bare fixints for ints 32-63,
		// which the retained struct read hook misreads as struct headers (e.g. NEXT_TABLE_ID
		// in __dbis__). Bailing the write hook keeps these as uint8 so they round-trip.
		const store = sharedStore();
		const enc = makeEncoder(false, store);
		for (const v of [31, 32, 50, 63, 64, 100]) {
			assert.strictEqual(enc.decode(Buffer.from(enc.encode(v))), v, `scalar ${v} should round-trip`);
		}
	});

	it('non-primary encoder still reads struct data written by a primary encoder', () => {
		const store = sharedStore();
		const writer = makeEncoder(true, store); // simulate an existing v5 that wrote struct mode
		const structBytes = writer.encode(record);
		assert.ok(structBytes[0] >= 0x20 && structBytes[0] < 0x40, 'precondition: struct bytes');

		const reader = makeEncoder(false, store);
		assert.notStrictEqual(reader._readStruct, undefined, 'struct read hook must be retained');
		const decoded = reader.decode(Buffer.from(structBytes));
		assert.ok(decoded, 'struct data should still decode (not swallowed to null)');
		assert.strictEqual(decoded.name, record.name);
		assert.strictEqual(decoded.type, record.type);
		assert.strictEqual(decoded.indexed, record.indexed);
	});
});

describe('RecordEncoder missing-structure handling (harper#1163)', () => {
	let warnings, errors, restoreWarn, restoreError;
	beforeEach(() => {
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
	});

	it('returns null (non-fatal) and warns distinctly when a typed structure is absent on this node', () => {
		// A record references a typed (random-access) structure that this node's structures buffer does
		// not contain. structon's readStruct reloads from the (still-empty) store and then throws;
		// RecordEncoder must keep internal reads non-fatal (return null) while surfacing the dropped
		// record distinctly rather than via the generic error path.
		const writer = makeEncoder(true, sharedStore());
		const bytes = Buffer.from(writer.encode(record));

		// Reader on a different node that never received the structure-buffer update.
		const reader = makeEncoder(true, sharedStore());
		assert.strictEqual(reader.decode(bytes), null, 'missing structure should decode to null, not throw');
		assert.strictEqual(warnings.length, 1, 'should emit exactly one distinct warning');
		assert.match(warnings[0][0], /shared structure missing/);
		assert.strictEqual(errors.length, 0, 'should not use the generic error path for a missing structure');
	});

	it('recovers (decodes, no throw) once the typed structure is present on this node', () => {
		// Writer and reader share the same structures store, so the reader's on-miss reload finds it.
		const store = sharedStore();
		const writer = makeEncoder(true, store);
		const bytes = Buffer.from(writer.encode(record));
		const reader = makeEncoder(true, store);
		const decoded = reader.decode(bytes);
		assert.ok(decoded, 'record should decode when the structure is available');
		assert.strictEqual(decoded.name, record.name);
	});

	it('detects both typed and classic missing-structure errors, and only those', () => {
		// classic-structure miss (msgpackr createSecondByteReader) is the relevant variant on 5.1 where
		// typed structs are off by default; we cannot easily manufacture a real classic shared-structure
		// miss in this harness, so assert the detection contract directly against the dependency's
		// terminal error messages.
		assert.ok(isMissingStructureError(new Error('Could not find typed structure 1')));
		assert.ok(isMissingStructureError(new Error('Record id is not defined for 42')));
		assert.ok(!isMissingStructureError(new Error('Data read, but end of buffer not reached 64')));
		assert.ok(!isMissingStructureError(new RangeError('Offset is outside the bounds of the DataView')));
		assert.ok(!isMissingStructureError(undefined));
	});

	it('still returns null (tolerant) for a decode failure that is not a missing structure', () => {
		// Truncate a valid struct-mode record mid-body: the structure IS present, but the buffer is too
		// short, so decoding throws a non-missing-structure error (e.g. out-of-bounds). That genuine
		// corruption keeps the existing log-and-null behavior.
		const store = sharedStore();
		const enc = makeEncoder(true, store);
		const bytes = Buffer.from(enc.encode(record));
		const truncated = bytes.subarray(0, 2);
		assert.strictEqual(enc.decode(truncated), null, 'corrupt (non-structure) decode should still return null');
		assert.strictEqual(errors.length, 1, 'genuine corruption should use the generic error path');
		assert.strictEqual(warnings.length, 0, 'genuine corruption should not use the missing-structure warning');
	});
});

describe('RecordEncoder typed-struct CAS regression', () => {
	function mockRocksRootStore() {
		let buffer;
		const meta = new Encoder({ useBigIntExtension: true });
		return {
			transactionSync(cb) {
				const txn = {
					getBinarySync() {
						return buffer;
					},
					putSync(_key, val) {
						buffer = meta.encode(val);
					},
				};
				return cb(txn);
			},
			_readDecoded() {
				return buffer ? meta.decode(buffer) : undefined;
			},
		};
	}

	function makeRocksEncoder(rootStore) {
		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: true,
			getStructures: () => undefined,
			saveStructures: () => true,
		});
		enc.isRocksDB = true;
		enc.rootStore = rootStore;
		enc.name = 'TestTable';
		return enc;
	}

	function makeStructures(typedEntries, lastTypedLen) {
		const m = new Map();
		m.set('named', []);
		m.set('typed', typedEntries);
		m.isCompatible = (existing) => {
			if (!existing) return lastTypedLen === 0;
			const t = existing instanceof Map ? existing.get('typed') || [] : existing?.typed || [];
			return t.length === lastTypedLen;
		};
		return m;
	}

	it('rejects a conflicting typed-only save when isCompatible is on structures, not the parameter', () => {
		// structon's _saveTypedStructures (node_modules/structon/index.js:165) calls
		// this.saveStructures(structures) without forwarding the second arg, but the structures
		// object that prepareStructures returned has .isCompatible attached. Harper's saveStructures
		// override must consult that attached function, otherwise its else-branch CAS check is
		// `existingStructures.length !== undefined` which is `Map.length(undefined) !== undefined` =
		// false, and a same-length-but-different-content typed-struct save silently clobbers the
		// previous one. Records the first writer encoded against now reference a struct whose schema
		// has been replaced, surfacing as "Data read, but end of buffer not reached" /
		// "Unexpected end of MessagePack data" at decode (HarperFast/harper#1441).
		const rootStore = mockRocksRootStore();
		const enc = makeRocksEncoder(rootStore);

		const firstStructures = makeStructures([[[3, 0, 'id']]], 0);
		assert.strictEqual(enc.saveStructures(firstStructures), true, 'initial save should succeed');

		// A different encoder (or thread) mints a different typed struct at the same lastTypedLen=0.
		const conflicting = makeStructures([[[3, 0, 'differentField']]], 0);
		const result = enc.saveStructures(conflicting);
		assert.strictEqual(
			result,
			false,
			'conflicting same-length typed-only save must be CAS-rejected; got true → silent clobber'
		);

		const persisted = rootStore._readDecoded();
		const typed = persisted instanceof Map ? persisted.get('typed') : persisted?.typed;
		assert.strictEqual(typed[0][0][2], 'id', 'persisted typed struct must still be the first writer’s');
	});

	it('continues to honor the explicit-parameter form (msgpackr.pack pathway)', () => {
		// Guards against the fix breaking msgpackr's call site (node_modules/msgpackr/pack.js:190),
		// which DOES pass structures.isCompatible as the second argument.
		const rootStore = mockRocksRootStore();
		const enc = makeRocksEncoder(rootStore);

		const first = makeStructures([[[3, 0, 'id']]], 0);
		assert.strictEqual(enc.saveStructures(first, first.isCompatible), true);

		const conflicting = makeStructures([[[3, 0, 'differentField']]], 0);
		assert.strictEqual(
			enc.saveStructures(conflicting, conflicting.isCompatible),
			false,
			'explicit-arg path must keep rejecting conflicts'
		);
	});
});
