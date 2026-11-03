// harper-pro#1229: the per-log purge bound a replication source compares a follower's resume position against.
// The property every test defends is one-directional: the bound may sit above what a prune removed (a resync
// that was not needed), never below it.
const assert = require('node:assert');
const { pack, unpack } = require('msgpackr');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { asBinary } = require('#src/resources/asBinary');
const {
	getAuditFloor,
	getLogPurgeBound,
	raiseAuditFloor,
	stampDatabaseGeneration,
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

function recordedLogs(auditStore) {
	return unpack(auditStore.getBinary(LOG_PURGE_BOUNDS_KEY)).logs;
}

describe('per-log purge bounds', function () {
	this.timeout(20000);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('starts a new database at its floor, before any prune', () => {
		const { auditStore } = freshTable();
		const bound = getLogPurgeBound(auditStore, scope('local'));
		assert.strictEqual(bound, getAuditFloor(auditStore), 'nothing was purged above the floor stamped at open');
	});

	it('keeps an idle log at its exact newest key, not at the cutoff', async () => {
		const Table = freshTable();
		for (let i = 0; i < 5; i++) await Table.put(`idle-${i}`, { name: 'x' });
		const newest = Math.max(...localLogKeys(Table.auditStore));
		raiseAuditFloor(Table.auditStore, Date.now() + 60_000, true);
		assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), newest);
		// a follower caught up on this idle log sits exactly at that key and missed nothing
	});

	it('caps an active log at the cutoff, and answers nothing for a log written above its bound', async () => {
		const Table = freshTable();
		await Table.put('older', { name: 'x' });
		const cutoff = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await Table.put('newer', { name: 'x' });
		raiseAuditFloor(Table.auditStore, cutoff, true);
		assert.strictEqual(recordedLogs(Table.auditStore)[isLMDB ? '' : 'local'], cutoff);
		// rotation of a written log can purge natively, outside the record, so the source keeps its old rule
		assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
	});

	it('answers nothing once an idle log is written again', async () => {
		const Table = freshTable();
		await Table.put('before', { name: 'x' });
		raiseAuditFloor(Table.auditStore, Date.now() + 60_000, true);
		assert.notStrictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
		await Table.put('after', { name: 'x' });
		assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), undefined);
	});

	it('records the cutoff of a prune that is not a retention pass, as delete_transaction_logs_before', async () => {
		const Table = freshTable();
		for (let i = 0; i < 3; i++) await Table.put(`manual-${i}`, { name: 'x' });
		const newest = Math.max(...localLogKeys(Table.auditStore));
		raiseAuditFloor(Table.auditStore, newest + 1);
		// a transaction committing near the cutoff may not have been observable, so no log keeps a lower bound
		assert.strictEqual(getLogPurgeBound(Table.auditStore, scope('local')), newest + 1);
	});

	it('finds the largest key of a log whose entries are not in key order, and ones above the clock', async function () {
		if (isLMDB) return this.skip(); // one key-ordered store
		const Table = freshTable();
		const origin = getIdOfRemoteNode('bound-origin', Table.auditStore);
		const base = Date.now() + 3_600_000;
		// appended in this order: the larger key first, then smaller ones, all above the clock
		for (const offset of [20, 10, 15])
			await applyAsOrigin(Table, `future-${offset}`, { nodeId: origin, logKey: base + offset });
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
		const Table = freshTable();
		const origin = getIdOfRemoteNode('burst-origin', Table.auditStore);
		const base = Math.floor(Date.now() + 5_400_000);
		for (let i = 0; i < 200; i++) await applyAsOrigin(Table, `burst-${i}`, { nodeId: origin, logKey: base + i / 1000 });
		const rootStore = Table.auditStore.rootStore;
		const useLog = rootStore.useLog;
		let queries = 0;
		rootStore.useLog = function (name) {
			const log = useLog.call(this, name);
			return {
				query(options) {
					if (name === 'burst-origin') queries++;
					return log.query(options);
				},
			};
		};
		try {
			raiseAuditFloor(Table.auditStore, base + 10, true);
		} finally {
			rootStore.useLog = useLog;
		}
		assert.strictEqual(getLogPurgeBound(Table.auditStore, ['burst-origin']), base + 199 / 1000);
		assert.ok(queries < 80, `${queries} probes for one log`);
	});

	it('answers any named scope from the one LMDB bound', async function () {
		if (!isLMDB) return this.skip();
		const Table = freshTable();
		await Table.put('lmdb-scope', { name: 'x' });
		const newest = Math.max(...localLogKeys(Table.auditStore));
		raiseAuditFloor(Table.auditStore, Date.now() + 60_000, true);
		assert.strictEqual(getLogPurgeBound(Table.auditStore, ['some-peer']), newest);
		assert.strictEqual(getLogPurgeBound(Table.auditStore), newest);
	});

	it('takes the highest bound across the named logs', async function () {
		if (isLMDB) return this.skip();
		const Table = freshTable();
		const quiet = getIdOfRemoteNode('quiet-origin', Table.auditStore);
		const busy = getIdOfRemoteNode('busy-origin', Table.auditStore);
		const base = Date.now() + 7_200_000;
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
		// the next tracked prune restarts the record from the floor it found
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
		const Table = freshTable();
		await Table.put('unreadable', { name: 'x' });
		const rootStore = Table.auditStore.rootStore;
		const useLog = rootStore.useLog;
		rootStore.useLog = (name) => ({
			query() {
				throw new Error(`cannot read ${name}`);
			},
		});
		const cutoff = Date.now() + 5000;
		try {
			raiseAuditFloor(Table.auditStore, cutoff, true);
		} finally {
			rootStore.useLog = useLog;
		}
		assert.strictEqual(getLogPurgeBound(Table.auditStore, ['local']), cutoff);
	});

	it('probes each log at most twice and takes no write lock when nothing changed', async function () {
		if (isLMDB) return this.skip();
		const Table = freshTable();
		for (let i = 0; i < 3; i++) await Table.put(`steady-${i}`, { name: 'x' });
		const cutoff = Date.now() + 60_000;
		raiseAuditFloor(Table.auditStore, cutoff, true);
		const rootStore = Table.auditStore.rootStore;
		const useLog = rootStore.useLog;
		const transactionSync = rootStore.transactionSync;
		let queries = 0;
		let transactions = 0;
		rootStore.useLog = function (name) {
			const log = useLog.call(this, name);
			return {
				query(options) {
					queries++;
					return log.query(options);
				},
			};
		};
		rootStore.transactionSync = function (...args) {
			transactions++;
			return transactionSync.apply(this, args);
		};
		try {
			raiseAuditFloor(Table.auditStore, cutoff, true);
		} finally {
			rootStore.useLog = useLog;
			rootStore.transactionSync = transactionSync;
		}
		assert.ok(queries <= 2 * rootStore.listLogs().length, `${queries} probes for ${rootStore.listLogs().length} logs`);
		assert.strictEqual(transactions, 0);
	});
});
