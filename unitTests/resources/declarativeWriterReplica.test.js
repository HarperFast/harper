require('../testUtils');
const assert = require('node:assert');
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

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)('Declarative writer replicas', function () {
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
			@sharded(slots: 2, by: "region", slotFrom: "region") {
			id: ID @primaryKey region: Int @indexed body: Any
		}`);
		return databases.writer_replicas[name];
	}
	async function invalidate(Rows, id, version) {
		const context = { timestamp: version };
		await transaction(context, async () => {
			const row = await Rows.getResource(id, context, { ensureLoaded: false });
			row._writeInvalidate(id, { id, region: 1 }, { version, residencySlot: 1 });
		});
	}
	for (const logOffset of [0, 1])
		it(`applies a complete origin PUT after a same-identity owner projection (log offset=${logOffset})`, async function () {
			if (isLMDB) return this.skip();
			const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
			const Rows = await declare();
			await Rows.put('copy-target', { id: 'copy-target', region: 0, body: 'old' });
			const nodeId = getIdOfRemoteNode('writer-origin', Rows.auditStore);
			const version = Date.now() + 100;
			const context = { source: {}, sourceApply: true, timestamp: version + logOffset };
			await transaction(context, async () => {
				const row = await Rows.getResource('copy-target', context, { ensureLoaded: false });
				row._writeInvalidate(
					'copy-target',
					{ id: 'copy-target', region: 0 },
					{ nodeId, version, residencySlot: 0, isCopyApply: true }
				);
			});
			const before = Rows.primaryStore.getEntry('copy-target');
			assert.ok(before.metadataFlags & INVALIDATED);
			assert.equal(before.version, version);
			assert.equal(before.nodeId, nodeId);
			const originEntries = () =>
				Array.from(Rows.auditStore.getRange({ start: 1, log: nodeId })).filter(
					(entry) => entry.tableId === Rows.tableId && entry.recordId === 'copy-target'
				);
			assert.equal(originEntries().length, 0, 'a snapshot projection cannot occupy an origin-log identity');
			const apply = async () => {
				const context = { source: {}, sourceApply: true, timestamp: version + logOffset };
				await transaction(context, async () => {
					const row = await Rows.getResource('copy-target', context, { ensureLoaded: false });
					row._writeUpdate('copy-target', { id: 'copy-target', region: 0, body: 'canonical body' }, true, {
						nodeId,
						version,
					});
				});
			};
			await apply();
			const complete = Rows.primaryStore.getEntry('copy-target');
			assert.equal(complete.value.body, 'canonical body');
			assert.ok(!(complete.metadataFlags & (INVALIDATED | REPLICA)));
			assert.equal(complete.version, version);
			assert.equal(complete.nodeId, nodeId);
			await apply();
			assert.equal((await Rows.get('copy-target')).body, 'canonical body');
			assert.equal(originEntries().length, 1, 'only one canonical origin transaction exists');
		});
	for (const slot of [0, 1])
		it(`keeps snapshot identity handling scoped to ownership (slot=${slot})`, async function () {
			if (isLMDB) return this.skip();
			const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
			const Rows = await declare();
			const nodeId = getIdOfRemoteNode('snapshot-source', Rows.auditStore);
			const version = Date.now() + 100;
			const apply = async (copy, invalidated) => {
				const context = { source: {}, sourceApply: true, timestamp: version };
				await transaction(context, async () => {
					const row = await Rows.getResource('snapshot', context, { ensureLoaded: false });
					const options = { nodeId, version, residencySlot: slot, isCopyApply: copy };
					if (invalidated) row._writeInvalidate('snapshot', { id: 'snapshot', region: slot }, options);
					else row._writeUpdate('snapshot', { id: 'snapshot', region: slot, body: 'complete' }, true, options);
				});
			};
			await apply(true, true);
			assert.ok(Rows.primaryStore.getEntry('snapshot').metadataFlags & INVALIDATED);
			const originalGet = Rows.auditStore.getSync;
			const originalRange = Rows.auditStore.getRange;
			let logReads = 0;
			Rows.auditStore.getSync = function (key, ...args) {
				if (key === version) logReads++;
				return originalGet.call(this, key, ...args);
			};
			Rows.auditStore.getRange = function (options, ...args) {
				if (options?.start === version || options?.log === nodeId) logReads++;
				return originalRange.call(this, options, ...args);
			};
			try {
				await apply(slot === 0, false);
				assert.equal(logReads, 0, 'snapshot repair and nonowner duplicate do not read audit history');
				await apply(true, true);
			} finally {
				Rows.auditStore.getSync = originalGet;
				Rows.auditStore.getRange = originalRange;
			}
			const entry = Rows.primaryStore.getEntry('snapshot');
			assert.equal(Boolean(entry.metadataFlags & INVALIDATED), slot === 1);
			assert.equal(entry.value.body, slot === 0 ? 'complete' : undefined);
			assert.equal(
				Array.from(Rows.auditStore.getRange({ start: 1, log: nodeId })).filter((entry) => entry.recordId === 'snapshot')
					.length,
				0
			);
		});
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
	for (const slot of [0, 1]) {
		it(`keeps a key-policy patch over an incomplete base invalidated (slot ${slot})`, async () => {
			const name = `KeyWriterReplica${++sequence}`;
			await loadGQLSchema(`type ${name} @table(database: "writer_replicas", replicaExpiration: 3600)
				@sharded(slots: 2, slotFrom: "${slot}") {
				id: ID @primaryKey tag: String @indexed body: String extra: String
			}`);
			const Rows = databases.writer_replicas[name];
			await Rows.put('row', { id: 'row', tag: 'before', body: 'complete' });
			await Rows.invalidate('row');
			const before = Rows.primaryStore.getEntry('row');
			assert.ok(before.metadataFlags & INVALIDATED, 'the patch starts from an actual stub');
			assert.equal(before.value.body, undefined);
			await Rows.patch('row', { tag: 'after', extra: 'partial' });
			const after = Rows.primaryStore.getEntry('row');
			assert.equal(after.value.tag, 'after', 'the patch committed its indexed field');
			assert.ok(after.metadataFlags & INVALIDATED, 'a partial body cannot become a complete row');
			assert.ok(!(after.metadataFlags & REPLICA), 'a partial body cannot become a complete replica');
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
	it('does not rescan growing audit history while a patch retains every blob', async function () {
		if (isLMDB) return this.skip();
		const { createBlob } = require('#src/resources/blob');
		const { randomBytes } = require('node:crypto');
		const Rows = await declare();
		const bytes = randomBytes(32768);
		await Rows.put('blob', { id: 'blob', region: 1, body: await createBlob(bytes) });
		const original = Rows.auditStore.getSync;
		let reads = 0;
		Rows.auditStore.getSync = function (...args) {
			reads++;
			return original.apply(this, args);
		};
		try {
			for (let i = 0; i < 10; i++) await Rows.patch('blob', { marker: i });
			const firstTen = reads;
			reads = 0;
			for (let i = 10; i < 20; i++) await Rows.patch('blob', { marker: i });
			assert.ok(reads <= firstTen + 20, `audit reads grew with retained history: ${firstTen} then ${reads}`);
			assert.deepEqual(Buffer.from(await Rows.primaryStore.getEntry('blob').value.body.arrayBuffer()), bytes);
		} finally {
			Rows.auditStore.getSync = original;
		}
	});
	it('bounds audit reads when each patch replaces a blob', async function () {
		if (isLMDB) return this.skip();
		const { createBlob } = require('#src/resources/blob');
		const { randomBytes } = require('node:crypto');
		const Rows = await declare();
		await Rows.put('blob', { id: 'blob', region: 1, body: await createBlob(randomBytes(32768)) });
		const original = Rows.auditStore.getSync;
		let reads = 0;
		Rows.auditStore.getSync = function (...args) {
			reads++;
			return original.apply(this, args);
		};
		try {
			for (let i = 0; i < 10; i++) await Rows.patch('blob', { body: await createBlob(randomBytes(32768)) });
			const firstTen = reads;
			reads = 0;
			for (let i = 0; i < 10; i++) await Rows.patch('blob', { body: await createBlob(randomBytes(32768)) });
			assert.ok(reads <= firstTen + 20, `blob replacement audit reads grew: ${firstTen} then ${reads}`);
		} finally {
			Rows.auditStore.getSync = original;
		}
	});
	it('retains a newer canonical audit reference when deferred replica cleanup resumes', async function () {
		if (isLMDB) return this.skip();
		const { createBlob, getFilePathForBlob, deleteBlobAndWait } = require('#src/resources/blob');
		const { randomBytes } = require('node:crypto');
		const { existsSync } = require('node:fs');
		const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
		const priorRetention = env.get('storage_blobRetention');
		const originalCommit = Transaction.prototype.commit;
		const parked = [];
		env.setProperty('storage_blobRetention', 0);
		try {
			const Rows = await declare();
			const bytes = randomBytes(32768);
			await Rows.put('blob', { id: 'blob', region: 1, body: await createBlob(bytes) });
			for (let i = 0; i < 100; i++) await Rows.patch('blob', { marker: i });
			const before = Rows.primaryStore.getEntry('blob');
			await Rows.evict('blob', before.value, before.version);
			await Rows.closeMaintenance();
			Rows.resumeMaintenance();
			const stub = Rows.primaryStore.getEntry('blob');
			assert.equal(
				await Rows._storeReplica(stub, {
					key: 'blob',
					value: { id: 'blob', region: 1, body: await createBlob(Buffer.from(bytes)) },
					version: stub.version,
					originNode: server.hostname,
				}),
				true
			);
			const fetched = Rows.primaryStore.getEntry('blob').value.body;
			const fetchedPath = getFilePathForBlob(fetched);
			Transaction.prototype.commit = function (...args) {
				if (this.store?.db === Rows.primaryStore.store.db && this.replicaCommitNotifications?.size) {
					for (const notify of this.replicaCommitNotifications) parked.push(notify);
					this.replicaCommitNotifications.clear();
				}
				return originalCommit.apply(this, args);
			};
			await invalidate(Rows, 'blob', stub.version + 100);
			Transaction.prototype.commit = originalCommit;
			assert.ok(parked.length, 'parked a real deferred audit cleanup');
			await Rows.put('blob', { id: 'blob', region: 1, body: fetched }, { timestamp: stub.version + 101 });
			const referencedVersion = Rows.primaryStore.getEntry('blob').version;
			await Rows.put(
				'blob',
				{ id: 'blob', region: 1, body: await createBlob(randomBytes(32768)) },
				{ timestamp: stub.version + 102 }
			);
			assert.equal(referencedVersion, stub.version + 101);
			const referenced = Array.from(Rows.auditStore.getRange({ start: 1 })).find(
				(entry) => entry.tableId === Rows.tableId && entry.type === 'put' && entry.version === referencedVersion
			);
			assert.ok(referenced, 'the later canonical reference committed before cleanup');
			for (const notify of parked.splice(0)) notify();
			await Rows.closeMaintenance();
			Rows.resumeMaintenance();
			await Rows.put('barrier', { id: 'barrier', region: 1, body: await createBlob(randomBytes(32768)) });
			await deleteBlobAndWait(Rows.primaryStore.getEntry('barrier').value.body);
			assert.ok(existsSync(fetchedPath), 'the intermediate canonical audit entry still owns the fetched file');
			assert.deepEqual(Buffer.from(await referenced.getValue(Rows.primaryStore).body.arrayBuffer()), bytes);
		} finally {
			Transaction.prototype.commit = originalCommit;
			for (const notify of parked) notify();
			env.setProperty('storage_blobRetention', priorRetention);
		}
	});
	for (const operation of ['refresh', 'demote']) {
		it(`retains later canonical blobs across raw ${operation} completion`, async function () {
			if (isLMDB) return this.skip();
			const { createBlob, getFilePathForBlob, deleteBlobAndWait } = require('#src/resources/blob');
			const { randomBytes } = require('node:crypto');
			const { existsSync } = require('node:fs');
			const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
			const originalCommit = Transaction.prototype.commit;
			const priorRetention = env.get('storage_blobRetention');
			env.setProperty('storage_blobRetention', 0);
			try {
				const Rows = await declare();
				const bytes = randomBytes(32768);
				await Rows.put('blob', { id: 'blob', region: 1, body: await createBlob(bytes) });
				const original = Rows.primaryStore.getEntry('blob');
				await Rows.evict('blob', original.value, original.version);
				const stub = Rows.primaryStore.getEntry('blob');
				assert.equal(
					await Rows._storeReplica(stub, {
						key: 'blob',
						value: { id: 'blob', region: 1, body: await createBlob(Buffer.from(bytes)) },
						version: stub.version,
						originNode: server.hostname,
					}),
					true
				);
				const replica = Rows.primaryStore.getEntry('blob');
				const fetched = replica.value.body;
				const path = getFilePathForBlob(fetched);
				let crossedCommit = false;
				Transaction.prototype.commit = function (...args) {
					if (this.store?.db !== Rows.primaryStore.store.db) return originalCommit.apply(this, args);
					Transaction.prototype.commit = originalCommit;
					return originalCommit.apply(this, args).then(async (result) => {
						crossedCommit = true;
						await Rows.put('blob', { id: 'blob', region: 1, body: fetched }, { timestamp: stub.version + 101 });
						await Rows.put(
							'blob',
							{ id: 'blob', region: 1, body: await createBlob(randomBytes(32768)) },
							{ timestamp: stub.version + 102 }
						);
						return result;
					});
				};
				if (operation === 'demote') await Rows.evict('blob', replica.value, replica.version);
				else
					assert.equal(
						await Rows._storeReplica(replica, {
							key: 'blob',
							value: { id: 'blob', region: 1, body: await createBlob(randomBytes(32768)) },
							version: stub.version + 1,
							originNode: server.hostname,
						}),
						true
					);
				assert.ok(crossedCommit);
				const referenced = Array.from(Rows.auditStore.getRange({ start: 1 })).find(
					(entry) => entry.tableId === Rows.tableId && entry.type === 'put' && entry.version === stub.version + 101
				);
				assert.ok(referenced, 'the later canonical body is durable');
				await Rows.closeMaintenance();
				Rows.resumeMaintenance();
				await Rows.put('barrier', { id: 'barrier', region: 1, body: await createBlob(randomBytes(32768)) });
				await deleteBlobAndWait(Rows.primaryStore.getEntry('barrier').value.body);
				assert.ok(existsSync(path), 'a later canonical audit entry retains the fetched file');
				assert.deepEqual(Buffer.from(await referenced.getValue(Rows.primaryStore).body.arrayBuffer()), bytes);
			} finally {
				Transaction.prototype.commit = originalCommit;
				env.setProperty('storage_blobRetention', priorRetention);
			}
		});
	}
	for (const fault of ['earlier callback throws', 'native attempt retries'])
		it(`reclaims fetched files after commit when ${fault}`, async function () {
			if (isLMDB) return this.skip();
			const { createBlob, getFilePathForBlob } = require('#src/resources/blob');
			const { randomBytes } = require('node:crypto');
			const { existsSync } = require('node:fs');
			const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
			const binding = Object.values(require.cache).find(
				(module) => typeof module.exports?.forceTryAgainForTesting === 'function'
			)?.exports;
			const priorRetention = env.get('storage_blobRetention');
			const originalCommit = Transaction.prototype.commit;
			env.setProperty('storage_blobRetention', 0);
			try {
				const Rows = await declare();
				const bytes = randomBytes(32768);
				const canonical = await createBlob(bytes);
				await Rows.put('blob', { id: 'blob', region: 1, body: canonical });
				for (let i = 0; i < 100; i++) await Rows.patch('blob', { marker: i });
				const before = Rows.primaryStore.getEntry('blob');
				await Rows.evict('blob', before.value, before.version);
				await Rows.closeMaintenance();
				Rows.resumeMaintenance();
				const stub = Rows.primaryStore.getEntry('blob');
				const fetched = await createBlob(Buffer.from(bytes));
				assert.equal(
					await Rows._storeReplica(stub, {
						key: 'blob',
						value: { id: 'blob', region: 1, body: fetched },
						version: stub.version,
						originNode: server.hostname,
					}),
					true
				);
				let injected = false,
					abandonedCalls = 0;
				const attempts = [];
				Transaction.prototype.commit = function (...args) {
					if (this.store?.db === Rows.primaryStore.store.db && this.replicaCommitNotifications?.size) {
						attempts.push(this.id);
						if (!injected) {
							injected = true;
							if (fault === 'earlier callback throws') {
								this.replicaCommitNotifications = new Set([
									() => {
										throw new Error('earlier notification failed');
									},
									...this.replicaCommitNotifications,
								]);
							} else {
								assert.ok(binding, 'native retry seam is available');
								this.replicaCommitNotifications = new Set(
									[...this.replicaCommitNotifications].map((notify) => () => {
										abandonedCalls++;
										notify();
									})
								);
								binding.forceTryAgainForTesting(1);
							}
						}
					}
					return originalCommit.apply(this, args);
				};
				await invalidate(Rows, 'blob', stub.version + 100);
				assert.ok(injected, 'the real deferred cleanup registered a post-commit callback');
				if (fault === 'native attempt retries') {
					assert.ok(attempts.length >= 2);
					assert.equal(new Set(attempts).size, 1, 'the native retry reused its handle');
					assert.equal(abandonedCalls, 0, 'only callbacks from the committed attempt may run');
				}
				await waitFor(() => !existsSync(getFilePathForBlob(fetched)), { timeout: 3000 });
				assert.ok(existsSync(getFilePathForBlob(canonical)), 'canonical audit files remain retained');
				const audit = Array.from(Rows.auditStore.getRange({ start: 1 })).find(
					(entry) => entry.tableId === Rows.tableId && entry.type === 'put'
				);
				assert.deepEqual(Buffer.from(await audit.getValue(Rows.primaryStore).body.arrayBuffer()), bytes);
			} finally {
				Transaction.prototype.commit = originalCommit;
				binding?.forceTryAgainForTesting(0);
				env.setProperty('storage_blobRetention', priorRetention);
			}
		});
	for (const references of [false, true])
		it(`bounds fetched-replica cleanup and automatically reclaims files (references=${references})`, async function () {
			if (isLMDB) return this.skip();
			const { createBlob, getFilePathForBlob } = require('#src/resources/blob');
			const { randomBytes } = require('node:crypto');
			const { existsSync } = require('node:fs');
			const priorRetention = env.get('storage_blobRetention');
			env.setProperty('storage_blobRetention', 0);
			try {
				for (const replacement of [false, true]) {
					const Rows = await declare();
					const bytes = randomBytes(32768);
					const canonical = await createBlob(bytes);
					await Rows.put('blob', { id: 'blob', region: 1, body: canonical });
					const base = Date.now() + 60_000;
					for (let i = 0; i < 100; i++)
						await Rows.patch('blob', { marker: i }, references ? { timestamp: base + i } : undefined);
					const written = Rows.primaryStore.getEntry('blob');
					if (references)
						assert.ok(written.additionalAuditRefs?.length, 'native patches carry distinct audit log keys');
					const original = Rows.auditStore.getSync;
					let sawPut = false;
					Rows.auditStore.getSync = function (...args) {
						const record = original.apply(this, args);
						if (record?.type === 'put' && record.recordId === 'blob') sawPut = true;
						return record;
					};
					try {
						await Rows.evict('blob', written.value, written.version);
						await waitFor(() => sawPut, { timeout: 3000 });
					} finally {
						Rows.auditStore.getSync = original;
					}
					for (let cycle = 0; cycle < 3; cycle++) {
						const stub = Rows.primaryStore.getEntry('blob');
						const fetched = await createBlob(Buffer.from(bytes));
						assert.equal(
							await Rows._storeReplica(stub, {
								key: 'blob',
								value: { id: 'blob', region: 1, body: fetched },
								version: stub.version,
								originNode: server.hostname,
							}),
							true
						);
						let reads = 0,
							maximum = 0,
							turns = 0,
							timer;
						const reset = () => {
							reads = 0;
							turns++;
							timer = setImmediate(reset);
						};
						timer = setImmediate(reset);
						Rows.auditStore.getSync = function (...args) {
							maximum = Math.max(maximum, ++reads);
							return original.apply(this, args);
						};
						try {
							if (replacement) await invalidate(Rows, 'blob', stub.version + 100);
							else await Rows.evict('blob', stub.value, stub.version);
							await waitFor(() => !existsSync(getFilePathForBlob(fetched)), { timeout: 3000 }).catch((error) => {
								throw new Error(
									`references=${references}, replacement=${replacement}, cycle=${cycle}, reads=${maximum}, flags=${Rows.primaryStore.getEntry('blob').metadataFlags}`,
									{ cause: error }
								);
							});
							assert.ok(maximum <= 40, `cleanup performed ${maximum} native reads in one event-loop turn`);
							assert.ok(turns > 0, 'long-chain cleanup yields and automatically reclaims without orphan scanning');
						} finally {
							clearImmediate(timer);
							Rows.auditStore.getSync = original;
						}
						assert.ok(existsSync(getFilePathForBlob(canonical)), 'canonical delivery still needs its original file');
					}
					const full = Array.from(Rows.auditStore.getRange({ start: 1 })).find(
						(entry) => entry.tableId === Rows.tableId && entry.type === 'put'
					);
					assert.deepEqual(Buffer.from(await full.getValue(Rows.primaryStore).body.arrayBuffer()), bytes);
				}
			} finally {
				env.setProperty('storage_blobRetention', priorRetention);
			}
		});
	it('keeps earlier audit blobs after patches and replica eviction or replacement', async function () {
		if (isLMDB) return this.skip();
		const { createBlob, getFilePathForBlob, cleanupOrphans } = require('#src/resources/blob');
		const { randomBytes } = require('node:crypto');
		const { existsSync } = require('node:fs');
		const priorRetention = env.get('storage_blobRetention');
		env.setProperty('storage_blobRetention', 0);
		try {
			for (const replacement of [false, true]) {
				for (const staged of [false, true]) {
					const Rows = await declare();
					const bytes = randomBytes(32768);
					const blob = await createBlob(bytes);
					const write = async () => {
						await Rows.put('blob', { id: 'blob', region: 1, body: blob });
						await Rows.patch('blob', { marker: 'patched' });
					};
					if (staged) await transaction({}, write);
					else await write();
					const file = getFilePathForBlob(blob);
					assert.ok(file, 'the body is file-backed');
					const written = Rows.primaryStore.getEntry('blob');
					if (replacement) await invalidate(Rows, 'blob', written.version + 100);
					else await Rows.evict('blob', written.value, written.version);
					await new Promise((resolve) => setTimeout(resolve, 100));
					await cleanupOrphans({ [Rows.tableName]: Rows }, 'writer_replicas');
					assert.ok(existsSync(file), 'delivery still needs the original audit body');
					const full = Array.from(Rows.auditStore.getRange({ start: 1 })).find(
						(entry) => entry.tableId === Rows.tableId && entry.type === 'put'
					);
					assert.deepEqual(Buffer.from(await full.getValue(Rows.primaryStore).body.arrayBuffer()), bytes);
				}
			}
		} finally {
			env.setProperty('storage_blobRetention', priorRetention);
		}
	});
	it('reclaims fetched replica blobs without losing the original audit blob', async function () {
		if (isLMDB) return this.skip();
		const { createBlob, getFilePathForBlob, cleanupOrphans } = require('#src/resources/blob');
		const { randomBytes } = require('node:crypto');
		const { existsSync } = require('node:fs');
		const priorRetention = env.get('storage_blobRetention');
		env.setProperty('storage_blobRetention', 0);
		try {
			for (const replacement of [false, true]) {
				const Rows = await declare();
				const bytes = randomBytes(32768);
				const original = await createBlob(bytes);
				await Rows.put('blob', { id: 'blob', region: 1, body: original });
				await Rows.patch('blob', { marker: 'patched' });
				const originalFile = getFilePathForBlob(original);
				const written = Rows.primaryStore.getEntry('blob');
				await Rows.evict('blob', written.value, written.version);
				const stub = Rows.primaryStore.getEntry('blob');
				assert.ok(stub.metadataFlags & INVALIDATED);
				const fetched = await createBlob(Buffer.from(bytes));
				assert.equal(
					await Rows._storeReplica(stub, {
						key: 'blob',
						value: { id: 'blob', region: 1, body: fetched },
						version: written.version,
						originNode: server.hostname,
					}),
					true
				);
				const fetchedFile = getFilePathForBlob(fetched);
				assert.ok(originalFile && fetchedFile);
				assert.notEqual(fetchedFile, originalFile, 'a source fetch creates a separate local file');
				assert.ok(Rows.primaryStore.getEntry('blob').metadataFlags & REPLICA);
				await cleanupOrphans({ [Rows.tableName]: Rows }, 'writer_replicas');
				assert.ok(existsSync(originalFile), 'a fetched replica must not hide the audit blob from cleanup');
				assert.ok(existsSync(fetchedFile), 'the live replica still needs its fetched file');
				if (replacement) await invalidate(Rows, 'blob', written.version + 100);
				else await Rows.evict('blob', written.value, written.version);
				await waitFor(() => !existsSync(fetchedFile), { timeout: 2000 });
				assert.ok(existsSync(originalFile), 'delayed delivery still needs the original audit file');
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
