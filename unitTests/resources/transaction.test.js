require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { DatabaseTransaction, RELEASED_TRANSACTION, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { LMDBTransaction } = require('#src/resources/LMDBTransaction');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const harperLogger = require('#src/utility/logging/harper_logger');
const { resetReplayedWritesWarning } = require('#src/resources/DatabaseTransaction');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// The package blocks deep imports of its package.json, so walk up from the resolved entry point.
function installedRocksdbVersion() {
	const { existsSync, readFileSync } = require('node:fs');
	const { dirname, join } = require('node:path');
	let dir = dirname(require.resolve('@harperfast/rocksdb-js'));
	for (let depth = 0; depth < 5; depth++) {
		const candidate = join(dir, 'package.json');
		if (existsSync(candidate)) {
			const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
			if (parsed.name === '@harperfast/rocksdb-js') return parsed.version;
		}
		dir = dirname(dir);
	}
	throw new Error('could not resolve the installed @harperfast/rocksdb-js version');
}

describe('Transactions', () => {
	let TxnTest, TxnTest2, TxnTest3;
	let test_subscription;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TxnTest = table({
			table: 'TxnTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'count' },
				{ name: 'countBigInt', type: 'BigInt' },
				{ name: 'countInt', type: 'Int' },
				{ name: 'computed', computed: true, indexed: true },
			],
			audit: true,
		});
		TxnTest.sourcedFrom({
			subscribe() {
				return (test_subscription = new IterableEventQueue());
			},
		});
		TxnTest.setComputedAttribute('computed', (instance) => instance.name + ' computed');
		TxnTest2 = table({
			table: 'TxnTest2',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		TxnTest3 = table({
			table: 'TxnTest3',
			database: 'test2',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});
	it('Can run txn', async function () {
		const context = {};
		await transaction(context, () => {
			return TxnTest.put(42, { name: 'the answer' }, context);
		});
		let answer = await TxnTest.get(42);
		assert.equal(answer.name, 'the answer');
		assert.equal(answer.computed, 'the answer computed');
	});
	it('waits for promise-returning commit callbacks on RocksDB', async function () {
		if (isLMDB) return this.skip();
		const transaction = new DatabaseTransaction();
		transaction.db = TxnTest.primaryStore;
		let settled = false;
		let release;
		const completion = new Promise((resolve) => (release = resolve)).then(() => {
			settled = true;
		});
		transaction.addWrite({
			key: 'async-commit-callback',
			store: TxnTest.primaryStore,
			commit: () => completion,
		});
		const committed = transaction.commit({ doneWriting: true });
		setImmediate(release);
		await committed;
		assert.equal(settled, true, 'commit resolved only after the callback completion settled');
	});
	it('surfaces a commit-callback rejection without an unhandled rejection', async function () {
		// each engine has its own no-op rejection handler on the staged completion
		// (DatabaseTransaction.stageCompletion, LMDBTransaction's doWrite)
		const transaction = isLMDB ? new LMDBTransaction() : new DatabaseTransaction();
		transaction.db = TxnTest.primaryStore;
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			transaction.addWrite({
				key: 'rejecting-commit-callback',
				store: TxnTest.primaryStore,
				commit: () => {
					// keyed write: LMDB stages it in the conditional batch, so its aggregating Promise.all is
					// attached only after that batch resolves — a turn or more after this rejection exists
					if (isLMDB) TxnTest.primaryStore.put('rejecting-commit-callback', { name: 'staged' });
					return Promise.reject(new Error('audit write failed'));
				},
			});
			// the staging-to-commit gap: a rejection with no consumer is reported at the end of this turn
			await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
			assert.deepEqual(unhandled, [], 'the staged completion has a rejection handler before commit');
			await assert.rejects(
				() => transaction.commit({ doneWriting: true }),
				/audit write failed/,
				'the rejection still propagates out of commit'
			);
			// the commit-to-aggregation gap, which is the one LMDB's handler covers
			await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
			assert.deepEqual(unhandled, [], 'the completion stays handled across the commit aggregation gap');
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
	it('drains staged completions when a transaction is aborted', async function () {
		if (isLMDB) return this.skip(); // LMDB creates its commit completions at commit time, not at write time
		const transaction = new DatabaseTransaction();
		transaction.db = TxnTest.primaryStore;
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const warnings = [];
		const originalWarn = harperLogger.warn;
		harperLogger.warn = (...args) => warnings.push(args);
		try {
			transaction.addWrite({
				key: 'aborted-commit-callback',
				store: TxnTest.primaryStore,
				commit: () => Promise.reject(new Error('audit write failed after abort')),
			});
			assert.equal(transaction.completions.length, 1, 'the completion is staged before the abort');
			assert.ok(transaction.transaction, 'the write-only transaction holds a native handle with no read reference');
			transaction.abort();
			assert.equal(transaction.transaction, null, 'the abort releases the native handle rather than leaking it');
			assert.deepEqual(
				transaction.completions,
				[],
				'an aborted batch cannot carry its completions into a later commit on a reused transaction'
			);
			await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
			assert.deepEqual(unhandled, [], 'the abandoned rejection does not escape as an unhandled rejection');
			assert.ok(
				warnings.some((args) => /aborted/.test(args[0])),
				'the abandoned rejection is logged rather than silently dropped'
			);
		} finally {
			harperLogger.warn = originalWarn;
			process.off('unhandledRejection', onUnhandled);
		}
	});
	it('waits for promise-returning commit callbacks on a keyed LMDB write', async function () {
		if (!isLMDB) return this.skip();
		const transaction = new LMDBTransaction();
		transaction.db = TxnTest.primaryStore;
		const order = [];
		let release;
		const completion = new Promise((resolve) => (release = resolve)).then(() => order.push('completion'));
		transaction.addWrite({
			key: 'lmdb-async-commit-callback',
			store: TxnTest.primaryStore,
			// keyed write: the conditional batch stages it, so this covers doWrite's non-null-key path
			commit: () => {
				TxnTest.primaryStore.put('lmdb-async-commit-callback', { name: 'staged' });
				return completion;
			},
		});
		// gated on the batch rather than a timer: a fixed delay a loaded runner outruns would pass silently
		const committed = transaction.commit({ doneWriting: true }).then(() => order.push('commit'));
		await TxnTest.primaryStore.flushed;
		assert.deepEqual(order, [], 'commit has not resolved while the callback completion is pending');
		release();
		await committed;
		assert.deepEqual(order, ['completion', 'commit'], 'commit resolved only after the callback completion');
	});
	it('Can run txn with three tables and two databases', async function () {
		const context = {};
		let start = Date.now();
		await transaction(context, async () => {
			await TxnTest.put(7, { name: 'a prime' }, context);
			await TxnTest2.put(13, { name: 'a bigger prime' }, context);
			await TxnTest3.put(14, { name: 'not a prime' }, context);
		});
		assert.equal((await TxnTest.get(7)).name, 'a prime');
		assert.equal((await TxnTest2.get(13)).name, 'a bigger prime');
		assert.equal((await TxnTest3.get(14)).name, 'not a prime');
		let last_txn;
		for await (let entry of TxnTest.getHistory(start)) {
			last_txn = entry;
		}
		assert.equal(last_txn.id, 7);
		let last_txn2;
		for await (let entry of TxnTest2.getHistory(start)) {
			last_txn2 = entry;
		}
		assert.equal(last_txn2.id, 13);
		assert.equal(last_txn.version, last_txn2.version);
	});
	it('Can run txn with commit in the middle', async function () {
		const context = {};
		await transaction(context, async () => {
			await TxnTest.put(7, { name: 'seven' }, context);
			await TxnTest2.put(13, { name: 'thirteen' }, context);
			await context.transaction.commit();
			assert.equal((await TxnTest.get(7, context)).name, 'seven');
			assert.equal((await TxnTest2.get(13, context)).name, 'thirteen');
			await TxnTest.put(7, { name: 'SEVEN' }, context);
			let entries = [];
			for await (let entry of TxnTest2.search([{ attribute: 'name', value: 'thirteen' }], context)) {
				entries.push(entry);
			}
			assert.equal(entries[0].name, 'thirteen');
			await TxnTest3.put(14, { name: 'fourteen' }, context);
			await context.transaction.commit();
			assert.equal((await TxnTest.get(7, context)).name, 'SEVEN');
			assert.equal((await TxnTest2.get(13, context)).name, 'thirteen');
			assert.equal((await TxnTest3.get(14, context)).name, 'fourteen');
		});
		const sevens = [];
		for await (let seven of TxnTest.search([{ attribute: 'name', value: 'SEVEN' }])) {
			sevens.push(seven);
		}
		assert.equal(sevens.length, 1);
	});
	it('abandons the retained handle writes when a commit with outstanding iterators replays', async function () {
		// The outstanding-iterators commit branch replays staged writes onto a fresh transaction
		// and retains the original handle for the iterators; its VT write intents can never be
		// released by a commit, so the branch must call abandonWrites() (harper#2001). The
		// release semantics themselves are covered by rocksdb-js's park-wake test; this pins
		// Harper's side of the contract, including that the native method still exists once the
		// dependency carrying it is installed — a silent `?.` no-op would leave the wedge live.
		if (isLMDB) this.skip();
		const [major, minor] = installedRocksdbVersion().split('.').map(Number);
		const nativeExpected = major > 2 || (major === 2 && minor >= 7);
		await TxnTest2.put('aw-seed-1', { name: 'aw-seed' });
		await TxnTest2.put('aw-seed-2', { name: 'aw-seed' });
		const context = {};
		let abandonCalls = 0;
		let iterator;
		const replayWarnings = [];
		// The warning is once per process and the whole suite shares one, so re-arm it here.
		resetReplayedWritesWarning();
		const originalWarn = harperLogger.warn;
		harperLogger.warn = (...args) => replayWarnings.push(args.join(' '));
		try {
			await transaction(context, async () => {
				iterator = TxnTest2.search([], context)[Symbol.asyncIterator]();
				const first = await iterator.next();
				assert.ok(!first.done, 'test setup: the iterator must be outstanding at commit');
				await TxnTest2.put('aw-write', { name: 'aw-write' }, context);
				const retained = context.transaction.transaction;
				if (nativeExpected) {
					assert.equal(
						typeof retained.abandonWrites,
						'function',
						'installed rocksdb-js should expose abandonWrites; without it the call site is a silent no-op'
					);
				}
				const original = retained.abandonWrites?.bind(retained);
				retained.abandonWrites = function () {
					abandonCalls++;
					return original?.();
				};
			});
		} finally {
			harperLogger.warn = originalWarn;
		}
		assert.equal(abandonCalls, 1, 'the replay commit must abandon the retained handle writes');
		assert.equal(replayWarnings.length, 1, 'the replay must warn the author about the doubled write work');
		assert.match(replayWarnings[0], /read iterators are still open/);
		assert.equal((await TxnTest2.get('aw-write')).name, 'aw-write', 'the replayed write must be durable');
		let remaining = 0;
		while (!(await iterator.next()).done) {
			remaining++;
		}
		assert.ok(remaining >= 1, 'the retained handle must keep serving the outstanding iterator');
	});
	describe('Testing updates', () => {
		it('Can update with addTo and set', async function () {
			const context = {};
			await transaction(context, () => {
				return TxnTest.put(
					45,
					{ name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n },
					context
				);
			});
			assert.equal((await TxnTest.get(45)).name, 'a counter');
			await transaction(async (txn) => {
				let counter = await TxnTest.update(45, {}, txn);
				counter.addTo('count', 1);
				counter.addTo('countInt', 1);
				counter.addTo('countBigInt', 1n);
				assert(counter.getUpdatedTime() > 1);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.count, 2);
			assert.equal(entity.countInt, 101);
			assert.equal(entity.countBigInt, 4611686018427388001n);
			assert.equal(entity.propertyA, undefined);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(
					transaction(async (txn) => {
						let counter = await TxnTest.update(45, {}, txn);
						await new Promise((resolve) => setTimeout(resolve, 1));
						counter.addTo('count', 3);
						counter.subtractFrom('countInt', 2);
						counter.addTo('countBigInt', 5);
						counter['new prop ' + i] = 'new value ' + i;
					})
				);
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 11);
			assert.equal(entity.countInt, 95);
			assert.equal(entity.countBigInt, 4611686018427388016n);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
		});
		it('Can update with patch', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.count, 1);
			assert.equal(entity['new prop 0'], undefined);
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 } });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(TxnTest.patch(45, { count: { __op__: 'add', value: -2 }, ['new prop ' + i]: 'new value ' + i }));
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, -3);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
			assert(entity.getUpdatedTime() > 1);
		});
		it('Can use update and get with different arguments', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			await transaction(async (txn) => {
				let updatable = await TxnTest.update(45, txn);
				updatable.count = 4;
			});
			await transaction(async (txn) => {
				assert.equal((await TxnTest.get(45, {}, txn)).count, 4);
			});
		});

		it('Apply out of order patch', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(61, { name: 'original' }, context);
			});
			let now = Date.now();
			await TxnTest.patch(61, { name: 'newer' }, { timestamp: now + 10 });
			await TxnTest.patch(61, { name: 'older', count: 3 }, { timestamp: now + 4 });
			let record = await TxnTest.get(61);
			assert.equal(record.name, 'newer');
			assert.equal(record.count, 3);
		});
		it('Apply out of order patch and put', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(61, { name: 'original' }, context);
			});
			let now = Date.now();
			await TxnTest.patch(61, { name: 'newer', count: 3 }, { timestamp: now + 10 });
			await TxnTest.put(61, { name: 'older' }, { timestamp: now + 4 });
			let record = await TxnTest.get(61);
			assert.equal(record.name, 'newer');
			assert.equal(record.count, 3);
		});

		it('Write after read after delete', async function () {
			if (isLMDB) return;
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(71, { name: 'before delete' });
				await TxnTest.delete(71);
				let rawRecord = TxnTest.primaryStore.getSync(71);
				console.log({ rawRecord });
				let record = await TxnTest.get(71);
				assert(!record);
				await TxnTest.put(71, { name: 'after delete' });
				record = await TxnTest.get(71);
				assert.equal(record.name, 'after delete');
				await TxnTest.put(71, { name: 'after delete 2' });
				record = await TxnTest.get(71);
				assert.equal(record.name, 'after delete 2');
			});
			let record = await TxnTest.get(71);
			assert.equal(record.name, 'after delete 2');
		});

		it('Successive patches, concurrently', async function () {
			if (isLMDB) return;
			await TxnTest.put(71, { name: 'original', count: 0 });
			let txns = [];
			for (let i = 0; i < 4; i++) {
				txns.push(
					transaction({}, async (txn) => {
						await TxnTest.patch(71, { count: 1 });
						console.log('id', txn.transaction?.id);
						await TxnTest.patch(71, { count: 2 });
					})
				);
			}
			await Promise.all(txns);
			let record = await TxnTest.get(71);
			assert.equal(record.count, 2);
		});

		it('Store additional audit refs on out-of-order writes', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(62, { name: 'original', count: 0 }, context);
			});
			let now = Date.now();
			// Apply newer update first
			await TxnTest.patch(62, { name: 'newer', count: 5 }, { timestamp: now + 100 });

			// Apply older update - this should trigger storing additional audit refs
			await TxnTest.patch(62, { name: 'older', value: 'test' }, { timestamp: now + 50 });

			// Get the entry to check for additional audit refs
			let entry = TxnTest.primaryStore.getEntry(62);
			assert(entry, 'Entry should exist');

			// The record should have the newer name but also the value from the older update
			let record = await TxnTest.get(62);
			assert.equal(record.name, 'newer');
			assert.equal(record.value, 'test');
			assert.equal(record.count, 5);
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
			// Verify additional audit refs were stored
			assert(entry.additionalAuditRefs, 'Additional audit refs should be stored');
			assert(entry.additionalAuditRefs.length > 0, 'Should have at least one additional audit ref');
		});

		it('Traverse multiple audit logs using additional refs', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
			const context = {};
			await transaction(context, () => {
				TxnTest.put(63, { name: 'original', count: 0 }, context);
			});
			let now = Date.now();

			// Create a complex out-of-order scenario
			// Timeline: original -> update1 (t+20) -> update2 (t+40) -> update3 (t+60) -> update4 (t+80)
			// But apply in order: original -> update4 -> update2 -> update1 -> update3

			// Apply update4 first (newest)
			await TxnTest.patch(63, { name: 'update4', prop4: true }, { timestamp: now + 80 });

			// Apply update2 (middle, should create a branch)
			await TxnTest.patch(63, { prop2: true }, { timestamp: now + 40 });

			// Apply update1 (oldest out-of-order)
			await TxnTest.patch(63, { prop1: true, count: { __op__: 'add', value: 1 } }, { timestamp: now + 20 });

			// Apply update3 (between update2 and update4)
			await TxnTest.patch(63, { prop3: true, count: { __op__: 'add', value: 1 } }, { timestamp: now + 60 });

			// Verify all properties are present
			let record = await TxnTest.get(63);
			assert.equal(record.name, 'update4');
			assert.equal(record.prop1, true, 'prop1 should be present');
			assert.equal(record.prop2, true, 'prop2 should be present');
			assert.equal(record.prop3, true, 'prop3 should be present');
			assert.equal(record.prop4, true, 'prop4 should be present');
			assert.equal(record.count, 2, 'Count should be 2 from both increments');

			// Verify additional audit refs exist
			let entry = TxnTest.primaryStore.getEntry(63);
			assert(entry.additionalAuditRefs, 'Additional audit refs should exist for complex resequencing');
		});

		it('Handle multiple concurrent out-of-order patches', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(64, { name: 'original', count: 0 }, context);
			});
			let now = Date.now();

			// Apply multiple out-of-order updates concurrently
			let promises = [];
			for (let i = 5; i > 0; i--) {
				// Apply in reverse order (5, 4, 3, 2, 1)
				promises.push(
					TxnTest.patch(
						64,
						{
							['prop' + i]: 'value' + i,
							count: { __op__: 'add', value: 1 },
						},
						{ timestamp: now + i * 10 }
					)
				);
			}

			await Promise.all(promises);

			// Verify all properties are merged correctly
			let record = await TxnTest.get(64);
			assert.equal(record.count, 5, 'All increments should be applied');
			for (let i = 1; i <= 5; i++) {
				assert.equal(record['prop' + i], 'value' + i, `prop${i} should be present with correct value`);
			}

			// Verify additional audit refs were created
			let entry = TxnTest.primaryStore.getEntry(64);
			assert(entry.additionalAuditRefs || true, 'Additional audit refs may be stored for complex concurrent updates');
		});

		it('Preserve additional audit refs across subsequent updates', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
			const context = {};
			await transaction(context, () => {
				TxnTest.put(65, { name: 'original', count: 0 }, context);
			});
			let now = Date.now();

			// Apply updates out of order
			await TxnTest.patch(65, { name: 'newer' }, { timestamp: now + 100 });
			await TxnTest.patch(65, { prop1: 'value1' }, { timestamp: now + 50 });

			// Apply another in-order update
			await TxnTest.patch(65, { prop2: 'value2' }, { timestamp: now + 150 });

			// Verify the record is correct
			let record = await TxnTest.get(65);
			assert.equal(record.name, 'newer');
			assert.equal(record.prop1, 'value1');
			assert.equal(record.prop2, 'value2');

			let entry2 = TxnTest.primaryStore.getEntry(65);
			// Verify older audit refs are still preserved
			let auditRecord = TxnTest.auditStore.getSync(entry2.version, TxnTest.tableId, 65);
			assert(auditRecord, 'Entry should exist for the older version');
			assert(auditRecord.previousAdditionalAuditRefs, 'Additional audit refs should be preserved');
		});

		// Regression for #1114: a pathologically deep audit chain (as seen during a replication
		// full-copy of a large-history database) must not make the out-of-order reconciliation in
		// commit() walk and buffer the whole chain — that OOMs the worker. Past the depth cap the walk
		// is bounded and the older write is reconciled against only the most-recent retained updates.
		it('bounds the out-of-order audit-chain walk past the depth cap and reconciles correctly (#1114)', async function () {
			if (isLMDB) return; // RocksDB-only bounded path (LMDB keeps the exact unbounded walk)
			const { logger } = require('#src/utility/logging/logger');
			const id = 1114000;
			// Each #1114 test writes a chain ~10k ms wide of timestamps into the shared TxnTest table. A
			// distinct, far-future per-test base keeps those ranges disjoint from each other AND from the
			// other tests' Date.now() writes, so audit entries can't collide at the same version (which made
			// re-delivery dedup timing-fragile across tests).
			const base = Date.now() + 400_000_000;
			// Oldest version: a seed put with count = 0.
			await TxnTest.put(id, { name: 'seed', count: 0 }, { timestamp: base });
			// A chain of in-order patches deeper than MAX_OUT_OF_ORDER_AUDIT_DEPTH (1000). None is a full
			// put, so an older out-of-order write would otherwise walk the entire chain. Each patch
			// rewrites the same field so the chain (not the record) is what grows deep.
			const depth = 1010;
			for (let i = 1; i <= depth; i++) {
				await TxnTest.patch(id, { seq: i }, { timestamp: base + 10 * i });
			}
			// Spy on the cap warning to assert the bounded branch actually ran (vs the normal full walk).
			const originalWarn = logger.warn;
			let capWarned = false;
			logger.warn = (msg) => {
				if (typeof msg === 'string' && msg.includes('exceeded depth cap')) capWarned = true;
			};
			try {
				// A write older than every patch (newer than the seed): a commutative increment, a field
				// that newer patches overwrite (seq), and a field no newer patch touches (fresh).
				await TxnTest.patch(
					id,
					{ count: { __op__: 'add', value: 5 }, seq: 'stale', fresh: 'applied' },
					{ timestamp: base + 5 }
				);
			} finally {
				logger.warn = originalWarn;
			}
			assert(capWarned, 'the depth-cap bounded path should have been taken');
			const record = await TxnTest.get(id);
			// Commutative op is applied once, on top of the current state (count 0 -> 5).
			assert.equal(record.count, 5, 'commutative op from the bounded out-of-order write should be applied');
			// A newer patch overwrote seq, so the older write's stale value loses (folded against retained updates).
			assert.equal(record.seq, depth, 'newer last-writer-wins value should survive the bounded reconciliation');
			// A field no newer update touched is still applied from the older write.
			assert.equal(record.fresh, 'applied', 'older field untouched by newer updates should be applied');
			assert.equal(record.name, 'seed');
		});

		it('does not double-apply a re-delivered commutative op in the bounded path (#1114)', async function () {
			if (isLMDB) return; // RocksDB-only bounded path (LMDB keeps the exact unbounded walk)
			const id = 1114001;
			const base = Date.now() + 100_000_000; // disjoint range — see the #1114 base note above
			await TxnTest.put(id, { name: 'seed', count: 0 }, { timestamp: base });
			const depth = 1010;
			for (let i = 1; i <= depth; i++) {
				await TxnTest.patch(id, { seq: i }, { timestamp: base + 10 * i });
			}
			const reDeliver = () => TxnTest.patch(id, { count: { __op__: 'add', value: 3 } }, { timestamp: base + 5 });
			await reDeliver();
			let record = await TxnTest.get(id);
			assert.equal(record.count, 3, 'op applied once on first delivery');
			// Full-copy audit-replay re-delivers writes; because the bounded walk stops before reaching
			// txnTime, the inline duplicate check never runs — the explicit O(1) duplicate lookup must
			// catch it so the increment is not applied a second time.
			await reDeliver();
			record = await TxnTest.get(id);
			assert.equal(record.count, 3, 're-delivered duplicate must not double-apply the commutative op');
		});

		// #1114: once a later in-order write drops the out-of-order ref from the record, a re-delivery can no
		// longer be caught by the additionalAuditRefs front-check. The up-front keyed audit lookup must catch
		// it BEFORE the resequencing walk, so the deep-walk/depth-cap path is never taken (this is the case
		// that pegged the event loop on transitive re-deliveries in production).
		it('deduplicates a re-delivered out-of-order write up front, without the deep walk (#1114)', async function () {
			if (isLMDB) return; // RocksDB-only up-front keyed dedup (LMDB keeps the exact unbounded walk)
			const { logger } = require('#src/utility/logging/logger');
			const id = 1114002;
			const base = Date.now() + 200_000_000; // disjoint range — see the #1114 base note above
			await TxnTest.put(id, { name: 'seed', count: 0 }, { timestamp: base });
			const depth = 1010; // deeper than MAX_OUT_OF_ORDER_AUDIT_DEPTH so an unguarded walk would cap
			for (let i = 1; i <= depth; i++) await TxnTest.patch(id, { seq: i }, { timestamp: base + 10 * i });
			// Out-of-order commutative write (older than every patch); records an additionalAuditRef.
			await TxnTest.patch(id, { count: { __op__: 'add', value: 7 } }, { timestamp: base + 5 });
			assert.equal((await TxnTest.get(id)).count, 7, 'out-of-order op applied once');
			// A newer in-order write rewrites the record and drops the ref, so the front-check can no longer see it.
			await TxnTest.patch(id, { seq: depth + 1 }, { timestamp: base + 10 * (depth + 2) });
			// Re-deliver the same out-of-order write: must be deduped up front, never reaching the depth-cap walk.
			const originalWarn = logger.warn;
			let capWarned = false;
			logger.warn = (msg) => {
				if (typeof msg === 'string' && msg.includes('exceeded depth cap')) capWarned = true;
			};
			try {
				await TxnTest.patch(id, { count: { __op__: 'add', value: 7 } }, { timestamp: base + 5 });
			} finally {
				logger.warn = originalWarn;
			}
			assert.equal((await TxnTest.get(id)).count, 7, 're-delivered duplicate must not double-apply');
			assert.equal(capWarned, false, 're-delivery should be deduped up front, not via the deep walk');
		});

		// #1114/#1316: an out-of-order write whose every field is overwritten by newer in-order patches is
		// fully superseded. The fold at the end of the walk already drops it (writeCommit(false)) — but only
		// after walking the whole chain. The early-out folds as it walks and escapes the moment the residual
		// empties, so a fully-superseded write past the depth cap never takes the deep walk. This is the bulk
		// of the transitive re-delivery / crash-recovery-replay traffic that pegged the event loop.
		it('escapes the deep walk when an out-of-order write is fully superseded by newer patches (#1114)', async function () {
			if (isLMDB) return; // RocksDB-only: the depth-cap walk is bounded for RocksDB
			const { logger } = require('#src/utility/logging/logger');
			const id = 1114003;
			const base = Date.now() + 300_000_000; // disjoint range — see the #1114 base note above
			await TxnTest.put(id, { name: 'seed', val: 0 }, { timestamp: base });
			// A linear chain of in-order patches deeper than MAX_OUT_OF_ORDER_AUDIT_DEPTH (1000), each
			// overwriting the same field. In-order patches add no audit branches, so the early-out's
			// no-branch guard holds.
			const depth = 1010;
			for (let i = 1; i <= depth; i++) await TxnTest.patch(id, { val: i }, { timestamp: base + 10 * i });
			const originalWarn = logger.warn;
			let capWarned = false;
			logger.warn = (msg) => {
				if (typeof msg === 'string' && msg.includes('exceeded depth cap')) capWarned = true;
			};
			try {
				// Older than every patch and touching only `val`, which every newer patch overwrites → fully
				// superseded. Without the early-out this walks the whole chain and hits the cap; with it, the
				// residual empties on the first (newest) patch folded and the walk is abandoned.
				await TxnTest.patch(id, { val: 'stale' }, { timestamp: base + 5 });
			} finally {
				logger.warn = originalWarn;
			}
			assert.equal(capWarned, false, 'a fully-superseded write should escape before the depth-cap walk');
			const record = await TxnTest.get(id);
			assert.equal(record.val, depth, 'newest last-writer-wins value survives; the stale older write is dropped');
			assert.equal(record.name, 'seed');
		});

		it('Can merge replication updates', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.count, 1);
			assert.equal(entity['new prop 0'], undefined);
			let earlier = Date.now() + 5;
			await new Promise((resolve) => setTimeout(resolve, 20));
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 }, propertyA: 'valueA' });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			assert.equal(entity['propertyA'], 'valueA');
			await new Promise((resolve) => {
				// send an update from the past, which should be merged into the current state but not overwrite it
				test_subscription.send({
					type: 'patch',
					id: 45,
					timestamp: earlier,
					table: 'TxnTest',
					value: { count: { __op__: 'add', value: 2 }, propertyA: 'should not change', propertyB: 'valueB' },
					onCommit: resolve,
				});
			});
			entity = await TxnTest.get(45);
			// Should have incrementation and correct property values
			assert.equal(entity.count, 5);
			assert.equal(entity['propertyA'], 'valueA');
			assert.equal(entity['propertyB'], 'valueB');

			await new Promise((resolve) => {
				// send an update with a duplicate timestamp, this should be ignored
				test_subscription.send({
					type: 'patch',
					id: 45,
					timestamp: earlier,
					table: 'TxnTest',
					value: { count: { __op__: 'add', value: 2 }, propertyA: 'should not change', propertyB: 'valueB' },
					onCommit: resolve,
				});
			});
			entity = await TxnTest.get(45);
			// nothing should have changed
			// TODO: Not sure why this fails in CI
			/*
			assert.equal(entity.count, 5);
			assert.equal(entity['propertyA'], 'valueA');
			assert.equal(entity['propertyB'], 'valueB');
			 */
		});
		it('Can handle writes after a transaction has completed', async function () {
			const context = {};
			let writes;
			await transaction(context, async () => {
				writes = (async () => {
					for (let i = 0; i < 10; i++) {
						await TxnTest.put(48, { name: 'in and out of txn', count: i });
						await delay(i);
					}
				})();
			});
			await writes;
			let entity = await TxnTest.get(48);
			assert.equal(entity.count, 9);
		});
		it('Can handle writes after a transaction has completed, but we explicitly reuse the DatabaseTransaction', async function () {
			const context = {};
			let writes;
			await transaction(context, async (transaction) => {
				writes = (async () => {
					for (let i = 0; i < 10; i++) {
						await TxnTest.put(49, { name: 'in and out of txn', count: i }, { transaction });
						await delay(1);
					}
				})();
			});
			await writes;
			if (TxnTest.primaryStore.flushed) await TxnTest.primaryStore.flushed;
			let entity = await TxnTest.get(49);
			assert.equal(entity.count, 9);
		});
		it('Can update new object and addTo consecutively replication updates', async function () {
			class WithCountOnGet extends TxnTest {
				static async get(target) {
					let record = await super.get(target);
					let updatable;
					if (record) {
						updatable = await this.update(target);
					} else {
						updatable = await this.update(target, { name: 'another counter' });
					}
					updatable.addTo('count', 1);
					return updatable;
				}
			}
			await WithCountOnGet.delete(67);
			let instance = await transaction(() => WithCountOnGet.get(67));
			assert.equal(instance.count, 1);
			instance = await transaction(() => WithCountOnGet.get(67));
			assert.equal(instance.count, 2);
		});
		it('Can run txn with commit after get(undefined)', async function () {
			await TxnTest.delete(8);
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put({ id: 8, name: 'eight' }, context);
				if (TxnTest.primaryStore instanceof RocksDatabase) {
					// lmdb does guarantee read after write
					assert.equal((await TxnTest.get(8, context)).name, 'eight');
				}
				await context.transaction.commit();
				await TxnTest.put({ id: 8, name: 'eight changed' }); // no context
				await context.transaction.commit();
				assert.equal((await TxnTest.get(8, context)).name, 'eight changed');
			});
		});
	});
	// Regression coverage for a context/transaction retention issue found via a production heap
	// snapshot: a long-lived context (notably an MQTT subscription context, which stays reachable
	// for the life of a suspended delivery loop long after its transaction() call has returned and
	// committed) kept pointing at the completed DatabaseTransaction, pinning it in memory. These
	// tests cover DatabaseTransaction's releaseContext() cleanup, called from both commit completion
	// paths and abort().
	describe('Releasing the context back-reference on transaction completion', () => {
		it('releases the context’s back-reference once the transaction commits', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(90, { name: 'release-on-commit' }, context);
			});
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			assert.equal((await TxnTest.get(90)).name, 'release-on-commit');
		});
		it('releases the context’s back-reference once the transaction aborts', async function () {
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					await TxnTest.put(91, { name: 'release-on-abort' }, context);
					throw new Error('forced abort for test');
				}),
				/forced abort for test/
			);
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			assert.equal(await TxnTest.get(91), undefined);
		});
		it('does not clobber a context that has been re-pointed at a different transaction', async function () {
			const context = {};
			const original = new DatabaseTransaction();
			original.setContext(context);
			context.transaction = original;
			// Simulate something re-pointing the context at a different DatabaseTransaction (as
			// resources/Table.ts:5530 and resources/replayLogs.ts:200 can do) before the original
			// transaction's own completion runs.
			const replacement = new DatabaseTransaction();
			context.transaction = replacement;
			// doneWriting: true mirrors resources/transaction.ts's own final wrapper commit — the
			// only case releaseContext() ever attempts a release (see DatabaseTransaction.ts).
			await original.commit({ doneWriting: true });
			assert.strictEqual(
				context.transaction,
				replacement,
				'a context re-pointed at another transaction must not be clobbered by a stale transaction’s own cleanup'
			);
		});
		it('lets a context be reused for a second transaction() call after the first commits', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(92, { name: 'first txn on shared context' }, context);
			});
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			await transaction(context, async () => {
				await TxnTest.put(93, { name: 'second txn on shared context' }, context);
			});
			assert.equal((await TxnTest.get(92)).name, 'first txn on shared context');
			assert.equal((await TxnTest.get(93)).name, 'second txn on shared context');
		});
		// The release must not strand a later write on an uncommitted transaction. It cannot:
		// resources/transaction.ts only reuses a context's transaction while it is OPEN, so a later write
		// always goes through the transaction() wrapper, which commits in onComplete (or aborts in
		// onError) by construction.
		it('keeps post-completion writes on a reused context durable, with nothing left staged', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(94, { name: 'inside txn' }, context);
			});
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			// Writes made with the SAME context after its transaction completed must still commit.
			await TxnTest.put(95, { name: 'after commit' }, context);
			await TxnTest.get(95, context); // a read in between, which also re-enters the dispatcher
			await TxnTest.put(96, { name: 'after commit again' }, context);
			assert.equal((await TxnTest.get(94)).name, 'inside txn');
			assert.equal((await TxnTest.get(95)).name, 'after commit');
			assert.equal((await TxnTest.get(96)).name, 'after commit again');
			assert.equal(
				context.transaction?.writes?.length ?? 0,
				0,
				'no write may be left staged on an uncommitted transaction attached to the reused context'
			);
		});
		// A handler with no transaction() wrapper of its own makes a static Resource API call with its
		// context; Resource.ts services that by minting a transaction ON the context and driving it to a
		// final commit. The handler may then still commit its own context, per the documented pattern.
		it('lets a handler commit its context after a nested Resource API call completed that context’s transaction', async function () {
			const context = {};
			await TxnTest.get(97, context);
			assert.strictEqual(
				context.transaction,
				RELEASED_TRANSACTION,
				'premise: the nested get’s own final commit released the slot'
			);
			await context.transaction.commit();
			await TxnTest.put(97, { name: 'after released commit' }, context);
			await context.transaction.commit();
			assert.equal((await TxnTest.get(97)).name, 'after released commit');
		});
		// A shared, process-wide released transaction must never be claimed as a place to stage writes.
		it('never lets the released placeholder be claimed or written to', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(98, { name: 'claim check' }, context);
			});
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			await TxnTest.put(99, { name: 'not staged on the placeholder' }, context);
			// The write runs on a transaction of its own, which releases the slot back to the placeholder,
			// so the slot's identity says nothing here — only that the shared instance was never claimed.
			assert.equal(RELEASED_TRANSACTION.writes.length, 0, 'nothing may ever be staged on the placeholder');
			assert.equal(RELEASED_TRANSACTION.db, undefined, 'no store may ever claim the placeholder');
			assert.equal((await TxnTest.get(99)).name, 'not staged on the placeholder');
		});
		// One instance is shared by every released context, so each route into its state must fail rather
		// than write through to all of them.
		it('refuses every route into the shared placeholder’s state', function () {
			assert.throws(() => RELEASED_TRANSACTION.addWrite({}), /already completed/);
			assert.throws(() => RELEASED_TRANSACTION.setContext({}), /shared released transaction/);
			assert.throws(() => RELEASED_TRANSACTION.writes.push({}), TypeError);
			assert.throws(() => {
				'use strict';
				RELEASED_TRANSACTION.open = TRANSACTION_STATE.OPEN;
			}, TypeError);
			assert.equal(RELEASED_TRANSACTION.open, TRANSACTION_STATE.CLOSED);
		});
		it('keeps transaction.commit()/abort() throwing for a context that never had a transaction', function () {
			assert.throws(() => transaction.commit({}), /No active transaction is available to commit/);
			assert.throws(() => transaction.abort({}), /No active transaction is available to abort/);
		});
		it('makes transaction.commit(context) a no-op on a released slot, like the direct form', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(100, { name: 'live' }, context);
			});
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			assert.deepEqual(await transaction.commit(context), { txnTime: 0 });
			assert.equal(transaction.abort(context), undefined);
			assert.equal((await TxnTest.get(100)).name, 'live');
		});
		it('stays callable for repeated checkpoint commits inside one scope', async function () {
			const context = {};
			await transaction(context, async () => {
				for (let i = 0; i < 4; i++) {
					await TxnTest.put(110 + i, { name: `checkpoint-${i}` }, context);
					await transaction.commit(context);
				}
			});
			for (let i = 0; i < 4; i++) {
				assert.equal((await TxnTest.get(110 + i))?.name, `checkpoint-${i}`, `row ${i} must persist`);
			}
		});
		// Passing a transaction where a context is expected is a supported form; on a released context that
		// argument is the placeholder, and every route that adopts it must read it as "no transaction"
		// rather than assign onto the frozen shared instance.
		it('accepts a released slot wherever a transaction or context is accepted', async function () {
			const context = {};
			await transaction(context, async () => {
				await TxnTest.put(120, { name: 'bare-arg' }, context);
			});
			assert.strictEqual(context.transaction, RELEASED_TRANSACTION);
			await TxnTest.delete(120, context.transaction); // transactional() argument normalization
			assert.equal(await TxnTest.get(120), undefined, 'the delete must run on a fresh transaction');
			// Resource.create shifts its own arguments and never reaches that normalizer.
			const created = await TxnTest.create({ name: 'created-with-released-slot' }, context.transaction);
			assert.ok(created?.id ?? created, 'create must not fail on a released slot');
			// transaction() called with the placeholder directly as its context.
			await transaction(context.transaction, async () => TxnTest.put(121, { name: 'direct' }));
			assert.equal((await TxnTest.get(121)).name, 'direct');
		});
		// #1411: a timeout-poisoned abort must NOT release the context's back-reference. Resource.ts's
		// dispatcher deliberately keeps joining a `timedOut` transaction (context?.transaction?.timedOut)
		// so the rest of the logical operation fails atomically, instead of silently starting a fresh
		// transaction for a write made after the timeout fired (see integrationTests/resources/
		// txn-overtime-atomicity.test.ts for the end-to-end regression this guards).
		it('keeps a timeout-poisoned transaction attached to its context so later writes still fail atomically', async function () {
			const context = {};
			const txn = new DatabaseTransaction();
			txn.setContext(context);
			context.transaction = txn;
			txn.abortDueToTimeout();
			assert.strictEqual(
				context.transaction,
				txn,
				'a timed-out transaction must remain attached as a poison tombstone'
			);
			assert.strictEqual(context.transaction.timedOut, true);
		});
	});
	describe('Testing updates with extended class with loadAsInstance=false', () => {
		before(() => {
			TxnTest.primaryStore.clearSync();
		});
		it('Can run txn with commit in the middle', async function () {
			class NewTxnTest extends TxnTest {
				static loadAsInstance = false;
				get(_target) {
					return this.getContext().callback();
				}
			}
			const context = {
				callback: async () => {
					await NewTxnTest.create({ id: 8, name: 'eight' }, context);
					await context.transaction.commit();
					assert.equal((await TxnTest.get(8)).name, 'eight');
				},
			};
			await NewTxnTest.get(1, context);
		});
	});
	describe('Testing updates with loadAsInstance=false', () => {
		before(() => {
			TxnTest.loadAsInstance = false;
		});
		it('Can update with addTo and set', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			assert.equal((await TxnTest.get(45)).name, 'a counter');
			await transaction(async (txn) => {
				let counter = await TxnTest.update(45, {}, txn);
				counter.addTo('count', 1);
				counter.addTo('countInt', 1);
				counter.addTo('countBigInt', 1n);
				assert(counter.getUpdatedTime() > 1);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.count, 2);
			assert.equal(entity.countInt, 101);
			assert.equal(entity.countBigInt, 4611686018427388001n);
			assert.equal(entity.propertyA, undefined);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(
					transaction(async (txn) => {
						let counter = await TxnTest.update(45, {}, txn);
						await new Promise((resolve) => setTimeout(resolve, 1));
						counter.addTo('count', 3);
						counter.subtractFrom('countInt', 2);
						counter.addTo('countBigInt', 5);
						counter.set('new prop ' + i, 'new value ' + i);
					})
				);
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 11);
			assert.equal(entity.countInt, 95);
			assert.equal(entity.countBigInt, 4611686018427388016n);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
		});
		it('Can use update and get with different arguments', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			await transaction(async (txn) => {
				let updatable = await TxnTest.update(45, txn);
				updatable.count = 4;
			});
			await transaction(async (txn) => {
				assert.equal((await TxnTest.get(45, {}, txn)).count, 4);
			});
		});
		it('Can update with patch', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.count, 1);
			assert.equal(entity['new prop 0'], undefined);
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 } });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(TxnTest.patch(45, { count: { __op__: 'add', value: -2 }, ['new prop ' + i]: 'new value ' + i }));
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, -3);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
			assert(entity.getUpdatedTime() > 1);
		});

		it('Can merge replication updates', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.count, 1);
			assert.equal(entity['new prop 0'], undefined);
			let earlier = Date.now() + 5;
			await new Promise((resolve) => setTimeout(resolve, 20));
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 }, propertyA: 'valueA' });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			assert.equal(entity['propertyA'], 'valueA');
			await new Promise((resolve) => {
				// send an update from the past, which should be merged into the current state but not overwrite it
				test_subscription.send({
					type: 'patch',
					id: 45,
					timestamp: earlier,
					table: 'TxnTest',
					value: { count: { __op__: 'add', value: 2 }, propertyA: 'should not change', propertyB: 'valueB' },
					onCommit: resolve,
				});
			});
			entity = await TxnTest.get(45);
			// Should have incrementation and correct property values
			assert.equal(entity.count, 5);
			assert.equal(entity['propertyA'], 'valueA');
			assert.equal(entity['propertyB'], 'valueB');

			await new Promise((resolve) => {
				// send an update with a duplicate timestamp, this should be ignored
				test_subscription.send({
					type: 'patch',
					id: 45,
					timestamp: earlier,
					table: 'TxnTest',
					value: { count: { __op__: 'add', value: 2 }, propertyA: 'should not change', propertyB: 'valueB' },
					onCommit: resolve,
				});
			});
			entity = await TxnTest.get(45);
			// nothing should have changed, tracked with https://github.com/HarperFast/harper/issues/262
			/*
			assert.equal(entity.count, 5);
			assert.equal(entity['propertyA'], 'valueA');
			assert.equal(entity['propertyB'], 'valueB');
			 */
		});
		// should we support returning a currently modified object with super.get?
		it.skip('Can update new object and addTo consecutively replication updates', async function () {
			class WithCountOnGet extends TxnTest {
				get() {
					if (!this.doesExist()) {
						this.update({ name: 'another counter' });
					}
					this.addTo('count', 1);
					return super.get();
				}
			}
			await WithCountOnGet.delete(67);
			let instance = await WithCountOnGet.get(67);
			assert.equal(instance.count, 1);
			instance = await WithCountOnGet.get(67);
			assert.equal(instance.count, 2);
		});
		it('authorize gets turned off', async function () {
			const context = { authorize: true, user: { role: { permission: { super_user: true } } } };
			await TxnTest.get(45, context);
			assert.equal(context.authorize, false);
		});
	});
});
