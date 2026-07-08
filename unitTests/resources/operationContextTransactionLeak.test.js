const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const { contextStorage } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');

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
		assert.ok(first, 'first-record must persist: it must not be silently dropped by a leaked/shared transaction from the ambient operation context');
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
});
