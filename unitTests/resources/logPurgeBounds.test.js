// harper-pro#1229: the per-log purge bound a replication source compares a follower's resume position against.
// The property every test defends is one-directional: the bound may sit above what a prune removed (a resync
// that was not needed), never below it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pack, unpack } = require('msgpackr');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { asBinary } = require('#src/resources/asBinary');
const {
	getAuditFloor,
	getLogPurgeBound,
	getLogPurgeBounds,
	getLogPurgeTrackedFrom,
	raiseAuditFloor,
	stampDatabaseGeneration,
	purgeAgedLogs,
	setAuditRetention,
	auditRetention,
} = require('#src/resources/auditStore');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const LOG_PURGE_BOUNDS_KEY = Symbol.for('log-purge-bounds');
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');

let databaseCount = 0;
function freshTable() {
	return table({
		table: 'Bounded',
		database: `logPurgeBounds_${databaseCount++}`,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		audit: true,
	});
}

const DAY_MS = 86_400_000;

function writeMetadata(auditStore, key, bytes) {
	const root = auditStore.rootStore;
	if (typeof root.putSync === 'function' && auditStore.reusableIterable) root.putSync(key, asBinary(bytes));
	else auditStore.putSync(key, asBinary(bytes));
}

function floorBytes(value) {
	return new Uint8Array(Float64Array.of(value).buffer);
}

// what `_writeUpdate` does for a replicated write: the origin's own log key, not a minted local one
function applyAsOrigin(Table, id, { nodeId, logKey }) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await Table.getResource(id, context);
		await resource._writeUpdate(id, { id, name: id }, true, { isNotification: true, nodeId, version: logKey });
	});
}

function localLogKeys(auditStore) {
	const keys = [];
	for (const entry of auditStore.getRange({ start: 1, ...(isLMDB ? {} : { log: 'local' }), snapshot: false }))
		keys.push(entry.txnLogKey);
	return keys;
}

const scope = (name) => (isLMDB ? undefined : [name]);

function nativeRetention(auditStore) {
	return auditStore.rootStore.useLog('local').getStats().config.retentionMs;
}

function writeRecord(auditStore, record) {
	writeMetadata(auditStore, LOG_PURGE_BOUNDS_KEY, pack(record));
}

// a database whose floor is `age` old, so a bound read within its first minute is not just the new epoch
function backdatedTable(age = 3_600_000) {
	const Table = freshTable();
	const floor = Date.now() - age;
	writeMetadata(Table.auditStore, AUDIT_FLOOR_KEY, floorBytes(floor));
	writeRecord(Table.auditStore, { epoch: floor, cutoff: floor, observedAt: 0, logs: {} });
	return Table;
}

// so the keys written so far sit below a cutoff of Date.now(): a pass observes only a cutoff in the past
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function interceptQueries(rootStore, query) {
	const useLog = rootStore.useLog;
	rootStore.useLog = function (name) {
		const log = useLog.call(this, name);
		return {
			name: log.name,
			getStats: () => log.getStats(),
			getPurgeWatermark: () => log.getPurgeWatermark(),
			query: (options) => query(name, log, options),
		};
	};
	return () => (rootStore.useLog = useLog);
}

// flushed, so a purge may remove them, and last written at `mtime`
async function ageLogFiles(Table, name, mtime) {
	const rootStore = Table.auditStore.rootStore;
	await rootStore.flush();
	const directory = path.join(rootStore.path, 'transaction_logs', name);
	for (const file of fs.readdirSync(directory))
		if (file.endsWith('.txnlog')) fs.utimesSync(path.join(directory, file), mtime / 1000, mtime / 1000);
}

// what `scheduleAuditCleanup` does on RocksDB: record, then purge what was last written before the cutoff
function retentionPass(Table, cutoff) {
	raiseAuditFloor(Table.auditStore, cutoff, true);
	return Table.auditStore.rootStore.purgeLogs({ before: cutoff });
}

// counts the log queries the boot purge makes
function bootPurge(Table, retention) {
	let queries = 0;
	const restore = interceptQueries(Table.auditStore.rootStore, (_name, log, options) => {
		queries++;
		return log.query(options);
	});
	const configured = auditRetention;
	setAuditRetention(retention);
	try {
		purgeAgedLogs(Table.auditStore.rootStore);
	} finally {
		setAuditRetention(configured);
		restore();
	}
	return queries;
}

// What rocksdb-js reports for every log created before 2.14: its deletions were not all recorded. The fixture
// below makes a real one; this applies the same answer to every log, for the record rule's own tests.
function withoutWatermarks() {
	const useLog = RocksDatabase.prototype.useLog;
	const logs = new Set();
	before(() => {
		RocksDatabase.prototype.useLog = function (name) {
			const log = useLog.call(this, name);
			if (!logs.has(log)) {
				logs.add(log);
				overrideWatermark(log, () => ({ known: false }));
			}
			return log;
		};
	});
	after(() => {
		delete RocksDatabase.prototype.useLog;
		if (RocksDatabase.prototype.useLog !== useLog) RocksDatabase.prototype.useLog = useLog;
		for (const log of logs) delete log.getPurgeWatermark;
	});
}

// a native method is read-only, so an override is an own property of the log
function overrideWatermark(log, getPurgeWatermark) {
	Object.defineProperty(log, 'getPurgeWatermark', { value: getPurgeWatermark, configurable: true });
}

