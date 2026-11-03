require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { INVALIDATED } = require('#src/resources/Table');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { hostname } = require('node:os');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

function indexedCreatedTimes(Table, id) {
	return Array.from(Table.indices.createdAt.getRange({}))
		.filter(({ value }) => value === id)
		.map(({ key }) => key);
}

function watchConflicts(Table, id) {
	const watch = { conflicts: 0 };
	if (isLMDB) {
		const { primaryStore } = Table;
		const originalIfVersion = primaryStore.ifVersion;
		primaryStore.ifVersion = function (key, version, callback, options) {
			const resolution = originalIfVersion.call(this, key, version, callback, options);
			if (key === id)
				resolution.then(
					(committed) => !committed && watch.conflicts++,
					() => {}
				);
			return resolution;
		};
		watch.restore = () => (primaryStore.ifVersion = originalIfVersion);
	} else {
		const { Transaction, constants } = require('../rocksdbBindings.mts').rocksdbBindings();
		const originalCommit = Transaction.prototype.commit;
		const targetDb = Table.primaryStore.store.db;
		Transaction.prototype.commit = function (...args) {
			const resolution = originalCommit.apply(this, args);
			if (this.store?.db === targetDb)
				resolution.then(
					// a coordinated-retry commit resolves with this instead of rejecting
					(result) => result === constants.RETRY_NOW_VALUE && watch.conflicts++,
					() => watch.conflicts++
				);
			return resolution;
		};
		watch.restore = () => (Transaction.prototype.commit = originalCommit);
	}
	return watch;
}

// `later` takes the newer timestamp but reads its base before `earlier` commits, so its own commit conflicts
// and the retry applies it, in order, over what `earlier` left.
async function commitOverEarlier(Table, id, earlier, later) {
	const staged = (write) => {
		let commit, stage;
		const context = {};
		const isStaged = new Promise((resolve) => (stage = resolve));
		const gate = new Promise((resolve) => (commit = resolve));
		const committed = transaction(context, async () => {
			await write(context);
			stage();
			await gate;
		});
		return isStaged.then(() => ({ commit: () => (commit(), committed) }));
	};
	const first = await staged(earlier);
	const second = await staged(later);
	await first.commit();
	const earlierRecord = Table.primaryStore.getEntry(id)?.value;
	const watch = watchConflicts(Table, id);
	try {
		await second.commit();
	} finally {
		watch.restore();
	}
	return { conflicts: watch.conflicts, earlierRecord };
}

function lastLoggedWrite(Table, id) {
	let last;
	for (const entry of Table.auditStore.getRange({ start: 1 })) if (entry.recordId === id) last = entry;
	return { version: last.version, value: { ...last.getValue(Table.primaryStore) } };
}

// a log key unequal to the record version, as a write applied from a peer can carry
async function applyFromPeer(Table, id, delta, version) {
	const nodeId = getIdOfRemoteNode('created-time-peer', Table.auditStore);
	const context = { source: {}, sourceApply: true, timestamp: version - 5 };
	await transaction(context, async () => {
		const resource = await Table.getResource(id, context);
		return resource._writeUpdate(id, delta, false, { isNotification: true, nodeId, version });
	});
}

