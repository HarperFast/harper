require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { transaction } = require('#src/resources/transaction');
const {
	setDatabaseBaselineGuard,
	setDatabaseLiveGuard,
	REPLICATION_APPLY,
} = require('#src/resources/databaseLiveGuard');
const env = require('#src/utility/environment/environmentManager');
const { server } = require('#src/server/Server');

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)('Sharding baseline admission', function () {
	let Records, Plain, root, baseline, configuration, priorList, priorShard, priorNodes;
	before(async () => {
		setupTestDBPath();
		priorList = env.get('replication_shards');
		priorShard = env.get('replication_shard');
		priorNodes = server.shards;
		env.setProperty('replication_shards', [0, 1]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([
			[0, [{ name: server.hostname }]],
			[1, [{ name: 'other-shard' }]],
		]);
		await loadGQLSchema(`type Rows @table(database: "baselineAdmission") @sharded(slots: 2, slotFrom: "Number(id) % 2") {
			id: ID @primaryKey value: String
		}`);
		Records = databases.baselineAdmission.Rows;
		Plain = table({ database: 'baselineAdmission', table: 'Plain', attributes: [{ name: 'id', isPrimaryKey: true }] });
		root = Records.primaryStore.rootStore;
		setDatabaseBaselineGuard(root, () => baseline);
		setDatabaseLiveGuard(root, () => configuration);
	});
	afterEach(() => {
		baseline = configuration = undefined;
	});
	after(() => {
		setDatabaseBaselineGuard(root, () => undefined);
		setDatabaseLiveGuard(root, () => undefined);
		env.setProperty('replication_shards', priorList);
		env.setProperty('replication_shard', priorShard);
		server.shards = priorNodes;
	});

	it('refuses owned misses and writes promptly while allowing present bodies and nonowned data', async () => {
		await Records.put('0', { id: '0', value: 'present' });
		baseline = 'waiting for a complete owner';
		await assert.rejects(
			async () => Records.get('2'),
			(error) => error.statusCode === 503 && /complete owner/.test(error.message)
		);
		await assert.rejects(
			async () => Records.put('2', { id: '2', value: 'refused' }),
			(error) => error.statusCode === 503
		);
		assert.ok(!Records.primaryStore.getEntry('2'));
		assert.equal((await Records.get('0')).value, 'present');
		assert.equal(await Records.get('1'), null);
		await Plain.put('ordinary', { id: 'ordinary' });
		assert.equal((await Plain.get('ordinary')).id, 'ordinary');
		baseline = undefined;
		await Records.put('2', { id: '2', value: 'accepted' });
		assert.equal(Records.primaryStore.getSync('2').value, 'accepted');
	});

	it('allows actual replication to fill a held owner but refuses external source apply and configuration mismatch', async () => {
		baseline = 'waiting for a complete owner';
		const apply = (id, replicated) => {
			const context = { sourceApply: true, [REPLICATION_APPLY]: replicated };
			return transaction(context, async () => {
				const record = await Records.getResource(id, context);
				await record._writeUpdate(id, { id, value: 'full body' }, true);
			});
		};
		await assert.rejects(apply('4', false), /complete owner/);
		assert.equal(Records.primaryStore.getEntry('4'), undefined);
		await apply('4', true);
		assert.equal(Records.primaryStore.getSync('4').value, 'full body');
		configuration = 'replication.shards does not match';
		await assert.rejects(apply('6', true), /replication.shards does not match/);
		assert.equal(Records.primaryStore.getEntry('6'), undefined);
	});

	it('refuses a collection query before opening a read transaction', () => {
		baseline = 'baseline unavailable';
		const context = {};
		assert.throws(
			() => Records.getResource({ isCollection: true }, context),
			(error) => error.statusCode === 503
		);
		assert.equal(context.transaction, undefined);
	});

	it('rechecks the baseline before committing a write staged while serving', async () => {
		await assert.rejects(
			transaction({}, async () => {
				await Records.put('8', { id: '8', value: 'must roll back' });
				baseline = 'baseline was revoked';
			}),
			/baseline was revoked/
		);
		assert.equal(Records.primaryStore.getEntry('8'), undefined);
	});
	it('refuses an external body after the replication source returns no body', async () => {
		let replicationReads = 0,
			externalReads = 0;
		Records.sourcedFrom(
			class Replicator {
				static isReplicator = true;
				static async load() {
					replicationReads++;
				}
			},
			{ intermediateSource: true }
		);
		Records.sourcedFrom(
			class External {
				static async get(id) {
					externalReads++;
					return { id, value: 'external body' };
				}
			}
		);
		baseline = 'waiting for a complete owner';
		await assert.rejects(async () => Records.get('10'), /complete owner/);
		assert.ok(replicationReads > 0);
		assert.ok(externalReads > 0);
		assert.ok(!Records.primaryStore.getEntry('10')?.value);
	});
});
