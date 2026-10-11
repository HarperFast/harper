require('../testUtils');
const assert = require('node:assert');
const { hostname } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { DatabaseTransaction, replicationConfirmation } = require('#src/resources/DatabaseTransaction');

const SELF = global.server.hostname || hostname();
const PEER_A = 'residency-confirmation-a';
const PEER_B = 'residency-confirmation-b';

// replicatedConfirmation counts only peers resident for the written records (harper-pro#1031): the
// commit hands the confirmation callback the other residents of each distinct residency list
describe('replicatedConfirmation residency (harper-pro#1031)', () => {
	let Records, Unplaced, calls;

	before(function () {
		// LMDBTransaction keeps its own confirmation registry, which the replication layer never registers
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'ResidencyConfirmation',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'homes' }, { name: 'body' }],
			audit: true,
		});
		Unplaced = table({
			table: 'ResidencyConfirmationUnplaced',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			audit: true,
		});
	});

	beforeEach(() => {
		calls = [];
		replicationConfirmation((databaseName, version, confirmationCount, residentPeerLists) => {
			calls.push({ databaseName, version, confirmationCount, residentPeerLists });
			return Promise.resolve();
		});
		Records.setResidency((record) => record.homes);
	});

	afterEach(() => {
		replicationConfirmation(undefined);
		Records.setResidency(undefined);
		Records.setResidencyById(undefined);
	});

	const confirmed = (context, write) => transaction(context, write);
	const sorted = (lists) => lists.map((list) => [...list].sort()).sort();

	it('passes the other residents of a record placed by a residency list', async () => {
		await confirmed({ replicatedConfirmation: 1 }, () =>
			Records.put('placed', { id: 'placed', homes: [SELF, PEER_A], body: 'complete' })
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_A]]);
		assert.equal(calls[0].version, Records.primaryStore.getEntry('placed').version);
	});

	it('passes no residency lists for a table without residency, as before', async () => {
		await confirmed({ replicatedConfirmation: 1 }, () => Unplaced.put('open', { id: 'open', body: 'complete' }));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].residentPeerLists, undefined);
		assert.ok(calls[0].version);
	});

	it('passes one list per distinct residency in a multi-record transaction, ignoring unplaced records', async () => {
		await confirmed({ replicatedConfirmation: 1 }, async () => {
			await Records.put('multi-a', { id: 'multi-a', homes: [SELF, PEER_A], body: 'a' });
			await Records.put('multi-b', { id: 'multi-b', homes: [SELF, PEER_B], body: 'b' });
			await Records.put('multi-a2', { id: 'multi-a2', homes: [SELF, PEER_A], body: 'a2' });
			await Unplaced.put('multi-open', { id: 'multi-open', body: 'open' });
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(sorted(calls[0].residentPeerLists), [[PEER_A], [PEER_B]]);
	});

	it('places a replicateTo list like a residency list', async () => {
		Records.setResidency(undefined);
		await confirmed({ replicatedConfirmation: 1, replicateTo: [PEER_B] }, () =>
			Records.put('replicate-to', { id: 'replicate-to', body: 'complete' })
		);
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_B]]);
	});

	it('fails before writing when the count exceeds the other residents', async () => {
		await assert.rejects(
			confirmed({ replicatedConfirmation: 2 }, async () =>
				Records.put('too-few', { id: 'too-few', homes: [SELF, PEER_A, PEER_A], body: 'complete' })
			),
			(error) => {
				assert.equal(error.statusCode, 400);
				assert.match(error.message, /Cannot confirm replication to 2 node\(s\) for record "too-few"/);
				assert.match(error.message, new RegExp(`resident on 1 other node\\(s\\) \\(${PEER_A}\\)`));
				return true;
			}
		);
		assert.equal(Records.primaryStore.getEntry('too-few'), undefined);
		assert.equal(calls.length, 0);
		// nothing was left locked or staged: the same key writes normally afterwards
		await Records.put('too-few', { id: 'too-few', homes: [SELF, PEER_A], body: 'later' });
		assert.equal((await Records.get('too-few')).body, 'later');
	});

	it('rolls back the whole transaction when a later record cannot be confirmed', async () => {
		await assert.rejects(
			confirmed({ replicatedConfirmation: 1 }, async () => {
				await Records.put('rollback-ok', { id: 'rollback-ok', homes: [SELF, PEER_A], body: 'ok' });
				await Records.put('rollback-self', { id: 'rollback-self', homes: [SELF], body: 'self only' });
			}),
			/resident on 0 other node\(s\)$/
		);
		assert.equal(Records.primaryStore.getEntry('rollback-ok'), undefined);
		assert.equal(Records.primaryStore.getEntry('rollback-self'), undefined);
	});

	it('rejects at commit when confirmation is requested after the write was staged', async () => {
		const context = { transaction: new DatabaseTransaction() };
		await Records.put('late', { id: 'late', homes: [SELF], body: 'complete' }, context);
		context.transaction.replicatedConfirmation = 1;
		await assert.rejects(context.transaction.commit({ doneWriting: true }), /resident on 0 other node\(s\)$/);
		assert.equal(calls.length, 0);
	});

	it('confirms a write whose residency omits the writer, which stores no local record', async () => {
		Records.setResidency(undefined);
		Records.setResidencyById(() => [PEER_A]);
		await confirmed({ replicatedConfirmation: 1 }, () =>
			Records.put('elsewhere', { id: 'elsewhere', body: 'complete' })
		);
		assert.equal(Records.primaryStore.getEntry('elsewhere')?.value, undefined);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].residentPeerLists, [[PEER_A]]);
		assert.ok(calls[0].version);
	});
});
