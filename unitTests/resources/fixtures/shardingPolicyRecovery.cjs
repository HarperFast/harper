const assert = require('node:assert');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const [mode, root] = process.argv.slice(2);
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, HDB_SETTINGS_NAMES } = require('#src/utility/hdbTerms');
mkdirSync(join(root, 'database'), { recursive: true });
env.setProperty(HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
env.setProperty(CONFIG_PARAMS.STORAGE_PATH, join(root, 'database'));
env.setProperty(CONFIG_PARAMS.LOGGING_AUDITLOG, true);
env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, 'policy-recovery');
env.setProperty('replication_shards', [0]);
env.setProperty('replication_shard', 0);
env.setProperty('replication_experimentalAttributeSlots', mode !== 'refuse');
const { server } = require('#src/server/Server');
require('#src/server/threads/manageThreads').setMainIsWorker(true);
const { getDatabases, table, flushDatabases, databaseResidencyBlockReason } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
(async () => {
	getDatabases();
	server.shards = new Map([[0, [{ name: server.hostname }]]]);
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'body' }];
	if (mode === 'seed') {
		await loadGQLSchema(
			'type Records @table(database: "experimental") @sharded(slots: 2, slotFrom: "0") { id: ID @primaryKey body: String }'
		);
		await getDatabases().experimental.Records.put('kept', { id: 'kept', body: 'durable' });
		for (const database of ['experimental', 'healthy']) {
			const Plain = table({ database, table: 'Plain', attributes, audit: true });
			await Plain.put('kept', { id: 'kept', body: 'plain' });
		}
	} else {
		const databases = getDatabases();
		await databases.healthy.Plain.put('available', { id: 'available', body: 'healthy' });
		if (mode === 'refuse') {
			assert.match(databaseResidencyBlockReason('experimental'), /1178/);
			await assert.rejects(async () => databases.experimental.Plain.put('refused', { id: 'refused' }), /1178/);
			assert.equal(databases.experimental.Plain.primaryStore.getSync('refused'), undefined);
		} else {
			assert.equal(databaseResidencyBlockReason('experimental'), undefined);
			assert.equal((await databases.experimental.Records.get('kept')).body, 'durable');
			await databases.experimental.Plain.put('restored', { id: 'restored' });
		}
	}
	await flushDatabases();
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
