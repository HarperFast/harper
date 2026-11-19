require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { INVALIDATED, REPLICA } = require('#src/resources/Table');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { server } = require('#src/server/Server');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// not one of the databases testUtils aliases onto one path: each alias would load its own class
const DATABASE = 'copiedDeleteBoundaryWorkers';
const CONTROL = 'copied-delete-boundary-control';
const REPLY = 'copied-delete-boundary-reply';
const DAY = 86400 * 1000;
// a residency that excludes this node, so a row of it is a stub that can hold a replica
const RESIDENCY_ID = 123;

function fixtureWorker() {
	const worker = new Worker(__dirname + '/fixtures/copiedDeleteBoundaryWorker.cjs', {
		workerData: { database: DATABASE, noServerStart: true, addPorts: [], workerIndex: 1, workerCount: 2 },
	});
	let nextId = 0;
	const pending = new Map();
	worker.on('message', (message) => {
		if (message.type !== REPLY) return;
		pending.get(message.id)?.(message.error ? new Error(message.error) : null, message.result);
	});
	const fail = (error) => {
		for (const settle of pending.values()) settle(error);
	};
	worker.on('error', fail);
	worker.on('exit', (code) => fail(new Error(`fixture worker exited: ${code}`)));
	return {
		worker,
		call(command, details = {}) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => pending.get(id)?.(new Error(`worker command timed out: ${command}`)), 15000);
				pending.set(id, (error, result) => {
					clearTimeout(timer);
					pending.delete(id);
					if (error) reject(error);
					else resolve(result);
				});
				worker.postMessage({ type: CONTROL, id, command, ...details });
			});
		},
	};
}

