require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setMaxOutstandingTxnDuration, setMaxRetryDelayMs } = require('#src/resources/DatabaseTransaction');
const { DERIVED_INDEX_ACCEPTED, DerivedIndexRuntime } = require('#src/resources/derivedIndexRuntime');
const { auditHistoryAbortMarked, establishAbortMarkedHistory } = require('#src/resources/auditStore');
const {
	abortMarkersEnabled,
	resolveAbortMarkersSetting,
	resolveWriteIntentsSetting,
	setAbortMarkersForTests,
	setWriteIntentsForTests,
} = require('#src/resources/transactionLogAbortMarkers');
const { Transaction, ConflictKind, constants } = require('@harperfast/rocksdb-js');
const { createBlob, saveBlob, holdBlobFile, setDeletionDelay } = require('#src/resources/blob');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Transaction-log abort markers (storage.rocks.transactionLogAbortMarkers)', function () {
	if (isLMDB) return;
	this.timeout(20000);
	let Audited, ChainHead, ChainLink;
	let nextId = 1;
	const id = (prefix) => `${prefix}-${nextId++}`;
	const restores = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Audited = table({
			table: 'AbortMarkersAudited',
			database: 'abortMarkersA',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
			audit: true,
		});
		ChainHead = table({
			table: 'AbortMarkersChainHead',
			database: 'abortMarkersHead',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }],
			audit: true,
		});
		ChainLink = table({
			table: 'AbortMarkersChainLink',
			database: 'abortMarkersLink',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }],
			audit: true,
		});
		const priorRetryDelay = setMaxRetryDelayMs(1);
		restores.push(() => setMaxRetryDelayMs(priorRetryDelay));
	});

	afterEach(() => {
		while (restores.length > 1) restores.pop()();
	});

	after(() => {
		while (restores.length) restores.pop()();
	});

	function auditEntries(targetTable, recordId) {
		return [...targetTable.auditStore.getRange({ start: 1 })].filter(
			(entry) => entry.tableId === targetTable.tableId && entry.recordId === recordId
		);
	}

	// competing writes are older than the transaction they conflict with, so they do not supersede it
	const OLD = Date.now() - 86400000;
	const seed = (targetTable, recordId) =>
		transaction({ timestamp: OLD }, (context) => targetTable.put({ id: recordId, writer: 'seed' }, context));

	// Each attempt of the first transaction committing to `targetTable` meets a write that committed after
	// its snapshot (a conflict RocksDB finds at commit) while `conflicts()` says so.
	function conflictAtCommit(targetTable, recordId, conflicts, pauseMs = 0) {
		const targetDb = targetTable.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		const attempts = [];
		let target;
		let passThrough = false;
		Transaction.prototype.commit = async function (...args) {
			if (passThrough || this.store?.db !== targetDb) return originalCommit.apply(this, args);
			target ??= this.id;
			if (this.id !== target) return originalCommit.apply(this, args);
			if (conflicts(attempts.length)) {
				if (pauseMs) await delay(pauseMs);
				passThrough = true;
				try {
					await transaction({ timestamp: OLD + attempts.length + 1 }, (other) =>
						targetTable.put({ id: recordId, writer: 'competitor', count: attempts.length }, other)
					);
				} finally {
					passThrough = false;
				}
			}
			const result = await originalCommit.apply(this, args);
			attempts.push({ kind: this.lastConflictKind(), logWritten: this.logWritten(), key: this.getTimestamp() });
			return result;
		};
		restores.push(() => (Transaction.prototype.commit = originalCommit));
		return attempts;
	}

	function writeAfterRead(targetTable, recordId, writer) {
		const context = {};
		return transaction(context, async () => {
			await targetTable.get(recordId, context);
			await targetTable.put({ id: recordId, writer }, context);
		});
	}

	// `holder` stages a write intent on `recordId`, which refuses `mine`'s first commit before its log write.
	async function refuseOnHeldIntent(targetTable, recordId, { holderCommits, mineContext = {}, patch = false }) {
		const targetDb = targetTable.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		const attempts = [];
		let holderId, holderVersion;
		let submitted = false;
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db !== targetDb || this.id === holderId) return originalCommit.apply(this, args);
			submitted = true;
			const result = await originalCommit.apply(this, args);
			attempts.push({ kind: this.lastConflictKind(), logWritten: this.logWritten(), key: this.getTimestamp() });
			return result;
		};
		restores.push(() => (Transaction.prototype.commit = originalCommit));
		let releaseHolder;
		const holderGate = new Promise((resolve) => (releaseHolder = resolve));
		const holderContext = {};
		const holder = transaction(holderContext, async () => {
			await targetTable.get(recordId, holderContext);
			await targetTable.put({ id: recordId, writer: 'holder' }, holderContext);
			const write = holderContext.transaction.writes.find((candidate) => candidate.key === recordId);
			await holderContext.transaction.save(write);
			holderId = holderContext.transaction.transaction.id;
			holderVersion = holderContext.transaction.timestamp;
			await holderGate;
			if (!holderCommits) throw new Error('holder gives up');
		});
		holder.catch(() => {});
		await waitFor(() => holderId !== undefined);
		const mine = transaction(mineContext, async () => {
			await targetTable.get(recordId, mineContext);
			if (patch) await targetTable.patch(recordId, { writer: 'mine' }, mineContext);
			else await targetTable.put({ id: recordId, writer: 'mine' }, mineContext);
		});
		await waitFor(() => submitted);
		await delay(20); // the native intent check runs on the commit thread after submission
		releaseHolder();
		await mine;
		if (holderCommits) await holder;
		else await assert.rejects(holder, /holder gives up/);
		assert.equal(attempts.length, 2);
		assert.deepEqual(
			{ kind: attempts[0].kind, logWritten: attempts[0].logWritten },
			{ kind: ConflictKind.intentBeforeLog, logWritten: false }
		);
		assert.equal(attempts[1].logWritten, true);
		return { attempts, holderVersion };
	}

	async function relogAfterRefusal(targetTable) {
		const recordId = id('relog');
		await seed(targetTable, recordId);
		const { attempts } = await refuseOnHeldIntent(targetTable, recordId, { holderCommits: false });
		assert.ok(attempts[1].key > attempts[0].key, 'the re-logged retry takes a fresh key');
		const entries = auditEntries(targetTable, recordId);
		assert.equal(entries.filter((entry) => entry.txnLogKey === attempts[0].key).length, 0);
		assert.equal(entries.filter((entry) => entry.txnLogKey === attempts[1].key).length, 1);
		assert.equal(targetTable.primaryStore.getEntry(recordId).version, attempts[1].key);
		assert.equal((await targetTable.get(recordId)).writer, 'mine');
	}

	it('turns markers on unless configured false, and write intents only when configured', function () {
		assert.equal(abortMarkersEnabled(), true, 'opening through databases.ts with the setting unset enables markers');
		for (const configured of [undefined, null, true, 'true', ''])
			assert.equal(resolveAbortMarkersSetting(configured), true, String(configured));
		for (const configured of [false, 'false', 'FALSE', 0, '0', 'off'])
			assert.equal(resolveAbortMarkersSetting(configured), false, String(configured));
		for (const configured of [undefined, null, '', false, 'false', 0, 'maybe'])
			assert.equal(resolveWriteIntentsSetting(configured), false, `write intents ${configured}`);
		for (const configured of [true, 'true', 1])
			assert.equal(resolveWriteIntentsSetting(configured), true, `write intents ${configured}`);
	});

	it('retries a logged attempt write-once and commits one log entry under its first key', async function () {
		const recordId = id('write-once');
		await seed(Audited, recordId);
		const attempts = conflictAtCommit(Audited, recordId, (attempt) => attempt < 3);
		await writeAfterRead(Audited, recordId, 'mine');
		assert.equal(attempts.length, 4);
		assert.ok(attempts.slice(0, 3).every((attempt) => attempt.kind === ConflictKind.atCommit));
		assert.ok(attempts.every((attempt) => attempt.logWritten && attempt.key === attempts[0].key));
		assert.equal((await Audited.get(recordId)).writer, 'mine');
		const mine = auditEntries(Audited, recordId).filter((entry) => entry.txnLogKey === attempts[0].key);
		assert.equal(mine.length, 1, 'the retry must not stage its log batch again');
	});

	it('gives up after 40 logged commit conflicts with the 500, leaving no readable log entry', async function () {
		const recordId = id('capped');
		await seed(Audited, recordId);
		const attempts = conflictAtCommit(Audited, recordId, () => true);
		await assert.rejects(writeAfterRead(Audited, recordId, 'capped'), (error) => {
			assert.match(error.message, /After 40 coordinated retries/);
			assert.equal(error.statusCode, 500);
			return true;
		});
		assert.equal(attempts.length, 41);
		assert.ok(attempts.every((attempt) => attempt.kind === ConflictKind.atCommit && attempt.logWritten));
		assert.deepEqual(
			auditEntries(Audited, recordId).filter((entry) => entry.txnLogKey === attempts[0].key),
			[],
			'a reader must skip the aborted batch'
		);
		assert.equal((await Audited.get(recordId)).writer, 'competitor');
	});

	it('says the outcome is unknown when the abort at the cap could not be marked', async function () {
		const recordId = id('unmarked');
		await seed(Audited, recordId);
		conflictAtCommit(Audited, recordId, () => true);
		const originalAbort = Transaction.prototype.abort;
		const targetDb = Audited.primaryStore.store.db;
		Transaction.prototype.abort = function (...args) {
			const result = originalAbort.apply(this, args);
			if (this.store?.db === targetDb && this.logWritten())
				throw Object.assign(new Error('could not mark'), { code: 'ERR_TRANSACTION_ABORT_UNRESOLVED' });
			return result;
		};
		restores.push(() => (Transaction.prototype.abort = originalAbort));
		await assert.rejects(writeAfterRead(Audited, recordId, 'unmarked'), (error) => {
			assert.match(error.message, /After 40 coordinated retries.*may still apply after a restart/);
			return true;
		});
	});

	it('abandons a logged commit still in conflict past the commit deadline with the 503', async function () {
		const recordId = id('overdue');
		await seed(Audited, recordId);
		const priorDuration = setMaxOutstandingTxnDuration(300);
		restores.push(() => setMaxOutstandingTxnDuration(priorDuration));
		const attempts = conflictAtCommit(Audited, recordId, () => true, 20);
		await assert.rejects(writeAfterRead(Audited, recordId, 'overdue'), (error) => {
			assert.equal(error.name, 'TransactionCommitConflictTimeoutError');
			assert.equal(error.retryable, true);
			return true;
		});
		assert.ok(attempts.length > 1 && attempts.length <= 40, `${attempts.length} attempts`);
		assert.ok(attempts.every((attempt) => attempt.logWritten));
		assert.deepEqual(
			auditEntries(Audited, recordId).filter((entry) => entry.txnLogKey === attempts[0].key),
			[]
		);
	});

	it('reports a deadline 503 as not retryable when its abort could not be marked', async function () {
		const recordId = id('overdue-unmarked');
		await seed(Audited, recordId);
		const priorDuration = setMaxOutstandingTxnDuration(300);
		restores.push(() => setMaxOutstandingTxnDuration(priorDuration));
		conflictAtCommit(Audited, recordId, () => true, 20);
		const originalAbort = Transaction.prototype.abort;
		const targetDb = Audited.primaryStore.store.db;
		Transaction.prototype.abort = function (...args) {
			const result = originalAbort.apply(this, args);
			if (this.store?.db === targetDb && this.logWritten())
				throw Object.assign(new Error('could not mark'), { code: 'ERR_TRANSACTION_ABORT_UNRESOLVED' });
			return result;
		};
		restores.push(() => (Transaction.prototype.abort = originalAbort));
		await assert.rejects(writeAfterRead(Audited, recordId, 'overdue-unmarked'), (error) => {
			assert.equal(error.name, 'TransactionCommitConflictTimeoutError');
			assert.equal(error.retryable, false);
			assert.match(error.message, /may still apply after a restart/);
			return true;
		});
	});

	it('bounds refusals before the log write by the commit deadline (503), never the retry cap', async function () {
		const recordId = id('refused');
		await seed(Audited, recordId);
		const priorDuration = setMaxOutstandingTxnDuration(600);
		restores.push(() => setMaxOutstandingTxnDuration(priorDuration));
		const targetDb = Audited.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		const keys = [];
		let target;
		// What rocksdb-js reports for a commit refused on an older write intent before its log write: it parks,
		// then resolves RETRY_NOW with nothing written.
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
			target ??= this.id;
			if (this.id !== target) return originalCommit.apply(this, args);
			keys.push(this.getTimestamp());
			this.lastConflictKind = () => ConflictKind.intentBeforeLog;
			this.logWritten = () => false;
			await delay(5);
			return constants.RETRY_NOW_VALUE;
		};
		restores.push(() => (Transaction.prototype.commit = originalCommit));
		await assert.rejects(writeAfterRead(Audited, recordId, 'refused'), (error) => {
			assert.equal(error.name, 'TransactionCommitConflictTimeoutError');
			assert.equal(error.statusCode, 503);
			return true;
		});
		assert.ok(keys.length > 41, `refusals must not count against the retry cap (${keys.length} attempts)`);
		assert.equal((await Audited.get(recordId)).writer, 'seed');
	});

	it('re-logs a retry refused before its log write on an older write intent, committing one entry', async function () {
		const priorIntents = setWriteIntentsForTests(true);
		restores.push(() => setWriteIntentsForTests(priorIntents ?? false));
		await relogAfterRefusal(Audited);
	});

	describe('a retry refused before its log write', function () {
		let Stamped;
		before(function () {
			Stamped = table({
				table: 'AbortMarkersStamped',
				database: 'abortMarkersStamped',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'writer' },
					{ name: 'created', assignCreatedTime: true },
					{ name: 'updated', assignUpdatedTime: true },
				],
				audit: true,
			});
		});
		beforeEach(function () {
			const priorIntents = setWriteIntentsForTests(true);
			restores.push(() => setWriteIntentsForTests(priorIntents ?? false));
		});

		it('stamps the created and updated times of a create at the version it commits under', async function () {
			const recordId = id('stamped-create');
			const { attempts } = await refuseOnHeldIntent(Stamped, recordId, { holderCommits: false });
			assert.ok(attempts[1].key > attempts[0].key, 'the re-logged retry takes a fresh key');
			const entry = Stamped.primaryStore.getEntry(recordId);
			assert.equal(entry.version, attempts[1].key);
			assert.deepEqual(
				{ writer: entry.value.writer, created: entry.value.created, updated: entry.value.updated },
				{ writer: 'mine', created: entry.version, updated: entry.version }
			);
		});

		for (const patch of [false, true]) {
			it(`keeps the created time of the record a concurrent creator committed first (${patch ? 'patch' : 'put'})`, async function () {
				const recordId = id('stamped-raced');
				const { attempts, holderVersion } = await refuseOnHeldIntent(Stamped, recordId, { holderCommits: true, patch });
				const entry = Stamped.primaryStore.getEntry(recordId);
				assert.equal(entry.version, attempts[1].key);
				assert.ok(entry.version > holderVersion, 'the retry commits after the holder');
				assert.deepEqual(
					{ writer: entry.value.writer, created: entry.value.created, updated: entry.value.updated },
					{ writer: 'mine', created: holderVersion, updated: entry.version }
				);
			});
		}

		it('keeps the created time of a concurrent creator under an explicit timestamp', async function () {
			const recordId = id('stamped-explicit');
			const timestamp = Date.now() + 60000;
			const { attempts, holderVersion } = await refuseOnHeldIntent(Stamped, recordId, {
				holderCommits: true,
				mineContext: { timestamp },
			});
			assert.equal(attempts[1].key, attempts[0].key);
			const entry = Stamped.primaryStore.getEntry(recordId);
			assert.equal(entry.version, timestamp);
			assert.deepEqual(
				{ writer: entry.value.writer, created: entry.value.created, updated: entry.value.updated },
				{ writer: 'mine', created: holderVersion, updated: timestamp }
			);
			const entries = auditEntries(Stamped, recordId).filter((entry) => entry.txnLogKey === attempts[1].key);
			assert.equal(entries.length, 1);
		});
	});

	it('turns write intents on from storage.rocks.transactionLogWriteIntents', async function () {
		const env = require('#src/utility/environment/environmentManager');
		const configured = env.get('storage_rocks_transactionLogWriteIntents');
		const priorIntents = setWriteIntentsForTests(undefined);
		env.setProperty('storage_rocks_transactionLogWriteIntents', true);
		restores.push(() => {
			env.setProperty('storage_rocks_transactionLogWriteIntents', configured);
			setWriteIntentsForTests(priorIntents ?? false);
		});
		const Configured = table({
			table: 'AbortMarkersIntents',
			database: 'abortMarkersIntents',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
			audit: true,
		});
		await relogAfterRefusal(Configured);
	});

	it('discards the blob of a re-logged retry that a newer write superseded', async function () {
		const priorIntents = setWriteIntentsForTests(true);
		restores.push(() => setWriteIntentsForTests(priorIntents ?? false));
		const Blobs = table({
			table: 'AbortMarkersBlobs',
			database: 'abortMarkersBlobs',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'blob', type: 'Blob' }],
			audit: true,
		});
		const recordId = id('blob-relog');
		await seed(Blobs, recordId);
		setDeletionDelay(0);
		restores.push(() => setDeletionDelay(undefined));
		let releaseHolder;
		const holderGate = new Promise((resolve) => (releaseHolder = resolve));
		const holderContext = { timestamp: Date.now() + 60000 };
		let holderStaged = false;
		const holder = transaction(holderContext, async () => {
			await Blobs.get(recordId, holderContext);
			await Blobs.put({ id: recordId, writer: 'newer' }, holderContext);
			await holderContext.transaction.save(holderContext.transaction.writes.find((write) => write.key === recordId));
			holderStaged = true;
			await holderGate;
		});
		await waitFor(() => holderStaged);
		const targetDb = Blobs.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		const kinds = [];
		let submitted = false;
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db === targetDb && this.id !== holderContext.transaction?.transaction?.id) submitted = true;
			const result = await originalCommit.apply(this, args);
			if (this.store?.db === targetDb) kinds.push(this.lastConflictKind());
			return result;
		};
		restores.push(() => (Transaction.prototype.commit = originalCommit));
		const blob = createBlob(Buffer.alloc(20000, 'r'), { saveBeforeCommit: true });
		let write, release;
		const context = { timestamp: OLD + 100 };
		const mine = transaction(context, async () => {
			await Blobs.get(recordId, context);
			await Blobs.put({ id: recordId, writer: 'older', blob }, context);
			write = context.transaction.writes.find((candidate) => candidate.key === recordId);
			await context.transaction.save(write);
			release = holdBlobFile(blob);
		});
		await waitFor(() => submitted);
		await delay(20); // the native intent check runs on the commit thread after submission
		releaseHolder();
		await holder;
		await mine;
		release?.();
		assert.ok(kinds.includes(ConflictKind.intentBeforeLog), 'an attempt is refused before its log write');
		assert.equal(write.skipped, true, 'the newer write supersedes the retried one');
		assert.equal((await Blobs.get(recordId)).writer, 'newer');
		assert.throws(() => saveBlob(blob), /Blob was discarded/, 'no committed entry references the blob');
	});

	it('keeps retrying a logged chain link once an earlier store committed', async function () {
		const headId = id('chain-head');
		const linkId = id('chain-link');
		await seed(ChainLink, linkId);
		const attempts = conflictAtCommit(ChainLink, linkId, (attempt) => attempt < 45);
		const context = {};
		await transaction(context, async () => {
			await ChainHead.put({ id: headId, writer: 'mine' }, context);
			await ChainLink.get(linkId, context);
			await ChainLink.put({ id: linkId, writer: 'mine' }, context);
		});
		assert.equal(attempts.length, 46, 'aborting the link would land the transaction in part');
		assert.equal((await ChainHead.get(headId)).writer, 'mine');
		assert.equal((await ChainLink.get(linkId)).writer, 'mine');
	});

	it('keeps retrying a chain link refused before its log write past the deadline once an earlier store committed', async function () {
		const headId = id('refused-head');
		const linkId = id('refused-link');
		await seed(ChainLink, linkId);
		const priorDuration = setMaxOutstandingTxnDuration(200);
		restores.push(() => setMaxOutstandingTxnDuration(priorDuration));
		const targetDb = ChainLink.primaryStore.store.db;
		const originalCommit = Transaction.prototype.commit;
		let refusals = 0;
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db !== targetDb || refusals >= 30) return originalCommit.apply(this, args);
			refusals++;
			this.lastConflictKind = () => ConflictKind.intentBeforeLog;
			this.logWritten = () => false;
			await delay(10);
			return constants.RETRY_NOW_VALUE;
		};
		restores.push(() => (Transaction.prototype.commit = originalCommit));
		const context = {};
		await transaction(context, async () => {
			await ChainHead.put({ id: headId, writer: 'mine' }, context);
			await ChainLink.put({ id: linkId, writer: 'mine' }, context);
		});
		assert.equal(refusals, 30, 'the link must outlast its 200ms deadline');
		assert.equal((await ChainHead.get(headId)).writer, 'mine');
		assert.equal((await ChainLink.get(linkId)).writer, 'mine');
	});

	for (const markers of [true, false]) {
		it(`${markers ? 'never delivers' : 'delivers'} an aborted logged transaction to the derived-index runtime with markers ${markers ? 'on' : 'off'}`, async function () {
			const priorMarkers = setAbortMarkersForTests(markers);
			restores.push(() => setAbortMarkersForTests(priorMarkers ?? true));
			const Indexed = table({
				table: 'AbortMarkersIndexed',
				database: `abortMarkersIndexed_${markers}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
				audit: true,
			});
			await Indexed.put({ id: 'anchor', writer: 'anchor' });
			const anchor = auditEntries(Indexed, 'anchor').at(-1).txnLogKey;
			const deliveries = [];
			const backend = {
				id: `aborted-${markers}`,
				cursor: { format: 1, logs: { local: anchor } },
				attach() {},
				flush() {},
				shutdown() {},
				getDurableCursor() {
					return this.cursor;
				},
				deliver(batch) {
					deliveries.push(batch);
					this.cursor = batch.through;
					return DERIVED_INDEX_ACCEPTED;
				},
				onStateChange() {
					return () => {};
				},
			};
			const runtime = new DerivedIndexRuntime(Indexed.auditStore, (_tableId, recordId) => {
				const entry = Indexed.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			});
			restores.push(() => runtime.stop());
			runtime.register({ backend, projections: new Map([[Indexed.tableId, (record) => ({ writer: record.writer })]]) });
			const mutations = (recordId) =>
				deliveries.flatMap((batch) =>
					batch.transactions.flatMap((txn) => txn.mutations.filter((mutation) => mutation.recordId === recordId))
				);
			const targetDb = Indexed.primaryStore.store.db;
			const originalCommit = Transaction.prototype.commit;
			restores.push(() => (Transaction.prototype.commit = originalCommit));
			let firstAttemptLogged;
			const context = {};
			const aborted = transaction(context, async () => {
				await Indexed.get('conflicted', context);
				await Indexed.put({ id: 'aborted', writer: 'never committed' }, context);
				await Indexed.put({ id: 'conflicted', writer: 'never committed' }, context);
				await transaction({}, (other) => Indexed.put({ id: 'conflicted', writer: 'competitor' }, other));
				let attempt = 0;
				// the first attempt logs and meets the competitor at commit; the retry fails terminally
				Transaction.prototype.commit = async function (...args) {
					if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
					if (++attempt === 1) {
						const result = await originalCommit.apply(this, args);
						firstAttemptLogged = this.logWritten() && this.lastConflictKind() === ConflictKind.atCommit;
						return result;
					}
					throw Object.assign(new Error('terminal storage error after the log write'), {
						code: 'ERR_IO',
						hasLog: true,
					});
				};
			});
			await assert.rejects(aborted, (error) => error.code === 'ERR_IO');
			Transaction.prototype.commit = originalCommit;
			assert.equal(firstAttemptLogged, true, 'the aborted transaction must have written its log batch');
			assert.equal(Indexed.primaryStore.getEntry('aborted'), undefined);
			await Indexed.put({ id: 'after', writer: 'after' });
			await waitFor(() => mutations('after').length > 0, { timeout: 5000 });
			assert.equal(mutations('aborted').length, markers ? 0 : 1);
		});
	}

	describe('history certification', function () {
		it('records which logs predate this process from their file counts, reading none (harper#3968)', async function () {
			const store = Audited.auditStore;
			const prior = store.abortMarkedHistory;
			restores.push(() => (store.abortMarkedHistory = prior));
			await Audited.put({ id: id('unread'), writer: 'logged' });
			const rootStore = store.rootStore;
			const useLog = rootStore.useLog;
			let queries = 0;
			rootStore.useLog = (name) => {
				const log = useLog.call(rootStore, name);
				return {
					getStats: () => log.getStats(),
					query: (options) => {
						queries++;
						return log.query(options);
					},
				};
			};
			try {
				establishAbortMarkedHistory(store);
			} finally {
				rootStore.useLog = useLog;
			}
			assert.equal(queries, 0, 'a query maps the file the boot purge then deletes');
			for (const name of rootStore.listLogs()) {
				const stats = rootStore.useLog(name).getStats();
				assert.equal(
					store.abortMarkedHistory.baseline.get(name),
					stats.fileCount > 0 ? stats.currentSequenceNumber : undefined,
					name
				);
			}
		});

		it('trusts a log only once the files that predate this process are purged', async function () {
			const store = Audited.auditStore;
			const prior = store.abortMarkedHistory;
			restores.push(() => (store.abortMarkedHistory = prior));
			assert.equal(auditHistoryAbortMarked(store, undefined), true, 'a log created in this process');
			await Audited.put({ id: id('history'), writer: 'logged' });
			establishAbortMarkedHistory(store); // as a restart would
			const local = store.rootStore.useLog('local').getStats();
			assert.equal(store.abortMarkedHistory.baseline.get('local'), local.currentSequenceNumber);
			assert.equal(auditHistoryAbortMarked(store, undefined), false, 'earlier files may hold unmarked orphans');
			const rootStore = store.rootStore;
			const useLog = rootStore.useLog;
			const baseline = store.abortMarkedHistory.baseline.get('local');
			rootStore.useLog = (name) => {
				const log = useLog.call(rootStore, name);
				if (name !== 'local') return log;
				return { getStats: () => ({ ...log.getStats(), fileCount: 1, oldestSequenceNumber: baseline + 1 }) };
			};
			try {
				assert.equal(auditHistoryAbortMarked(store, undefined), false, 'rechecked at most once a minute');
				store.abortMarkedHistory.recheckAt.clear();
				assert.equal(auditHistoryAbortMarked(store, undefined), true, 'once the files before this process are purged');
			} finally {
				rootStore.useLog = useLog;
			}
			const priorMarkers = setAbortMarkersForTests(false);
			try {
				establishAbortMarkedHistory(store);
				assert.equal(store.abortMarkedHistory, undefined);
				assert.equal(auditHistoryAbortMarked(store, undefined), false);
			} finally {
				setAbortMarkersForTests(priorMarkers ?? true);
			}
		});
	});
});
