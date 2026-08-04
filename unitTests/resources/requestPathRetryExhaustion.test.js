require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const RETRY_NOW_VALUE = require('@harperfast/rocksdb-js').constants.RETRY_NOW_VALUE;

// A request-path (non-sourceApply) transaction whose commit conflicts past the retry cap must
// REJECT the promise chain the request handler awaits — the caller gets a loud ServerError (500),
// never a silent hang. This is the invariant behind harper#1785: the client-observed "permanent
// ingest hang" was the retry loop outliving the client's socket, so the eventual exhaustion error
// was written to a dead connection. These tests pin that the exhaustion error (a) rejects the
// awaited transaction() promise on both native conflict-signaling paths (ERR_BUSY/ERR_TRY_AGAIN
// rejection, and the coordinatedRetry RETRY_NOW sentinel), (b) does so after exactly
// MAX_RETRIES + 1 attempts, and (c) never leaks an unhandled rejection.
describe('request-path commit retry exhaustion rejects the awaited chain', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	const MAX_RETRIES = 40; // mirrors resources/DatabaseTransaction.ts
	let ExhaustTable;
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		ExhaustTable = table({
			table: 'RetryExhaustionTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }],
			audit: true,
		});
		process.on('unhandledRejection', onUnhandled);
	});

	after(() => {
		process.removeListener('unhandledRejection', onUnhandled);
	});

	afterEach(() => {
		unhandled.length = 0; // isolate tests: one leak must not taint the following tests' assertions
		// safety net: restore the commit stub even if a test bails before its finally runs
		while (pendingRestores.length) pendingRestores.pop()();
	});

	const pendingRestores = [];

	// Force native commits against the test database to fail: `reject` mode rejects with the given
	// error code (the uncoordinated conflict path), `retryNow` mode resolves with the RETRY_NOW
	// sentinel (the coordinatedRetry conflict path). abort() stays real so retry transactions
	// release their native handles. Scoped to the test table's native db handle — background
	// timers (hdb_analytics aggregation) commit their own transactions during the ~20s backoff
	// window, and failing those spawns unrelated retry chains that pollute the attempt count.
	function failCommits(mode, code) {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = ExhaustTable.primaryStore.store.db;
		const attempts = [];
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
			attempts.push(this.id);
			if (mode === 'retryNow') return Promise.resolve(RETRY_NOW_VALUE);
			return Promise.reject(Object.assign(new Error('forced conflict'), { code }));
		};
		const restore = () => (Transaction.prototype.commit = originalCommit);
		pendingRestores.push(restore);
		return { attempts, restore };
	}

	async function writeThatExhausts(id) {
		const context = {};
		return transaction(context, async () => {
			// read first so the transaction is created via getReadTxn (coordinatedRetry), matching the
			// operations-API bulk upsert flow (ResourceBridge reads each record before writing)
			await ExhaustTable.get(id, context);
			await ExhaustTable.put({ id, writer: 'exhaust' }, context);
		});
	}

	function raceOutcome(txnDone, ms) {
		return Promise.race([
			Promise.resolve(txnDone).then(
				() => ({ outcome: 'committed' }),
				(error) => ({ outcome: 'rejected', error })
			),
			// unref the race timer so a settled race doesn't keep the event loop alive for up to `ms`
			delay(ms, undefined, { ref: false }).then(() => ({ outcome: 'hung' })),
		]);
	}

	it('rejects with the retry-exhaustion ServerError when commits reject (ERR_TRY_AGAIN)', async function () {
		this.timeout(60000);
		const { attempts, restore } = failCommits('reject', 'ERR_TRY_AGAIN');
		try {
			// full quadratic backoff runs here (~20s): this also pins that exhaustion surfaces in
			// tens of seconds — well inside client socket timeouts — not minutes
			const { outcome, error } = await raceOutcome(writeThatExhausts('try-again'), 50000);
			assert.equal(outcome, 'rejected', 'the awaited transaction promise must reject, not hang or commit');
			assert.match(error.message, /After 40 retries, unable to commit/);
			assert.equal(error.statusCode, 500, 'the exhaustion error must carry an HTTP status');
			assert.equal(attempts.length, MAX_RETRIES + 1, 'one initial attempt plus MAX_RETRIES retries');
		} finally {
			restore();
		}
		// unhandledRejection is emitted on a later event-loop turn than the rejection itself;
		// drain before asserting or a leaked rejection could land after the check (and after
		// the listener is removed in the after hook)
		await delay(50);
		assert.deepEqual(unhandled, [], 'exhaustion must not leak an unhandled rejection');
	});

	it('rejects with the retry-exhaustion ServerError when commits reject (ERR_BUSY)', async function () {
		this.timeout(60000);
		const { attempts, restore } = failCommits('reject', 'ERR_BUSY');
		try {
			const { outcome, error } = await raceOutcome(writeThatExhausts('busy'), 50000);
			assert.equal(outcome, 'rejected', 'the awaited transaction promise must reject, not hang or commit');
			assert.match(error.message, /After 40 retries, unable to commit/);
			assert.equal(error.statusCode, 500, 'the exhaustion error must carry an HTTP status');
			assert.equal(attempts.length, MAX_RETRIES + 1, 'one initial attempt plus MAX_RETRIES retries');
		} finally {
			restore();
		}
		// unhandledRejection is emitted on a later event-loop turn than the rejection itself;
		// drain before asserting or a leaked rejection could land after the check (and after
		// the listener is removed in the after hook)
		await delay(50);
		assert.deepEqual(unhandled, [], 'exhaustion must not leak an unhandled rejection');
	});

	it('rejects with the coordinated-retry exhaustion ServerError when commits resolve RETRY_NOW', async function () {
		this.timeout(15000);
		const { attempts, restore } = failCommits('retryNow');
		try {
			// coordinated retries recurse without backoff, so this path must fail fast
			const { outcome, error } = await raceOutcome(writeThatExhausts('retry-now'), 10000);
			assert.equal(outcome, 'rejected', 'the awaited transaction promise must reject, not hang or commit');
			assert.match(error.message, /After 40 coordinated retries, unable to commit/);
			assert.equal(error.statusCode, 500, 'the exhaustion error must carry an HTTP status');
			assert.equal(attempts.length, MAX_RETRIES + 1, 'one initial attempt plus MAX_RETRIES retries');
		} finally {
			restore();
		}
		// unhandledRejection is emitted on a later event-loop turn than the rejection itself;
		// drain before asserting or a leaked rejection could land after the check (and after
		// the listener is removed in the after hook)
		await delay(50);
		assert.deepEqual(unhandled, [], 'exhaustion must not leak an unhandled rejection');
	});
});
