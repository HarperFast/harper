// Audit history is removed only after a durable floor covers it (harper#2912, harper#2486, harper#2566).
// A RocksDB commit reaches the WAL but is not synced, so a power loss can drop the floor's raise while the
// unlink of the log files it covers survives. These tests stand in for that loss: the root store's barriers
// (`flushSync`, `syncWal`) record what each one made durable, and a simulated crash rolls the floor records
// back to the last barrier's image before the database is reopened.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pack } = require('msgpackr');
const { setupTestDBPath } = require('../testUtils');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { table, closeDatabase, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { asBinary } = require('#src/resources/asBinary');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { transaction } = require('#src/resources/transaction');
const {
	getAuditFloor,
	getAuditResumeFloor,
	getLogPurgeBounds,
	getLogPurgeTrackedFrom,
	purgeAgedLogs,
	setAuditRetention,
	auditRetention,
} = require('#src/resources/auditStore');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const harperLogger = require('#js/utility/logging/harper_logger');
const { waitFor } = require('../waitFor');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// what the floor's transaction writes, and so what a lost WAL tail takes back
const FLOOR_RECORDS = [Symbol.for('audit-floor'), Symbol.for('audit-resume-floor'), Symbol.for('log-purge-bounds')];
const ORIGIN = 'durability-origin';
const HOUR_MS = 3_600_000;

let databaseCount = 0;
function openTable(database) {
	return table({
		table: 'Durable',
		database,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		audit: true,
	});
}

// a replicated write keeps its origin's log key, so a test can place it in the past
function applyAsOrigin(Table, id, logKey) {
	const nodeId = getIdOfRemoteNode(ORIGIN, Table.auditStore);
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await Table.getResource(id, context);
		await resource._writeUpdate(id, { id, name: id }, true, { isNotification: true, nodeId, version: logKey });
	});
}

/**
 * A database whose origin log holds entries keyed two hours back, in files last written then. `preWatermark`
 * reopens it with each log's `txn.purged` removed, as a log created before rocksdb-js 2.14: rocksdb-js reports
 * such a log's watermark unknown, so its purge bound comes from Harper's record, in the floor's transaction.
 */
async function databaseWithAgedHistory({ preWatermark }) {
	const database = `auditPurgeDurability_${databaseCount++}`;
	let Table = openTable(database);
	const removedKeys = [];
	for (let i = 0; i < 3; i++) {
		const logKey = Date.now() - 2 * HOUR_MS + i;
		await applyAsOrigin(Table, `aged-${i}`, logKey);
		removedKeys.push(logKey);
	}
	if (preWatermark) {
		const logsPath = path.join(Table.auditStore.rootStore.path, 'transaction_logs');
		assert.ok(await closeDatabase(database));
		for (const name of fs.readdirSync(logsPath)) fs.rmSync(path.join(logsPath, name, 'txn.purged'), { force: true });
		Table = openTable(database);
	}
	assert.strictEqual(
		Table.auditStore.rootStore.useLog(ORIGIN).getPurgeWatermark().known,
		!preWatermark,
		'precondition: the log kind under test'
	);
	const rootStore = Table.auditStore.rootStore;
	// where the last retention pass before this one left the floors and the purge-bounds record: below any
	// cutoff these tests purge at
	const lastPass = Date.now() - 3 * HOUR_MS;
	const [floorKey, resumeFloorKey, boundsKey] = FLOOR_RECORDS;
	for (const key of [floorKey, resumeFloorKey]) rootStore.putSync(key, asBinary(floorBytes(lastPass)));
	const record = { epoch: lastPass, unobserved: 0, trackedFrom: lastPass, cutoff: lastPass, observedAt: lastPass };
	rootStore.putSync(boundsKey, asBinary(pack({ ...record, positions: {}, logs: {} })));
	await rootStore.flush();
	const directory = path.join(rootStore.path, 'transaction_logs', ORIGIN);
	const agedAt = (Date.now() - 2 * HOUR_MS) / 1000;
	for (const file of fs.readdirSync(directory))
		if (file.endsWith('.txnlog')) fs.utimesSync(path.join(directory, file), agedAt, agedAt);
	return { Table, database, removedKeys };
}

function floorBytes(value) {
	return new Uint8Array(Float64Array.of(value).buffer);
}

function readRecords(auditStore) {
	return FLOOR_RECORDS.map((key) => {
		const bytes = auditStore.getBinary(key);
		return bytes === undefined ? undefined : Uint8Array.from(bytes);
	});
}

