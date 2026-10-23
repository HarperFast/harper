const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

if (require.main === module) {
	const [root, marker, mode] = process.argv.slice(2);
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(root, 'database'));
	env.setProperty('replication_shards', [0, 1]);
	env.setProperty('replication_shard', 0);
	env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
	mkdirSync(path.join(root, 'database'), { recursive: true });
	const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
	const logger = require('#src/utility/logging/harper_logger');
	logger.error = (...args) => console.error(...args);
	let replayed = 0;
	if (mode === 'replay') {
		const commit = DatabaseTransaction.prototype.directCommitSync;
		DatabaseTransaction.prototype.directCommitSync = function () {
			if (this.isReplay) replayed += this.writes.filter((write) => write && !write.skipped).length;
			return commit.call(this);
		};
	}
	const { getDatabases } = require('#src/resources/databases');
	const { loadGQLSchema } = require('#src/resources/graphql');
	const { getResidencyMapTable } = require('#src/resources/residencyMaps');
	const { server } = require('#src/server/Server');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	(async () => {
		if (mode.startsWith('write')) {
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'other' }]],
			]);
			await loadGQLSchema(
				'type CrashSlots @table(database: "slotcrash") @residency(slots: 2, byAttribute: true, slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }'
			);
			if (mode === 'write') await getResidencyMapTable().primaryStore.rootStore.flush();
			const Table = getDatabases().slotcrash.CrashSlots;
			await Table.put('local', { id: 'local', region: 0, body: 'complete' });
			await Table.put('remote', { id: 'remote', region: 1, body: 'remote body' });
			await Table.put('deleted', { id: 'deleted', region: 0, body: 'removed' });
			await Table.delete('deleted');
			writeFileSync(marker, 'written');
			process.kill(process.pid, 'SIGKILL');
		} else {
			const Table = getDatabases().slotcrash.CrashSlots;
			const rows = Object.fromEntries(
				['local', 'remote', 'deleted'].map((id) => {
					const entry = Table.primaryStore.getEntry(id);
					return [id, { slot: entry?.residencySlot, body: entry?.value?.body, region: entry?.value?.region }];
				})
			);
			writeFileSync(marker, JSON.stringify({ replayed, rows }));
			process.exit(0);
		}
	})().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
