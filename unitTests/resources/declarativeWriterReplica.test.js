require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, openReplicaDeadlineStore } = require('#src/resources/databases');
const { INVALIDATED, REPLICA, setMinReplicaScanIntervalForTesting } = require('#src/resources/Table');
const { transaction } = require('#src/resources/transaction');
const { replicationConfirmation } = require('#src/resources/DatabaseTransaction');
const { setResidencyPlacementGuard } = require('#src/resources/residencyMaps');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { server } = require('#src/server/Server');
const env = require('#src/utility/environment/environmentManager');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Declarative writer replicas', function () {
	this.timeout(10000);
	let priorShards, priorList, priorShard;
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setMinReplicaScanIntervalForTesting(20);
		priorShards = server.shards;
		priorList = env.get('replication_shards');
		priorShard = env.get('replication_shard');
		env.setProperty('replication_shards', [0, 1]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([
			[0, [{ name: server.hostname }]],
			[1, [{ name: 'writer-replica-owner' }]],
		]);
	});
	afterEach(() => {
		setResidencyPlacementGuard(undefined);
		replicationConfirmation(undefined);
	});
	after(() => {
		setMinReplicaScanIntervalForTesting(undefined);
		server.shards = priorShards;
		env.setProperty('replication_shards', priorList);
		env.setProperty('replication_shard', priorShard);
	});
	async function declare(expiration = 3600) {
		const name = `WriterReplica${++sequence}`;
		await loadGQLSchema(`type ${name} @table(database: "writer_replicas", replicaExpiration: ${expiration})
			@residency(slots: 2, byAttribute: true, slotFrom: "region") {
			id: ID @primaryKey region: Int @indexed body: Any
		}`);
		return databases.writer_replicas[name];
	}
	async function invalidate(Rows, id, version) {
		const context = {};
		await transaction(context, async () => {
			const row = await Rows.getResource(id, context, { ensureLoaded: false });
			row._writeInvalidate(id, { id, region: 1 }, { version, residencySlot: 1 });
		});
	}
	for (const expiration of [0, 3600]) {
		it(`retains complete writes only when replicas are enabled (${expiration})`, async () => {
			const Rows = await declare(expiration);
			Rows.sourcedFrom({
				load() {
					throw new Error('owner delivery held');
				},
			});
			await Rows.put('row', { id: 'row', region: 1, body: 'complete' });
			const entry = Rows.primaryStore.getEntry('row');
			const replica = !isLMDB && expiration > 0;
			assert.equal(Boolean(entry.metadataFlags & REPLICA), replica);
			assert.equal(Boolean(entry.metadataFlags & INVALIDATED), !replica);
			assert.equal(entry.value.body, replica ? 'complete' : undefined);
			if (replica) assert.equal((await Rows.get('row')).body, 'complete');
			assert.deepEqual(Rows.getRecordResidency(entry), ['writer-replica-owner']);
		});
	}
	it('expires through the sweep without appending an audit entry', async function () {
		if (isLMDB) return this.skip();
		const Rows = await declare(0.08);
		await Rows.put('row', { id: 'row', region: 1, body: 'temporary' });
		const count = () =>
			Array.from(Rows.auditStore.getRange({ start: 1 })).filter((entry) => entry.tableId === Rows.tableId).length;
		const before = count();
		assert.ok(Rows.primaryStore.getEntry('row').metadataFlags & REPLICA);
		await waitFor(() => Rows.primaryStore.getEntry('row').metadataFlags & INVALIDATED, { timeout: 3000 });
		assert.equal(Rows.primaryStore.getEntry('row').value.body, undefined);
		assert.equal(count(), before);
		assert.equal(openReplicaDeadlineStore(Rows.primaryStore.rootStore, Rows.tableName).getSync('row'), undefined);
	});
	it('a newer remote projection replaces the writer replica and its deadline', async function () {
		if (isLMDB) return this.skip();
		const Rows = await declare();
		await Rows.put('row', { id: 'row', region: 1, body: 'first' });
		const version = Rows.primaryStore.getEntry('row').version;
		await invalidate(Rows, 'row', version + 100);
		const entry = Rows.primaryStore.getEntry('row');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, undefined);
		assert.equal(openReplicaDeadlineStore(Rows.primaryStore.rootStore, Rows.tableName).getSync('row'), undefined);
	});
	it('keeps staged patches complete and still requires a real new-owner confirmation', async function () {
		if (isLMDB) return this.skip();
		const Rows = await declare();
		await Rows.put('row', { id: 'row', region: 0, body: 'first' });
		setResidencyPlacementGuard(() => {});
		let release;
		let confirmation;
		replicationConfirmation((_db, _version, count, owners, automatic) => {
			confirmation = { count, owners, automatic };
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		let completed = false;
		const writing = transaction({}, async () => {
			await Rows.patch('row', { region: 1 });
			await Rows.patch('row', { body: 'second' });
		}).then(() => {
			completed = true;
		});
		try {
			await waitFor(() => release, { timeout: 2000 });
			assert.equal(completed, false);
			assert.deepEqual(confirmation, { count: 1, owners: [['writer-replica-owner']], automatic: true });
			assert.ok(Rows.primaryStore.getEntry('row').metadataFlags & REPLICA);
			assert.equal((await Rows.get('row')).body, 'second');
		} finally {
			release?.();
			await writing;
		}
	});
	it('rolls back the replica row and deadline together', async function () {
		if (isLMDB) return this.skip();
		const Rows = await declare();
		await assert.rejects(
			transaction({}, async () => {
				await Rows.put('aborted', { id: 'aborted', region: 1, body: 'discard' });
				throw new Error('rollback');
			}),
			/rollback/
		);
		assert.equal(Rows.primaryStore.getEntry('aborted'), undefined);
		assert.equal(openReplicaDeadlineStore(Rows.primaryStore.rootStore, Rows.tableName).getSync('aborted'), undefined);
	});
	it('keeps the full audit blob after a replica expires or a newer projection replaces it', async function () {
		if (isLMDB) return this.skip();
		const { createBlob, getFilePathForBlob, cleanupOrphans } = require('#src/resources/blob');
		const { randomBytes } = require('node:crypto');
		const { existsSync } = require('node:fs');
		const priorRetention = env.get('storage_blobRetention');
		env.setProperty('storage_blobRetention', 0);
		try {
			for (const replacement of [false, true]) {
				const Rows = await declare(replacement ? 3600 : 0.08);
				const bytes = randomBytes(32768);
				const blob = await createBlob(bytes);
				await Rows.put('blob', { id: 'blob', region: 1, body: blob });
				const file = getFilePathForBlob(blob);
				assert.ok(file, 'the body is file-backed');
				const written = Rows.primaryStore.getEntry('blob');
				if (replacement) await invalidate(Rows, 'blob', written.version + 100);
				else await waitFor(() => Rows.primaryStore.getEntry('blob').metadataFlags & INVALIDATED, { timeout: 3000 });
				await new Promise((resolve) => setTimeout(resolve, 100));
				await cleanupOrphans({ [Rows.tableName]: Rows }, 'writer_replicas');
				assert.ok(existsSync(file), 'delivery still needs the original audit body');
				const full = Array.from(Rows.auditStore.getRange({ start: 1 })).find(
					(entry) => entry.tableId === Rows.tableId && entry.type === 'put'
				);
				assert.deepEqual(Buffer.from(await full.getValue(Rows.primaryStore).body.arrayBuffer()), bytes);
			}
		} finally {
			env.setProperty('storage_blobRetention', priorRetention);
		}
	});
	it('documents positive and negated row filters seeing only the invalidation projection', async () => {
		const Rows = await declare();
		await Rows.put('private', { id: 'private', region: 1, body: 'private' });
		await new Promise(setImmediate);
		const observed = [[], []];
		const events = [[], []];
		const subscriptions = [];
		try {
			for (const index of [0, 1])
				subscriptions.push(
					await Rows.subscribe({
						id: 'private',
						rowFilter(row) {
							observed[index].push(row.body);
							return index ? row.body !== 'private' : row.body === 'private';
						},
						listener(event) {
							events[index].push(event);
						},
					})
				);
			for (const values of [...observed, ...events]) values.length = 0;
			await invalidate(Rows, 'private', Rows.primaryStore.getEntry('private').version + 100);
			await waitFor(() => observed.every((rows) => rows.length > 0) && events[1].length > 0, { timeout: 2000 });
			assert.deepEqual(observed, [[undefined], [undefined]]);
			assert.equal(events[0].length, 0);
			assert.equal(events[1][0].type, 'invalidate');
			assert.equal(events[1][0].value.body, undefined);
		} finally {
			for (const subscription of subscriptions) subscription.end();
		}
	});
});
