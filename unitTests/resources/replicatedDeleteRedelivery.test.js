// A replicated write re-delivered onto the state it already produced must not re-log: in a mesh every
// re-logged copy is new log tail that peers forward and re-log in turn (harper-pro#826, harper-pro#1306).
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { INVALIDATED } = require('#src/resources/Table');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { getAuditFloor } = require('#src/resources/auditStore');
const { waitFor } = require('../waitFor.js');

// LMDB keys its log by local time, so a stored tombstone carries no origin log key to tie a later
// delivery against; only copies inside one apply transaction collapse there.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Re-delivered replicated writes (harper-pro#826, harper-pro#1306)', () => {
	let Nodes, Unindexed, auditStore, peerNodeId, otherPeerNodeId;

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
			for (const { type, id, record, version = logKey, nodeId = peerNodeId, isCopyApply } of writes) {
				const resource = await TableClass.getResource(id, context);
				if (type === 'delete') resource._writeDelete(id, { nodeId, version });
				else if (type === 'invalidate') resource._writeInvalidate(id, record, { nodeId, version });
				else if (type === 'relocate') resource._writeRelocate(id, { nodeId, version });
				else resource._writeUpdate(id, record, type === 'put', { isNotification: true, nodeId, version, isCopyApply });
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
		// an id with no mapped node name is this node's own, and a local write mints its log key;
		// a same-version tie goes to the later node name, so the other peer's name sorts last
		peerNodeId = getIdOfRemoteNode('redelivery-peer-a', auditStore);
		otherPeerNodeId = getIdOfRemoteNode('redelivery-peer-b', auditStore);
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
		await applyFrame(deleteKey, [del(id, { nodeId: peerNodeId })]);
		await applyFrame(deleteKey, [del(id, { nodeId: otherPeerNodeId })]);
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

	it('does not re-log a re-delivered [put, delete] once the put is recognized as applied', async function () {
		if (isLMDB) return this.skip();
		const id = 'put-delete-counted';
		const logKey = originClock();
		await applyFrame(logKey, [put(id, 'counted'), del(id)]);
		// the put's dedup reads the log by key, which can lag a just-committed entry (harper#1137)
		await waitFor(() => auditStore.get(logKey, Nodes.tableId, id, peerNodeId), {
			message: 'the entries become readable',
		});
		await applyFrame(logKey, [put(id, 'counted'), del(id)]);
		assert.equal(entriesFor(Nodes, id, 'put').length, 1);
		assert.equal(entriesFor(Nodes, id, 'delete').length, 1);
	});

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
		const deleteWrite = { type: 'delete', id, nodeId: peerNodeId, version: deleteKey };
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
					yield frame(putKey, [{ type: 'put', id, value: { id, name: 'peer' }, nodeId: peerNodeId, version: putKey }]);
					yield frame(deleteKey, [deleteWrite]);
					yield frame(
						deleteKey,
						Array.from({ length: 20 }, () => ({ ...deleteWrite }))
					);
					yield frame(markerKey, [
						{ type: 'put', id: 'marker', value: { id: 'marker' }, nodeId: peerNodeId, version: markerKey },
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

	const invalidate = (id, name, extra) => ({ type: 'invalidate', id, record: name && { id, name }, ...extra });
	// below the audit floor an older plain patch is dropped unwalked, so the patch tests key above it
	function recentClock() {
		let key = Date.now();
		return () => (key += 1000);
	}

	it('does not re-log an invalidate re-delivered onto its own stub', async function () {
		if (isLMDB) return this.skip();
		const id = 'invalidated-redelivered';
		await applyFrame(originClock(), [put(id, 'resident')]);
		const invalidateKey = originClock();
		await applyFrame(invalidateKey, [invalidate(id, 'stub')]);
		for (let i = 0; i < 3; i++) await applyFrame(invalidateKey, [invalidate(id, 'stub')]);
		assert.equal(entriesFor(Nodes, id, 'invalidate').length, 1);
		const stub = Nodes.primaryStore.getEntry(id);
		assert.equal(stub.version, invalidateKey);
		assert.equal(stub.metadataFlags & INVALIDATED, INVALIDATED);
		assert.deepEqual(await indexedIds('stub'), [id]);
	});

	it('applies two invalidates of one origin transaction in program order, then treats a re-delivery as applied', async function () {
		const id = 'invalidated-twice';
		await applyFrame(originClock(), [put(id, 'resident')]);
		const logKey = originClock();
		const frame = [invalidate(id, 'first'), invalidate(id, 'second')];
		await applyFrame(logKey, frame);
		assert.deepEqual(await indexedIds('second'), [id]);
		assert.deepEqual(await indexedIds('first'), []);
		if (isLMDB) return;
		const logged = entriesFor(Nodes, id, 'invalidate').length;
		await applyFrame(logKey, frame);
		assert.equal(entriesFor(Nodes, id, 'invalidate').length, logged);
		assert.deepEqual(await indexedIds('second'), [id]);
	});

	it('does not re-log an invalidate whose log key differs from its version', async function () {
		if (isLMDB) return this.skip();
		const id = 'invalidated-dual-clock';
		const version = originClock();
		const logKey = originClock();
		await applyFrame(logKey, [invalidate(id, 'dual-clock', { version })]);
		for (let i = 0; i < 3; i++) await applyFrame(logKey, [invalidate(id, 'dual-clock', { version })]);
		assert.equal(entriesFor(Nodes, id, 'invalidate').length, 1);
		assert.equal(Nodes.primaryStore.getEntry(id).version, version);
	});

	it('still applies two invalidates that share a version under different log keys', async function () {
		if (isLMDB) return this.skip();
		const id = 'invalidated-shared-version';
		const version = originClock();
		await applyFrame(originClock(), [invalidate(id, 'first-key', { version })]);
		await applyFrame(originClock(), [invalidate(id, 'second-key', { version })]);
		assert.equal(entriesFor(Nodes, id, 'invalidate').length, 2);
		assert.deepEqual(await indexedIds('second-key'), [id]);
	});

	it('does not re-log an invalidate onto its stub after an older patch folded into it', async function () {
		if (isLMDB) return this.skip();
		const Folded = table({
			table: 'RedeliveredFoldedStub',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
			audit: true,
		});
		const clock = recentClock();
		const [patchKey, invalidateKey] = [clock(), clock()];
		const id = 'folded-stub';
		await applyFrame(invalidateKey, [invalidate(id, 'stub')], Folded);
		await applyFrame(patchKey, [{ type: 'patch', id, record: { name: 'folded' }, nodeId: otherPeerNodeId }], Folded);
		assert.ok(Folded.primaryStore.getEntry(id).additionalAuditRefs?.length, 'premise: the stub carries a ref');
		const invalidations = () => entriesFor(Folded, id, 'invalidate').length;
		const logged = invalidations();
		for (let i = 0; i < 3; i++) await applyFrame(invalidateKey, [invalidate(id, 'stub')], Folded);
		assert.equal(invalidations(), logged);
	});

	it('re-delivers a [delete, invalidate] transaction to the stub it left', async function () {
		const id = 'delete-invalidate';
		await applyFrame(originClock(), [put(id, 'resident')]);
		const logKey = originClock();
		const frame = [del(id), invalidate(id, 'stub-after-delete')];
		await applyFrame(logKey, frame);
		await applyFrame(logKey, frame);
		const entry = Nodes.primaryStore.getEntry(id);
		assert.equal(entry.metadataFlags & INVALIDATED, INVALIDATED);
		assert.deepEqual(await indexedIds('stub-after-delete'), [id]);
	});

	it('re-delivers a [relocate, invalidate] transaction whose version differs from its log key to the stub it left', async function () {
		const id = 'relocate-invalidate';
		await applyFrame(originClock(), [put(id, 'resident-before-relocate')]);
		const version = originClock();
		const logKey = originClock();
		const frame = [{ type: 'relocate', id, version }, invalidate(id, 'stub-after-relocate', { version })];
		await applyFrame(logKey, frame);
		assert.equal(Nodes.primaryStore.getEntry(id).metadataFlags & INVALIDATED, INVALIDATED, 'premise');
		await applyFrame(logKey, frame);
		const entry = Nodes.primaryStore.getEntry(id);
		assert.equal(entry.metadataFlags & INVALIDATED, INVALIDATED);
		assert.deepEqual(await indexedIds('stub-after-relocate'), [id]);
	});

	it('applies an invalidate whose transaction committed only an earlier put to the key', async function () {
		const id = 'put-then-invalidate';
		const logKey = originClock();
		await applyFrame(logKey, [put(id, 'resident-first')]);
		await applyFrame(logKey, [invalidate(id, 'stub-second')]);
		assert.equal(Nodes.primaryStore.getEntry(id).metadataFlags & INVALIDATED, INVALIDATED);
		assert.deepEqual(await indexedIds('stub-second'), [id]);
	});

	it('still applies a same-version invalidate from a different origin', async function () {
		const id = 'invalidated-by-two';
		const logKey = originClock();
		await applyFrame(logKey, [invalidate(id, 'peer-a', { nodeId: peerNodeId })]);
		await applyFrame(logKey, [invalidate(id, 'peer-b', { nodeId: otherPeerNodeId })]);
		assert.equal(entriesFor(Nodes, id, 'invalidate').length, 2);
		assert.deepEqual(await indexedIds('peer-b'), [id]);
	});

	it('does not re-log a late-relayed older patch that newer patches fully supersede', async function () {
		if (isLMDB) return this.skip();
		const Superseded = table({
			table: 'RedeliveredSupersededPatch',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'other' }],
			audit: true,
		});
		const clock = recentClock();
		const lateOrigin = getIdOfRemoteNode('redelivery-superseded-origin', auditStore);
		const id = 'superseded-patch';
		const [baseKey, lateKey, firstLateOriginKey, newerKey] = [clock(), clock(), clock(), clock()];
		await applyFrame(
			firstLateOriginKey,
			[{ type: 'put', id: 'superseded-origin-first', record: { id: 'superseded-origin-first' }, nodeId: lateOrigin }],
			Superseded
		);
		await applyFrame(baseKey, [{ type: 'put', id, record: { id, name: 'base', other: 0 } }], Superseded);
		await applyFrame(newerKey, [{ type: 'patch', id, record: { name: 'newer' } }], Superseded);
		const latePatch = { type: 'patch', id, record: { name: 'late' }, nodeId: lateOrigin };
		await applyFrame(lateKey, [latePatch], Superseded);
		const lateEntries = () => entriesFor(Superseded, id, 'patch').filter((entry) => entry.txnLogKey === lateKey);
		assert.equal(lateEntries().length, 1, 'premise: the first delivery logs the superseded patch');
		for (let i = 0; i < 3; i++) await applyFrame(lateKey, [latePatch], Superseded);
		assert.equal(lateEntries().length, 1);
		assert.equal(Superseded.primaryStore.getEntry(id).value.name, 'newer');
	});

	it('does not re-log a late-relayed older patch whose record a base copy rewrote', async function () {
		if (isLMDB) return this.skip();
		const Patched = table({
			table: 'RedeliveredLatePatch',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'other' }],
			audit: true,
		});
		const clock = recentClock();
		const lateOrigin = getIdOfRemoteNode('redelivery-late-origin', auditStore);
		const copySource = getIdOfRemoteNode('redelivery-copy-source', auditStore);
		const id = 'late-patch';
		const [baseKey, lateKey, firstLateOriginKey, newerKey, copyKey] = [clock(), clock(), clock(), clock(), clock()];
		await applyFrame(
			firstLateOriginKey,
			[{ type: 'put', id: 'late-origin-first', record: { id: 'late-origin-first' }, nodeId: lateOrigin }],
			Patched
		);
		await applyFrame(baseKey, [{ type: 'put', id, record: { id, name: 'base', other: 0 } }], Patched);
		await applyFrame(newerKey, [{ type: 'patch', id, record: { other: 1 } }], Patched);
		const latePatch = { type: 'patch', id, record: { name: 'late' }, nodeId: lateOrigin };
		await applyFrame(lateKey, [latePatch], Patched);
		const lateEntries = () => entriesFor(Patched, id, 'patch').filter((entry) => entry.txnLogKey === lateKey);
		assert.equal(lateEntries().length, 1, 'premise: the first delivery logs the late patch');
		assert.ok(getAuditFloor(auditStore) <= lateKey, 'premise: the late key is at or above the audit floor');
		for (const entry of auditStore.getRange({ start: 1, log: lateOrigin })) {
			assert.ok(entry.txnLogKey > lateKey, 'premise: the late origin log starts above the late key');
			break;
		}
		await applyFrame(
			copyKey,
			[{ type: 'put', id, record: { id, name: 'copied', other: 2 }, nodeId: copySource, isCopyApply: true }],
			Patched
		);
		assert.ok(
			!Patched.primaryStore.getEntry(id).additionalAuditRefs?.some((ref) => ref.version === lateKey),
			'premise: no ref on the record names the late patch'
		);
		for (let i = 0; i < 3; i++) await applyFrame(lateKey, [latePatch], Patched);
		assert.equal(lateEntries().length, 1);
	});
});
