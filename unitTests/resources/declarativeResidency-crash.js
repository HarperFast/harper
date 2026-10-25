const exit = process.exit.bind(process);
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
	logger.setMainLogger({ ...logger.createLogger(), error: (...args) => console.error(...args) });
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
		if (mode.startsWith('runtime-worker-rescan')) {
			const assert = require('node:assert');
			const { Worker, parentPort } = require('node:worker_threads');
			const { once } = require('node:events');
			const { resetDatabases, databaseResidencyBlockReason } = require('#src/resources/databases');
			getDatabases();
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'other' }]],
			]);
			if (parentPort) {
				assert.equal(getDatabases()[database], undefined, 'the worker scans before the database exists');
				parentPort.postMessage('ready');
				await once(parentPort, 'message');
				env.setProperty('replication_shards', [1]);
				resetDatabases();
				env.setProperty('replication_shards', [0, 1]);
				assert.equal(
					databaseResidencyBlockReason(database),
					undefined,
					'a later worker scan cannot invent startup quarantine'
				);
				assert.equal((await getDatabases()[database].RuntimeSlots.get('local')).body, 'complete');
				exit(0);
			}
			const worker = new Worker(__filename, { argv: [root, marker, 'runtime-worker-rescan-child'] });
			const completion = once(worker, 'exit');
			await once(worker, 'message');
			await loadGQLSchema(
				`type RuntimeSlots @table(database: "${database}") @sharded(slots: 2, by: "region", slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }`
			);
			await getDatabases()[database].RuntimeSlots.put('local', { id: 'local', region: 0, body: 'complete' });
			worker.postMessage('load');
			const [code] = await completion;
			assert.equal(code, 0);
			assert.equal(databaseResidencyBlockReason(database), undefined);
			exit(0);
		}
		if (mode === 'runtime-open-rescan') {
			const assert = require('node:assert');
			const { resetDatabases, databaseResidencyBlockReason } = require('#src/resources/databases');
			getDatabases();
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'other' }]],
			]);
			await loadGQLSchema(
				`type RuntimeSlots @table(database: "${database}") @sharded(slots: 2, by: "region", slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }`
			);
			const Table = getDatabases()[database].RuntimeSlots;
			await Table.put('local', { id: 'local', region: 0, body: 'complete' });
			env.setProperty('replication_shards', [1]);
			resetDatabases();
			env.setProperty('replication_shards', [0, 1]);
			assert.equal(databaseResidencyBlockReason(database), undefined, 'runtime-opened root was already recovered');
			assert.equal((await Table.get('local')).body, 'complete');
			await Table.put('repaired', { id: 'repaired', region: 0, body: 'available' });
			exit(0);
		}
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
				`type CrashSlots @table(database: "${database}") @sharded(slots: 2, by: "region", slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }`
			);
			if (mode === 'write') await getResidencyMapTable().primaryStore.rootStore.flush();
			const Table = getDatabases()[database].CrashSlots;
			await Table.put('local', { id: 'local', region: 0, body: 'complete' });
			await Table.put('remote', { id: 'remote', region: 1, body: 'remote body' });
			await Table.put('deleted', { id: 'deleted', region: 0, body: 'removed' });
			await Table.delete('deleted');
			if (mode === 'write-bad-count') {
				const { createResidencyMap } = require('#src/resources/residencyPolicy');
				const Maps = getResidencyMapTable();
				// Emulate a persisted map left by a build that permitted larger database maps.
				await Maps.primaryStore.put(
					database,
					createResidencyMap(
						database,
						4,
						[
							{ start: 0, end: 1, shard: 0 },
							{ start: 1, end: 4, shard: 1 },
						],
						2
					)
				);
				await Maps.primaryStore.rootStore.flush();
			}
			writeFileSync(marker, 'written');
			process.kill(process.pid, 'SIGKILL');
		} else {
			const { syncBuiltinESMExports } = require('node:module');
			if (mode === 'replay-system-first') {
				const fs = require('node:fs');
				const readdir = fs.readdirSync;
				fs.readdirSync = (directory, ...args) => {
					const entries = readdir(directory, ...args);
					return directory === path.join(root, 'database')
						? entries.sort((a, b) => a.name.localeCompare(b.name))
						: entries;
				};
				syncBuiltinESMExports();
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
				syncBuiltinESMExports();
				try {
					require('node:assert').throws(() => getDatabases(), /injected scan failure/);
				} finally {
					fs.readdirSync = readdir;
					syncBuiltinESMExports();
				}
			}
			if (mode === 'replay-bad-count') {
				const assert = require('node:assert');
				const loaded = getDatabases();
				const Blocked = loaded[database].CrashSlots;
				assert.throws(
					() => Blocked.get('local'),
					(error) => error.code === 'DATABASE_SHARDING_BLOCKED' && /2.*4/.test(error.message)
				);
				assert.ok(
					Array.from(Blocked.auditStore.getRange({ startFromLastFlushed: true, readUncommitted: true })).length >= 4
				);
				assert.equal((await loaded.healthy.Rows.get('good')).body, 'healthy tail');
				writeFileSync(marker, JSON.stringify({ refused: true }));
				exit(0);
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
						error.code === 'DATABASE_SHARDING_BLOCKED' &&
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
					await loadGQLSchema(`type CrashSlots @table(database: "${database}") @sharded(slots: 2, by: "region", slotFrom: "region") { id: ID @primaryKey region: Int @indexed body: String }
						type NewBlocked @table(database: "${database}") { id: ID @primaryKey }
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
					// A graceful shutdown must preserve the same replay obligation as an abrupt exit.
					await require('#src/resources/databases').closeLoadedDatabases({ requireClosed: true });
				}
				writeFileSync(marker, JSON.stringify({ refused: true }));
				exit(0);
			}
			if (mode === 'replay-initial-guard')
				require('#src/resources/residencyMaps').setResidencyPlacementGuard(() => {
					throw new Error('peer discovery has not settled');
				});
			const Table = getDatabases()[database].CrashSlots;
			if (mode === 'replay-initial-guard')
				require('#src/resources/residencyMaps').setResidencyPlacementGuard(undefined);
			if (mode.startsWith('replay-rescan-')) {
				const assert = require('node:assert');
				const { resetDatabases, databaseResidencyBlockReason } = require('#src/resources/databases');
				const { setResidencyPlacementGuard } = require('#src/resources/residencyMaps');
				server.shards = new Map([
					[0, [{ name: server.hostname }]],
					[1, [{ name: 'other' }]],
				]);
				try {
					if (mode === 'replay-rescan-config') env.setProperty('replication_shards', [1]);
					else
						setResidencyPlacementGuard(() => {
							throw new Error('temporary topology disagreement');
						});
					resetDatabases();
					assert.equal((await getDatabases().healthy.Rows.get('good')).body, 'healthy tail');
				} finally {
					env.setProperty('replication_shards', [0, 1]);
					setResidencyPlacementGuard(undefined);
				}
				assert.equal(databaseResidencyBlockReason(database), undefined, 'runtime refusal is not startup quarantine');
				assert.equal((await Table.get('local')).body, 'complete');
				await Table.put('after-rescan', { id: 'after-rescan', region: 0, body: 'recovered' });
				assert.equal((await Table.get('after-rescan')).body, 'recovered');
			}
			const rows = Object.fromEntries(
				['local', 'remote', 'deleted'].map((id) => {
					const entry = Table.primaryStore.getEntry(id);
					return [id, { slot: entry?.residencySlot, body: entry?.value?.body, region: entry?.value?.region }];
				})
			);
			writeFileSync(marker, JSON.stringify({ replayed, rows }));
			exit(0);
		}
	})().catch((error) => {
		console.error(error);
		exit(1);
	});
}
