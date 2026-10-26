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

	it('skips every same-key write when a competing delivery committed the source transaction', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const { T, apply } = await fixture('SameKeyBatch', version);
		const options = { version, fullUpdate: true };
		async function stageBatch(txn, context) {
			await txn.save(txn.writes.find((write) => write.key === 'counter'));
			const resource = await T.getResource('counter', context);
			await resource._writeUpdate('counter', { count: { __op__: 'add', value: 1 } }, false, {
				isNotification: true,
				nodeId: getIdOfRemoteNode('duplicate-origin', T.auditStore),
				version,
			});
			const writes = txn.writes.filter((write) => write.key === 'counter');
			assert.equal(writes.length, 2);
			await txn.save(writes[1]);
			return writes;
		}
		let native, writes;
		await apply({ id: 'counter', count: 0 }, options, async (txn, context) => {
			writes = await stageBatch(txn, context);
			native = txn.transaction;
			assert.ok(writes.every((write) => write.appendedAuditEntry));
			await apply({ id: 'counter', count: 0 }, options, stageBatch);
			assert.equal(T.primaryStore.getEntry('counter').value.count, 1);
		});
		assert.ok(native.retries > 0, 'the duplicate source transactions must really conflict');
		assert.equal((await T.get('counter')).count, 1, 'the committed increment must not be applied again');
		assert.ok(
			writes.every((write) => write.skipped),
			'both writes belong to the committed duplicate'
		);
	});

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

	for (const [offset, committedOffset] of [
		[0, 10],
		[20, 10],
		[20, 0],
	]) {
		it(`preserves distinct log keys sharing a record version during a retry (offsets ${offset}/${committedOffset})`, async function () {
			if (isLMDB) return this.skip();
			const version = Date.now() + 86400000;
			const state = await fixture(`DistinctKeys${offset}_${committedOffset}`, version);
			const { write } = await conflict(
				state,
				{ count: { __op__: 'add', value: 1 } },
				{ version, logKey: version + offset },
				{ version, logKey: version + committedOffset }
			);
			assert.equal((await state.T.get('counter')).count, 2);
			assert.equal(write.skipped, false, 'equal record versions alone do not prove write identity');
		});
	}

	it('treats equal-version writes from unmapped origins as one write', async function () {
		if (isLMDB) return this.skip();
		// Unmapped origins (an id with no node name) are filed in `local`, where every key is minted, so
		// their writes carry no origin key an equal version could be told apart by; an origin gives
		// distinct writes distinct versions (resources/DESIGN.md, "Origin-closed timestamp floor").
		const version = Date.now() + 86400000;
		const state = await fixture('UnmappedOrigins', version);
		const { write } = await conflict(
			state,
			{ count: { __op__: 'add', value: 1 } },
			{ version, originId: 35 },
			{ version, originId: 36 }
		);
		assert.equal(write.skipped, true, 'an equal version in `local` is a re-delivery');
		assert.equal((await state.T.get('counter')).count, 1);
	});

	it('does not mistake its own staged counter for committed state when another key conflicts', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const { T, apply } = await fixture('OtherKey', version);
		await T.put('other', { count: 0 });
		let native, counterWrite, secondCounterWrite;
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
			const counter = await T.getResource('counter', context);
			await counter._writeUpdate('counter', { count: { __op__: 'add', value: 1 } }, false, {
				isNotification: true,
				nodeId: getIdOfRemoteNode('duplicate-origin', T.auditStore),
				version,
			});
			secondCounterWrite = txn.writes.filter((write) => write.key === 'counter')[1];
			await txn.save(secondCounterWrite);
			native = txn.transaction;
			await transaction({}, () => T.put('other', { count: 2 }));
		});
		assert.ok(native.retries > 0, 'the other key must cause a real native conflict');
		assert.equal(counterWrite.skipped, false);
		assert.equal(secondCounterWrite.skipped, false);
		assert.equal((await T.get('counter')).count, 2);
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
			setDeletionDelay(undefined);
		}
	});

	it('discards a skipped blob whose unsubmitted audit batch was abandoned for a retained read snapshot', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const { T } = await fixture('IteratorBlob', version);
		await T.put('iterator-sentinel', { count: 0 });
		const blobs = [
			createBlob(Buffer.alloc(20000, 'a'), { saveBeforeCommit: true }),
			createBlob(Buffer.alloc(20000, 'b')),
		];
		const context = { timestamp: version };
		let readOwner, native, write, originalCommit, release;
		let originalCommits = 0;
		setDeletionDelay(0);
		try {
			await transaction(context, async () => {
				await T.getResource('counter', context);
				readOwner = context.transaction;
				const readTxn = readOwner.useReadTxn();
				assert.ok(T.primaryStore.getEntry('counter', { transaction: readTxn }));
				await T.put('counter', { count: 1, blob: blobs[0] }, context);
				const txn = context.transaction;
				write = txn.writes.find((write) => write.key === 'counter');
				await txn.save(write);
				release = holdBlobFile(blobs[0]);
				assert.equal(write.blobsAuditReferenced, true, 'the abandoned batch must have staged an audit reference');
				native = txn.transaction;
				originalCommit = native.commit;
				native.commit = function (...args) {
					originalCommits++;
					return originalCommit.apply(this, args);
				};
				await transaction({ timestamp: version + 1 }, (other) => T.put('counter', { count: 2, blob: blobs[1] }, other));
			});
			assert.equal(originalCommits, 0, 'the original audit batch must never have been submitted');
			assert.equal(write.skipped, true);
			assert.equal(getFileId(T.primaryStore.getEntry('counter').value.blob), getFileId(blobs[1]));
			assert.throws(() => saveBlob(blobs[0]), /Blob was discarded/, 'an unsubmitted audit batch owns no blob');
		} finally {
			if (native) native.commit = originalCommit;
			readOwner?.doneReadTxn();
			release?.();
			setDeletionDelay(undefined);
		}
	});
});
