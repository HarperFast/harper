const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor.js');
const { transaction } = require('#src/resources/transaction');

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
		const originalEntry = T.primaryStore.getEntry;
		T.primaryStore.getEntry = function (id, options, ...args) {
			if (id === 'r' && options?.uncachedRead && !options.transaction) reads.push({ committedRead: id });
			return originalEntry.call(this, id, options, ...args);
		};
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
				T.primaryStore.getEntry = originalEntry;
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
		assert.deepEqual(spy.reads, [], 'a sole write is decided from its commit base, with no log or committed read');
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

	for (const other of ['message', 'relocate']) {
		for (const putFirst of [false, true]) {
			it(`applies a put ${putFirst ? 'before' : 'after'} a same-key ${other} in its source transaction`, async function () {
				if (isLMDB) return this.skip();
				const { T, apply, origin } = replicatedTable(`${other}${putFirst ? 'AfterPut' : 'ThenPut'}`);
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
				const put = { type: 'put', id: 'r', value: { id: 'r', name: 'new' }, nodeId: origin, version };
				const otherWrite = { type: other, id: 'r', value: { id: 'r', name: 'published' }, nodeId: origin, version };
				await apply({
					type: 'transaction',
					timestamp: version,
					writes: putFirst ? [put, otherWrite] : [otherWrite, put],
				});
				assert.equal((await T.get('r')).name, 'new');
				const puts = (await T.getHistoryOfRecord('r')).filter((entry) => entry.type === 'put');
				assert.equal(puts.length, 2, 'the put is applied and logged, not skipped');
			});
		}
	}

	for (const putFirst of [false, true]) {
		it(`re-delivers a put ${putFirst ? 'before' : 'after'} a non-resident relocate without changing the record`, async function () {
			if (isLMDB) return this.skip();
			const { T, apply, origin } = replicatedTable(`NonResidentRelocate${putFirst ? 'AfterPut' : 'ThenPut'}`);
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
			const transaction = () => {
				const put = { type: 'put', id: 'r', value: { id: 'r', name: 'new' }, nodeId: origin, version };
				const relocate = { type: 'relocate', id: 'r', nodeId: origin, version, residencyList: ['not-this-node'] };
				return { type: 'transaction', timestamp: version, writes: putFirst ? [put, relocate] : [relocate, put] };
			};
			await apply(transaction());
			const delivered = T.primaryStore.getEntry('r');
			await apply(transaction());
			const redelivered = T.primaryStore.getEntry('r');
			assert.deepEqual(
				{ value: redelivered?.value, flags: redelivered?.metadataFlags, version: redelivered?.version },
				{ value: delivered?.value, flags: delivered?.metadataFlags, version: delivered?.version }
			);
		});
	}

	it('skips the put of a re-delivered transaction that also publishes to its key', async function () {
		if (isLMDB) return this.skip();
		const { T, apply, origin } = replicatedTable('PutPublishRedelivery');
		const version = Date.now() - 60000;
		const transaction = () => ({
			type: 'transaction',
			timestamp: version,
			writes: [
				{ type: 'put', id: 'r', value: { id: 'r', name: 'first' }, nodeId: origin, version },
				{ type: 'message', id: 'r', value: { id: 'r', name: 'published' }, nodeId: origin, version },
			],
		});
		await apply(transaction());
		const puts = async () => (await T.getHistoryOfRecord('r')).filter((entry) => entry.type === 'put').length;
		const putsBefore = await puts();
		const spy = spyRecordLogReads(T, version, origin);
		try {
			await apply(transaction());
		} finally {
			spy.restore();
		}
		assert.ok(
			spy.reads.some((read) => read.committedRead),
			'an eager same-key publish forces the committed read'
		);
		assert.equal(await puts(), putsBefore, 'the re-delivered put must not be logged again');
		assert.equal((await T.get('r')).name, 'first');
	});

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
		assert.deepEqual(spy.reads, [], 'skipped and unsaved same-key writes leave the commit base usable, with no read');
		assert.equal((await T.getHistoryOfRecord('r')).length, history);
		assert.equal((await T.get('r')).name, 'second');
	});
	it('converges when a competing delivery commits while a same-key publish is staged', async function () {
		if (isLMDB) return this.skip();
		const { T, apply, origin } = replicatedTable('CompetingDelivery');
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
		const options = { isNotification: true, nodeId: origin, version };
		function deliver(afterStage) {
			const context = { source: {}, sourceApply: true, timestamp: version };
			return transaction(context, async () => {
				const resource = await T.getResource('r', context);
				resource._writePublish('r', { id: 'r', name: 'published' }, options);
				resource._writeUpdate('r', { id: 'r', name: 'new' }, true, options);
				await afterStage?.(context.transaction);
			});
		}
		let outer;
		await deliver(async (txn) => {
			outer = txn.transaction;
			await deliver();
		});
		assert.ok(outer.retries > 0, 'the competing commit must force a retry');
		assert.equal((await T.get('r')).name, 'new');
	});
});
