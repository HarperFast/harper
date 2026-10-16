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
	replicationConfirmation,
	setMaxOutstandingTxnDuration,
	suspendDatabaseCommits,
} = require('#src/resources/DatabaseTransaction');
const { MIN_LOCK_LEASE_MS } = require('#src/resources/recordLock');
const { publishOriginFloor } = require('#src/resources/originClosedFloor');
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
			this.timeout(60000);
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
					// Interpose a real write with a timestamp newer than seed but older than the holder's write
					// so attempt 1 experiences a genuine C++ Commit ERR_BUSY after flushing its log batch.
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
			this.timeout(30000);
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

			// Verify commitOutcome's rejection handler released the commit hold so a new holder can lock immediately.
			const nextHolder = await UnauditedA.lock(recordId, { lease: 5000, timeout: 300 });
			await nextHolder.unlock();
		});
	});

	describe('2. Coordinated RETRY_NOW retry cap after durable log write', () => {
		it('retries past MAX_RETRIES without aborting when attempt 1 hits a real RETRY_NOW conflict and subsequent attempts return RETRY_NOW', async function () {
			this.timeout(20000);
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
	});

	describe('3. Commit-budget deadline (elapsedPastCommitBudget) after durable log write', () => {
		it('does not throw TransactionCommitConflictTimeoutError when a logged transaction exceeds the conflict budget on both RETRY_NOW and ERR_BUSY paths', async function () {
			this.timeout(20000);
			await delay(1100);
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
					[lockHandle] = this.lockHolds ?? [];
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
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

			// Waiter B requests the lock on recordId after A's lease timer has already fired while A's
			// logged commit is parked in retry. B must stay queued until A's commit lands locally.
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

			// Meanwhile, saving on `otherId` on the same ImmediateTransaction must succeed and release its own lock hold.
			holderOther.set('count', 11);
			await holderOther.save();
			await holderOther.unlock();
			const checkOtherLock = await AuditedA.lock(otherId, { lease: MIN_LOCK_LEASE_MS, timeout: 300 });
			await checkOtherLock.unlock();

			// Now let A finish its retry commit.
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
			// Waiter B contends while A's replayTransaction is retrying after lease expiry.
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
				// Pre-age commitStartedAt so as soon as attempt 1 returns RETRY_NOW, noteOverdueLoggedCommit
				// sees the commit budget spent and releases `transaction.lockHolds`.
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

			// Even though txnA is still parked inside attempt 2, its lock hold was released at the budget boundary.
			const waiterB = await AuditedA.lock(recordId, { lease: 1000, timeout: 500 });
			await waiterB.unlock();

			holdSecondRetry();
			await txnAPromise;
		});

		it('releases the lock hold as soon as the store commit lands locally, before chained stores or replicationConfirmation settle', async function () {
			this.timeout(20000);
			// Case (a): Chained second store DbB parked on a barrier after DbA commits locally.
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
					if (holdRetainedDuringDbACommit === undefined) {
						dbANativeTxn = this;
						holdRetainedDuringDbACommit = (this.lockHolds?.size ?? 0) > 0;
					} else if (captureRepTxn && !repNativeTxn) {
						repNativeTxn = this;
						holdRetainedDuringRepCommit = (this.lockHolds?.size ?? 0) > 0;
					}
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
			// DbA has already committed locally, so its lock on recordA must be acquirable immediately while DbB is still parked.
			const lockDuringDbB = await AuditedA.lock(recordA, { lease: MIN_LOCK_LEASE_MS, timeout: 400 });
			await lockDuringDbB.unlock();
			releaseDbB();
			await chainPromise;

			// Case (b): replicationConfirmation parked on a barrier after local commit lands.
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

		it('delays cluster onRelease (revokeLease recall drain) until an in-flight logged retry settles or hits the commit budget', async function () {
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

			// Coordinator recalls the lease while the logged commit is in flight.
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
			// Lease expires and the hold-deadline timer (~150ms) flushes the deferred unlock while commit is still wedged.
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

			// 1. Start k1.save() first so it owns isCommitting = true, hits an ERR_BUSY conflict on attempt 1
			//    (setting sharedCtx.transaction.retries = 1), and parks inside attempt 2.
			holder1.set('writer', 'w1');
			holder1.set('count', 10);
			const k1SavePromise = holder1.save();
			await waitFor(() => k1Attempt2Parked, { message: 'k1 retry attempt 2 should be parked in flight' });
			assert.strictEqual(sharedCtx.transaction.isCommitting, true);
			assert.strictEqual(sharedCtx.transaction.retries, 1);

			// 2. While k1 owns isCommitting = true and retries === 1, start k2.save() so it takes the
			//    if (this.isCommitting) -> this.commit({ transaction: txn2 }) path and parks in flight.
			nextWriteStage = 'k2';
			holder2.set('writer', 'w2');
			holder2.set('count', 20);
			const k2SavePromise = holder2.save();
			await waitFor(() => k2InCommit, { message: 'k2 commit should be parked in flight' });

			// 3. Let k1 finish so isCommitting resets to false while retries === 1 and k2 remains in this.writes.
			releaseK1();
			await k1SavePromise;
			assert.strictEqual(sharedCtx.transaction.isCommitting, false);
			assert.ok(sharedCtx.transaction.retries > 0, 'shared ImmediateTransaction must have recorded a retry from k1');

			// 4. While k2 is still in flight in this.writes and retries > 0, run k3.save() through the top-level
			//    this.commit() loop on the same ImmediateTransaction.
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
	});

	describe('5. Chained multi-store transaction (head -> next) with a durably logged link', () => {
		it('carries a chained transaction to completion when DbA commits and DbB logs on attempt 1 then conflicts past MAX_RETRIES and budget', async function () {
			this.timeout(20000);
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
			const ageSamples = [];
			let enteredBackoffWindow = false;
			let releaseAttempt5;
			const attempt5Gate = new Promise((resolve) => {
				releaseAttempt5 = resolve;
			});
			pendingRestores.push(() => releaseAttempt5());

			Transaction.prototype.commit = async function (...args) {
				if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
				const snap = getOutstandingCommits();
				if (snap.oldestAgeMs !== undefined) ageSamples.push(snap.oldestAgeMs);
				if (trackedTxnId === undefined) {
					trackedTxnId = this.id;
					attemptCount++;
					await putWithTimestamp(AuditedA, { id: recordId, writer: 'interposer', count: 1 }, baseNow - 5_000);
					return originalCommit.apply(this, args);
				}
				if (this.id !== trackedTxnId) return originalCommit.apply(this, args);
				attemptCount++;
				if (attemptCount <= 5) {
					if (attemptCount === 4) {
						// After attempt 3 rejects, this.retries === 3 (> 2), so the retry enters the quadratic backoff window.
						enteredBackoffWindow = true;
					}
					if (attemptCount === 5) {
						await attempt5Gate;
					} else {
						await delay(15);
					}
					throw Object.assign(new Error('forced busy'), { code: 'ERR_BUSY' });
				}
				return originalCommit.apply(this, args);
			};
			pendingRestores.push(() => {
				Transaction.prototype.commit = originalCommit;
			});

			const startMs = performance.now();
			const holder = await AuditedA.lock(recordId, { hold: true, lease: 10_000 });
			holder.set('writer', 'drain-survivor');
			holder.set('count', 42);
			const savePromise = holder.save();

			await waitFor(() => enteredBackoffWindow, {
				message: 'logged retry should reach the ERR_BUSY backoff window (retries > 2)',
			});

			// Sample oldestAgeMs during the backoff window and verify an unrelated write on another database
			// is not load-shed with 503 when total elapsed exceeds maxOutstandingTxnDurationMs but the current
			// round's age is below it.
			const midBackoffSnap = getOutstandingCommits();
			assert.ok(midBackoffSnap.count >= 1, 'logged retry must remain tracked in outstandingCommits during backoff');
			if (midBackoffSnap.oldestAgeMs !== undefined) ageSamples.push(midBackoffSnap.oldestAgeMs);
			setMaxOutstandingTxnDuration(35);
			try {
				await AuditedB.put({ id: unrelatedId, writer: 'unrelated-ok', count: 1 });
			} finally {
				setMaxOutstandingTxnDuration(45_000);
			}

			// Now suspend commits on rootStore while the logged retry is in its backoff/attempt-5 window.
			const suspension = suspendDatabaseCommits([rootStore]);
			try {
				assert.ok(attemptCount < 6, 'retry loop must still be in flight when suspendDatabaseCommits is called');
				releaseAttempt5();
				await suspension.waitForDrain();
				assert.strictEqual(
					attemptCount,
					6,
					'suspendDatabaseCommits must wait for the logged retry loop to finish committing across backoff windows'
				);
				await savePromise;
			} finally {
				suspension.release();
			}
			const totalElapsedMs = performance.now() - startMs;
			await holder.unlock();

			assert.strictEqual(AuditedA.primaryStore.getEntry(recordId).value.writer, 'drain-survivor');
			const maxSampledAge = Math.max(...ageSamples);
			assert.ok(
				maxSampledAge < 80,
				`each per-attempt/per-backoff outstanding-commit age (${maxSampledAge}ms) must stay bounded by a single round, not accumulate total elapsed (${totalElapsedMs}ms)`
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

			// Also verify suspendDatabaseCommits rejects an unlogged commit at commit() before its first native submission.
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

		it('logs an error with commit identity if a native abort ever throws ERR_TRANSACTION_ABANDONED', async function () {
			const errorLines = [];
			const originalError = harperLogger.error;
			harperLogger.error = (...args) => errorLines.push(args);
			const originalAbort = Transaction.prototype.abort;
			Transaction.prototype.abort = function () {
				throw Object.assign(new Error('Transaction cannot be aborted after log write'), {
					code: 'ERR_TRANSACTION_ABANDONED',
				});
			};
			pendingRestores.push(() => {
				harperLogger.error = originalError;
				Transaction.prototype.abort = originalAbort;
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
				'must log ERR_TRANSACTION_ABANDONED at error level with the abort reason and commit identity'
			);
		});
	});
});
