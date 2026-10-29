require('../testUtils');
const assert = require('node:assert');
const { loadGQLSchema } = require('#src/resources/graphql');
const { table, getDatabases } = require('#src/resources/databases');
const { server } = require('#src/server/Server');
const env = require('#src/utility/environment/environmentManager');
const { residencyDeclarationDatabases } = require('#src/resources/residencyMaps');
const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)('Supported sharding policies', function () {
	let shards, list, shard, experimental, markers;
	before(() => {
		shards = server.shards;
		list = env.get('replication_shards');
		shard = env.get('replication_shard');
		experimental = env.get('replication_experimentalAttributeSlots');
		markers = env.get('storage_rocks_transactionLogAbortMarkers');
		env.setProperty('replication_shards', [0]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([[0, [{ name: server.hostname }]]]);
	});
	beforeEach(() => {
		env.setProperty('replication_experimentalAttributeSlots', false);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', undefined);
	});
	after(() => {
		server.shards = shards;
		env.setProperty('replication_shards', list);
		env.setProperty('replication_shard', shard);
		env.setProperty('replication_experimentalAttributeSlots', experimental);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', markers);
	});
	const schema = (database, directive) => `type Records @table(database: "${database}") ${directive} {
		id: ID @primaryKey tag: String @indexed body: String
	}`;
	it('keeps primary-key placement unchanged when ordinary fields change', async () => {
		await loadGQLSchema(schema('supported_hash', '@sharded(slots: 2)'));
		const Records = getDatabases().supported_hash.Records;
		await Records.put('same-key', { id: 'same-key', tag: 'before', body: 'complete' });
		const slot = Records.getResidencySlot('same-key');
		await Records.patch('same-key', { tag: 'after' });
		assert.equal(Records.getResidencySlot('same-key'), slot);
		assert.equal((await Records.get('same-key')).body, 'complete');
	});
	for (const [name, directive] of [
		['attribute', '@sharded(slots: 2, by: "tag")'],
		['expression', '@sharded(slots: 2, slotFrom: "id.length % 2")'],
	])
		it(`refuses ${name} declarations before writing a durable declaration marker`, async () => {
			const database = `unsupported_${name}`;
			await assert.rejects(
				loadGQLSchema(schema(database, directive)),
				(error) =>
					error.statusCode === 400 &&
					/not supported yet/.test(error.message) &&
					/harper-pro\/issues\/1178/.test(error.message)
			);
			assert.ok(!residencyDeclarationDatabases().includes(database));
			const Plain = table({
				database,
				table: 'Plain',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			});
			await Plain.put('available', { id: 'available', body: 'still writable' });
			assert.equal((await Plain.get('available')).body, 'still writable');
		});
	for (const origin of [undefined, 'cluster'])
		it(`refuses experimental policy on the direct table path (origin=${origin})`, () => {
			assert.throws(
				() =>
					table({
						database: `unsupported_direct_${origin ?? 'local'}`,
						table: 'Records',
						origin,
						residency: { slots: 2, byAttribute: false, slotFrom: '0' },
						attributes: [{ name: 'id', isPrimaryKey: true }],
					}),
				/harper-pro\/issues\/1178/
			);
		});
	it('refuses an unchanged experimental schema when its test switch is off', async () => {
		const gql = schema('unsupported_reload', '@sharded(slots: 2, slotFrom: "id.length % 2")');
		env.setProperty('replication_experimentalAttributeSlots', true);
		await loadGQLSchema(gql);
		env.setProperty('replication_experimentalAttributeSlots', false);
		await assert.rejects(loadGQLSchema(gql), /harper-pro\/issues\/1178/);
	});
	it('quarantines only persisted experimental databases and restores them after restart with the switch', function () {
		this.timeout(30_000);
		const { spawnSync } = require('node:child_process');
		const { mkdtempSync, rmSync } = require('node:fs');
		const { join } = require('node:path');
		const root = mkdtempSync(join(__dirname, '../envDir/policy-recovery-'));
		try {
			for (const mode of ['seed', 'refuse', 'restore']) {
				const child = spawnSync(
					process.execPath,
					[join(__dirname, 'fixtures/shardingPolicyRecovery.cjs'), mode, root],
					{ timeout: 9000, encoding: 'utf8' }
				);
				assert.equal(child.status, 0, child.stderr);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it('requires the native marker accessor for experimental attribute declarations', async function () {
		if (typeof Transaction.prototype.usesAbortMarkers === 'function') this.skip();
		env.setProperty('replication_experimentalAttributeSlots', true);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', true);
		await assert.rejects(loadGQLSchema(schema('missing_markers', '@sharded(slots: 2, by: "tag")')), /usesAbortMarkers/);
	});
	it('requires marker enablement independently of a stubbed capability predicate', async () => {
		const descriptor = Object.getOwnPropertyDescriptor(Transaction.prototype, 'usesAbortMarkers');
		Object.defineProperty(Transaction.prototype, 'usesAbortMarkers', { configurable: true, value: () => true });
		env.setProperty('replication_experimentalAttributeSlots', true);
		try {
			await assert.rejects(
				loadGQLSchema(schema('disabled_markers', '@sharded(slots: 2, by: "tag")')),
				/transactionLogAbortMarkers/
			);
		} finally {
			if (descriptor) Object.defineProperty(Transaction.prototype, 'usesAbortMarkers', descriptor);
			else delete Transaction.prototype.usesAbortMarkers;
		}
	});
});
