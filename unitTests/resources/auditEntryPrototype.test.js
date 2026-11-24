require('../testUtils');
const assert = require('node:assert');
const { createAuditEntry, readAuditEntry, HAS_CURRENT_RESIDENCY_ID } = require('#src/resources/auditStore');

describe('Audit entries read from their encoding', () => {
	const record = {
		version: 1786360662786.2988,
		tableId: 7,
		recordId: 'sensor/ünïcode/42',
		nodeId: 3,
		user: 'someone',
		type: 'put',
		extendedType: 0,
		encodedRecord: Buffer.from('the record body'),
	};
	const read = (fields) => readAuditEntry(Buffer.from(createAuditEntry({ ...record, ...fields })));

	it('exposes the encoded fields, accessors and methods', () => {
		const entry = read();
		assert.equal(entry.type, 'put');
		assert.equal(entry.tableId, 7);
		assert.equal(entry.nodeId, 3);
		assert.equal(entry.version, record.version);
		assert.equal(entry.recordId, record.recordId);
		assert.equal(entry.user, 'someone');
		assert.equal(Buffer.from(entry.getBinaryValue()).toString(), 'the record body');
		assert.equal(entry.size, entry.encoded.length);
		assert.equal(readAuditEntry(entry.encoded).recordId, record.recordId);
	});

	it('keeps accessors and methods off the entry itself', () => {
		const entry = read();
		for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
			assert.equal(typeof descriptor.value === 'function' || 'get' in descriptor, false, `${name} is per-entry`);
		}
		assert.equal(Object.getPrototypeOf(entry), Object.getPrototypeOf(read({ type: 'delete' })));
	});

	it('reads each entry of a shared buffer by its own offsets', () => {
		const first = createAuditEntry({ ...record, recordId: 'first', encodedRecord: Buffer.from('first body') });
		const firstLength = first.length;
		const shared = Buffer.concat([
			Buffer.from(first),
			Buffer.from(
				createAuditEntry({ ...record, recordId: 'second', user: 'a longer user name', encodedRecord: Buffer.from('2') })
			),
		]);
		const firstEntry = readAuditEntry(shared, 0, firstLength);
		const secondEntry = readAuditEntry(shared, firstLength, shared.length);
		assert.equal(Buffer.from(firstEntry.getBinaryValue()).toString(), 'first body');
		assert.equal(Buffer.from(secondEntry.getBinaryValue()).toString(), '2');
		assert.equal(firstEntry.recordId, 'first');
	});

	it('spreads to its data fields only, and re-encodes from explicit reads of the rest', () => {
		const entry = read({ residencyId: 5, extendedType: HAS_CURRENT_RESIDENCY_ID });
		const spread = { ...entry };
		for (const name of ['recordId', 'user', 'encoded', 'size', 'getValue', 'getBinaryValue', 'getBinaryRecordId']) {
			assert.equal(name in spread, false, `${name} is copied by a spread`);
		}
		for (const value of Object.values(spread)) assert.equal(value instanceof Uint8Array, false);
		const reread = readAuditEntry(
			Buffer.from(
				createAuditEntry({
					...spread,
					recordId: entry.recordId,
					user: entry.user,
					residencyId: 9,
					extendedType: HAS_CURRENT_RESIDENCY_ID,
					encodedRecord: entry.getBinaryValue(),
				})
			)
		);
		assert.equal(reread.residencyId, 9);
		assert.equal(reread.recordId, record.recordId);
		assert.equal(reread.user, 'someone');
		assert.equal(Buffer.from(reread.getBinaryValue()).toString(), 'the record body');
	});

	it('decodes the body once, by its parsed action after extendedType is overwritten', () => {
		const entry = read();
		let decodes = 0;
		const store = { decoder: { decode: (body) => ({ body: Buffer.from(body).toString(), decode: ++decodes }) } };
		entry.extendedType = 0;
		assert.deepEqual(entry.getValue(store), { body: 'the record body', decode: 1 });
		assert.equal(entry.getValue(store), entry.getValue(store));
		assert.equal(decodes, 1);
	});

	it('throws for a copy that inherits from the entry, and for a detached method', () => {
		const entry = read();
		const copy = Object.create(entry);
		for (const name of ['recordId', 'user', 'encoded', 'size']) assert.throws(() => copy[name], TypeError, name);
		for (const name of ['getBinaryValue', 'getBinaryRecordId']) assert.throws(() => copy[name](), TypeError, name);
		const { getValue } = entry;
		assert.throws(() => getValue({}), TypeError);
	});

	it('still returns the corrupt-entry sentinel for an entry cut short', () => {
		const encoded = Buffer.from(createAuditEntry(record));
		const entry = readAuditEntry(encoded.subarray(0, 12));
		assert.equal(entry.type, undefined);
		assert.equal(entry.tableId, undefined);
		assert.equal(entry.getValue({}), undefined);
	});
});
