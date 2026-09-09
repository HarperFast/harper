require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const {
	setTxnExpiration,
	DatabaseTransaction,
	TRANSACTION_STATE,
	COMMIT_PHASE_GRACE,
	shouldSpareCommitPhase,
} = require('#src/resources/DatabaseTransaction');
const { setTxnExpiration: setLMDBTxnExpiration, LMDBTransaction } = require('#src/resources/LMDBTransaction');
const { setReadTxnExpiration, checkReadTxnTimeouts } = require('#src/resources/RecordEncoder');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const { PassThrough } = require('node:stream');
const { RocksDatabase, registryStatus, constants } = require('@harperfast/rocksdb-js');
const { RETRY_NOW_VALUE } = constants;
const { createBlob } = require('#src/resources/blob');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const { waitFor } = require('../waitFor.js');
const { logger } = require('#src/utility/logging/logger');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

function databaseTxns(context) {
	const txns = [];
	for (let txn = context.transaction; txn; txn = txn.next) if (txn.db) txns.push(txn);
	return txns;
}

describe('Txn Expiration', () => {
	let SlowResource,
		performedDBInteractions = false;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		let BasicTable = table({
			table: 'BasicTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		SlowResource = class extends BasicTable {
			async get(query) {
				await delay(40);
				// at this point the read transaction should be expired, but we should still be able to do read/writes (in a
				// new transaction)
				await super.get(3);
				await super.put(3, { name: 'three' });
				performedDBInteractions = true;
				await delay(500);
				return super.get(query);
			}
		};
	});
	it('Slow txn will expire', async function () {
		await SlowResource.put(3, { name: 'three' });
		let trackedTxns =
			SlowResource.primaryStore instanceof RocksDatabase ? setTxnExpiration(20) : setLMDBTxnExpiration(20);
		await delay(50);
		// Any transactions from previous tests that were expired may still be completing their
		// async commit callbacks. Poll briefly until the set stabilizes so the baseline count
		// is accurate and doesn't include in-flight removals.
		let prevSize = -1;
		while (prevSize !== trackedTxns.size) {
			prevSize = trackedTxns.size;
			await delay(5);
		}
		let existingTxns = trackedTxns.size;
		let result = SlowResource.get(3);
		assert.equal(trackedTxns.size, existingTxns + 1);
		const txns = Array.from(trackedTxns);
		const lastTxn = txns[txns.length - 1];
		if (SlowResource.primaryStore instanceof RocksDatabase) {
			assert.equal(lastTxn.startedFrom.resourceName, 'SlowResource');
			assert.equal(lastTxn.startedFrom.method, 'get');
			assert.equal(lastTxn.timeout, 20);
		}
		// The 500ms tail inside get() keeps `result` pending, so observing expiry before `result`
		// settles proves the txn was expired mid-flight rather than removed by normal completion.
		let resultSettled = false;
		result.then(
			() => (resultSettled = true),
			() => (resultSettled = true)
		);
		await waitFor(() => performedDBInteractions, { message: 'read/write after expiry never completed' });
		// Check the specific txn we started was expired and removed. Counting against
		// existingTxns is unreliable: other tests' transactions can expire concurrently and
		// shift the count underneath us.
		const outcome = await waitFor(() => (!trackedTxns.has(lastTxn) ? 'expired' : resultSettled && 'settled'), {
			message: 'the slow transaction was neither expired nor completed',
		});
		assert.equal(
			outcome,
			'expired',
			'expected the slow transaction to have been expired and removed from trackedTxns before get() completed'
		);
		// Drain the slow get() so its 500ms tail and final read cannot run into the next
		// describe's expiration settings and freshly re-pathed test DB. On rocksdb the aborted
		// outer transaction must also surface to the caller.
		if (SlowResource.primaryStore instanceof RocksDatabase) {
			await assert.rejects(result, /aborted after exceeding the maximum open-transaction time/);
		} else {
			await result.catch(() => {});
		}
	});
	after(function () {
		// both expiration globals are process-wide, and the 20ms above went to whichever engine
		// is active, so restoring only one leaks it into every later test on the other pass
		setTxnExpiration(30000);
		setLMDBTxnExpiration(30000);
	});
});

