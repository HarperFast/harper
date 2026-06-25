require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const DAY = 86400 * 1000;

// harper-pro#480: on the out-of-order apply path, the keyed audit dedup looks up a version in the
// per-node transaction log. That log has time-based retention, so a lookup for a version older than
// the log's oldest retained entry can never hit — its entry was purged — and on RocksDB the exactStart
// miss scans the whole log to end-of-log. The guard skips the lookup for such versions (it is allowed
// to miss: it falls through to the resequencing walk). These tests assert the keyed lookup is skipped
// for a pre-retention version, performed for an in-retention version, and that convergence is unchanged.
describe('Audit dedup retention guard (harper-pro#480)', () => {
	let Guarded;
	// Records every `key` (first arg) the keyed dedup / walk looks up, and whether the guard's
	// oldest-retained probe (getRange start:1) ran. Installed per-test around the apply under test.
	function spyAuditStore(auditStore) {
		const getSyncKeys = [];
		let oldestRetainedProbeCount = 0;
		const origGetSync = auditStore.getSync.bind(auditStore);
		const origGetRange = auditStore.getRange.bind(auditStore);
		auditStore.getSync = function (key, ...rest) {
			getSyncKeys.push(key);
			return origGetSync(key, ...rest);
		};
		auditStore.getRange = function (options, ...rest) {
			if (options && options.start === 1) oldestRetainedProbeCount++;
			return origGetRange(options, ...rest);
		};
		return {
			getSyncKeys,
			get oldestRetainedProbeCount() {
				return oldestRetainedProbeCount;
			},
			restore() {
				auditStore.getSync = origGetSync;
				auditStore.getRange = origGetRange;
			},
		};
	}

	before(async function () {
		if (isLMDB) return; // guard is RocksDB-only; LMDB keeps its exact unbounded lookup
		setupTestDBPath();
		setMainIsWorker(true);
		Guarded = table({
			table: 'GuardedDedup',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }],
			audit: true,
		});
	});

	it('skips the keyed dedup lookup for a version older than the oldest retained log entry', async function () {
		if (isLMDB) return this.skip();
		const id = 'pre-retention';
		// Establish an existing, newer record. The oldest retained audit entry is now ~Date.now().
		const context = {};
		await transaction(context, () => {
			Guarded.put(id, { name: 'original' }, context);
		});
		const now = Date.now();
		await Guarded.patch(id, { name: 'newer' }, { timestamp: now + 10 });

		// Apply an out-of-order write whose version predates retention by ~30 days. Its keyed dedup
		// lookup is a guaranteed miss (its log entry was purged), so the guard must skip it.
		const oldVersion = now - 30 * DAY;
		const spy = spyAuditStore(Guarded.auditStore);
		try {
			await Guarded.patch(id, { name: 'should-lose', count: 3 }, { timestamp: oldVersion });
		} finally {
			spy.restore();
		}

		// The keyed dedup (auditStore.get → getSync) for the pre-retention version must NOT run...
		assert(
			!spy.getSyncKeys.includes(oldVersion),
			`keyed dedup must be skipped for pre-retention version; got lookups for keys: ${spy.getSyncKeys}`
		);
		// ...and the guard must have resolved the oldest retained entry once.
		assert(spy.oldestRetainedProbeCount >= 1, 'guard should probe the oldest retained audit entry');
		// ...while the resequencing walk still ran (it looks up the existing chain by its recent
		// localTime / previousVersion keys — proving we fell through to the walk, not short-circuited it).
		assert(spy.getSyncKeys.length >= 1, 'resequencing walk should still look up the existing audit chain');

		// Correctness unchanged: a write that predates the record's own initial put is fully superseded by
		// that newer full put, so the walk correctly drops it — same outcome as without the guard.
		const record = await Guarded.get(id);
		assert.equal(record.name, 'newer', 'newer write still wins');
		assert.equal(record.count, undefined, 'stale pre-creation write is superseded, not folded in');
	});

	it('performs the keyed dedup lookup for a version within retention', async function () {
		if (isLMDB) return this.skip();
		const id = 'in-retention';
		const context = {};
		await transaction(context, () => {
			Guarded.put(id, { name: 'original' }, context);
		});
		const now = Date.now();
		await Guarded.patch(id, { name: 'newer' }, { timestamp: now + 100 });

		// An out-of-order write only ~10ms older than the head is well within retention (newer than the
		// oldest retained entry), so the keyed dedup lookup must still be performed.
		const recentOlderVersion = now + 10;
		const spy = spyAuditStore(Guarded.auditStore);
		try {
			await Guarded.patch(id, { name: 'should-lose', count: 7 }, { timestamp: recentOlderVersion });
		} finally {
			spy.restore();
		}

		assert(
			spy.getSyncKeys.includes(recentOlderVersion),
			`keyed dedup must run for an in-retention version; got lookups for keys: ${spy.getSyncKeys}`
		);

		const record = await Guarded.get(id);
		assert.equal(record.name, 'newer');
		assert.equal(record.count, 7);
	});
});