// a database whose logs predate the purge watermark, as one created before rocksdb-js 2.14: rocksdb-js reports
// a log directory with no `txn.purged` unknown permanently
async function preWatermarkTable(origins = []) {
	const database = `logPurgeBounds_${databaseCount++}`;
	const open = () =>
		table({
			table: 'Bounded',
			database,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	let Table = open();
	await Table.put('before-upgrade', { name: 'x' });
	for (const name of origins) {
		const nodeId = getIdOfRemoteNode(name, Table.auditStore);
		await applyAsOrigin(Table, `${name}-before-upgrade`, { nodeId, logKey: Date.now() - 3_600_000 });
	}
	const logsPath = path.join(Table.auditStore.rootStore.path, 'transaction_logs');
	assert.ok(await closeDatabase(database));
	for (const name of fs.readdirSync(logsPath)) fs.rmSync(path.join(logsPath, name, 'txn.purged'), { force: true });
	Table = open();
	for (const name of ['local', ...origins])
		assert.strictEqual(Table.auditStore.rootStore.useLog(name).getPurgeWatermark().known, false);
	return { Table, database, open };
}

function recordedLogs(auditStore) {
	return unpack(auditStore.getBinary(LOG_PURGE_BOUNDS_KEY)).logs;
}

describe('per-log purge bounds', function () {
	this.timeout(20000);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('starts tracking a new database at its floor, not as a bound on any log', function () {
		if (isLMDB) return this.skip();
		const { auditStore } = freshTable();
		assert.strictEqual(getLogPurgeTrackedFrom(auditStore), getAuditFloor(auditStore));
		assert.strictEqual(getLogPurgeBounds(auditStore, 'local').get('local'), 0);
	});

	it('keeps tracking from the floor when a record restarts', async () => {
		const Table = freshTable();
		const olderPrune = Date.now() + 120_000;
		writeMetadata(Table.auditStore, AUDIT_FLOOR_KEY, floorBytes(olderPrune));
		assert.strictEqual(getLogPurgeTrackedFrom(Table.auditStore), undefined);
		raiseAuditFloor(Table.auditStore, olderPrune + 1000);
		assert.ok(getLogPurgeTrackedFrom(Table.auditStore) >= olderPrune);
	});

	it('reads a record from before trackedFrom as tracking from its epoch, with each folded bound unfolded', function () {
		if (isLMDB) return this.skip();
		const { auditStore } = freshTable();
		const floor = getAuditFloor(auditStore);
		const real = floor + 1000;
		writeRecord(auditStore, {
			epoch: floor,
			cutoff: floor,
			observedAt: Date.now(),
			logs: { 'folded-origin': [floor, 1, floor], 'pruned-origin': [real, Date.now(), real] },
		});
		assert.strictEqual(getLogPurgeTrackedFrom(auditStore), floor);
		const bounds = getLogPurgeBounds(auditStore, ['folded-origin', 'pruned-origin', 'new-origin']);
		assert.strictEqual(bounds.get('folded-origin'), 0);
		assert.strictEqual(bounds.get('pruned-origin'), real);
		assert.strictEqual(bounds.get('new-origin'), 0);
	});

	it('stores an epoch a build that reads only epoch can rely on', async function () {
		if (isLMDB) return this.skip();
		const Table = freshTable();
		const trackedFrom = getLogPurgeTrackedFrom(Table.auditStore);
		const stored = () => unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
		assert.strictEqual(stored().epoch, trackedFrom);
		assert.strictEqual(stored().unobserved, 0);
		await tick();
		raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
		assert.ok(stored().epoch >= trackedFrom);
		assert.strictEqual(stored().unobserved, 0);
	});

	it('stops trusting the record when the floor moves without it', async () => {
		const Table = freshTable();
		await Table.put('stale', { name: 'x' });
		raiseAuditFloor(Table.auditStore, Date.now() + 1000);
		assert.notStrictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
		const olderPrune = Date.now() + 120_000;
		writeMetadata(Table.auditStore, AUDIT_FLOOR_KEY, floorBytes(olderPrune));
		assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
		raiseAuditFloor(Table.auditStore, olderPrune + 1000);
		assert.ok(getLogPurgeBound(Table.auditStore, scope('local')) >= olderPrune);
	});

	it('stops trusting the record after a copy that carried no log raised the floor', async () => {
		const Table = freshTable();
		assert.notStrictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
		await new Promise((resolve) => setTimeout(resolve, 2));
		stampDatabaseGeneration(Table.auditStore, { carriesLog: false });
		assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
	});

	for (const [label, value] of [
		['undecodable bytes', new Uint8Array([0xc1, 0xc1])],
		[
			'an entry of the wrong shape',
			pack({ epoch: 1, cutoff: Date.now() * 2, observedAt: 1, logs: { 'local': [1, 2], '': [1, 2] } }),
		],
		['a negative bound', pack({ epoch: 1, cutoff: Date.now() * 2, logs: { 'local': -5, '': -5 } })],
		['a non-finite epoch', pack({ epoch: Infinity, cutoff: Date.now() * 2, logs: {} })],
		['a logs array', pack({ epoch: 1, cutoff: Date.now() * 2, logs: [1] })],
		[
			'a negative unobserved',
			pack({ epoch: 1, unobserved: -1, trackedFrom: 1, cutoff: Date.now() * 2, observedAt: 1, logs: {} }),
		],
		[
			'a non-finite trackedFrom',
			pack({ epoch: 1, trackedFrom: Infinity, cutoff: Date.now() * 2, observedAt: 1, logs: {} }),
		],
		['a negative trackedFrom', pack({ epoch: 1, trackedFrom: -1, cutoff: Date.now() * 2, observedAt: 1, logs: {} })],
		[
			'a trackedFrom of the wrong type',
			pack({ epoch: 1, trackedFrom: 'x', cutoff: Date.now() * 2, observedAt: 1, logs: {} }),
		],
	]) {
		it(`reads ${label} as no bound`, () => {
			const { auditStore } = freshTable();
			writeMetadata(auditStore, LOG_PURGE_BOUNDS_KEY, value);
			assert.strictEqual(getLogPurgeBound(auditStore, scope('local')), undefined);
		});
	}

	describe('a log with a purge watermark', function () {
		before(function () {
			if (isLMDB) this.skip(); // LMDB has no transaction-log files
		});

		it('covers a key minted ahead of the clock in a file purged by its age (harper#3953)', async () => {
			const Table = backdatedTable();
			const origin = getIdOfRemoteNode('skewed-origin', Table.auditStore);
			const ahead = Date.now() + DAY_MS;
			await applyAsOrigin(Table, 'from-the-future', { nodeId: origin, logKey: ahead });
			await ageLogFiles(Table, 'skewed-origin', Date.now() - 2 * 3_600_000);
			const purged = retentionPass(Table, Date.now() - 3_600_000);
			assert.ok(
				purged.some((file) => file.includes('skewed-origin')),
				'precondition: the pass purged the file'
			);
			assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'skewed-origin').get('skewed-origin'), ahead);
		});

		it('covers files purged when the metadata write accounting for them was lost (harper#3947)', async () => {
			const Table = backdatedTable();
			const origin = getIdOfRemoteNode('crash-origin', Table.auditStore);
			const ahead = Date.now() + DAY_MS;
			await applyAsOrigin(Table, 'purged-unrecorded', { nodeId: origin, logKey: ahead });
			await ageLogFiles(Table, 'crash-origin', Date.now() - 2 * 3_600_000);
			// the files go and the floor and record stay as they were: what power loss leaves of an unsynced write
			const purged = Table.auditStore.rootStore.purgeLogs({ before: Date.now() - 3_600_000 });
			assert.ok(purged.length > 0, 'precondition: the purge removed files');
			assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'crash-origin').get('crash-origin'), ahead);
		});

		it('reads no watermarked log in a retention pass (harper#3963)', async () => {
			const Table = backdatedTable();
			for (let i = 0; i < 3; i++) await Table.put(`unread-${i}`, { name: 'x' });
			await tick();
			let queries = 0;
			const restore = interceptQueries(Table.auditStore.rootStore, (_name, log, options) => {
				queries++;
				return log.query(options);
			});
			try {
				raiseAuditFloor(Table.auditStore, Date.now(), true);
			} finally {
				restore();
			}
			assert.strictEqual(queries, 0);
			assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'local').get('local'), 0, 'nothing was purged');
		});

		it('purges at the boot cutoff and bounds each log by its watermark, reading no log', async () => {
			const Table = backdatedTable();
			await Table.put('booted', { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await ageLogFiles(Table, 'local', Date.now() - 2 * 3_600_000);
			assert.strictEqual(bootPurge(Table, 3_600_000), 0);
			const local = Table.auditStore.rootStore.useLog('local');
			assert.strictEqual(local.getStats().fileCount, 0, 'precondition: the boot purge removed the aged files');
			const bound = getLogPurgeBounds(Table.auditStore, 'local').get('local');
			assert.strictEqual(bound, local.getPurgeWatermark().purgedThrough);
			assert.ok(bound >= newest);
		});

		it('bounds a log rocksdb-js purged on reopen by its watermark, keeping where tracking began', async () => {
			const database = `logPurgeBounds_${databaseCount++}`;
			const open = () =>
				table({
					table: 'Bounded',
					database,
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
					audit: true,
				});
			let Table = open();
			const downSince = Date.now() - nativeRetention(Table.auditStore) - DAY_MS;
			const origin = getIdOfRemoteNode('reopened-origin', Table.auditStore);
			await applyAsOrigin(Table, 'last-write', { nodeId: origin, logKey: downSince });
			const trackedFrom = getLogPurgeTrackedFrom(Table.auditStore);
			const logDir = path.join(Table.auditStore.rootStore.path, 'transaction_logs', 'reopened-origin');
			assert.ok(await closeDatabase(database));
			for (const file of fs.readdirSync(logDir))
				if (file.endsWith('.txnlog')) fs.utimesSync(path.join(logDir, file), downSince / 1000, downSince / 1000);
			Table = open();
			const log = Table.auditStore.rootStore.useLog('reopened-origin');
			assert.strictEqual(log.getStats().fileCount, 0, 'precondition: reopening purged the aged log');
			assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'reopened-origin').get('reopened-origin'), downSince);
			raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
			assert.strictEqual(getLogPurgeTrackedFrom(Table.auditStore), trackedFrom);
		});

		it('keeps where tracking began after no pass read the logs within the native retention', async () => {
			const Table = backdatedTable(400 * DAY_MS);
			await Table.put('long-gap', { name: 'x' });
			const trackedFrom = getLogPurgeTrackedFrom(Table.auditStore);
			assert.ok(trackedFrom < Date.now() - nativeRetention(Table.auditStore), 'precondition: tracking began long ago');
			raiseAuditFloor(Table.auditStore, Date.now() - 60_000, true);
			assert.strictEqual(getLogPurgeTrackedFrom(Table.auditStore), trackedFrom);
			assert.strictEqual(bootPurge(Table, 0), 0);
			assert.strictEqual(getLogPurgeTrackedFrom(Table.auditStore), trackedFrom);
		});

		it('answers for a log that does not exist without creating it', () => {
			const { auditStore } = freshTable();
			assert.strictEqual(getLogPurgeBounds(auditStore, ['never-written-origin']).get('never-written-origin'), 0);
			assert.ok(!auditStore.rootStore.listLogs().includes('never-written-origin'));
		});

		it('leaves out a log whose watermark cannot be read, never reading it as 0', async () => {
			const Table = freshTable();
			await Table.put('unreadable-watermark', { name: 'x' });
			const local = Table.auditStore.rootStore.useLog('local');
			for (const failure of [
				() => {
					throw new Error('cannot read the watermark');
				},
				() => ({ known: true, purgedThrough: Number.NaN }),
				() => ({ known: true, purgedThrough: -1 }),
			]) {
				overrideWatermark(local, failure);
				try {
					const bounds = getLogPurgeBounds(Table.auditStore, ['local']);
					assert.ok(bounds, 'the other logs still answer');
					assert.strictEqual(bounds.has('local'), false);
					assert.strictEqual(getLogPurgeBound(Table.auditStore, ['local']), undefined);
				} finally {
					delete local.getPurgeWatermark;
				}
			}
		});

		it('takes the record rule on a rocksdb-js with no purge watermark, refusing no log', async () => {
			const Table = backdatedTable();
			for (let i = 0; i < 3; i++) await Table.put(`no-watermark-api-${i}`, { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			const local = Table.auditStore.rootStore.useLog('local');
			overrideWatermark(local, undefined);
			try {
				await tick();
				raiseAuditFloor(Table.auditStore, Date.now(), true);
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'local').get('local'), newest);
			} finally {
				delete local.getPurgeWatermark;
			}
		});

		it('bounds a log that loses its watermark by the cutoff of the last pass', async () => {
			const Table = backdatedTable();
			await Table.put('later-unaccounted', { name: 'x' });
			await tick();
			const cutoff = Date.now() - 1000;
			raiseAuditFloor(Table.auditStore, cutoff, true);
			// rocksdb-js deleted a file of it it could not read
			const local = Table.auditStore.rootStore.useLog('local');
			overrideWatermark(local, () => ({ known: false }));
			try {
				assert.ok(getLogPurgeBounds(Table.auditStore, 'local').get('local') >= cutoff);
			} finally {
				delete local.getPurgeWatermark;
			}
		});

		it('records what a build from before the watermark reads as covering each purge', async () => {
			const Table = backdatedTable();
			const origin = getIdOfRemoteNode('downgrade-origin', Table.auditStore);
			const earlier = Date.now() - 2 * 3_600_000;
			await applyAsOrigin(Table, 'downgrade', { nodeId: origin, logKey: earlier });
			await ageLogFiles(Table, 'downgrade-origin', earlier);
			retentionPass(Table, Date.now() - 3_600_000);
			const cutoff = Date.now() - 1000;
			raiseAuditFloor(Table.auditStore, cutoff, true);
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			const entry = record.logs['downgrade-origin'];
			assert.strictEqual(entry.length, 3, 'the shape 5.4.0-beta.1–3 decode');
			// those builds' reader: the record's bound, plus the native horizon for a log not seen quiet within it
			const [bound, quietAt, maxKey] = entry;
			const horizon = Date.now() - nativeRetention(Table.auditStore);
			const earlierBuildBound = Math.max(record.unobserved, bound, quietAt < horizon ? Math.min(horizon, maxKey) : 0);
			assert.ok(earlierBuildBound >= cutoff);
			assert.ok(earlierBuildBound >= earlier);
		});

		it('probes no log and takes no write lock when nothing changed', async () => {
			const Table = freshTable();
			for (let i = 0; i < 3; i++) await Table.put(`steady-${i}`, { name: 'x' });
			await tick();
			const cutoff = Date.now();
			const now = Date.now;
			Date.now = () => cutoff;
			const rootStore = Table.auditStore.rootStore;
			const transactionSync = rootStore.transactionSync;
			let queries = 0;
			let transactions = 0;
			let restore;
			try {
				raiseAuditFloor(Table.auditStore, cutoff, true);
				restore = interceptQueries(rootStore, (_name, log, options) => {
					queries++;
					return log.query(options);
				});
				rootStore.transactionSync = function (...args) {
					transactions++;
					return transactionSync.apply(this, args);
				};
				raiseAuditFloor(Table.auditStore, cutoff, true);
			} finally {
				Date.now = now;
				restore?.();
				rootStore.transactionSync = transactionSync;
			}
			assert.strictEqual(queries, 0);
			assert.strictEqual(transactions, 0);
		});
	});

	describe('the record rule: LMDB, and a RocksDB log from before the purge watermark', () => {
		withoutWatermarks();

		it('bounds a new database by its epoch and what it holds once a retention pass has seen it', async () => {
			const { auditStore } = freshTable();
			await tick();
			raiseAuditFloor(auditStore, Date.now(), true);
			const { epoch, trackedFrom } = unpack(auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			assert.strictEqual(
				getLogPurgeBound(auditStore, scope('local')),
				Math.max(epoch, trackedFrom, ...localLogKeys(auditStore))
			);
		});

		it('answers for a log no pass has read with the native horizon, as a position on this node', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			await Table.put('unseen', { name: 'x' });
			const horizon = Date.now() - nativeRetention(Table.auditStore);
			assert.ok(getLogPurgeTrackedFrom(Table.auditStore) >= horizon);
		});

		describe('a relayed log whose keys predate this database', () => {
			const relayedLog = async (name) => {
				const Table = freshTable();
				const origin = getIdOfRemoteNode(name, Table.auditStore);
				const trackedFrom = getLogPurgeTrackedFrom(Table.auditStore);
				const lastKey = trackedFrom - 3_600_000;
				await applyAsOrigin(Table, 'relayed', { nodeId: origin, logKey: lastKey });
				return { Table, lastKey, trackedFrom };
			};

			it('reads no bound before a pass has seen it', async function () {
				if (isLMDB) return this.skip();
				const { Table } = await relayedLog('young-relay-origin');
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'young-relay-origin').get('young-relay-origin'), 0);
			});

			it('is bounded by its largest key after a pass, and keeps where tracking began', async function () {
				if (isLMDB) return this.skip();
				const { Table, lastKey, trackedFrom } = await relayedLog('passed-relay-origin');
				await tick();
				raiseAuditFloor(Table.auditStore, Date.now(), true);
				assert.strictEqual(
					getLogPurgeBounds(Table.auditStore, 'passed-relay-origin').get('passed-relay-origin'),
					lastKey
				);
				assert.strictEqual(getLogPurgeTrackedFrom(Table.auditStore), trackedFrom);
			});

			it('takes no gap epoch on the first pass, for an origin idle past the native retention', async function () {
				if (isLMDB) return this.skip();
				const Table = freshTable();
				const origin = getIdOfRemoteNode('long-idle-origin', Table.auditStore);
				const lastKey = Date.now() - nativeRetention(Table.auditStore) - DAY_MS;
				await applyAsOrigin(Table, 'long-idle', { nodeId: origin, logKey: lastKey });
				raiseAuditFloor(Table.auditStore, Date.now() - 60_000, true);
				assert.strictEqual(unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY)).unobserved, 0);
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'long-idle-origin').get('long-idle-origin'), lastKey);
			});

			it('keeps its largest key as its bound after a gap longer than the native retention', async function () {
				if (isLMDB) return this.skip();
				const Table = freshTable();
				const retention = nativeRetention(Table.auditStore);
				const lastKey = Date.now() - retention - 2 * DAY_MS;
				const lastPass = Date.now() - retention - DAY_MS;
				const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
				record.logs = { 'gap-origin': [lastKey, lastPass, lastKey] };
				record.observedAt = lastPass;
				writeRecord(Table.auditStore, record);
				raiseAuditFloor(Table.auditStore, Date.now() - 60_000, true);
				const horizon = Date.now() - retention - 1000;
				const after = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
				assert.strictEqual(after.unobserved, 0);
				assert.ok(after.trackedFrom >= horizon);
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'gap-origin').get('gap-origin'), lastKey);
			});

			it('keeps exposure up to its largest key at the last pass through a gap', async function () {
				if (isLMDB) return this.skip();
				const Table = freshTable();
				const retention = nativeRetention(Table.auditStore);
				const bound = Date.now() - retention - 3 * DAY_MS;
				const maxKey = Date.now() - retention - 2 * DAY_MS;
				const lastPass = Date.now() - retention - DAY_MS;
				const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
				record.logs = { 'written-origin': [bound, bound, maxKey] };
				record.observedAt = lastPass;
				writeRecord(Table.auditStore, record);
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'written-origin').get('written-origin'), maxKey);
				raiseAuditFloor(Table.auditStore, Date.now() - 60_000, true);
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'written-origin').get('written-origin'), maxKey);
			});

			it('is bounded by a prune that observes no log, past its largest key', async function () {
				if (isLMDB) return this.skip();
				const { Table } = await relayedLog('unobserved-prune-origin');
				const cutoff = Date.now() + 1000;
				raiseAuditFloor(Table.auditStore, cutoff);
				assert.strictEqual(getLogPurgeBound(Table.auditStore, ['unobserved-prune-origin']), cutoff);
			});

			it('is bounded by a later write a pass saw, past a follower that missed it', async function () {
				if (isLMDB) return this.skip();
				const { Table, lastKey } = await relayedLog('real-purge-origin');
				await tick();
				raiseAuditFloor(Table.auditStore, Date.now(), true);
				const origin = getIdOfRemoteNode('real-purge-origin', Table.auditStore);
				const missed = lastKey + 1000;
				await applyAsOrigin(Table, 'missed', { nodeId: origin, logKey: missed });
				await tick();
				raiseAuditFloor(Table.auditStore, Date.now(), true);
				assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'real-purge-origin').get('real-purge-origin'), missed);
			});
		});

		it('answers a boot purge after the clock moved back past its last pass with where tracking began', async function () {
			if (isLMDB) return this.skip();
			const Table = freshTable();
			await Table.put('rollback', { name: 'x' });
			const realNow = Date.now;
			const ahead = realNow() + DAY_MS;
			Date.now = () => ahead;
			try {
				raiseAuditFloor(Table.auditStore, ahead - 1000, true);
			} finally {
				Date.now = realNow;
			}
			const bootedAt = realNow();
			assert.strictEqual(bootPurge(Table, 0), 0);
			assert.ok(getLogPurgeTrackedFrom(Table.auditStore) >= bootedAt);
		});

		it('keeps an idle log at its exact newest key, not at the cutoff', async () => {
			const Table = backdatedTable();
			for (let i = 0; i < 5; i++) await Table.put(`idle-${i}`, { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), newest);
		});

		it('keeps an idle log at its bound after a new write while its quiet pass is past the cutoff', async () => {
			const Table = backdatedTable();
			await Table.put('before', { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			const quietPass = Date.now();
			raiseAuditFloor(Table.auditStore, quietPass, true);
			await Table.put('after', { name: 'x' });
			raiseAuditFloor(Table.auditStore, quietPass - 1000, true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), newest);
		});

		it('takes the cutoff for a log written through a whole retention window', async function () {
			if (isLMDB) return this.skip(); // one key-ordered store, removed by key
			const Table = freshTable();
			await Table.put('older', { name: 'x' });
			const cutoff = Date.now();
			await new Promise((resolve) => setTimeout(resolve, 5));
			await Table.put('newer', { name: 'x' });
			raiseAuditFloor(Table.auditStore, cutoff, true);
			assert.strictEqual(recordedLogs(Table.auditStore).local[0], cutoff);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['local']), cutoff);
		});

		it('stays at or below a caught-up follower while a log written just before it goes idle', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			const quietPass = Date.now();
			raiseAuditFloor(Table.auditStore, quietPass - 1000, true);
			await Table.put('last', { name: 'x' });
			const followerAt = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			raiseAuditFloor(Table.auditStore, quietPass + 1, true);
			assert.ok(getLogPurgeBound(Table.auditStore, ['local']) <= followerAt);
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['local']), followerAt);
		});

		it('takes the native retention horizon once a log has not been quiet within that retention', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			record.logs.local = [1, Date.now() - 400 * DAY_MS, Number.MAX_SAFE_INTEGER];
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			const horizon = Date.now() - nativeRetention(Table.auditStore);
			assert.ok(getLogPurgeBound(Table.auditStore, ['local']) >= horizon);
		});

		it('keeps the native horizon when a pass finds a log emptied after its quiet time aged out', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			// rocksdb-js may have purged writes made after that quiet pass when the log last opened
			record.logs.local = [1, Date.now() - 400 * DAY_MS, Number.MAX_SAFE_INTEGER];
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			const horizon = Date.now() - nativeRetention(Table.auditStore);
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.ok(recordedLogs(Table.auditStore).local[0] >= horizon);
			assert.ok(getLogPurgeBound(Table.auditStore, ['local']) >= horizon);
		});

		for (const recorded of [true, false]) {
			it(`bounds a ${recorded ? 'recorded' : 'never-recorded'} log rocksdb-js purged on reopen, after its node was down past that retention`, async function () {
				if (isLMDB) return this.skip();
				const database = `logPurgeBounds_${databaseCount++}`;
				const open = () =>
					table({
						table: 'Bounded',
						database,
						attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
						audit: true,
					});
				let Table = open();
				const downSince = Date.now() - nativeRetention(Table.auditStore) - DAY_MS;
				const floor = downSince - DAY_MS;
				writeMetadata(Table.auditStore, AUDIT_FLOOR_KEY, floorBytes(floor));
				// the last pass came before one more write to the origin, and then the node went down
				writeRecord(Table.auditStore, {
					epoch: floor,
					cutoff: floor,
					observedAt: floor,
					logs: recorded ? { 'down-origin': [floor - 1, floor, floor - 1] } : {},
				});
				const origin = getIdOfRemoteNode('down-origin', Table.auditStore);
				await applyAsOrigin(Table, 'last-write', { nodeId: origin, logKey: downSince });
				const logDir = path.join(Table.auditStore.rootStore.path, 'transaction_logs', 'down-origin');
				assert.ok(await closeDatabase(database));
				for (const file of fs.readdirSync(logDir))
					fs.utimesSync(path.join(logDir, file), downSince / 1000, downSince / 1000);
				Table = open();
				// a version of rocksdb-js that also drops an emptied log from its listing
				const listLogs = Table.auditStore.rootStore.listLogs;
				if (!recorded)
					Table.auditStore.rootStore.listLogs = function () {
						return listLogs.call(this).filter((name) => name !== 'down-origin');
					};
				const remaining = [...Table.auditStore.rootStore.useLog('down-origin').query({ start: 0 })];
				assert.strictEqual(remaining.length, 0, 'precondition: reopening purged the aged log');
				raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
				assert.ok(getLogPurgeTrackedFrom(Table.auditStore) >= downSince);
				assert.ok(getLogPurgeBound(Table.auditStore) >= downSince);
				Table.auditStore.rootStore.listLogs = listLogs;
			});
		}

		it('reads a log named after an Object.prototype key like any other', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			const bound = Date.now() - 60_000;
			record.logs = { constructor: [bound, Date.now(), bound] };
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['constructor', 'toString']), bound);
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['constructor', 'toString']), bound);
		});

		it('keeps an idle log exact when audit retention reaches past the native retention', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			const retention = nativeRetention(Table.auditStore);
			const origin = getIdOfRemoteNode('long-retention-origin', Table.auditStore);
			const lastKey = Date.now() - retention - DAY_MS;
			await applyAsOrigin(Table, 'idle-past-native', { nodeId: origin, logKey: lastKey });
			// a cutoff older than the entry, as with an audit retention longer than the native one
			raiseAuditFloor(Table.auditStore, lastKey - DAY_MS, true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['long-retention-origin']), lastKey);
		});

		it('bounds a log that went idle after its quiet pass by its largest key at the last pass, not the native horizon', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			const retention = nativeRetention(Table.auditStore);
			const origin = getIdOfRemoteNode('went-idle-origin', Table.auditStore);
			// the last write, now just past the native horizon, came after a quiet pass that is older still
			const lastKey = Date.now() - retention - 3_600_000;
			await applyAsOrigin(Table, 'last', { nodeId: origin, logKey: lastKey });
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			record.logs['went-idle-origin'] = [lastKey - DAY_MS, lastKey - 7_200_000, lastKey];
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['went-idle-origin']), lastKey);
			// an audit retention as long as the native one: the pass's cutoff is at the native horizon
			raiseAuditFloor(Table.auditStore, Date.now() - retention, true);
			assert.strictEqual(recordedLogs(Table.auditStore)['went-idle-origin'][0], lastKey);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['went-idle-origin']), lastKey);
		});

		it('bounds native exposure by the largest key at the last pass, not by a key that survives out of order', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			const horizon = Date.now() - nativeRetention(Table.auditStore);
			const origin = getIdOfRemoteNode('unordered-purge-origin', Table.auditStore);
			// a delayed key survives in a later segment; a higher key the last pass saw was in an earlier one, since purged
			const survivor = horizon - 7_200_000;
			const purged = horizon - 3_600_000;
			await applyAsOrigin(Table, 'delayed', { nodeId: origin, logKey: survivor });
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			record.logs['unordered-purge-origin'] = [horizon - DAY_MS, horizon - DAY_MS, purged];
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			assert.ok(getLogPurgeBound(Table.auditStore, ['unordered-purge-origin']) >= purged);
			raiseAuditFloor(Table.auditStore, Date.now() - nativeRetention(Table.auditStore), true);
			assert.ok(getLogPurgeBound(Table.auditStore, ['unordered-purge-origin']) >= purged);
		});

		it('reads each named log from one read of the record', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('many', { name: 'x' });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			const bounds = getLogPurgeBounds(Table.auditStore, ['local', 'absent-origin']);
			const withTracking = (bound) => Math.max(bound, getLogPurgeTrackedFrom(Table.auditStore));
			assert.strictEqual(withTracking(bounds.get('local')), getLogPurgeBound(Table.auditStore, ['local']));
			assert.strictEqual(
				withTracking(bounds.get('absent-origin')),
				getLogPurgeBound(Table.auditStore, ['absent-origin'])
			);
		});

		it('finishes a pass over a log whose maximum is not finite', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('garbage', { name: 'x' });
			// a corrupt frame decoding to an infinite timestamp: every query from any start yields it
			let probes = 0;
			const restore = interceptQueries(Table.auditStore.rootStore, (name, log, options) => {
				// a regression fails here instead of spinning the process
				if (++probes > 1000) throw new Error('the maximum search did not stop');
				return name === 'local' ? [{ timestamp: Infinity }] : log.query(options);
			});
			try {
				raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
			} finally {
				restore();
			}
			assert.ok(probes <= 1000, `${probes} probes: the maximum search did not stop`);
			assert.strictEqual(recordedLogs(Table.auditStore).local[2], Number.MAX_SAFE_INTEGER);
		});

		it('observes a fresh database before its first native retention window ends', async function () {
			if (isLMDB) return this.skip();
			const Table = freshTable();
			await Table.put('early', { name: 'x' });
			// a cutoff the new epoch covers, which alone would need no observation
			raiseAuditFloor(Table.auditStore, Date.now() - 60_000, true);
			assert.ok(recordedLogs(Table.auditStore).local, 'the pass recorded the log');
		});

		it('reads a single log name passed as a string', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('named', { name: 'x' });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, 'local'), getLogPurgeBound(Table.auditStore, ['local']));
			assert.strictEqual(
				getLogPurgeBounds(Table.auditStore, 'local').get('local'),
				getLogPurgeBound(Table.auditStore, ['local'])
			);
		});

		it('rewrites a quiet time older than half the native retention, keeping the bound', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('aging', { name: 'x' });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			const [bound] = record.logs.local;
			const aging = Date.now() - nativeRetention(Table.auditStore) * 0.6;
			record.logs.local = [bound, aging, bound];
			writeRecord(Table.auditStore, record);
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			const [rewrittenBound, quietAt] = recordedLogs(Table.auditStore).local;
			assert.strictEqual(rewrittenBound, bound);
			assert.ok(quietAt > aging + 1000, 'the quiet time moved to this pass');
		});

		it('answers a boot purge before any pass with where tracking began, recording nothing per log', async function () {
			if (isLMDB) return this.skip(); // LMDB has no log purge
			const Table = backdatedTable(400 * DAY_MS);
			await Table.put('before-first-pass', { name: 'x' });
			await tick();
			const bootedAt = Date.now();
			assert.strictEqual(bootPurge(Table, 0), 0);
			const trackedFrom = getLogPurgeTrackedFrom(Table.auditStore);
			assert.ok(trackedFrom >= bootedAt, `${trackedFrom} >= ${bootedAt}`);
			assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'local').get('local'), 0);
			assert.strictEqual(recordedLogs(Table.auditStore).local, undefined);
		});

		it('answers a boot purge that observed nothing even when another worker reads the logs first', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(400 * DAY_MS);
			const { auditStore } = Table;
			await Table.put('race', { name: 'x' });
			const beforeThePass = auditStore.getBinary(LOG_PURGE_BOUNDS_KEY);
			await tick();
			raiseAuditFloor(auditStore, Date.now() - 1000, true);
			const getBinary = auditStore.getBinary;
			auditStore.getBinary = (key) => (key === LOG_PURGE_BOUNDS_KEY ? beforeThePass : getBinary.call(auditStore, key));
			await tick();
			const bootedAt = Date.now();
			try {
				assert.strictEqual(bootPurge(Table, 0), 0);
			} finally {
				auditStore.getBinary = getBinary;
			}
			assert.ok(getLogPurgeTrackedFrom(auditStore) >= bootedAt);
		});

		it('keeps a log a retention pass saw quiet at its bound through the boot purge, reading no log', async function () {
			if (isLMDB) return this.skip(); // LMDB has no log purge
			const Table = backdatedTable();
			for (let i = 0; i < 3; i++) await Table.put(`boot-${i}`, { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			const [, quietAt] = recordedLogs(Table.auditStore).local;
			// a boot cutoff just below the quiet time
			assert.strictEqual(bootPurge(Table, Date.now() - quietAt + 1000), 0);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['local']), newest);
		});

		it('bounds a log written since its last quiet pass by the boot cutoff, reading no log', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('before-pass', { name: 'x' });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			await Table.put('after-pass', { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			const bootedAt = Date.now();
			assert.strictEqual(bootPurge(Table, 0), 0);
			assert.ok(getLogPurgeBound(Table.auditStore, ['local']) >= Math.max(newest, bootedAt));
		});

		it('writes a later quiet time on every pass, even when nothing else changes', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('idle', { name: 'x' });
			await tick();
			const cutoff = Date.now();
			raiseAuditFloor(Table.auditStore, cutoff, true);
			const [bound, firstQuiet] = recordedLogs(Table.auditStore).local;
			await tick();
			raiseAuditFloor(Table.auditStore, cutoff, true);
			const [sameBound, laterQuiet] = recordedLogs(Table.auditStore).local;
			assert.strictEqual(sameBound, bound);
			assert.ok(laterQuiet > firstQuiet, `${laterQuiet} > ${firstQuiet}`);
		});

		it('records a cutoff ahead of the clock as the epoch rather than observing the logs', async () => {
			const Table = backdatedTable();
			await Table.put('ahead', { name: 'x' });
			const cutoff = Date.now() + 60_000;
			raiseAuditFloor(Table.auditStore, cutoff, true);
			assert.ok(getLogPurgeBound(Table.auditStore, scope('local')) >= cutoff);
		});

		it('refreshes a recorded log that has no files left', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			const record = unpack(Table.auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
			const aging = Date.now() - nativeRetention(Table.auditStore) * 0.6;
			const goneBound = record.epoch + 1;
			record.logs['gone-origin'] = [goneBound, aging, goneBound];
			record.observedAt = Date.now();
			writeRecord(Table.auditStore, record);
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			const [bound, quietAt] = recordedLogs(Table.auditStore)['gone-origin'];
			assert.strictEqual(bound, goneBound);
			assert.ok(quietAt > aging + 1000);
		});

		it('records the cutoff of a prune that is not a retention pass, as delete_transaction_logs_before', async () => {
			const Table = freshTable();
			for (let i = 0; i < 3; i++) await Table.put(`manual-${i}`, { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			raiseAuditFloor(Table.auditStore, newest + 1);
			assert.ok(getLogPurgeBound(Table.auditStore, scope('local')) >= newest + 1);
		});

		it('finds the largest key of a log whose entries are not in key order', async function () {
			if (isLMDB) return this.skip(); // one key-ordered store
			const Table = backdatedTable(2 * 3_600_000);
			const origin = getIdOfRemoteNode('bound-origin', Table.auditStore);
			const base = Date.now() - 3_600_000;
			for (const offset of [10, 20, 15])
				await applyAsOrigin(Table, `unordered-${offset}`, { nodeId: origin, logKey: base + offset });
			raiseAuditFloor(Table.auditStore, base + 30, true);
			assert.strictEqual(
				getLogPurgeBound(Table.auditStore, ['bound-origin']),
				base + 20,
				'the maximum, not the first key reached'
			);
			raiseAuditFloor(Table.auditStore, base + 40, true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['bound-origin']), base + 20);
		});

		it('finds the maximum of a burst inside one millisecond in a bounded number of probes', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(2 * 3_600_000);
			const origin = getIdOfRemoteNode('burst-origin', Table.auditStore);
			const base = Math.floor(Date.now() - 3_600_000);
			for (let i = 0; i < 200; i++)
				await applyAsOrigin(Table, `burst-${i}`, { nodeId: origin, logKey: base + i / 1000 });
			let queries = 0;
			const restore = interceptQueries(Table.auditStore.rootStore, (name, log, options) => {
				if (name === 'burst-origin') queries++;
				return log.query(options);
			});
			try {
				raiseAuditFloor(Table.auditStore, base + 10, true);
			} finally {
				restore();
			}
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['burst-origin']), base + 199 / 1000);
			assert.ok(queries < 80, `${queries} probes for one log`);
		});

		it('answers any named scope from the one LMDB bound', async function () {
			if (!isLMDB) return this.skip();
			const Table = freshTable();
			await Table.put('lmdb-scope', { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['some-peer']), newest);
			assert.strictEqual(getLogPurgeBound(Table.auditStore), newest);
		});

		it('takes the highest bound across the named logs', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable(2 * 3_600_000);
			const quiet = getIdOfRemoteNode('quiet-origin', Table.auditStore);
			const busy = getIdOfRemoteNode('busy-origin', Table.auditStore);
			const base = Date.now() - 3_600_000;
			await applyAsOrigin(Table, 'q', { nodeId: quiet, logKey: base + 1 });
			await applyAsOrigin(Table, 'b', { nodeId: busy, logKey: base + 9 });
			raiseAuditFloor(Table.auditStore, base + 100, true);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['quiet-origin']), base + 1);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, ['quiet-origin', 'busy-origin']), base + 9);
		});

		it('keeps an idle log at its bound through a pass that cannot read it', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('idle', { name: 'x' });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			const [bound] = recordedLogs(Table.auditStore).local;
			const restore = interceptQueries(Table.auditStore.rootStore, (name) => {
				throw new Error(`cannot read ${name}`);
			});
			try {
				// its quiet pass is past this cutoff, so nothing this prune can remove is above the bound
				raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
			} finally {
				restore();
			}
			assert.strictEqual(recordedLogs(Table.auditStore).local[0], bound);
			assert.strictEqual(getLogPurgeBound(Table.auditStore, 'local'), bound);
		});

		it('bounds a log it cannot read by the cutoff', async function () {
			if (isLMDB) return this.skip();
			const Table = backdatedTable();
			await Table.put('unreadable', { name: 'x' });
			const restore = interceptQueries(Table.auditStore.rootStore, (name) => {
				throw new Error(`cannot read ${name}`);
			});
			await tick();
			const cutoff = Date.now();
			try {
				raiseAuditFloor(Table.auditStore, cutoff, true);
			} finally {
				restore();
			}
			assert.ok(getLogPurgeBound(Table.auditStore, ['local']) >= cutoff);
			assert.strictEqual(recordedLogs(Table.auditStore).local[2], Number.MAX_SAFE_INTEGER);
			await Table.put('readable-again', { name: 'x' });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			assert.ok(recordedLogs(Table.auditStore).local[2] < Number.MAX_SAFE_INTEGER);
		});

		it('probes each log at most twice and takes no write lock when nothing changed', async function () {
			if (isLMDB) return this.skip();
			const Table = freshTable();
			for (let i = 0; i < 3; i++) await Table.put(`steady-${i}`, { name: 'x' });
			await tick();
			const cutoff = Date.now();
			// one clock reading for both passes: a later quiet time is a change, and is written
			const now = Date.now;
			Date.now = () => cutoff;
			const rootStore = Table.auditStore.rootStore;
			const transactionSync = rootStore.transactionSync;
			let queries = 0;
			let transactions = 0;
			let restore;
			try {
				raiseAuditFloor(Table.auditStore, cutoff, true);
				restore = interceptQueries(rootStore, (name, log, options) => {
					queries++;
					return log.query(options);
				});
				rootStore.transactionSync = function (...args) {
					transactions++;
					return transactionSync.apply(this, args);
				};
				raiseAuditFloor(Table.auditStore, cutoff, true);
			} finally {
				Date.now = now;
				restore?.();
				rootStore.transactionSync = transactionSync;
			}
			assert.ok(
				queries <= 2 * rootStore.listLogs().length,
				`${queries} probes for ${rootStore.listLogs().length} logs`
			);
			assert.strictEqual(transactions, 0);
		});
	});

	describe('a database from before the purge watermark', function () {
		before(function () {
			if (isLMDB) this.skip();
		});

		it('keeps a log the last pass read at its newest key through a boot past the retention (harper-pro#1308)', async () => {
			const { Table: written, database, open } = await preWatermarkTable();
			await written.put('last-write', { name: 'x' });
			const newest = Math.max(...localLogKeys(written.auditStore));
			await tick();
			// the last pass before the node went down read the log
			raiseAuditFloor(written.auditStore, Date.now(), true);
			assert.ok(await closeDatabase(database));
			const Table = open();
			await tick();
			// the boot after downtime past the retention: its cutoff is past that pass
			assert.strictEqual(bootPurge(Table, 0), 0);
			assert.strictEqual(getLogPurgeBounds(Table.auditStore, 'local').get('local'), newest);
		});

		it('bounds a log written past the reach at the last pass by its largest key then, a key ahead of the clock included', async () => {
			const { Table } = await preWatermarkTable(['skew-origin']);
			const origin = getIdOfRemoteNode('skew-origin', Table.auditStore);
			const ahead = Date.now() + DAY_MS;
			await applyAsOrigin(Table, 'ahead', { nodeId: origin, logKey: ahead });
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
			assert.strictEqual(recordedLogs(Table.auditStore)['skew-origin'][2], ahead, 'precondition: the pass saw it');
			assert.strictEqual(bootPurge(Table, 0), 0);
			assert.ok(getLogPurgeBounds(Table.auditStore, 'skew-origin').get('skew-origin') >= ahead);
		});

		it('bounds a log written after the last pass by the boot cutoff', async () => {
			const { Table } = await preWatermarkTable();
			await tick();
			raiseAuditFloor(Table.auditStore, Date.now(), true);
			await Table.put('after-the-pass', { name: 'x' });
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			const bootedAt = Date.now();
			assert.strictEqual(bootPurge(Table, 0), 0);
			assert.ok(getLogPurgeBounds(Table.auditStore, 'local').get('local') >= Math.max(newest, bootedAt));
		});

		it('applies each rule to its own log, reading only the logs without a watermark', async () => {
			const { Table } = await preWatermarkTable();
			const origin = getIdOfRemoteNode('after-upgrade-origin', Table.auditStore);
			const ahead = Date.now() + DAY_MS;
			await applyAsOrigin(Table, 'new-log', { nodeId: origin, logKey: ahead });
			const rootStore = Table.auditStore.rootStore;
			assert.strictEqual(rootStore.useLog('after-upgrade-origin').getPurgeWatermark().known, true);
			const newest = Math.max(...localLogKeys(Table.auditStore));
			await tick();
			const queried = new Set();
			const restore = interceptQueries(rootStore, (name, log, options) => {
				queried.add(name);
				return log.query(options);
			});
			try {
				raiseAuditFloor(Table.auditStore, Date.now(), true);
			} finally {
				restore();
			}
			assert.deepStrictEqual([...queried], ['local']);
			await ageLogFiles(Table, 'after-upgrade-origin', Date.now() - 2 * 3_600_000);
			assert.strictEqual(bootPurge(Table, 3_600_000), 0);
			assert.strictEqual(rootStore.useLog('after-upgrade-origin').getStats().fileCount, 0, 'precondition: purged');
			const bounds = getLogPurgeBounds(Table.auditStore, ['local', 'after-upgrade-origin']);
			assert.strictEqual(bounds.get('after-upgrade-origin'), ahead);
			assert.strictEqual(bounds.get('local'), newest);
		});
	});
});