describe('Write txn timeout', () => {
	let IndexedResource, OtherResource;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		IndexedResource = table({
			table: 'IndexedTxnTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 't', indexed: true },
			],
		});
		// A second table for the multi-store classification path. Note it shares `test` with
		// IndexedResource, and the `next` chain is per-DATABASE, so both tables resolve to the same
		// transaction link — a `next` link does not actually form here (a second `database:` in this
		// suite resolves to the same store), which is why the chain-walk test below builds its links
		// directly instead of going through the resource API.
		OtherResource = table({
			table: 'OtherTxnTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	function setExpiration(ms) {
		return IndexedResource.primaryStore instanceof RocksDatabase ? setTxnExpiration(ms) : setLMDBTxnExpiration(ms);
	}

	it('keeps a timeout budget across reads without shortening a larger global limit', async function () {
		try {
			setExpiration(30_000);
			const extendedContext = {};
			await transaction(extendedContext, async (txn) => {
				txn.timeoutBudget = 600_000;
				await IndexedResource.put(900, { t: 9000 }, extendedContext);
				const databaseTxn = databaseTxns(extendedContext)[0];
				assert.equal(databaseTxn.timeout, 600_000);
				await IndexedResource.get(901, extendedContext);
				assert.equal(databaseTxn.timeout, 600_000);
				await IndexedResource.get(902, extendedContext);
				assert.equal(databaseTxn.timeout, 600_000);
			});

			setExpiration(1_200_000);
			const largerGlobalContext = {};
			await transaction(largerGlobalContext, async (txn) => {
				txn.timeoutBudget = 600_000;
				await IndexedResource.get(903, largerGlobalContext);
				assert.equal(databaseTxns(largerGlobalContext)[0].timeout, 1_200_000);
			});
		} finally {
			setExpiration(30_000);
		}
	});

	it('does not abort a write transaction whose budget exceeds the global limit', async function () {
		const trackedTxns = setExpiration(20);
		let databaseTxn;
		try {
			const context = {};
			await transaction(context, async (txn) => {
				txn.timeoutBudget = 5_000;
				await IndexedResource.put(904, { t: 42 }, context);
				databaseTxn = databaseTxns(context)[0];
				trackedTxns.add(databaseTxn);
				await waitFor(() => databaseTxn.timeout < 5_000 || databaseTxn.timedOut, {
					message: 'the monitor should tick while the transaction remains within its budget',
				});
				assert.ok(!databaseTxn.timedOut, 'the transaction must remain active within its timeout budget');
				assert.ok(databaseTxn.timeout > 20, 'the global limit must not replace the larger timeout budget');
			});
			assert.equal((await IndexedResource.get(904))?.t, 42);
		} finally {
			if (databaseTxn) trackedTxns.delete(databaseTxn);
			setExpiration(30_000);
		}
	});

	// A transaction held open past the limit with uncommitted writes must be aborted and surface an error,
	// not silently force-committed. Force-committing a partial write set violates atomicity and can orphan
	// secondary-index entries that only a full index rebuild repairs (issue #1407).
	it('aborts a write-bearing txn open too long, surfacing an error and leaving no record or index entry', async function () {
		setExpiration(20);
		try {
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					await IndexedResource.put(101, { t: 9999 }, context);
					// hold the transaction open (with a pending write) long enough for the monitor to fire
					await delay(150);
				}),
				/open-transaction time/
			);
			// the partial write must have been rolled back: no record by primary key...
			assert.ok((await IndexedResource.get(101)) == null, 'timed-out write should not have been committed');
			// ...and no orphaned secondary-index entry for the indexed value
			const matches = [];
			for await (const entry of IndexedResource.search([{ attribute: 't', value: 9999 }])) {
				matches.push(entry);
			}
			assert.equal(matches.length, 0, 'timed-out write should not leave an orphaned index entry');
		} finally {
			setExpiration(30000);
		}
	});

	// A handler that keeps reading must not extend the limit once it is holding uncommitted writes:
	// those hold write intents other writers' commits park on (harper#2001). The read-only arm below
	// pins the other half — reads alone still re-arm. RocksDB-only: LMDBTransaction.getReadTxn()
	// re-arms unconditionally, and that engine has no verification-table park to wedge.
	it('does not let reads extend the limit for a txn holding uncommitted writes', async function () {
		if (isLMDB) this.skip();
		setExpiration(20);
		try {
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					await IndexedResource.put(401, { t: 4001 }, context);
					// Read repeatedly, well past the limit: pre-fix each read reset the clock and the
					// monitor never fired.
					for (let i = 0; i < 15; i++) {
						await IndexedResource.get(401, context);
						await delay(15);
					}
				}),
				/open-transaction time/
			);
			assert.ok((await IndexedResource.get(401)) == null, 'the aborted write must not be committed');
		} finally {
			setExpiration(30000);
		}
	});

	// The limit is an IDLE limit, so work in progress must not be killed: a transaction that keeps
	// writing stays alive indefinitely, and only goes over when it stops. This is the counterpart to
	// the arm above — reads don't extend a write-holding transaction, but writes do.
	it('lets continued writes extend the limit well past it', async function () {
		if (isLMDB) this.skip();
		setExpiration(20);
		try {
			const context = {};
			// Same total duration and cadence as the read-loop arm above, writing instead of reading.
			await transaction(context, async () => {
				for (let i = 0; i < 15; i++) {
					await IndexedResource.put(500 + i, { t: 5000 + i }, context);
					await delay(15);
				}
			});
			assert.ok(await IndexedResource.get(514), 'a continuously-writing transaction must commit normally');
		} finally {
			setExpiration(30000);
		}
	});

	// Direct-construction unit check of the chain walk: a head that holds NO writes of its own but
	// whose `next` link does must not re-arm on a read. Driving this through the resource API is not
	// reliable here — a second `database:` in this suite resolves to the same store, so no `next`
	// link forms — so the links are built directly, as sourceApplyConflictRetry.test.js does.
	it('does not re-arm the head on a read when the next chain holds the writes', function () {
		if (isLMDB) this.skip();
		const head = new DatabaseTransaction();
		const next = new DatabaseTransaction();
		head.next = next;
		head.open = TRANSACTION_STATE.OPEN;
		next.open = TRANSACTION_STATE.OPEN;
		head.writes = [];
		next.writes = [{ key: 'pending' }];
		head.transaction = {}; // stand-in native read txn so getReadTxn returns before allocating one
		assert.ok(head.hasPendingWrites(), "test setup: the head must see the next chain's write");

		head.timeout = 5;
		head.getReadTxn();
		assert.equal(head.timeout, 5, 'a read must not re-arm a head whose next chain holds writes');

		// Control: with the chain drained the same read re-arms normally.
		next.writes = [];
		head.timeout = 5;
		head.getReadTxn();
		assert.ok(head.timeout > 5, 'a read must still re-arm once no link holds writes');
	});

	// chainStillActive must tell "written recently" apart from "read recently": a next link with no
	// writes of its own re-arms its own `timeout` on every read (the fast path above), so using that
	// same field to decide the chain is write-active would let unrelated reads on the next link keep
	// a write-holding head immortal — the harper#2001 shape, shifted onto a second store.
	it('does not treat repeated reads on a write-free next link as write activity (chainStillActive)', async function () {
		if (isLMDB) this.skip();
		const trackedTxns = setExpiration(20);
		try {
			const head = new DatabaseTransaction();
			head.open = TRANSACTION_STATE.OPEN;
			head.writes = [{ key: 'pending' }]; // head itself holds the write
			head.transaction = { abort() {} }; // stand-in native handle, as the chain-walk test above uses
			head.readTxnsUsed = 1; // as a real getReadTxn() would leave behind
			trackedTxns.add(head); // ...and as a real getReadTxn() would track it
			head.timeout = 20;

			const next = new DatabaseTransaction();
			head.next = next;
			next.open = TRANSACTION_STATE.OPEN;
			next.transaction = { abort() {} };

			// Read next repeatedly, well past the limit: each read re-arms next.timeout via the fast
			// path, but must never touch writeTimeout — the signal chainStillActive actually consults.
			for (let i = 0; i < 8; i++) {
				next.getReadTxn();
				assert.ok(next.timeout > 0, "test setup: next's own idle timeout does re-arm on reads");
				await delay(15);
			}
			assert.ok(!next.writeTimeout, 'reads on a write-free link must never set writeTimeout');
			assert.ok(
				!trackedTxns.has(head),
				'the head must not be kept immortal by unrelated reads on a write-free next link'
			);
		} finally {
			setExpiration(30000);
		}
	});

	// The other half of the same fix: a next link that receives a write but is never itself read (a
	// blind write to a second database) is never added to trackedTxns, so nothing else decays it.
	// Pre-fix, chainStillActive treated its permanently-armed timeout as ongoing write activity and
	// kept the head immortal forever — a regression inside this PR's own target scenario.
	it('reaps an idle chain whose next link received a write but was never itself read (chainStillActive decay)', async function () {
		if (isLMDB) this.skip();
		const trackedTxns = setExpiration(20);
		try {
			const head = new DatabaseTransaction();
			head.open = TRANSACTION_STATE.OPEN;
			head.transaction = { abort() {} };
			head.readTxnsUsed = 1;
			trackedTxns.add(head);
			head.timeout = 20;

			const next = new DatabaseTransaction();
			head.next = next;
			next.open = TRANSACTION_STATE.OPEN;
			next.writes = [{ key: 'pending' }]; // as addWrite would leave staged
			next.writeTimeout = 20; // as addWrite would set — but next.getReadTxn() is never called

			assert.ok(!trackedTxns.has(next), 'test setup: next must not be tracked — it is never itself read');
			assert.ok(head.hasPendingWrites(), "test setup: head must see the next chain's write");

			await delay(150); // several monitor cycles with nothing touching either link
			assert.ok(
				!trackedTxns.has(head),
				'an idle chain whose only write lives on an untracked next link must eventually be reaped'
			);
		} finally {
			setExpiration(30000);
		}
	});

	it('still lets reads extend the limit for a read-only txn', async function () {
		if (isLMDB) this.skip();
		await IndexedResource.put(402, { t: 4002 });
		setExpiration(20);
		try {
			const context = {};
			// Same duration and read cadence as the arm above, without a write: the transaction holds
			// no write intents, so continued reads legitimately keep it alive.
			await transaction(context, async () => {
				for (let i = 0; i < 15; i++) {
					assert.ok(await IndexedResource.get(402, context));
					await delay(15);
				}
			});
		} finally {
			setExpiration(30000);
		}
	});

	// Multi-store path: a transaction that reads one database and writes another holds the write on its
	// `next` chain while the head (which only read) has no writes of its own. The head must still be treated
	// as write-bearing and aborted, or the monitor would force-commit the second database's write (#1407).
	it('aborts a multi-store txn whose write lives on the next chain, not force-committing it', async function () {
		await IndexedResource.put(301, { t: 1 });
		setExpiration(20);
		try {
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					await IndexedResource.get(301, context); // read database A -> head, no writes of its own
					await OtherResource.put(302, { name: 'should not persist' }, context); // write database B -> next
					await delay(150);
				}),
				/open-transaction time/
			);
			assert.ok((await OtherResource.get(302)) == null, 'multi-store write should not have been committed');
		} finally {
			setExpiration(30000);
		}
	});

	// Canonical-source applies (replication / external caching source) have no resubscribe/resume path, so
	// aborting one would drop the write while the resume cursor advances past it (harper-pro#348). They keep
	// the prior force-commit behavior instead of being poisoned.
	it('does not abort a source-apply txn open too long (preserves the write)', async function () {
		setExpiration(20);
		try {
			const context = { sourceApply: true };
			await transaction(context, async () => {
				await IndexedResource.put(401, { t: 7 }, context);
				await delay(150); // held past the limit; monitor must NOT poison a source-apply txn
			});
			assert.equal((await IndexedResource.get(401))?.t, 7, 'source-apply write should be preserved');
		} finally {
			setExpiration(30000);
		}
	});

	// harper#2471: the exemption above is why a canonical-source apply can hold verification-table write
	// intents indefinitely, and until now it did so with no log line at all — the branch that force-commits
	// it logs nothing. The exemption stays; the silence does not.
	it('names a source-apply txn that the monitor is not reaping, with its native id and origin', async function () {
		if (isLMDB) this.skip();
		const warnings = [];
		const originalWarn = logger.warn;
		const originalThreshold = env.get(CONFIG_PARAMS.STORAGE_LONGTRANSACTIONREPORTTHRESHOLD);
		logger.warn = (...args) => warnings.push(args);
		env.setProperty(CONFIG_PARAMS.STORAGE_LONGTRANSACTIONREPORTTHRESHOLD, '0.02');
		setExpiration(20);
		try {
			const context = { sourceApply: true };
			await transaction(context, async () => {
				await IndexedResource.put(402, { t: 8 }, context);
				await waitFor(
					() =>
						warnings.some(([message]) => String(message).includes('Harper transaction has held RocksDB transaction')),
					2000
				);
			});
			const reported = warnings.filter(([message]) =>
				String(message).includes('Harper transaction has held RocksDB transaction')
			);
			assert.ok(reported.length > 0, 'the un-reaped source-apply holder must be named');
			assert.match(reported[0][0], /state: [^,]*source-apply/);
			assert.match(reported[0][0], /IndexedTxnTable/);
			assert.match(reported[0][0], /transaction \d+/, 'the native id is the join key with the registry sweep');
			// Attribution must not have changed the exemption it is reporting on.
			assert.strictEqual((await IndexedResource.get(402))?.t, 8, 'source-apply write should still be preserved');
		} finally {
			logger.warn = originalWarn;
			env.setProperty(CONFIG_PARAMS.STORAGE_LONGTRANSACTIONREPORTTHRESHOLD, originalThreshold);
			setExpiration(30000);
		}
	});

	describe('abort releases the native handle', () => {
		// A write-first link (save() built the handle with no prior read) has no readTxnsUsed, so the
		// refcount loop never runs and the handle was stranded — permanently, since rocksdb-js's
		// registry keeps it alive and it holds a read snapshot (#2107).
		it('releases a write-first native handle on abort, with no read refcount to drive the loop', function () {
			if (isLMDB) this.skip();
			const txn = new DatabaseTransaction();
			txn.open = TRANSACTION_STATE.OPEN;
			let aborted = 0;
			txn.transaction = {
				abort() {
					aborted++;
				},
			};
			assert.strictEqual(txn.readTxnsUsed, undefined, 'test setup: a write-first handle has no read refcount');

			txn.abort();

			assert.strictEqual(aborted, 1, 'abort() must release the native handle');
			assert.strictEqual(txn.transaction, null, 'the released handle must not be reachable for reuse');
		});

		// Control: the refcount loop still owns the read-created release, and the fallback must not
		// abort the same handle a second time.
		it('releases a read-created native handle exactly once on abort', function () {
			if (isLMDB) this.skip();
			const txn = new DatabaseTransaction();
			txn.open = TRANSACTION_STATE.OPEN;
			let aborted = 0;
			txn.transaction = {
				abort() {
					aborted++;
				},
			};
			txn.readTxnsUsed = 1; // as getReadTxn() would leave behind

			txn.abort();

			assert.strictEqual(aborted, 1, 'the read refcount loop must release it, and the fallback must not re-abort');
			assert.strictEqual(txn.transaction, null);
		});

		// A failed commitSync leaves the handle open, and directCommitSync has already untracked it, so
		// nothing else can reach it.
		it('returns the native snapshot to baseline after a blind-write abort', function () {
			if (isLMDB) this.skip();
			const store = IndexedResource.primaryStore;
			const rootStore = store.rootStore;
			const liveTxns = () => registryStatus().reduce((total, db) => total + db.transactions, 0);
			const snapshots = () => rootStore.getDBIntProperty('rocksdb.num-snapshots');

			const baselineTxns = liveTxns();
			const baselineSnapshots = snapshots();

			const txn = new DatabaseTransaction();
			txn.db = store;
			txn.addWrite({
				key: 601,
				store,
				commit() {},
			});
			assert.strictEqual(txn.readTxnsUsed, 1, 'save() must attach the native handle with its base read reference');
			assert.strictEqual(liveTxns(), baselineTxns + 1, 'test setup: the native handle must be registered');
			assert.ok(snapshots() > baselineSnapshots, 'test setup: the blind-write lookup must pin a snapshot');

			txn.abort();

			assert.strictEqual(liveTxns(), baselineTxns, 'the native handle must be deregistered');
			assert.strictEqual(snapshots(), baselineSnapshots, 'the read snapshot must be released');
		});

		// RocksTransaction.abort() throws on an already committed/aborted handle. abort() must absorb
		// that: its callers (abortDueToTimeout, abortChainAfterRetries, commit()'s rejection wrapper)
		// have no handler, and a throw out of the first statement would skip every later cleanup step.
		it('completes its cleanup when the native abort throws', function () {
			if (isLMDB) this.skip();
			const txn = new DatabaseTransaction();
			txn.open = TRANSACTION_STATE.OPEN;
			txn.transaction = {
				abort() {
					throw Object.assign(new Error('Transaction has already been committed'), {
						code: 'ERR_ALREADY_COMMITTED',
					});
				},
			};
			txn.readTxnsUsed = 1; // release goes through the read-refcount loop, abort()'s first statement

			assert.doesNotThrow(() => txn.abort());

			assert.strictEqual(txn.transaction, null, 'the handle must be detached even though its abort threw');
			assert.strictEqual(txn.open, TRANSACTION_STATE.CLOSED, 'the cleanup after the release must still run');
		});

		it('releases the native handle when a direct commit throws', function () {
			if (isLMDB) this.skip();
			const txn = new DatabaseTransaction();
			let aborted = 0;
			txn.transaction = {
				commitSync() {
					throw new Error('commit failed');
				},
				abort() {
					aborted++;
				},
			};

			assert.throws(() => txn.directCommitSync(), /commit failed/);

			assert.strictEqual(aborted, 1, 'a failed direct commit must release the handle it orphaned');
			assert.strictEqual(txn.transaction, null);
		});
	});
});

