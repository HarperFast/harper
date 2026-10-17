require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const {
	ImmediateTransaction,
	getOutstandingCommits,
	getTxnExpiration,
	replicationConfirmation,
	resetStuckCommitLogCooldownForTests,
	setMaxOutstandingTxnDuration,
	setMaxRetryDelayMs,
	setTxnExpiration,
	suspendDatabaseCommits,
} = require('#src/resources/DatabaseTransaction');
const { MIN_LOCK_LEASE_MS } = require('#src/resources/recordLock');
const { publishOriginFloor } = require('#src/resources/originClosedFloor');
const { replayLogs } = require('#src/resources/replayLogs');
const harperLogger = require('#src/utility/logging/harper_logger');
const { Transaction, constants } = require('@harperfast/rocksdb-js');
const RETRY_NOW_VALUE = constants.RETRY_NOW_VALUE;
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Transactions are never aborted once durably written to the transaction log', function () {
	if (isLMDB) return;

	const MAX_RETRIES = 40;
	const WELL_PAST_BUDGET_MS = 3_600_000;
	let AuditedA, AuditedB, UnauditedA;
	let nextId = 1;
	const id = (prefix = 'rec') => `${prefix}-${nextId++}`;
	const pendingRestores = [];
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		AuditedA = table({
			table: 'NoAbortAuditedA',
			database: 'testNoAbortA',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
			audit: true,
		});
		AuditedB = table({
			table: 'NoAbortAuditedB',
			database: 'testNoAbortB',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
			audit: true,
		});
		UnauditedA = table({
			table: 'NoAbortUnauditedA',
			database: 'testNoAbortA',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
			audit: false,
		});
		process.on('unhandledRejection', onUnhandled);
	});

	after(() => {
		process.removeListener('unhandledRejection', onUnhandled);
	});

	afterEach(async function () {
		while (pendingRestores.length) pendingRestores.pop()();
		await delay(30);
		const leaked = unhandled.splice(0);
		if (this.currentTest?.state !== 'failed') {
			assert.deepStrictEqual(leaked, [], 'must not leak unhandled rejections');
		}
	});

	function auditEntriesFor(targetTable, recordId, extraOptions = {}) {
		return [...targetTable.auditStore.getRange({ start: 1, ...extraOptions })].filter(
			(entry) => entry.tableId === targetTable.tableId && entry.recordId === recordId
		);
	}

	async function putWithTimestamp(targetTable, record, timestamp) {
		const ctx = {};
		await transaction(ctx, async () => {
			ctx.transaction.timestamp = timestamp;
			await targetTable.put(record, ctx);
		});
	}

	function trackAborts(targetDb) {
		const originalAbort = Transaction.prototype.abort;
		const aborted = [];
		Transaction.prototype.abort = function (...args) {
			if (!targetDb || this.store?.db === targetDb) aborted.push(this.id);
			return originalAbort.apply(this, args);
		};
		pendingRestores.push(() => {
			Transaction.prototype.abort = originalAbort;
		});
		return aborted;
	}

	function captureLogger(method) {
		const lines = [];
		const original = harperLogger[method];
		harperLogger[method] = function (...args) {
			lines.push(args);
			return original.apply(this, args);
		};
		pendingRestores.push(() => {
			harperLogger[method] = original;
		});
		return lines;
	}

	describe('1. Uncoordinated ERR_BUSY / ERR_TRY_AGAIN retry cap after durable log write', () => {
		it('retries past MAX_RETRIES without aborting when attempt 1 hits a real ERR_BUSY conflict and subsequent attempts reject', async function () {
			this.timeout(20000);
			const prevMaxRetryDelay = setMaxRetryDelayMs(1);
			pendingRestores.push(() => setMaxRetryDelayMs(prevMaxRetryDelay));
			const recordId = id('busy-cap');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;
			const warnLines = captureLogger('warn');

			let trackedTxnId;
			let attemptCount = 0;
			let firstAttemptOutcome;
			let hasStagedLogAfterFirst;
			let durableLogCountAfterFirst;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					try {
						const res = await originalCommit.apply(this, args);
						firstAttemptOutcome = { resolved: res };
						return res;
					} catch (err) {
						firstAttemptOutcome = { rejected: err.code };
						hasStagedLogAfterFirst = this.hasStagedLog;
						durableLogCountAfterFirst = auditEntriesFor(AuditedA, recordId, { readUncommitted: true }).length;
						throw err;
					}
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount <= MAX_RETRIES + 2) {
					const code = attemptCount % 2 === 0 ? 'ERR_BUSY' : 'ERR_TRY_AGAIN';
					throw Object.assign(new Error(`synthetic ${code}`), { code });
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const auditBefore = auditEntriesFor(AuditedA, recordId).length;
			const holder = await AuditedA.lock(recordId, { hold: true, lease: 30_000 });
			assert.ok(holder.getContext().transaction instanceof ImmediateTransaction);
			holder.set('writer', 'logged-winner');
			holder.set('count', 2);
			await holder.save();
			await holder.unlock();

			assert.deepStrictEqual(
				firstAttemptOutcome,
				{ rejected: 'ERR_BUSY' },
				'attempt 1 must hit a real native ERR_BUSY conflict'
			);
			assert.strictEqual(hasStagedLogAfterFirst, true, 'attempt 1 must have staged a transaction-log entry');
			assert.strictEqual(
				durableLogCountAfterFirst - auditBefore,
				2,
				'attempt 1 must have durably flushed the holder log entry before rejecting'
			);
			assert.strictEqual(attemptCount, MAX_RETRIES + 3, 'must retry past MAX_RETRIES and land on the final attempt');
			assert.ok(!aborted.includes(trackedTxnId), 'the logged native transaction must never be aborted');
			const stored = AuditedA.primaryStore.getEntry(recordId).value;
			assert.strictEqual(stored.writer, 'logged-winner');
			assert.strictEqual(stored.count, 2);

			const auditsAfter = auditEntriesFor(AuditedA, recordId);
			assert.strictEqual(auditsAfter.length - auditBefore, 2, 'one audit entry for interposer and one for holder');
			const holderAudit = auditsAfter.at(-1).getValue(AuditedA.primaryStore);
			assert.strictEqual(holderAudit.writer, 'logged-winner');
			assert.strictEqual(holderAudit.count, 2);
			assert.ok(
				warnLines.some(([msg]) =>
					/Logged transaction .* still in conflict after 40 retries; continuing to retry/.test(msg)
				),
				'must emit periodic warning at MAX_RETRIES'
			);
		});

		it('still aborts an unlogged (audit: false) transaction at MAX_RETRIES and releases its lock hold', async function () {
			this.timeout(20000);
			const prevMaxRetryDelay = setMaxRetryDelayMs(1);
			pendingRestores.push(() => setMaxRetryDelayMs(prevMaxRetryDelay));
			const recordId = id('unlogged-busy-cap');
			await UnauditedA.put({ id: recordId, writer: 'seed', count: 0 });

			const targetDb = UnauditedA.primaryStore.store.db;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;

			let attempts = 0;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				attempts++;
				throw Object.assign(new Error('forced busy'), { code: 'ERR_BUSY' });
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holder = await UnauditedA.lock(recordId, { hold: true, lease: 30_000 });
			holder.set('writer', 'unlogged-loser');
			await assert.rejects(
				() => holder.save(),
				(err) => err.statusCode === 500 && /After 40 retries, unable to commit/.test(err.message)
			);
			assert.strictEqual(attempts, MAX_RETRIES + 1);
			assert.strictEqual(aborted.length, 1, 'unlogged transaction must be aborted on retry exhaustion');
			await holder.unlock();

			const nextHolder = await UnauditedA.lock(recordId, { lease: 5000, timeout: 300 });
			await nextHolder.unlock();
		});
	});

	describe('2. Coordinated RETRY_NOW retry cap after durable log write', () => {
		it('retries past MAX_RETRIES without aborting when attempt 1 hits a real RETRY_NOW conflict and subsequent attempts return RETRY_NOW', async function () {
			this.timeout(20000);
			const prevMaxRetryDelay = setMaxRetryDelayMs(1);
			pendingRestores.push(() => setMaxRetryDelayMs(prevMaxRetryDelay));
			const recordId = id('retry-now-cap');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;

			const warnLines = captureLogger('warn');

			let trackedTxnId;
			let attemptCount = 0;
			let firstAttemptOutcome;
			let hasStagedLogAfterFirst;
			let durableLogCountAfterFirst;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					firstAttemptOutcome = res;
					hasStagedLogAfterFirst = this.hasStagedLog;
					durableLogCountAfterFirst = auditEntriesFor(AuditedA, recordId, { readUncommitted: true }).length;
					return res;
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount <= MAX_RETRIES + 2) {
					return RETRY_NOW_VALUE;
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const auditBefore = auditEntriesFor(AuditedA, recordId).length;
			const context = {};
			await transaction(context, async () => {
				await AuditedA.get(recordId, context);
				await AuditedA.put({ id: recordId, writer: 'coord-winner', count: 2 }, context);
			});

			assert.strictEqual(
				firstAttemptOutcome,
				RETRY_NOW_VALUE,
				'attempt 1 must resolve to RETRY_NOW_VALUE from a real native coordinated conflict'
			);
			assert.strictEqual(hasStagedLogAfterFirst, true, 'attempt 1 must have staged a transaction-log entry');
			assert.strictEqual(
				durableLogCountAfterFirst - auditBefore,
				2,
				'attempt 1 must have durably flushed the log entry before returning RETRY_NOW'
			);
			assert.strictEqual(attemptCount, MAX_RETRIES + 3);
			assert.ok(!aborted.includes(trackedTxnId), 'the logged native transaction must never be aborted');
			const stored = AuditedA.primaryStore.getEntry(recordId).value;
			assert.strictEqual(stored.writer, 'coord-winner');
			assert.strictEqual(stored.count, 2);

			const auditsAfter = auditEntriesFor(AuditedA, recordId);
			assert.strictEqual(auditsAfter.length - auditBefore, 2, 'one audit entry for interposer and one for winner');
			const winnerAudit = auditsAfter.at(-1).getValue(AuditedA.primaryStore);
			assert.strictEqual(winnerAudit.writer, 'coord-winner');
			assert.strictEqual(winnerAudit.count, 2);
			assert.ok(
				warnLines.some(([msg]) =>
					/Logged transaction .* still in conflict after 40 coordinated retries; continuing to retry/.test(msg)
				),
				'must emit periodic warning at MAX_RETRIES'
			);
		});

		it('preserves an explicit transaction.timestamp below the origin floor across conflict retry rounds', async function () {
			this.timeout(15000);
			const recordId = id('explicit-ts-below-floor');
			const baseNow = Date.now();
			const explicitTs = baseNow - 2_000;
			const originFloor = baseNow - 1_000;
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);
			publishOriginFloor(AuditedA.primaryStore.rootStore, originFloor);

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let trackedTxnId;
			let attemptCount = 0;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const context = {};
			let commitResult;
			await transaction(context, async () => {
				context.transaction.timestamp = explicitTs;
				await AuditedA.get(recordId, context);
				await AuditedA.put({ id: recordId, writer: 'explicit-below-floor', count: 9 }, context);
				commitResult = await context.transaction.commit();
			});

			assert.strictEqual(attemptCount, 2, 'must re-stage and commit on attempt 2');
			const storedEntry = AuditedA.primaryStore.getEntry(recordId);
			assert.strictEqual(
				storedEntry.version,
				explicitTs,
				'retry round must preserve explicit record version below origin floor instead of promoting to native log key'
			);
			assert.strictEqual(storedEntry.value.writer, 'explicit-below-floor');
			assert.strictEqual(
				commitResult.txnTime,
				explicitTs,
				'returned commitResult.txnTime must preserve explicit timestamp across retry rounds'
			);
			const winnerAuditEntry = auditEntriesFor(AuditedA, recordId).at(-1);
			assert.strictEqual(
				winnerAuditEntry.version,
				explicitTs,
				'audit entry version must match explicit record version'
			);
		});

		it('flushes the durable log entry before parking on an uncommitted write-intent holder, then completes across two real native RETRY_NOW rounds with one aftercommit event and consistent replayLogs()', async function () {
			this.timeout(20000);
			const recordId = id('uncommitted-holder-real-retries');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let trackedTxnId;
			const attemptOutcomes = [];
			let uncommittedAuditWritersWhileHolderOpen = [];
			let committedAuditWritersWhileHolderOpen = [];

			let holderTxn;
			let holderOpen = false;
			pendingRestores.push(() => {
				if (holderOpen && holderTxn) {
					holderOpen = false;
					try {
						holderTxn.abort();
					} catch {}
				}
			});

			let afterCommitCount = 0;
			const onAfterCommit = () => {
				afterCommitCount++;
			};
			AuditedA.auditStore.on('aftercommit', onAfterCommit);
			pendingRestores.push(() => {
				AuditedA.auditStore.off('aftercommit', onAfterCommit);
			});

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb || this.id !== trackedTxnId) return originalCommit.apply(this, args);
				if (attemptOutcomes.length === 0) {
					const commitPromise = originalCommit.apply(this, args);
					await waitFor(
						() =>
							auditEntriesFor(AuditedA, recordId, { readUncommitted: true }).some(
								(e) => e.getValue(AuditedA.primaryStore)?.writer === 'multi-real-winner'
							),
						{ timeout: 3000, message: 'attempt 1 must flush its durable log entry while parked on uncommitted holder' }
					);
					uncommittedAuditWritersWhileHolderOpen = auditEntriesFor(AuditedA, recordId, {
						readUncommitted: true,
					}).map((e) => e.getValue(AuditedA.primaryStore)?.writer);
					committedAuditWritersWhileHolderOpen = auditEntriesFor(AuditedA, recordId).map(
						(e) => e.getValue(AuditedA.primaryStore)?.writer
					);
					holderOpen = false;
					holderTxn.commitSync();
					const res = await commitPromise;
					attemptOutcomes.push(res);
					return res;
				}
				if (attemptOutcomes.length === 1) {
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer-2', count: 2 }, baseNow - 3_000);
				}
				const res = await originalCommit.apply(this, args);
				attemptOutcomes.push(res);
				return res;
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const auditBefore = auditEntriesFor(AuditedA, recordId).length;
			afterCommitCount = 0;
			const context = {};
			await transaction(context, async () => {
				await AuditedA.get(recordId, context);
				trackedTxnId = context.transaction.transaction.id;
				await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer-1', count: 1 }, baseNow - 8_000);
				holderTxn = new Transaction(AuditedA.primaryStore.store, { coordinatedRetry: true });
				holderOpen = true;
				AuditedA.primaryStore.putSync(
					recordId,
					{ id: recordId, writer: 'uncommitted-holder', count: 1 },
					{ transaction: holderTxn, version: baseNow - 6_000 }
				);
				await AuditedA.put({ id: recordId, writer: 'multi-real-winner', count: 3 }, context);
			});

			assert.ok(
				uncommittedAuditWritersWhileHolderOpen.includes('multi-real-winner'),
				'durable log entry must exist in readUncommitted scan before the uncommitted holder releases'
			);
			assert.ok(
				!committedAuditWritersWhileHolderOpen.includes('multi-real-winner'),
				'default committed scan must stay held back by uncommittedPositions until the logged handle commits'
			);
			assert.deepStrictEqual(
				attemptOutcomes,
				[RETRY_NOW_VALUE, RETRY_NOW_VALUE, undefined],
				'must experience two real native RETRY_NOW rounds and commit on attempt 3'
			);
			assert.strictEqual(
				afterCommitCount,
				3,
				'aftercommit must fire once for interposer-1, once for interposer-2, and once for multi-real-winner across 3 native attempts'
			);
			const auditsAfter = auditEntriesFor(AuditedA, recordId);
			assert.strictEqual(
				auditsAfter.length - auditBefore,
				3,
				'real recommits of a logged handle must not write duplicate audit entries'
			);
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.writer, 'multi-real-winner');

			const winnerEntry = AuditedA.primaryStore.getEntry(recordId);
			AuditedA.primaryStore.putSync(
				recordId,
				{ id: recordId, writer: 'corrupted-before-replay', count: 0 },
				{ version: baseNow - 9_000 }
			);
			await replayLogs(AuditedA.primaryStore.rootStore, { NoAbortAuditedA: AuditedA }, true);
			const afterReplay = AuditedA.primaryStore.getEntry(recordId);
			assert.strictEqual(afterReplay.value.writer, 'multi-real-winner');
			assert.strictEqual(afterReplay.value.count, 3);
			assert.strictEqual(afterReplay.version, winnerEntry.version);
		});

		it('handles last-write-wins loss against a newer interposer and merges patch retries against the updated base record', async function () {
			this.timeout(20000);
			const lwwId = id('lww-loser-on-retry');
			const patchId = id('patch-merge-on-retry');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: lwwId, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: patchId, writer: 'seed-writer', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let activeScenario = 'lww';
			let trackedLwwTxn;
			let trackedPatchTxn;
			const lwwOutcomes = [];
			const patchOutcomes = [];
			const newerInterposerTs = baseNow + 5_000;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (activeScenario === 'lww' && trackedLwwTxn === undefined) {
					trackedLwwTxn = this.id;
					await putWithTimestamp(AuditedA, { id: lwwId, writer: 'newer-interposer', count: 99 }, newerInterposerTs);
					const res = await originalCommit.apply(this, args);
					lwwOutcomes.push(res);
					return res;
				}
				if (this.id === trackedLwwTxn) {
					const res = await originalCommit.apply(this, args);
					lwwOutcomes.push(res);
					return res;
				}
				if (activeScenario === 'patch' && trackedPatchTxn === undefined) {
					trackedPatchTxn = this.id;
					await putWithTimestamp(AuditedA, { id: patchId, writer: 'interposer-writer', count: 10 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					patchOutcomes.push(res);
					return res;
				}
				if (this.id === trackedPatchTxn) {
					const res = await originalCommit.apply(this, args);
					patchOutcomes.push(res);
					return res;
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const lwwCtx = {};
			await transaction(lwwCtx, async () => {
				lwwCtx.transaction.timestamp = baseNow - 2_000;
				await AuditedA.get(lwwId, lwwCtx);
				await AuditedA.put({ id: lwwId, writer: 'older-retry-writer', count: 1 }, lwwCtx);
			});
			assert.deepStrictEqual(
				lwwOutcomes,
				[RETRY_NOW_VALUE, undefined],
				'LWW loser must conflict on attempt 1 and commit its no-op handle on attempt 2'
			);
			const lwwStored = AuditedA.primaryStore.getEntry(lwwId);
			assert.strictEqual(lwwStored.value.writer, 'newer-interposer');
			assert.strictEqual(lwwStored.value.count, 99);
			assert.strictEqual(lwwStored.version, newerInterposerTs);

			activeScenario = 'patch';
			const patchCtx = {};
			await transaction(patchCtx, async () => {
				await AuditedA.patch(patchId, { count: 77 }, patchCtx);
			});
			assert.deepStrictEqual(
				patchOutcomes,
				[RETRY_NOW_VALUE, undefined],
				'patch must conflict on attempt 1 and commit the merged record on attempt 2'
			);
			const patchStored = AuditedA.primaryStore.getEntry(patchId);
			assert.strictEqual(
				patchStored.value.writer,
				'interposer-writer',
				'patch retry must merge against the newly committed base record'
			);
			assert.strictEqual(patchStored.value.count, 77);
		});

		it('backs off after round 3 (retries > 2) under sustained RETRY_NOW contention after both crossing-writes transactions durably log', async function () {
			this.timeout(20000);
			const keyA = id('cross-a');
			const keyB = id('cross-b');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: keyA, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: keyB, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const rootStore = AuditedA.primaryStore.rootStore;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;

			let txn1Id;
			let txn2Id;
			let attempts1 = 0;
			let attempts2 = 0;
			let enteredInTurn = 0;
			const attempt1Outcomes = [];
			const waitingInCommit = [];
			const reenteredSynchronouslyAfterRound = [];

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (this.id !== txn1Id && this.id !== txn2Id) return originalCommit.apply(this, args);
				const attempt = this.id === txn1Id ? ++attempts1 : ++attempts2;
				enteredInTurn++;
				if (attempt === 1) {
					const res = await originalCommit.apply(this, args);
					attempt1Outcomes.push(res);
					return await new Promise((resolve) => {
						waitingInCommit.push(() => resolve(res));
					});
				}
				if (attempt <= 3) {
					return await new Promise((resolve) => {
						waitingInCommit.push(() => resolve(RETRY_NOW_VALUE));
					});
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
				while (waitingInCommit.length > 0) waitingInCommit.shift()();
			});

			const auditABefore = auditEntriesFor(AuditedA, keyA).length;
			const auditBBefore = auditEntriesFor(AuditedA, keyB).length;

			const ctx1 = {};
			const ctx2 = {};
			let snapshotsReadyResolve;
			let snapshotsReadyCount = 0;
			const snapshotsReady = new Promise((resolve) => {
				snapshotsReadyResolve = resolve;
			});
			let releaseAfterBump;
			const bumpGate = new Promise((resolve) => {
				releaseAfterBump = resolve;
			});
			pendingRestores.push(() => releaseAfterBump());

			const t1Promise = transaction(ctx1, async () => {
				ctx1.transaction.timestamp = baseNow - 2_000;
				await AuditedA.get(keyA, ctx1);
				await AuditedA.get(keyB, ctx1);
				txn1Id = ctx1.transaction.transaction.id;
				if (++snapshotsReadyCount === 2) snapshotsReadyResolve();
				await bumpGate;
				await AuditedA.put({ id: keyA, writer: 'cross-1', count: 10 }, ctx1);
				await AuditedA.put({ id: keyB, writer: 'cross-1', count: 10 }, ctx1);
			});

			const t2Promise = transaction(ctx2, async () => {
				ctx2.transaction.timestamp = baseNow - 1_000;
				await AuditedA.get(keyB, ctx2);
				await AuditedA.get(keyA, ctx2);
				txn2Id = ctx2.transaction.transaction.id;
				if (++snapshotsReadyCount === 2) snapshotsReadyResolve();
				await bumpGate;
				await AuditedA.put({ id: keyB, writer: 'cross-2', count: 20 }, ctx2);
				await AuditedA.put({ id: keyA, writer: 'cross-2', count: 20 }, ctx2);
			});

			await snapshotsReady;
			await putWithTimestamp(AuditedA, { id: keyA, writer: 'bump', count: 1 }, baseNow - 8_000);
			await putWithTimestamp(AuditedA, { id: keyB, writer: 'bump', count: 1 }, baseNow - 8_000);
			releaseAfterBump();

			for (let round = 1; round <= 3; round++) {
				await waitFor(() => waitingInCommit.length === 2, {
					timeout: 3000,
					message: `both crossing-writes transactions must reach commit round ${round}`,
				});
				if (round === 1) {
					assert.deepStrictEqual(
						attempt1Outcomes,
						[RETRY_NOW_VALUE, RETRY_NOW_VALUE],
						'both transactions must flush their durable log entries and get real RETRY_NOW on attempt 1'
					);
				}
				enteredInTurn = 0;
				const releases = waitingInCommit.splice(0, 2);
				for (const release of releases) release();
				for (let tick = 0; tick < 6; tick++) await Promise.resolve();
				reenteredSynchronouslyAfterRound.push(enteredInTurn);
			}

			assert.deepStrictEqual(
				reenteredSynchronouslyAfterRound,
				[2, 2, 0],
				'rounds 1-2 re-stage immediately in lockstep, while round 3 (retries > 2) backs off before re-staging'
			);

			const suspension = suspendDatabaseCommits([rootStore]);
			try {
				await suspension.waitForDrain();
				await Promise.all([t1Promise, t2Promise]);
			} finally {
				suspension.release();
			}

			assert.deepStrictEqual(aborted, [], 'neither logged crossing-writes transaction may be aborted');
			assert.ok(attempts1 >= 4 && attempts2 >= 4, 'both transactions must complete after the post-round-3 backoff');
			assert.strictEqual(AuditedA.primaryStore.getEntry(keyA).value.writer, 'cross-2');
			assert.strictEqual(AuditedA.primaryStore.getEntry(keyB).value.writer, 'cross-2');
			assert.strictEqual(
				auditEntriesFor(AuditedA, keyA).length - auditABefore,
				3,
				'keyA must have bump + cross-1 + cross-2 audit entries with no duplicates across retries'
			);
			assert.strictEqual(
				auditEntriesFor(AuditedA, keyB).length - auditBBefore,
				3,
				'keyB must have bump + cross-1 + cross-2 audit entries with no duplicates across retries'
			);
		});
	});

	describe('3. Commit-budget deadline (elapsedPastCommitBudget) after durable log write', () => {
		it('does not throw TransactionCommitConflictTimeoutError when a logged transaction exceeds the conflict budget on both RETRY_NOW and ERR_BUSY paths', async function () {
			this.timeout(20000);
			resetStuckCommitLogCooldownForTests();
			const recordId = id('budget-logged');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;

			const errorLines = captureLogger('error');

			let trackedTxnId;
			let attemptCount = 0;
			let firstAttemptOutcome;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					firstAttemptOutcome = res;
					return res;
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount === 2) return RETRY_NOW_VALUE;
				if (attemptCount === 3) throw Object.assign(new Error('forced busy'), { code: 'ERR_BUSY' });
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const auditBefore = auditEntriesFor(AuditedA, recordId).length;
			const context = {};
			await transaction(context, async () => {
				await AuditedA.get(recordId, context);
				await AuditedA.put({ id: recordId, writer: 'budget-survivor', count: 5 }, context);
				context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
			});

			assert.strictEqual(firstAttemptOutcome, RETRY_NOW_VALUE);
			assert.strictEqual(attemptCount, 4);
			assert.ok(!aborted.includes(trackedTxnId), 'logged transaction must not be abandoned at the budget deadline');
			const stored = AuditedA.primaryStore.getEntry(recordId).value;
			assert.strictEqual(stored.writer, 'budget-survivor');
			assert.strictEqual(stored.count, 5);

			const auditsAfter = auditEntriesFor(AuditedA, recordId);
			assert.strictEqual(auditsAfter.length - auditBefore, 2);
			assert.strictEqual(auditsAfter.at(-1).getValue(AuditedA.primaryStore).writer, 'budget-survivor');

			const overdueErrors = errorLines.filter(([msg]) =>
				msg.startsWith('A durably logged write transaction is still in write-intent conflict')
			);
			assert.strictEqual(overdueErrors.length, 1, 'overdue diagnostic must be logged once per logical commit');
		});

		it('unblocks a parked logged commit when the long-transaction monitor aborts an unsubmitted write-intent holder', async function () {
			this.timeout(25000);
			const recordId = id('monitor-aborts-holder');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const prevTxnExpiration = getTxnExpiration();
			pendingRestores.push(() => setTxnExpiration(prevTxnExpiration));

			let writerSnapshotResolve;
			const writerSnapshotReady = new Promise((resolve) => {
				writerSnapshotResolve = resolve;
			});
			let releaseWriterToCommit;
			const writerReadyGate = new Promise((resolve) => {
				releaseWriterToCommit = resolve;
			});
			pendingRestores.push(() => releaseWriterToCommit());

			let holderStagedResolve;
			const holderStaged = new Promise((resolve) => {
				holderStagedResolve = resolve;
			});
			let releaseHolderScope;
			const holderScopeGate = new Promise((resolve) => {
				releaseHolderScope = resolve;
			});
			pendingRestores.push(() => releaseHolderScope());

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let writerTxnId;
			let writerAttempts = 0;
			let writerSettled = false;

			const holderCtx = {};
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb || this.id !== writerTxnId) return originalCommit.apply(this, args);
				writerAttempts++;
				if (writerAttempts >= 2 && !holderCtx.transaction?.timedOut) {
					// Keep bumping the committed version behind the reset snapshot while the holder is still open,
					// so round 2+ also hits Status::Busy() and parks on the holder instead of committing around it.
					await putWithTimestamp(
						AuditedA,
						{ id: recordId, writer: `interposer-${writerAttempts}`, count: 1 },
						baseNow - 8_000 + writerAttempts
					);
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const writerCtx = {};
			const writerPromise = transaction(writerCtx, async () => {
				writerCtx.transaction.timeout = 20_000;
				writerCtx.transaction.writeTimeout = 20_000;
				await AuditedA.get(recordId, writerCtx);
				writerTxnId = writerCtx.transaction.transaction.id;
				writerSnapshotResolve();
				await writerReadyGate;
				await AuditedA.put({ id: recordId, writer: 'unblocked-by-monitor', count: 3 }, writerCtx);
			}).then((res) => {
				writerSettled = true;
				return res;
			});

			await writerSnapshotReady;
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer-1', count: 1 }, baseNow - 8_000);

			const holderPromise = transaction(holderCtx, async () => {
				await AuditedA.get(recordId, holderCtx);
				await AuditedA.put({ id: recordId, writer: 'stalled-holder', count: 2 }, holderCtx);
				holderCtx.transaction.save(holderCtx.transaction.writes[0]);
				holderStagedResolve();
				await holderScopeGate;
				await holderCtx.transaction.commit();
			});

			await holderStaged;
			releaseWriterToCommit();

			await waitFor(
				() =>
					auditEntriesFor(AuditedA, recordId, { readUncommitted: true }).some(
						(e) => e.getValue(AuditedA.primaryStore)?.writer === 'unblocked-by-monitor'
					),
				{ timeout: 3000, message: 'writer must flush its durable log entry and park on stalled holder' }
			);
			await waitFor(() => writerAttempts >= 2, {
				timeout: 8000,
				message: 'writer must finish one native park interval and re-park on round 2 while holder remains open',
			});
			assert.strictEqual(
				writerSettled,
				false,
				'writer must still be pending after one native park interval before the monitor aborts the holder'
			);
			assert.ok(!holderCtx.transaction.timedOut, 'holder must still be open while writer is parked on round 2');

			holderCtx.transaction.timeout = 0;
			holderCtx.transaction.writeTimeout = 0;
			setTxnExpiration(25);

			await writerPromise;
			assert.strictEqual(holderCtx.transaction.timedOut, true, 'monitor must have timed out the unsubmitted holder');
			assert.ok(writerAttempts >= 3, 'writer must wake from round 2 and commit after the monitor aborts the holder');

			releaseHolderScope();
			await assert.rejects(
				holderPromise,
				(err) => err.statusCode === 422 && /exceeding the maximum open-transaction time/.test(err.message)
			);
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.writer, 'unblocked-by-monitor');
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.count, 3);
		});
	});

	describe('4. Record-lock lease expiry on retry after durable log write', () => {
		it('completes a single-holder logged commit across 3 retry rounds after its lease expires', async function () {
			this.timeout(20000);
			const recordId = id('lock-single');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const lease = MIN_LOCK_LEASE_MS;
			const targetDb = AuditedA.primaryStore.store.db;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnId;
			let trackedNativeTxn;
			let attemptCount = 0;
			let lockHandle;
			const holdRetainedOnRetry = [];
			const isExpiredOnRetry = [];

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					trackedNativeTxn = this;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					[lockHandle] = this.lockHolds ?? [];
					try {
						return await originalCommit.apply(this, args);
					} finally {
						await delay(lease + 60);
					}
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				holdRetainedOnRetry.push(Boolean(this.lockHolds?.has(lockHandle)));
				isExpiredOnRetry.push(lockHandle?.isExpired());
				if (attemptCount <= 3) return RETRY_NOW_VALUE;
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const auditBefore = auditEntriesFor(AuditedA, recordId).length;
			const rec = await AuditedA.lock(recordId, { hold: true, lease });
			rec.set('writer', 'lease-expired-winner');
			rec.set('count', 9);
			await rec.save();
			assert.strictEqual(Boolean(trackedNativeTxn.lockHolds), false, 'lockHolds must be cleared once save() settles');
			await rec.unlock();

			assert.strictEqual(attemptCount, 4, 'initial real conflict + 2 RETRY_NOW rounds + final commit');
			assert.deepStrictEqual(isExpiredOnRetry, [true, true, true], 'lease must be expired across all 3 retry rounds');
			assert.deepStrictEqual(
				holdRetainedOnRetry,
				[true, true, true],
				'native transaction must retain lockHolds across all 3 retry rounds'
			);
			assert.ok(!aborted.includes(trackedTxnId));
			const stored = AuditedA.primaryStore.getEntry(recordId).value;
			assert.strictEqual(stored.writer, 'lease-expired-winner');
			assert.strictEqual(stored.count, 9);
			const auditsAfter = auditEntriesFor(AuditedA, recordId);
			assert.strictEqual(auditsAfter.length - auditBefore, 2);
			assert.strictEqual(auditsAfter.at(-1).getValue(AuditedA.primaryStore).count, 9);
		});

		it('serializes a second lock waiter behind an in-flight logged retry past lease expiry and does not block unrelated keys on the same ImmediateTransaction', async function () {
			this.timeout(20000);
			const recordId = id('lock-two-holder');
			const otherId = id('lock-other-key');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 5 }, baseNow - 10_000);
			await AuditedA.put({ id: otherId, writer: 'seed-other', count: 10 });

			const lease = MIN_LOCK_LEASE_MS;
			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnId;
			let releaseRetry;
			const retryGate = new Promise((resolve) => {
				releaseRetry = resolve;
			});
			pendingRestores.push(() => releaseRetry());
			let firstConflictDoneResolve;
			const firstConflictDone = new Promise((resolve) => {
				firstConflictDoneResolve = resolve;
			});

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 5 }, baseNow - 5_000);
					try {
						return await originalCommit.apply(this, args);
					} catch (err) {
						await delay(lease + 60);
						firstConflictDoneResolve();
						await retryGate;
						throw err;
					}
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holderOther = await AuditedA.lock(otherId, { hold: true, lease: 5000 });
			const holderA = await AuditedA.lock(recordId, { hold: true, lease }, holderOther.getContext());
			assert.strictEqual(
				holderA.getContext().transaction,
				holderOther.getContext().transaction,
				'both hold locks share the same ImmediateTransaction instance'
			);

			holderA.set('writer', 'holder-A');
			holderA.set('count', 6);
			const saveAPromise = holderA.save();

			await firstConflictDone;

			let bAcquired = false;
			const waiterBPromise = transaction(async () => {
				const recB = await AuditedA.lock(recordId, { lease: 5000, timeout: 5000 });
				bAcquired = true;
				const observedCount = recB.get('count');
				assert.strictEqual(observedCount, 6, 'Waiter B must observe holder A committed count (6)');
				recB.set('writer', 'holder-B');
				recB.set('count', observedCount + 1);
				await recB.save();
			});

			await delay(40);
			assert.strictEqual(bAcquired, false, 'Waiter B must not acquire the lock while A logged commit is in flight');

			holderOther.set('count', 11);
			await holderOther.save();
			await holderOther.unlock();
			const checkOtherLock = await AuditedA.lock(otherId, { lease: MIN_LOCK_LEASE_MS, timeout: 300 });
			await checkOtherLock.unlock();

			releaseRetry();
			await saveAPromise;
			await waiterBPromise;
			await holderA.unlock();

			assert.strictEqual(bAcquired, true);
			const finalRecord = AuditedA.primaryStore.getEntry(recordId).value;
			assert.strictEqual(finalRecord.count, 7);
			assert.strictEqual(finalRecord.writer, 'holder-B');

			const audits = auditEntriesFor(AuditedA, recordId).map((e) => e.getValue(AuditedA.primaryStore));
			assert.strictEqual(audits.at(-2).count, 6);
			assert.strictEqual(audits.at(-1).count, 7);
		});

		it('serializes a second lock waiter when an open-iterator replayTransaction conflicts on attempt 1 and retries past lease expiry', async function () {
			this.timeout(20000);
			const recordId = id('lock-replay-two-holder');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 5 }, baseNow - 10_000);

			const lease = MIN_LOCK_LEASE_MS;
			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;

			let replayTxnId;
			let attemptCount = 0;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (replayTxnId === undefined) {
					replayTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 5 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					// Age the lease while the replay transaction is in conflict, AFTER it has written its log batch
					// (replayTransaction uses coordinatedRetry: true, so originalCommit resolves with RETRY_NOW).
					await delay(lease + 60);
					return res;
				}
				if (this.id !== replayTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			let heldIterator;
			const context = {};
			const txnAPromise = transaction(context, async () => {
				const recA = await AuditedA.lock(recordId, { lease });
				recA.set('writer', 'replay-A');
				recA.set('count', 6);
				await recA.save();
				// Keep an open read iterator on `context` so performCommit takes the replayTransaction branch.
				heldIterator = AuditedA.search({ conditions: [] }, context)[Symbol.asyncIterator]();
				await heldIterator.next();
			});

			await waitFor(() => attemptCount >= 1, { message: 'replayTransaction should enter attempt 1' });
			const txnBPromise = transaction(async () => {
				const recB = await AuditedA.lock(recordId, { lease: 5000, timeout: 5000 });
				const seen = recB.get('count');
				assert.strictEqual(seen, 6, 'Waiter B must see replayTransaction A committed value (6)');
				recB.set('writer', 'replay-B');
				recB.set('count', seen + 1);
				await recB.save();
			});

			await txnAPromise;
			await txnBPromise;
			await heldIterator?.return?.();

			const finalRecord = AuditedA.primaryStore.getEntry(recordId).value;
			assert.strictEqual(finalRecord.count, 7);
			assert.strictEqual(finalRecord.writer, 'replay-B');
		});

		it('bounds the deferred lock hold by the commit-conflict budget so a wedged logged retry releases the key for another waiter', async function () {
			this.timeout(20000);
			const recordId = id('lock-budget-release');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const lease = MIN_LOCK_LEASE_MS;
			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnId;
			let attemptCount = 0;
			let holdSecondRetry;
			const secondRetryGate = new Promise((resolve) => {
				holdSecondRetry = resolve;
			});
			pendingRestores.push(() => holdSecondRetry());
			let parkedInOverdueRetry = false;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					await delay(lease + 60);
					return res;
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount === 2) {
					parkedInOverdueRetry = true;
					await secondRetryGate;
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const context = {};
			let txnASettled = false;
			const txnAPromise = transaction(context, async () => {
				const rec = await AuditedA.lock(recordId, { lease });
				rec.set('writer', 'overdue-holder');
				rec.set('count', 10);
				await rec.save();
				context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
			});
			txnAPromise.then(
				() => {
					txnASettled = true;
				},
				() => {
					txnASettled = true;
				}
			);

			await waitFor(() => parkedInOverdueRetry || txnASettled, {
				message: 'logged transaction should reach attempt 2 after budget expiry',
			});
			assert.strictEqual(parkedInOverdueRetry, true, 'logged transaction must continue to attempt 2 past budget');

			const waiterB = await AuditedA.lock(recordId, { lease: 1000, timeout: 500 });
			await waiterB.unlock();

			holdSecondRetry();
			await txnAPromise;
		});

		it('releases the lock hold as soon as the store commit lands locally, before chained stores or replicationConfirmation settle', async function () {
			this.timeout(20000);
			const recordA = id('local-land-chain-a');
			const recordB = id('local-land-chain-b');
			await AuditedA.put({ id: recordA, writer: 'seed', count: 0 });
			await AuditedB.put({ id: recordB, writer: 'seed', count: 0 });

			const lease = MIN_LOCK_LEASE_MS;
			const dbAHandle = AuditedA.primaryStore.store.db;
			const dbBHandle = AuditedB.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let releaseDbB;
			const dbBGate = new Promise((resolve) => {
				releaseDbB = resolve;
			});
			pendingRestores.push(() => releaseDbB());
			let dbBReached = false;
			let dbANativeTxn;
			let holdRetainedDuringDbACommit;
			let captureRepTxn = false;
			let repNativeTxn;
			let holdRetainedDuringRepCommit;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db === dbAHandle) {
					const commitPromise = originalCommit.apply(this, args);
					await Promise.resolve();
					if (holdRetainedDuringDbACommit === undefined) {
						dbANativeTxn = this;
						holdRetainedDuringDbACommit = (this.lockHolds?.size ?? 0) > 0;
					} else if (captureRepTxn && !repNativeTxn) {
						repNativeTxn = this;
						holdRetainedDuringRepCommit = (this.lockHolds?.size ?? 0) > 0;
					}
					return commitPromise;
				}
				if (this.store?.db !== dbBHandle) return originalCommit.apply(this, args);
				dbBReached = true;
				await delay(lease + 60);
				await dbBGate;
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const chainContext = {};
			const chainPromise = transaction(chainContext, async () => {
				const recA = await AuditedA.lock(recordA, { lease });
				recA.set('writer', 'chain-a');
				recA.set('count', 1);
				await recA.save();
				await AuditedB.put({ id: recordB, writer: 'chain-b', count: 1 }, chainContext);
			});

			await waitFor(() => dbBReached, { message: 'DbB commit should be entered after DbA commits locally' });
			assert.strictEqual(
				holdRetainedDuringDbACommit,
				true,
				'DbA native transaction must retain lockHolds during commit'
			);
			assert.strictEqual(Boolean(dbANativeTxn.lockHolds), false, 'DbA lockHolds must be released before DbB settles');
			const lockDuringDbB = await AuditedA.lock(recordA, { lease: MIN_LOCK_LEASE_MS, timeout: 400 });
			await lockDuringDbB.unlock();
			releaseDbB();
			await chainPromise;

			const recordRep = id('local-land-rep');
			await AuditedA.put({ id: recordRep, writer: 'seed', count: 0 });
			let releaseRep;
			const repGate = new Promise((resolve) => {
				releaseRep = resolve;
			});
			pendingRestores.push(() => releaseRep());
			let repReached = false;
			let holdDuringRepWait;
			replicationConfirmation(
				() => {
					holdDuringRepWait = Boolean(repNativeTxn?.lockHolds);
					repReached = true;
					return repGate;
				},
				() => {}
			);
			pendingRestores.push(() => {
				replicationConfirmation(undefined, undefined);
			});

			captureRepTxn = true;
			const repContext = { replicatedConfirmation: 1 };
			const repPromise = transaction(repContext, async () => {
				const rec = await AuditedA.lock(recordRep, { lease });
				rec.set('writer', 'rep-writer');
				rec.set('count', 2);
				await rec.save();
			});

			await waitFor(() => repReached, { message: 'replicationConfirmation should be entered after local commit' });
			assert.strictEqual(holdRetainedDuringRepCommit, true, 'native transaction must retain lockHolds during commit');
			assert.strictEqual(
				holdDuringRepWait,
				false,
				'lockHolds must already be cleared when replicationConfirmation starts'
			);
			const lockDuringRep = await AuditedA.lock(recordRep, { lease: MIN_LOCK_LEASE_MS, timeout: 400 });
			await lockDuringRep.unlock();
			releaseRep();
			await repPromise;
		});

		it('delays cluster onRelease (revokeLease recall drain) until an in-flight logged retry settles', async function () {
			this.timeout(20000);
			const recordId = id('lock-cluster-recall');
			const conflictId = id('lock-cluster-conflict');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: conflictId, writer: 'seed', count: 0 }, baseNow - 10_000);

			let clusterReleased = false;
			let lockHandle;
			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let trackedTxnId;
			let releaseRetry;
			const retryGate = new Promise((resolve) => {
				releaseRetry = resolve;
			});
			pendingRestores.push(() => releaseRetry());
			let inRetry = false;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					await putWithTimestamp(AuditedA, { id: conflictId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					inRetry = true;
					await retryGate;
					return res;
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const ctx = {};
			const txnPromise = transaction(ctx, async () => {
				const rec = await AuditedA.lock(recordId, { lease: 5000 });
				lockHandle = ctx.transaction.recordLockFor(AuditedA.primaryStore, recordId);
				assert.ok(lockHandle, 'lock handle must be registered on the transaction');
				const joined = lockHandle.joinClusterRound(Date.now(), 5000, performance.now(), () => {
					clusterReleased = true;
				});
				assert.strictEqual(joined, true, 'must join cluster round');
				await AuditedA.get(conflictId, ctx);
				await AuditedA.put({ id: conflictId, writer: 'cluster-holder', count: 3 }, ctx);
				rec.set('writer', 'cluster-holder');
				rec.set('count', 3);
				await rec.save();
			});

			await waitFor(() => inRetry, { message: 'logged commit should be parked in retry' });

			lockHandle.revokeLease();
			await delay(40);
			assert.strictEqual(
				clusterReleased,
				false,
				'cluster onRelease must not fire while the logged commit is still in flight'
			);

			releaseRetry();
			await txnPromise;
			assert.strictEqual(clusterReleased, true, 'cluster onRelease fires once the logged commit lands');
		});

		it('releases a deferred record lock via the hold-deadline timer when a native commit wedges and never settles', async function () {
			this.timeout(20000);
			const recordId = id('lock-wedged-commit');
			await AuditedA.put({ id: recordId, writer: 'seed', count: 0 });

			const prevMaxDuration = setMaxOutstandingTxnDuration(150);
			pendingRestores.push(() => setMaxOutstandingTxnDuration(prevMaxDuration));

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let releaseWedged;
			const wedgedGate = new Promise((resolve) => {
				releaseWedged = resolve;
			});
			pendingRestores.push(() => releaseWedged());
			let enteredCommit = false;
			let trackedTxnId;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					enteredCommit = true;
					await wedgedGate;
					return originalCommit.apply(this, args);
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holder = await AuditedA.lock(recordId, { hold: true, lease: MIN_LOCK_LEASE_MS });
			holder.getContext().transaction.timeoutBudget = 150;
			holder.set('writer', 'wedged-holder');
			holder.set('count', 1);
			const savePromise = holder.save();

			await waitFor(() => enteredCommit, { message: 'holder commit should enter wedged native commit' });
			const contender = await AuditedA.lock(recordId, { lease: 1000, timeout: 1000 });
			await contender.unlock();

			releaseWedged();
			await savePromise;
			await holder.unlock();
		});

		it('does not re-stage an in-flight sibling write onto a fresh write when a shared ImmediateTransaction had an earlier retry', async function () {
			this.timeout(20000);
			const k1 = id('sib-k1');
			const k2 = id('sib-k2');
			const k3 = id('sib-k3');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: k1, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: k2, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: k3, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let k1TxnId;
			let k1Attempt2Parked = false;
			let releaseK1;
			const k1Gate = new Promise((resolve) => {
				releaseK1 = resolve;
			});
			pendingRestores.push(() => releaseK1());

			let k2TxnId;
			let k2InCommit = false;
			let releaseK2;
			const k2Gate = new Promise((resolve) => {
				releaseK2 = resolve;
			});
			pendingRestores.push(() => releaseK2());

			let nextWriteStage = 'k1';
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (nextWriteStage === 'k1' && k1TxnId === undefined) {
					k1TxnId = this.id;
					await putWithTimestamp(AuditedA, { id: k1, writer: 'interposer-k1', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id === k1TxnId) {
					k1Attempt2Parked = true;
					await k1Gate;
					return originalCommit.apply(this, args);
				}
				if (nextWriteStage === 'k2' && k2TxnId === undefined) {
					k2TxnId = this.id;
					k2InCommit = true;
					await k2Gate;
					return originalCommit.apply(this, args);
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holder1 = await AuditedA.lock(k1, { hold: true, lease: 10_000 });
			const sharedCtx = holder1.getContext();
			const holder2 = await AuditedA.lock(k2, { hold: true, lease: 10_000 }, sharedCtx);
			const holder3 = await AuditedA.lock(k3, { hold: true, lease: 10_000 }, sharedCtx);
			assert.strictEqual(holder2.getContext().transaction, sharedCtx.transaction);
			assert.strictEqual(holder3.getContext().transaction, sharedCtx.transaction);

			const k1AuditsBefore = auditEntriesFor(AuditedA, k1).length;
			const k2AuditsBefore = auditEntriesFor(AuditedA, k2).length;
			const k3AuditsBefore = auditEntriesFor(AuditedA, k3).length;

			holder1.set('writer', 'w1');
			holder1.set('count', 10);
			const k1SavePromise = holder1.save();
			await waitFor(() => k1Attempt2Parked, { message: 'k1 retry attempt 2 should be parked in flight' });
			assert.strictEqual(sharedCtx.transaction.isCommitting, true);
			assert.strictEqual(sharedCtx.transaction.retries, 1);

			nextWriteStage = 'k2';
			holder2.set('writer', 'w2');
			holder2.set('count', 20);
			const k2SavePromise = holder2.save();
			await waitFor(() => k2InCommit, { message: 'k2 commit should be parked in flight' });

			releaseK1();
			await k1SavePromise;
			assert.strictEqual(sharedCtx.transaction.isCommitting, false);
			assert.strictEqual(
				sharedCtx.transaction.retries,
				0,
				'shared ImmediateTransaction must reset its retry counter when k1 settles so sibling writes do not inherit it'
			);

			nextWriteStage = 'k3';
			holder3.set('writer', 'w3');
			holder3.set('count', 30);
			await holder3.save();

			releaseK2();
			await k2SavePromise;
			await holder1.unlock();
			await holder2.unlock();
			await holder3.unlock();

			const k1AuditsAfter = auditEntriesFor(AuditedA, k1).length;
			const k2AuditsAfter = auditEntriesFor(AuditedA, k2).length;
			const k3AuditsAfter = auditEntriesFor(AuditedA, k3).length;
			assert.strictEqual(
				k1AuditsAfter - k1AuditsBefore,
				2,
				'k1 must have 2 audit entries (interposer + w1) and never be re-staged onto k2 or k3'
			);
			assert.strictEqual(
				k2AuditsAfter - k2AuditsBefore,
				1,
				'k2 must only be committed once and never re-staged onto k3 native transaction'
			);
			assert.strictEqual(k3AuditsAfter - k3AuditsBefore, 1, 'k3 must only be committed once');
			assert.strictEqual(AuditedA.primaryStore.getEntry(k1).value.writer, 'w1');
			assert.strictEqual(AuditedA.primaryStore.getEntry(k2).value.writer, 'w2');
			assert.strictEqual(AuditedA.primaryStore.getEntry(k3).value.writer, 'w3');
		});

		it('does not re-stage an in-flight nested write onto a sibling commit when both the nested write and the sibling commit retry', async function () {
			this.timeout(20000);
			const k1 = id('imm-retry-guard-1');
			const k2 = id('imm-retry-guard-2');
			const k3 = id('imm-retry-guard-3');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: k1, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: k2, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: k3, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			let k1TxnId;
			let k1InCommit = false;
			let releaseK1;
			const k1Gate = new Promise((resolve) => {
				releaseK1 = resolve;
			});
			pendingRestores.push(() => releaseK1());

			let k2TxnId;
			let k2Attempt1Parked = false;
			let releaseK2Attempt1;
			const k2Attempt1Gate = new Promise((resolve) => {
				releaseK2Attempt1 = resolve;
			});
			pendingRestores.push(() => releaseK2Attempt1());

			let k2Attempt2Parked = false;
			let releaseK2Attempt2;
			const k2Attempt2Gate = new Promise((resolve) => {
				releaseK2Attempt2 = resolve;
			});
			pendingRestores.push(() => releaseK2Attempt2());

			let k3TxnId;
			let k3Attempt2Seen = false;
			let nextWriteStage = 'k1';
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (nextWriteStage === 'k1' && k1TxnId === undefined) {
					k1TxnId = this.id;
					k1InCommit = true;
					await k1Gate;
					return originalCommit.apply(this, args);
				}
				if (nextWriteStage === 'k2' && k2TxnId === undefined) {
					k2TxnId = this.id;
					k2Attempt1Parked = true;
					await k2Attempt1Gate;
					await putWithTimestamp(AuditedA, { id: k2, writer: 'interposer-k2', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id === k2TxnId) {
					k2Attempt2Parked = true;
					await k2Attempt2Gate;
					return originalCommit.apply(this, args);
				}
				if (nextWriteStage === 'k3' && k3TxnId === undefined) {
					k3TxnId = this.id;
					await putWithTimestamp(AuditedA, { id: k3, writer: 'interposer-k3', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id === k3TxnId) {
					k3Attempt2Seen = Boolean(this.isRetry);
					return originalCommit.apply(this, args);
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holder1 = await AuditedA.lock(k1, { hold: true, lease: 10_000 });
			const sharedCtx = holder1.getContext();
			const holder2 = await AuditedA.lock(k2, { hold: true, lease: 10_000 }, sharedCtx);
			const holder3 = await AuditedA.lock(k3, { hold: true, lease: 10_000 }, sharedCtx);

			const k1AuditsBefore = auditEntriesFor(AuditedA, k1).length;
			const k2AuditsBefore = auditEntriesFor(AuditedA, k2).length;
			const k3AuditsBefore = auditEntriesFor(AuditedA, k3).length;

			holder1.set('writer', 'w1');
			holder1.set('count', 10);
			const k1SavePromise = holder1.save();
			await waitFor(() => k1InCommit, { message: 'k1 commit should be parked in flight' });
			assert.strictEqual(sharedCtx.transaction.isCommitting, true);

			nextWriteStage = 'k2';
			holder2.set('writer', 'w2');
			holder2.set('count', 20);
			const k2SavePromise = holder2.save();
			await waitFor(() => k2Attempt1Parked, { message: 'k2 attempt 1 should be parked in flight' });

			releaseK1();
			await k1SavePromise;
			assert.strictEqual(sharedCtx.transaction.isCommitting, false);

			releaseK2Attempt1();
			await waitFor(() => k2Attempt2Parked, { message: 'k2 retry attempt 2 should be parked in flight' });
			assert.strictEqual(sharedCtx.transaction.isCommitting, false);
			assert.strictEqual(sharedCtx.transaction.retries, 1);

			nextWriteStage = 'k3';
			holder3.set('writer', 'w3');
			holder3.set('count', 30);
			await holder3.save();
			assert.strictEqual(k3Attempt2Seen, true, 'k3 must have retried onto a second native attempt');

			releaseK2Attempt2();
			await k2SavePromise;
			await holder1.unlock();
			await holder2.unlock();
			await holder3.unlock();

			const k1AuditsAfter = auditEntriesFor(AuditedA, k1).length;
			const k2AuditsAfter = auditEntriesFor(AuditedA, k2).length;
			const k3AuditsAfter = auditEntriesFor(AuditedA, k3).length;
			assert.strictEqual(k1AuditsAfter - k1AuditsBefore, 1, 'k1 must only be committed once');
			assert.strictEqual(
				k2AuditsAfter - k2AuditsBefore,
				2,
				'k2 must have 2 audit entries (interposer + w2) and never be re-staged onto k3 attempt 1 or attempt 2'
			);
			assert.strictEqual(k3AuditsAfter - k3AuditsBefore, 2, 'k3 must have 2 audit entries (interposer + w3)');
			assert.strictEqual(AuditedA.primaryStore.getEntry(k1).value.writer, 'w1');
			assert.strictEqual(AuditedA.primaryStore.getEntry(k2).value.writer, 'w2');
			assert.strictEqual(AuditedA.primaryStore.getEntry(k3).value.writer, 'w3');
		});

		it('allocates fresh monotonic timestamps for sequential plain writes sharing an ImmediateTransaction while a sibling commit is in flight', async function () {
			this.timeout(15000);
			const keyA = id('imm-ts-a');
			const keyB = id('imm-ts-b');

			const targetDb = AuditedA.primaryStore.store.db;
			let nextWriteStage = 'b';
			let bInCommit = false;
			let releaseB;
			const bGate = new Promise((resolve) => {
				releaseB = resolve;
			});
			pendingRestores.push(() => releaseB());

			const originalCommit = Transaction.prototype.commit;
			Transaction.prototype.commit = function (...args) {
				if (this.store?.db === targetDb && this.hasStagedLog && !this._immTsStage) {
					this._immTsStage = nextWriteStage;
				}
				if (this._immTsStage === 'b') {
					bInCommit = true;
					return bGate.then(() => originalCommit.apply(this, args));
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const sharedCtx = {};
			const bPromise = new AuditedA(keyB, sharedCtx).put(keyB, { id: keyB, writer: 'b', count: 1 });
			assert.strictEqual(sharedCtx.transaction.saveCommits, true);
			await waitFor(() => bInCommit, { message: 'write B should be parked inside native commit()' });

			nextWriteStage = 'a1';
			await new AuditedA(keyA, sharedCtx).put(keyA, { id: keyA, writer: 'v1', count: 1 });
			const v1Entry = AuditedA.primaryStore.getEntry(keyA);
			assert.strictEqual(v1Entry.value.writer, 'v1');

			nextWriteStage = 'a2';
			await new AuditedA(keyA, sharedCtx).put(keyA, { id: keyA, writer: 'v2', count: 2 });
			const v2Entry = AuditedA.primaryStore.getEntry(keyA);
			assert.strictEqual(v2Entry.value.writer, 'v2');
			assert.strictEqual(v2Entry.value.count, 2);
			assert.ok(
				v2Entry.version > v1Entry.version,
				`second sequential write must receive a strictly newer record version (${v2Entry.version} > ${v1Entry.version}) while sibling B is in flight`
			);

			releaseB();
			await bPromise;
			assert.strictEqual(AuditedA.primaryStore.getEntry(keyB).value.writer, 'b');
		});

		it('preserves explicit context and transaction timestamps across overlapping writes while allowing post-settlement same-key rewrites on a reused ImmediateTransaction', async function () {
			this.timeout(15000);
			const keyA = id('imm-explicit-ts-a');
			const keyB = id('imm-explicit-ts-b');
			const keyC = id('imm-explicit-ts-c');
			const keyD = id('imm-explicit-ts-d');

			const targetDb = AuditedA.primaryStore.store.db;
			let nextWriteStage = 'a';
			let aInCommit = false;
			let releaseA;
			const aGate = new Promise((resolve) => {
				releaseA = resolve;
			});
			pendingRestores.push(() => releaseA());

			let cInCommit = false;
			let releaseC;
			const cGate = new Promise((resolve) => {
				releaseC = resolve;
			});
			pendingRestores.push(() => releaseC());

			const originalCommit = Transaction.prototype.commit;
			Transaction.prototype.commit = function (...args) {
				if (this.store?.db === targetDb && this.hasStagedLog && !this._immExplicitTsStage) {
					this._immExplicitTsStage = nextWriteStage;
				}
				if (this._immExplicitTsStage === 'a') {
					aInCommit = true;
					return aGate.then(() => {
						if (!this._retriedOnce) {
							this._retriedOnce = true;
							return RETRY_NOW_VALUE;
						}
						return originalCommit.apply(this, args);
					});
				}
				if (this._immExplicitTsStage === 'c') {
					cInCommit = true;
					return cGate.then(() => {
						if (!this._retriedOnce) {
							this._retriedOnce = true;
							return RETRY_NOW_VALUE;
						}
						return originalCommit.apply(this, args);
					});
				}
				if (this._immExplicitTsStage === 'mid-scope-1' && !this._retriedOnce) {
					this._retriedOnce = true;
					return Promise.resolve(RETRY_NOW_VALUE);
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const explicitCtxTs = Date.now() - 1_000;
			const sharedCtx = { timestamp: explicitCtxTs };
			const aPromise = new AuditedA(keyA, sharedCtx).put(keyA, { id: keyA, writer: 'w1', count: 1 });
			assert.strictEqual(sharedCtx.transaction.saveCommits, true);
			await waitFor(() => aInCommit, { message: 'write A should be parked inside native commit()' });

			nextWriteStage = 'b';
			await new AuditedA(keyB, sharedCtx).put(keyB, { id: keyB, writer: 'w2', count: 2 });
			assert.strictEqual(
				AuditedA.primaryStore.getEntry(keyB).version,
				explicitCtxTs,
				'concurrent write sharing a context with explicit timestamp must preserve context.timestamp'
			);

			releaseA();
			await aPromise;
			assert.strictEqual(AuditedA.primaryStore.getEntry(keyA).version, explicitCtxTs);

			nextWriteStage = 'a-rewrite';
			await new AuditedA(keyA, sharedCtx).put(keyA, { id: keyA, writer: 'w1-rewrite', count: 10 });
			const aRewriteEntry = AuditedA.primaryStore.getEntry(keyA);
			assert.strictEqual(
				aRewriteEntry.value.writer,
				'w1-rewrite',
				'same-key rewrite after in-flight writes settle must not tie at context.timestamp and be skipped'
			);
			assert.ok(
				aRewriteEntry.version > explicitCtxTs,
				`post-settlement rewrite must receive a fresh version (${aRewriteEntry.version} > ${explicitCtxTs})`
			);

			const keySeed = id('imm-explicit-ts-seed');
			const explicitTxnTs = explicitCtxTs + 500;
			const txnTsCtx = {};
			nextWriteStage = 'seed';
			await new AuditedA(keySeed, txnTsCtx).put(keySeed, { id: keySeed, writer: 'seed', count: 0 });
			assert.strictEqual(txnTsCtx.transaction.saveCommits, true);
			txnTsCtx.transaction.timestamp = explicitTxnTs;
			nextWriteStage = 'c';
			const cPromise = new AuditedA(keyC, txnTsCtx).put(keyC, { id: keyC, writer: 'w3', count: 3 });
			await waitFor(() => cInCommit, { message: 'write C should be parked inside native commit()' });

			nextWriteStage = 'd';
			await new AuditedA(keyD, txnTsCtx).put(keyD, { id: keyD, writer: 'w4', count: 4 });
			assert.strictEqual(
				AuditedA.primaryStore.getEntry(keyD).version,
				explicitTxnTs,
				'overlapping write while an explicit transaction.timestamp commit is in flight must preserve transaction.timestamp'
			);

			releaseC();
			await cPromise;
			assert.strictEqual(
				AuditedA.primaryStore.getEntry(keyC).version,
				explicitTxnTs,
				'explicitly assigning ctx.transaction.timestamp before overlapping writes must survive ImmediateTransaction reuse'
			);

			nextWriteStage = 'c-rewrite';
			await new AuditedA(keyC, txnTsCtx).put(keyC, { id: keyC, writer: 'w3-rewrite', count: 30 });
			const cRewriteEntry = AuditedA.primaryStore.getEntry(keyC);
			assert.strictEqual(cRewriteEntry.value.writer, 'w3-rewrite');
			assert.ok(cRewriteEntry.version > explicitTxnTs);

			const keyMid = id('mid-scope-retry-same-key');
			nextWriteStage = 'mid-scope-1';
			await transaction(async (ctx) => {
				await AuditedA.put({ id: keyMid, writer: 'seg1', count: 1 }, ctx);
				await ctx.transaction.commit();
				nextWriteStage = 'mid-scope-2';
				await AuditedA.put({ id: keyMid, writer: 'seg2', count: 2 }, ctx);
			});
			const midEntry = AuditedA.primaryStore.getEntry(keyMid);
			assert.strictEqual(
				midEntry.value.writer,
				'seg2',
				'same-key write in rotated segment after a retried mid-scope commit must not reuse segment 1 timestamp and be skipped'
			);
		});
	});

	describe('5. Chained multi-store transaction (head -> next) with a durably logged link', () => {
		it('carries a chained transaction to completion when DbA commits and DbB logs on attempt 1 then conflicts past MAX_RETRIES and budget', async function () {
			this.timeout(20000);
			const prevMaxRetryDelay = setMaxRetryDelayMs(1);
			pendingRestores.push(() => setMaxRetryDelayMs(prevMaxRetryDelay));
			const recordId = id('chain-b-conflict');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed-a', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedB, { id: recordId, writer: 'seed-b', count: 0 }, baseNow - 10_000);

			const dbBHandle = AuditedB.primaryStore.store.db;
			const abortedB = trackAborts(dbBHandle);
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnB;
			let attemptsB = 0;
			let firstAttemptBOutcome;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== dbBHandle) return originalCommit.apply(this, args);
				if (trackedTxnB === undefined) {
					trackedTxnB = this.id;
					attemptsB++;
					await putWithTimestamp(AuditedB, { id: recordId, writer: 'interposer-b', count: 1 }, baseNow - 5_000);
					const res = await originalCommit.apply(this, args);
					firstAttemptBOutcome = res;
					return res;
				}
				if (this.id !== trackedTxnB) return originalCommit.apply(this, args);
				attemptsB++;
				if (attemptsB <= MAX_RETRIES + 2) return RETRY_NOW_VALUE;
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const context = {};
			await transaction(context, async () => {
				await AuditedA.get(recordId, context);
				await AuditedB.get(recordId, context);
				await AuditedA.put({ id: recordId, writer: 'chain-winner-a', count: 10 }, context);
				await AuditedB.put({ id: recordId, writer: 'chain-winner-b', count: 20 }, context);
				assert.ok(context.transaction.next, 'premise: writes across two databases form a head -> next chain');
				context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
			});

			assert.strictEqual(firstAttemptBOutcome, RETRY_NOW_VALUE);
			assert.strictEqual(attemptsB, MAX_RETRIES + 3);
			assert.ok(!abortedB.includes(trackedTxnB), 'logged chained transaction on DbB must not be aborted');

			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.writer, 'chain-winner-a');
			assert.strictEqual(AuditedB.primaryStore.getEntry(recordId).value.writer, 'chain-winner-b');
			assert.strictEqual(
				auditEntriesFor(AuditedA, recordId).at(-1).getValue(AuditedA.primaryStore).writer,
				'chain-winner-a'
			);
			assert.strictEqual(
				auditEntriesFor(AuditedB, recordId).at(-1).getValue(AuditedB.primaryStore).writer,
				'chain-winner-b'
			);
		});

		it('carries a chained transaction to completion when head DbA logs on attempt 1 and conflicts past MAX_RETRIES before cascading to DbB', async function () {
			this.timeout(20000);
			const prevMaxRetryDelay = setMaxRetryDelayMs(1);
			pendingRestores.push(() => setMaxRetryDelayMs(prevMaxRetryDelay));
			const recordId = id('chain-a-conflict');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed-a', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedB, { id: recordId, writer: 'seed-b', count: 0 }, baseNow - 10_000);

			const dbAHandle = AuditedA.primaryStore.store.db;
			const abortedA = trackAborts(dbAHandle);
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnA;
			let attemptsA = 0;

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== dbAHandle) return originalCommit.apply(this, args);
				if (trackedTxnA === undefined) {
					trackedTxnA = this.id;
					attemptsA++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer-a', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id !== trackedTxnA) return originalCommit.apply(this, args);
				attemptsA++;
				if (attemptsA <= MAX_RETRIES + 2) return RETRY_NOW_VALUE;
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const context = {};
			await transaction(context, async () => {
				await AuditedA.get(recordId, context);
				await AuditedB.get(recordId, context);
				await AuditedA.put({ id: recordId, writer: 'head-winner-a', count: 11 }, context);
				await AuditedB.put({ id: recordId, writer: 'head-winner-b', count: 22 }, context);
				context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
			});

			assert.strictEqual(attemptsA, MAX_RETRIES + 3);
			assert.ok(!abortedA.includes(trackedTxnA));
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.writer, 'head-winner-a');
			assert.strictEqual(AuditedB.primaryStore.getEntry(recordId).value.writer, 'head-winner-b');
		});
	});

	describe('6. suspendDatabaseCommits drain and per-attempt backoff tracking on logged retries', () => {
		it('waits for an in-flight logged retry across ERR_BUSY backoff windows before suspendDatabaseCommits resolves, while keeping oldestAgeMs per-attempt bounded', async function () {
			this.timeout(20000);
			const recordId = id('suspend-drain');
			const unrelatedId = id('suspend-unrelated');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordId, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const rootStore = AuditedA.primaryStore.rootStore;
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnId;
			let attemptCount = 0;
			let elapsedBeforeAttempt4 = 0;
			let attempt4EntrySnap;
			let atAttempt4Gate = false;
			let releaseAttempt4;
			const attempt4Gate = new Promise((resolve) => {
				releaseAttempt4 = resolve;
			});
			pendingRestores.push(() => releaseAttempt4());

			let startMs = 0;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount <= 4) {
					if (attemptCount < 4) {
						await delay(20);
					} else {
						elapsedBeforeAttempt4 = performance.now() - startMs;
						await Promise.resolve();
						attempt4EntrySnap = getOutstandingCommits();
						atAttempt4Gate = true;
						await attempt4Gate;
					}
					throw Object.assign(new Error('forced busy'), { code: 'ERR_BUSY' });
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holder = await AuditedA.lock(recordId, { hold: true, lease: 10_000 });
			holder.set('writer', 'drain-survivor');
			holder.set('count', 42);
			startMs = performance.now();
			const savePromise = holder.save();

			await waitFor(() => atAttempt4Gate, {
				message: 'logged retry should reach attempt 4 after the first ERR_BUSY backoff window',
			});

			assert.ok(attempt4EntrySnap.count >= 1, 'attempt 4 must be tracked in outstandingCommits');
			assert.ok(
				attempt4EntrySnap.oldestAgeMs < elapsedBeforeAttempt4 / 2,
				`attempt 4 entry age (${attempt4EntrySnap.oldestAgeMs}ms) must reflect only the fresh round, not cumulative elapsed (${elapsedBeforeAttempt4}ms)`
			);

			const suspension = suspendDatabaseCommits([rootStore]);
			try {
				await AuditedB.put({ id: unrelatedId, writer: 'unrelated-ok', count: 1 });
				assert.strictEqual(attemptCount, 4, 'retry loop must still be on attempt 4 before release');
				releaseAttempt4();
				await suspension.waitForDrain();
				assert.strictEqual(
					attemptCount,
					5,
					'suspendDatabaseCommits must wait across the ERR_BUSY backoff window for attempt 5 to finish'
				);
				await savePromise;
			} finally {
				suspension.release();
			}
			await holder.unlock();

			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.writer, 'drain-survivor');
			assert.strictEqual(AuditedB.primaryStore.getEntry(unrelatedId).value.writer, 'unrelated-ok');
		});

		it('does not let an unlogged chained link bypass suspendDatabaseCommits after a logged head link commits', async function () {
			this.timeout(15000);
			const recordA = id('chain-suspend-a');
			const recordB = id('chain-suspend-b');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordA, writer: 'seed-a', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedB, { id: recordB, writer: 'seed-b', count: 0 }, baseNow - 10_000);

			const dbAHandle = AuditedA.primaryStore.store.db;
			const abortedA = trackAborts(dbAHandle);
			const errorLines = captureLogger('error');
			const rootStoreB = AuditedB.primaryStore.rootStore;
			const originalCommit = Transaction.prototype.commit;
			let trackedTxnA;
			let attemptsA = 0;
			let suspensionB;
			pendingRestores.push(() => suspensionB?.release());

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== dbAHandle) return originalCommit.apply(this, args);
				if (trackedTxnA === undefined) {
					trackedTxnA = this.id;
					attemptsA++;
					await putWithTimestamp(AuditedA, { id: recordA, writer: 'interposer-a', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id !== trackedTxnA) return originalCommit.apply(this, args);
				attemptsA++;
				suspensionB = suspendDatabaseCommits([rootStoreB]);
				await suspensionB.waitForDrain();
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					await AuditedA.get(recordA, context);
					await AuditedA.put({ id: recordA, writer: 'logged-head-a', count: 10 }, context);
					await AuditedB.put({ id: recordB, writer: 'unlogged-link-b', count: 20 }, context);
				}),
				(err) => err.statusCode === 503 && err.code === 'DATABASE_CLOSING' && err.retryable === false
			);

			assert.strictEqual(attemptsA, 2, 'head A must have retried after logging on attempt 1');
			assert.deepStrictEqual(
				abortedA,
				[],
				'already-committed head handle A must not have abort() called when chained link B rejects'
			);
			assert.strictEqual(
				errorLines.filter(([msg]) => msg.includes('Aborted a transaction with a durable log entry')).length,
				0,
				'already-committed head handle A must not trigger false abandoned-log diagnostics when chained link B rejects'
			);
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordA).value.writer, 'logged-head-a');
			assert.strictEqual(
				AuditedB.primaryStore.getEntry(recordB).value.writer,
				'seed-b',
				'unlogged link B must not bypass suspendDatabaseCommits into a drained database'
			);
		});
	});

	describe('7. Pre-first-submit abort preservation and ERR_TRANSACTION_ABANDONED diagnostic', () => {
		it('still aborts before the first native commit when a lock lease expires prior to submission, or when an unlogged transaction is suspended', async function () {
			this.timeout(15000);
			const recordId = id('pre-submit-abort');
			await AuditedA.put({ id: recordId, writer: 'seed', count: 0 });

			const lease = MIN_LOCK_LEASE_MS;
			await assert.rejects(
				transaction(async () => {
					const rec = await AuditedA.lock(recordId, { lease });
					rec.set('writer', 'stale-before-submit');
					await rec.save();
					await delay(lease + 60);
				}),
				(err) => err.statusCode === 409
			);
			assert.strictEqual(
				AuditedA.primaryStore.getEntry(recordId).value.writer,
				'seed',
				'pre-submit expired lease must still abort with 409'
			);

			let suspension;
			try {
				await assert.rejects(
					transaction(async () => {
						await AuditedA.put({ id: recordId, writer: 'blocked-by-suspend', count: 99 });
						suspension = suspendDatabaseCommits([AuditedA.primaryStore.rootStore]);
					}),
					(err) => err.statusCode === 503 && err.code === 'DATABASE_CLOSING'
				);
			} finally {
				suspension?.release();
			}
			assert.strictEqual(
				AuditedA.primaryStore.getEntry(recordId).value.writer,
				'seed',
				'pre-submit suspended transaction must abort and leave the record unchanged'
			);
		});

		it('logs an error with commit identity if a native abort ever throws ERR_TRANSACTION_ABANDONED, including on post-log re-staging or pre-commit completion failure', async function () {
			const targetDb = AuditedA.primaryStore.store.db;
			const errorLines = [];
			const originalError = harperLogger.error;
			harperLogger.error = (...args) => errorLines.push(args);
			const originalAbort = Transaction.prototype.abort;
			const originalCommit = Transaction.prototype.commit;
			let interceptMode = 'none';
			let terminalAttempt = 0;
			let abortCalls = 0;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db === targetDb && interceptMode !== 'none' && this.hasStagedLog) {
					terminalAttempt++;
					if (terminalAttempt === 1) {
						if (interceptMode === 'restage-throw' || interceptMode === 'completion-reject') {
							return RETRY_NOW_VALUE;
						}
						throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY' });
					}
					if (interceptMode === 'io-error') {
						throw Object.assign(new Error('I/O error on retry'), { code: 'ERR_IO' });
					}
				}
				return originalCommit.apply(this, args);
			};
			Transaction.prototype.abort = function (...args) {
				if (this.store?.db !== targetDb) return originalAbort.apply(this, args);
				abortCalls++;
				originalAbort.apply(this, args);
				throw Object.assign(new Error('Transaction cannot be aborted after log write'), {
					code: 'ERR_TRANSACTION_ABANDONED',
				});
			};
			pendingRestores.push(() => {
				harperLogger.error = originalError;
				Transaction.prototype.abort = originalAbort;
				Transaction.prototype.commit = originalCommit;
			});

			const recordId = id('abandoned-diag');
			await AuditedA.put({ id: recordId, writer: 'seed', count: 0 });
			const lease = MIN_LOCK_LEASE_MS;
			await assert.rejects(
				transaction(async () => {
					const rec = await AuditedA.lock(recordId, { lease });
					rec.set('writer', 'diag-test');
					await rec.save();
					await delay(lease + 60);
				}),
				(err) => err.statusCode === 409
			);

			assert.ok(
				errorLines.some(([msg]) =>
					/Aborted a transaction with a durable log entry \(aborting a transaction whose record lock lapsed before submission\)/.test(
						msg
					)
				),
				'must log ERR_TRANSACTION_ABANDONED at error level on pre-submit abort diagnostic path'
			);

			errorLines.length = 0;
			abortCalls = 0;
			terminalAttempt = 0;
			interceptMode = 'io-error';
			await assert.rejects(
				AuditedA.put({ id: recordId, writer: 'terminal-io-failure', count: 99 }),
				(err) => err.code === 'ERR_IO'
			);
			assert.strictEqual(terminalAttempt, 2, 'must have reached attempt 2 after attempt 1 logged and conflicted');
			assert.strictEqual(abortCalls, 1, 'native abort must run exactly once (abortedByWrapper idempotence)');
			assert.ok(
				errorLines.some(([msg]) =>
					/Aborted a transaction with a durable log entry \(aborting transaction after failed commit\)/.test(msg)
				),
				'must log ERR_TRANSACTION_ABANDONED at error level when a post-log retry fails with a non-conflict terminal error'
			);

			errorLines.length = 0;
			abortCalls = 0;
			terminalAttempt = 0;
			interceptMode = 'restage-throw';
			const ctx1 = {};
			await assert.rejects(
				transaction(ctx1, async () => {
					await AuditedA.put({ id: recordId, writer: 'restage-throw', count: 100 }, ctx1);
					const writeOp = ctx1.transaction.writes[0];
					const origCommitOp = writeOp.commit;
					writeOp.commit = function (txnTime, existingEntry, retry) {
						if (retry) {
							throw new Error('deterministic handler throw during retry re-stage');
						}
						return origCommitOp.apply(this, arguments);
					};
				}),
				(err) => /deterministic handler throw during retry re-stage/.test(err.message)
			);
			assert.strictEqual(terminalAttempt, 1);
			assert.strictEqual(abortCalls, 1, 'detached retry handle must be aborted once when re-staging throws');
			assert.ok(
				errorLines.some(([msg]) =>
					/Aborted a transaction with a durable log entry \(aborting a retry transaction whose re-save threw\)/.test(
						msg
					)
				),
				'must log ERR_TRANSACTION_ABANDONED at error level when re-staging throws on a logged retry handle'
			);

			errorLines.length = 0;
			abortCalls = 0;
			terminalAttempt = 0;
			interceptMode = 'completion-reject';
			let completionRejectTxn;
			await assert.rejects(
				transaction(async (txn) => {
					completionRejectTxn = txn;
					const rec = await AuditedA.lock(recordId, { lease: 30_000 });
					rec.set('writer', 'completion-reject');
					rec.set('count', 101);
					await rec.save();
					const writeOp = txn.writes[0];
					const origCommitOp = writeOp.commit;
					writeOp.commit = function (txnTime, existingEntry, retry) {
						const res = origCommitOp.apply(this, arguments);
						if (retry) {
							return Promise.reject(new Error('pre-commit completion rejected on retry'));
						}
						return res;
					};
				}),
				(err) => /pre-commit completion rejected on retry/.test(err.message)
			);
			assert.strictEqual(terminalAttempt, 1);
			assert.strictEqual(
				abortCalls,
				1,
				'abortAfterCommitError must abort the detached retry handle once when completions reject'
			);
			assert.strictEqual(
				completionRejectTxn.writes.length,
				0,
				'abortAfterCommitError must clear writes staged on the aborted retry handle'
			);
			assert.ok(
				errorLines.some(([msg]) =>
					/Aborted a transaction with a durable log entry \(aborting a retry transaction after pre-commit failure\)/.test(
						msg
					)
				),
				'must log ERR_TRANSACTION_ABANDONED at error level when pre-commit completions reject on a logged retry'
			);
			const checkLock = await AuditedA.lock(recordId, { lease: MIN_LOCK_LEASE_MS, timeout: 400 });
			await checkLock.unlock();
		});

		it('does not retract hasLog when a retry round throws ERR_BUSY with hasLog: false, and protects in-flight logged commits from untargeted abort() or clearWrites()', async function () {
			this.timeout(20000);
			const prevMaxRetryDelay = setMaxRetryDelayMs(1);
			pendingRestores.push(() => setMaxRetryDelayMs(prevMaxRetryDelay));

			const recordA = id('haslog-sticky-a');
			const recordB = id('haslog-sticky-b');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: recordA, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: recordB, writer: 'seed', count: 0 }, baseNow - 10_000);

			const targetDb = AuditedA.primaryStore.store.db;
			const aborted = trackAborts(targetDb);
			const originalCommit = Transaction.prototype.commit;

			let trackedTxnId;
			let attemptCount = 0;
			let parkedInRetry = false;
			let releaseRetry;
			const retryGate = new Promise((resolve) => {
				releaseRetry = resolve;
			});
			pendingRestores.push(() => releaseRetry());

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordA, writer: 'interposer', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount === 2) {
					parkedInRetry = true;
					await retryGate;
				}
				if (attemptCount <= MAX_RETRIES + 2) {
					throw Object.assign(new Error('busy on retry round with default hasLog=false'), {
						code: 'ERR_BUSY',
						hasLog: false,
					});
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const holderA = await AuditedA.lock(recordA, { hold: true, lease: 15_000 });
			const sharedCtx = holderA.getContext();
			holderA.set('writer', 'sticky-logged-winner');
			holderA.set('count', 7);
			const saveAPromise = holderA.save();

			await waitFor(() => parkedInRetry, { message: 'holderA should be parked inside retry round 2' });
			const writeA = sharedCtx.transaction.writes.find((w) => w.key === recordA);
			assert.ok(writeA, 'in-flight logged write must remain in transaction.writes');
			const savedBlobsA = [{}];
			writeA.savedBlobs = savedBlobsA;

			let siblingTxnAborted = false;
			const siblingTxn = new Transaction(AuditedA.primaryStore.store);
			const origSiblingAbort = siblingTxn.abort.bind(siblingTxn);
			siblingTxn.abort = () => {
				siblingTxnAborted = true;
				return origSiblingAbort();
			};
			sharedCtx.transaction.transaction = siblingTxn;
			const savedBlobsB = [{}];
			const writeB = {
				key: recordB,
				store: AuditedA.primaryStore,
				stagedOn: siblingTxn,
				savedBlobs: savedBlobsB,
				commit() {},
			};
			sharedCtx.transaction.writes.push(writeB);

			sharedCtx.transaction.abort();
			assert.strictEqual(siblingTxnAborted, true, 'untargeted abort() must abort the unsubmitted sibling handle');
			assert.strictEqual(savedBlobsB.length, 0, 'untargeted abort() must clean up the unsubmitted sibling savedBlobs');
			assert.ok(!sharedCtx.transaction.writes.includes(writeB), 'untargeted abort() must clear the sibling write');
			assert.strictEqual(
				savedBlobsA.length,
				1,
				'untargeted abort() must not clean up the in-flight logged commit savedBlobs'
			);
			assert.ok(
				sharedCtx.transaction.writes.includes(writeA),
				'untargeted abort() must preserve the in-flight logged write'
			);
			assert.ok(!aborted.includes(trackedTxnId), 'untargeted abort() must not abort the durably logged native handle');

			releaseRetry();
			await saveAPromise;
			await holderA.unlock();

			assert.strictEqual(attemptCount, MAX_RETRIES + 3, 'must survive ERR_BUSY with hasLog: false past MAX_RETRIES');
			assert.strictEqual(savedBlobsA.length, 1, 'logged commit savedBlobs must never be cleaned up by abort()');
			assert.ok(!aborted.includes(trackedTxnId), 'logged native handle must never be aborted');
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordA).value.writer, 'sticky-logged-winner');
			assert.strictEqual(AuditedA.primaryStore.getEntry(recordA).value.count, 7);
		});

		it('preserves an audit:false sibling commit sleeping in ERR_BUSY backoff when another sibling fails on a shared ImmediateTransaction', async function () {
			this.timeout(15_000);
			const targetDb = UnauditedA.primaryStore.store.db;
			const recordA = id('imm-unlogged-backoff-a');
			const recordB = id('imm-unlogged-backoff-b');
			const recordC = id('imm-unlogged-backoff-c');
			await UnauditedA.put({ id: recordA, writer: 'seed-a', count: 0 });
			await UnauditedA.put({ id: recordB, writer: 'seed-b', count: 0 });
			await UnauditedA.put({ id: recordC, writer: 'seed-c', count: 0 });

			const origCommit = Transaction.prototype.commit;
			let holderATxn = null;
			let holderAAttempts = 0;
			let allowHolderACommit = false;

			pendingRestores.push(() => {
				Transaction.prototype.commit = origCommit;
			});

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return origCommit.apply(this, args);
				if (this === holderATxn) {
					holderAAttempts++;
					if (!allowHolderACommit) {
						if (holderAAttempts === 3) {
							this.retries = 19;
						}
						throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY' });
					}
					return origCommit.apply(this, args);
				}
				this.retries = MAX_RETRIES;
				throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY' });
			};

			const holderA = await UnauditedA.lock(recordA, { hold: true, lease: 15_000 });
			const sharedCtx = holderA.getContext();
			const holderB = await UnauditedA.lock(recordB, { hold: true, lease: 15_000 }, sharedCtx);
			const holderC = await UnauditedA.lock(recordC, { hold: true, lease: 15_000 }, sharedCtx);
			const lockHandleC = sharedCtx.transaction.recordLockFor(UnauditedA.primaryStore, recordC);

			const origSave = sharedCtx.transaction.save;
			let capturedFirstSave = false;
			sharedCtx.transaction.save = function (operation, transaction, isValidated, options) {
				if (operation.key === recordC) {
					lockHandleC.revokeLease();
				}
				const res = origSave.call(this, operation, transaction, isValidated, options);
				if (!capturedFirstSave && operation.key === recordA) {
					capturedFirstSave = true;
					holderATxn = operation.stagedOn;
				}
				return res;
			};

			holderA.set('writer', 'backoff-survivor');
			holderA.set('count', 11);
			const saveAPromise = holderA.save();

			await waitFor(() => holderAAttempts >= 3 && holderATxn?.commitInFlight === false, {
				message: 'holderA should be parked in async ERR_BUSY backoff with commitInFlight === false',
			});
			assert.strictEqual(Boolean(holderATxn.hasStagedLog), false, 'audit:false sibling must not be durably logged');
			const writeA = sharedCtx.transaction.writes.find((w) => w.key === recordA);
			assert.ok(writeA, 'holderA write must still be present in sharedCtx.transaction.writes during backoff');
			const savedBlobsA = [{}];
			writeA.savedBlobs = savedBlobsA;

			holderB.set('writer', 'doomed-busy-sibling');
			holderB.set('count', 22);
			await assert.rejects(
				async () => holderB.save(),
				/After 40 retries, unable to commit transaction/,
				'unlogged sibling holderB must fail after exhausting ERR_BUSY retries'
			);

			assert.strictEqual(
				holderATxn.commitInFlight,
				false,
				'holderA must still be in its between-attempt backoff window when holderB fails'
			);
			assert.strictEqual(
				savedBlobsA.length,
				1,
				'failing sibling commit must not clean up savedBlobs of an audit:false sibling sleeping in backoff'
			);
			assert.ok(
				sharedCtx.transaction.writes.includes(writeA),
				'failing sibling commit must not clear the write of an audit:false sibling sleeping in backoff'
			);

			holderC.set('writer', 'doomed-expired-lock-sibling');
			holderC.set('count', 33);
			await assert.rejects(
				async () => holderC.save(),
				/lease expired/i,
				'sibling failing inside save() before opening a native handle must reject'
			);

			assert.strictEqual(
				holderATxn.commitInFlight,
				false,
				'holderA must still be in its between-attempt backoff window when holderC fails pre-handle'
			);
			assert.strictEqual(
				savedBlobsA.length,
				1,
				'pre-handle save() failure must not clean up savedBlobs of an audit:false sibling sleeping in backoff'
			);
			assert.ok(
				sharedCtx.transaction.writes.includes(writeA),
				'pre-handle save() failure must not clear the write of an audit:false sibling sleeping in backoff'
			);

			allowHolderACommit = true;
			await saveAPromise;
			await holderA.unlock();
			await holderB.unlock();
			await holderC.unlock();

			assert.strictEqual(UnauditedA.primaryStore.getEntry(recordA).value.writer, 'backoff-survivor');
			assert.strictEqual(UnauditedA.primaryStore.getEntry(recordA).value.count, 11);
			assert.strictEqual(UnauditedA.primaryStore.getEntry(recordB).value.writer, 'seed-b');
			assert.strictEqual(UnauditedA.primaryStore.getEntry(recordC).value.writer, 'seed-c');
		});

		it('preserves an outer request transaction write across conflict retry when a late write runs an immediate commit on the closed context', async function () {
			this.timeout(20000);
			const targetDb = AuditedA.primaryStore.store.db;
			const unauditedTargetDb = UnauditedA.primaryStore.store.db;
			const outerId = id('req-closed-imm-outer');
			const lateOkId = id('req-closed-imm-late-ok');
			const lateFailId = id('req-closed-imm-late-fail');
			const baseNow = Date.now();
			await putWithTimestamp(AuditedA, { id: outerId, writer: 'seed', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(AuditedA, { id: lateOkId, writer: 'seed-late', count: 0 }, baseNow - 10_000);
			await putWithTimestamp(UnauditedA, { id: lateFailId, writer: 'seed-fail', count: 0 }, baseNow - 10_000);

			const origCommit = Transaction.prototype.commit;
			let outerTxnId;
			let outerAttempt = 0;
			let parkedAfterFirstConflict = false;
			let releaseOuterRetry;
			const outerRetryGate = new Promise((resolve) => {
				releaseOuterRetry = resolve;
			});
			pendingRestores.push(() => releaseOuterRetry());
			pendingRestores.push(() => {
				Transaction.prototype.commit = origCommit;
			});

			let failNextLateCommit = false;
			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb && this.store?.db !== unauditedTargetDb) return origCommit.apply(this, args);
				if (outerTxnId === undefined) {
					outerTxnId = this.id;
					outerAttempt++;
					await putWithTimestamp(AuditedA, { id: outerId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					const res = await origCommit.apply(this, args);
					parkedAfterFirstConflict = true;
					await outerRetryGate;
					return res;
				}
				if (this.id === outerTxnId) {
					outerAttempt++;
					return origCommit.apply(this, args);
				}
				if (failNextLateCommit) {
					this.retries = MAX_RETRIES;
					throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY' });
				}
				return origCommit.apply(this, args);
			};

			const ctx = {};
			let outerDbTxn;
			let lateOkHolder;
			let lateFailHolder;
			const outerPromise = transaction(ctx, async () => {
				outerDbTxn = ctx.transaction;
				lateOkHolder = await AuditedA.lock(lateOkId, { hold: true, lease: 15_000 }, ctx);
				lateFailHolder = await UnauditedA.lock(lateFailId, { hold: true, lease: 15_000 }, ctx);
				await AuditedA.get(outerId, ctx);
				await AuditedA.put({ id: outerId, writer: 'outer-winner', count: 2 }, ctx);
			});

			try {
				await waitFor(() => parkedAfterFirstConflict, {
					message: 'outer request transaction should be parked after attempt 1 conflict',
				});

				assert.strictEqual(ctx.transaction, outerDbTxn);
				assert.strictEqual(outerDbTxn.saveCommits, false);

				lateOkHolder.set('writer', 'late-immediate-ok');
				lateOkHolder.set('count', 9);
				await lateOkHolder.save();

				failNextLateCommit = true;
				lateFailHolder.set('writer', 'late-immediate-fail');
				lateFailHolder.set('count', 99);
				await assert.rejects(() => lateFailHolder.save(), /After 40 retries, unable to commit transaction/);
				failNextLateCommit = false;

				releaseOuterRetry();
				await outerPromise;

				assert.ok(outerAttempt >= 2, `expected outer transaction to retry at least once, got ${outerAttempt}`);
				assert.strictEqual(AuditedA.primaryStore.getEntry(outerId).value.writer, 'outer-winner');
				assert.strictEqual(AuditedA.primaryStore.getEntry(outerId).value.count, 2);
				assert.strictEqual(AuditedA.primaryStore.getEntry(lateOkId).value.writer, 'late-immediate-ok');
				assert.strictEqual(AuditedA.primaryStore.getEntry(lateOkId).value.count, 9);
				assert.strictEqual(UnauditedA.primaryStore.getEntry(lateFailId).value.writer, 'seed-fail');

				const outerAudits = auditEntriesFor(AuditedA, outerId).map((e) => e.getValue(AuditedA.primaryStore));
				assert.strictEqual(
					outerAudits.filter((a) => a?.writer === 'outer-winner').length,
					1,
					'outer write must have exactly one audit entry'
				);
				const lateOkAudits = auditEntriesFor(AuditedA, lateOkId).map((e) => e.getValue(AuditedA.primaryStore));
				assert.strictEqual(
					lateOkAudits.filter((a) => a?.writer === 'late-immediate-ok').length,
					1,
					'late immediate write must have exactly one audit entry'
				);
			} finally {
				await lateOkHolder?.unlock?.();
				await lateFailHolder?.unlock?.();
			}
		});

		it('does not sweep or drop a sibling holder unsaved deferred write when another holder ImmediateTransaction.save() retries past ERR_BUSY', async function () {
			this.timeout(20000);
			const key1 = id('deferred-save-1');
			const key2 = id('deferred-save-2');
			await AuditedA.put({ id: key1, writer: 'seed-1', count: 0 });
			await AuditedA.put({ id: key2, writer: 'seed-2', count: 0 });

			const targetDb = AuditedA.primaryStore.store.db;
			const origCommit = Transaction.prototype.commit;
			pendingRestores.push(() => {
				Transaction.prototype.commit = origCommit;
			});

			let holder1TxnId;
			let parkedInHolder1Conflict = false;
			let releaseHolder1Retry;
			const holder1RetryGate = new Promise((resolve) => {
				releaseHolder1Retry = resolve;
			});
			pendingRestores.push(() => releaseHolder1Retry());

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return origCommit.apply(this, args);
				if (holder1TxnId === undefined) {
					holder1TxnId = this.id;
					parkedInHolder1Conflict = true;
					await holder1RetryGate;
					throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY', hasLog: true });
				}
				return origCommit.apply(this, args);
			};

			const holder1 = await AuditedA.lock(key1, { hold: true, lease: 15_000 });
			const sharedCtx = holder1.getContext();
			const holder2 = await AuditedA.lock(key2, { hold: true, lease: 15_000 }, sharedCtx);
			try {
				assert.strictEqual(holder1.getContext().transaction, holder2.getContext().transaction);

				holder1.set('writer', 'holder1-saved');
				holder1.set('count', 1);
				const save1Promise = holder1.save();

				await waitFor(() => parkedInHolder1Conflict, {
					message: 'holder1 should be parked in its first commit conflict',
				});

				// Stage a deferred write on holder2 WITHOUT calling holder2.save() yet.
				holder2.set('writer', 'holder2-unsaved');
				holder2.set('count', 2);

				releaseHolder1Retry();
				await save1Promise;

				// holder1's retry must NOT have committed holder2's unsaved write, nor dropped it from this.writes.
				assert.strictEqual(AuditedA.primaryStore.getEntry(key1).value.writer, 'holder1-saved');
				assert.strictEqual(
					AuditedA.primaryStore.getEntry(key2).value.writer,
					'seed-2',
					'holder2 unsaved deferred write must not be committed by holder1 retry'
				);

				// Now calling holder2.save() must commit holder2's staged write cleanly.
				await holder2.save();
				assert.strictEqual(AuditedA.primaryStore.getEntry(key2).value.writer, 'holder2-unsaved');
				assert.strictEqual(AuditedA.primaryStore.getEntry(key2).value.count, 2);
			} finally {
				await holder1?.unlock?.();
				await holder2?.unlock?.();
			}
		});

		it('does not rotate an explicitly aborted scope back to OPEN when a logged mid-scope commit settles in the background', async function () {
			this.timeout(20000);
			const midKey = id('midscope-logged');
			const afterAbortKey = id('after-abort-key');
			await AuditedA.put({ id: midKey, writer: 'seed-mid', count: 0 });
			await AuditedA.put({ id: afterAbortKey, writer: 'seed-after', count: 0 });

			const targetDb = AuditedA.primaryStore.store.db;
			const origCommit = Transaction.prototype.commit;
			pendingRestores.push(() => {
				Transaction.prototype.commit = origCommit;
			});

			let midTxnId;
			let parkedInMidRetry = false;
			let releaseMidRetry;
			const midRetryGate = new Promise((resolve) => {
				releaseMidRetry = resolve;
			});
			pendingRestores.push(() => releaseMidRetry());

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return origCommit.apply(this, args);
				if (midTxnId === undefined) {
					midTxnId = this.id;
					parkedInMidRetry = true;
					await midRetryGate;
					throw Object.assign(new Error('Resource busy'), { code: 'ERR_BUSY', hasLog: true });
				}
				return origCommit.apply(this, args);
			};

			const ctx = {};
			await transaction(ctx, async () => {
				const dbTxn = ctx.transaction;
				await AuditedA.put({ id: midKey, writer: 'mid-committed', count: 1 }, ctx);
				// Trigger a mid-scope commit (not doneWriting) that parks after logging its entry.
				const midCommitPromise = Promise.resolve(dbTxn.commit({}));
				await waitFor(() => parkedInMidRetry, {
					message: 'mid-scope commit should park in its first conflict',
				});

				// Explicitly abort the outer scope while the logged mid-scope commit is still retrying.
				dbTxn.abort();
				assert.strictEqual(dbTxn.open, 0, 'explicit abort must leave the transaction CLOSED');

				// Let the logged mid-scope commit finish retrying and settle.
				releaseMidRetry();
				await midCommitPromise;

				assert.strictEqual(
					dbTxn.open,
					0,
					'settling the logged mid-scope commit must not rotate an explicitly aborted scope back to OPEN'
				);
				assert.strictEqual(AuditedA.primaryStore.getEntry(midKey).value.writer, 'mid-committed');
			});
		});
	});
});
