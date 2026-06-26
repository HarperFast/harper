require('../testUtils');
const assert = require('assert');
const {
	RecordEncoder,
	isMissingStructureError,
	isStructureMismatchError,
	isFaithfulExtension,
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

describe('RecordEncoder present-but-wrong recovery (durable-wins reload)', () => {
	let errors, restoreError, restoreWarn;
	beforeEach(() => {
		errors = [];
		restoreError = harperLogger.error;
		restoreWarn = harperLogger.warn;
		harperLogger.error = (...a) => errors.push(a);
		harperLogger.warn = () => {};
	});
	afterEach(() => {
		harperLogger.error = restoreError;
		harperLogger.warn = restoreWarn;
	});

	const oneField = { a: 1 };
	const threeField = { x: 1, y: 2, z: 3 };

	it('heals a diverged in-memory dictionary by reloading durable (durable-wins) and retrying', () => {
		// Canonical durable order: id0 = ['a'], id1 = ['x','y','z'] (the writer's encounter order).
		const canonical = sharedStore();
		const writer = makeEncoder(false, canonical);
		writer.encode(oneField);
		writer.encode(threeField);
		const recordOneField = Buffer.from(writer.encode(oneField)); // references id0 = ['a'] (1 field)

		// Reader builds its OWN divergent in-memory order from an empty store — the off-CAS minting the
		// replication-apply path does — assigning id0 = ['x','y','z'] (the opposite order).
		const reader = makeEncoder(false, sharedStore());
		reader.encode(threeField); // reader in-memory id0 = ['x','y','z']
		reader.encode(oneField); // reader in-memory id1 = ['a']
		// Its authoritative durable, however, is the canonical order (what every other node committed).
		reader.getStructures = canonical.get;

		// Decoding a record written against the canonical order over-reads (id0 is a 3-field shape in
		// memory vs the 1-field record) → a present-but-wrong structure-mismatch error. Without recovery
		// this returns null forever; with it, the reader reloads canonical durable and heals.
		const decoded = reader.decode(recordOneField);
		assert.deepStrictEqual(decoded, oneField, 'diverged read should heal to the correct record');
		assert.strictEqual(errors.length, 0, 'recovery should succeed without falling to the generic error path');
	});

	it('classifies present-but-wrong errors distinctly from missing-structure errors', () => {
		assert.ok(isStructureMismatchError(new Error('Unexpected end of MessagePack data')));
		assert.ok(isStructureMismatchError(new Error('Data read, but end of buffer not reached 64')));
		assert.ok(!isStructureMismatchError(new Error('Could not find typed structure 1')));
		assert.ok(!isStructureMismatchError(new Error('Record id is not defined for 42')));
		assert.ok(!isStructureMismatchError(undefined));
		// the two classifiers are mutually exclusive over the dependency's terminal messages
		assert.ok(!isMissingStructureError(new Error('Unexpected end of MessagePack data')));
	});

	it('isFaithfulExtension accepts append-only growth but rejects a same-length reorder', () => {
		const base = [['a'], ['x', 'y', 'z']];
		assert.ok(isFaithfulExtension(base, [['a'], ['x', 'y', 'z'], ['n']]), 'appending on top is faithful');
		assert.ok(isFaithfulExtension(undefined, [['a']]), 'seeding from empty is faithful');
		assert.ok(!isFaithfulExtension(base, [['x', 'y', 'z'], ['a']]), 'a same-length reorder is NOT faithful');
		assert.ok(!isFaithfulExtension(base, [['a']]), 'dropping a published id is NOT faithful');
		// the {named, typed} Map form (typed tables) is unwrapped before comparison
		const mapBase = new Map([
			['named', base],
			['typed', []],
		]);
		const mapNext = new Map([
			['named', [['x', 'y', 'z'], ['a']]],
			['typed', []],
		]);
		assert.ok(!isFaithfulExtension(mapBase, mapNext), 'reorder detected through the {named,typed} map form');
	});
});