// The open-transaction limit polices the APPLICATION holding a transaction open with an unfinished write
// set. Once commit() has been entered the write set is sealed and the caller is awaiting the commit, so
// time spent in the pre-commit phase (`before`/`beforeIntermediate` — in practice a blob's durable file
// write) is core's own I/O and must not be poisoned: a multi-tens-of-MB deploy payload legitimately takes
// longer than the limit, and aborting there both drops the write and unlinks the blob the write
// references, leaving the caller holding a blob whose file is gone (issue #2062).
describe('Commit-phase pre-commit work is not poisoned by the monitor (#2062)', () => {
	let BlobResource, SecondaryBlobResource;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		BlobResource = table({
			table: 'CommitPhaseBlobTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
		SecondaryBlobResource = table({
			table: 'CommitPhaseSecondaryBlobTable',
			database: 'commit-phase-secondary',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'value', type: 'String' },
			],
		});
	});

	function setExpiration(ms) {
		return BlobResource.primaryStore instanceof RocksDatabase ? setTxnExpiration(ms) : setLMDBTxnExpiration(ms);
	}

	async function forceMonitorTicks(txn, count) {
		for (let tick = 0; tick < count; tick++) {
			txn.timeout = 0;
			await waitFor(() => txn.timeout > 0 || txn.timedOut, {
				message: `the monitor should process commit-phase tick ${tick + 1}`,
			});
			assert.ok(!txn.timedOut, `the monitor must spare commit-phase tick ${tick + 1}`);
		}
	}

	it('marks and clears the commit phase across an LMDB transaction chain', function () {
		const head = new LMDBTransaction();
		const next = new LMDBTransaction();
		head.next = next;
		head.commitPhaseTicks = 4;
		next.commitPhaseTicks = 7;
		head.setCommitPhase(true);
		assert.ok(head.committing && next.committing, 'every linked database must be spared together');
		assert.equal(head.commitChainHead, head);
		assert.equal(next.commitChainHead, head);
		assert.equal(head.commitPhaseTicks, 0);
		assert.equal(next.commitPhaseTicks, 0);
		const checkedCommitPhaseChains = new Set();
		assert.ok(shouldSpareCommitPhase(head, checkedCommitPhaseChains));
		assert.ok(shouldSpareCommitPhase(next, checkedCommitPhaseChains));
		assert.equal(head.commitPhaseTicks, 1, 'one monitor pass must consume one grace tick per chain');
		assert.equal(next.commitPhaseTicks, 0, 'a link must not run its own grace counter');
		head.setCommitPhase(false);
		assert.ok(!head.committing && !next.committing, 'every linked database must leave the phase together');
		assert.equal(head.commitChainHead, undefined);
		assert.equal(next.commitChainHead, undefined);
	});

	it('propagates stalled-commit poison to a database linked afterward', async function () {
		const root = isLMDB ? new LMDBTransaction(BlobResource.primaryStore) : new DatabaseTransaction();
		root.db = BlobResource.primaryStore;
		root.postSubmitPoisoned = true;
		const context = { transaction: root };
		root.setContext(context);
		try {
			await assert.rejects(
				async () => SecondaryBlobResource.put({ id: 2070, value: 'must reject' }, context),
				/open-transaction time/
			);
			assert.equal(root.next.postSubmitPoisoned, true);
		} finally {
			root.abort();
		}
	});

	it('lets a commit whose blob save outruns the limit finish, keeping the record and its blob', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const trackedTxns = setExpiration(20);
		let parked;
		try {
			const context = {};
			const committing = transaction(context, async () => {
				await BlobResource.put({ id: 2062, blob }, context);
				parked = databaseTxns(context)[0];
			});
			committing.catch(() => {});
			slow.write(Buffer.alloc(16384, 'a'));
			await waitFor(() => parked?.committing, { message: 'the blob save should park the commit' });
			trackedTxns.add(parked);
			await forceMonitorTicks(parked, 2);
			slow.end(Buffer.alloc(16384, 'b'));
			await committing;
		} finally {
			if (parked) trackedTxns.delete(parked);
			if (!slow.writableEnded) slow.end();
			setExpiration(30000);
		}
		const stored = await BlobResource.get(2062);
		assert.ok(stored, 'the write must not be dropped while its blob save runs past the limit');
		assert.equal((await stored.blob.bytes()).length, 32768, 'the blob file must survive the commit');
	});

	it('keeps every multi-store link alive while the head waits on its blob save', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const context = {};
		const trackedTxns = setExpiration(20);
		let links;
		try {
			const committing = transaction(context, async (txn) => {
				txn.timeoutBudget = 200;
				await BlobResource.put({ id: 2067, blob }, context);
				await SecondaryBlobResource.put({ id: 2067, value: 'secondary' }, context);
				links = databaseTxns(context);
			});
			committing.catch(() => {});
			slow.write(Buffer.alloc(16384, 'h'));
			await waitFor(
				() => {
					return links?.length === 2 && links.every((txn) => txn.committing);
				},
				{ message: 'both database links should enter the same commit phase' }
			);
			for (const link of links) trackedTxns.add(link);
			await waitFor(() => links[0].commitPhaseTicks >= 2, {
				timeout: 5000,
				message: 'the monitor should consume the shared commit-phase grace repeatedly',
			});
			assert.ok(
				links.every((txn) => txn.commitChainHead === links[0]),
				'every link must share the chain head'
			);
			assert.ok(
				links.every((txn) => !txn.timedOut),
				'no link may be poisoned while its chain is committing'
			);
			assert.ok(
				links.every((txn) => txn.timeout > 20),
				'the commit-phase re-arm must preserve the transaction timeout budget'
			);
			slow.end(Buffer.alloc(16384, 'i'));
			await committing;
		} finally {
			for (const link of links ?? []) trackedTxns.delete(link);
			if (!slow.writableEnded) slow.end();
			setExpiration(30000);
		}
		assert.ok(await BlobResource.get(2067), 'the head database write must commit');
		assert.equal((await SecondaryBlobResource.get(2067))?.value, 'secondary', 'the linked database write must commit');
	});

	it('aborts a parked multi-store commit from the chain head when a later link exhausts the grace', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const context = {};
		const trackedTxns = setExpiration(20);
		let links;
		try {
			const committing = transaction(context, async (txn) => {
				txn.timeoutBudget = 200;
				await BlobResource.put({ id: 2068 }, context);
				await SecondaryBlobResource.put({ id: 2068, value: 'secondary' }, context);
				await BlobResource.put({ id: 2069, blob }, context);
				links = databaseTxns(context);
			});
			committing.catch(() => {});
			slow.write(Buffer.alloc(16384, 'j'));
			await waitFor(() => links?.length === 2 && links.every((txn) => txn.committing), {
				message: 'both database links should enter the same commit phase',
			});
			for (const link of links) trackedTxns.add(link);
			links[0].timeout = 200;
			links[1].timeout = 0;
			await waitFor(() => links.some((txn) => txn.timedOut), {
				timeout: 10000,
				message: 'the later link should exhaust the shared commit-phase grace',
			});
			assert.ok(
				links.every((txn) => txn.timedOut),
				'every link must be poisoned together'
			);
			slow.end(Buffer.alloc(16384, 'k'));
			await assert.rejects(committing, /open-transaction time/);
		} finally {
			for (const link of links ?? []) trackedTxns.delete(link);
			if (!slow.writableEnded) slow.end();
			setExpiration(30000);
		}
		assert.equal(await BlobResource.get(2068), undefined, 'the head database must not partially commit');
		assert.equal(await BlobResource.get(2069), undefined, 'the head blob write must not partially commit');
		assert.equal(await SecondaryBlobResource.get(2068), undefined, 'the linked database must not commit');
	});

	// Belt and braces for the same window: a transaction can still be poisoned while parked there via the
	// multi-store chain (abortDueToTimeout poisons every link). The in-flight commit must observe that and
	// throw, not resume and resolve as a success with an empty (cleared) write set — a phantom commit that
	// tells the caller its write landed and leaves it holding a blob whose file was just unlinked.
	it('a transaction poisoned while parked in its pre-commit phase throws instead of resolving as success', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const context = {};
		let parked;
		const committing = transaction(context, async () => {
			await BlobResource.put({ id: 2063, blob }, context);
			parked = databaseTxns(context)[0];
		});
		slow.write(Buffer.alloc(16384, 'c'));
		await waitFor(() => parked?.committing, {
			message: 'commit should park in its pre-commit phase while the blob save runs',
		});
		parked.abortDueToTimeout();
		slow.end();
		await assert.rejects(committing, /open-transaction time/);
		assert.equal(await BlobResource.get(2063), undefined, 'the poisoned write must not be committed');
	});

	it('reports a disconnect that aborts a commit parked in pre-commit work', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const context = {};
		let parked;
		const committing = transaction(context, async () => {
			await BlobResource.put({ id: 2071, blob }, context);
			parked = databaseTxns(context)[0];
		});
		slow.write(Buffer.alloc(16384, 'l'));
		await waitFor(() => parked?.committing, {
			message: 'commit should park in its pre-commit phase while the blob save runs',
		});
		parked.abortDueToDisconnect();
		slow.end();
		await assert.rejects(committing, /client disconnected/);
		assert.equal(await BlobResource.get(2071), undefined, 'the disconnected write must not be committed');
	});

	it('keeps disconnect cancellation armed through the wrapper final commit', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const ac = new AbortController();
		const context = { signal: ac.signal };
		let parked;
		const committing = transaction(context, async () => {
			await BlobResource.put({ id: 2072, blob }, context);
			parked = databaseTxns(context)[0];
		});
		slow.write(Buffer.alloc(16384, 'm'));
		await waitFor(() => parked?.committing, {
			message: 'the wrapper final commit should park in pre-commit work',
		});
		ac.abort();
		slow.end();
		await assert.rejects(committing, /client disconnected/);
		assert.equal(await BlobResource.get(2072), undefined, 'the disconnected final commit must not land');
	});

	// Same phantom-commit hazard reached by a plain abort rather than the monitor's poison.
	it('a transaction aborted while parked in its pre-commit phase throws instead of resolving as success', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const context = {};
		let parked;
		const committing = transaction(context, async () => {
			await BlobResource.put({ id: 2064, blob }, context);
			parked = databaseTxns(context)[0];
		});
		slow.write(Buffer.alloc(16384, 'd'));
		await waitFor(() => parked?.committing, {
			message: 'commit should park in its pre-commit phase while the blob save runs',
		});
		parked.abort();
		slow.end();
		await assert.rejects(committing, /aborted while its commit was waiting/);
		assert.equal(await BlobResource.get(2064), undefined, 'the aborted write must not be committed');
	});

	// A canonical-source apply must never be aborted (harper-pro#348) — but neither may it be
	// force-committed while its blob file is still being written, which would durably commit a record
	// pointing at an incomplete file on the replica. It is spared for as long as the write takes.
	it('never force-commits a source-apply parked in its pre-commit phase', async function () {
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const context = { sourceApply: true };
		const trackedTxns = setExpiration(20);
		let parked;
		try {
			const committing = transaction(context, async () => {
				await BlobResource.put({ id: 2066, blob }, context);
				parked = databaseTxns(context)[0];
			});
			slow.write(Buffer.alloc(16384, 'f'));
			await waitFor(() => parked?.committing, { message: 'the blob save should park the source apply' });
			trackedTxns.add(parked);
			await forceMonitorTicks(parked, COMMIT_PHASE_GRACE + 2);
			assert.equal(await BlobResource.get(2066), undefined, 'must not be committed while the blob is still writing');
			assert.ok(!parked.timedOut, 'a source apply must not be poisoned');
			slow.end(Buffer.alloc(16384, 'g'));
			await committing;
		} finally {
			if (parked) trackedTxns.delete(parked);
			setExpiration(30000);
		}
		const stored = await BlobResource.get(2066);
		assert.equal((await stored.blob.bytes()).length, 32768, 'the apply commits once its blob has landed');
	});

	// The exemption is a grace, not an exemption forever: the transaction still pins a read snapshot, so
	// a pre-commit source that stalls instead of finishing must eventually be poisoned like any other
	// over-time transaction.
	it('bounds the grace so a pre-commit source that never finishes is still aborted', async function () {
		const stuck = new PassThrough(); // deliberately never ended
		const blob = createBlob(stuck);
		const context = {};
		const trackedTxns = setExpiration(20);
		let parked;
		const committing = transaction(context, async () => {
			await BlobResource.put({ id: 2065, blob }, context);
			parked = databaseTxns(context)[0];
		});
		committing.catch(() => {}); // settles only when the stuck source is destroyed below
		stuck.write(Buffer.alloc(16384, 'e'));
		try {
			await waitFor(() => parked?.committing, { message: 'commit should park in its pre-commit phase' });
			trackedTxns.add(parked);
			parked.timeout = 0;
			await waitFor(() => parked.timedOut, {
				timeout: 10000,
				message: 'a commit phase that never finishes should be aborted once its grace runs out',
			});
		} finally {
			if (parked) trackedTxns.delete(parked);
			setExpiration(30000);
			stuck.destroy();
		}
		assert.ok(
			parked.commitPhaseTicks > COMMIT_PHASE_GRACE,
			`should have been spared ${COMMIT_PHASE_GRACE} ticks first, got ${parked.commitPhaseTicks}`
		);
	});
});

