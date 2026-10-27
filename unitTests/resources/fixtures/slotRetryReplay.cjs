const { createRequire } = require('node:module');
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert');
const req = createRequire(path.resolve(__dirname, '../../../package.json'));
const [mode, root, output] = process.argv.slice(2);
process.env.ROOTPATH = root;
process.env.STORAGE_PATH = path.join(root, 'database');
const env = req('#src/utility/environment/environmentManager');
const terms = req('#src/utility/hdbTerms');
env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(root, 'database'));
env.setProperty('replication_shards', [0, 1]);
env.setProperty('replication_shard', 0);
env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
mkdirSync(path.join(root, 'database'), { recursive: true });
assert.equal(env.get(terms.CONFIG_PARAMS.STORAGE_PATH), path.join(root, 'database'));

const { DatabaseTransaction, replicationConfirmation } = req('#src/resources/DatabaseTransaction');
const native = req('@harperfast/rocksdb-js');
if (process.env.HARPER_TEST_ABORT_MARKER_LEGACY_RED === '1') native.Transaction.prototype.usesAbortMarkers = () => true;
else assert.equal(typeof native.Transaction.prototype.usesAbortMarkers, 'function');
native.RocksDatabase.config({ transactionLogAbortMarkers: true });
const helper = require('./slotRetryAbort.cjs');
const commits = [];
if (mode === 'replay') {
	const original = DatabaseTransaction.prototype.directCommitSync;
	DatabaseTransaction.prototype.directCommitSync = function (...args) {
		if (!this.isReplay) return original.apply(this, args);
		const before = this.db.getEntry('retry-abort');
		const operations = this.writes
			.filter(Boolean)
			.map((w) => ({ key: w.key, slot: w.stagedEntry?.residencySlot, skipped: w.skipped }));
		const result = original.apply(this, args);
		const after = this.db.getEntry('retry-abort');
		commits.push({
			timestamp: this.timestamp,
			operations,
			before: before?.value,
			after: after?.value,
			slot: after?.residencySlot,
		});
		return result;
	};
}
const { getDatabases } = req('#src/resources/databases');
const { loadGQLSchema } = req('#src/resources/graphql');
const { getResidencyMapTable, setResidencyPlacementGuard } = req('#src/resources/residencyMaps');
const { server } = req('#src/server/Server');
req('#src/server/threads/manageThreads').setMainIsWorker(true);
server.shards = new Map([
	[0, [{ name: server.hostname }]],
	[1, [{ name: 'other' }]],
]);
(async () => {
	if (mode === 'write') {
		await loadGQLSchema(
			'type RetryRows @table(database: "slotabort", replicaExpiration: 0) @sharded(slots: 2, by: "region", slotFrom: "region === 0 ? 0 : zone") { id: ID @primaryKey region: Int @indexed zone: Int @indexed body: String }'
		);
		const Records = getDatabases().slotabort.RetryRows;
		assert.ok(Records.primaryStore.rootStore.path.startsWith(root + path.sep), 'isolated native store');
		await getResidencyMapTable().primaryStore.rootStore.flush();
		await Records.primaryStore.rootStore.flush();
		const result = await helper.abortMove(Records, {
			transaction: req('#src/resources/transaction').transaction,
			...req('./unitTests/rocksdbBindings.mts').rocksdbBindings(),
			setResidencyPlacementGuard,
			replicationConfirmation,
		});
		result.replayTail = helper.audit(Records, { start: undefined, startFromLastFlushed: true, readUncommitted: true });
		writeFileSync(output, JSON.stringify(result, null, 2));
		process.kill(process.pid, 'SIGKILL');
	} else {
		const Records = getDatabases().slotabort.RetryRows;
		assert.ok(Records.primaryStore.rootStore.path.startsWith(root + path.sep), 'isolated native store');
		const result = {
			commits,
			primary: helper.snapshot(Records),
			audit: helper.audit(Records, { readUncommitted: true }),
		};
		assert.ok(
			commits.some((c) => c.operations.some((w) => w.key === 'retry-abort')),
			'startup replay reached the target record'
		);
		writeFileSync(output, JSON.stringify(result, null, 2));
		process.exit(0);
	}
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
