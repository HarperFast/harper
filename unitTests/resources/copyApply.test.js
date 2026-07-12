const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { setTimeout: delay } = require('node:timers/promises');
require('#src/server/serverHelpers/serverUtilities');

// Bulk base-copy frames are applied as snapshots (harper-pro#480): the record + indices are written
// but NO audit/transaction-log entry is created, and the out-of-order resequencing/dedup is skipped.
// These tests exercise the core apply branch via an intermediate (replication) source, which is how
// replication feeds writes through _writeUpdate; `isCopyApply` on the event is set by harper-pro's
// replicationConnection for frames received between COPY_START and COPY_COMPLETE.
describe('copy-apply snapshot writes (harper-pro#480)', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		server.replication.mockRemoteMap = new Map([['local', 0]]);
		server.replication.getIdOfRemoteNode = function (name) {
			let id = server.replication.mockRemoteMap.get(name);
			if (id === undefined) {
				id = server.replication.mockRemoteMap.size;
				server.replication.mockRemoteMap.set(name, id);
			}
			return id;
		};
	});

	async function waitFor(predicate, message, timeout = 5000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (await predicate()) return;
			await delay(20);
		}
		throw new Error('waitFor timed out: ' + message);
	}

	// A table fed only by an intermediate (replication) source that yields `events` in order, then
	// holds the subscription open until `held` resolves (so the apply loop stays alive for assertions).
	function makeReplicatedTable(name, events, held) {
		const ReplicatedTable = table({
			table: name,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		ReplicatedTable.sourcedFrom(
			{
				subscribeOnThisThread() {
					return true;
				},
				async *subscribe() {
					for (const event of events) yield event;
					await held;
				},
			},
			{ intermediateSource: true }
		);
		return ReplicatedTable;
	}

	it('writes the record but no audit entry, while a normal replicated put does write one', async function () {
		// copy-apply suppresses the audit entry on RocksDB only; on LMDB it falls back to the normal audited
		// apply (LMDB stores localTime separately and audit=false would drop it), so this RocksDB-specific
		// assertion does not hold under HARPER_STORAGE_ENGINE=lmdb (harper-pro#480).
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const ReplicatedTable = makeReplicatedTable(
			'CopyApplyAudit',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'copied' }, timestamp: now, isCopyApply: true },
				{ type: 'put', id: 2, value: { id: 2, name: 'replicated' }, timestamp: now + 1 },
			],
			held
		);
		try {
			await waitFor(
				async () =>
					(await ReplicatedTable.get(1))?.name === 'copied' && (await ReplicatedTable.get(2))?.name === 'replicated',
				'both records applied'
			);
			// the snapshot record is durably stored
			assert.equal(ReplicatedTable.primaryStore.getEntry(1)?.value?.name, 'copied');
			// copy-apply rows carry no audit/transaction-log entry; the normal replicated row does
			assert.equal((await ReplicatedTable.getHistoryOfRecord(1)).length, 0, 'copy-apply row must have no audit entry');
			assert.ok(
				(await ReplicatedTable.getHistoryOfRecord(2)).length >= 1,
				'normal replicated row must have an audit entry'
			);
		} finally {
			release();
		}
	});

	it('is put-if-newer-or-absent: an older snapshot must not regress a newer row', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const ReplicatedTable = makeReplicatedTable(
			'CopyApplyNewer',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'newer' }, timestamp: now + 100, isCopyApply: true },
				{ type: 'put', id: 1, value: { id: 1, name: 'older' }, timestamp: now, isCopyApply: true },
				// sentinel applied last so we can wait for the whole batch to drain
				{ type: 'put', id: 9, value: { id: 9, name: 'marker' }, timestamp: now + 200, isCopyApply: true },
			],
			held
		);
		try {
			await waitFor(async () => (await ReplicatedTable.get(9))?.name === 'marker', 'sentinel applied');
			assert.equal(
				(await ReplicatedTable.get(1))?.name,
				'newer',
				'older copy-apply snapshot must not overwrite the newer row'
			);
		} finally {
			release();
		}
	});
});
