require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');
const RETRY_NOW_VALUE = require('@harperfast/rocksdb-js').constants.RETRY_NOW_VALUE;

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const PATHS = 15; // the field topology's peer count: every peer relayed the bridge origin's writes

// harper#2485: the same origin write reaching a node over N replication paths at once is one write
// with one identity — (record id, origin version, origin nodeId) — and must leave one
// transaction-log entry and one apply. Each delivery is its own transaction, so none of them can
// see another's staged audit append, and the record write is the only part optimistic concurrency
// arbitrates: the N-1 that lose it still leave their append behind, because the log batch is
// written by the commit attempt (even a failed one) and its bytes cannot be unwritten. The field
// case was a 15-node mesh fed through a directional bridge peer, where the duplicate count was
// exactly the peer count rather than a spread.
describe('Concurrent multi-path deliveries of one write (harper#2485)', () => {
	let Replicated;
	before(async function () {
		if (isLMDB) return;
		setupTestDBPath();
		setMainIsWorker(true);
		Replicated = table({
			table: 'ConcurrentDuplicateApply',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }],
			audit: true,
		});
	});

	// Drive the replication apply path the way the subscription loop does: the origin write's
	// version as the transaction timestamp, sourceApply so a conflict retries rather than dropping
	// the write, and the origin nodeId per write so the entry lands in that origin's log.
	function applyFromPeer(id, recordUpdate, fullUpdate, version, nodeId) {
		const context = { sourceApply: true, timestamp: version, source: {} };
		const options = { isNotification: true, ensureLoaded: false, nodeId, async: true };
		return transaction(context, async () => {
			const resource = await Replicated.getResource(id, context, options);
			return resource._writeUpdate(id, recordUpdate, fullUpdate, options);
		});
	}

	function entriesForIdentity(id, version, nodeId) {
		let count = 0;
		for (const entry of Replicated.auditStore.getRange({ start: 1, log: nodeId })) {
			if (entry.recordId === id && entry.tableId === Replicated.tableId && entry.version === version) count++;
		}
		return count;
	}

	// Records how each native commit attempt resolved, so a test can assert the deliveries really
	// raced (at least one lost optimistic concurrency) instead of having been serialized by the
	// scheduler into a sequence the keyed dedup already handles.
	function spyOnCommits() {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const attempts = [];
		Transaction.prototype.commit = function (...args) {
			const attempt = {};
			attempts.push(attempt);
			return originalCommit.apply(this, args).then(
				(result) => {
					attempt.result = result;
					return result;
				},
				(error) => {
					attempt.code = error.code;
					throw error;
				}
			);
		};
		return {
			get conflicted() {
				return attempts.some(
					(attempt) =>
						attempt.result === RETRY_NOW_VALUE || attempt.code === 'ERR_BUSY' || attempt.code === 'ERR_TRY_AGAIN'
				);
			},
			restore: () => (Transaction.prototype.commit = originalCommit),
		};
	}

	it('persists one transaction-log entry and one fold for N concurrent identical patches', async function () {
		if (isLMDB) return this.skip();
		this.timeout(30000);
		const id = 'multi-path-increment';
		const nodeId = Replicated.auditStore.ensureLogExists('duplicate-apply-origin');
		await Replicated.put(id, { id, count: 0 });
		// A version ahead of the record's own so every delivery takes the in-order apply path, which
		// is where the field amplification happened; the identity tie is what the twins collide on.
		const version = Replicated.primaryStore.getMonotonicTimestamp() + 100000;
		const increment = { count: { __op__: 'add', value: 1 } };
		const spy = spyOnCommits();
		let outcomes;
		try {
			outcomes = await Promise.allSettled(
				Array.from({ length: PATHS }, () => applyFromPeer(id, increment, false, version, nodeId))
			);
		} finally {
			spy.restore();
		}
		assert.deepEqual(
			outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason.message),
			[],
			'every delivery must settle: a source apply has no resume path that could recover a dropped write'
		);
		assert.ok(spy.conflicted, 'premise: the deliveries must actually race for the record write');
		await waitFor(() => entriesForIdentity(id, version, nodeId) > 0, {
			message: 'the write must leave a transaction-log entry',
		});
		// Fixed settle, not a condition wait: the assertion is that no further entry appears.
		await delay(250);
		assert.equal(
			entriesForIdentity(id, version, nodeId),
			1,
			'one write delivered over many paths is one transaction-log entry'
		);
		assert.equal((await Replicated.get(id)).count, 1, 'the commutative op must be folded exactly once');
	});

	it('still dedupes a re-delivery that arrives after the first has committed', async function () {
		if (isLMDB) return this.skip();
		this.timeout(30000);
		const id = 'sequential-redelivery';
		const nodeId = Replicated.auditStore.ensureLogExists('redelivery-origin');
		await Replicated.put(id, { id, count: 0 });
		const version = Replicated.primaryStore.getMonotonicTimestamp() + 100000;
		const increment = { count: { __op__: 'add', value: 1 } };
		for (let i = 0; i < 5; i++) await applyFromPeer(id, increment, false, version, nodeId);
		await delay(250);
		assert.equal(entriesForIdentity(id, version, nodeId), 1, 'a re-delivered write must not add an entry');
		assert.equal((await Replicated.get(id)).count, 1, 'a re-delivered write must not re-fold its op');
	});

	it('keeps distinct origins that share a version as distinct writes', async function () {
		if (isLMDB) return this.skip();
		this.timeout(30000);
		const id = 'distinct-origins';
		const nodeA = Replicated.auditStore.ensureLogExists('distinct-origin-a');
		const nodeB = Replicated.auditStore.ensureLogExists('distinct-origin-b');
		await Replicated.put(id, { id, count: 0 });
		const version = Replicated.primaryStore.getMonotonicTimestamp() + 100000;
		const increment = { count: { __op__: 'add', value: 1 } };
		await Promise.all([
			applyFromPeer(id, increment, false, version, nodeA),
			applyFromPeer(id, increment, false, version, nodeB),
		]);
		await waitFor(
			() => entriesForIdentity(id, version, nodeA) === 1 && entriesForIdentity(id, version, nodeB) === 1,
			{ message: 'two origins at the same version are two writes, each with its own entry' }
		);
		assert.equal((await Replicated.get(id)).count, 2, 'both origins must fold');
	});
});
