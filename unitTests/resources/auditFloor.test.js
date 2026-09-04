/**
 * The audit staleness floor (harper#2447). A consumer resuming incremental audit-log consumption
 * from a saved cursor has to be able to tell a complete catch-up from a truncated one;
 * `oldestRetainedAuditTime` is the primitive that answers it, and the invariant these tests defend
 * is one-directional: the floor may ask for a resync that was not strictly necessary, but it must
 * never certify a cursor a prune has already truncated. Pruning is the whole of what it covers — a
 * state copy that rolls a database back (`restore_backup`, a RocksDB checkpoint) reinstalls an older
 * floor along with everything else, and needs a database generation instead (harper#2451).
 */
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const {
	getAuditFloor: oldestRetainedAuditTime,
	establishAuditFloor,
	raiseAuditFloor,
	purgeAgedLogs,
	setAuditRetention,
	auditRetention,
} = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const os = require('node:os');
const path = require('node:path');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');
const AUDIT_FLOOR_BOOTSTRAP_KEY = Symbol.for('audit-floor-bootstrap');
const ORIGINAL_CLEANUP_DELAY = 10_000; // setAuditRetention's own default, which it does not expose

// A cursor records the last position already processed, so a cursor AT the floor is safe.
const canResumeFrom = (cursor, floor) => cursor >= floor;

function auditEntries(auditStore) {
	const entries = [];
	for (const record of auditStore.getRange({ start: 1 })) {
		entries.push({ tableId: record.tableId, localTime: record.localTime });
	}
	return entries;
}

/** The epoch `establishAuditFloor` recorded as a guess, or undefined when it recorded none. */
function bootstrapEpoch(auditStore) {
	const stored = auditStore.getBinary(AUDIT_FLOOR_BOOTSTRAP_KEY);
	return stored === undefined ? undefined : new Float64Array(stored.slice().buffer)[0];
}

/** Clear a record on either engine: on RocksDB the floor lives in the root store, whose log store's own remove() is a no-op. */
async function clearRecord(auditStore, key) {
	const root = auditStore.rootStore;
	if (typeof root?.removeSync === 'function') root.removeSync(key);
	await auditStore.remove(key);
}

function encodeFloorBytes(value) {
	const target = new Float64Array(1);
	target[0] = value;
	return new Uint8Array(target.buffer.slice(0));
}

/**
 * A table in a database of its own. The floor is database-scoped, so a test that moves it would
 * otherwise decide what every later test starts from — and a floor pushed into the future silently
 * turns a later `raiseAuditFloor` into a no-op.
 */
function tableInOwnDatabase(name) {
	return table({
		table: name,
		database: `auditFloor_${name}`,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
	});
}

