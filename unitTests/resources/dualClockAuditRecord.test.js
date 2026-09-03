// harper#2412 stage 0b: an audit record carries two clocks, and they must not be confused.
//
//   version   — the record's own version: LWW ordering, @updatedTime, ETag. Legitimately non-unique.
//   localTime — this entry's key in the per-origin transaction log. Write identity, resume cursor.
//
// They hold the same value for a write whose record version is its own commit timestamp, which is
// every ordinary local write — so a test that only writes ordinary records cannot tell the two
// apart, and every case below deliberately drives them apart.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor.js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Dual-clock audit records (harper#2412)', () => {
	let Plain, Filled, auditStore;
	let reportedVersion;

	// Every audit entry this suite's tables produced, newest last.
	function auditEntriesFor(TableClass, id) {
		const entries = [];
		for (const auditRecord of auditStore.getRange({ start: 1 })) {
			if (auditRecord.tableId !== TableClass.tableId) continue;
			if (auditRecord.recordId !== id) continue;
			entries.push({
				type: auditRecord.type,
				version: auditRecord.version,
				localTime: auditRecord.localTime,
			});
		}
		return entries;
	}

	// The receive path: the apply transaction commits under the origin's log key while each write
	// stores the origin's record version (Table.ts's apply dispatcher -> options.version).
	function applyFromOrigin(TableClass, id, record, { logKey, version, nodeId = 1 }) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			const resource = await TableClass.getResource(id, context);
			return resource._writeUpdate(id, record, true, { isNotification: true, nodeId, version });
		});
	}

	before(async function () {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
		Plain = table({
			table: 'DualClockPlain',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		Filled = table({
			table: 'DualClockFilled',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		Filled.sourcedFrom(
			class extends Resource {
				get() {
					// a source that reports a version older than the fill's own commit: core #2065
					reportedVersion = Date.now() - 60_000;
					this.getContext().lastModified = reportedVersion;
					return { id: this.getId(), name: 'from-source' };
				}
			}
		);
		auditStore = Plain.primaryStore.rootStore.auditStore;
	});

	it('a plain write records its version as both the record version and the log key', async function () {
		if (isLMDB) return this.skip();
		const id = 'plain-1';
		await Plain.put(id, { id, name: 'local' });
		const [entry] = auditEntriesFor(Plain, id);
		assert.ok(entry, 'the write must have produced an audit entry');
		assert.equal(entry.version, Plain.primaryStore.getEntry(id).version, 'version is the record version');
		assert.equal(entry.localTime, entry.version, 'a locally-originated write commits at its own version');
	});

	it('a source fill records the source version and the fill commit as separate clocks', async function () {
		if (isLMDB) return this.skip();
		const id = 'fill-1';
		await Filled.get(id);
		await waitFor(() => !Filled.primaryStore.hasLock(id), { message: 'the fill should finish committing' });
		const storedVersion = Filled.primaryStore.getEntry(id).version;
		assert.equal(storedVersion, reportedVersion, 'the record keeps the version the source reported');
		const [entry] = auditEntriesFor(Filled, id);
		assert.ok(entry, 'the fill must have produced an audit entry');
		assert.equal(entry.version, reportedVersion, 'the audit record carries the record version');
		assert.ok(
			entry.localTime > reportedVersion,
			`the log key is the fill's commit, not its version (localTime ${entry.localTime}, version ${entry.version})`
		);
	});

	it('an applied write keeps the origin version and takes the origin log key', async function () {
		if (isLMDB) return this.skip();
		const id = 'applied-1';
		const logKey = Date.now();
		const version = logKey - 30_000;
		await applyFromOrigin(Plain, id, { id, name: 'from-origin' }, { logKey, version });
		assert.equal(Plain.primaryStore.getEntry(id).version, version, 'the peer stores the origin record version');
		const [entry] = auditEntriesFor(Plain, id);
		assert.equal(entry.version, version, 'the audit record carries the origin record version');
		assert.equal(entry.localTime, logKey, "the peer's log key for this write is the origin's log key");
	});

	it('one applied transaction can carry writes at different record versions', async function () {
		if (isLMDB) return this.skip();
		// A sender frames by log key, so entries committed together — a fill and an ordinary write —
		// reach the receiver in one transaction with different record versions. Each has to keep its own.
		const logKey = Date.now() + 1;
		const olderVersion = logKey - 45_000;
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		await transaction(context, async () => {
			const older = await Plain.getResource('batched-old', context);
			await older._writeUpdate('batched-old', { id: 'batched-old', name: 'a' }, true, {
				isNotification: true,
				nodeId: 1,
				version: olderVersion,
			});
			const current = await Plain.getResource('batched-new', context);
			await current._writeUpdate('batched-new', { id: 'batched-new', name: 'b' }, true, {
				isNotification: true,
				nodeId: 1,
				version: logKey,
			});
		});
		assert.equal(Plain.primaryStore.getEntry('batched-old').version, olderVersion);
		assert.equal(Plain.primaryStore.getEntry('batched-new').version, logKey);
		const [oldEntry] = auditEntriesFor(Plain, 'batched-old');
		const [newEntry] = auditEntriesFor(Plain, 'batched-new');
		assert.equal(oldEntry.version, olderVersion);
		assert.equal(newEntry.version, logKey);
		assert.equal(oldEntry.localTime, logKey, 'both share the transaction log key');
		assert.equal(newEntry.localTime, logKey);
	});

	it('an ordinary local write ignores a record version it was not given', async function () {
		if (isLMDB) return this.skip();
		// The per-write clock is read only on an apply path; a plain put must be unaffected by it.
		const id = 'plain-2';
		await Plain.put(id, { id, name: 'still-local' });
		const [entry] = auditEntriesFor(Plain, id);
		assert.equal(entry.localTime, entry.version);
	});

	it('delivers a subscriber event whose version is the record version and localTime the log position', async function () {
		if (isLMDB) return this.skip();
		const id = 'transport-1';
		const subscription = await Plain.subscribe({});
		const events = [];
		subscription.on('data', (event) => events.push(event));
		try {
			const logKey = Date.now() + 2;
			const version = logKey - 90_000;
			await applyFromOrigin(Plain, id, { id, name: 'delivered' }, { logKey, version });
			await waitFor(() => events.some((event) => event.id === id), {
				message: 'the applied write should reach the subscription',
			});
			const event = events.find((candidate) => candidate.id === id);
			assert.equal(event.version, version, 'event.version is the record version');
			assert.equal(event.localTime, logKey, 'event.localTime is the log position');
		} finally {
			subscription.close();
		}
	});

	it('still removes a real tombstone through deleteHistory on the live store', async function () {
		if (isLMDB) return this.skip();
		// The identity predicate reads `localTime` off the PRIMARY entry. On RocksDB that is the record's
		// stored word, written by the encoder's metadata prefix — including on a tombstone, which is a
		// stored null rather than an absent key. A mocked entry could hide that; this one cannot.
		const id = 'tombstone-1';
		await Plain.put(id, { id, name: 'to-be-deleted' });
		await Plain.delete(id);
		const tombstone = Plain.primaryStore.getEntry(id);
		assert.equal(tombstone.value, null, 'the delete must leave a tombstone, not an absent key');
		assert.equal(tombstone.localTime, tombstone.version, 'a locally-written record stores one word');
		const [, deleteEntry] = auditEntriesFor(Plain, id);
		assert.equal(deleteEntry.type, 'delete');
		assert.equal(deleteEntry.localTime, tombstone.localTime, "the audit entry names the tombstone's write");
		await Plain.deleteHistory(Date.now() + 60_000);
		assert.equal(Plain.primaryStore.getEntry(id), undefined, 'the tombstone must be removed with its entry');
	});

	it('looks a record up in the log by its log key, not by its version', async function () {
		if (isLMDB) return this.skip();
		// auditStore.get(key, ...) walks the entries at one log key; a fill's entry sits at its commit
		// key while the record itself stores the source version, so keying by version must not find it.
		const id = 'lookup-1';
		const logKey = Date.now() + 3;
		const version = logKey - 120_000;
		// nodeId 0 so the entry lands in — and is read back from — the one log a single-node test has
		await applyFromOrigin(Plain, id, { id, name: 'lookup' }, { logKey, version, nodeId: 0 });
		const found = auditStore.get(logKey, Plain.tableId, id, 0);
		assert.ok(found, 'the entry is addressable by its log key');
		assert.equal(found.version, version);
		assert.equal(auditStore.get(version, Plain.tableId, id, 0), undefined, 'and not by its record version');
	});
});

// LMDB has carried the two clocks in separate fields all along, so nothing here is normalized — but the
// per-write record version added for the receive path runs through LMDBTransaction's own commit loop,
// and that branch would otherwise ship untested.
describe('Dual-clock audit records on LMDB (harper#2412)', () => {
	let Applied;

	before(async function () {
		if (!isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
		Applied = table({
			table: 'DualClockLmdb',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	});

	it('stores the origin record version on an applied write and keys the entry by its own audit time', async function () {
		if (!isLMDB) return this.skip();
		const id = 'lmdb-applied-1';
		const originLogKey = Date.now();
		const version = originLogKey - 30_000;
		const context = { source: {}, sourceApply: true, timestamp: originLogKey };
		await transaction(context, async () => {
			const resource = await Applied.getResource(id, context);
			return resource._writeUpdate(id, { id, name: 'from-origin' }, true, {
				isNotification: true,
				nodeId: 1,
				version,
			});
		});
		assert.equal(Applied.primaryStore.getEntry(id).version, version, 'the peer stores the origin record version');
		const auditStore = Applied.primaryStore.rootStore.auditStore;
		let entry;
		for (const auditRecord of auditStore.getRange({ start: 1 })) {
			if (auditRecord.tableId === Applied.tableId && auditRecord.recordId === id) entry = auditRecord;
		}
		assert.ok(entry, 'the applied write must have produced an audit entry');
		assert.equal(entry.version, version, 'the audit entry carries the origin record version');
		assert.equal(
			entry.localTime,
			Applied.primaryStore.getEntry(id).localTime,
			"on LMDB the audit key is the receiver's own local time for the record, not the origin's log key"
		);
	});
});