/**
 * Instruments the barriers and purge of `target` (a store, or `RocksDatabase.prototype` for a store the boot path
 * has not opened yet), for the store at `path` when given. `durable` is the floor records' image as of the last
 * barrier that returned: what a barrier makes durable is what committed before it was called. Each purge records
 * the image it started over. The starting image must already be durable.
 */
function recordDurability(target, { durable, auditStoreOf, path }) {
	const original = { flushSync: target.flushSync, syncWal: target.syncWal, purgeLogs: target.purgeLogs };
	const state = { durable, purges: [] };
	const watched = (store) => path === undefined || store.path === path;
	target.flushSync = function (...args) {
		if (!watched(this)) return original.flushSync.apply(this, args);
		const image = readRecords(auditStoreOf(this));
		const result = original.flushSync.apply(this, args);
		state.durable = image;
		return result;
	};
	target.syncWal = async function (...args) {
		if (!watched(this)) return original.syncWal.apply(this, args);
		const image = readRecords(auditStoreOf(this));
		await original.syncWal.apply(this, args);
		state.durable = image;
	};
	target.purgeLogs = function (options) {
		if (!watched(this)) return original.purgeLogs.call(this, options);
		const image = state.durable;
		const purged = original.purgeLogs.call(this, options);
		state.purges.push({ before: options.before, durable: image, purged });
		return purged;
	};
	state.restore = () => Object.assign(target, original);
	return state;
}

function recordStore(Table, store = Table.auditStore.rootStore) {
	const auditStore = Table.auditStore;
	return recordDurability(store, { durable: readRecords(auditStore), auditStoreOf: () => auditStore });
}

/** Closes the database, then reopens it the way startup does, so its replay runs the boot purge. */
async function boot(Table, database, retention) {
	assert.ok(await closeDatabase(database));
	const configured = auditRetention;
	setAuditRetention(retention);
	try {
		return resetDatabases()[database].Durable;
	} finally {
		setAuditRetention(configured);
	}
}

/** Power loss right after the purge: the unlinks stay, the floor records fall back to their durable image. */
async function crashAndReopen(Table, database, image) {
	const rootStore = Table.auditStore.rootStore;
	FLOOR_RECORDS.forEach((key, i) => {
		if (image[i] === undefined) rootStore.removeSync(key);
		else rootStore.putSync(key, asBinary(image[i]));
	});
	assert.ok(await closeDatabase(database));
	return openTable(database);
}

function withRetention(retention, run) {
	const configured = auditRetention;
	setAuditRetention(retention);
	try {
		return run();
	} finally {
		setAuditRetention(configured);
	}
}

async function retentionPass(Table, retention) {
	const configured = auditRetention;
	setAuditRetention(retention);
	try {
		await Table.auditStore.scheduleAuditCleanup(1);
	} finally {
		setAuditRetention(configured);
	}
}

function assertCoversRemoved(Table, removedKeys, cutoff, { preWatermark }) {
	const auditStore = Table.auditStore;
	const floor = getAuditFloor(auditStore);
	const resumeFloor = getAuditResumeFloor(auditStore);
	assert.ok(floor >= cutoff, `the reopened floor ${floor} is below the purge cutoff ${cutoff}`);
	assert.ok(resumeFloor >= cutoff, `the reopened resume floor ${resumeFloor} is below the purge cutoff ${cutoff}`);
	const bound = getLogPurgeBounds(auditStore, ORIGIN).get(ORIGIN);
	const trackedFrom = getLogPurgeTrackedFrom(auditStore);
	for (const key of removedKeys) {
		assert.ok(bound >= key, `${preWatermark ? 'pre-2.14' : 'watermarked'} log bound ${bound} is below removed ${key}`);
		assert.ok(trackedFrom <= key || bound >= key, 'precondition: the bound, not the tracking start, covers it');
	}
}

