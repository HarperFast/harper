require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { setTxnExpiration, DatabaseTransaction, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { setTxnExpiration: setLMDBTxnExpiration } = require('#src/resources/LMDBTransaction');
const { setReadTxnExpiration, checkReadTxnTimeouts } = require('#src/resources/RecordEncoder');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const { RocksDatabase, registryStatus } = require('@harperfast/rocksdb-js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const { waitFor } = require('../waitFor.js');
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

	it('keeps a RocksDB timeout budget across reads without shortening a larger global limit', async function () {
		if (!(IndexedResource.primaryStore instanceof RocksDatabase)) this.skip();
		try {
			setTxnExpiration(30_000);
			const extendedContext = {};
			await transaction(extendedContext, async (txn) => {
				txn.timeoutBudget = 600_000;
				await IndexedResource.put(900, { t: 9000 }, extendedContext);
				assert.equal(txn.timeout, 600_000);
				await IndexedResource.get(901, extendedContext);
				assert.equal(txn.timeout, 600_000);
				await IndexedResource.get(902, extendedContext);
				assert.equal(txn.timeout, 600_000);
			});

			setTxnExpiration(1_200_000);
			const largerGlobalContext = {};
			await transaction(largerGlobalContext, async (txn) => {
				txn.timeoutBudget = 600_000;
				await IndexedResource.get(903, largerGlobalContext);
				assert.equal(txn.timeout, 1_200_000);
			});
		} finally {
			setTxnExpiration(30_000);
		}
	});

	it('does not abort a RocksDB write transaction whose budget exceeds the global limit', async function () {
		if (!(IndexedResource.primaryStore instanceof RocksDatabase)) this.skip();
		setTxnExpiration(20);
		try {
			const context = {};
			await transaction(context, async (txn) => {
				txn.timeoutBudget = 5_000;
				await IndexedResource.put(904, { t: 42 }, context);
				await delay(150);
			});
			assert.equal((await IndexedResource.get(904))?.t, 42);
		} finally {
			setTxnExpiration(30_000);
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

// harper#2001: a client that disconnects mid-handler must not leave its request-scoped transaction's
// staged writes / native write intents held until the handler's own promise happens to settle (which,
// for a client that is never coming back, may be effectively never) or the long-transaction monitor's
// next cycle catches it. `resources/transaction.ts` listens for `context.signal`'s 'abort' event (the
// same signal a Request/UwsRequest populates on client disconnect) and, while the callback is still
// running, aborts the transaction immediately instead.
describe('Disconnect abort', () => {
	let DisconnectResource;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		DisconnectResource = table({
			table: 'DisconnectTxnTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
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

	it('keeps a write-first iterator safe when the poisoned callback rejects', async function () {
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
		const { txn: iteratorTransaction } = getReadTransaction(context.transaction);
		assert.ok(
			iteratorTransaction.transaction ?? iteratorTransaction.readTxn,
			'callback cleanup must retain the iterator native transaction'
		);
		while (!(await iterator.next()).done);
		assert.equal(
			iteratorTransaction.transaction ?? iteratorTransaction.readTxn,
			null,
			'finishing the iterator releases the native transaction'
		);
		assert.ok((await DisconnectResource.get(510)) == null, 'the disconnected write must not commit');
	});

	it('does not let the transaction monitor release a poisoned iterator', async function () {
		setDisconnectExpiration(20);
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
					await delay(100);
					assert.equal(
						iteratorTransaction.transaction ?? iteratorTransaction.readTxn,
						nativeTransaction,
						'the monitor must not release a poisoned iterator native transaction'
					);
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

	// Table.ts's txnForContext only chains a separate `next` link when the second store's `.path` differs
	// from the head's. In this test harness setupTestDBPath() points every configured database name at the
	// same directory (unitTests/testUtils.js), so two tables never actually get distinct store paths here
	// to exercise that branch — the same pre-existing harness limitation noted in PR #2009's review of this
	// file ("same-database tables share one transaction — I measured it"). So this only exercises the
	// (still real, still necessary) case where a second table resolves to the SAME store as the head: the
	// rejection comes from the head's own poison check, not from a genuinely new chain link. The Table.ts
	// propagation fix itself (transaction.next.disconnected = ...) is exercised whenever a real deployment
	// — with actual distinct database paths — touches a second database after a disconnect; verified by
	// code inspection (txnForContext's `next` link creation is unconditional on database identity, and the
	// two new poison-propagation lines run in that same branch) rather than a mechanistic test here.
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
			// RocksDB rejects with requestAbortedError ("disconnected"). LMDB's own overridden
			// addWrite/commit don't consult the `disconnected` poison flag, but they already reject on
			// `open === CLOSED` (which txnForContext does propagate to a chain link created after the
			// poisoning) with their own pre-existing, differently-worded error — both block the write.
			/disconnected|no longer open/
		);
		assert.ok((await DisconnectResource.get(502)) == null, 'the poisoned first write must not commit either');
		assert.ok((await DisconnectResource.get(504)) == null, 'a write staged after disconnect must not commit');
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
		await delay(10); // let the fetch reach the gated source call
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
