// A publish adds a message to the audit log and leaves the record as it was: its value and indexes,
// its expiration, residency id and stub/replica flags.
// In a transaction it applies to what earlier writes to the key left, not to the pre-transaction record.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { INVALIDATED } = require('#src/resources/Table');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { server } = require('#src/server/Server');

const add = (value) => ({ __op__: 'add', value });

async function collect(iterable) {
	const out = [];
	for await (const item of iterable) out.push(item);
	return out;
}

describe('publish leaves the record unchanged', function () {
	this.timeout(10000);
	let T, Unaudited, nodeA;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'PublishRecordState',
			database: 'publishRecordState',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag', indexed: true }, { name: 'body' }],
			audit: true,
		});
		if (T.indexingOperation) await T.indexingOperation;
		Unaudited = table({
			table: 'PublishRecordStateUnaudited',
			database: 'publishRecordState',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
			audit: false,
		});
		if (Unaudited.indexingOperation) await Unaudited.indexingOperation;
		nodeA = getIdOfRemoteNode('publish-state-a', T.auditStore);
	});

	/** Apply one origin transaction's writes as replication does. */
	function applyFromOrigin(id, writes, { version, nodeId }) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			for (const [type, value, options] of writes) {
				const resource = await T.getResource({ id }, context);
				const writeOptions = { isNotification: true, nodeId, version, ...options };
				if (type === 'message') resource._writePublish(id, value, writeOptions);
				else await resource._writeUpdate(id, value, false, writeOptions);
			}
		});
	}

	function messageAuditEntries(id) {
		return [...T.auditStore.getRange({ start: 1 })].filter(
			(entry) => entry.recordId === id && entry.type === 'message'
		);
	}

	async function idsTagged(tag) {
		return (await collect(T.search({ conditions: [{ attribute: 'tag', value: tag }] }))).map((record) => record.id);
	}

	async function assertStoredAndIndexed(id, tag) {
		const record = await T.get(id);
		assert.strictEqual(record?.tag, tag, `stored record is ${JSON.stringify(record)}`);
		assert.ok((await idsTagged(tag)).includes(id), `${id} is not indexed under ${tag}`);
	}

	it('a put then a publish on one instance in a transaction keeps the put', async () => {
		await T.put({ id: 'instance', tag: 'v1' });
		const context = {};
		await transaction(context, async () => {
			const resource = await T.getResource({ id: 'instance' }, context);
			await resource.put({ id: 'instance', tag: 'v2' });
			await resource.publish({ note: 'after put' });
		});
		await assertStoredAndIndexed('instance', 'v2');
		assert.deepStrictEqual(await idsTagged('v1'), []);
	});

	it('a put then a publish through the table in a transaction keeps the put', async () => {
		await T.put({ id: 'static', tag: 'v1' });
		const context = {};
		await transaction(context, async () => {
			await T.put({ id: 'static', tag: 'v2' }, context);
			await T.publish('static', { note: 'after put' }, context);
		});
		await assertStoredAndIndexed('static', 'v2');
	});

	it('a create then a publish in a transaction keeps the created record', async () => {
		const context = {};
		await transaction(context, async () => {
			await T.put({ id: 'created', tag: 'fresh' }, context);
			await T.publish('created', { note: 'after create' }, context);
		});
		await assertStoredAndIndexed('created', 'fresh');
	});

	it('a patch then a publish in a transaction keeps the patch', async () => {
		await T.put({ id: 'patched', tag: 'v1', body: 'kept' });
		const context = {};
		await transaction(context, async () => {
			await T.patch('patched', { tag: 'v2' }, context);
			await T.publish('patched', { note: 'after patch' }, context);
		});
		await assertStoredAndIndexed('patched', 'v2');
		assert.strictEqual((await T.get('patched')).body, 'kept');
	});

	it('a publish then a put in a transaction applies the put', async () => {
		await T.put({ id: 'publish-first', tag: 'v1' });
		const context = {};
		await transaction(context, async () => {
			await T.publish('publish-first', { note: 'before put' }, context);
			await T.put({ id: 'publish-first', tag: 'v2' }, context);
		});
		await assertStoredAndIndexed('publish-first', 'v2');
	});

	it('on an unaudited table, a publish then a put or create in a transaction applies them', async () => {
		await Unaudited.put({ id: 'existing', tag: 'v1' });
		const context = {};
		await transaction(context, async () => {
			await Unaudited.publish('existing', { note: 'before put' }, context);
			await Unaudited.put({ id: 'existing', tag: 'v2' }, context);
			await Unaudited.publish('new', { note: 'before create' }, context);
			await Unaudited.create({ id: 'new', tag: 'fresh' }, context);
		});
		assert.strictEqual((await Unaudited.get('existing'))?.tag, 'v2');
		assert.strictEqual((await Unaudited.get('new'))?.tag, 'fresh');
	});

	it('a re-delivered origin transaction of a message and an increment applies the increment once', async () => {
		const version = Date.now() + 86_400_000;
		await T.put({ id: 'counter', tag: 'v1', count: 1 });
		const writes = [
			['message', { note: 'counted' }],
			['patch', { count: add(1) }],
		];
		await applyFromOrigin('counter', writes, { version, nodeId: nodeA });
		assert.strictEqual((await T.get('counter')).count, 2);
		await applyFromOrigin('counter', writes, { version, nodeId: nodeA });
		assert.strictEqual((await T.get('counter')).count, 2, 'the re-delivered increment was applied again');
	});

	it('keeps the local-only flag an invalidation or delete earlier in the transaction stored', async () => {
		await T.put({ id: 'local-stub', tag: 'v1' });
		await T.put({ id: 'local-tombstone', tag: 'v1' });
		const context = {};
		await transaction(context, async () => {
			const stub = await T.getResource({ id: 'local-stub' }, context);
			stub._writeInvalidate('local-stub', undefined, { localOnly: true });
			stub._writePublish('local-stub', { note: 'after invalidate' });
			const tombstone = await T.getResource({ id: 'local-tombstone' }, context);
			tombstone._writeDelete('local-tombstone', { localOnly: true });
			tombstone._writePublish('local-tombstone', { note: 'after delete' });
		});
		const stub = T.primaryStore.getEntry('local-stub');
		assert.ok(stub.metadataFlags & INVALIDATED);
		assert.ok(stub.metadataFlags & LOCAL_ONLY, 'the stub lost its local-only flag');
		const tombstone = T.primaryStore.getEntry('local-tombstone');
		assert.strictEqual(tombstone.value, null);
		assert.ok(tombstone.metadataFlags & LOCAL_ONLY, 'the tombstone lost its local-only flag');
	});

	it("a message's residency routes the message and leaves the record's own", async () => {
		const residencyId = 4712;
		T.dbisDB.putSync([Symbol.for('residency_by_id'), residencyId], [server.hostname]);
		await T.put({ id: 'unscoped', tag: 'v1' });
		const context = {};
		await transaction(context, async () => {
			const resource = await T.getResource({ id: 'unscoped' }, context);
			resource._writePublish('unscoped', { note: 'scoped message' }, { residencyId });
		});
		assert.ok(!T.primaryStore.getEntry('unscoped').residencyId, 'the record took the message residency');
		assert.strictEqual(messageAuditEntries('unscoped').at(-1).residencyId, residencyId);
	});

	it('keeps the expiration', async () => {
		const expiresAt = Date.now() + 3_600_000;
		await T.put({ id: 'expiring', tag: 'v1' }, { expiresAt });
		assert.strictEqual(T.primaryStore.getEntry('expiring').expiresAt, expiresAt);
		await T.publish('expiring', { note: 'message' });
		assert.strictEqual(T.primaryStore.getEntry('expiring').expiresAt, expiresAt);
	});

	it('keeps the residency id', async () => {
		const residencyId = 4711;
		T.dbisDB.putSync([Symbol.for('residency_by_id'), residencyId], [server.hostname]);
		const context = {};
		await transaction(context, async () => {
			const resource = await T.getResource({ id: 'resident' }, context);
			resource._writeUpdate('resident', { id: 'resident', tag: 'v1' }, true, { residencyId });
		});
		assert.strictEqual(T.primaryStore.getEntry('resident').residencyId, residencyId);
		await T.publish('resident', { note: 'message' });
		assert.strictEqual(T.primaryStore.getEntry('resident').residencyId, residencyId);
		assert.ok(!messageAuditEntries('resident').at(-1).residencyId, 'the message took the record residency');
	});

	it('keeps an invalidated stub invalidated', async () => {
		await T.put({ id: 'stub', tag: 'v1', body: 'complete' });
		await T.invalidate('stub');
		const stub = T.primaryStore.getEntry('stub');
		assert.ok(stub.metadataFlags & INVALIDATED);
		await T.publish('stub', { note: 'message' });
		const after = T.primaryStore.getEntry('stub');
		assert.ok(after.metadataFlags & INVALIDATED, 'the publish turned the stub into a full-looking record');
		assert.strictEqual(after.value.body, undefined);
	});
});
