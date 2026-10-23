require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { INVALIDATED, REPLICA, DEFAULT_REPLICA_EXPIRATION_MS } = require('#src/resources/Table');
const databases = require('#src/resources/databases');
const { HAS_BLOBS } = require('#src/resources/auditStore');
const { createBlob, getFilePathForBlob, setDeletionDelay } = require('#src/resources/blob');
const { existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { server } = require('#src/server/Server');

const RESIDENCY_ID = 123;
const OTHER_RESIDENCY_ID = 456;
const ID = 'record';

async function waitFor(condition, description, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = await condition();
		if (result) return result;
		assert.ok(Date.now() < deadline, `timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const describeReplicas = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
describeReplicas('Local replicas of residency stubs', function () {
	this.timeout(20_000);
	let Records, response, calls, stored;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			database: 'test',
			table: 'ResidencyReplicas',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'body', type: 'String' },
				{ name: 'file', type: 'Any' },
			],
			audit: true,
		});
		Records.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], ['resident-a', 'resident-b']);
		Records.dbisDB.putSync([Symbol.for('residency_by_id'), OTHER_RESIDENCY_ID], ['other-resident']);
		Records.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					calls.push(entry.key);
					const found = typeof response === 'function' ? await response() : response;
					if (found) stored.push(await Records._storeReplica(entry, found));
					return found;
				}
			},
			{ intermediateSource: true }
		);
	});

	let stubVersion;
	async function invalidate(partial, options = {}, newer = 0) {
		const before = Records.primaryStore.getEntry(ID);
		const version = (options.version ?? before?.version ?? Date.now()) + newer;
		const context = before ? { sourceApply: true, timestamp: version } : {};
		await transaction(context, async () => {
			const resource = await Records.getResource(ID, context, { ensureLoaded: false });
			resource._writeInvalidate(ID, partial, {
				residencyId: RESIDENCY_ID,
				...(before ? { version, nodeId: before.nodeId ?? 0 } : {}),
				...options,
			});
		});
		return Records.primaryStore.getEntry(ID);
	}

	beforeEach(async () => {
		Records.setTTLExpiration({
			replicaExpiration: DEFAULT_REPLICA_EXPIRATION_MS / 1000,
			replicaRefreshFraction: 0.5,
		});
		calls = [];
		stored = [];
		if (Records.primaryStore.getEntry(ID)?.value) await Records.delete(ID);
		const stub = await invalidate(Object.freeze({ name: 'indexed' }), {}, 1);
		assert.ok(stub.metadataFlags & INVALIDATED);
		stubVersion = stub.version;
		response = {
			key: ID,
			value: { id: ID, name: 'indexed', body: 'complete' },
			version: stubVersion,
			originNode: server.hostname,
		};
	});

	async function query(select, conditions = []) {
		const records = [];
		for await (const record of Records.search({ conditions, select })) records.push(record);
		return records;
	}

	function history() {
		return Records.getHistoryOfRecord(ID).then((entries) => entries.map((entry) => entry.type));
	}

	// the per-table deadline store (`<table>/@replicas`): id → deadline in ms
	function deadlines(Table = Records) {
		return databases.openReplicaDeadlineStore(
			Table.primaryStore.rootStore,
			Table.tableName,
			Table.dbisDB.getSync(Table.tableName + '/')?.generation
		);
	}
	const deadlineOf = (id, Table = Records) => deadlines(Table).getSync(id);

	async function replica() {
		const record = await Records.get(ID);
		assert.equal(record.body, 'complete');
		assert.deepEqual(stored, [true]);
		const entry = Records.primaryStore.getEntry(ID);
		assert.ok(entry.metadataFlags & REPLICA, 'the fetched record must be flagged as a replica');
		assert.ok(!(entry.metadataFlags & INVALIDATED));
		return entry;
	}

	it('keeps a fetched record as a replica with the stub identity, residency and no audit entry', async () => {
		const before = await history();
		const entry = await replica();
		assert.equal(entry.value.body, 'complete');
		assert.equal(entry.residencyId, RESIDENCY_ID);
		assert.equal(entry.version, stubVersion);
		assert.equal(entry.expiresAt, undefined, 'the row carries no replica deadline');
		const deadline = deadlineOf(ID);
		assert.ok(deadline > Date.now() + DEFAULT_REPLICA_EXPIRATION_MS - 5000);
		assert.ok(deadline <= Date.now() + DEFAULT_REPLICA_EXPIRATION_MS);
		assert.deepEqual(await history(), before, 'a replica write leaves the audit history unchanged');
		assert.equal(Records.dbisDB.getSync(`${Records.tableName}/@replicas`)?.auxiliary, '@replicas');
		assert.deepEqual(calls, [ID]);
		assert.equal((await Records.get(ID)).body, 'complete');
		assert.deepEqual(await query(['id', 'body'], [{ attribute: 'name', value: 'indexed' }]), [
			{ id: ID, body: 'complete' },
		]);
		assert.deepEqual(calls, [ID], 'reads of a replica never contact a resident');
	});

	it('does not keep a response that is older than the stub, or one with no version', async () => {
		for (const stale of [
			{ ...response, version: stubVersion - 1 },
			{ ...response, version: undefined },
		]) {
			response = stale;
			calls = [];
			stored = [];
			assert.equal((await Records.get(ID)).body, 'complete', 'the caller still receives the fetched record');
			assert.deepEqual(stored, [false]);
			const entry = Records.primaryStore.getEntry(ID);
			assert.ok(entry.metadataFlags & INVALIDATED);
			assert.equal(entry.value.body, undefined);
		}
	});

	it('keeps a newer response under the stub identity', async () => {
		response = { ...response, version: stubVersion + 5 };
		const entry = await replica();
		assert.equal(entry.version, stubVersion);
	});

	it('refuses a response once the stub was deleted', async () => {
		response = () => {
			const context = { sourceApply: true, timestamp: stubVersion + 1 };
			return transaction(context, async () => {
				const resource = await Records.getResource(ID, context, { ensureLoaded: false });
				resource._writeDelete(ID, { version: stubVersion + 1, nodeId: 0 });
			}).then(() => ({ key: ID, value: { id: ID, name: 'indexed', body: 'complete' }, version: stubVersion }));
		};
		await Records.get(ID);
		assert.deepEqual(stored, [false]);
		assert.equal(Records.primaryStore.getEntry(ID)?.value, null);
	});

	it('keeps a record carrying its own expiry, which then expires like any row', async () => {
		const expiresAt = Date.now() + 500;
		response = { ...response, expiresAt };
		const entry = await replica();
		assert.equal(entry.expiresAt, expiresAt, 'the record expiry is stored exactly as reported');
		assert.equal(deadlineOf(ID), expiresAt, 'the replica deadline never passes the record expiry');
		await new Promise((resolve) => setTimeout(resolve, 600));
		calls = [];
		assert.equal(await Records.get(ID), undefined, 'an expired record reads as a resident reads it: gone');
		const demoted = await waitFor(() => {
			const current = Records.primaryStore.getEntry(ID);
			return current.metadataFlags & INVALIDATED ? current : undefined;
		}, 'the expired replica to be demoted');
		assert.equal(demoted.expiresAt, expiresAt, 'the stub keeps the record expiry');
		assert.equal(deadlineOf(ID), undefined);
		calls = [];
		assert.equal(await Records.get(ID), undefined, 'an expired stub reads as absent');
		assert.deepEqual(calls, [], 'an expired stub never fetches the expired record from a resident');
	});

	it('keeps an equal-version answer only from the stub writer, and a newer one from anyone', async () => {
		for (const originNode of ['some-other-writer', undefined]) {
			response = { ...response, originNode };
			calls = [];
			stored = [];
			assert.equal((await Records.get(ID)).body, 'complete');
			assert.deepEqual(stored, [false], `${originNode} at the stub version must not be kept under its writer`);
			assert.ok(Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED);
		}
		stored = [];
		response = { ...response, originNode: undefined, version: stubVersion + 1 };
		await replica();
	});

	it('serves a replica past its deadline until the sweep demotes it; reads honor only the record expiry', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0.2 });
		await replica();
		await Records.closeMaintenance();
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			const held = Records.primaryStore.getEntry(ID);
			assert.ok(held.metadataFlags & REPLICA && deadlineOf(ID) < Date.now(), 'a replica past its deadline still held');
			calls = [];
			assert.equal((await Records.get(ID)).body, 'complete');
			assert.deepEqual(await query(['id', 'body']), [{ id: ID, body: 'complete' }]);
			assert.deepEqual(calls, [], 'a replica past its deadline is served, not reloaded');
		} finally {
			Records.resumeMaintenance();
		}
		await waitFor(
			() => (Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED ? true : undefined),
			'the sweep to demote the replica'
		);
		assert.equal(deadlineOf(ID), undefined, 'demotion takes the deadline entry with it');
	});

	it('slides on a table with its own record expiry, never past that expiry, which a demoted stub keeps', async () => {
		const Expiring = table({
			database: 'test',
			table: 'ResidencyReplicasExpiring',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			audit: true,
			expiration: 3600,
			replicaExpiration: 2,
		});
		const loaded = [];
		let residentExpiresAt = Date.now() + 3600_000;
		Expiring.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					loaded.push(entry.key);
					const found = {
						key: ID,
						value: { id: ID, name: 'indexed', body: 'complete' },
						version: entry.version,
						originNode: server.hostname,
						expiresAt: residentExpiresAt,
					};
					await Expiring._storeReplica(entry, found);
					return found;
				}
			},
			{ intermediateSource: true }
		);
		const stub = async (newer) => {
			const context = { sourceApply: true, timestamp: Date.now() + newer };
			await transaction(context, async () => {
				const resource = await Expiring.getResource(ID, context, { ensureLoaded: false });
				resource._writeInvalidate(ID, { name: 'indexed' }, { residencyId: RESIDENCY_ID, version: context.timestamp });
			});
		};
		await stub(0);
		assert.equal((await Expiring.get(ID)).body, 'complete');
		let entry = Expiring.primaryStore.getEntry(ID);
		assert.ok(entry.metadataFlags & REPLICA);
		assert.equal(entry.expiresAt, residentExpiresAt, 'the row keeps the record expiry as reported');
		const first = deadlineOf(ID, Expiring);
		assert.ok(first <= Date.now() + 2000 && first > Date.now() + 1500);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.equal((await Expiring.get(ID)).body, 'complete');
		await waitFor(() => (deadlineOf(ID, Expiring) > first ? true : undefined), 'a read hit to renew the deadline');
		assert.equal(Expiring.primaryStore.getEntry(ID).expiresAt, residentExpiresAt, 'a renewal never touches the row');
		assert.deepEqual(loaded, [ID]);

		residentExpiresAt = Date.now() + 1500;
		await stub(1000);
		assert.equal((await Expiring.get(ID)).body, 'complete');
		entry = Expiring.primaryStore.getEntry(ID);
		assert.equal(entry.expiresAt, residentExpiresAt);
		assert.equal(deadlineOf(ID, Expiring), residentExpiresAt, 'the record expiry caps the deadline');
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.equal((await Expiring.get(ID)).body, 'complete');
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(deadlineOf(ID, Expiring), residentExpiresAt, 'a read hit never extends past the record expiry');
		assert.deepEqual(loaded, [ID, ID]);

		residentExpiresAt = Date.now() + 3600_000;
		await stub(2000);
		Expiring.setTTLExpiration({ expiration: 3600, replicaExpiration: 0.2 });
		assert.equal((await Expiring.get(ID)).body, 'complete');
		const demoted = await waitFor(() => {
			const current = Expiring.primaryStore.getEntry(ID);
			return current.metadataFlags & INVALIDATED ? current : undefined;
		}, 'the sweep to demote the replica');
		assert.equal(demoted.expiresAt, residentExpiresAt, 'a demoted stub keeps the record expiry');
		assert.equal(deadlineOf(ID, Expiring), undefined);
	});

	it('keeps committed computed index entries when the fetched body replaces a stub', async () => {
		const Computed = table({
			database: 'test',
			table: 'ResidencyReplicasComputed',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'sku', indexed: true },
				{ name: 'name' },
				{ name: 'upper', indexed: true, computed: true },
			],
			audit: true,
		});
		Computed.setComputedAttribute('upper', (record) => record.name.toUpperCase());
		const results = [];
		Computed.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					const found = {
						key: ID,
						value: { id: ID, sku: 'A1', name: 'resident' },
						version: entry.version,
						originNode: server.hostname,
					};
					results.push(await Computed._storeReplica(entry, found));
					return found;
				}
			},
			{ intermediateSource: true }
		);
		await Computed.put(ID, { id: ID, sku: 'A1', name: 'original' });
		const context = {};
		await transaction(context, async () => {
			const resource = await Computed.getResource(ID, context, { ensureLoaded: false });
			resource._writeInvalidate(ID, { id: ID, sku: 'A1', upper: 'ORIGINAL' }, { residencyId: RESIDENCY_ID });
		});
		assert.equal((await Computed.get(ID)).name, 'resident');
		assert.deepEqual(results, [true], 'a computed index must not stop the replica from being kept');
		const entry = Computed.primaryStore.getEntry(ID);
		assert.ok(entry.metadataFlags & REPLICA);
		const found = [];
		for await (const record of Computed.search({
			conditions: [{ attribute: 'upper', value: 'ORIGINAL' }],
			select: ['id'],
		}))
			found.push(record);
		assert.deepEqual(found, [{ id: ID }]);
		const patch = { sourceApply: true, timestamp: entry.version + 1 };
		await transaction(patch, async () => {
			const resource = await Computed.getResource(ID, patch, { ensureLoaded: false });
			resource._writeUpdate(ID, { sku: 'A2' }, false, { version: entry.version + 1, nodeId: entry.nodeId ?? 0 });
			resource.save();
		});
		const stub = Computed.primaryStore.getEntry(ID);
		assert.ok(stub.metadataFlags & INVALIDATED);
		assert.equal(stub.value.sku, 'A2');
		assert.equal(stub.residencyId, RESIDENCY_ID);
	});

	for (const [label, apply, expectStub, expectBody, expectName = 'changed'] of [
		[
			'a newer invalidation',
			(resource, options) => resource._writeInvalidate(ID, { id: ID, name: 'changed' }, options),
			true,
		],
		[
			'a relocation that excludes this node',
			(resource, options) => resource._writeRelocate(ID, { ...options, residencyId: OTHER_RESIDENCY_ID }),
			true,
			undefined,
			'indexed',
		],
		[
			'a put without residency',
			(resource, options) => {
				resource._writeUpdate(ID, { id: ID, name: 'changed', body: 'replaced' }, true, options);
				resource.save();
			},
			false,
			'replaced',
		],
		[
			'a patch, which keeps a non-resident a non-resident',
			(resource, options) => {
				resource._writeUpdate(ID, { name: 'changed' }, false, options);
				resource.save();
			},
			true,
		],
		[
			'a local patch with no residency of its own',
			(resource, { version, nodeId }) => {
				resource._writeUpdate(ID, { name: 'changed' }, false, { version, nodeId });
				resource.save();
			},
			true,
		],
		['a delete', (resource, options) => resource._writeDelete(ID, options), null],
	]) {
		it(`is overwritten by ${label} like a stub`, async () => {
			const before = await replica();
			const context = { sourceApply: true, timestamp: before.version + 1 };
			await transaction(context, async () => {
				const resource = await Records.getResource(ID, context, { ensureLoaded: false });
				apply(resource, { version: before.version + 1, nodeId: before.nodeId ?? 0, residencyId: RESIDENCY_ID });
			});
			const after = Records.primaryStore.getEntry(ID);
			assert.equal(deadlineOf(ID), undefined, 'an overwrite takes the deadline entry with it');
			if (expectStub === null) {
				assert.equal(after?.value, null);
				return;
			}
			assert.ok(!(after.metadataFlags & REPLICA), 'a newer write never leaves the replica flag behind');
			assert.equal(Boolean(after.metadataFlags & INVALIDATED), expectStub);
			if (expectStub) assert.equal(after.residencyId, label.includes('relocation') ? OTHER_RESIDENCY_ID : RESIDENCY_ID);
			assert.equal(after.value.body, expectBody);
			assert.equal(after.value.name, expectName);
			for (const name of ['indexed', 'changed'])
				assert.equal((await query(['name'], [{ attribute: 'name', value: name }])).length, name === expectName ? 1 : 0);
		});
	}

	it('keeps the replica when an older invalidation arrives', async () => {
		const before = await replica();
		await invalidate({ id: ID, name: 'stale' }, {}, -1);
		const after = Records.primaryStore.getEntry(ID);
		assert.ok(after.metadataFlags & REPLICA);
		assert.equal(after.value.body, 'complete');
		assert.equal(after.version, before.version);
	});

	it('demotes a replica back to its stub on eviction, keeping indexes, residency and history', async () => {
		const entry = await replica();
		const before = await history();
		await Records.evict(ID, entry.value, entry.version);
		const stub = Records.primaryStore.getEntry(ID);
		assert.ok(stub.metadataFlags & INVALIDATED);
		assert.ok(!(stub.metadataFlags & REPLICA));
		assert.equal(stub.value.body, undefined);
		assert.equal(stub.value.name, 'indexed');
		assert.equal(stub.residencyId, RESIDENCY_ID);
		assert.equal(stub.version, entry.version);
		assert.equal(stub.expiresAt, undefined);
		assert.deepEqual(await history(), before);
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'indexed' }]), [{ id: ID }]);
		calls = [];
		assert.equal((await Records.get(ID)).body, 'complete');
		assert.deepEqual(calls, [ID], 'a demoted replica is fetched again');
	});

	it('releases a replica body’s blobs only after its demotion commits', async () => {
		const file = createBlob(randomBytes(25000)); // above the inline size, so the body owns a file
		response = { ...response, value: { id: ID, name: 'indexed', body: 'complete', file } };
		const entry = await replica();
		assert.ok(entry.metadataFlags & HAS_BLOBS);
		const filePath = getFilePathForBlob(entry.value.file);
		assert.ok(existsSync(filePath));
		setDeletionDelay(0);
		try {
			await Records.evict(ID, entry.value, entry.version);
			const stub = Records.primaryStore.getEntry(ID);
			assert.ok(stub.metadataFlags & INVALIDATED);
			assert.ok(!(stub.metadataFlags & HAS_BLOBS));
			await waitFor(() => (existsSync(filePath) ? undefined : true), 'the demoted body’s blob file to be released');
		} finally {
			setDeletionDelay(undefined);
		}
	});

	it('is swept back to a stub once its lifetime passes, without an audit entry', async () => {
		Records.setTTLExpiration({ expiration: 0, eviction: 0, replicaExpiration: 0.001 });
		const before = await history();
		await replica();
		const stub = await waitFor(() => {
			const entry = Records.primaryStore.getEntry(ID);
			return entry.metadataFlags & INVALIDATED ? entry : undefined;
		}, 'the expiration sweep to demote the replica');
		assert.equal(stub.value.body, undefined);
		assert.equal(stub.residencyId, RESIDENCY_ID);
		assert.deepEqual(await history(), before);
	});

	it('renews the deadline on a read hit once half the lifetime has passed, not on every read', async () => {
		Records.setTTLExpiration({ replicaExpiration: 2 });
		const entry = await replica();
		const first = deadlineOf(ID);
		assert.equal((await Records.get(ID)).body, 'complete');
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(deadlineOf(ID), first, 'a fresh replica is not renewed');
		await new Promise((resolve) => setTimeout(resolve, 1050));
		assert.equal((await Records.get(ID)).body, 'complete');
		await waitFor(() => (deadlineOf(ID) > first ? true : undefined), 'the read hit to renew the deadline');
		const current = Records.primaryStore.getEntry(ID);
		assert.ok(current.metadataFlags & REPLICA);
		assert.equal(current.version, entry.version);
		assert.equal(current.expiresAt, undefined, 'a renewal never touches the row');
		assert.deepEqual(calls, [ID], 'a renewal is a local write');
	});

	it('renews after the configured fraction of the lifetime, and never when it is 1', async () => {
		Records.setTTLExpiration({ replicaExpiration: 2, replicaRefreshFraction: 0.25 });
		await replica();
		const first = deadlineOf(ID);
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal((await Records.get(ID)).body, 'complete');
		await waitFor(() => (deadlineOf(ID) > first ? true : undefined), 'a quarter of the lifetime to renew');

		Records.setTTLExpiration({ replicaExpiration: 2, replicaRefreshFraction: 1 });
		await Records.delete(ID);
		stored = [];
		const stub = await invalidate(Object.freeze({ name: 'indexed' }), {}, 1);
		response = { ...response, version: stub.version };
		await replica();
		const fixed = deadlineOf(ID);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.equal((await Records.get(ID)).body, 'complete');
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(deadlineOf(ID), fixed, 'a fraction of 1 is a fixed lifetime');
	});

	it('keeps the blob file of a replica whose deadline was renewed', async function () {
		Records.setTTLExpiration({ replicaExpiration: 2 });
		const file = createBlob(randomBytes(25000));
		response = { ...response, value: { id: ID, name: 'indexed', body: 'complete', file } };
		const entry = await replica();
		const first = deadlineOf(ID);
		const filePath = getFilePathForBlob(entry.value.file);
		assert.ok(existsSync(filePath));
		setDeletionDelay(0);
		try {
			await new Promise((resolve) => setTimeout(resolve, 1100));
			assert.equal((await Records.get(ID)).body, 'complete');
			await waitFor(() => (deadlineOf(ID) > first ? true : undefined), 'the read hit to renew the deadline');
			assert.ok(Records.primaryStore.getEntry(ID).metadataFlags & HAS_BLOBS);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.ok(existsSync(filePath), 'the renewal released the body’s own blob file');
			assert.equal((await (await Records.get(ID)).file.arrayBuffer()).byteLength, 25000);
		} finally {
			setDeletionDelay(undefined);
		}
	});

	it('removes a deadline entry whose key no longer holds a replica', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0.2 });
		await deadlines().put('ghost', Date.now() - 1);
		await replica();
		await waitFor(() => (deadlineOf('ghost') === undefined ? true : undefined), 'the sweep to drop the orphan entry');
	});

	it('gives a replica row without a deadline entry a lifetime on the first sweep after load', async () => {
		const Repaired = table({
			database: 'test',
			table: 'ResidencyReplicasRepaired',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			replicaExpiration: 2,
		});
		Repaired.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					const found = { key: ID, value: { id: ID, name: 'indexed', body: 'complete' }, version: entry.version };
					await Repaired._storeReplica(entry, { ...found, originNode: server.hostname });
					return found;
				}
			},
			{ intermediateSource: true }
		);
		const context = {};
		await transaction(context, async () => {
			const resource = await Repaired.getResource(ID, context, { ensureLoaded: false });
			resource._writeInvalidate(ID, { name: 'indexed' }, { residencyId: RESIDENCY_ID });
		});
		assert.equal((await Repaired.get(ID)).body, 'complete');
		assert.ok(deadlineOf(ID, Repaired) > Date.now());
		await deadlines(Repaired).remove(ID); // a crash between column-family flushes, or a copy without this store
		assert.equal(deadlineOf(ID, Repaired), undefined);
		const restored = await waitFor(() => deadlineOf(ID, Repaired), 'the first sweep to restore the lifetime');
		assert.ok(restored > Date.now() && restored <= Date.now() + 2000);
	});

	it('drops the deadline store with its table', async () => {
		const Dropped = table({
			database: 'test',
			table: 'ResidencyReplicasDropped',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
		});
		Dropped.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					const found = { key: ID, value: { id: ID, name: 'indexed', body: 'complete' }, version: entry.version };
					await Dropped._storeReplica(entry, { ...found, originNode: server.hostname });
					return found;
				}
			},
			{ intermediateSource: true }
		);
		const context = {};
		await transaction(context, async () => {
			const resource = await Dropped.getResource(ID, context, { ensureLoaded: false });
			resource._writeInvalidate(ID, { name: 'indexed' }, { residencyId: RESIDENCY_ID });
		});
		assert.equal((await Dropped.get(ID)).body, 'complete');
		const catalogKey = `${Dropped.tableName}/@replicas`;
		assert.ok(Dropped.dbisDB.getSync(catalogKey));
		const rootStore = Dropped.primaryStore.rootStore;
		const storeName = databases.storeNameFor(catalogKey, Dropped.dbisDB.getSync(`${Dropped.tableName}/`)?.generation);
		if (rootStore.columns) assert.ok(rootStore.columns.includes(storeName));
		await Dropped.dropTable();
		assert.equal(Dropped.dbisDB.getSync(catalogKey), undefined, 'the catalog row goes with the table');
		if (rootStore.columns) assert.ok(!rootStore.columns.includes(storeName), 'the column family goes with the table');
	});

	it('re-arms the sweep after replicas are disabled and enabled again', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0.2 });
		await replica();
		await Records.closeMaintenance();
		Records.setTTLExpiration({ expiration: 0, eviction: 0, replicaExpiration: 0 });
		Records.resumeMaintenance();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.ok(Records.primaryStore.getEntry(ID).metadataFlags & REPLICA, 'no sweep runs while replicas are disabled');
		Records.setTTLExpiration({ replicaExpiration: 0.001 });
		await waitFor(() => {
			const entry = Records.primaryStore.getEntry(ID);
			return entry.metadataFlags & INVALIDATED ? entry : undefined;
		}, 'the re-armed sweep to demote the replica');
	});

	it('stands down after a complete empty sweep and wakes on the next replica', async () => {
		const sweepArmed = () =>
			Atomics.load(
				new Int32Array(
					Records.primaryStore.getUserSharedBuffer(`replica-sweep:${Records.tableId}`, new ArrayBuffer(8))
				),
				1
			);
		Records.setTTLExpiration({ replicaExpiration: 0.2 });
		await replica();
		assert.equal(sweepArmed(), 1);
		await waitFor(
			() => (Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED ? true : undefined),
			'the first demotion'
		);
		await waitFor(() => (sweepArmed() === 0 ? true : undefined), 'the empty sweep to stand down');
		stored = [];
		await replica();
		await waitFor(() => (sweepArmed() === 1 ? true : undefined), 'the new replica to wake the sweep');
		await waitFor(
			() => (Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED ? true : undefined),
			'the woken sweep to demote the new replica'
		);
	});

	it('stores nothing when replicaExpiration is zero', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0 });
		assert.equal((await Records.get(ID)).body, 'complete');
		assert.deepEqual(stored, [false]);
		assert.ok(Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED);
	});
});
