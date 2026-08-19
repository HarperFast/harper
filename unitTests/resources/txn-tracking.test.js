require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const {
	setTxnExpiration,
	DatabaseTransaction,
	TRANSACTION_STATE,
	COMMIT_PHASE_GRACE,
} = require('#src/resources/DatabaseTransaction');
const { setTxnExpiration: setLMDBTxnExpiration, LMDBTransaction } = require('#src/resources/LMDBTransaction');
const { setReadTxnExpiration, checkReadTxnTimeouts } = require('#src/resources/RecordEncoder');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const { PassThrough } = require('node:stream');
const { RocksDatabase, registryStatus } = require('@harperfast/rocksdb-js');
const { createBlob } = require('#src/resources/blob');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const { waitFor } = require('../waitFor.js');

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
		await Promise.race([delay(50), result]);
		assert(performedDBInteractions);
		// Check the specific txn we started was expired and removed. Counting against
		// existingTxns is unreliable: other tests' transactions can expire concurrently and
		// shift the count underneath us during the 50ms window.
		assert.ok(
			!trackedTxns.has(lastTxn),
			'expected the slow transaction to have been expired and removed from trackedTxns'
		);
	});
	after(function () {
		setTxnExpiration(30000);
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
		assert.equal(head.commitPhaseTicks, 0);
		assert.equal(next.commitPhaseTicks, 0);
		head.setCommitPhase(false);
		assert.ok(!head.committing && !next.committing, 'every linked database must leave the phase together');
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
			await waitFor(() => links.every((txn) => txn.commitPhaseTicks >= 2), {
				timeout: 5000,
				message: 'the monitor should spare both links repeatedly',
			});
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