describe('@createdTime follows the record a write lands on', function () {
	this.timeout(10_000);
	let Item,
		Replica,
		Stringly,
		sequence = 0;
	const nextId = (label) => `${label}-${++sequence}`;
	const attributes = (createdAtType = 'Float') => [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'name' },
		{ name: 'sku', indexed: true },
		{ name: 'createdAt', type: createdAtType, assignCreatedTime: true, indexed: true },
		{ name: 'updatedAt', type: 'Float', assignUpdatedTime: true },
	];
	const recordOf = (Table, id) => {
		const entry = Table.primaryStore.getEntry(id);
		return entry?.value && { ...entry.value };
	};

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		const define = (name, createdAtType) =>
			table({ database: 'createdTimeBase', table: name, attributes: attributes(createdAtType), audit: true });
		Item = define('CreatedTimeBase');
		Replica = define('CreatedTimeBaseReplica');
		Stringly = define('CreatedTimeBaseString', 'String');
	});

	describe('over an invalidation stub of a record that was never stored', () => {
		for (const [label, write] of [
			['a put', (id) => Item.put(id, { id, name: 'put', sku: 'P' })],
			['a patch', (id) => Item.patch(id, { name: 'patch', sku: 'P' })],
		]) {
			it(`${label} stamps the created time and indexes it`, async () => {
				const id = nextId('absent');
				await Item.invalidate(id);
				const stub = Item.primaryStore.getEntry(id);
				assert.ok(stub.metadataFlags & INVALIDATED, 'the invalidation left a stub');
				assert.equal(stub.value?.createdAt, undefined);
				await write(id);
				const entry = Item.primaryStore.getEntry(id);
				assert.equal(entry.value.createdAt, entry.version, `no created time on ${JSON.stringify(entry.value)}`);
				assert.deepEqual(indexedCreatedTimes(Item, id), [entry.version]);
			});
		}
	});

	describe('over an invalidation stub of a stored record', () => {
		for (const [label, write] of [
			['a put', (id) => Item.put(id, { id, name: 'put', sku: 'P' })],
			['a patch', (id) => Item.patch(id, { name: 'patch' })],
		]) {
			it(`${label} keeps the original created time`, async () => {
				const id = nextId('resident');
				await Item.put(id, { id, name: 'original', sku: 'O' });
				const original = Item.primaryStore.getEntry(id).value.createdAt;
				await Item.invalidate(id);
				assert.equal(Item.primaryStore.getEntry(id).value.createdAt, original, 'the stub carries the created time');
				await write(id);
				assert.equal(Item.primaryStore.getEntry(id).value.createdAt, original);
				assert.deepEqual(indexedCreatedTimes(Item, id), [original]);
			});
		}
	});

	it('a patch over a residency stub logs no created time over the residents’ own', async () => {
		const self = global.server.hostname || hostname();
		const minter = nextId('minter');
		Item.setResidency(() => ['created-time-resident', self]);
		try {
			await Item.put(minter, { id: minter, name: 'minter', sku: 'M' });
		} finally {
			Item.setResidency(undefined);
		}
		const { residencyId } = Item.primaryStore.getEntry(minter);
		const id = nextId('elsewhere');
		const version = Date.now();
		const nodeId = getIdOfRemoteNode('created-time-peer', Item.auditStore);
		const context = { source: {}, sourceApply: true, timestamp: version };
		await transaction(context, async () => {
			const resource = await Item.getResource(id, context);
			resource._writeInvalidate(id, undefined, { residencyId, nodeId, version });
		});
		const stub = Item.primaryStore.getEntry(id);
		assert.ok(stub.metadataFlags & INVALIDATED && stub.residencyId, 'the invalidation left a residency stub');
		assert.equal(stub.value.createdAt, undefined);
		await Item.patch(id, { name: 'local' });
		const logged = lastLoggedWrite(Item, id);
		assert.equal(logged.value.name, 'local');
		assert.equal(logged.value.createdAt, undefined);
	});

	describe('a patch that recreates a deleted record', () => {
		function assertRecreated(Table, id, version = Table.primaryStore.getEntry(id)?.version) {
			const stored = Table.primaryStore.getEntry(id)?.value;
			assert.ok(stored, 'the patch recreated the record');
			assert.equal(stored.id, id, `stored without its primary key: ${JSON.stringify(stored)}`);
			assert.equal(stored.createdAt, version, `wrong created time on ${JSON.stringify(stored)}`);
			assert.deepEqual(indexedCreatedTimes(Table, id), [version]);
		}

		it('after a conflict retry that read the live record, on the writer and on a replica applying its log', async () => {
			const id = nextId('raced');
			await Item.put(id, { id, name: 'original', sku: 'O' });
			const { conflicts } = await commitOverEarlier(
				Item,
				id,
				(context) => Item.delete(id, context),
				(context) => Item.patch(id, { name: 'patched', sku: 'S' }, context)
			);
			assert.ok(conflicts > 0, 'the patch was not retried after a conflict');
			assertRecreated(Item, id);
			const logged = lastLoggedWrite(Item, id);
			assert.deepEqual(
				{ id: logged.value.id, createdAt: logged.value.createdAt },
				{ id: undefined, createdAt: undefined },
				'the logged delta is the one the first attempt prepared'
			);
			await applyFromPeer(Replica, id, logged.value, logged.version);
			assertRecreated(Replica, id, Item.primaryStore.getEntry(id).version);
			assert.deepEqual(recordOf(Replica, id), recordOf(Item, id));
		});

		it('after the delete committed', async () => {
			const id = nextId('sequential');
			await Item.put(id, { id, name: 'original', sku: 'O' });
			await Item.delete(id);
			await Item.patch(id, { name: 'patched' });
			assertRecreated(Item, id);
		});

		it('in the transaction that deleted it', async () => {
			const id = nextId('same-transaction');
			await Item.put(id, { id, name: 'original', sku: 'O' });
			const context = {};
			await transaction(context, async () => {
				await Item.delete(id, context);
				await Item.patch(id, { name: 'patched' }, context);
			});
			assertRecreated(Item, id);
		});

		it('formats the created time as its attribute’s type', async () => {
			const id = nextId('string');
			await Stringly.put(id, { id, name: 'original', sku: 'O' });
			await Stringly.delete(id);
			await Stringly.patch(id, { name: 'patched' });
			assertRecreated(Stringly, id, new Date(Stringly.primaryStore.getEntry(id).version).toISOString());
		});

		it('leaves a live record’s created time and the caller’s delta alone', async () => {
			const id = nextId('live');
			await Item.put(id, { id, name: 'original', sku: 'O' });
			const original = Item.primaryStore.getEntry(id).value.createdAt;
			const delta = { name: 'patched' };
			await Item.patch(id, delta);
			assert.equal(Item.primaryStore.getEntry(id).value.createdAt, original);
			assert.deepEqual(indexedCreatedTimes(Item, id), [original]);

			const absent = nextId('absent-delta');
			const applied = { name: 'applied' };
			const version = Date.now();
			await applyFromPeer(Replica, absent, applied, version);
			assertRecreated(Replica, absent, version);
			assert.deepEqual(applied, { name: 'applied' });
		});
	});
});
