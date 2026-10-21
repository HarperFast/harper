const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { raiseAuditFloor } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const {
	createBlob,
	decodeFromDatabase,
	saveBlob,
	getFileId,
	holdBlobFile,
	setDeletionDelay,
} = require('#src/resources/blob');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Retried replicated duplicates (harper#3361)', function () {
	this.timeout(10000);
	before(() => {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function fixture(name, version) {
		const T = table({
			table: name,
			database: `retryDuplicate_${name}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'count' }, { name: 'blob', type: 'Blob' }],
			audit: true,
		});
		const nodeId = getIdOfRemoteNode('duplicate-origin', T.auditStore);
		async function apply(record, { version, logKey = version, fullUpdate = false, originId = nodeId }, afterStage) {
			const context = { source: {}, sourceApply: true, timestamp: logKey };
			return transaction(context, async () => {
				const resource = await T.getResource('counter', context);
				await resource._writeUpdate('counter', record, fullUpdate, { isNotification: true, nodeId: originId, version });
				await afterStage?.(context.transaction, context);
			});
		}
		await apply({ id: 'counter', count: 0 }, { version: version - 1000, fullUpdate: true });
		raiseAuditFloor(T.auditStore, Date.now());
		return { T, apply };
	}

	async function conflict(
		{ T, apply },
		record,
		options,
		concurrentOptions = options,
		concurrentRecord = record,
		afterConcurrent
	) {
		let write, native;
		const reads = [];
		const originalGet = T.auditStore.getSync;
		const originalRange = T.auditStore.getRange;
		try {
			await apply(record, options, async (txn, context) => {
				write = txn.writes.find((write) => write.key === 'counter');
				await txn.save(write);
				native = txn.transaction;
				assert.equal(write.appendedAuditEntry, true, 'the failed attempt must stage its own audit entry');
				await apply(concurrentRecord, concurrentOptions);
				await afterConcurrent?.(txn, context);
				T.auditStore.getSync = function (key, tableId, recordId, ...args) {
					if (tableId === T.tableId && recordId === 'counter') reads.push(key);
					return originalGet.call(this, key, tableId, recordId, ...args);
				};
				T.auditStore.getRange = function (options, ...args) {
					reads.push({ start: options.start, log: options.log });
					return originalRange.call(this, options, ...args);
				};
			});
		} finally {
			T.auditStore.getSync = originalGet;
			T.auditStore.getRange = originalRange;
		}
		assert.ok(native.retries > 0, 'RocksDB must detect and retry the real conflict');
		return { write, reads };
	}

	for (const belowFloor of [true, false]) {
		for (const fullUpdate of [true, false]) {
			it(`skips a committed duplicate ${fullUpdate ? 'put' : 'increment'} ${belowFloor ? 'below' : 'above'} the floor`, async function () {
				if (isLMDB) return this.skip();
				const version = Date.now() + (belowFloor ? -86400000 : 86400000);
				const state = await fixture(`Duplicate${belowFloor}${fullUpdate}`, version);
				const record = fullUpdate ? { id: 'counter', count: 1 } : { count: { __op__: 'add', value: 1 } };
				const { write, reads } = await conflict(state, record, { version, fullUpdate });
				assert.deepEqual(reads, [], 'a committed duplicate retry must not read audit history');
				assert.equal(write.skipped, true);
				assert.equal((await state.T.get('counter')).count, 1, 'the duplicate must not apply twice');
			});
		}
	}

	it('recovers its own uncommitted increment after another write wins the conflict', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('Orphan', version);
		const { write } = await conflict(
			state,
			{ count: { __op__: 'add', value: 1 } },
			{ version },
			{ version: version + 1 }
		);
		assert.equal(write.skipped, false, 'an orphan audit entry is not proof of a committed duplicate');
		assert.equal((await state.T.get('counter')).count, 2, 'both distinct increments must survive');
	});

	it('preserves distinct log keys sharing a record version during a retry', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('DistinctKeys', version);
		const { write } = await conflict(
			state,
			{ count: { __op__: 'add', value: 1 } },
			{ version, logKey: version + 20 },
			{ version, logKey: version + 10 }
		);
		assert.equal(write.skipped, false, 'equal record versions alone do not prove write identity');
		assert.equal((await state.T.get('counter')).count, 2);
	});

	it('does not deduplicate distinct unmapped origins that compare as a version tie', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('UnmappedOrigins', version);
		const { write } = await conflict(
			state,
			{ count: { __op__: 'add', value: 1 } },
			{ version, originId: 35 },
			{ version, originId: 36 }
		);
		assert.equal(write.skipped, false, 'different numeric origins must not count as the same write');
		assert.equal((await state.T.get('counter')).count, 2);
	});

	it('does not mistake its own staged counter for committed state when another key conflicts', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const { T, apply } = await fixture('OtherKey', version);
		await T.put('other', { count: 0 });
		let native, counterWrite;
		await apply({ count: { __op__: 'add', value: 1 } }, { version }, async (txn, context) => {
			counterWrite = txn.writes.find((write) => write.key === 'counter');
			await txn.save(counterWrite);
			const other = await T.getResource('other', context);
			await other._writeUpdate('other', { count: 1 }, false, {
				isNotification: true,
				nodeId: getIdOfRemoteNode('duplicate-origin', T.auditStore),
				version,
			});
			await txn.save(txn.writes.find((write) => write.key === 'other'));
			native = txn.transaction;
			await transaction({}, () => T.put('other', { count: 2 }));
		});
		assert.ok(native.retries > 0, 'the other key must cause a real native conflict');
		assert.equal(counterWrite.skipped, false);
		assert.equal((await T.get('counter')).count, 1);
	});

	it('keeps the staged audit blob usable when a duplicate retry is skipped', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('Blobs', version);
		const blobs = [createBlob(Buffer.alloc(20000, 'a')), createBlob(Buffer.alloc(20000, 'a'))];
		for (const blob of blobs) await decodeFromDatabase(() => saveBlob(blob).saving, state.T.primaryStore.rootStore);
		assert.notEqual(getFileId(blobs[0]), getFileId(blobs[1]), 'each receiver saves its own file');
		const release = holdBlobFile(blobs[0]);
		setDeletionDelay(0);
		let write;
		try {
			({ write } = await conflict(
				state,
				{ id: 'counter', count: 1, blob: blobs[0] },
				{ version, fullUpdate: true },
				{ version, fullUpdate: true },
				{ id: 'counter', count: 1, blob: blobs[1] },
				async (txn, context) => {
					const resource = await state.T.getResource('counter', context);
					await resource._writeDelete('counter', {
						nodeId: getIdOfRemoteNode('duplicate-origin', state.T.auditStore),
						version,
					});
				}
			));
			assert.equal(write.skipped, true);
			assert.equal(write.blobsAuditReferenced, true);
			assert.ok((await state.T.get('counter')) == null, 'the later same-key delete must survive the retry');
			assert.doesNotThrow(() => saveBlob(blobs[0]), 'skip cleanup must not discard the audit-owned blob');
		} finally {
			release();
			setDeletionDelay(50);
		}
	});
});
