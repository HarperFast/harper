const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor.js');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Relayed head-tie duplicates (harper#3467)', function () {
	this.timeout(10000);
	before(() => {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function replicatedTable(name) {
		const pending = [];
		let lastMarker = 0;
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
		const origin = getIdOfRemoteNode('v4-era-origin', T.auditStore);
		return {
			T,
			origin,
			async apply(...events) {
				const markerKey = (lastMarker = Math.max(Date.now(), lastMarker + 1));
				pending.push(...events, {
					type: 'put',
					id: 'marker',
					value: { id: 'marker', name: String(markerKey) },
					timestamp: markerKey,
					nodeId: origin,
				});
				wake?.();
				await waitFor(async () => (await T.get('marker'))?.name === String(markerKey), {
					timeout: 5000,
					message: 'the batch should apply',
				});
			},
		};
	}

	function spyRecordLogReads(T, logKey, origin) {
		const reads = [];
		const originalGet = T.auditStore.getSync;
		const originalRange = T.auditStore.getRange;
		T.auditStore.getSync = function (key, ...args) {
			if (key === logKey) reads.push({ getSync: key });
			return originalGet.call(this, key, ...args);
		};
		T.auditStore.getRange = function (options, ...args) {
			if (options?.start === logKey || (options?.start === 1 && options?.log === origin))
				reads.push({ getRange: options.start, log: options.log });
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
		const version = Date.now() - 60000;
		await state.apply({
			type: 'put',
			id: 'r',
			value: { id: 'r', name: 'copied' },
			timestamp: version,
			version,
			nodeId: state.origin,
			isCopyApply: true,
		});
		assert.equal((await state.T.getHistoryOfRecord('r')).length, 0, 'a copy-applied row has no log entry');
		return { ...state, version };
	}

	it('skips a relayed duplicate without reading the transaction log or appending to it', async function () {
		if (isLMDB) return this.skip();
		const { T, apply, origin, version } = await copiedRecord('NoLogEntry');
		const spy = spyRecordLogReads(T, version, origin);
		try {
			await apply({
				type: 'put',
				id: 'r',
				value: { id: 'r', name: 'copied' },
				timestamp: version,
				version,
				nodeId: origin,
			});
		} finally {
			spy.restore();
		}
		assert.deepEqual(spy.reads, [], 'the duplicate must be decided from the committed record');
		assert.equal((await T.getHistoryOfRecord('r')).length, 0, 'the duplicate must not be appended to the log');
		assert.equal((await T.get('r')).name, 'copied');
	});

	it('still orders a same-version write that carries a different log key', async function () {
		if (isLMDB) return this.skip();
		const { T, apply, origin, version } = await copiedRecord('DistinctLogKey');
		await apply({
			type: 'put',
			id: 'r',
			value: { id: 'r', name: 'distinct' },
			timestamp: version + 5,
			version,
			nodeId: origin,
		});
		assert.equal((await T.get('r')).name, 'distinct', 'the later log key orders after the copied write');
		assert.equal((await T.getHistoryOfRecord('r')).length, 1, 'a distinct write is applied and logged');
	});

	for (const prior of ['message', 'relocate']) {
		it(`applies a put that follows a same-key ${prior} in its source transaction`, async function () {
			if (isLMDB) return this.skip();
			const { T, apply, origin } = replicatedTable(`${prior}ThenPut`);
			const before = Date.now() - 60000;
			await apply({
				type: 'put',
				id: 'r',
				value: { id: 'r', name: 'old' },
				timestamp: before,
				version: before,
				nodeId: origin,
			});
			const version = before + 1000;
			await apply({
				type: 'transaction',
				timestamp: version,
				writes: [
					{ type: prior, id: 'r', value: { id: 'r', name: 'published' }, nodeId: origin, version },
					{ type: 'put', id: 'r', value: { id: 'r', name: 'new' }, nodeId: origin, version },
				],
			});
			assert.equal((await T.get('r')).name, 'new');
		});
	}

	it('skips every write of a re-delivered transaction that writes one key twice', async function () {
		if (isLMDB) return this.skip();
		const { T, apply, origin } = replicatedTable('TwoWriteRedelivery');
		const version = Date.now() - 60000;
		const transaction = () => ({
			type: 'transaction',
			timestamp: version,
			writes: [
				{ type: 'put', id: 'r', value: { id: 'r', name: 'first' }, nodeId: origin, version },
				{ type: 'patch', id: 'r', value: { name: 'second' }, nodeId: origin, version },
			],
		});
		await apply(transaction());
		const history = (await T.getHistoryOfRecord('r')).length;
		const spy = spyRecordLogReads(T, version, origin);
		try {
			await apply(transaction());
		} finally {
			spy.restore();
		}
		assert.deepEqual(spy.reads, [], 'both writes are decided from the committed record');
		assert.equal((await T.getHistoryOfRecord('r')).length, history);
		assert.equal((await T.get('r')).name, 'second');
	});
});
