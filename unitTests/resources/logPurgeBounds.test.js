// harper-pro#1229: the per-log purge bound a replication source compares a follower's resume position against.
// The property every test defends is one-directional: the bound may sit above what a prune removed (a resync
// that was not needed), never below it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pack, unpack } = require('msgpackr');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { asBinary } = require('#src/resources/asBinary');
const {
	getAuditFloor,
	getLogPurgeBound,
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
		return { getStats: () => log.getStats(), query: (options) => query(name, log, options) };
	};
	return () => (rootStore.useLog = useLog);
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

	it('bounds a new database by its epoch and what it holds once a retention pass has seen it', async () => {
		const { auditStore } = freshTable();
		await tick();
		raiseAuditFloor(auditStore, Date.now(), true);
		const { epoch } = unpack(auditStore.getBinary(LOG_PURGE_BOUNDS_KEY));
		assert.strictEqual(getLogPurgeBound(auditStore, scope('local')), Math.max(epoch, ...localLogKeys(auditStore)));
	});

	it('bounds a log no retention pass has seen by the epoch and the native horizon', async function () {
		if (isLMDB) return this.skip(); // no native purge
		const Table = backdatedTable(400 * DAY_MS);
		await Table.put('unseen', { name: 'x' });
		const horizon = Date.now() - nativeRetention(Table.auditStore);
		const bound = getLogPurgeBound(Table.auditStore, ['local']);
		assert.ok(bound >= getAuditFloor(Table.auditStore));
		assert.ok(bound >= horizon);
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
		// the next pass's cutoff is below the quiet pass, so nothing it can remove is newer than `before`
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
		// passes while the write is inside the window, then once it has aged out
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
		record.logs.local = [1, Date.now() - 400 * DAY_MS];
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
		record.logs.local = [1, Date.now() - 400 * DAY_MS];
		record.observedAt = Date.now();
		writeRecord(Table.auditStore, record);
		const horizon = Date.now() - nativeRetention(Table.auditStore);
		await tick();
		raiseAuditFloor(Table.auditStore, Date.now(), true);
		assert.ok(recordedLogs(Table.auditStore).local[0] >= horizon);
		assert.ok(getLogPurgeBound(Table.auditStore, ['local']) >= horizon);
	});

	it('bounds a log rocksdb-js purged on reopen, after its node was down past that retention', async function () {
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
		// the origin's last quiet pass came before one more write, and then the node went down
		writeRecord(Table.auditStore, {
			epoch: floor,
			cutoff: floor,
			observedAt: floor,
			logs: { 'down-origin': [floor - 1, floor] },
		});
		const origin = getIdOfRemoteNode('down-origin', Table.auditStore);
		await applyAsOrigin(Table, 'last-write', { nodeId: origin, logKey: downSince });
		const logDir = path.join(Table.auditStore.rootStore.path, 'transaction_logs', 'down-origin');
		assert.ok(await closeDatabase(database));
		for (const file of fs.readdirSync(logDir))
			fs.utimesSync(path.join(logDir, file), downSince / 1000, downSince / 1000);
		Table = open();
		const remaining = [...Table.auditStore.rootStore.useLog('down-origin').query({ start: 0 })];
		assert.strictEqual(remaining.length, 0, 'precondition: reopening purged the aged log');
		raiseAuditFloor(Table.auditStore, Date.now() - 1000, true);
		assert.ok(getLogPurgeBound(Table.auditStore, ['down-origin']) >= downSince);
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
		record.logs.local = [bound, aging];
		writeRecord(Table.auditStore, record);
		raiseAuditFloor(Table.auditStore, Date.now(), true);
		const [rewrittenBound, quietAt] = recordedLogs(Table.auditStore).local;
		assert.strictEqual(rewrittenBound, bound);
		assert.ok(quietAt > aging + 1000, 'the quiet time moved to this pass');
	});

	it('records each log through the boot purge', async function () {
		if (isLMDB) return this.skip(); // LMDB has no log purge
		const Table = backdatedTable();
		for (let i = 0; i < 3; i++) await Table.put(`boot-${i}`, { name: 'x' });
		const newest = Math.max(...localLogKeys(Table.auditStore));
		const retention = auditRetention;
		await tick();
		setAuditRetention(0);
		try {
			purgeAgedLogs(Table.auditStore.rootStore);
		} finally {
			setAuditRetention(retention);
		}
		assert.strictEqual(getLogPurgeBound(Table.auditStore, ['local']), newest);
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
		record.logs['gone-origin'] = [record.epoch, aging];
		record.observedAt = Date.now();
		writeRecord(Table.auditStore, record);
		await tick();
		raiseAuditFloor(Table.auditStore, Date.now(), true);
		const [bound, quietAt] = recordedLogs(Table.auditStore)['gone-origin'];
		assert.strictEqual(bound, record.epoch);
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
		for (let i = 0; i < 200; i++) await applyAsOrigin(Table, `burst-${i}`, { nodeId: origin, logKey: base + i / 1000 });
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

	it('stops trusting the record when the floor moves without it', async () => {
		const Table = freshTable();
		await Table.put('stale', { name: 'x' });
		raiseAuditFloor(Table.auditStore, Date.now() + 1000);
		assert.notStrictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
		// an older binary's prune raises the floor and nothing else
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
			pack({ epoch: 1, cutoff: Date.now() * 2, observedAt: 1, logs: { 'local': [1, 2, 0], '': [1, 2, 0] } }),
		],
		['a negative bound', pack({ epoch: 1, cutoff: Date.now() * 2, logs: { 'local': -5, '': -5 } })],
		['a non-finite epoch', pack({ epoch: Infinity, cutoff: Date.now() * 2, logs: {} })],
		['a logs array', pack({ epoch: 1, cutoff: Date.now() * 2, logs: [1] })],
	]) {
		it(`reads ${label} as no bound`, () => {
			const { auditStore } = freshTable();
			writeMetadata(auditStore, LOG_PURGE_BOUNDS_KEY, value);
			assert.strictEqual(getLogPurgeBound(auditStore, scope('local')), undefined);
		});
	}

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
	});

	it('probes each log at most twice and takes no write lock when nothing changed', async function () {
		if (isLMDB) return this.skip();
		const Table = freshTable();
		for (let i = 0; i < 3; i++) await Table.put(`steady-${i}`, { name: 'x' });
		await tick();
		const cutoff = Date.now();
		raiseAuditFloor(Table.auditStore, cutoff, true);
		const rootStore = Table.auditStore.rootStore;
		const transactionSync = rootStore.transactionSync;
		let queries = 0;
		let transactions = 0;
		const restore = interceptQueries(rootStore, (name, log, options) => {
			queries++;
			return log.query(options);
		});
		rootStore.transactionSync = function (...args) {
			transactions++;
			return transactionSync.apply(this, args);
		};
		try {
			raiseAuditFloor(Table.auditStore, cutoff, true);
		} finally {
			restore();
			rootStore.transactionSync = transactionSync;
		}
		assert.ok(queries <= 2 * rootStore.listLogs().length, `${queries} probes for ${rootStore.listLogs().length} logs`);
		assert.strictEqual(transactions, 0);
	});
});