describe('audit history is removed only after a durable floor covers it', function () {
	this.timeout(30000);

	before(function () {
		if (isLMDB) this.skip(); // LMDB has no log-file purge, and syncs each commit
		setupTestDBPath();
		setMainIsWorker(true);
	});

	for (const preWatermark of [false, true]) {
		const kind = preWatermark ? 'a log from before the purge watermark' : 'a watermarked log';

		describe(`on ${kind}`, function () {
			it('the boot purge makes the floor durable before it unlinks (harper#2912)', async () => {
				const { Table, database, removedKeys } = await databaseWithAgedHistory({ preWatermark });
				const path = Table.auditStore.rootStore.path;
				const recorder = recordDurability(RocksDatabase.prototype, {
					durable: readRecords(Table.auditStore),
					auditStoreOf: (store) => store.auditStore,
					path,
				});
				const cutoff = Date.now() - HOUR_MS;
				let Booted;
				try {
					Booted = await boot(Table, database, HOUR_MS);
				} finally {
					recorder.restore();
				}
				const purge = recorder.purges.find((candidate) => candidate.purged.length > 0);
				assert.ok(purge, 'precondition: the boot purge unlinked the aged files');
				assert.strictEqual(Booted.auditStore.rootStore.useLog(ORIGIN).getStats().fileCount, 0);
				const reopened = await crashAndReopen(Booted, database, purge.durable);
				assertCoversRemoved(reopened, removedKeys, cutoff, { preWatermark });
			});

			it('the retention pass makes the floor durable before it unlinks', async () => {
				const { Table, database, removedKeys } = await databaseWithAgedHistory({ preWatermark });
				const recorder = recordStore(Table);
				const cutoff = Date.now() - HOUR_MS;
				try {
					await retentionPass(Table, HOUR_MS);
				} finally {
					recorder.restore();
				}
				const purge = recorder.purges.find((candidate) => candidate.purged.length > 0);
				assert.ok(purge, 'precondition: the pass unlinked the aged files');
				const reopened = await crashAndReopen(Table, database, purge.durable);
				assertCoversRemoved(reopened, removedKeys, cutoff, { preWatermark });
			});

			it('delete_transaction_logs_before makes the floor durable before it unlinks', async () => {
				const { Table, database, removedKeys } = await databaseWithAgedHistory({ preWatermark });
				const recorder = recordStore(Table, Table.primaryStore);
				const cutoff = Date.now() - HOUR_MS;
				try {
					const results = await harperBridge.deleteTransactionLogsBefore({ database, timestamp: cutoff });
					assert.ok(results.log_files_deleted > 0, 'precondition: the operation unlinked the aged files');
				} finally {
					recorder.restore();
				}
				const [purge] = recorder.purges;
				const reopened = await crashAndReopen(Table, database, purge.durable);
				assertCoversRemoved(reopened, removedKeys, cutoff, { preWatermark });
			});
		});
	}

	describe('when the floor cannot be made durable (harper#2486)', function () {
		const noSpace = () =>
			Object.assign(new Error('IO error: No space left on device: While appending to file'), { code: 'ENOSPC' });

		async function assertNothingRemoved(Table, removedKeys, floorBefore) {
			assert.ok(Table.auditStore.rootStore.useLog(ORIGIN).getStats().fileCount > 0, 'the aged files must remain');
			const floor = getAuditFloor(Table.auditStore);
			assert.ok(floor >= floorBefore, `the floor fell from ${floorBefore} to ${floor}`);
			const keys = [];
			for (const entry of Table.auditStore.getRange({ start: 1, log: ORIGIN, snapshot: false }))
				keys.push(entry.txnLogKey);
			assert.deepStrictEqual(keys, removedKeys, 'every entry stays readable');
		}

		it('the boot purge removes nothing when the floor commit fails', async () => {
			const { Table, removedKeys } = await databaseWithAgedHistory({ preWatermark: false });
			const rootStore = Table.auditStore.rootStore;
			const floorBefore = getAuditFloor(Table.auditStore);
			const recorder = recordStore(Table);
			const transactionSync = rootStore.transactionSync;
			rootStore.transactionSync = () => {
				throw noSpace();
			};
			try {
				assert.throws(() => withRetention(HOUR_MS, () => purgeAgedLogs(rootStore)), /No space left/);
			} finally {
				rootStore.transactionSync = transactionSync;
				recorder.restore();
			}
			assert.deepStrictEqual(recorder.purges, []);
			await assertNothingRemoved(Table, removedKeys, floorBefore);
		});

		it('the boot purge still sheds aged files when only its barrier fails, behind the floor it committed first', async () => {
			// harper#2486: flushSync needs a new SST, so a full disk fails it where the floor's WAL append landed, and
			// these files are what a full node sheds to recover. The floor still precedes the unlink across a crash.
			const { Table, database, removedKeys } = await databaseWithAgedHistory({ preWatermark: true });
			const path = Table.auditStore.rootStore.path;
			const cutoff = Date.now() - HOUR_MS;
			const { flushSync, purgeLogs } = RocksDatabase.prototype;
			let barriers = 0;
			let floorAtPurge;
			RocksDatabase.prototype.flushSync = function (...args) {
				if (this.path !== path) return flushSync.apply(this, args);
				barriers++;
				throw noSpace();
			};
			RocksDatabase.prototype.purgeLogs = function (options) {
				if (this.path === path) floorAtPurge = getAuditFloor(this.auditStore);
				return purgeLogs.call(this, options);
			};
			const warnings = [];
			const warn = harperLogger.warn;
			harperLogger.warn = (...args) => warnings.push(args);
			let Booted;
			try {
				Booted = await boot(Table, database, HOUR_MS);
			} finally {
				Object.assign(RocksDatabase.prototype, { flushSync, purgeLogs });
				harperLogger.warn = warn;
			}
			assert.ok(barriers > 0, 'precondition: the boot purge reached its barrier');
			assert.ok(
				floorAtPurge >= cutoff,
				`the floor ${floorAtPurge} was not committed before the purge (cutoff ${cutoff})`
			);
			assert.strictEqual(Booted.auditStore.rootStore.useLog(ORIGIN).getStats().fileCount, 0, 'the aged files are shed');
			const warning = warnings.find(([message]) => /before its audit floor is power-loss durable/.test(message));
			assert.ok(warning, 'the fallback is reported');
			assert.match(warning[1].message, /No space left/, 'with the barrier error');
			await Booted.put('after-fallback', { name: 'x' });
			assert.ok(await closeDatabase(database));
			assertCoversRemoved(openTable(database), removedKeys, cutoff, { preWatermark: true });
		});

		it('the retention pass removes nothing when the barrier fails, and purges on a later pass', async () => {
			const { Table, removedKeys } = await databaseWithAgedHistory({ preWatermark: false });
			const rootStore = Table.auditStore.rootStore;
			const floorBefore = getAuditFloor(Table.auditStore);
			const recorder = recordStore(Table);
			const syncWal = rootStore.syncWal;
			rootStore.syncWal = () => Promise.reject(noSpace());
			try {
				await retentionPass(Table, HOUR_MS);
			} finally {
				rootStore.syncWal = syncWal;
			}
			try {
				assert.deepStrictEqual(recorder.purges, []);
				await assertNothingRemoved(Table, removedKeys, floorBefore);
				await retentionPass(Table, HOUR_MS);
			} finally {
				recorder.restore();
			}
			assert.ok(
				recorder.purges.some((purge) => purge.purged.length > 0),
				'space comes back on the next pass that can record its floor'
			);
		});
	});

	describe('Table.deleteHistory on RocksDB (harper#2566)', function () {
		it('removes no audit entry, says so, and does not scan the log', async () => {
			const Table = openTable(`auditPurgeDurability_${databaseCount++}`);
			const startTime = Date.now() - 1;
			await Table.put('kept', { name: 'kept' });
			await Table.put('deleted', { name: 'deleted' });
			await Table.delete('deleted');
			const historyBefore = [];
			for await (const entry of Table.getHistory()) historyBefore.push(entry.localTime);
			assert.ok(historyBefore.length >= 3, 'precondition: history to keep');
			const auditStore = Table.auditStore;
			let scans = 0;
			const getRange = auditStore.getRange;
			auditStore.getRange = function (...args) {
				scans++;
				return getRange.apply(this, args);
			};
			let entriesDeleted;
			try {
				entriesDeleted = await Table.deleteHistory(Date.now() + 60_000);
			} finally {
				auditStore.getRange = getRange;
			}
			assert.strictEqual(entriesDeleted, 0);
			assert.strictEqual(scans, 0, 'a call that can remove nothing must not walk the log');
			const historyAfter = [];
			for await (const entry of Table.getHistory()) historyAfter.push(entry.localTime);
			assert.deepStrictEqual(historyAfter, historyBefore);
			assert.strictEqual(Table.primaryStore.getEntry('deleted')?.value, null, 'the tombstone stays with its entry');

			// a subscriber replaying from before the delete still receives it: no history went missing behind a floor
			// that does not say so
			const events = [];
			const subscription = await Table.subscribe({ startTime, listener: (event) => events.push(event) });
			try {
				await waitFor(() => events.some((event) => event.id === 'deleted' && event.type === 'delete'));
			} finally {
				subscription.end();
			}
		});

		it('still removes tombstones when asked to clean up deleted records', async () => {
			const Table = openTable(`auditPurgeDurability_${databaseCount++}`);
			await Table.put('swept', { name: 'swept' });
			await Table.delete('swept');
			assert.strictEqual(Table.primaryStore.getEntry('swept')?.value, null, 'precondition: a tombstone');
			assert.strictEqual(await Table.deleteHistory(Date.now() + 60_000, true), 0);
			assert.strictEqual(Table.primaryStore.getEntry('swept'), undefined);
		});
	});
});