// A copied delete that loses to a newer head records its boundary on that head at the head's own version, so a
// worker that cached the head before the stamp is still told its copy is current (RecordEncoder.ts
// Entry.copiedDeleteBoundary). Each write below builds a stored row from a base on that worker.
(isLMDB ? describe.skip : describe)(
	'a copied-delete boundary stamped while another worker caches the row',
	function () {
		this.timeout(60000);
		let worker;
		let tables = 0;
		let ids = 0;
		let headOrigin, lateOrigin;

		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			worker = fixtureWorker();
		});
		after(() => worker?.worker.terminate());

		async function declare(source) {
			const T = table({
				database: DATABASE,
				table: `BoundaryRows${++tables}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'extra' }],
			});
			T.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], ['resident-a']);
			headOrigin = getIdOfRemoteNode('boundary-worker-a', T.auditStore);
			lateOrigin = getIdOfRemoteNode('boundary-worker-b', T.auditStore);
			await T.dbisDB.committed;
			await worker.call('init', { table: T.tableName, record: source });
			return T;
		}
		const newId = () => `row-${++ids}`;
		const stored = (T, id) => T.primaryStore.getEntry(id, { uncachedRead: true });

		function fromOrigin(T, id, write, version) {
			const context = { source: {}, sourceApply: true, timestamp: version };
			return transaction(context, async () => write(await T.getResource(id, context, { ensureLoaded: false })));
		}
		const apply = (T, id, record, { version, nodeId = headOrigin }) =>
			fromOrigin(
				T,
				id,
				(resource) => resource._writeUpdate(id, record, false, { isNotification: true, nodeId, version }),
				version
			);
		const copiedDelete = (T, id, version) =>
			fromOrigin(
				T,
				id,
				(resource) =>
					resource._writeDelete(id, { isNotification: true, isCopyApply: true, nodeId: headOrigin, version }),
				version
			);
		async function localStub(T, id, options = { residencyId: RESIDENCY_ID }) {
			const context = {};
			await transaction(context, async () => {
				const resource = await T.getResource(id, context, { ensureLoaded: false });
				resource._writeInvalidate(id, { name: 'stub' }, options);
			});
			return stored(T, id);
		}
		const answer = (entry, body) => ({
			key: entry.key,
			value: { ...entry.value, extra: body },
			version: entry.version,
			originNode: server.hostname,
			fullWriteHead: entry.version,
		});

		async function stampWhileCached(T, id, deleteVersion) {
			const cached = await worker.call('cache', { key: id });
			assert.equal(cached.boundary, undefined);
			await copiedDelete(T, id, deleteVersion);
			const boundary = { version: deleteVersion, nodeId: headOrigin };
			assert.deepEqual(stored(T, id).copiedDeleteBoundary, boundary, 'premise: the stamp is stored');
			const peeked = await worker.call('peek', { key: id });
			assert.equal(peeked.version, cached.version);
			assert.equal(peeked.boundary, undefined, 'premise: the worker is served its pre-stamp copy');
			return boundary;
		}

		it('keeps the boundary under a copy-apply put that worker makes', async () => {
			const T = await declare();
			const id = newId();
			const version = Date.now() + DAY;
			await apply(T, id, { name: 'head' }, { version: version + 2000 });
			const boundary = await stampWhileCached(T, id, version);
			await worker.call('copy-put', {
				key: id,
				record: { id, name: 'copied' },
				version: version + 3000,
				nodeName: 'boundary-worker-a',
			});
			const entry = stored(T, id);
			assert.deepEqual({ ...entry.value }, { id, name: 'copied' });
			assert.deepEqual(entry.copiedDeleteBoundary, boundary);
			await apply(T, id, { extra: 'old' }, { version: version - 1000, nodeId: lateOrigin });
			assert.deepEqual({ ...stored(T, id).value }, { id, name: 'copied' }, 'a write the delete precedes still loses');
		});

		it('keeps the boundary under a source fill of a stub on that worker', async () => {
			const T = await declare({ name: 'from source' });
			const id = newId();
			const stub = await localStub(T, id, {});
			assert.ok(stub.metadataFlags & INVALIDATED, 'premise: a stub head');
			const boundary = await stampWhileCached(T, id, stub.version - 1000);
			assert.equal((await worker.call('source-get', { key: id })).name, 'from source');
			const entry = stored(T, id);
			assert.equal(entry.value.name, 'from source');
			assert.equal(entry.metadataFlags & INVALIDATED, 0, 'premise: the fill replaced the stub');
			assert.deepEqual(entry.copiedDeleteBoundary, boundary);
		});

		it('keeps the boundary when that worker evicts a replica back to a stub', async () => {
			const T = await declare();
			const id = newId();
			const stub = await localStub(T, id);
			assert.equal(await T._storeReplica(stub, answer(stub, 'body')), true);
			// a replica is stored at its stub's version, which marks it reused and uncached; a publish gives it its own
			await T.publish(id, { message: 'replica stays' });
			const head = stored(T, id);
			assert.ok(head.metadataFlags & REPLICA, 'premise: a replica head');
			assert.ok(head.version > stub.version, 'premise: at a version of its own');
			const boundary = await stampWhileCached(T, id, head.version - 1000);
			await worker.call('evict', { key: id });
			const entry = stored(T, id);
			assert.ok(entry.metadataFlags & INVALIDATED, 'premise: demoted to a stub');
			assert.equal(entry.metadataFlags & REPLICA, 0, 'premise: demoted to a stub');
			assert.deepEqual(entry.copiedDeleteBoundary, boundary);
		});

		it('keeps the boundary when that worker refills a stub with a replica', async () => {
			const T = await declare();
			const id = newId();
			const stub = await localStub(T, id);
			const boundary = await stampWhileCached(T, id, stub.version - 1000);
			const result = await worker.call('store-replica', {
				key: id,
				record: { extra: 'body' },
				nodeName: server.hostname,
			});
			assert.equal(result.stored, true, 'premise: the refill is stored');
			const entry = stored(T, id);
			assert.ok(entry.metadataFlags & REPLICA);
			assert.deepEqual(entry.copiedDeleteBoundary, boundary);
		});
	}
);

(isLMDB ? describe.skip : describe)('a copy-apply put reads its base once, from the store', function () {
	let T, origin;
	let ids = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			database: DATABASE,
			table: 'CopyApplyBase',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		origin = getIdOfRemoteNode('boundary-worker-a', T.auditStore);
	});

	// the options replication's writeUpdate (Table.ts sourcedFrom) passes for a base-copy frame
	const copyOptions = (version, nodeId = origin) => ({
		isNotification: true,
		ensureLoaded: false,
		nodeId,
		version,
		isCopyApply: true,
	});
	const copyPut = (id, record, version, during) => {
		const options = copyOptions(version);
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context, options);
			await during?.();
			return resource._writeUpdate(id, record, true, options);
		});
	};

	it('with one read of an existing row', async () => {
		const version = Date.now() + DAY;
		const id = `base-${++ids}`;
		await copyPut(id, { id, name: 'first' }, version);
		T.primaryStore.getEntry(id); // warm the cache
		const before = T.primaryStore.readCount;
		await copyPut(id, { id, name: 'second' }, version + 1000);
		assert.equal(T.primaryStore.readCount - before, 1);
		assert.equal(T.primaryStore.getEntry(id).value.name, 'second');
	});

	it('keeps a boundary stamped between its read and its commit', async () => {
		const id = `base-${++ids}`;
		const version = Date.now() + DAY;
		await copyPut(id, { id, name: 'head' }, version + 2000);
		await copyPut(id, { id, name: 'copied' }, version + 3000, () => {
			const context = { source: {}, sourceApply: true, timestamp: version };
			return transaction(context, async () => {
				const resource = await T.getResource(id, context, { ensureLoaded: false });
				return resource._writeDelete(id, { isNotification: true, isCopyApply: true, nodeId: origin, version });
			});
		});
		const entry = T.primaryStore.getEntry(id, { uncachedRead: true });
		assert.equal(entry.value.name, 'copied');
		assert.deepEqual(entry.copiedDeleteBoundary, { version, nodeId: origin });
	});
});
