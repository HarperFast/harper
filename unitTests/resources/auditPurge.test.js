const assert = require('node:assert');

// Regression test for the early-recovery transaction-log purge (harper#1115).
// scheduleAuditCleanup only runs once a worker reaches steady state, so a node that
// crash-loops during startup replay never purges its aged backlog. purgeAgedLogs is the
// one-shot purge wired into replayLogs so a recovering node sheds files older than the
// retention window before replaying. These tests pin its contract: it asks the store to
// purge everything older than `Date.now() - auditRetention` and returns the purged list.
const auditStore = require('#src/resources/auditStore');
const { purgeAgedLogs, setAuditRetention } = auditStore;

describe('purgeAgedLogs', () => {
	let originalRetention;

	before(() => {
		originalRetention = auditStore.auditRetention;
	});

	after(() => {
		setAuditRetention(originalRetention);
	});

	// purgeAgedLogs raises the floor before purging (harper#2447); `order` records both steps, because
	// a crash between them leaves a floor certifying purged history if the write came second.
	function fakeStore(purgedFiles = ['000001.txnlog', '000002.txnlog']) {
		const calls = [];
		const order = [];
		const store = {
			calls,
			order,
			floorWrites: [],
			purgeLogs(options) {
				calls.push(options);
				order.push('purge');
				return purgedFiles;
			},
		};
		store.auditStore = {
			rootStore: {
				// returns the callback's value, as both real engines do: updateAuditFloor requires an
				// explicit `true` because RocksDB swallows an aborted transaction and returns undefined.
				transactionSync(callback) {
					order.push('floor');
					return callback();
				},
			},
			// Holds what it is given, because updateAuditFloor reads its own write back inside the
			// transaction to catch a put that failed without saying so. It starts at the baseline a
			// database that has provably pruned nothing carries; an absent floor would instead mean
			// "unknown", which a prune deliberately leaves alone.
			stored: new Uint8Array(Float64Array.of(1).buffer),
			getBinary() {
				return store.auditStore.stored;
			},
			// `put`, as updateAuditFloor calls inside its write transaction; lmdb returns an
			// already-resolved sentinel there, so the write is still synchronous
			put(_key, value) {
				// the real write wraps the bytes in lmdb's asBinary(), which bypasses both engines' encoders
				const wrapped = Object.values(value)[0] ?? value;
				const bytes = Uint8Array.from(Object.values(wrapped));
				store.auditStore.stored = bytes;
				store.floorWrites.push(new Float64Array(bytes.buffer)[0]);
				return Promise.resolve(true);
			},
		};
		return store;
	}

	it('purges log files older than the configured audit retention window', () => {
		setAuditRetention(60_000);
		const store = fakeStore();
		const before = Date.now();
		const purged = purgeAgedLogs(store);
		const after = Date.now();

		assert.equal(store.calls.length, 1, 'purgeLogs should be called exactly once');
		assert.deepEqual(Object.keys(store.calls[0]), ['before'], 'only the time bound should be passed');
		const cutoff = store.calls[0].before;
		assert.ok(
			cutoff >= before - 60_000 && cutoff <= after - 60_000,
			`cutoff ${cutoff} should be ~Date.now() - 60000 (in [${before - 60_000}, ${after - 60_000}])`
		);
		assert.deepEqual(purged, ['000001.txnlog', '000002.txnlog'], 'returns the purged file list');
	});

	it('records the staleness floor at the same cutoff, before purging anything', () => {
		setAuditRetention(60_000);
		const store = fakeStore();
		const before = Date.now();
		purgeAgedLogs(store);

		assert.deepStrictEqual(store.order, ['floor', 'purge'], 'the floor must be recorded before the purge runs');
		assert.strictEqual(store.floorWrites.length, 1, 'exactly one floor write');
		assert.strictEqual(
			store.floorWrites[0],
			store.calls[0].before,
			'the floor and the purge cutoff must be the same instant'
		);
		assert.ok(store.floorWrites[0] >= before - 60_000, 'floor should track the retention window');
	});

	it('tracks the retention window when it changes', () => {
		setAuditRetention(5_000);
		const store = fakeStore();
		const before = Date.now();
		purgeAgedLogs(store);
		const after = Date.now();

		const cutoff = store.calls[0].before;
		assert.ok(
			cutoff >= before - 5_000 && cutoff <= after - 5_000,
			`cutoff ${cutoff} should track the 5s retention window`
		);
	});
});
