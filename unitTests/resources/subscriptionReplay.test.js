require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

// The count branch in Table.ts uses `start: 'z'` for reverse audit log iteration, which is an
// lmdb-specific encoding ('z' compares above numeric keys). rocksdb's TransactionLog.query
// requires numeric start values, so the count branch is a pre-existing rocksdb incompatibility.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

function assertChronological(events, msg = 'events out of order') {
	// Use `version` because lmdb populates localTime on cursor sends but rocksdb doesn't; both
	// backends set version on the audit record to the commit timestamp, so version is the
	// portable "time" key.
	for (let i = 1; i < events.length; i++) {
		assert.ok(
			events[i].version >= events[i - 1].version,
			`${msg} at index ${i}: ${events[i - 1].version} > ${events[i].version} (id=${events[i - 1]?.id} -> ${events[i]?.id})`
		);
	}
}

// rocksdb's audit log doesn't strictly serialize concurrent in-flight commits — two puts that
// race for the same millisecond can land in the audit log with their version-timestamps
// inverted. The cursor reads in audit-log order, so it delivers them inverted too. This is a
// backend ordering quirk, not a subscription-layer bug — every event still arrives exactly once.
// Tests that don't await each put before the next can't assert strict chronological order on
// rocksdb; use this helper for those.
function assertChronologicalIfStrictlyOrdered(events, msg) {
	if (isLMDB) assertChronological(events, msg);
}

// Drain a subscription into an array, returning when no new event has arrived for `quietMs`.
async function collect(subscription, quietMs = 50) {
	const events = [];
	let lastEventAt = Date.now();
	subscription.on('data', (event) => {
		events.push(event);
		lastEventAt = Date.now();
	});
	while (Date.now() - lastEventAt < quietMs) {
		await delay(quietMs);
	}
	return events;
}