// harper#2001: a client that disconnects mid-handler must not leave its request-scoped transaction's
// staged writes / native write intents held until the handler's own promise happens to settle (which,
// for a client that is never coming back, may be effectively never) or the long-transaction monitor's
// next cycle catches it. `resources/transaction.ts` listens for `context.signal`'s 'abort' event (the
// same signal a Request/UwsRequest populates on client disconnect) and, while the callback is still
// running, aborts the transaction immediately instead.
describe('Disconnect abort', () => {
	let DisconnectResource, DisconnectBlobResource;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		DisconnectResource = table({
			table: 'DisconnectTxnTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		DisconnectBlobResource = table({
			table: 'DisconnectBlobTxnTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});

	// On RocksDB the table's first access claims `context.transaction` itself (txnForContext in
	// Table.ts). On LMDB, that same first access always chains a fresh `LMDBTransaction` onto
	// `context.transaction.next` (LMDB never claims the head in place) — so the transaction actually
	// holding the write, and its native handle, can live one link into the chain. Walk the whole chain
	// so the assertion holds under either engine.
	function assertChainReleased(head) {
		let found = false;
		for (let txn = head; txn; txn = txn.next) {
			assert.equal(txn.open, TRANSACTION_STATE.CLOSED, 'every link in the chain should be closed');
			assert.ok(!txn.readTxnsUsed, 'no outstanding read references (write intents) should remain');
			assert.ok(!txn.transaction, 'native RocksDB transaction handle should be released');
			assert.ok(!txn.readTxn, 'native LMDB read transaction handle should be released');
			found = true;
		}
		assert.ok(found, 'expected at least the head transaction');
	}

	function getReadTransaction(head) {
		for (let txn = head; txn; txn = txn.next) {
			const nativeTransaction = txn.transaction ?? txn.readTxn;
			if (nativeTransaction) return { txn, nativeTransaction };
		}
	}

	function setDisconnectExpiration(ms) {
		return DisconnectResource.primaryStore instanceof RocksDatabase ? setTxnExpiration(ms) : setLMDBTxnExpiration(ms);
	}

	it('aborts a write-bearing txn when the client disconnects mid-handler, releasing the native transaction', async function () {
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.put(501, { name: 'orphaned' }, context);
				ac.abort(); // simulate the client disconnecting mid-handler, after a write is staged
				await delay(20); // give the handler a chance to keep running past the disconnect
				// Check from INSIDE the still-running handler, not after transaction() settles: the point
				// of this fix is releasing the intent promptly, not eventually (which onError's fallback
				// abort() would also achieve, and wouldn't distinguish this from the pre-fix behavior).
				assertChainReleased(context.transaction);
			}),
			/disconnected/
		);
		assert.ok((await DisconnectResource.get(501)) == null, 'the orphaned write must not have been committed');
	});

	it('lets an open read iterator finish without retaining the disconnected write intents', async function () {
		await DisconnectResource.put(507, { name: 'iterator seed' }, {});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		let iterator;
		await assert.rejects(
			transaction(context, async () => {
				const results = await DisconnectResource.search({}, context);
				iterator = results[Symbol.asyncIterator]();
				await iterator.next();
				await DisconnectResource.put(508, { name: 'must be discarded' }, context);
				const { txn: iteratorTransaction, nativeTransaction } = getReadTransaction(context.transaction);
				let abandonCalls = 0;
				if (!isLMDB) {
					const originalAbandonWrites = nativeTransaction.abandonWrites.bind(nativeTransaction);
					nativeTransaction.abandonWrites = () => {
						abandonCalls++;
						return originalAbandonWrites();
					};
				}
				ac.abort();
				assert.equal(iteratorTransaction.disconnected, true, 'disconnect must still poison the staged write');
				assert.equal(
					iteratorTransaction.transaction ?? iteratorTransaction.readTxn,
					nativeTransaction,
					'the open iterator must retain its native transaction until it finishes'
				);
				if (!isLMDB) {
					let competingWriteSettled = false;
					const competingWrite = transaction({}, () => DisconnectResource.put(508, { name: 'competing write' })).then(
						() => {
							competingWriteSettled = true;
						}
					);
					try {
						await waitFor(() => competingWriteSettled, {
							message: 'a competing write should not wait for the retained read iterator',
						});
					} finally {
						while (!(await iterator.next()).done);
						await competingWrite;
					}
				} else {
					while (!(await iterator.next()).done);
				}
				if (!isLMDB) assert.equal(abandonCalls, 1, 'disconnect must release the retained handle write intents');
				assert.equal(
					iteratorTransaction.transaction ?? iteratorTransaction.readTxn,
					null,
					'finishing the iterator releases the native transaction'
				);
			}),
			/disconnected/
		);
		const record = await DisconnectResource.get(508);
		if (isLMDB) assert.ok(record == null, 'the disconnected write must not commit');
		else assert.equal(record?.name, 'competing write', 'only the competing write should commit');
	});

	it('closes a write-first iterator abandoned by a poisoned callback', async function () {
		await DisconnectResource.put(509, { name: 'write-first iterator seed' }, {});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		let iterator;
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.put(510, { name: 'must be discarded' }, context);
				const results = await DisconnectResource.search({}, context);
				iterator = results[Symbol.asyncIterator]();
				await iterator.next();
				ac.abort();
				await DisconnectResource.put(511, { name: 'must reject' }, context);
			}),
			/disconnected/
		);
		// The callback rejected, so nothing was returned and no live response can own this iterator:
		// the transaction closes the iterators it owns rather than pinning the read snapshot on a
		// doneReadTxn() nobody is left to call.
		assert.equal(
			getReadTransaction(context.transaction),
			undefined,
			'an abandoned iterator must be closed when the poisoned callback settles'
		);
		// Idempotent: draining the already-closed iterator must not double-release, and must not fault
		// on the released handle.
		while (!(await iterator.next()).done);
		assert.equal(
			getReadTransaction(context.transaction),
			undefined,
			'draining an already-closed iterator must not resurrect a native transaction'
		);
		assert.ok((await DisconnectResource.get(510)) == null, 'the disconnected write must not commit');
	});

	it('retains a poisoned iterator immediately, then lets the monitor reclaim an undrained one', async function () {
		setDisconnectExpiration(50);
		try {
			await DisconnectResource.put(512, { name: 'monitor iterator seed' }, {});
			const ac = new AbortController();
			const context = { signal: ac.signal };
			await assert.rejects(
				transaction(context, async () => {
					const results = await DisconnectResource.search({}, context);
					const iterator = results[Symbol.asyncIterator]();
					await iterator.next();
					await DisconnectResource.put(513, { name: 'must be discarded' }, context);
					const { txn: iteratorTransaction, nativeTransaction } = getReadTransaction(context.transaction);
					ac.abort();
					// The poison itself never frees a handle an iterator still owns.
					assert.equal(
						iteratorTransaction.transaction ?? iteratorTransaction.readTxn,
						nativeTransaction,
						'poisoning must not release a native transaction an iterator still owns'
					);
					// But the retention is bounded: this handler never returns the iterator to anyone, so
					// past the open-transaction limit the monitor closes it rather than pinning the read
					// snapshot (and, on RocksDB, holding off compaction) for the life of the process.
					await waitFor(() => (iteratorTransaction.transaction ?? iteratorTransaction.readTxn) == null, {
						message: 'the monitor must reclaim an undrained poisoned iterator past the open-transaction limit',
					});
					while (!(await iterator.next()).done);
				}),
				/disconnected/
			);
		} finally {
			setDisconnectExpiration(30000);
		}
	});

	it('closes a returned iterator when the disconnected transaction cannot commit', async function () {
		await DisconnectResource.put(514, { name: 'returned iterator seed' }, {});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				const results = await DisconnectResource.search({}, context);
				await DisconnectResource.put(515, { name: 'must be discarded' }, context);
				ac.abort();
				return results;
			}),
			/disconnected/
		);
		assert.equal(
			getReadTransaction(context.transaction),
			undefined,
			'the returned iterator must be closed when commit rejects'
		);
		assert.ok((await DisconnectResource.get(515)) == null, 'the disconnected write must not commit');
	});

	it('preserves the commit error when returned result cleanup is unusable', async function () {
		for (const [id, onDone] of [
			[516, true],
			[
				517,
				() => {
					throw new Error('cleanup failed');
				},
			],
		]) {
			const ac = new AbortController();
			const context = { signal: ac.signal };
			await assert.rejects(
				transaction(context, async () => {
					await DisconnectResource.put(id, { name: 'must be discarded' }, context);
					ac.abort();
					return { onDone };
				}),
				/disconnected/
			);
			assertChainReleased(context.transaction);
		}
	});

	it('does not double-consume an LMDB iterator reference across explicit and wrapper commits', async function () {
		if (!isLMDB) this.skip();
		await DisconnectResource.put(518, { name: 'LMDB iterator seed' }, {});
		const context = {};
		let iterator;
		let iteratorTransaction;
		try {
			await transaction(context, async () => {
				const results = await DisconnectResource.search({}, context);
				iterator = results[Symbol.asyncIterator]();
				await iterator.next();
				({ txn: iteratorTransaction } = getReadTransaction(context.transaction));
				await context.transaction.commit();
				assert.ok(iteratorTransaction.readTxn, 'the explicit commit must retain the iterator read transaction');
			});
			assert.ok(iteratorTransaction.readTxn, 'the wrapper commit must not consume the iterator reference');
		} finally {
			if (iteratorTransaction?.readTxn) await iterator?.return?.();
		}
		assert.equal(iteratorTransaction.readTxn, null, 'closing the iterator must release its read transaction');
	});

	// This deliberately stays in the head database; the distinct-database late-link propagation case is
	// covered by "propagates stalled-commit poison to a database linked afterward" above.
	it('rejects a write to a database first touched after the disconnect', async function () {
		const OtherDisconnectResource = table({
			table: 'OtherDisconnectTxnTable2',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.put(510, { name: 'first table' }, context); // claims context.transaction
				ac.abort();
				await delay(10);
				await OtherDisconnectResource.put(511, { name: 'second table, too late' }, context);
			}),
			/disconnected|no longer open/
		);
		assert.ok((await OtherDisconnectResource.get(511)) == null, 'the second table write must not commit either');
	});

	it('rejects a further write staged after the disconnect poisons an already write-bearing txn', async function () {
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.put(502, { name: 'arms the poison' }, context); // stages a write first
				ac.abort(); // now hasPendingWrites() is true, so this actually poisons
				await delay(10);
				await DisconnectResource.put(504, { name: 'too late' }, context); // must throw, not commit
			}),
			// Both engines' addWrite consults `disconnected`; LMDB can also reach its own pre-existing
			// `open === CLOSED` rejection first, depending on which link the write lands on.
			/disconnected|no longer open/
		);
		assert.ok((await DisconnectResource.get(502)) == null, 'the poisoned first write must not commit either');
		assert.ok((await DisconnectResource.get(504)) == null, 'a write staged after disconnect must not commit');
	});

	it('rejects a deferred save that resumes after its holder was disconnected', async function () {
		if (isLMDB) this.skip(); // LMDB applies deferred instance writes from its holder's own commit path
		await DisconnectResource.put(509, { name: 'before disconnect' }, {});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				const row = await DisconnectResource.getResource({ id: 509 }, context, {});
				row.update({ name: 'must not land' }, false);
				ac.abort();
				await assert.rejects(async () => row.save(), /disconnected/);
			}),
			/disconnected/
		);
		assert.equal((await DisconnectResource.get(509))?.name, 'before disconnect');
	});

	// The disconnect abort is gated exactly like the long-transaction monitor gates abortDueToTimeout
	// (DatabaseTransaction.ts's startMonitoringTxns): only a transaction with a pending write is poisoned.
	// A read-only transaction's native handle can have live iterators streaming through it (a large
	// search()/export) — aborting mid-stream would free that handle out from under them rather than just
	// closing it early, so a disconnect with nothing staged yet must leave it alone entirely.
	it('does not poison a read-only transaction on disconnect (no pending writes to protect)', async function () {
		await DisconnectResource.put(505, { name: 'readable' }, {}); // seed, own (unrelated) txn
		const ac = new AbortController();
		const context = { signal: ac.signal };
		let sawDuringRead;
		const result = await transaction(context, async () => {
			await DisconnectResource.get(505, context); // pure read, no writes staged
			ac.abort();
			await delay(10);
			sawDuringRead = { open: context.transaction.open, disconnected: context.transaction.disconnected };
			return DisconnectResource.get(505, context);
		});
		assert.equal(sawDuringRead.disconnected, undefined, 'a read-only transaction must not be poisoned on disconnect');
		assert.equal(
			sawDuringRead.open,
			TRANSACTION_STATE.OPEN,
			'a read-only transaction stays open through the disconnect'
		);
		assert.equal(result?.name, 'readable', 'the read must still complete normally');
	});

	// The abort event fires exactly once, so "read-only right now" cannot be the whole decision: the
	// scope keeps running, and the write that arrives afterwards is what the gate exists to cut off.
	it('rejects a write staged after a disconnect that landed while the transaction was read-only', async function () {
		await DisconnectResource.put(520, { name: 'readable' }, {}); // seed, own (unrelated) txn
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.get(520, context); // read-only when the client disconnects
				ac.abort();
				await delay(10);
				assert.equal(context.transaction.disconnected, undefined, 'nothing was staged, so nothing is poisoned yet');
				await DisconnectResource.put(521, { name: 'must not commit' }, context);
			}),
			/disconnected/
		);
		assert.ok((await DisconnectResource.get(521)) == null, 'a write first staged after the disconnect must not commit');
	});

	it('rejects a database first touched after a read-only disconnect', async function () {
		const LateDisconnectResource = table({
			table: 'LateDisconnectTxnTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await DisconnectResource.put(522, { name: 'readable' }, {});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.get(522, context); // claims context.transaction, stages nothing
				ac.abort();
				await delay(10);
				// The chain link for this database does not exist yet, so it inherits the pending disconnect
				// from the chain root rather than carrying its own copy.
				await LateDisconnectResource.put(523, { name: 'second table, too late' }, context);
			}),
			/disconnected/
		);
		assert.ok((await LateDisconnectResource.get(523)) == null, 'the late database write must not commit either');
	});

	it('does not poison a source-apply transaction on disconnect (no resume path, must never drop a write)', async function () {
		const ac = new AbortController();
		const context = { signal: ac.signal, sourceApply: true };
		await transaction(context, async () => {
			await DisconnectResource.put(506, { name: 'from source' }, context);
			ac.abort();
			await delay(10);
			assert.equal(context.transaction.disconnected, undefined, 'a source-apply transaction must not be poisoned');
		});
		assert.equal((await DisconnectResource.get(506))?.name, 'from source', 'the source-applied write must commit');
	});

	it('does not affect a request that completes normally without disconnecting', async function () {
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await transaction(context, async () => {
			await DisconnectResource.put(503, { name: 'normal' }, context);
		});
		assert.equal((await DisconnectResource.get(503))?.name, 'normal');
	});

	// The read reference is taken at the top of search() and only owned by a result set at the bottom.
	// A query that faults in between owes it back, or the next abort() reads the transaction as
	// iterator-bearing and retains its native handle until the monitor's next tick.
	it('returns the read reference when the query faults before a result set exists', async function () {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await DisconnectResource.put(600, { name: 'seed' }, context);
				await DisconnectResource.search(
					{ conditions: [{ attribute: 'name', comparator: 'nonsense', value: 1 }] },
					context
				);
			})
		);
		assertChainReleased(context.transaction);
	});

	// Once an explicit in-handler commit() has submitted its native write, a later disconnect poisons
	// everything that follows but must not tear the started attempt's handle out, so its write can land
	// after the client is gone.
	it('lets an explicit commit already in flight reach its outcome, rejecting only later work', async function () {
		if (isLMDB) this.skip(); // LMDB submission-state parity is covered without gating its global store below
		const ac = new AbortController();
		const context = { signal: ac.signal };
		await assert.rejects(
			transaction(context, async (txn) => {
				await DisconnectResource.put(530, { name: 'commits despite the disconnect' }, context);
				const nativeTransaction = txn.transaction;
				const nativeCommit = nativeTransaction.commit.bind(nativeTransaction);
				const nativeAbort = nativeTransaction.abort.bind(nativeTransaction);
				let nativeAborts = 0;
				let releaseNativeCommit;
				const nativeGate = new Promise((resolve) => (releaseNativeCommit = resolve));
				nativeTransaction.commit = () => nativeGate.then(nativeCommit);
				nativeTransaction.abort = () => {
					nativeAborts++;
					return nativeAbort();
				};
				const committing = txn.commit();
				await waitFor(() => txn.commitSubmitted, { message: 'the native submission boundary must be marked' });
				ac.abort();
				assert.equal(txn.disconnected, true, 'the disconnect must still poison the transaction');
				assert.equal(nativeAborts, 0, 'a submitted native commit must not be aborted');
				releaseNativeCommit();
				await committing;
				assert.equal(nativeAborts, 0, 'settling the native commit must not trigger a late abort');
				await assert.rejects(
					DisconnectResource.put(531, { name: 'must reject' }, context),
					/disconnected/,
					'work after the started commit must be rejected'
				);
			}),
			/disconnected/
		);
		assert.equal(
			(await DisconnectResource.get(530))?.name,
			'commits despite the disconnect',
			'the started commit must reach its native outcome'
		);
		assert.ok((await DisconnectResource.get(531)) == null, 'the post-commit write must not land');
	});

	it('lets the wrapper-owned final commit settle after native submission before removing cancellation', async function () {
		if (isLMDB) this.skip(); // LMDB submission-state parity is covered without gating its global store below
		const ac = new AbortController();
		const context = { signal: ac.signal };
		let txn;
		let releaseNativeCommit;
		let nativeAborts = 0;
		const handled = transaction(context, async (currentTxn) => {
			txn = currentTxn;
			await DisconnectResource.put(535, { name: 'wrapper commit outcome' }, context);
			const nativeTransaction = currentTxn.transaction;
			const nativeCommit = nativeTransaction.commit.bind(nativeTransaction);
			const nativeAbort = nativeTransaction.abort.bind(nativeTransaction);
			const nativeGate = new Promise((resolve) => (releaseNativeCommit = resolve));
			nativeTransaction.commit = () => nativeGate.then(nativeCommit);
			nativeTransaction.abort = () => {
				nativeAborts++;
				return nativeAbort();
			};
		});

		await waitFor(() => txn?.commitSubmitted, { message: 'the wrapper must submit its final native commit' });
		ac.abort();
		assert.equal(txn.disconnected, true, 'the listener must remain armed through final commit settlement');
		assert.equal(nativeAborts, 0, 'a submitted wrapper commit must not be aborted');
		releaseNativeCommit();
		await handled;
		assert.equal(nativeAborts, 0);
		assert.equal((await DisconnectResource.get(535))?.name, 'wrapper commit outcome');
		assertChainReleased(context.transaction);

		await transaction(context, async () => {
			await DisconnectResource.put(536, { name: 'later scope on aborted signal' }, context);
		});
		assert.equal((await DisconnectResource.get(536))?.name, 'later scope on aborted signal');
	});

	// The same boundary from the other side of commit()'s CLOSED flip: once the native commit is in
	// flight the transaction has already marked itself CLOSED, so the listener's OPEN + hasPendingWrites()
	// test alone would see nothing to protect and let the scope rotate back open and commit later writes
	// for a client that is already gone. RocksDB only: LMDB commits its writes through the store's batch
	// rather than a native transaction handle this can gate on.
	// The listener used to be armed only when the callback returned a promise, which left a synchronous
	// callback's writes to be committed by onComplete with no cancellation armed at all — and that commit
	// is where they become durable.
	it('arms cancellation for a synchronous callback whose final commit is asynchronous', async function () {
		// LMDB reaches txnForContext only after an await inside put(), so a synchronous callback leaves it
		// nothing staged to commit and the shape does not exist on that engine.
		if (isLMDB) this.skip();
		const slow = new PassThrough();
		const blob = createBlob(slow);
		const ac = new AbortController();
		const context = { signal: ac.signal };
		// Synchronous callback: it stages its write and returns nothing thenable, so the wrapper's own
		// commit is this scope's only asynchronous phase.
		const handled = transaction(context, () => {
			DisconnectBlobResource.put({ id: 538, blob }, context);
		});
		handled.catch(() => {});
		slow.write(Buffer.alloc(4096, 'a'));
		await waitFor(() => databaseTxns(context).some((txn) => txn.committing), {
			message: 'the blob save should park the wrapper commit before it submits',
		});
		ac.abort();
		slow.end();
		await assert.rejects(handled, /disconnected/);
		assert.ok((await DisconnectBlobResource.get(538)) == null, 'a pre-submit commit must not land after a disconnect');
	});

	it('poisons a disconnect that lands after the commit marked itself closed', async function () {
		if (isLMDB) return;
		const ac = new AbortController();
		const context = { signal: ac.signal };
		let sawRotation;
		await assert.rejects(
			transaction(context, async (txn) => {
				await DisconnectResource.put(532, { name: 'commits despite the disconnect' }, context);
				// Hold the native commit open so the disconnect lands strictly inside the CLOSED window.
				const { nativeTransaction } = getReadTransaction(context.transaction);
				const nativeCommit = nativeTransaction.commit.bind(nativeTransaction);
				let releaseNativeCommit;
				const nativeGate = new Promise((resolve) => (releaseNativeCommit = resolve));
				nativeTransaction.commit = () => nativeGate.then(nativeCommit);
				const committing = txn.commit();
				await waitFor(() => Boolean(releaseNativeCommit) && txn.open === TRANSACTION_STATE.CLOSED, {
					message: 'the commit should reach its closed window',
				});
				ac.abort();
				assert.equal(txn.disconnected, true, 'a disconnect in the commit window must still poison');
				releaseNativeCommit();
				await committing;
				sawRotation = txn.open === TRANSACTION_STATE.OPEN;
				await assert.rejects(
					DisconnectResource.put(533, { name: 'must reject' }, context),
					/disconnected/,
					'the scope must not resume for a client that is gone'
				);
			}),
			/disconnected/
		);
		assert.equal(sawRotation, false, 'a poisoned scope must not rotate back open after its commit');
		assert.equal((await DisconnectResource.get(532))?.name, 'commits despite the disconnect');
		assert.ok((await DisconnectResource.get(533)) == null, 'the post-commit write must not land');
	});

	// The deliberate limit of the no-sticky-fast-path rule, pinned so it cannot change by accident: a
	// transaction created after the disconnect never sees an 'abort' event and is NOT poisoned, which is
	// what keeps post-disconnect compensation work runnable. It falls back to the monitor instead.
	it('does not poison a transaction created after the client already disconnected', async function () {
		const ac = new AbortController();
		ac.abort();
		const context = { signal: ac.signal };
		await transaction(context, async () => {
			await DisconnectResource.put(534, { name: 'compensation write' }, context);
		});
		assert.equal((await DisconnectResource.get(534))?.name, 'compensation write');
	});

	it('keeps a returned iterator alive when the transaction commits normally', async function () {
		await DisconnectResource.put(540, { name: 'returned iterator survives' }, {});
		const context = {};
		const results = await transaction(context, async () => {
			await DisconnectResource.put(541, { name: 'committed alongside' }, context);
			return DisconnectResource.search({}, context);
		});
		// Ownership tracking must not close an iterator the caller is entitled to consume.
		const ids = [];
		for await (const record of results) ids.push(record.id);
		assert.ok(ids.includes(540), 'the returned iterator must still yield its rows after the commit');
		assert.equal(getReadTransaction(context.transaction), undefined, 'draining it releases the native handle');
	});

	it('resumes a partially consumed iterator after the transaction settles', async function () {
		for (const id of [550, 551, 552]) await DisconnectResource.put(id, { name: 'resumable ' + id }, {});
		const context = {};
		let iterator;
		const seen = [];
		await transaction(context, async () => {
			await DisconnectResource.put(553, { name: 'committed alongside' }, context);
			const results = await DisconnectResource.search({}, context);
			iterator = results[Symbol.asyncIterator]();
			seen.push((await iterator.next()).value?.id);
		});
		let iteration = await iterator.next();
		while (!iteration.done) {
			seen.push(iteration.value?.id);
			iteration = await iterator.next();
		}
		assert.ok(seen.length > 1, 'the iterator must resume after the transaction settled');
		assert.equal(getReadTransaction(context.transaction), undefined, 'finishing it releases the native handle');
	});

	// Once a native commit has been submitted, its outcome is unknown. Aborting the wrapper cannot prove
	// the native work was cancelled, and clearing its writes can delete blobs the eventual commit names.
	// The monitor therefore poisons fresh work but leaves the submitted outcome alone.
	it('does not destructively abort a submitted commit that outlives the monitor grace', async function () {
		if (isLMDB) this.skip(); // LMDB submission-state parity is covered without gating its global store below
		setDisconnectExpiration(50);
		try {
			const ac = new AbortController();
			const context = { signal: ac.signal };
			let committing;
			let releaseNativeCommit;
			let nativeAborts = 0;
			const handled = transaction(context, async (txn) => {
				await DisconnectResource.put(570, { name: 'eventual outcome' }, context);
				const nativeTransaction = txn.transaction;
				const nativeCommit = nativeTransaction.commit.bind(nativeTransaction);
				const nativeAbort = nativeTransaction.abort.bind(nativeTransaction);
				const gate = new Promise((resolve) => (releaseNativeCommit = resolve));
				nativeTransaction.commit = () => gate.then(nativeCommit);
				nativeTransaction.abort = () => {
					nativeAborts++;
					return nativeAbort();
				};
				committing = txn.commit();
				await waitFor(() => txn.commitSubmitted, { message: 'the native submission boundary must be marked' });
				txn.timeout = 0;
				ac.abort();
				assert.equal(txn.disconnected, true, 'the disconnect poisons fresh work while the outcome is unknown');
				await waitFor(() => txn.timedOut, {
					message: 'the monitor should poison fresh work after the submitted commit remains stalled',
				});
				assert.equal(nativeAborts, 0, 'the monitor must not abort a native outcome it cannot classify');
				releaseNativeCommit();
				await committing;
			});
			await assert.rejects(handled, /disconnected|open-transaction time/);
			assert.equal(nativeAborts, 0, 'settlement must not be followed by a destructive late abort');
			assert.equal(
				(await DisconnectResource.get(570))?.name,
				'eventual outcome',
				'the native outcome must remain durable even after the request was poisoned'
			);
		} finally {
			setDisconnectExpiration(30000);
		}
	});

	it('finishes a RETRY_NOW continuation after a submitted commit is monitor-poisoned', async function () {
		if (isLMDB) this.skip();
		const context = {};
		let releaseFirstAttempt;
		let attempts = 0;
		await assert.rejects(
			transaction(context, async (txn) => {
				await DisconnectResource.put(571, { name: 'retry survives poison' }, context);
				const nativeTransaction = txn.transaction;
				const nativeCommit = nativeTransaction.commit.bind(nativeTransaction);
				nativeTransaction.commit = () => {
					attempts++;
					if (attempts === 1) return new Promise((resolve) => (releaseFirstAttempt = () => resolve(RETRY_NOW_VALUE)));
					return nativeCommit();
				};
				const committing = txn.commit();
				await waitFor(() => releaseFirstAttempt, { message: 'the first native attempt should be pending' });
				txn.poisonAfterStalledSubmittedCommit();
				releaseFirstAttempt();
				await committing;
			}),
			/open-transaction time/
		);
		assert.equal(attempts, 2, 'the poisoned attempt must run its RETRY_NOW continuation');
		assert.equal((await DisconnectResource.get(571))?.name, 'retry survives poison');
	});

	// The wrapper cannot abort a commit it did not await, but its scope is still over. Without giving
	// up scope ownership, that attempt's own mid-scope rotation reopens the instance with no wrapper
	// left to commit or abort it, and the next transaction() on the same context joins it and never
	// commits — a silent write loss reported as success.
	it('does not leave a rotated-open transaction behind when the callback throws mid-commit', async function () {
		const context = {};
		let releaseCommitGate;
		await assert.rejects(
			transaction(context, async (txn) => {
				await DisconnectResource.put(590, { name: 'fire and forget' }, context);
				txn.stageCompletion(new Promise((resolve) => (releaseCommitGate = resolve)));
				txn.commit().catch(() => {});
				throw new Error('handler threw mid-commit');
			}),
			/handler threw mid-commit/
		);
		releaseCommitGate();
		await waitFor(() => context.transaction.open !== TRANSACTION_STATE.OPEN, {
			message: 'an abandoned scope must not be rotated back open by its own in-flight commit',
		});
		await transaction(context, async () => {
			await DisconnectResource.put(591, { name: 'second scope' }, context);
		});
		assert.equal(
			(await DisconnectResource.get(591))?.name,
			'second scope',
			'a later transaction on the same context must get a wrapper that commits'
		);
	});

	// The same hole one window earlier: while the abandoned attempt is still inside its `before` hooks
	// the instance has not reached CLOSED on its own, so an OPEN check would still let the next write on
	// this context join it. A hung hook makes that window arbitrarily long.
	it('does not let a write join the abandoned scope while its commit is still in flight', async function () {
		const context = {};
		let releaseCommitGate;
		let committing;
		await assert.rejects(
			transaction(context, async (txn) => {
				await DisconnectResource.put(592, { name: 'fire and forget' }, context);
				txn.stageCompletion(new Promise((resolve) => (releaseCommitGate = resolve)));
				committing = txn.commit().catch(() => {});
				throw new Error('handler threw mid-commit');
			}),
			/handler threw mid-commit/
		);
		// Gate still held: the attempt has not settled and has not closed itself.
		await transaction(context, async () => {
			await DisconnectResource.put(593, { name: 'joined too early' }, context);
		});
		assert.equal(
			(await DisconnectResource.get(593))?.name,
			'joined too early',
			'a write made while the abandoned attempt is still in flight must get its own committing wrapper'
		);
		releaseCommitGate();
		await committing; // don't leave a native commit running into the next test
	});

	// The abandoned links are captured when the scope ends, not walked from `next` when the attempt
	// settles: a successful multi-store commit clears `next` first, so a former child's iterator would
	// own a snapshot nothing could reach. Built directly because setupTestDBPath gives every database
	// name the same store path, so the resource API never forms a second link in this harness.
	it("closes an abandoned chain link's iterator after the settling commit detaches it", function () {
		const head = new DatabaseTransaction({ scopeOwned: true });
		const link = new DatabaseTransaction();
		link.root = head;
		head.next = link;
		link.transaction = {}; // a link with no handle of its own owns nothing to reclaim
		let closed = 0;
		const iterator = {
			onDone() {
				iterator.onDone = null;
				closed++;
			},
		};
		link.registerReadIterator(iterator);
		head.commitsInFlight = 1;
		head.abandonScope();
		head.next = null; // what completeMidScopeCommit does before the outer commit() settles
		head.endCommitAttempt();
		assert.equal(closed, 1, "a detached link's iterator must still be closed when the attempt settles");
	});

	// The mirror case, which capturing the chain cannot cover: LMDB's commit clears `next` before it
	// awaits the child, so a scope abandoned in that window never saw the link at all. The link closes
	// its own iterators when its own attempt settles.
	it("closes an abandoned link's iterator when a commit detached it before the scope ended", function () {
		const head = new DatabaseTransaction({ scopeOwned: true });
		const link = new DatabaseTransaction();
		link.root = head; // already detached: head.next was cleared by the commit that started the child
		link.transaction = {};
		let closed = 0;
		const iterator = {
			onDone() {
				iterator.onDone = null;
				closed++;
			},
		};
		link.registerReadIterator(iterator);
		head.commitsInFlight = 1;
		link.commitsInFlight = 1;
		head.abandonScope();
		link.endCommitAttempt();
		assert.equal(closed, 1, 'a link detached before abandonment must close its own iterators on settle');
	});

	// The head marks itself CLOSED and detaches its handle as soon as its own commit starts, while a
	// second database's link is still holding uncommitted writes for the cascade. Without the deferral
	// the monitor reads that as "nothing left to supervise" and releases the chained link's handle,
	// dropping its writes even though the head's commit succeeds.
	it('does not unsupervise a multi-store chain while the head commit is in flight', async function () {
		if (isLMDB) return; // gating a native handle's commit; LMDB commits through the store's batch
		const SecondDbResource = table({
			table: 'DisconnectSecondDbTable',
			database: 'test2',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		setDisconnectExpiration(50);
		try {
			const context = {};
			await transaction(context, async (txn) => {
				await DisconnectResource.put(580, { name: 'head write' }, context);
				await SecondDbResource.put(580, { name: 'chained write' }, context);
				const nativeTransaction = context.transaction.transaction;
				const nativeCommit = nativeTransaction.commit.bind(nativeTransaction);
				let releaseNativeCommit;
				const gate = new Promise((resolve) => (releaseNativeCommit = resolve));
				nativeTransaction.commit = () => gate.then(nativeCommit);
				const committing = txn.commit({ doneWriting: true });
				txn.timeout = 0;
				await waitFor(() => txn.timeout > 0, {
					message: 'the monitor should defer the submitted head without releasing its chain',
				});
				releaseNativeCommit();
				await committing;
			});
			assert.equal((await DisconnectResource.get(580))?.name, 'head write');
			assert.equal(
				(await SecondDbResource.get(580))?.name,
				'chained write',
				"the chained store's writes must survive a head commit that outlives a monitor tick"
			);
		} finally {
			setDisconnectExpiration(30000);
		}
	});

	// A write plus an undrained iterator, idle past the open-transaction limit, with NO disconnect: the
	// poison retains the handle for the iterator that owns it, so the monitor is the only terminating
	// condition and without one the read snapshot is pinned for the life of the process.
	it('reclaims a timed-out transaction whose iterator is never drained', async function () {
		setDisconnectExpiration(50);
		try {
			await DisconnectResource.put(560, { name: 'timeout iterator seed' }, {});
			const context = {};
			let releaseHandler;
			const handlerGate = new Promise((resolve) => (releaseHandler = resolve));
			const running = transaction(context, async () => {
				await DisconnectResource.put(561, { name: 'must be discarded' }, context);
				const results = await DisconnectResource.search({}, context);
				await results[Symbol.asyncIterator]().next();
				await handlerGate; // the handler never returns on its own
			});
			running.catch(() => {}); // asserted below; keep the rejection from being unhandled meanwhile
			await waitFor(() => getReadTransaction(context.transaction) === undefined, {
				message: 'the monitor must reclaim the retained handle of a timed-out transaction',
			});
			releaseHandler();
			await assert.rejects(running, /open-transaction time/);
			assert.ok((await DisconnectResource.get(561)) == null, 'the timed-out write must not commit');
		} finally {
			setDisconnectExpiration(30000);
		}
	});

	// A caching table's on-demand fill-from-source runs `getFromSource`'s OWN `transaction(sourceContext,
	// ...)` (resources/Table.ts), a completely separate DatabaseTransaction from the requester's — with no
	// `signal` of its own (`sourceContext` never carries one). Independently, the requester's own (outer)
	// transaction has no pending writes of its own while waiting on the fetch, so the hasPendingWrites()
	// gate above leaves it unpoisoned too. Either guarantee alone would be enough; both hold. So a slow
	// source fetch triggered by a GET must keep filling the cache, AND the original GET must still resolve
	// normally, even after the requester who triggered it disconnects.
	it('still caches a slow source fill for later requesters even if the requesting client disconnects mid-fetch', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // caching tables: see unitTests/resources/caching.test.js
		const CachingResource = table({
			table: 'DisconnectCachingTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		let releaseSource;
		CachingResource.sourcedFrom({
			get(id) {
				return new Promise((resolve) => {
					releaseSource = () => resolve({ id, name: 'from-source-' + id });
				});
			},
		});
		const ac = new AbortController();
		const context = { signal: ac.signal };
		const getPromise = CachingResource.get(701, context);
		await waitFor(() => Boolean(releaseSource), { message: 'the source fetch should reach the gated get()' });
		ac.abort(); // the requesting client disconnects while the source fetch is still in flight
		await delay(5);
		releaseSource();
		const result = await getPromise; // read-only transaction, ungated — resolves normally despite the disconnect
		assert.equal(result?.name, 'from-source-701');
		// The cache fill commits via getFromSource's own background transaction (see the comment above),
		// deliberately not awaited by the requester's own promise — poll for it rather than a fixed sleep.
		// onlyIfCached throws (504) rather than returning falsy while still uncached, so swallow that.
		const cached = await waitFor(async () => {
			try {
				return await CachingResource.get(701, { onlyIfCached: true });
			} catch {
				return undefined;
			}
		});
		assert.equal(cached?.name, 'from-source-701', 'the fetched value must still be cached for a later requester');
	});
});

describe('Read Txn Expiration', () => {
	let SlowReadResource;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		let BasicTable = table({
			table: 'ReadTxnTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		SlowReadResource = class extends BasicTable {
			async get(query) {
				const result = super.get(query);
				await delay(50);
				return result;
			}
		};
		if (SlowReadResource.primaryStore instanceof RocksDatabase) this.skip();
	});

	it('Read txn will be ended after timeout', async function () {
		await SlowReadResource.put(1, { name: 'one' });

		// set timeout to minimum, 15s = 1 tick, openTimer > 1 means txn is expired
		const trackedTxns = setReadTxnExpiration(15000);

		const readPromise = SlowReadResource.get(1);
		await delay(20);

		const before = trackedTxns.length;
		checkReadTxnTimeouts();
		checkReadTxnTimeouts();
		checkReadTxnTimeouts();
		checkReadTxnTimeouts();
		checkReadTxnTimeouts();

		assert.ok(
			trackedTxns.length < before,
			`expected a txn to be removed; trackedTxns went ${before} -> ${trackedTxns.length}`
		);
		await readPromise;
	});

	it('Read txn below threshold is not expired', async function () {
		setReadTxnExpiration(60000);

		await SlowReadResource.put(2, { name: 'two' });
		const readPromise = SlowReadResource.get(2);
		await delay(20);

		// only 2 ticks
		checkReadTxnTimeouts();

		const result = await readPromise;
		assert.equal(result.name, 'two');
	});

	after(async function () {
		setReadTxnExpiration(300000);
		// On Node v24 the V8 exit-time finalizer order can call mdb_cursor_close on a cursor
		// whose txn was force-aborted by checkReadTxnTimeouts above. Drain in-flight ops and
		// reap orphaned cursor wrappers now, while the env is still in a stable state.
		await new Promise((r) => setImmediate(r));
		if (typeof global.gc === 'function') {
			global.gc();
			await new Promise((r) => setImmediate(r));
		}
	});
});
