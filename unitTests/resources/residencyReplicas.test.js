require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { INVALIDATED, REPLICA, DEFAULT_REPLICA_EXPIRATION_MS } = require('#src/resources/Table');
const { HAS_BLOBS } = require('#src/resources/auditStore');
const { createBlob } = require('#src/resources/blob');

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

describe('Local replicas of residency stubs', function () {
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
		Records.dbisDB.putSync([Symbol.for('residency_by_id'), OTHER_RESIDENCY_ID], ['other-resident']);
		Records.sourcedFrom(
			class extends Resource {
				// what harper-pro's Replicator does with a GET_RECORD answer
				static async load(entry) {
					calls.push(entry.key);
					const found = typeof response === 'function' ? response() : response;
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
		Records.setTTLExpiration({ replicaExpiration: DEFAULT_REPLICA_EXPIRATION_MS / 1000 });
		calls = [];
		stored = [];
		if (Records.primaryStore.getEntry(ID)?.value) await Records.delete(ID);
		const stub = await invalidate(Object.freeze({ name: 'indexed' }), {}, 1);
		assert.ok(stub.metadataFlags & INVALIDATED);
		stubVersion = stub.version;
		response = { key: ID, value: { id: ID, name: 'indexed', body: 'complete' }, version: stubVersion };
	});

	async function query(select, conditions = []) {
		const records = [];
		for await (const record of Records.search({ conditions, select })) records.push(record);
		return records;
	}

	function history() {
		return Records.getHistoryOfRecord(ID).then((entries) => entries.map((entry) => entry.type));
	}

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
		assert.ok(entry.expiresAt > Date.now() + DEFAULT_REPLICA_EXPIRATION_MS - 5000);
		assert.ok(entry.expiresAt <= Date.now() + DEFAULT_REPLICA_EXPIRATION_MS);
		assert.deepEqual(await history(), before, 'a replica write leaves the audit history unchanged');
		assert.ok(Records.dbisDB.getSync([Symbol.for('replica_tables'), Records.tableId]));
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

	it('bounds the replica lifetime by the expiry the resident reports', async () => {
		const residentExpiresAt = Date.now() + 500;
		response = { ...response, expiresAt: residentExpiresAt };
		const entry = await replica();
		assert.equal(entry.expiresAt, residentExpiresAt);
	});

	for (const [label, apply, expectStub, expectBody, expectName = 'changed'] of [
		[
			'a newer invalidation',
			(resource, options) => resource._writeInvalidate(ID, { id: ID, name: 'changed' }, options),
			true,
		],
		[
			// a relocate carries no values, so the stub keeps the indexed fields it already holds
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
			'a patch without residency',
			(resource, options) => {
				resource._writeUpdate(ID, { name: 'changed' }, false, options);
				resource.save();
			},
			false,
			'complete',
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
			if (expectStub === null) {
				assert.equal(after?.value, null);
				return;
			}
			assert.ok(!(after.metadataFlags & REPLICA), 'a newer write never leaves the replica flag behind');
			assert.equal(Boolean(after.metadataFlags & INVALIDATED), expectStub);
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
		const file = createBlob(Buffer.from('replica blob'));
		response = { ...response, value: { id: ID, name: 'indexed', body: 'complete', file } };
		const entry = await replica();
		assert.ok(entry.metadataFlags & HAS_BLOBS);
		await Records.evict(ID, entry.value, entry.version);
		assert.ok(Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED);
	});

	it('is swept back to a stub once its lifetime passes, without an audit entry', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0.001 });
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

	it('reloads an expired replica from a resident instead of hiding it', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0.001 });
		await replica();
		await new Promise((resolve) => setTimeout(resolve, 5));
		calls = [];
		stored = [];
		response = { ...response, value: { id: ID, name: 'indexed', body: 'complete' } };
		const entry = Records.primaryStore.getEntry(ID);
		if (entry.metadataFlags & REPLICA) {
			assert.equal((await Records.get(ID)).body, 'complete');
			assert.deepEqual(calls, [ID], 'an expired replica is answered by a resident');
			assert.deepEqual(stored, [true]);
		}
		assert.deepEqual(await query(['id', 'body']), [{ id: ID, body: 'complete' }]);
	});

	it('refreshes the lifetime on a read hit once a quarter of it has elapsed, not on every read', async () => {
		Records.setTTLExpiration({ replicaExpiration: 2 });
		const entry = await replica();
		assert.equal((await Records.get(ID)).body, 'complete');
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(Records.primaryStore.getEntry(ID).expiresAt, entry.expiresAt, 'a fresh replica is not rewritten');
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal((await Records.get(ID)).body, 'complete');
		const refreshed = await waitFor(() => {
			const current = Records.primaryStore.getEntry(ID);
			return current.expiresAt > entry.expiresAt ? current : undefined;
		}, 'the read hit to extend the replica lifetime');
		assert.ok(refreshed.metadataFlags & REPLICA);
		assert.equal(refreshed.version, entry.version);
		assert.deepEqual(calls, [ID], 'a refresh is a local write');
	});

	it('stores nothing when replicaExpiration is zero', async () => {
		Records.setTTLExpiration({ replicaExpiration: 0 });
		assert.equal((await Records.get(ID)).body, 'complete');
		assert.deepEqual(stored, [false]);
		assert.ok(Records.primaryStore.getEntry(ID).metadataFlags & INVALIDATED);
	});

	it('rejects a negative or non-numeric replicaExpiration', () => {
		for (const value of [-1, 'soon', NaN]) assert.throws(() => Records.setTTLExpiration({ replicaExpiration: value }));
	});
});