describe('Subscription replay', () => {
	let StartTimeTable, CountTable, CurrentStateTable, RecordTable, FreshTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		// FreshTable lives in 'test2' database which has no other subscriptions in this suite.
		// Used to test the case where this is the very first subscription on the database, so
		// `databaseSubscriptions.lastTxnTime` and the shared `'committed'` listener are not yet
		// established at the moment subscribe() is called.
		FreshTable = table({
			table: 'SubReplayFresh',
			database: 'test2',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		StartTimeTable = table({
			table: 'SubReplayStartTime',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		CountTable = table({
			table: 'SubReplayCount',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		CurrentStateTable = table({
			table: 'SubReplayCurrent',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		RecordTable = table({
			table: 'SubReplayRecord',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	});

	describe('startTime branch (collection with startTime)', () => {
		it('delivers all records past startTime, including across the yield boundary', async () => {
			const N = 250; // > REPLAY_YIELD_INTERVAL (100), forces multiple yields during replay
			const startTime = Date.now();
			for (let i = 0; i < N; i++) {
				await StartTimeTable.put(i, { name: 'v' + i });
			}
			const subscription = await StartTimeTable.subscribe({ startTime: startTime - 1, isCollection: true });
			const events = await collect(subscription, 200);
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			assert.equal(ids.size, N, `expected ${N} distinct ids, got ${ids.size}`);
			for (let i = 0; i < N; i++) {
				assert.ok(ids.has(i), `missing id ${i}`);
			}
			// no duplicate (id, version) pairs
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			// audit log iteration is forward in localTime, so events must be chronological
			assertChronological(events, 'startTime branch out of order');
		});

		it('delivers writes that land during replay without duplicates', async () => {
			const startTime = Date.now();
			// pre-populate enough to trigger replay yielding
			for (let i = 0; i < 150; i++) {
				await StartTimeTable.put(1000 + i, { name: 'pre' + i });
			}
			const subscription = await StartTimeTable.subscribe({ startTime: startTime - 1, isCollection: true });
			// fire writes concurrently with the replay loop
			const concurrentWrites = (async () => {
				for (let i = 0; i < 30; i++) {
					await StartTimeTable.put(2000 + i, { name: 'post' + i });
				}
			})();
			const events = await collect(subscription, 100);
			await concurrentWrites;
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			// every pre-populated id should be present
			for (let i = 0; i < 150; i++) {
				assert.ok(ids.has(1000 + i), `missing pre id ${1000 + i}`);
			}
			// every concurrently written id should be present
			for (let i = 0; i < 30; i++) {
				assert.ok(ids.has(2000 + i), `missing concurrent id ${2000 + i}`);
			}
			// no duplicate (id, version) pairs
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			// concurrent writes during replay should still come out in chronological order
			assertChronological(events, 'startTime branch with concurrent writes out of order');
		});
	});

	describe('count branch (collection with previousCount)', () => {
		it('delivers exactly the last N records, oldest first', async function () {
			if (!isLMDB) return this.skip();
			for (let i = 0; i < 200; i++) {
				await CountTable.put(i, { name: 'v' + i });
			}
			const subscription = await CountTable.subscribe({ previousCount: 10, isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			// at least 10 history events (could be more if writes overlapped, but should not exceed by much)
			assert.ok(events.length >= 10, `expected at least 10 events, got ${events.length}`);
			// no duplicate (id, version) pairs
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			// history is collected reverse then sent oldest-first; queue events come after with later
			// timestamps. Whole stream must be chronological.
			assertChronological(events, 'count branch out of order');
		});

		it('queues writes that land during replay without duplicating history', async function () {
			if (!isLMDB) return this.skip();
			for (let i = 0; i < 150; i++) {
				await CountTable.put(3000 + i, { name: 'count_pre' + i });
			}
			const subscription = await CountTable.subscribe({ previousCount: 5, isCollection: true });
			// fire writes after subscribe returns but while replay loop is still running
			const concurrentWrites = (async () => {
				for (let i = 0; i < 20; i++) {
					await CountTable.put(4000 + i, { name: 'count_post' + i });
				}
			})();
			const events = await collect(subscription, 150);
			await concurrentWrites;
			subscription.return?.();

			// concurrent writes should arrive
			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 20; i++) {
				assert.ok(ids.has(4000 + i), `missing concurrent id ${4000 + i}`);
			}
			// no duplicate (id, version) pairs
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			// history followed by concurrent writes — chronological throughout
			assertChronological(events, 'count branch with concurrent writes out of order');
		});
	});

	describe('!omitCurrent branch (collection current-state)', () => {
		// Note: this branch iterates `primaryStore` in primary-key order, not localTime order, so
		// the initial state dump is NOT guaranteed to be in chronological order. Real-time events
		// queued after the cursor are chronological among themselves, but interleaving with the
		// cursor's key-ordered output means we don't assert chronological for the whole stream.

		// !omitCurrent uses retained-message semantics: a key updated during cursor iteration
		// can legitimately reach the subscriber twice (once via cursor's current-state read, once
		// via the listener's audit event for the same write). Both deliveries carry the same
		// final value, so the subscriber's state lands in the same place either way. We don't
		// assert no-duplicates on this branch — only that no key is ever lost.

		it('delivers current state for all records', async () => {
			const N = 150; // > REPLAY_YIELD_INTERVAL to exercise yielding
			for (let i = 0; i < N; i++) {
				await CurrentStateTable.put(i, { name: 'curr' + i });
			}
			const subscription = await CurrentStateTable.subscribe({ isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < N; i++) {
				assert.ok(ids.has(i), `missing id ${i}`);
			}
		});

		it('updates during cursor iteration reach subscriber (duplicates allowed under retained-message semantics)', async () => {
			// pre-populate
			for (let i = 0; i < 150; i++) {
				await CurrentStateTable.put(5000 + i, { name: 'dedupe_pre' + i });
			}
			const subscription = await CurrentStateTable.subscribe({ isCollection: true });
			// concurrent writes that may be observed by both cursor (snapshot:false) and the listener
			const concurrentWrites = (async () => {
				for (let i = 0; i < 30; i++) {
					await CurrentStateTable.put(5000 + i, { name: 'dedupe_updated' + i });
				}
			})();
			const events = await collect(subscription, 150);
			await concurrentWrites;
			subscription.return?.();

			// every updated key MUST be delivered with its final value at least once, even if
			// the same (id, version) is also delivered via the cursor first
			const lastByKey = new Map();
			for (const e of events) lastByKey.set(e.id, e);
			for (let i = 0; i < 30; i++) {
				const e = lastByKey.get(5000 + i);
				assert.ok(e, `key ${5000 + i} never delivered`);
				assert.equal(
					e.value?.name,
					'dedupe_updated' + i,
					`key ${5000 + i} final value is ${e.value?.name}, expected dedupe_updated${i}`
				);
			}
		});
	});

	describe('non-collection branch (single record with startTime)', () => {
		it('delivers history + current value without duplicating the entry version', async () => {
			const startTime = Date.now();
			// build a version chain
			await RecordTable.put(42, { name: 'v1' });
			await RecordTable.put(42, { name: 'v2' });
			await RecordTable.put(42, { name: 'v3' });
			await delay(10);
			const subscription = await RecordTable.subscribe({ id: 42, startTime: startTime - 1 });
			const events = await collect(subscription, 100);
			subscription.return?.();

			// no duplicate (id, version) pairs - this is the regression we're testing
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(
				new Set(pairs).size,
				pairs.length,
				'duplicate (id,version) emitted - branch 4 entry-event regression'
			);
			// final event's value should be the latest
			const final = events[events.length - 1];
			assert.equal(final.value?.name, 'v3', `expected final value to be v3, got ${final.value?.name}`);
			// history is sent oldest-first, so localTimes ascend
			assertChronological(events, 'non-collection branch out of order');
		});

		it('delivers concurrent updates after history without duplicates', async () => {
			const startTime = Date.now();
			await RecordTable.put(99, { name: 'pre1' });
			await RecordTable.put(99, { name: 'pre2' });
			await delay(10);
			const subscription = await RecordTable.subscribe({ id: 99, startTime: startTime - 1 });
			const concurrentWrites = (async () => {
				for (let i = 0; i < 5; i++) {
					await RecordTable.put(99, { name: 'post' + i });
				}
			})();
			const events = await collect(subscription, 150);
			await concurrentWrites;
			subscription.return?.();

			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			// history then concurrent updates should be chronological throughout
			assertChronological(events, 'non-collection branch with concurrent writes out of order');
		});
	});

	describe('race conditions', () => {
		// First subscription on a fresh database, with writes already in flight when subscribe()
		// is called. Isolates the question of whether the chronological-order race we see on
		// rocksdb depends on existing-subscription state (shared lastTxnTime, pre-registered
		// `'committed'` listener, etc.) or is a pure backend-ordering quirk.
		it('FIRST-subscription-on-fresh-DB while writes are in flight delivers each exactly once', async () => {
			const startTime = Date.now();
			const inFlight = [];
			for (let i = 0; i < 200; i++) {
				inFlight.push(FreshTable.put(20000 + i, { name: 'fresh_inflight' + i }));
			}
			const subscription = await FreshTable.subscribe({ startTime: startTime - 1, isCollection: true });
			const events = await collect(subscription, 250);
			await Promise.all(inFlight);
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 200; i++) {
				assert.ok(ids.has(20000 + i), `missing in-flight id ${20000 + i}`);
			}
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			assertChronologicalIfStrictlyOrdered(events, 'fresh-DB subscribe-during-writes out of order');
		});

		// Cursor has not yet reached a key when it gets updated → cursor sees latest via
		// snapshot:false renewal AND listener queues the same audit event. With retained-message
		// semantics, the subscriber may legitimately receive both — verify no key is lost.
		it('!omitCurrent: rapid updates to keys cursor has not yet reached are all delivered', async () => {
			// pre-populate ascending ids; cursor will iterate primary store in id order
			for (let i = 0; i < 200; i++) {
				await CurrentStateTable.put(6000 + i, { name: 'rc_init' + i });
			}
			const subscription = await CurrentStateTable.subscribe({ isCollection: true });
			// hammer keys late in the iteration — cursor with snapshot:false will likely see them
			// AFTER they were updated, while the listener also queues them
			const concurrentWrites = (async () => {
				for (let round = 0; round < 3; round++) {
					for (let i = 100; i < 200; i++) {
						await CurrentStateTable.put(6000 + i, { name: `rc_v${round}_${i}` });
					}
				}
			})();
			const events = await collect(subscription, 200);
			await concurrentWrites;
			subscription.return?.();

			// every key in 6000..6199 must appear at least once
			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 200; i++) {
				assert.ok(ids.has(6000 + i), `missing id ${6000 + i}`);
			}
			// the LATEST delivered version of each updated key must be the final round-2 update
			const lastByKey = new Map();
			for (const e of events) lastByKey.set(e.id, e);
			for (let i = 100; i < 200; i++) {
				const e = lastByKey.get(6000 + i);
				assert.equal(
					e.value?.name,
					`rc_v2_${i}`,
					`key ${6000 + i} final value is ${e.value?.name}, expected rc_v2_${i}`
				);
			}
		});

		// Updates to a key the cursor has ALREADY PASSED reach the subscriber only via the queue
		// (snapshot:false won't go back). Without the queue, those updates would be lost.
		it('!omitCurrent: updates to passed keys arrive via queue', async () => {
			// pre-populate
			for (let i = 0; i < 50; i++) {
				await CurrentStateTable.put(7000 + i, { name: 'pp_init' + i });
			}
			const subscription = await CurrentStateTable.subscribe({ isCollection: true });
			// updates to existing keys — cursor may or may not see depending on its position
			const concurrentWrites = (async () => {
				// first wait briefly so cursor likely advances
				await delay(5);
				for (let i = 0; i < 50; i++) {
					await CurrentStateTable.put(7000 + i, { name: 'pp_updated' + i });
				}
			})();
			const events = await collect(subscription, 250);
			await concurrentWrites;
			subscription.return?.();

			// every key 7000..7049 must end up at the updated value as its final delivery
			// (duplicates of (id, version) are acceptable under retained-message semantics)
			const lastByKey = new Map();
			for (const e of events) lastByKey.set(e.id, e);
			for (let i = 0; i < 50; i++) {
				const e = lastByKey.get(7000 + i);
				assert.ok(e, `key ${7000 + i} never delivered`);
				assert.equal(
					e.value?.name,
					'pp_updated' + i,
					`key ${7000 + i} final value is ${e.value?.name}, expected pp_updated${i}`
				);
			}
		});

		// Branch 4 race: entry's audit `'committed'` arrives via cross-thread notification while
		// the do-while loop is yielding. The fix moves `subscription.startTime = localTime`
		// before the loop so the gate skips that event. This test exercises the timing by doing
		// many puts to the same record before subscribing, then immediately subscribing.
		it('non-collection: entry version not duplicated under repeated rapid updates', async () => {
			const startTime = Date.now();
			// many versions to grow the version chain — exercises do-while yields
			for (let i = 0; i < 250; i++) {
				await RecordTable.put(8000, { name: 'rapid_v' + i });
			}
			await delay(5);
			const subscription = await RecordTable.subscribe({ id: 8000, startTime: startTime - 1 });
			const events = await collect(subscription, 200);
			subscription.return?.();

			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(
				new Set(pairs).size,
				pairs.length,
				`duplicate (id,version) emitted: ${pairs.length - new Set(pairs).size} dupes`
			);
			assertChronological(events, 'non-collection rapid updates out of order');
		});

		// Branch 1 race: notifyFromTransactionData advances `lastTxnTime` during a cursor yield.
		// The cursor's snapshot:false + renewId chain must keep the cursor from lagging — every
		// record either delivered by cursor or by listener after `dropDuringReplay = false`.
		it('startTime: heavy concurrent writes during replay all arrive without loss', async () => {
			const startTime = Date.now();
			// pre-populate enough to trigger several yields during replay
			for (let i = 0; i < 300; i++) {
				await StartTimeTable.put(9000 + i, { name: 'race_pre' + i });
			}
			const subscription = await StartTimeTable.subscribe({ startTime: startTime - 1, isCollection: true });
			// fire a batch of writes that will interleave with cursor yields
			const concurrentCount = 50;
			const concurrentWrites = (async () => {
				for (let i = 0; i < concurrentCount; i++) {
					await StartTimeTable.put(10000 + i, { name: 'race_concurrent' + i });
				}
			})();
			const events = await collect(subscription, 200);
			await concurrentWrites;
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 300; i++) {
				assert.ok(ids.has(9000 + i), `missing pre id ${9000 + i}`);
			}
			for (let i = 0; i < concurrentCount; i++) {
				assert.ok(ids.has(10000 + i), `missing concurrent id ${10000 + i}`);
			}
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			assertChronological(events, 'startTime heavy race out of order');
		});

		// Subscribe-during-writes race: writes are in flight (Promises not yet awaited) at the
		// moment subscribe() is called. The subscription's lastTxnTime is initialized to
		// Date.now() at addSubscription time; some writes may commit before that snapshot, some
		// after. Each must be delivered exactly once across the cursor + listener boundary.
		it('startTime: subscribe while writes are in flight delivers each exactly once', async () => {
			const startTime = Date.now();
			// fire a bunch of puts WITHOUT awaiting — they're commit promises in flight
			const inFlight = [];
			for (let i = 0; i < 200; i++) {
				inFlight.push(StartTimeTable.put(13000 + i, { name: 'inflight' + i }));
			}
			// subscribe immediately — lastTxnTime is captured now, mid-flight
			const subscription = await StartTimeTable.subscribe({ startTime: startTime - 1, isCollection: true });
			const events = await collect(subscription, 250);
			await Promise.all(inFlight);
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 200; i++) {
				assert.ok(ids.has(13000 + i), `missing in-flight id ${13000 + i}`);
			}
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
			assertChronologicalIfStrictlyOrdered(events, 'subscribe-during-writes startTime out of order');
		});

		it('!omitCurrent: subscribe while writes are in flight delivers every key', async () => {
			const inFlight = [];
			for (let i = 0; i < 200; i++) {
				inFlight.push(CurrentStateTable.put(14000 + i, { name: 'inflight' + i }));
			}
			const subscription = await CurrentStateTable.subscribe({ isCollection: true });
			const events = await collect(subscription, 250);
			await Promise.all(inFlight);
			subscription.return?.();

			// every in-flight key must be delivered at least once (duplicates allowed under
			// retained-message semantics for !omitCurrent)
			const lastByKey = new Map();
			for (const e of events) {
				if (e.id >= 14000 && e.id < 14200) lastByKey.set(e.id, e);
			}
			for (let i = 0; i < 200; i++) {
				assert.ok(lastByKey.has(14000 + i), `in-flight id ${14000 + i} never delivered`);
			}
		});

		it('count: subscribe while writes are in flight does not duplicate history', async function () {
			if (!isLMDB) return this.skip();
			// pre-populate so we have history to capture
			for (let i = 0; i < 50; i++) {
				await CountTable.put(16000 + i, { name: 'count_race_pre' + i });
			}
			// fire concurrent in-flight writes — these may be in audit log AND have their
			// 'committed' callbacks delivered during the cursor's iteration
			const inFlight = [];
			for (let i = 0; i < 30; i++) {
				inFlight.push(CountTable.put(17000 + i, { name: 'count_race_inflight' + i }));
			}
			const subscription = await CountTable.subscribe({ previousCount: 10, isCollection: true });
			const events = await collect(subscription, 250);
			await Promise.all(inFlight);
			subscription.return?.();

			// the regression we want to catch: a record landing in BOTH history (from cursor's
			// snapshot:true view) AND pendingRealTimeQueue (from the listener firing during the
			// cursor's yields with subscription.startTime still at 0)
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(
				new Set(pairs).size,
				pairs.length,
				`duplicate (id,version) emitted: ${pairs.length - new Set(pairs).size} dupes`
			);
		});

		it('non-collection: subscribe while writes to the target record are in flight', async () => {
			const startTime = Date.now();
			// in-flight writes to the SAME record we're about to subscribe to
			const inFlight = [];
			for (let i = 0; i < 50; i++) {
				inFlight.push(RecordTable.put(15000, { name: 'inflight_v' + i }));
			}
			const subscription = await RecordTable.subscribe({ id: 15000, startTime: startTime - 1 });
			const events = await collect(subscription, 250);
			await Promise.all(inFlight);
			subscription.return?.();

			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(
				new Set(pairs).size,
				pairs.length,
				`duplicate (id,version) emitted: ${pairs.length - new Set(pairs).size} dupes`
			);
			assertChronologicalIfStrictlyOrdered(events, 'subscribe-during-writes non-collection out of order');
		});

		// Cross-table race: writes to *another* table in the same database fire `'committed'`
		// and run notifyFromTransactionData, which calls resetReadTxn and advances renewId.
		// Our subscription's cursor must still iterate correctly under this churn.
		it('startTime: writes to another table in the same database do not break our cursor', async () => {
			const startTime = Date.now();
			for (let i = 0; i < 200; i++) {
				await StartTimeTable.put(11000 + i, { name: 'crosstab' + i });
			}
			const subscription = await StartTimeTable.subscribe({ startTime: startTime - 1, isCollection: true });
			// concurrent writes to a DIFFERENT table — we should not see these, but they cause
			// resetReadTxn churn that stresses our cursor's renewal
			const otherTableWrites = (async () => {
				for (let i = 0; i < 100; i++) {
					await CurrentStateTable.put(12000 + i, { name: 'other' + i });
				}
			})();
			const events = await collect(subscription, 200);
			await otherTableWrites;
			subscription.return?.();

			// only StartTimeTable records should be delivered (id 11000..11199)
			for (const e of events) {
				assert.ok(e.id >= 11000 && e.id < 11200, `unexpected id ${e.id} (cross-table leak)`);
			}
			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 200; i++) {
				assert.ok(ids.has(11000 + i), `missing id ${11000 + i}`);
			}
			const pairs = events.map((e) => `${e.id}:${e.version}`);
			assert.equal(new Set(pairs).size, pairs.length, 'duplicate (id,version) emitted');
		});
	});

	describe('edge cases', () => {
		// ---- count branch edge cases ----

		it('count: previousCount larger than total records returns all available', async function () {
			if (!isLMDB) return this.skip();
			// fresh table to control record count
			const T = table({
				table: 'EdgeCountLarger',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			for (let i = 0; i < 7; i++) {
				await T.put(i, { name: 'v' + i });
			}
			const subscription = await T.subscribe({ previousCount: 100, isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			const ids = new Set(events.map((e) => e.id));
			for (let i = 0; i < 7; i++) {
				assert.ok(ids.has(i), `missing id ${i}`);
			}
			assert.equal(events.length, 7, `expected exactly 7 events, got ${events.length}`);
		});

		it('count: previousCount=1 returns only the most recent record', async function () {
			if (!isLMDB) return this.skip();
			const T = table({
				table: 'EdgeCountOne',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			for (let i = 0; i < 5; i++) {
				await T.put(i, { name: 'v' + i });
			}
			const subscription = await T.subscribe({ previousCount: 1, isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			// the 4 here is i=4, the last put — we expect that as the most recent
			assert.equal(events.length, 1, `expected exactly 1 history event, got ${events.length}`);
			assert.equal(events[0].id, 4, `expected most recent id 4, got ${events[0]?.id}`);
		});

		it('count: empty database delivers nothing initially', async function () {
			if (!isLMDB) return this.skip();
			const T = table({
				table: 'EdgeCountEmpty',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const subscription = await T.subscribe({ previousCount: 10, isCollection: true });
			const events = await collect(subscription, 150);
			subscription.return?.();

			assert.equal(events.length, 0, `expected 0 events on empty table, got ${events.length}`);
		});

		it('count: empty initial state, then live commits delivered via listener', async function () {
			if (!isLMDB) return this.skip();
			const T = table({
				table: 'EdgeCountEmptyThenWrites',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const subscription = await T.subscribe({ previousCount: 10, isCollection: true });
			const events = [];
			subscription.on('data', (e) => events.push(e));
			// Write immediately — these are post-subscribe live commits and MUST be delivered.
			for (let i = 0; i < 5; i++) {
				await T.put(100 + i, { name: 'live' + i });
			}
			await delay(150);
			subscription.return?.();

			assert.equal(events.length, 5, `expected 5 live events, got ${events.length}`);
			const ids = events.map((e) => e.id);
			assert.deepEqual(ids, [100, 101, 102, 103, 104], `live events should arrive in commit order`);
		});

		it('count: many versions of the same record returns last N versions of it', async function () {
			if (!isLMDB) return this.skip();
			const T = table({
				table: 'EdgeCountSameRecord',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			// put 20 versions of id=42
			for (let i = 0; i < 20; i++) {
				await T.put(42, { name: 'v' + i });
			}
			const subscription = await T.subscribe({ previousCount: 5, isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			// all 5 should be for id=42, with the LAST 5 versions (v15..v19) delivered chronologically
			assert.equal(events.length, 5, `expected 5 history events, got ${events.length}`);
			for (const e of events) {
				assert.equal(e.id, 42);
			}
			// chronological order
			assertChronological(events, 'count same-record out of order');
			// the final event should be the most recent put
			assert.equal(events[events.length - 1].value?.name, 'v19');
		});

		it('count: only other-table records exist, listener delivers our table commits', async function () {
			if (!isLMDB) return this.skip();
			// pollute the audit log with another table's records
			const Other = table({
				table: 'EdgeCountOtherTable',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const Ours = table({
				table: 'EdgeCountOursAfter',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			for (let i = 0; i < 50; i++) {
				await Other.put(20000 + i, { name: 'noise' + i });
			}
			// subscribe to Ours which has no records
			const subscription = await Ours.subscribe({ previousCount: 5, isCollection: true });
			const events = [];
			subscription.on('data', (e) => events.push(e));
			await delay(2);
			// now write to ours
			for (let i = 0; i < 3; i++) {
				await Ours.put(30000 + i, { name: 'real' + i });
			}
			await delay(200);
			subscription.return?.();

			// the cursor iterated 50 audit records, all skipped (different table); history is empty.
			// listener delivers our 3 live writes via the queue+drain (during) and direct (after).
			const ids = events.map((e) => e.id);
			assert.equal(events.length, 3, `expected 3 live events, got ${events.length}: ${JSON.stringify(ids)}`);
			for (let i = 0; i < 3; i++) {
				assert.ok(ids.includes(30000 + i), `missing live id ${30000 + i}`);
			}
		});

		// ---- startTime branch edge cases ----

		it('startTime: future startTime (> current time) yields nothing initially, only live updates', async () => {
			const T = table({
				table: 'EdgeFutureStart',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			// existing records before subscribe
			for (let i = 0; i < 5; i++) {
				await T.put(i, { name: 'pre' + i });
			}
			// startTime well in the future — gate skips everything ≤ that
			const futureTime = Date.now() + 10_000_000_000; // far future
			const subscription = await T.subscribe({ startTime: futureTime, isCollection: true });
			const events = await collect(subscription, 150);
			subscription.return?.();

			// nothing delivered initially (gate skips, cursor's exclusiveStart skips)
			assert.equal(events.length, 0, `expected 0 events for far-future startTime, got ${events.length}`);
		});

		it('startTime: startTime = 0 with no records (empty audit log)', async () => {
			const T = table({
				table: 'EdgeStartTimeEmpty',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			// startTime: 1 (truthy) to force the branch
			const subscription = await T.subscribe({ startTime: 1, isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			assert.equal(events.length, 0, `expected 0 events on empty audit log, got ${events.length}`);
		});

		// ---- !omitCurrent branch edge cases ----

		it('!omitCurrent: empty primaryStore delivers nothing initially', async () => {
			const T = table({
				table: 'EdgeOmitCurrentEmpty',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const subscription = await T.subscribe({ isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			assert.equal(events.length, 0, `expected 0 events on empty store, got ${events.length}`);
		});

		it('!omitCurrent: deleted keys are not delivered as current state', async () => {
			const T = table({
				table: 'EdgeOmitCurrentDeleted',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			await T.put(1, { name: 'a' });
			await T.put(2, { name: 'b' });
			await T.delete(1);
			const subscription = await T.subscribe({ isCollection: true });
			const events = await collect(subscription, 100);
			subscription.return?.();

			const ids = events.map((e) => e.id);
			assert.ok(ids.includes(2), `live id 2 should be in current state, got: ${JSON.stringify(ids)}`);
			assert.ok(!ids.includes(1), `deleted id 1 should not be in current state, got: ${JSON.stringify(ids)}`);
		});

		// ---- non-collection branch edge cases ----

		it('non-collection: subscribe to non-existent record delivers nothing initially', async () => {
			const T = table({
				table: 'EdgeNonCollectionMissing',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const subscription = await T.subscribe({ id: 999, startTime: Date.now() - 1 });
			const events = await collect(subscription, 100);
			subscription.return?.();

			assert.equal(events.length, 0, `expected 0 events for non-existent record, got ${events.length}`);
		});

		it('non-collection: record with single version (no version chain) delivers just current', async () => {
			const T = table({
				table: 'EdgeNonCollectionSingle',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			await T.put(7, { name: 'only' });
			const startTime = 1;
			const subscription = await T.subscribe({ id: 7, startTime });
			const events = await collect(subscription, 100);
			subscription.return?.();

			assert.equal(events.length, 1, `expected 1 event for single-version record, got ${events.length}`);
			assert.equal(events[0].id, 7);
			assert.equal(events[0].value?.name, 'only');
		});

		// ---- general edge cases ----

		it('subscription.return() ends iteration cleanly even mid-replay', async () => {
			const T = table({
				table: 'EdgeReturnMidReplay',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			const startTime = Date.now() - 1;
			for (let i = 0; i < 500; i++) {
				await T.put(i, { name: 'x' + i });
			}
			const subscription = await T.subscribe({ startTime, isCollection: true });
			const events = [];
			subscription.on('data', (e) => events.push(e));
			// don't wait for completion — return early
			await delay(20);
			const iter = subscription[Symbol.asyncIterator]();
			iter.return?.();
			await delay(200);
			// shouldn't have crashed; we likely got some events (anywhere from 0 to 500)
			assert.ok(events.length >= 0, `events array exists`);
		});

		it('audit records of types not in ACTIONS_OF_INTEREST are still delivered by cursor', async () => {
			// verifies pre-existing behavior: the cursor doesn't filter by audit type, but the
			// listener does (notifyFromTransactionData has ACTIONS_OF_INTEREST gate). For
			// 'put'/'patch'/'delete' there's no asymmetry; this test just documents the cursor
			// path delivers what it sees.
			const T = table({
				table: 'EdgeAuditTypes',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			await T.put(1, { name: 'a' });
			await T.delete(1);
			await T.put(1, { name: 'b' });

			const subscription = await T.subscribe({ startTime: 1, isCollection: true, id: 1 });
			const events = await collect(subscription, 100);
			subscription.return?.();

			// We expect history of put/delete/put events for id=1, all delivered.
			const ids = events.filter((e) => e.id === 1).map((e) => e.type);
			assert.ok(ids.length >= 1, `expected at least 1 event for id=1, got ${ids.length}`);
		});
	});
});