describe('audit staleness floor', () => {
	let Audited, Sibling, originalRetention;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		originalRetention = auditRetention;
		const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
		Audited = table({ table: 'FloorAudited', database: 'auditFloorDB', attributes });
		Sibling = table({ table: 'FloorSibling', database: 'auditFloorDB', attributes });
	});

	after(() => {
		// both arguments: the second sets the module-global default cleanup delay, and restoring only the
		// retention leaves every audit store opened later in this mocha process looping at 1 ms
		setAuditRetention(originalRetention, ORIGINAL_CLEANUP_DELAY);
	});

	it('gives a new database a floor that admits every cursor it could have produced', async () => {
		const floor = Audited.oldestRetainedAuditTime();
		assert.ok(Number.isFinite(floor), `a freshly opened database should have a known floor, got ${floor}`);
		await Audited.put('admits-1', { name: 'one' });
		await Audited.put('admits-2', { name: 'two' });
		for (const entry of auditEntries(Audited.auditStore)) {
			assert.ok(
				canResumeFrom(entry.localTime, floor),
				`entry at ${entry.localTime} is retained but reads as below the floor ${floor}`
			);
		}
	});

	it('reports the same database-scoped floor to every table in the database', () => {
		assert.strictEqual(Audited.oldestRetainedAuditTime(), Sibling.oldestRetainedAuditTime());
	});

	it('does not leak a floor across databases', () => {
		const raised = tableInOwnDatabase('Raised');
		const untouched = tableInOwnDatabase('Untouched');
		const before = untouched.oldestRetainedAuditTime();
		const cutoff = Date.now() + 60_000;
		raiseAuditFloor(raised.auditStore, cutoff);
		assert.strictEqual(raised.oldestRetainedAuditTime(), cutoff, 'precondition: the raise landed');
		assert.strictEqual(
			untouched.oldestRetainedAuditTime(),
			before,
			"raising one database's floor must not move another's"
		);
	});

	describe('untrustworthy metadata fails closed', () => {
		// A NaN floor in particular makes one of the two natural spellings of the check
		// ("cursor < floor means stale") read as safe, so none of these may return a number.
		const cases = [
			['a truncated record', new Uint8Array(4)],
			['an oversized record', new Uint8Array(12)],
			['an empty record', new Uint8Array(0)],
			['NaN', encodeFloorBytes(NaN)],
			['negative infinity', encodeFloorBytes(-Infinity)],
			['a negative time', encodeFloorBytes(-1)],
			['negative zero', encodeFloorBytes(-0)],
		];

		let Metadata, trustedFloor;
		before(() => {
			Metadata = tableInOwnDatabase('Metadata');
			trustedFloor = Metadata.oldestRetainedAuditTime();
			assert.ok(Number.isFinite(trustedFloor), 'precondition: the floor starts trustworthy');
		});

		afterEach(() => {
			Metadata.auditStore.putSync(AUDIT_FLOOR_KEY, encodeFloorBytes(trustedFloor));
			assert.strictEqual(Metadata.oldestRetainedAuditTime(), trustedFloor, 'restored between cases');
		});

		for (const [label, bytes] of cases) {
			it(`returns Infinity for ${label}, without throwing`, () => {
				Metadata.auditStore.putSync(AUDIT_FLOOR_KEY, bytes);
				const floor = Metadata.oldestRetainedAuditTime();
				assert.strictEqual(floor, Infinity, `${label} should read as unknown`);
				assert.strictEqual(canResumeFrom(0, floor), false);
				assert.strictEqual(canResumeFrom(Date.now(), floor), false);
				assert.strictEqual(canResumeFrom(Number.MAX_VALUE, floor), false);
			});
		}

		for (const [label, cutoff] of [
			['negative zero', -0],
			['a string', '123'],
			['null', null],
		]) {
			it(`throws on ${label} as a cutoff, which the prune range would still honor`, () => {
				const target = tableInOwnDatabase(`Bound${String(label).replace(/\W/g, '')}`);
				const before = target.oldestRetainedAuditTime();
				assert.throws(() => raiseAuditFloor(target.auditStore, cutoff), /Invalid audit prune bound/);
				assert.strictEqual(target.oldestRetainedAuditTime(), before);
			});
		}

		it('bootstraps above the newest retained entry, not below it, when the clock has rolled back', async function () {
			if (Audited.auditStore.reusableIterable) return this.skip(); // RocksDB getKeys is unimplemented
			const { establishAuditFloor } = require('#src/resources/auditStore');
			const rolled = tableInOwnDatabase('RolledBack');
			const future = Date.now() + 3_600_000;
			rolled.auditStore.putSync(future, new Uint8Array(0));
			// A store that has NEVER bootstrapped, which is the only case this bound applies to: both
			// records absent. Clearing the floor alone leaves the provenance record its open already wrote,
			// and `establishAuditFloor` then adopts that epoch rather than deriving a fresh one — correct,
			// and deliberately not bounded by the newest key: the record has to hold the epoch the floor was
			// actually stamped to, or its value stops being the guess a later repair reads.
			await clearRecord(rolled.auditStore, AUDIT_FLOOR_BOOTSTRAP_KEY);
			await clearRecord(rolled.auditStore, AUDIT_FLOOR_KEY);
			assert.strictEqual(rolled.oldestRetainedAuditTime(), Infinity, 'precondition: no floor recorded');
			assert.strictEqual(bootstrapEpoch(rolled.auditStore), undefined, 'precondition: never bootstrapped');
			establishAuditFloor(rolled.auditStore);
			assert.ok(
				rolled.oldestRetainedAuditTime() >= future,
				`floor ${rolled.oldestRetainedAuditTime()} must not sit below the newest retained entry ${future}`
			);
		});

		it('does not stamp over a record that decodes to unknown', () => {
			// establishAuditFloor keys off the record's ABSENCE. Keying off the decoded value instead would
			// let a reopen replace a deliberately-stored Infinity (or corrupt bytes) with Date.now(),
			// lowering a floor the contract says never lowers.
			const { establishAuditFloor } = require('#src/resources/auditStore');
			Metadata.auditStore.putSync(AUDIT_FLOOR_KEY, encodeFloorBytes(Infinity));
			assert.strictEqual(Metadata.oldestRetainedAuditTime(), Infinity);
			establishAuditFloor(Metadata.auditStore);
			assert.strictEqual(Metadata.oldestRetainedAuditTime(), Infinity, 'reopen must not lower it');
		});

		// The bootstrap epoch is a guess bounded by surviving state, and surviving state cannot see history
		// a selective prune already removed (#2458). It is recorded AS a guess: the record's PRESENCE marks
		// the store, its value says how far the guess reached, and only a database generation (#2451)
		// retires the mark — a floor that has climbed past the epoch does not. These pin what that rests
		// on. Both engines: the record is written on both, and only the clock-rollback bound above is
		// LMDB-only.
		describe('bootstrap provenance', () => {
			it('records the epoch it stamped, equal to the floor it stamped', () => {
				const fresh = tableInOwnDatabase('Provenance');
				const floor = fresh.oldestRetainedAuditTime();
				assert.ok(Number.isFinite(floor), 'precondition: opening the database stamped a floor');
				assert.strictEqual(bootstrapEpoch(fresh.auditStore), floor, 'the guess must be recorded as what it is');
			});

			it('leaves the record where it is when a real prune raises the floor', () => {
				// The record preserves the guessed value, so it must not drift with the floor — that value is
				// what tells a later repair how far the guess reached. Note what it does NOT license: a floor
				// above the record is no evidence the store is safe, since a prune certifies only the history
				// it removed and pre-tracking removals can sit above the epoch (#2458).
				const pruned = tableInOwnDatabase('ProvenancePruned');
				const stamped = pruned.oldestRetainedAuditTime();
				const cutoff = stamped + 60_000;
				raiseAuditFloor(pruned.auditStore, cutoff);
				assert.strictEqual(pruned.oldestRetainedAuditTime(), cutoff, 'precondition: the prune raised the floor');
				assert.strictEqual(bootstrapEpoch(pruned.auditStore), stamped, 'the record must not follow it up');
			});

			it('adopts an orphaned record instead of stamping a fresh epoch', async () => {
				// The record is written BEFORE the floor, so a crash in between leaves exactly this state. The
				// next open has to stamp the floor the record already claims, or the recorded value stops
				// being the epoch the floor was built from.
				const orphaned = tableInOwnDatabase('ProvenanceOrphan');
				const older = Date.now() - 1_000_000;
				orphaned.auditStore.putSync(AUDIT_FLOOR_BOOTSTRAP_KEY, encodeFloorBytes(older));
				await clearRecord(orphaned.auditStore, AUDIT_FLOOR_KEY);
				assert.strictEqual(orphaned.oldestRetainedAuditTime(), Infinity, 'precondition: no floor record');
				establishAuditFloor(orphaned.auditStore);
				assert.strictEqual(orphaned.oldestRetainedAuditTime(), older, 'the floor must carry the recorded epoch');
				assert.strictEqual(bootstrapEpoch(orphaned.auditStore), older, 'and the record must be unchanged');
			});

			it('records nothing for a store that already has a floor', async () => {
				// The early return is on the FLOOR's absence, so a store whose floor predates this record does
				// not acquire a guess it never made — which would read as suspect and cost a needless resync.
				const existing = tableInOwnDatabase('ProvenanceExisting');
				assert.ok(Number.isFinite(existing.oldestRetainedAuditTime()), 'precondition: a floor is recorded');
				await clearRecord(existing.auditStore, AUDIT_FLOOR_BOOTSTRAP_KEY);
				establishAuditFloor(existing.auditStore);
				assert.strictEqual(bootstrapEpoch(existing.auditStore), undefined, 'no record may appear');
			});

			it('replaces an unreadable record rather than pinning the floor to unknown forever', async () => {
				// Keeping undecodable bytes was fail-closed FOREVER, not recoverably: the resolver skipped the
				// write because a record existed, the read back failed the same way on every later open, and
				// no retry could ever succeed. The record is a comparison basis, not a floor, so unreadable
				// bytes carry nothing worth keeping — unlike the floor, where a present record may be a
				// deliberate unknown sentinel.
				const corrupt = tableInOwnDatabase('ProvenanceCorrupt');
				corrupt.auditStore.putSync(AUDIT_FLOOR_BOOTSTRAP_KEY, new Uint8Array(4));
				await clearRecord(corrupt.auditStore, AUDIT_FLOOR_KEY);
				establishAuditFloor(corrupt.auditStore);
				const floor = corrupt.oldestRetainedAuditTime();
				assert.ok(Number.isFinite(floor), `the floor must be stamped, got ${floor}`);
				assert.strictEqual(bootstrapEpoch(corrupt.auditStore), floor, 'and the record rewritten to match');
			});
		});

		it('persists the unknown sentinel when a prune finds no floor record at all', async () => {
			// Returning without a marker would let the next open stamp a FINITE epoch, and a prune bound
			// above it — a future endTime, or a rolled-back clock — would then certify cursors whose history
			// this prune deleted.
			const floorless = tableInOwnDatabase('Floorless');
			// On RocksDB the floor lives in the root store and the log store's own remove() is a no-op,
			// so clearing it goes through the root store there.
			const floorlessRoot = floorless.auditStore.rootStore;
			if (typeof floorlessRoot.removeSync === 'function') floorlessRoot.removeSync(AUDIT_FLOOR_KEY);
			await floorless.auditStore.remove(AUDIT_FLOOR_KEY);
			assert.strictEqual(floorless.auditStore.getBinary(AUDIT_FLOOR_KEY), undefined, 'precondition: no floor record');
			raiseAuditFloor(floorless.auditStore, Date.now());
			assert.notStrictEqual(
				floorless.auditStore.getBinary(AUDIT_FLOOR_KEY),
				undefined,
				'the prune must leave a record behind'
			);
			assert.strictEqual(floorless.oldestRetainedAuditTime(), Infinity, 'and it must read as unknown');
			// and a later open must not talk it back down to a finite epoch
			const { establishAuditFloor } = require('#src/resources/auditStore');
			establishAuditFloor(floorless.auditStore);
			assert.strictEqual(floorless.oldestRetainedAuditTime(), Infinity);
		});

		it('raises normally when a floor appears between the pre-check and the transaction', () => {
			// The pre-check is lock-free, so another worker's establishAuditFloor can land in the window.
			// Treating that as "still absent" would write the unknown sentinel — or, worse, write nothing and
			// let the prune run against a floor left below its cutoff. Simulated by hiding the record from
			// the pre-check read only; the transaction sees the real store.
			const raced = tableInOwnDatabase('Raced');
			const established = raced.oldestRetainedAuditTime();
			assert.ok(Number.isFinite(established), 'precondition: a real floor is recorded');
			const cutoff = established + 60_000;
			const store = raced.auditStore;
			const realGetBinary = store.getBinary.bind(store);
			let hidden = false;
			store.getBinary = (key) => {
				if (!hidden && key === AUDIT_FLOOR_KEY) {
					hidden = true;
					return undefined; // the pre-check observes no record
				}
				return realGetBinary(key);
			};
			try {
				raiseAuditFloor(store, cutoff);
			} finally {
				store.getBinary = realGetBinary;
			}
			assert.strictEqual(
				raced.oldestRetainedAuditTime(),
				cutoff,
				'the raced-in record must take the monotonic raise, not the unknown sentinel'
			);
		});

		it('leaves an unknown floor unknown when a prune tries to raise it', () => {
			// A cutoff says nothing about the history the store lost before we started tracking it.
			Metadata.auditStore.putSync(AUDIT_FLOOR_KEY, new Uint8Array(4));
			raiseAuditFloor(Metadata.auditStore, Date.now());
			assert.strictEqual(Metadata.oldestRetainedAuditTime(), Infinity);
		});
	});

	describe('raiseAuditFloor', () => {
		let Monotonic;
		before(() => {
			Monotonic = tableInOwnDatabase('Monotonic');
		});

		it('never lowers an established floor', () => {
			const high = Date.now() + 120_000;
			raiseAuditFloor(Monotonic.auditStore, high);
			assert.strictEqual(Monotonic.oldestRetainedAuditTime(), high);
			raiseAuditFloor(Monotonic.auditStore, high - 60_000);
			assert.strictEqual(
				Monotonic.oldestRetainedAuditTime(),
				high,
				'a narrower prune must not undo the floor a wider one established'
			);
		});

		for (const [label, cutoff] of [
			['NaN', NaN],
			['a negative time', -1],
		]) {
			it(`throws on ${label} as a cutoff rather than declining it silently`, () => {
				// Audit keys are raw float64, so NaN and negatives sort ABOVE every real timestamp and the
				// prune's own range honors them — declining only the floor update would delete everything.
				const before = Monotonic.oldestRetainedAuditTime();
				assert.throws(() => raiseAuditFloor(Monotonic.auditStore, cutoff), /Invalid audit prune bound/);
				assert.strictEqual(Monotonic.oldestRetainedAuditTime(), before);
			});
		}

		it('refuses a deleteHistory whose bound the range would honor but the floor cannot record', async function () {
			if (Audited.auditStore.reusableIterable) return this.skip(); // LMDB is the engine that removes entries
			const guarded = tableInOwnDatabase('Guarded');
			await guarded.put('kept-1', { name: 'one' });
			await guarded.put('kept-2', { name: 'two' });
			const before = auditEntries(guarded.auditStore).length;
			assert.ok(before >= 2, 'precondition: entries that must survive');
			await assert.rejects(() => guarded.deleteHistory(NaN), /Invalid audit prune bound/);
			assert.strictEqual(
				auditEntries(guarded.auditStore).length,
				before,
				'a bound that cannot be recorded must delete nothing'
			);
		});

		it('takes an Infinity cutoff and reports the floor as unknown', () => {
			// `deleteHistory(Infinity)` removes ALL of a table's history. Rejecting the cutoff would
			// remove the entries and leave the previous floor certifying them.
			const unbounded = tableInOwnDatabase('Unbounded');
			assert.ok(Number.isFinite(unbounded.oldestRetainedAuditTime()), 'precondition: a known floor');
			raiseAuditFloor(unbounded.auditStore, Infinity);
			assert.strictEqual(unbounded.oldestRetainedAuditTime(), Infinity);
		});

		it('throws rather than skipping the write when there is no audit store', () => {
			// Callers order the raise before the prune, so this throw is what stops an unrecorded prune.
			assert.throws(() => raiseAuditFloor(undefined, Date.now()), /has no audit store/);
		});

		it('does not report a commit when the floor write fails silently', function () {
			// The containment around the LMDB put cannot tell a failing write from a replaced one, so the
			// transaction reads its own write back. Without that, a rejected put was swallowed, the callback
			// still returned true, and the caller pruned against a floor that was never recorded.
			if (Audited.auditStore.reusableIterable) return this.skip(); // LMDB write branch
			const swallowed = tableInOwnDatabase('Swallowed');
			const before = swallowed.oldestRetainedAuditTime();
			const store = swallowed.auditStore;
			const realPut = store.put.bind(store);
			store.put = () => Promise.reject(new Error('simulated floor write failure'));
			try {
				assert.throws(() => raiseAuditFloor(store, before + 60_000), /did not commit/);
			} finally {
				store.put = realPut;
			}
			assert.strictEqual(swallowed.oldestRetainedAuditTime(), before, 'and the floor must not have moved');
		});

		it('does not report a commit when the unknown sentinel itself fails to write', function () {
			// The read-back compares the value it wrote. On a FLOORLESS store the value is the unknown
			// sentinel, and `decodeAuditFloor(undefined)` is that same sentinel — so equality alone said
			// "landed" for a write that never happened, on exactly the store where the marker matters most.
			// Both other write-failure tests seed a finite floor first, so neither reaches this.
			if (Audited.auditStore.reusableIterable) return this.skip(); // LMDB write branch
			const floorless = tableInOwnDatabase('SentinelFails');
			const store = floorless.auditStore;
			const floorlessRoot = store.rootStore;
			if (typeof floorlessRoot.removeSync === 'function') floorlessRoot.removeSync(AUDIT_FLOOR_KEY);
			return store.remove(AUDIT_FLOOR_KEY).then(() => {
				assert.strictEqual(store.getBinary(AUDIT_FLOOR_KEY), undefined, 'precondition: no floor record');
				const realPut = store.put.bind(store);
				store.put = () => Promise.resolve(true); // accepted, but nothing is stored
				try {
					assert.throws(() => raiseAuditFloor(store, Date.now()), /did not commit/);
				} finally {
					store.put = realPut;
				}
				assert.strictEqual(
					store.getBinary(AUDIT_FLOOR_KEY),
					undefined,
					'and still no record, so the caller must not have pruned'
				);
			});
		});

		it('does not prune when the floor cannot be recorded', () => {
			let purgeCalls = 0;
			const failingStore = {
				auditStore: {
					rootStore: {
						transactionSync() {
							throw new Error('cannot record the floor');
						},
					},
				},
				purgeLogs() {
					purgeCalls++;
					return [];
				},
			};
			assert.throws(() => purgeAgedLogs(failingStore), /cannot record the floor/);
			assert.strictEqual(purgeCalls, 0, 'the purge must not run once the floor write failed');
		});
	});

	it('answers the resume predicate exactly at the floor', () => {
		const floor = Audited.oldestRetainedAuditTime();
		assert.ok(Number.isFinite(floor), 'precondition: a known floor');
		assert.strictEqual(canResumeFrom(floor - 1, floor), false, 'a cursor below the floor has lost history');
		assert.strictEqual(canResumeFrom(floor, floor), true, 'a cursor at the floor has processed everything below it');
		assert.strictEqual(canResumeFrom(floor + 1, floor), true);
	});

	describe('every prune path advances the floor', () => {
		it('the retention cleanup loop does, and keeps a usable floor once the log is empty', async function () {
			if (Audited.auditStore.reusableIterable) return this.skip(); // RocksDB prunes by whole log file, covered below
			const pruned = tableInOwnDatabase('Pruned');
			await pruned.put(1, { name: 'one' });
			await pruned.put(2, { name: 'two' });
			const written = auditEntries(pruned.auditStore).map((entry) => entry.localTime);
			assert.ok(written.length >= 2, 'precondition: entries to prune');

			setAuditRetention(0.001, 1);
			await waitFor(
				async () => {
					await pruned.auditStore.scheduleAuditCleanup(1);
					return auditEntries(pruned.auditStore).length === 0;
				},
				{ timeout: 10_000, interval: 0, message: 'audit log was not pruned' }
			);

			const floor = pruned.oldestRetainedAuditTime();
			// The surviving log is empty, so nothing about it distinguishes "pruned everything" from
			// "never wrote anything" — this is exactly the case a floor derived from the log gets wrong.
			assert.ok(Number.isFinite(floor), `floor should still be known after a full prune, got ${floor}`);
			for (const localTime of written) {
				assert.strictEqual(
					canResumeFrom(localTime, floor),
					false,
					`a cursor at pruned entry ${localTime} must read as stale (floor ${floor})`
				);
			}
		});

		it('deleteHistory does, above entries the surviving log cannot account for', async function () {
			if (Audited.auditStore.reusableIterable) return this.skip(); // RocksTransactionLogStore.remove() is a no-op
			setAuditRetention(originalRetention);
			const auditStore = Audited.auditStore;
			await Audited.put('sparse-1', { name: 'x1' });
			await Sibling.put('sparse-a', { name: 'y1' });
			await Audited.put('sparse-2', { name: 'x2' });
			await Sibling.put('sparse-b', { name: 'y2' });

			const before = auditEntries(auditStore);
			const siblingTimes = before.filter((e) => e.tableId === Sibling.tableId).map((e) => e.localTime);
			const endTime = siblingTimes[siblingTimes.length - 1];
			const removedTimes = before
				.filter((e) => e.tableId === Audited.tableId && e.localTime < endTime)
				.map((e) => e.localTime);
			assert.ok(removedTimes.length > 0, 'precondition: entries of this table below the cut');

			await Audited.deleteHistory(endTime);

			const floor = Audited.oldestRetainedAuditTime();
			const highestRemoved = Math.max(...removedTimes);
			assert.strictEqual(
				canResumeFrom(highestRemoved, floor),
				false,
				`the floor ${floor} still certifies removed entry ${highestRemoved}`
			);
			// And the reason the floor has to be recorded rather than read off the log: this prune takes
			// one table out of a database-scoped log, so a sibling's entry survives BELOW the newest
			// entry it removed. "Oldest surviving entry" would have reported a floor under that.
			const surviving = auditEntries(auditStore);
			assert.ok(surviving.length > 0, 'precondition: sibling entries survive');
			assert.ok(
				surviving[0].localTime < highestRemoved,
				`expected a surviving entry below the highest removed (${surviving[0].localTime} vs ${highestRemoved})`
			);
		});

		it('but a pass with nothing eligible writes no floor at all', async function () {
			// the Rocks branch purges whole log files, so it has no per-entry eligibility probe to assert on
			if (Audited.auditStore.reusableIterable) return this.skip();
			const idle = tableInOwnDatabase('Idle');
			await idle.put('recent', { name: 'kept' });
			const before = idle.oldestRetainedAuditTime();
			setAuditRetention(originalRetention); // nothing is old enough to prune
			await idle.auditStore.scheduleAuditCleanup(1);
			assert.strictEqual(
				idle.oldestRetainedAuditTime(),
				before,
				'an idle database must not write a floor transaction on every pass'
			);
		});

		it('deleteHistory(Infinity) leaves the database a usable floor, not the absorbing sentinel', async function () {
			// Infinity is the unknown sentinel AND absorbing: the lock-free pre-check skips any record no
			// cutoff exceeds and establishAuditFloor skips any store that has one, so recording it would
			// retire `oldestRetainedAuditTime` for this database forever. The floor is database-scoped, so
			// clearing ONE table's history would take every sibling's consumers down with it, permanently
			// (#2458). A finite bound above everything in the log is honest about what was removed and
			// still lets later cursors resume.
			if (Audited.auditStore.reusableIterable) return this.skip(); // deleteHistory only raises on LMDB
			const shared = 'auditFloorDB_infinite';
			const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
			const wiped = table({ table: 'WipedTable', database: shared, attributes });
			const spared = table({ table: 'SparedTable', database: shared, attributes });
			await wiped.put('w-1', { name: 'one' });
			await spared.put('s-1', { name: 'one' });

			await wiped.deleteHistory(Infinity);

			const floor = wiped.oldestRetainedAuditTime();
			assert.ok(Number.isFinite(floor), `the floor must stay finite, got ${floor}`);
			assert.strictEqual(spared.oldestRetainedAuditTime(), floor, 'precondition: one floor per database');
			// the sibling was never touched, so a cursor taken after the wipe must still resume
			await spared.put('s-2', { name: 'two' });
			const later = auditEntries(spared.auditStore)
				.map((entry) => entry.localTime)
				.filter((t) => t >= floor);
			assert.ok(later.length > 0, 'a sibling write after the wipe must sit at or above the floor');
			assert.strictEqual(canResumeFrom(later[later.length - 1], floor), true, 'and must read as resumable');
		});

		it('deleteHistory with a far-future finite bound stays reachable too', async function () {
			// The same defect as Infinity by degree, and the case Infinity's clamp used to miss: a bare
			// '9999999999999' or a Date.now()*1000 ms/µs slip is FINITE, so it cleared both the bridge's
			// finiteness guard and `boundedAuditPruneEnd`'s old `cutoff !== Infinity` early return, and was
			// recorded verbatim. A floor only ever rises, so every entry written afterwards lands BELOW it
			// and the accessor is retired for the whole database just as permanently (#2458).
			if (Audited.auditStore.reusableIterable) return this.skip(); // deleteHistory only raises on LMDB
			const shared = 'auditFloorDB_farFuture';
			const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
			const wiped = table({ table: 'FutureWiped', database: shared, attributes });
			const spared = table({ table: 'FutureSpared', database: shared, attributes });
			await wiped.put('w-1', { name: 'one' });
			await spared.put('s-1', { name: 'one' });

			const absurd = Date.now() * 1000; // a ms value read as µs — about the year 55000
			await wiped.deleteHistory(absurd);

			const floor = wiped.oldestRetainedAuditTime();
			assert.ok(floor < absurd, `the floor must be clamped below the requested bound, got ${floor}`);
			assert.ok(floor <= Date.now() + 1, `and must not be left sitting in the future, got ${floor}`);
			// The property the verbatim floor destroyed: a write after the prune is still resumable. The
			// sibling was never pruned, so this must hold for it regardless of what `wiped` asked for.
			await spared.put('s-2', { name: 'two' });
			const later = auditEntries(spared.auditStore)
				.map((entry) => entry.localTime)
				.filter((t) => t >= floor);
			assert.ok(later.length > 0, 'a write after the prune must sit at or above the floor');
			assert.strictEqual(canResumeFrom(later[later.length - 1], floor), true, 'and must read as resumable');
		});

		it('deleteHistory with an unbounded endTime leaves no cursor readable as safe', async function () {
			if (Audited.auditStore.reusableIterable) return this.skip(); // RocksTransactionLogStore.remove() is a no-op
			const cleared = tableInOwnDatabase('Cleared');
			await cleared.put('all-1', { name: 'one' });
			await cleared.put('all-2', { name: 'two' });
			const written = auditEntries(cleared.auditStore).map((entry) => entry.localTime);
			assert.ok(written.length >= 2, 'precondition: entries to remove');

			await cleared.deleteHistory(Infinity);

			const floor = cleared.oldestRetainedAuditTime();
			for (const localTime of written) {
				assert.strictEqual(
					canResumeFrom(localTime, floor),
					false,
					`a cursor at removed entry ${localTime} must read as stale (floor ${floor})`
				);
			}
		});

		it('the RocksDB log purge does', async function () {
			if (!Audited.auditStore.reusableIterable) return this.skip(); // LMDB paths covered above
			const purgeTable = tableInOwnDatabase('Purged');
			const auditStore = purgeTable.auditStore;
			const rootStore = auditStore.rootStore;
			// RocksDB drops only whole log files that are already flushed and no longer being appended
			// to, so a purge needs a flushed batch AND a later one to roll the append point off it.
			for (let i = 0; i < 40; i++) await purgeTable.put(`purge-a-${i}`, { name: 'a'.repeat(200) });
			rootStore.flushSync();
			const firstBatch = auditEntries(auditStore).map((entry) => entry.localTime);
			for (let i = 0; i < 40; i++) await purgeTable.put(`purge-b-${i}`, { name: 'b'.repeat(200) });
			rootStore.flushSync();

			const floorBefore = purgeTable.oldestRetainedAuditTime();
			setAuditRetention(-60_000); // a cutoff in the future, so the whole flushed batch is eligible
			const purged = purgeAgedLogs(rootStore);
			setAuditRetention(originalRetention);

			assert.ok(purged.length > 0, 'precondition: a log file was actually purged');
			const floor = purgeTable.oldestRetainedAuditTime();
			assert.ok(Number.isFinite(floor), `floor should stay known after a purge, got ${floor}`);
			assert.ok(floor > floorBefore, `the purge should have advanced the floor (${floorBefore} -> ${floor})`);
			const highestPurged = Math.max(...firstBatch);
			assert.strictEqual(
				canResumeFrom(highestPurged, floor),
				false,
				`the floor ${floor} still certifies purged entry ${highestPurged}`
			);
		});
	});

	it('records the floor before the purge on a real store, not only on a stand-in', async function () {
		// auditPurge.test.js proves the ordering against a plain-object stand-in, which takes the LMDB
		// branch of updateAuditFloor. This pins it on whichever branch the running engine actually uses,
		// by observing the floor from inside purgeLogs — the only point where "already recorded?" is a
		// meaningful question.
		const ordered = tableInOwnDatabase('Ordered');
		await ordered.put('ordering-1', { name: 'one' });
		const rootStore = ordered.auditStore.rootStore;
		if (typeof rootStore.purgeLogs !== 'function') return this.skip(); // LMDB has no log purge
		const cutoff = Date.now() + 30_000;
		let floorDuringPurge;
		const realPurgeLogs = rootStore.purgeLogs.bind(rootStore);
		rootStore.purgeLogs = (options) => {
			floorDuringPurge = ordered.oldestRetainedAuditTime();
			return realPurgeLogs(options);
		};
		try {
			setAuditRetention(Date.now() - cutoff); // so purgeAgedLogs' cutoff is `cutoff`
			purgeAgedLogs(rootStore);
		} finally {
			rootStore.purgeLogs = realPurgeLogs;
			setAuditRetention(originalRetention);
		}
		assert.ok(
			floorDuringPurge >= cutoff,
			`floor should already be recorded when purgeLogs runs, saw ${floorDuringPurge}`
		);
	});

	it('works on a real legacy standalone audit root, which owns its own transaction', function () {
		// A legacy `auditPath` layout is opened by databases.ts as its own LMDB root, with an encoder that
		// has no Uint8Array passthrough and no `.rootStore` — so an unwrapped floor write reaches
		// createAuditEntry and throws `Invalid audit entry type`, failing database startup.
		const { open } = require('lmdb');
		const { createAuditEntry, readAuditEntry, establishAuditFloor } = require('#src/resources/auditStore');
		const legacyPath = path.join(os.tmpdir(), `harper-legacy-audit-${process.pid}-${Date.now()}.mdb`);
		const legacyEncoder = {
			encode: (auditRecord) => createAuditEntry(auditRecord),
			decode: (encoding) => readAuditEntry(encoding),
		};
		const legacyRoot = open({ path: legacyPath, encoder: legacyEncoder });
		try {
			assert.doesNotThrow(() => establishAuditFloor(legacyRoot), 'a legacy root must open, not throw');
			const established = oldestRetainedAuditTime(legacyRoot);
			assert.ok(Number.isFinite(established), `legacy root should get a floor, got ${established}`);
			raiseAuditFloor(legacyRoot, established + 5_000);
			assert.strictEqual(oldestRetainedAuditTime(legacyRoot), established + 5_000);
			legacyRoot.close();
			// Reopen: the whole floor-before-prune ordering rests on the bytes being durable, and every
			// other assertion in this file reads back through the handle that wrote them.
			const reopened = open({ path: legacyPath, encoder: legacyEncoder });
			try {
				assert.strictEqual(
					oldestRetainedAuditTime(reopened),
					established + 5_000,
					'the floor must survive a close and reopen'
				);
			} finally {
				reopened.close();
			}
		} finally {
			if (legacyRoot.status !== 'closed') legacyRoot.close();
		}
	});

	it('keeps the floor key out of the enumerable audit keys', function () {
		// openAuditStore's time-reversal check does `time > Date.now()` over getKeys({reverse, limit: 1}).
		// A symbol reaching that comparison throws, so a database whose audit log holds no entries yet —
		// only the floor and last-removed markers — would fail to open. The audit key encoder does not
		// yield symbol keys, which is what keeps that check numeric.
		if (Audited.auditStore.reusableIterable) return this.skip(); // RocksDB getKeys is unimplemented
		const fresh = tableInOwnDatabase('KeyOnlyFloor');
		assert.ok(Number.isFinite(fresh.oldestRetainedAuditTime()), 'precondition: a floor is recorded');
		const keys = [];
		for (const key of fresh.auditStore.getKeys({ reverse: true, limit: 1 })) keys.push(key);
		assert.deepStrictEqual(keys, [], 'no marker symbol may surface as an enumerable audit key');
	});

	it('reports the database floor for a table whose own auditing is off', () => {
		const unaudited = table({
			table: 'FloorUnaudited',
			database: 'auditFloorDB',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(unaudited.oldestRetainedAuditTime(), Audited.oldestRetainedAuditTime());
	});
});
