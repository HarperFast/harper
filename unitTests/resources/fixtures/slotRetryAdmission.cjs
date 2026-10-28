const { createRequire } = require('node:module');
const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert');
const req = createRequire(path.resolve(__dirname, '../../../package.json'));
const [mode, marker, root, output] = process.argv.slice(2);
process.env.ROOTPATH = root;
process.env.STORAGE_PATH = path.join(root, 'database');
const env = req('#src/utility/environment/environmentManager');
env.setProperty('replication_experimentalAttributeSlots', true);
env.setProperty('storage_rocks_transactionLogAbortMarkers', true);
const terms = req('#src/utility/hdbTerms');
env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root);
env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(root, 'database'));
env.setProperty('replication_shards', [0, 1]);
env.setProperty('replication_shard', 0);
env.setProperty(terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
mkdirSync(path.join(root, 'database'), { recursive: true });
const { replicationConfirmation } = req('#src/resources/DatabaseTransaction');
const { transaction } = req('#src/resources/transaction');
const { Transaction, constants } = req('./unitTests/rocksdbBindings.mts').rocksdbBindings();
if (marker === 'native') {
	const native = req('@harperfast/rocksdb-js');
	native.RocksDatabase.config({ transactionLogAbortMarkers: true });
	if (process.env.HARPER_TEST_ABORT_MARKER_LEGACY_RED === '1') Transaction.prototype.usesAbortMarkers = () => true;
	else assert.equal(typeof Transaction.prototype.usesAbortMarkers, 'function');
} else
	Object.defineProperty(Transaction.prototype, 'usesAbortMarkers', {
		configurable: true,
		value: marker === 'missing' ? undefined : () => marker === 'true',
	});
const { logger } = req('#src/utility/logging/logger');
const warnings = [];
logger.warn = (...args) => warnings.push(args.join(' '));
const { getDatabases } = req('#src/resources/databases');
const { loadGQLSchema } = req('#src/resources/graphql');
const { getResidencyMapTable, setResidencyPlacementGuard } = req('#src/resources/residencyMaps');
const { server } = req('#src/server/Server');
req('#src/server/threads/manageThreads').setMainIsWorker(true);
server.shards = new Map([
	[0, [{ name: server.hostname }]],
	[1, [{ name: 'other' }]],
]);
const id = 'retry-probe';
(async () => {
	await loadGQLSchema(
		'type RetryRows @table(database: "slotprobe", replicaExpiration: 0) @sharded(slots: 2, by: "region", slotFrom: "region === 0 ? 0 : zone") { id: ID @primaryKey region: Int @indexed zone: Int @indexed body: String }'
	);
	const Records = getDatabases().slotprobe.RetryRows;
	assert.ok(Records.primaryStore.rootStore.path.startsWith(root + path.sep));
	await getResidencyMapTable().primaryStore.rootStore.flush();
	await Records.put(id, {
		id,
		region: mode === 'local-only-put' ? 2 : 0,
		zone: mode === 'local-only-put' ? 1 : 0,
		body: 'original',
	});
	const binding = Object.values(require.cache).find(
		(m) => m.filename?.endsWith('.node') && typeof m.exports.forceTryAgainForTesting === 'function'
	)?.exports;
	assert.ok(binding);
	const commit = Transaction.prototype.commit,
		abort = Transaction.prototype.abort;
	const attempts = [],
		aborts = [],
		confirmations = [];
	let firstId, admittedSlot, error, concurrent;
	const snapshot = () => {
		const row = Records.primaryStore.getEntry(id);
		return {
			slot: row?.residencySlot,
			version: row?.version,
			flags: row?.metadataFlags,
			value: row?.value,
			indexes: Object.fromEntries(
				['region', 'zone'].map((name) => [name, [...Records.indices[name].getRange({})].filter((e) => e.value === id)])
			),
		};
	};
	Transaction.prototype.abort = function (...args) {
		const entry = { id: this.id };
		aborts.push(entry);
		try {
			return abort.apply(this, args);
		} catch (e) {
			entry.code = e.code;
			entry.message = e.message;
			throw e;
		}
	};
	Transaction.prototype.commit = function (...args) {
		if (this.store?.db !== Records.primaryStore.store.db) return commit.apply(this, args);
		attempts.push(this.id);
		const first = firstId === undefined;
		if (first) firstId = this.id;
		const result = commit.apply(this, args);
		if (!first) return result;
		const changeBase = async () => {
			await transaction({}, () =>
				Records.put(id, {
					id,
					region: mode === 'local-only-put' ? 0 : 2,
					zone: ['invalid', 'local-only-put'].includes(mode) ? 0 : 1,
					body: 'concurrent',
				})
			);
			concurrent = snapshot();
		};
		return result.then(
			async (out) => {
				assert.equal(out, constants.RETRY_NOW_VALUE);
				await changeBase();
				return out;
			},
			async (e) => {
				assert.equal(e.code, 'ERR_TRY_AGAIN');
				await changeBase();
				throw e;
			}
		);
	};
	setResidencyPlacementGuard(() => {});
	replicationConfirmation((...args) => {
		confirmations.push(args);
		return Promise.resolve();
	});
	try {
		const context = { timestamp: Date.now() + 60_000 };
		try {
			await transaction(context, async () => {
				if (mode === 'invalid') await Records.patch(id, { zone: 50 });
				else if (mode === 'delete') await Records.delete(id);
				else if (mode === 'local-only-put') {
					const row = await Records.getResource(id, context);
					await row._writeUpdate(id, { id, region: 2, zone: 1, body: 'submitted' }, true, { localOnly: true });
					await row.save();
				} else {
					const row = await Records.getResource(id, context);
					row._writeInvalidate(id, { region: 0, zone: 0 });
				}
				const write = context.transaction.writes.find((w) => w?.key === id);
				admittedSlot = write.residencyOwnerSlot;
				assert.equal(admittedSlot, mode === 'local-only-put' ? 1 : 0);
				binding.forceTryAgainForTesting(1);
			});
		} catch (e) {
			error = { name: e.name, code: e.code, statusCode: e.statusCode, retryable: e.retryable, message: e.message };
		}
		const audit = [...Records.auditStore.getRange({ start: 1, log: 0 })]
			.filter((e) => e.tableId === Records.tableId && e.recordId === id)
			.map((e) => ({
				type: e.type,
				slot: e.residencySlot,
				version: e.version,
				txnLogKey: e.txnLogKey,
				value: e.getValue(Records.primaryStore),
			}));
		const primary = snapshot();
		let freshError;
		if (mode === 'invalid' && !error) {
			try {
				await Records.patch(id, { body: 'fresh' });
			} catch (e) {
				freshError = { statusCode: e.statusCode, message: e.message };
			}
			assert.deepEqual(snapshot(), primary, 'fresh invalid write must not change the stored row or indexes');
		}
		writeFileSync(
			output,
			JSON.stringify(
				{
					mode,
					marker,
					firstId,
					admittedSlot,
					attempts,
					aborts,
					error,
					concurrent,
					primary,
					audit,
					confirmations,
					warnings,
					freshError,
				},
				null,
				2
			)
		);
	} finally {
		binding.forceTryAgainForTesting(0);
		Transaction.prototype.commit = commit;
		Transaction.prototype.abort = abort;
		setResidencyPlacementGuard(undefined);
		replicationConfirmation(undefined);
	}
	process.exit(0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
