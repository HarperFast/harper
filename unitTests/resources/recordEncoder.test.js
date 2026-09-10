require('../testUtils');
const assert = require('assert');
const {
	RecordEncoder,
	RecordObject,
	isMissingStructureError,
	DEFAULT_MAX_TYPED_STRUCTURES,
} = require('#src/resources/RecordEncoder');
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

	it('promoted classic msgpackr and structon records share the runtime base without sharing prototypes', () => {
		const classicEncoder = makeEncoder(false, sharedStore());
		const structEncoder = makeEncoder(true, sharedStore());
		const classicDecoded = classicEncoder.decode(Buffer.from(classicEncoder.encode(record)));
		const classicRecord = new classicEncoder.structPrototype.constructor();
		Object.assign(classicRecord, classicDecoded); // getEntry promotes classic decoded objects this way
		const structRecord = structEncoder.decode(Buffer.from(structEncoder.encode(record)));

		assert.ok(classicRecord instanceof RecordObject, 'classic msgpackr records must be identifiable at runtime');
		assert.ok(structRecord instanceof RecordObject, 'structon records must be identifiable at runtime');
		assert.notStrictEqual(
			classicEncoder.structPrototype,
			structEncoder.structPrototype,
			'per-encoder prototypes must remain isolated for table-specific computed getters'
		);
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

describe('RecordEncoder structure-dictionary bound & observability (harper#2220)', () => {
	let warnings, restoreWarn;
	beforeEach(() => {
		warnings = [];
		restoreWarn = harperLogger.warn;
		harperLogger.warn = (...args) => warnings.push(args);
	});
	afterEach(() => {
		harperLogger.warn = restoreWarn;
	});
	const saturationWarnings = () => warnings.filter((w) => /Typed-structure dictionary/.test(w[0]));

	function makeCappedEncoder(store, maxOwnStructures) {
		return new RecordEncoder({
			structures: [],
			randomAccessStructure: true,
			maxOwnStructures,
			getStructures: store.get,
			saveStructures: store.save,
		});
	}

	it('defaults the typed-structure dictionary to the documented bound', () => {
		const enc = makeEncoder(true, sharedStore());
		assert.strictEqual(enc.maxOwnStructures, DEFAULT_MAX_TYPED_STRUCTURES);
		assert.strictEqual(enc.getStructureCounts().typedLimit, DEFAULT_MAX_TYPED_STRUCTURES);
	});

	it('stops minting typed structures at the bound, and past-cap records still round-trip', () => {
		const enc = makeCappedEncoder(sharedStore(), 4);
		// Each novel field name is a novel shape, so this would mint 20 structures if uncapped.
		for (let i = 0; i < 20; i++) enc.encode({ ['f' + i]: i });
		assert.strictEqual(enc.getStructureCounts().typed, 4, 'dictionary must stop growing at the bound');
		const bytes = Buffer.from(enc.encode({ beyond: 'the cap' }));
		assert.deepStrictEqual(enc.decode(bytes), { beyond: 'the cap' }, 'past-cap shapes fall back to plain encoding');
	});

	it("reports the durable dictionary, not this encoder's own arrays", () => {
		// The failure this guards: each worker owns its own encoder and loads lazily, so a worker that
		// never encoded for a store holds empty arrays for a store whose durable dictionary is full.
		// Reporting the local arrays would tell an operator there is full headroom when there is none.
		const store = sharedStore();
		const writer = makeCappedEncoder(store, 8);
		for (let i = 0; i < 20; i++) writer.encode({ ['f' + i]: i });
		assert.strictEqual(writer.getStructureCounts().typed, 8);

		const idleWorker = makeCappedEncoder(store, 8);
		assert.strictEqual(idleWorker.typedStructs.length, 0, 'precondition: this encoder has loaded nothing');
		assert.strictEqual(idleWorker.getStructureCounts().typed, 8, 'counts must come from the durable payload');
	});

	it('does not report zero typed structures for a named-only durable payload', () => {
		// structon keeps this encoder's typed dictionary for the legacy bare-array and cbor-x
		// {structures} payloads -- both carry named structures only. Reading typed as 0 for those
		// would show an empty dictionary for a store that is actually saturated.
		const store = sharedStore();
		const enc = makeCappedEncoder(store, 8);
		for (let i = 0; i < 20; i++) enc.encode({ ['f' + i]: i });
		assert.strictEqual(enc.typedStructs.length, 8, 'precondition: this encoder holds a full dictionary');

		store.save(['someNamedStructure']); // legacy bare-array form
		assert.strictEqual(enc.getStructureCounts().typed, 8, 'bare-array payload must not zero the typed count');

		store.save({ structures: ['someNamedStructure'] }); // cbor-x SharedData form
		assert.strictEqual(enc.getStructureCounts().typed, 8, 'cbor-x payload must not zero the typed count');
	});

	it('reports zero for a store whose structures have never been saved', () => {
		const enc = makeCappedEncoder(sharedStore(), 8);
		assert.deepStrictEqual(enc.getStructureCounts(), {
			typed: 0,
			classic: 0,
			typedLimit: 8,
			typedEnabled: true,
		});
	});

	it('reports zeros rather than throwing for a store with no shared-structures mechanism', () => {
		// msgpackr only defines getStructures when the option was supplied, so the captured super is
		// undefined here; Table.getStructureCounts() is public and must not throw on such a store.
		const enc = new RecordEncoder({ structures: [], randomAccessStructure: true });
		const counts = enc.getStructureCounts();
		assert.strictEqual(counts.typed, 0);
		assert.strictEqual(counts.classic, 0);
	});

	it('reports whether typed encoding is enabled at all', () => {
		// Random-access fields default off (utility/lmdb/OpenDBIObject.ts), so a typed count of 0
		// against a limit of 256 is the normal state for most tables, not spare headroom.
		assert.strictEqual(makeEncoder(true, sharedStore()).getStructureCounts().typedEnabled, true);
		assert.strictEqual(makeEncoder(false, sharedStore()).getStructureCounts().typedEnabled, false);
	});

	it('reports classic (named-record) structures separately from typed ones', () => {
		const enc = makeEncoder(false, sharedStore()); // struct hook bails -> msgpackr records mode
		enc.encode(record);
		const counts = enc.getStructureCounts();
		assert.strictEqual(counts.typed, 0, 'records mode must not mint typed structures');
		assert.ok(counts.classic > 0, 'records mode mints a classic named-record structure');
	});

	it('warns exactly once when the typed-structure dictionary saturates', () => {
		const enc = makeCappedEncoder(sharedStore(), 4);
		for (let i = 0; i < 20; i++) enc.encode({ ['f' + i]: i });
		assert.strictEqual(saturationWarnings().length, 1, 'saturation should be reported once, not per write');
		assert.match(saturationWarnings()[0][0], /reached its limit of 4 structures/);
	});

	it('does not warn while the dictionary still has headroom', () => {
		const enc = makeCappedEncoder(sharedStore(), 64);
		for (let i = 0; i < 8; i++) enc.encode({ ['f' + i]: i });
		assert.strictEqual(enc.getStructureCounts().typed, 8);
		assert.strictEqual(saturationWarnings().length, 0, 'no warning below the bound');
	});

	it('does not fail the write when the log sink throws on the saturation warning', () => {
		// The structures are already durably committed by the time this runs, so a failing sink must
		// not turn a committed save into a reported failure.
		harperLogger.warn = () => {
			throw new Error('log sink unavailable');
		};
		const enc = makeCappedEncoder(sharedStore(), 4);
		for (let i = 0; i < 20; i++) enc.encode({ ['f' + i]: i });
		assert.strictEqual(enc.getStructureCounts().typed, 4);
		const bytes = Buffer.from(enc.encode({ still: 'writable' }));
		assert.deepStrictEqual(enc.decode(bytes), { still: 'writable' });
	});

	it('does not warn when the structure save was declined', () => {
		// A declined save means the dictionary this encoder holds was never persisted; warning on it
		// would report saturation of a dictionary that does not exist durably.
		const enc = new RecordEncoder({
			structures: [],
			randomAccessStructure: true,
			maxOwnStructures: 4,
			getStructures: () => undefined,
			saveStructures: () => false,
		});
		for (let i = 0; i < 20; i++) {
			try {
				enc.encode({ ['f' + i]: i });
			} catch {
				// structon surfaces sustained save contention; the point here is the absent warning
			}
		}
		assert.strictEqual(saturationWarnings().length, 0, 'a declined save must not report saturation');
	});

	it('counts key order and per-field value width as distinct shapes, not just the field set', () => {
		// The growth driver behind harper#2220: dictionary size is combinatorial in
		// (field subset) x (key order) x (per-field value width class), not linear in column count.
		const byOrder = makeEncoder(true, sharedStore());
		byOrder.encode({ a: 1, b: 1, c: 1 });
		byOrder.encode({ c: 1, b: 1, a: 1 });
		assert.strictEqual(byOrder.getStructureCounts().typed, 2, 'same field set, different key order, two shapes');

		const byWidth = makeEncoder(true, sharedStore());
		byWidth.encode({ id: 'k', v: 1 }); // 1-byte int
		byWidth.encode({ id: 'k', v: 70000 }); // 4-byte int
		assert.strictEqual(byWidth.getStructureCounts().typed, 2, 'same field set, different value width, two shapes');
	});
});
