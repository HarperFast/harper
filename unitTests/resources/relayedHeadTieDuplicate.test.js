const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { setTimeout: delay } = require('node:timers/promises');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// harper#3467: a relayed re-delivery of the write a record already holds (same origin, version and log
// key) must be dropped from the committed record alone. When the receiver has no log entry for it (here,
// because a base copy applied the record), a log lookup scans to end-of-log, and applying it again appends
// an entry that every peer is re-sent.
describe('Relayed head-tie duplicates (harper#3467)', function () {
	this.timeout(10000);
	before(() => {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function waitFor(predicate, message, timeout = 5000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (await predicate()) return;
			await delay(20);
		}
		throw new Error('waitFor timed out: ' + message);
	}

	// A table fed by an intermediate (replication) source; push() hands it the next batch of events.
	function replicatedTable(name) {
		const pending = [];
		let wake;
		const T = table({
			table: name,
			database: `headTie_${name}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		T.sourcedFrom(
			{
				subscribeOnThisThread() {
					return true;
				},
				async *subscribe() {
					while (true) {
						while (pending.length) yield pending.shift();
						await new Promise((resolve) => (wake = resolve));
					}
				},
			},
			{ intermediateSource: true }
		);
		return {
			T,
			push(...events) {
				pending.push(...events);
				wake?.();
			},
		};
	}

	function spyLogReads(T) {
		const reads = [];
		const originalGet = T.auditStore.getSync;
		const originalRange = T.auditStore.getRange;
		T.auditStore.getSync = function (key, ...args) {
			reads.push({ getSync: key });
			return originalGet.call(this, key, ...args);
		};
		T.auditStore.getRange = function (options, ...args) {
			reads.push({ getRange: options?.start, log: options?.log });
			return originalRange.call(this, options, ...args);
		};
		return {
			reads,
			restore() {
				T.auditStore.getSync = originalGet;
				T.auditStore.getRange = originalRange;
			},
		};
	}

	async function copiedRecord(name) {
		const state = replicatedTable(name);
		const origin = getIdOfRemoteNode('v4-era-origin', state.T.auditStore);
		const version = Date.now() - 60000;
		state.push(
			{
				type: 'put',
				id: 'r',
				value: { id: 'r', name: 'copied' },
				timestamp: version,
				version,
				nodeId: origin,
				isCopyApply: true,
			},
			{
				type: 'put',
				id: 'copied',
				value: { id: 'copied' },
				timestamp: version + 1,
				version: version + 1,
				nodeId: origin,
				isCopyApply: true,
			}
		);
		await waitFor(async () => (await state.T.get('copied')) != null, 'copy applied');
		assert.equal((await state.T.getHistoryOfRecord('r')).length, 0, 'a copy-applied row has no log entry');
		return { ...state, origin, version };
	}

	it('skips a relayed duplicate without reading the transaction log or appending to it', async function () {
		if (isLMDB) return this.skip();
		const { T, push, origin, version } = await copiedRecord('NoLogEntry');
		const spy = spyLogReads(T);
		try {
			push(
				{ type: 'put', id: 'r', value: { id: 'r', name: 'copied' }, timestamp: version, version, nodeId: origin },
				{ type: 'put', id: 'marker', value: { id: 'marker' }, timestamp: Date.now(), nodeId: origin }
			);
			await waitFor(async () => (await T.get('marker')) != null, 'duplicate batch applied');
		} finally {
			spy.restore();
		}
		const recordReads = spy.reads.filter((read) => read.getSync === version || read.getRange !== undefined);
		assert.deepEqual(recordReads, [], 'the duplicate must be decided from the committed record');
		assert.equal((await T.getHistoryOfRecord('r')).length, 0, 'the duplicate must not be appended to the log');
		assert.equal((await T.get('r')).name, 'copied');
	});

	it('still orders a same-version write that carries a different log key', async function () {
		if (isLMDB) return this.skip();
		const { T, push, origin, version } = await copiedRecord('DistinctLogKey');
		push(
			{ type: 'put', id: 'r', value: { id: 'r', name: 'distinct' }, timestamp: version + 5, version, nodeId: origin },
			{ type: 'put', id: 'marker', value: { id: 'marker' }, timestamp: Date.now(), nodeId: origin }
		);
		await waitFor(async () => (await T.get('marker')) != null, 'distinct write applied');
		assert.equal((await T.get('r')).name, 'distinct', 'the later log key orders after the copied write');
		assert.equal((await T.getHistoryOfRecord('r')).length, 1, 'a distinct write is applied and logged');
	});
});
