require('../testUtils');
const assert = require('assert');
const {
	createAuditEntry,
	readAuditEntry,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_EXPIRATION_EXTENDED_TYPE,
	HAS_ORIGINATING_OPERATION,
	entryUint32At,
	entryFloat64At,
} = require('#src/resources/auditStore');

const base = { version: 1786360662786.2988, tableId: 7, nodeId: 3, type: 'put', user: 'admin' };

function entry(fields) {
	return Buffer.from(createAuditEntry({ ...base, ...fields }));
}

describe('readAuditEntry decoding', () => {
	it("reads each entry's own id, user and value when several share one buffer, in any order", () => {
		const first = entry({ recordId: 'first', user: 'alice', encodedRecord: Buffer.from([1, 2, 3]) });
		const second = entry({ recordId: 'second', user: 'bob', encodedRecord: Buffer.from([4, 5, 6, 7]) });
		const frame = Buffer.concat([first, second]);
		const a = readAuditEntry(frame, 0, first.length);
		const b = readAuditEntry(frame, first.length, frame.length);
		// read the first entry's lazy parts only after the second was decoded from the same buffer
		assert.deepEqual([...a.getBinaryValue()], [1, 2, 3]);
		assert.deepEqual([...b.getBinaryValue()], [4, 5, 6, 7]);
		assert.equal(a.recordId, 'first');
		assert.equal(b.recordId, 'second');
		assert.equal(a.user, 'alice');
		assert.equal(b.user, 'bob');
		assert.equal(a.size, first.length);
		assert.equal(b.size, second.length);
		// each entry frames only its own bytes, including the first, which starts at offset 0
		assert.deepEqual([...a.encoded], [...first]);
		assert.deepEqual([...b.encoded], [...second]);
	});

	it('gives each reader of an array id its own copy', () => {
		const record = readAuditEntry(entry({ recordId: ['device', 7], encodedRecord: Buffer.from([1]) }));
		record.recordId.push('changed by one reader');
		assert.deepEqual(record.recordId, ['device', 7]);
	});

	it('reads big-endian integers and floats with the high bit set as a DataView does', () => {
		const bytes = new Uint8Array(16);
		const view = new DataView(bytes.buffer);
		for (const value of [0, 1, 0x7fffffff, 0x80000000, 0x80000001, 0xc0000000, 0xfffffffe, 0xffffffff]) {
			view.setUint32(3, value);
			assert.strictEqual(entryUint32At(bytes, 3), value, `uint32 ${value}`);
		}
		for (const value of [0, -0, 1.5, -2.25, 1786360662786.2988, Number.MAX_VALUE, -Infinity]) {
			view.setFloat64(5, value);
			assert(Object.is(entryFloat64At(bytes, 5), value), `float64 ${value}`);
		}
		assert.throws(() => entryUint32At(bytes, 13), RangeError);
		assert.throws(() => entryFloat64At(bytes, 9), RangeError);
	});

	it('round-trips integers across every variable-length width', () => {
		for (const value of [0, 0x7f, 0x80, 0x3fff, 0x4000, 0x3effffff, 0x3f000000, 0xfffffffe]) {
			const read = readAuditEntry(
				entry({
					recordId: 'id',
					tableId: value,
					nodeId: value,
					residencyId: value,
					extendedType: HAS_CURRENT_RESIDENCY_ID,
					encodedRecord: Buffer.from([9]),
				})
			);
			assert.equal(read.tableId, value, `tableId ${value}`);
			assert.equal(read.nodeId, value, `nodeId ${value}`);
			assert.equal(read.residencyId, value, `residencyId ${value}`);
			assert.equal(read.version, base.version);
			assert.equal(read.recordId, 'id');
		}
	});

	it("stops at an entry's declared end when more bytes follow it", () => {
		const whole = entry({ recordId: 'bounded', user: 'dave', encodedRecord: Buffer.from([1, 2]) });
		const read = readAuditEntry(whole);
		const headerLength = whole.length - read.getBinaryValue().length;
		const frame = Buffer.concat([whole, entry({ recordId: 'next', encodedRecord: Buffer.from([3]) })]);
		for (let length = 1; length < headerLength; length++) {
			const cut = readAuditEntry(frame, 0, length);
			assert.equal(cut.type, undefined, `end at ${length}`);
			assert.equal(cut.encoded.length, length, `the sentinel frames only the declared ${length} bytes`);
		}
		const bounded = readAuditEntry(frame, 0, whole.length);
		assert.equal(bounded.recordId, 'bounded');
		assert.deepEqual([...bounded.encoded], [...whole]);
	});

	it('returns the corrupt-entry sentinel for a header cut short at any byte', () => {
		const whole = entry({ recordId: 'truncated', user: '', encodedRecord: Buffer.from([1]) });
		const read = readAuditEntry(whole);
		// the header ends where the value starts
		const headerLength = whole.length - read.getBinaryValue().length;
		for (let length = 1; length < headerLength; length++) {
			const cut = readAuditEntry(whole.subarray(0, length));
			assert.equal(cut.type, undefined, `cut at ${length}`);
			assert.equal(cut.tableId, undefined, `cut at ${length}`);
		}
	});

	it("names each entry's own user as the writer changes between entries", () => {
		const users = ['alice', 'alice', 'bob', 'alice', 'alicf', 'al', '', 'al'];
		const decoded = users.map((user) => readAuditEntry(entry({ recordId: 'u', user })).user);
		assert.deepEqual(decoded, ['alice', 'alice', 'bob', 'alice', 'alicf', 'al', undefined, 'al']);
	});

	it('gives every decoded entry the same own fields, whatever optional parts it carries', () => {
		const plain = readAuditEntry(entry({ recordId: 'a', encodedRecord: Buffer.from([1]) }));
		const rich = readAuditEntry(
			entry({
				recordId: 'b',
				encodedRecord: Buffer.from([1]),
				extendedType: HAS_CURRENT_RESIDENCY_ID | HAS_EXPIRATION_EXTENDED_TYPE | HAS_ORIGINATING_OPERATION,
				residencyId: 5,
				expiresAt: 1817915930237,
				originatingOperation: 'upsert',
			})
		);
		assert.deepEqual(Object.keys(plain), Object.keys(rich));
		assert.equal(rich.expiresAt, 1817915930237);
		assert.equal(rich.originatingOperation, 'upsert');
	});
});
