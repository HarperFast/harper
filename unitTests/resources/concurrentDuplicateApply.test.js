require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');

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
		// Spans, not a conflict count: with the deliveries deduped before they stage there is no
		// conflict left to observe, so the premise this has to pin is that they were genuinely in
		// flight together — an awaited sequence of re-deliveries is a different (already handled) case.
		const spans = [];
		const timed = (promise) => {
			const span = { start: performance.now(), end: Infinity };
			spans.push(span);
			return promise.finally(() => (span.end = performance.now()));
		};
		const outcomes = await Promise.allSettled(
			Array.from({ length: PATHS }, () => timed(applyFromPeer(id, increment, false, version, nodeId)))
		);
		assert.deepEqual(
			outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason.message),
			[],
			'every delivery must settle: a source apply has no resume path that could recover a dropped write'
		);
		const latestStart = Math.max(...spans.map((span) => span.start));
		assert.ok(
			spans.filter((span) => span.end >= latestStart).length === PATHS,
			'premise: every delivery must still be in flight when the last one starts'
		);
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

	it('does not multiply the entries of a duplicated transaction that writes one key twice', async function () {
		if (isLMDB) return this.skip();
		this.timeout(30000);
		// Same-key writes chained in one transaction share the whole write identity — they carry the
		// transaction's single timestamp (harper#2211, and harper#2412 names this as an open
		// write-identity question) — so a chained write must inherit its predecessor's disposition
		// instead of reading itself as a duplicate of it, in both directions: two entries for one
		// delivery, and still two when that delivery arrives three times at once.
		const id = 'chained-same-key';
		const nodeId = Replicated.auditStore.ensureLogExists('chained-origin');
		await Replicated.put(id, { id, count: 0 });
		const version = Replicated.primaryStore.getMonotonicTimestamp() + 100000;
		const writes = [{ name: 'first', count: { __op__: 'add', value: 1 } }, { name: 'second' }];
		const deliverTransaction = () => {
			const context = { sourceApply: true, timestamp: version, source: {} };
			const options = { isNotification: true, ensureLoaded: false, nodeId, async: true };
			return transaction(context, async () => {
				for (const update of writes) {
					const resource = await Replicated.getResource(id, context, options);
					await resource._writeUpdate(id, update, false, options);
				}
			});
		};
		await Promise.all([deliverTransaction(), deliverTransaction(), deliverTransaction()]);
		// Fixed settle, not a condition wait: the assertion is that no further entry appears.
		await delay(250);
		assert.equal(
			entriesForIdentity(id, version, nodeId),
			writes.length,
			'a duplicated transaction must leave the entries of one delivery, not of three'
		);
		const record = await Replicated.get(id);
		assert.equal(record.count, 1, 'the commutative op must be folded exactly once');
		assert.equal(record.name, 'second', 'the later write in the chain must still win');
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
