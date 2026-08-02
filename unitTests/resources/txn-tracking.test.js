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
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
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
