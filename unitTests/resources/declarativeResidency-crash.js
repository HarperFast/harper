const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

if (require.main === module) {
	const [root, marker, mode] = process.argv.slice(2);
	const database = mode.endsWith('system-first') ? 'zzslotcrash' : 'slotcrash';
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(root, 'database'));
	env.setProperty('replication_shards', mode === 'replay-bad-config' ? [1] : [0, 1]);
	env.setProperty('replication_shard', 0);
	env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
	mkdirSync(path.join(root, 'database'), { recursive: true });
	const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
	const logger = require('#src/utility/logging/harper_logger');
	logger.error = (...args) => console.error(...args);
	let replayed = 0;
	if (mode.startsWith('replay')) {
		const commit = DatabaseTransaction.prototype.directCommitSync;
		DatabaseTransaction.prototype.directCommitSync = function () {
			if (this.isReplay) replayed += this.writes.filter((write) => write && !write.skipped).length;
			return commit.call(this);
		};
	}
	const { getDatabases, table, flushDatabases } = require('#src/resources/databases');
	const { loadGQLSchema } = require('#src/resources/graphql');
	const { getResidencyMapTable } = require('#src/resources/residencyMaps');
	const { server } = require('#src/server/Server');
	const { setMainIsWorker } = require('#src/server/threads/manageThreads');
	setMainIsWorker(true);
	(async () => {
		if (mode.startsWith('write')) {
			const Healthy = table({
				database: 'healthy',
				table: 'Rows',
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			});
			await Healthy.put('good', { id: 'good', body: 'healthy tail' });
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'other' }]],
			]);
			await loadGQLSchema(
				`type CrashSlots @table(database: "${database}") @residency(slots: 2, byAttribute: true, slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }`
			);
			if (mode === 'write') await getResidencyMapTable().primaryStore.rootStore.flush();
			const Table = getDatabases()[database].CrashSlots;
			await Table.put('local', { id: 'local', region: 0, body: 'complete' });
			await Table.put('remote', { id: 'remote', region: 1, body: 'remote body' });
			await Table.put('deleted', { id: 'deleted', region: 0, body: 'removed' });
			await Table.delete('deleted');
			writeFileSync(marker, 'written');
			process.kill(process.pid, 'SIGKILL');
		} else {
			if (mode === 'replay-system-first') {
				const fs = require('node:fs');
				const readdir = fs.readdirSync;
				fs.readdirSync = (directory, ...args) => {
					const entries = readdir(directory, ...args);
					return directory === path.join(root, 'database')
						? entries.sort((a, b) => a.name.localeCompare(b.name))
						: entries;
				};
			}
			if (mode === 'replay-scan-error') {
				const fs = require('node:fs');
				const readdir = fs.readdirSync;
				fs.readdirSync = (directory, ...args) => {
					if (directory === path.join(root, 'database', 'system')) throw new Error('injected scan failure');
					const entries = readdir(directory, ...args);
					return directory === path.join(root, 'database')
						? entries.sort((a, b) => a.name.localeCompare(b.name))
						: entries;
				};
				try {
					require('node:assert').throws(() => getDatabases(), /injected scan failure/);
				} finally {
					fs.readdirSync = readdir;
				}
			}
			if (mode === 'replay-bad-config' || mode === 'worker-repaired') {
				const assert = require('node:assert');
				const loaded = getDatabases();
				const Blocked = loaded[database].CrashSlots;
				const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
				const bridge = new ResourceBridge();
				assert.throws(
					() =>
						bridge.searchByHash({
							database,
							schema: database,
							table: 'CrashSlots',
							hash_values: ['local'],
							get_attributes: ['*'],
						}),
					/replication.shard/
				);
				await assert.rejects(bridge.getBackup({ database }), /replication.shard/);
				const tail = () =>
					Array.from(
						Blocked.auditStore.getRange({ startFromLastFlushed: true, readUncommitted: true }),
						(entry) => entry.txnLogKey
					);
				const before = tail();
				assert.ok(before.length >= 4, 'unreplayed tail remains');
				assert.throws(
					() => Blocked.get('local'),
					(error) =>
						error.code === 'DATABASE_RESIDENCY_BLOCKED' &&
						error.retryable === false &&
						/replication.shard/.test(error.message)
				);
				await assert.rejects(async () => Blocked.put('no', { id: 'no', region: 0 }), /replication.shard/);
				assert.equal((await loaded.healthy.Rows.get('good')).body, 'healthy tail');
				await loaded.healthy.Rows.put('still', { id: 'still', body: 'available' });
				await flushDatabases();
				assert.deepEqual(tail(), before, 'healthy flush must not consume the blocked tail');
				if (mode === 'replay-bad-config') {
					env.setProperty('replication_shards', [0, 1]);
					await loadGQLSchema(`type CrashSlots @table(database: "${database}") @residency(slots: 2, byAttribute: true, slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }
						type HealthyReload @table(database: "healthy") { id: ID @primaryKey }`);
					assert.throws(() => Blocked.get('local'), /replication.shard/);
					await getDatabases().healthy.HealthyReload.put('ok', { id: 'ok' });
					const { Worker } = require('node:worker_threads');
					await new Promise((resolve, reject) => {
						const worker = new Worker(__filename, { argv: [root, marker, 'worker-repaired'] });
						const deadline = setTimeout(() => {
							void worker.terminate();
							reject(new Error('blocked worker timed out'));
						}, 10000);
						worker.once('error', reject);
						worker.once('exit', (code) => {
							clearTimeout(deadline);
							code === 0 ? resolve() : reject(new Error(`blocked worker exit ${code}`));
						});
					});
					assert.deepEqual(tail(), before, 'new worker did not replay after repair');
				}
				writeFileSync(marker, JSON.stringify({ refused: true }));
				process.exit(0);
			}
			const Table = getDatabases()[database].CrashSlots;
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
