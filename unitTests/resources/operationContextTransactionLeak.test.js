const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const { contextStorage } = require('#src/resources/transaction');
const { TRANSACTION_STATE, DatabaseTransaction, RELEASED_TRANSACTION } = require('#src/resources/DatabaseTransaction');

// Regression coverage for a transaction-context leak exposed by issue #1591/#1592 (ambient user
// context for operation handlers) and confirmed against a real 2-node cluster-formation scenario
// (harper-pro integrationTests/cluster/replicationTopology.test.mjs, bisected to core commit
// af646222d) — see harper-pro replication/subscriptionManager.ts's ensureNode(), which is called
// twice in sequence (once for "this node", once for a peer) from a single add_node/add_node_back
// operation handler.
//
// processLocalTransaction now wraps an entire operation handler invocation in one
// contextStorage.run({ user: hdbUser }, ...) call, installing a *single, long-lived, mutable*
// context object as the ambient store for the whole handler. resources/transaction.ts's
// transaction() helper mutates that shared object in place (context.transaction = <txn>) as a side
// effect of servicing the *first* static Resource API write made with no explicit context. Because
// the object is shared, that leftover `.transaction` reference is then visible to any *subsequent*,
// logically-independent static Resource API write made later in the same handler — and
// resources/Resource.ts's dispatcher decides whether to join an existing transaction purely via
// `if (context?.transaction)` truthiness, with no check that the transaction is still meaningfully
// open for a *fresh, unrelated* write. The two writes get folded into one transaction whose commit
// lifecycle was only ever driven by the second call, and the first call's write is silently lost.
//
// Before #1591, every internal, no-explicit-context static Resource API call resolved ambient
// context via `contextStorage.getStore() ?? {}`, and the store was always empty for operation
// handlers (nothing ever populated it), so each call always got its own fresh, throwaway `{}` and
// could never observe another call's transaction.
describe('Ambient operation context must not couple independent writes (transaction leak, issue #1591 side effect)', () => {
	let LeakTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		LeakTable = table({
			table: 'LeakTable',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	it('persists two sequential no-explicit-context writes made inside one ambient-user operation', async () => {
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'internal_bookkeeping' } } },
			async () => {
				// Mirrors setNode()/addNodeBack(): a preceding static-API *read* (e.g.
				// getReplicationCertAuth()'s hdb_certificate lookup) establishes the first transaction on
				// the shared ambient context, before ensureNode() is called twice in sequence (once for
				// "this node", once for a peer) — two logically-independent records, written through the
				// static Resource API with no explicit context, both relying on ambient contextStorage
				// fallback.
				await LeakTable.get('does-not-exist-yet');
				await LeakTable.put('first-record', { name: 'first' });
				await LeakTable.put('second-record', { name: 'second' });
				return { message: 'ok' };
			}
		);

		const first = await LeakTable.get('first-record');
		const second = await LeakTable.get('second-record');
		assert.ok(
			first,
			'first-record must persist: it must not be silently dropped by a leaked/shared transaction from the ambient operation context'
		);
		assert.equal(first?.name, 'first');
		assert.ok(second, 'second-record must persist');
		assert.equal(second?.name, 'second');
	});

	it('persists three sequential no-explicit-context writes made inside one ambient-user operation', async () => {
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'internal_bookkeeping' } } },
			async () => {
				await LeakTable.get('does-not-exist-yet-2');
				await LeakTable.put('r1', { name: 'r1' });
				await LeakTable.put('r2', { name: 'r2' });
				await LeakTable.put('r3', { name: 'r3' });
				return { message: 'ok' };
			}
		);

		for (const id of ['r1', 'r2', 'r3']) {
			const record = await LeakTable.get(id);
			assert.ok(record, `${id} must persist`);
			assert.equal(record?.name, id);
		}
	});

	it('persists a write made after a search() iterator leaves the shared context.transaction non-OPEN', async () => {
		// Mirrors harper-pro security/certificate.ts's signCertificate(), which does
		// `for await (const cert of certificateTable.search([])) {...}` (a long-lived static-API read
		// iterator) before later code in the same operation handler calls setCertTable() /
		// ensureNode(), which write through the static API with no explicit context. A search()
		// iterator is exactly the kind of read that can leave the shared ambient context's
		// `.transaction` in a LINGERING (not OPEN) state once it completes, rather than a plain get().
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'internal_bookkeeping' } } },
			async () => {
				await LeakTable.put('pre-existing', { name: 'pre-existing' });
				// eslint-disable-next-line no-empty
				for await (const _record of LeakTable.search([])) {
					// drain the iterator, as signCertificate() does
				}
				// At this point the shared ambient context's .transaction (if still attached at all)
				// must not be treated as an open scope for the next, unrelated write below — assert the
				// invariant directly so this test still documents the mechanism if the write-loss
				// symptom is ever masked by an unrelated change.
				const ambientTransaction = contextStorage.getStore()?.transaction;
				if (ambientTransaction) {
					assert.notEqual(
						ambientTransaction.open,
						TRANSACTION_STATE.OPEN,
						'test setup assumption: the drained search() transaction should no longer be OPEN by the time this write runs — if it is, this test is not exercising the leak scenario'
					);
				}
				await LeakTable.put('after-search', { name: 'after-search' });
				return { message: 'ok' };
			}
		);

		const preExisting = await LeakTable.get('pre-existing');
		const afterSearch = await LeakTable.get('after-search');
		assert.ok(preExisting, 'pre-existing record must still be present');
		assert.ok(afterSearch, 'write made after draining a search() iterator must persist');
		assert.equal(afterSearch?.name, 'after-search');
	});

	// The three tests above assert final persistence, which a reviewer (cb1kenobi, PR #1720) found
	// does not actually discriminate buggy vs. fixed code: reverting Resource.ts's fix back to the
	// bare `if (context?.transaction)` truthiness check and re-running them still passes 3/3, because
	// by the time a second write joins the stale, already-committed transaction from the first call,
	// DatabaseTransaction's addWrite()/save() takes an immediate-commit path for a closed transaction,
	// so the write still lands. That masks the actual bug in this isolated single-process unit setup,
	// even though the same coalescing was proven to silently drop a write in the live 4-node cluster
	// integration test (harper-pro's replicationTopology.test.mjs) that originally caught this.
	//
	// This test originally proved the mechanism via the leftover `.transaction` reference each
	// write left attached to the shared ambient context after it completed: distinct instances
	// proved each independent write got its own transaction rather than coalescing into a prior,
	// already-completed one. That leftover reference no longer survives past completion —
	// DatabaseTransaction now releases the context's back-reference the instant it completes
	// (commit or abort; see DatabaseTransaction.ts's releaseContext(), added so a long-lived
	// context, e.g. an MQTT subscription context, can't keep pinning a finished transaction in
	// memory).
	//
	// That release also means this particular flow (a plain sequential write, no outstanding
	// iterators) can no longer discriminate a #1591 dispatcher revert: once the prior write's
	// commit has released the slot to `null`, BOTH the fixed `.open === TRANSACTION_STATE.OPEN`
	// check and the old, buggy bare-truthiness `if (context?.transaction)` check see the same
	// falsy value and take the "start a fresh transaction" branch — a revert would still pass the
	// assertions below. The #1591 scenario (a truthy-but-non-OPEN reference genuinely observed by
	// the next call) still needs a case where release is deferred past the write that would
	// wrongly join it — see the search()-iterator test above, which exercises exactly that LINGERING
	// window. This test's job is narrower: pin that DatabaseTransaction's OWN release invariant
	// holds for a sequence of independent writes (each is released, and each really is a fresh
	// instance), which is what the assertions below check.
	//
	// Captured by hooking LeakTable.prototype.put — the per-record INSTANCE method Resource.ts's
	// dispatcher calls from inside the callback it hands to transaction() (resources/Table.ts's
	// put()), never before. `context.transaction` is unconditionally set before that callback ever
	// runs (resources/transaction.ts's transaction() assigns it, then invokes the callback), so this
	// hook point is correct regardless of whatever async work (authorization, resource resolution,
	// component loading) the dispatcher does on the way there — unlike peeking at the ambient context
	// synchronously right after issuing the call, which silently assumes no such work is ever async
	// (it can be, and intermittently was, under CI: a would-be "immediately available" read raced a
	// pending resolution and observed the write's transaction as not-yet-attached). Scoped to this one
	// test table's own prototype (an own-property override, shadowing but not touching the shared
	// `Table` base), so it can't count an unrelated background transaction the way stubbing
	// `DatabaseTransaction.prototype.setContext` — a hook shared by every table — would.
	it('releases each independent no-explicit-context write’s transaction from the ambient context once it completes, and each is a genuinely fresh instance (mechanism-level)', async () => {
		const transactionsSeenAfterEachWrite = [];
		const transactionsStarted = [];
		const originalPut = LeakTable.prototype.put;
		LeakTable.prototype.put = function (...args) {
			transactionsStarted.push(contextStorage.getStore()?.transaction);
			return originalPut.apply(this, args);
		};
		try {
			await serverUtilities.processLocalTransaction(
				{ body: { operation: 'test_registered_op', hdb_user: { username: 'internal_bookkeeping' } } },
				async () => {
					await LeakTable.put('mech-first', { name: 'first' });
					transactionsSeenAfterEachWrite.push(contextStorage.getStore()?.transaction);

					await LeakTable.put('mech-second', { name: 'second' });
					transactionsSeenAfterEachWrite.push(contextStorage.getStore()?.transaction);

					await LeakTable.put('mech-third', { name: 'third' });
					transactionsSeenAfterEachWrite.push(contextStorage.getStore()?.transaction);

					return { message: 'ok' };
				}
			);
		} finally {
			LeakTable.prototype.put = originalPut;
		}

		const [afterFirst, afterSecond, afterThird] = transactionsSeenAfterEachWrite;
		assert.strictEqual(
			afterFirst,
			RELEASED_TRANSACTION,
			"the first write's transaction must be released from the ambient context once its commit completes"
		);
		assert.strictEqual(
			afterSecond,
			RELEASED_TRANSACTION,
			"the second write's transaction must likewise be released, not left attached for a later write to observe"
		);
		assert.strictEqual(
			afterThird,
			RELEASED_TRANSACTION,
			"the third write's transaction must likewise be released, for the same reason"
		);

		assert.strictEqual(
			transactionsStarted.length,
			3,
			'each independent write must start its own transaction() call — none may join an existing OPEN transaction'
		);
		assert.ok(
			transactionsStarted.every((txn) => txn instanceof DatabaseTransaction),
			'each write must have a real DatabaseTransaction attached to the ambient context while it runs'
		);
		assert.notStrictEqual(
			transactionsStarted[0],
			transactionsStarted[1],
			'the second write must not join the first write’s transaction instance: each independent, ' +
				'no-explicit-context write must run in its own DatabaseTransaction, not a stale one left over ' +
				'from a prior, already-completed call on the shared ambient context — this is the #1591 ' +
				'dispatcher fix (resources/transaction.ts:35’s `.open === OPEN` check), not this PR’s release'
		);
		assert.notStrictEqual(
			transactionsStarted[1],
			transactionsStarted[2],
			'the third write must not join the second write’s transaction instance, for the same reason'
		);
	});

	// The delivery path: an operations-API handler under processLocalTransaction's ambient context reads
	// through that context and then commits it itself. transaction.test.js covers the same shape on a
	// bare `{}` context; only this one exercises the real ambient operation context.
	it('lets an operation handler commit its ambient context after a static read completed that context’s transaction', async () => {
		let committed = false;
		const result = await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'internal_bookkeeping' } } },
			async () => {
				const context = contextStorage.getStore();
				await LeakTable.get('handler-commit-target');
				// getUserPermissions()'s shape: bound the transaction the reads above ran in, then carry on.
				await context.transaction.commit();
				committed = true;
				await LeakTable.put('handler-commit-target', { name: 'written after the handler commit' });
				await context.transaction.commit();
				return { message: 'ok' };
			}
		);
		assert.equal(result?.message, 'ok', 'the handler must not fail on its own mid-handler commit');
		assert.ok(committed);
		const record = await LeakTable.get('handler-commit-target');
		assert.ok(record, 'the write made after the handler’s own commit must persist');
		assert.equal(record.name, 'written after the handler commit');
	});
});
