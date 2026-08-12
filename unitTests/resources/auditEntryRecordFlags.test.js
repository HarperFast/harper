require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { createAuditEntry, readAuditEntry } = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const HAS_RECORD = 16;
const HAS_PARTIAL_RECORD = 32;

// harper#2153: an audit-only commit (a fully-superseded out-of-order write) stores no record but
// passed its operation type through unchanged, so the entry advertised HAS_RECORD with no body.
// Readers then decode an empty buffer ("Unexpected end of MessagePack data"), and since
// harper-pro#521 that decode failure permanently wedges the replication leg on this entry.
describe('Audit entry record flags match the body (#2153)', () => {
	// the field values from the production entry in the issue
	const baseRecord = {
		version: 1786360662786.2988,
		tableId: 1,
		recordId: '006a97ef-579c-41e5-b884-bbefcf2ee889',
		nodeId: 16,
		type: 'put',
		extendedType: 0x1100, // HAS_EXPIRATION_EXTENDED_TYPE | HAS_STRUCTURE_UPDATE
		expiresAt: 1817915930237,
	};

	it('clears the record flags on a put minted with no encoded record', () => {
		const entry = createAuditEntry({ ...baseRecord, encodedRecord: undefined });
		const read = readAuditEntry(Buffer.from(entry));
		assert.equal(read.type, 'put');
		assert.equal(read.extendedType & (HAS_RECORD | HAS_PARTIAL_RECORD), 0);
		assert.equal(read.getBinaryValue().length, 0);
		// no body advertised, so getValue must not attempt a decode (store is never touched)
		assert.equal(read.getValue({}), undefined);
	});

	it('keeps HAS_RECORD when a body is present', () => {
		const encodedRecord = Buffer.from([0x81, 0xa1, 0x61, 0x01]); // msgpack {a: 1}
		const entry = createAuditEntry({ ...baseRecord, encodedRecord });
		const read = readAuditEntry(Buffer.from(entry));
		assert.equal(read.type, 'put');
		assert.equal(read.extendedType & HAS_RECORD, HAS_RECORD);
		assert.deepEqual(read.getBinaryValue(), encodedRecord);
	});

	it('tolerates a pre-fix malformed entry: HAS_RECORD set with no body', () => {
		// mint the (fixed) bodyless entry, then set HAS_RECORD back in the action word to get the
		// exact malformed form persisted by pre-fix nodes (production bytes start c0 00 11 11)
		const entry = Buffer.from(createAuditEntry({ ...baseRecord, encodedRecord: undefined }));
		assert.equal(entry[0], 0xc0); // extended action word, no previousVersion
		entry[3] |= HAS_RECORD;
		const read = readAuditEntry(entry);
		assert.equal(read.type, 'put');
		assert.equal(read.extendedType & HAS_RECORD, HAS_RECORD);
		assert.equal(read.recordId, baseRecord.recordId);
		// the reader must treat it as having no record rather than throwing on the empty decode
		assert.equal(read.getValue({}), undefined);
	});

	describe('audit-only commit for a superseded out-of-order write', () => {
		let T;
		before(async function () {
			if (isLMDB) return;
			setupTestDBPath();
			setMainIsWorker(true);
			T = table({
				table: 'SupersededAudit2153',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'a' }, { name: 'b' }],
				audit: true,
			});
		});

		it('mints a decodable entry carrying the superseded update as its body', async function () {
			if (isLMDB) return this.skip();
			const id = 'r1';
			const context = {};
			await transaction(context, () => {
				T.put(id, { id, a: 'v0', b: 'keep' }, context);
			});
			const now = Date.now();
			await T.patch(id, { a: 'n1' }, { timestamp: now + 100 });
			await T.patch(id, { a: 'n2' }, { timestamp: now + 200 });
			// out-of-order older patch to `a`, fully superseded by the two newer patches: takes the
			// writeCommit(false) audit-only escape
			const loserVersion = now + 50;
			await T.patch(id, { a: 'loser' }, { timestamp: loserVersion, nodeId: 7 });

			let loser;
			for (const entry of T.auditStore.getRange({ start: 1 })) {
				if (entry.version === loserVersion) loser = entry;
				// every minted entry must be internally consistent: record flags imply a body
				if (entry.extendedType & (HAS_RECORD | HAS_PARTIAL_RECORD)) {
					assert(entry.getBinaryValue().length > 0, `entry ${entry.version} advertises a record but has no body`);
				}
			}
			assert(loser, 'audit entry for the superseded write should exist');
			assert.deepEqual({ ...loser.getValue(T.primaryStore) }, { a: 'loser' });
			const record = await T.get(id);
			assert.equal(record.a, 'n2');
			assert.equal(record.b, 'keep');
		});
	});
});
