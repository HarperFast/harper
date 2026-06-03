const assert = require('node:assert/strict');

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

	function fakeStore(purgedFiles = ['000001.txnlog', '000002.txnlog']) {
		const calls = [];
		return {
			calls,
			purgeLogs(options) {
				calls.push(options);
				return purgedFiles;
			},
		};
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
