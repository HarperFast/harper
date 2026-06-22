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

describe('RecordEncoder structure-version drift on read', () => {
	// Production symptom from the v4→v5 in-place upgrade soak (Akamai staging): a burst of
	// records on the first upgraded node failed to decode with
	//   "Error decoding record Error: Data read, but end of buffer not reached"
	// All affected records carry the same classic struct ID byte and decode through msgpackr's
	// checkedRead. Mechanism: writer encoded against shared-structures version V (N+k fields),
	// reader's local in-memory structures buffer is at V-1 (N fields), so the decoder finishes
	// the N declared fields successfully but k field-bytes remain in the buffer. Distinct from
	// the CAS-clobber path (harper#1441), which surfaces as missing-structure or "Unexpected end
	// of MessagePack data" instead; this one is reader-side dictionary lag, not writer-side
	// overwrite.

	let errors, restoreError;
	beforeEach(() => {
		errors = [];
		restoreError = harperLogger.error;
		harperLogger.error = (...args) => errors.push(args);
	});
	afterEach(() => {
		harperLogger.error = restoreError;
	});

	it('recovers via getStructures() reload when persistent dict has caught up to writer', () => {
		// In production the persistent structures buffer in storage is at the writer's version
		// (saveStructures wrote it); only the in-memory singleton encoder dict lags. The fix
		// catches "end of buffer not reached" once, calls getStructures() (which reads from
		// storage), merges, and retries decode.
		const writerStore = sharedStore();
		const writer = makeEncoder(false, writerStore);
		const bytes = Buffer.from(writer.encode({ id: 'x', payload: 'hello', tag: 'extra' }));

		const reader = makeEncoder(false, writerStore);
		reader.structures = writerStore.get().map((entry) => (Array.isArray(entry) ? entry.slice(0, -1) : entry));

		const decoded = reader.decode(bytes);
		assert.deepStrictEqual(
			decoded,
			{ id: 'x', payload: 'hello', tag: 'extra' },
			`fix should reload structures on "end of buffer not reached" and recover the full record; got ${JSON.stringify(decoded)}`
		);
		assert.strictEqual(errors.length, 0, 'recovery must not leak to the error log');
	});

	it('falls through to null + error log when reload does not advance the dict', () => {
		// Guards the _reloadingStructures recursion guard: if a single reload doesn't actually
		// advance the dict, the second decode must NOT retry again. Falls through to the existing
		// null-on-corrupt-decode contract so we don't spin or shadow real corruption.
		const writerStore = sharedStore();
		const writer = makeEncoder(false, writerStore);
		const bytes = Buffer.from(writer.encode({ id: 'x', payload: 'hello', tag: 'extra' }));

		const stuckStore = sharedStore();
		stuckStore.save(writerStore.get().map((entry) => (Array.isArray(entry) ? entry.slice(0, -1) : entry)));
		const reader = makeEncoder(false, stuckStore);

		const decoded = reader.decode(bytes);
		assert.strictEqual(decoded, null, 'permanent truncation must still produce null');
		assert.ok(
			errors.some((e) => /end of buffer not reached/i.test((e[1] && e[1].message) || e.join(' '))),
			'permanent failure must still surface in the error log (not silent)'
		);
	});

	it('reports "Data read, but end of buffer not reached" when reader’s structures are behind writer’s', () => {
		// Pure symptom: writer uses CLASSIC shared structures (randomAccessStructure=false). Its
		// first encoded record installs a 3-field structure at index 0. Reader uses a DIFFERENT
		// store seeded with a TRUNCATED structures dict (same index, only the first two fields).
		// Models the v4→v5 first-upgrade window where the v5 receiver's local encoder dict for a
		// given struct index lagged behind the writer's by one field. The bytes for the third
		// field are still in the buffer; msgpackr decodes the two declared fields and checkedRead
		// then flags the leftover bytes.
		const writerStore = sharedStore();
		const writer = makeEncoder(false, writerStore);
		const wideRecord = { id: 'x', payload: 'hello', tag: 'extra' };
		const bytes = Buffer.from(writer.encode(wideRecord));

		const fullStructures = writerStore.get();
		const stale = sharedStore();
		stale.save(fullStructures.map((entry) => (Array.isArray(entry) ? entry.slice(0, -1) : entry)));
		const reader = makeEncoder(false, stale);
		const decoded = reader.decode(bytes);

		const messages = errors.map((e) => (e[1] && e[1].message) || e.join(' '));
		const hitLog = messages.some((m) => /end of buffer not reached/i.test(m));
		const hitNull = decoded === null;
		assert.ok(
			hitLog || !hitNull,
			`expected leftover-bytes detection (null + error log, or thrown error). decoded=${JSON.stringify(decoded)} messages=${JSON.stringify(messages)}`
		);
		if (hitNull) {
			assert.ok(hitLog, `decoded to null but error log did not include "end of buffer not reached": ${JSON.stringify(messages)}`);
		} else if (decoded !== null && JSON.stringify(decoded) === JSON.stringify(wideRecord)) {
			assert.fail('reader recovered the full record despite a truncated dict; symptom is not reproduced by this fixture');
		}
	});
});
