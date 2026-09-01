/**
 * The audit staleness floor (harper#2447). A consumer resuming incremental audit-log consumption
 * from a saved cursor has to be able to tell a complete catch-up from a truncated one;
 * `oldestRetainedAuditTime` is the primitive that answers it, and the invariant these tests defend
 * is one-directional: the floor may ask for a resync that was not strictly necessary, but it must
 * never certify a cursor whose history has already been pruned.
 */
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { raiseAuditFloor, purgeAgedLogs, setAuditRetention, auditRetention } = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');

/**
 * The predicate a resuming consumer applies to the floor. Spelled out here rather than assumed,
 * because it is the contract the accessor exists to serve and what harper#2448 will apply inside
 * `Table.subscribe`: a cursor records the last position already processed, so a cursor AT the floor
 * is safe and only one below it has lost entries.
 */
const canResumeFrom = (cursor, floor) => cursor >= floor;

function auditEntries(auditStore) {
	const entries = [];
	for (const record of auditStore.getRange({ start: 1 })) {
		entries.push({ tableId: record.tableId, localTime: record.localTime });
	}
	return entries;
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
		setAuditRetention(originalRetention);
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
		// Every one of these is metadata this code did not write — a shorter or longer record, or eight
		// bytes that do not decode to a usable time. Returning ANY number for them would hand a
		// consumer a floor derived from bytes we do not understand, and a NaN floor in particular makes
		// one of the two natural spellings of the check ("cursor < floor means stale") read as safe.
		const cases = [
			['a truncated record', new Uint8Array(4)],
			['an oversized record', new Uint8Array(12)],
			['an empty record', new Uint8Array(0)],
			['NaN', encodeFloorBytes(NaN)],
			['negative infinity', encodeFloorBytes(-Infinity)],
			['a negative time', encodeFloorBytes(-1)],
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

		it('leaves an unknown floor unknown when a prune tries to raise it', () => {
			// A store whose history we cannot account for must not be talked down to a cutoff that says
			// nothing about what it lost before we started tracking.
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
			['Infinity', Infinity],
			['a negative time', -1],
		]) {
			it(`ignores ${label} as a cutoff`, () => {
				const before = Monotonic.oldestRetainedAuditTime();
				raiseAuditFloor(Monotonic.auditStore, cutoff);
				assert.strictEqual(Monotonic.oldestRetainedAuditTime(), before);
			});
		}

		it('does not prune when the floor cannot be recorded', () => {
			// Ordering is the whole guarantee: a purge that ran and then failed to record its floor
			// leaves a floor certifying history that is gone. purgeAgedLogs raises first, so a failure
			// to record has to stop the purge.
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

	it('reports the database floor for a table whose own auditing is off', () => {
		// The floor is a property of the database's audit log, not of one table's participation in it,
		// so an unaudited table in an audited database still answers — with its database's floor.
		const unaudited = table({
			table: 'FloorUnaudited',
			database: 'auditFloorDB',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(unaudited.oldestRetainedAuditTime(), Audited.oldestRetainedAuditTime());
	});
});
