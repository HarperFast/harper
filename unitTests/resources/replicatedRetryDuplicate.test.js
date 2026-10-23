const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
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

	const add = (value) => ({ count: { __op__: 'add', value } });

	function startPendingWrite(state, record, version) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		let release;
		let write;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const completion = transaction(context, async () => {
			const resource = await state.T.getResource('counter', context);
			await resource._writeUpdate('counter', record, false, {
				isNotification: true,
				nodeId: getIdOfRemoteNode('duplicate-origin', state.T.auditStore),
				version,
			});
			write = context.transaction.writes.find((write) => write.key === 'counter');
			await context.transaction.save(write);
			await gate;
		});
		completion.catch(() => {});
		return {
			completion,
			release: () => release(),
			get write() {
				return write;
			},
			context,
		};
	}

	it('applies a retry when a competing terminal abort left its matching log entry readable', async function () {
		if (isLMDB) return this.skip();
		this.timeout(10000);
		const version = Date.now() + 86400000;
		const state = await fixture('TerminalAbortOrphan', version);
		const originId = getIdOfRemoteNode('duplicate-origin', state.T.auditStore);
		const retried = startPendingWrite(state, add(1), version);
		const abandoned = startPendingWrite(state, add(1), version);
		const { Transaction } = require('@harperfast/rocksdb-js');
		const targetDb = state.T.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		let retryNativeId;
		let abandonedNativeId;
		let retryAttempts = 0;
		let abandonedAttempts = 0;
		try {
			await waitFor(() => retried.write?.appendedAuditEntry && abandoned.write?.appendedAuditEntry, {
				timeout: 3000,
				message: 'both source deliveries must stage their writes before the newer commit',
			});
			retryNativeId = retried.context.transaction.transaction.id;
			abandonedNativeId = abandoned.context.transaction.transaction.id;
			await state.apply(add(10), { version: version + 1 });
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (this.id === abandonedNativeId && ++abandonedAttempts === 2) {
					throw Object.assign(new Error('terminal storage error after logged conflict'), {
						code: 'ERR_IO',
						hasLog: true,
					});
				}
				if (this.id === retryNativeId && ++retryAttempts === 1) {
					try {
						return await originalCommit.apply(this, args);
					} catch (error) {
						await abandoned.completion.catch(() => {});
						const orphan = state.T.auditStore.get(version, state.T.tableId, 'counter', originId);
						assert.ok(orphan, 'the terminally aborted delivery must leave a readable log entry');
						assert.equal(orphan.txnLogKey, version);
						assert.equal(orphan.version, version);
						assert.equal(orphan.nodeId, originId);
						throw error;
					}
				}
				return originalCommit.apply(this, args);
			};
			retried.release();
			abandoned.release();
			await retried.completion;
			await assert.rejects(abandoned.completion, (error) => error.code === 'ERR_IO');
			assert.ok(retryAttempts > 1, 'the retrying delivery must really conflict and re-stage');
			assert.equal(retried.write.skipped, false);
			assert.equal((await state.T.get('counter')).count, 11);
		} finally {
			Transaction.prototype.commit = originalCommit;
			retried.release();
			abandoned.release();
		}
	});

	it('still skips a retry when the matching write committed on another handle', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('CommittedDuplicateControl', version);
		const { write } = await conflict(state, add(1), { version });
		assert.equal(write.skipped, true);
		assert.equal((await state.T.get('counter')).count, 1);
	});

	it('does not authenticate a prior staged same-key write as committed retry provenance', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const { T, apply } = await fixture('PriorStagedRetry', version);
		const originId = getIdOfRemoteNode('duplicate-origin', T.auditStore);
		let native;
		let writes;
		await apply(add(1), { version }, async (txn, context) => {
			const first = txn.writes.find((write) => write.key === 'counter');
			await txn.save(first);
			const resource = await T.getResource('counter', context);
			await resource._writeUpdate('counter', add(2), false, {
				isNotification: true,
				nodeId: originId,
				version,
			});
			writes = txn.writes.filter((write) => write.key === 'counter');
			await txn.save(writes[1]);
			native = txn.transaction;
			await apply(add(10), { version: version + 1 });
		});
		assert.ok(native.retries > 0, 'the newer write must force the same-key transaction to retry');
		assert.ok(
			writes.every((write) => !write.skipped),
			'both ordered writes must be applied on retry'
		);
		assert.equal((await T.get('counter')).count, 13);
	});

	it('skips a committed duplicate reached through a known-origin audit ref on retry', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('KnownOriginRetryRef', version);
		const originId = getIdOfRemoteNode('duplicate-origin', state.T.auditStore);
		await state.apply(add(10), { version: version + 10 });
		const retried = startPendingWrite(state, add(1), version);
		try {
			await waitFor(() => retried.write?.appendedAuditEntry, {
				timeout: 3000,
				message: 'the retry candidate must stage before the competing duplicate',
			});
			const native = retried.context.transaction.transaction;
			await state.apply(add(1), { version });
			const headWithRef = state.T.primaryStore.getEntry('counter');
			assert.ok(headWithRef.additionalAuditRefs?.some((ref) => ref.version === version && ref.nodeId === originId));
			await state.apply(add(0), { version: version + 20 });
			const newerHead = state.T.primaryStore.getEntry('counter');
			assert.equal(newerHead.version, version + 20);
			assert.ok(
				!newerHead.additionalAuditRefs?.some((ref) => ref.version === version && ref.nodeId === originId),
				'the duplicate is no longer on the primary record head'
			);
			const newerAudit = state.T.auditStore.get(version + 20, state.T.tableId, 'counter', originId);
			assert.ok(
				newerAudit.previousAdditionalAuditRefs?.some((ref) => ref.version === version && ref.nodeId === originId),
				'the newer audit entry must carry the committed origin-known ref'
			);
			retried.release();
			await retried.completion;
			assert.ok(native.retries > 0, 'the retry must follow a real conflict');
			assert.equal(retried.write.skipped, true);
			assert.equal((await state.T.get('counter')).count, 11);
		} finally {
			retried.release();
		}
	});

	for (const belowFloor of [false, true]) {
		it(`applies an ambiguous duplicate retry behind a newer committed write ${belowFloor ? 'below' : 'above'} the floor`, async function () {
			if (isLMDB) return this.skip();
			const version = Date.now() + (belowFloor ? -86400000 : 86400000);
			const state = await fixture(`NewerHead${belowFloor}`, version);
			const { write } = await conflict(state, add(1), { version }, { version }, add(1), () =>
				state.apply(add(10), { version: version + 1 })
			);
			assert.deepEqual(
				{ skipped: write.skipped, count: (await state.T.get('counter')).count },
				{ skipped: false, count: 12 },
				'an origin-ambiguous predecessor is not proof that this retry committed'
			);
		});
	}

	it('skips a duplicate retry whose committed head carries an out-of-order sibling ref', async function () {
		if (isLMDB) return this.skip();
		const version = Date.now() + 86400000;
		const state = await fixture('SiblingRef', version);
		const siblingOrigin = getIdOfRemoteNode('sibling-origin', state.T.auditStore);
		const { write } = await conflict(state, add(1), { version }, { version }, add(1), () =>
			state.apply(add(10), { version: version - 10, originId: siblingOrigin })
		);
		const head = state.T.primaryStore.getEntry('counter');
		assert.equal(head.version, version);
		assert.ok(head.additionalAuditRefs?.some((ref) => ref.nodeId === siblingOrigin));
		assert.deepEqual(
			{ skipped: write.skipped, count: (await state.T.get('counter')).count },
			{ skipped: true, count: 11 },
			'the committed increment must not be applied again'
		);
	});

	for (const replicated of [false, true]) {
		it(`keeps a failed attempt's ${replicated ? 'replicated' : 'local'} log entry unreadable until its retry commits`, async function () {
			if (isLMDB) return this.skip();
			const version = Date.now() + 86400000;
			const { T } = await fixture(`OrphanVisibility${replicated}`, version);
			const log = replicated ? getIdOfRemoteNode('duplicate-origin', T.auditStore) : 0;
			const patches = () => {
				const versions = [];
				for (const entry of T.auditStore.getRange({ start: 1, log })) {
					if (entry.tableId === T.tableId && entry.recordId === 'counter' && entry.type === 'patch')
						versions.push(entry.version);
				}
				return versions;
			};
			const commitToSameLog = async () => {
				const context = replicated ? { source: {}, sourceApply: true, timestamp: version + 5 } : {};
				await transaction(context, async () => {
					const resource = await T.getResource('other', context);
					await resource._writeUpdate(
						'other',
						{ id: 'other' },
						true,
						replicated ? { isNotification: true, nodeId: log, version: version + 5 } : {}
					);
				});
			};
			const context = replicated
				? { source: {}, sourceApply: true, timestamp: version + 2 }
				: { timestamp: version + 2 };
			const options = replicated ? { isNotification: true, nodeId: log, version: version + 2 } : {};
			let native, unreadable;
			await transaction(context, async () => {
				const resource = await T.getResource('counter', context);
				await resource._writeUpdate('counter', add(1), false, options);
				await context.transaction.save(context.transaction.writes.find((write) => write.key === 'counter'));
				native = context.transaction.transaction;
				const originalCommit = native.commit;
				native.commit = function (...args) {
					native.commit = originalCommit;
					const settle = async () => {
						await commitToSameLog();
						unreadable = patches().length === 0;
					};
					return Promise.resolve(originalCommit.apply(this, args)).then(
						async (result) => (await settle(), result),
						async (error) => {
							await settle();
							throw error;
						}
					);
				};
				await transaction({ timestamp: version + 1 }, (other) => T.put('counter', { count: 10 }, other));
			});
			assert.ok(native.retries > 0, 'RocksDB must detect and retry the real conflict');
			assert.equal((await T.get('counter')).count, 11);
			assert.equal(unreadable, true, 'the failed attempt must not be readable before its retry commits');
			assert.equal(patches().length, 1, 'the retry commits the entry');
		});
	}

	for (const belowFloor of [false, true]) {
		for (const duplicate of [true, false]) {
			it(`${duplicate ? 'deduplicates' : 'applies once'} the first submission of a write replayed for a retained read snapshot ${belowFloor ? 'below' : 'above'} the floor`, async function () {
				if (isLMDB) return this.skip();
				const version = Date.now() + (belowFloor ? -86400000 : 86400000);
				const { T, apply } = await fixture(`ReplayDuplicate${belowFloor}${duplicate}`, version);
				const nodeId = getIdOfRemoteNode('duplicate-origin', T.auditStore);
				const context = { source: {}, sourceApply: true, timestamp: version };
				let readOwner, native, write;
				let originalCommits = 0;
				try {
					await transaction(context, async () => {
						const resource = await T.getResource('counter', context);
						readOwner = context.transaction;
						readOwner.useReadTxn();
						await resource._writeUpdate('counter', add(1), false, { isNotification: true, nodeId, version });
						const txn = context.transaction;
						write = txn.writes.find((write) => write.key === 'counter');
						await txn.save(write);
						assert.equal(write.appendedAuditEntry, true);
						native = txn.transaction;
						const originalCommit = native.commit;
						native.commit = function (...args) {
							originalCommits++;
							return originalCommit.apply(this, args);
						};
						if (duplicate) await apply(add(1), { version });
						await apply(add(10), { version: version + 1 });
					});
				} finally {
					readOwner?.doneReadTxn();
				}
				assert.equal(originalCommits, 0, 'the original batch must be abandoned, leaving no orphan entry');
				assert.deepEqual(
					{ skipped: write.skipped, count: (await T.get('counter')).count },
					{ skipped: duplicate, count: 11 },
					'the increment must be applied exactly once'
				);
				if (duplicate) assert.equal(write.appendedAuditEntry, false);
				else assert.ok(write.appendedAuditEntry && write.appendedTo !== native, 'the replay handle owns the entry');
			});
		}
	}

	for (const belowFloor of [false, true]) {
		it(`recovers its own uncommitted increment after another write wins the conflict ${belowFloor ? 'below' : 'above'} the floor`, async function () {
			if (isLMDB) return this.skip();
			const version = Date.now() + (belowFloor ? -86400000 : 86400000);
			const state = await fixture(`Orphan${belowFloor}`, version);
			const { write } = await conflict(
				state,
				{ count: { __op__: 'add', value: 1 } },
				{ version },
				{ version: version + 1 }
			);
			assert.equal(write.skipped, false, 'an orphan audit entry is not proof of a committed duplicate');
			assert.equal((await state.T.get('counter')).count, 2, 'both distinct increments must survive');
		});
	}

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

	for (const [label, record, fullUpdate] of [
		['plain-field patch', { count: 1 }, false],
		['full put', { id: 'counter', count: 1 }, true],
	]) {
		it(`applies an ambiguous retry ${label} instead of treating an origin tie as committed identity`, async function () {
			if (isLMDB) return this.skip();
			const version = Date.now() + 86400000;
			const state = await fixture(`AmbiguousRetry${label.replaceAll(' ', '')}`, version);
			const { write } = await conflict(
				state,
				record,
				{ version, originId: 35, fullUpdate },
				{ version, originId: 36, fullUpdate },
				label === 'full put' ? { id: 'counter', count: 2 } : { count: 2 }
			);
			assert.equal(write.skipped, false);
			assert.ok((await state.T.get('counter')).count > 0);
		});
	}

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
