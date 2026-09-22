// A replicated delete re-delivered onto the state it already produced must not re-log: in a mesh every
// re-logged copy is new log tail that peers forward and re-log in turn (harper-pro#826).
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { INVALIDATED } = require('#src/resources/Table');
const { waitFor } = require('../waitFor.js');

// LMDB keys its log by local time, so a stored tombstone carries no origin log key to tie a later
// delivery against; only copies inside one apply transaction collapse there.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Re-delivered replicated deletes (harper-pro#826)', () => {
	let Nodes, Unindexed, auditStore;

	// Each applied transaction needs its own log key: a second transaction at an existing key would
	// hide the first from auditStore.get.
	let lastLogKey = Date.now() - 3_600_000;
	function originClock() {
		return (lastLogKey += 10_000);
	}

	function entriesFor(TableClass, id, type) {
		const entries = [];
		for (const auditRecord of auditStore.getRange({ start: 1 })) {
			if (auditRecord.tableId === TableClass.tableId && auditRecord.recordId === id && auditRecord.type === type)
				entries.push(auditRecord);
		}
		return entries;
	}

	function applyFrame(logKey, writes, TableClass = Nodes) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			for (const { type, id, record, version = logKey, nodeId = 1 } of writes) {
				const resource = await TableClass.getResource(id, context);
				if (type === 'delete') resource._writeDelete(id, { nodeId, version });
				else if (type === 'invalidate') resource._writeInvalidate(id, undefined, { nodeId, version });
				else resource._writeUpdate(id, record, true, { isNotification: true, nodeId, version });
			}
		});
	}

	const put = (id, name, extra) => ({ type: 'put', id, record: { id, name }, ...extra });
	const del = (id, extra) => ({ type: 'delete', id, ...extra });
	const indexedIds = async (name) => {
		const ids = [];
		for await (const record of Nodes.search({ conditions: [{ attribute: 'name', value: name }] })) ids.push(record.id);
		return ids;
	};

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Nodes = table({
			table: 'RedeliveredDeletes',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
			audit: true,
		});
		// no indexed attributes, so an invalidation stores a null stub
		Unindexed = table({
			table: 'RedeliveredDeletesUnindexed',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		auditStore = Nodes.primaryStore.rootStore.auditStore;
	});

	it('does not re-log a delete re-delivered onto its own tombstone', async function () {
		if (isLMDB) return this.skip();
		const id = 'redelivered';
		await applyFrame(originClock(), [put(id, 'peer')]);
		const deleteKey = originClock();
		await applyFrame(deleteKey, [del(id)]);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1, 'premise: the first delivery logs the delete');
		for (let i = 0; i < 3; i++) await applyFrame(deleteKey, [del(id)]);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1);
		const tombstone = Nodes.primaryStore.getEntry(id);
		assert.equal(tombstone.value, null);
		assert.equal(tombstone.version, deleteKey);
	});

	it('logs a delete of an absent row once, then treats re-deliveries as applied', async function () {
		if (isLMDB) return this.skip();
		const id = 'never-present';
		const deleteKey = originClock();
		await applyFrame(deleteKey, [del(id)]);
		await applyFrame(deleteKey, [del(id)]);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1);
	});

	it('logs one entry for a frame that carries the same delete many times', async function () {
		if (isLMDB) return this.skip();
		const id = 'echoed';
		await applyFrame(originClock(), [put(id, 'peer')]);
		const deleteKey = originClock();
		await applyFrame(deleteKey, [del(id)]);
		await applyFrame(
			deleteKey,
			Array.from({ length: 50 }, () => del(id))
		);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1);
	});

	it('logs one entry when the first delivery of a delete already carries many copies', async function () {
		const id = 'echoed-first-seen';
		await applyFrame(originClock(), [put(id, 'first-seen')]);
		await applyFrame(
			originClock(),
			Array.from({ length: 50 }, () => del(id))
		);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1);
		assert.equal(Nodes.primaryStore.getEntry(id).value, null);
		assert.deepEqual(await indexedIds('first-seen'), []);
	});

	it('still applies a distinct delete that reuses the tombstone version under a new log key', async function () {
		if (isLMDB) return this.skip(); // LMDB applies at the transaction version
		const id = 'same-version-new-key';
		const version = originClock();
		await applyFrame(originClock(), [del(id, { version })]);
		await applyFrame(originClock(), [del(id, { version })]);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 2);
	});

	it('still applies a same-version delete from a different origin', async function () {
		const id = 'other-origin';
		const deleteKey = originClock();
		await applyFrame(deleteKey, [del(id, { nodeId: 1 })]);
		await applyFrame(deleteKey, [del(id, { nodeId: 2 })]);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 2);
	});

	it('still applies a delete that shares its version with the live record it removes', async function () {
		const id = 'same-version-live';
		const logKey = originClock();
		await applyFrame(logKey, [put(id, 'same-version-live')]);
		await applyFrame(logKey + 1, [del(id, { version: logKey })]);
		assert.equal(Nodes.primaryStore.getEntry(id)?.value, null);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1);
		assert.deepEqual(await indexedIds('same-version-live'), []);
	});

	it('still applies a newer delete from the same origin', async function () {
		const id = 'deleted-twice';
		await applyFrame(originClock(), [del(id)]);
		const newerKey = originClock();
		await applyFrame(newerKey, [del(id)]);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 2);
		assert.equal(Nodes.primaryStore.getEntry(id).version, newerKey);
	});

	// A delete that follows a write in the same transaction is not a tie with its own tombstone, so it
	// applies whenever that write re-applied; these pin convergence, not entry counts.
	for (const [name, writes, expectLive] of [
		['put, delete', (id) => [put(id, 'composite-' + id), del(id)], false],
		['delete, put', (id) => [del(id), put(id, 'composite-' + id)], true],
		['delete, put, delete', (id) => [del(id), put(id, 'composite-' + id), del(id)], false],
	]) {
		it(`converges when a [${name}] transaction is re-delivered`, async function () {
			const id = name.replaceAll(', ', '-');
			await applyFrame(originClock(), [put(id, 'before-' + id)]);
			const logKey = originClock();
			await applyFrame(logKey, writes(id));
			await applyFrame(logKey, writes(id));
			assert.equal(Nodes.primaryStore.getEntry(id).value?.name, expectLive ? 'composite-' + id : undefined);
			assert.deepEqual(await indexedIds('composite-' + id), expectLive ? [id] : []);
			assert.deepEqual(await indexedIds('before-' + id), []);
		});
	}

	for (const [name, writes] of [
		['invalidate, delete', (id) => [{ type: 'invalidate', id }, del(id)]],
		['delete, invalidate, delete', (id) => [del(id), { type: 'invalidate', id }, del(id)]],
	]) {
		it(`deletes the null stub an invalidation left earlier in a [${name}] transaction`, async function () {
			const id = name.replaceAll(', ', '-');
			await applyFrame(originClock(), [put(id, 'present')], Unindexed);
			await applyFrame(originClock(), writes(id), Unindexed);
			const entry = Unindexed.primaryStore.getEntry(id);
			assert.equal(entry.value, null);
			assert.equal(entry.metadataFlags & INVALIDATED, 0, 'the key must hold a tombstone, not an invalidated stub');
		});
	}

	it('applies the rest of a transaction whose delete was already applied on its own', async function () {
		if (isLMDB) return this.skip();
		// the tombstone this write left, but not the put that followed it in the same origin transaction
		const id = 'partially-applied';
		const logKey = originClock();
		await applyFrame(logKey, [del(id)]);
		await applyFrame(logKey, [del(id), put(id, 'after-delete')]);
		assert.equal(Nodes.primaryStore.getEntry(id).value?.name, 'after-delete');
		assert.deepEqual(await indexedIds('after-delete'), [id]);
	});

	it('does not re-log through the replication apply dispatcher', async function () {
		if (isLMDB) return this.skip();
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const id = 'dispatched';
		const putKey = originClock();
		const deleteKey = originClock();
		const markerKey = originClock();
		const frame = (timestamp, writes) => ({ type: 'transaction', timestamp, writes });
		const deleteWrite = { type: 'delete', id, nodeId: 1, version: deleteKey };
		const Dispatched = table({
			table: 'RedeliveredDeletesDispatched',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		Dispatched.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					yield frame(putKey, [{ type: 'put', id, value: { id, name: 'peer' }, nodeId: 1, version: putKey }]);
					yield frame(deleteKey, [deleteWrite]);
					yield frame(
						deleteKey,
						Array.from({ length: 20 }, () => ({ ...deleteWrite }))
					);
					yield frame(markerKey, [
						{ type: 'put', id: 'marker', value: { id: 'marker' }, nodeId: 1, version: markerKey },
					]);
					await held;
				},
			},
			{ intermediateSource: true }
		);
		try {
			await waitFor(() => Dispatched.primaryStore.getEntry('marker')?.value, {
				timeout: 5000,
				message: 'the frames should apply',
			});
			assert.equal(entriesFor(Dispatched, id, 'delete').length, 1);
		} finally {
			release();
		}
	});
});
