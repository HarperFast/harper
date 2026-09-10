// Commit handlers must run in staging order, so that the per-key write chain (harper#1968) describes
// what actually ran. A delete saves eagerly in addWrite() while a `deferSave` put waits for the commit
// loop, and the source-apply path never calls resource.save() on its puts — so a pair staged
// put-then-delete used to run delete-then-put with neither on the other's chain. Both diffed against
// the pre-transaction record: the delete stripped every index entry, and the put (indexed values
// unchanged against that same record) did no index work and re-stored the record (harper#2211).
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { ImmediateTransaction } = require('#src/resources/DatabaseTransaction');

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

// Stage a write the way the replication apply loop's writeUpdate() does: resolve the resource, then
// call the internal write directly. Notably it never calls resource.save(), which is what leaves a
// put staged but unexecuted until the commit loop.
async function applyPut(Inst, id, value, context) {
	const options = { isNotification: true, ensureLoaded: false, async: true };
	const resource = await Inst.getResource(id, context, options);
	return resource._writeUpdate(id, value, true, options);
}
async function applyDelete(Inst, id, context) {
	const options = { isNotification: true, ensureLoaded: false, async: true };
	const resource = await Inst.getResource(id, context, options);
	return resource._writeDelete(id, options);
}
async function applyInvalidate(Inst, id, value, context) {
	const options = { isNotification: true, ensureLoaded: false, async: true };
	const resource = await Inst.getResource(id, context, options);
	return resource._writeInvalidate(id, value, options);
}

describe('secondary index vs. write staging order in one transaction', () => {
	let Inst;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Inst = table({
			table: 'IndexStagingOrder',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'line', indexed: true },
				{ name: 'user', indexed: true },
			],
			audit: true,
		});
		if (Inst.indexingOperation) await Inst.indexingOperation;
	});

	async function indexedUnder(attribute, value, id) {
		const rows = await collect(Inst.search({ conditions: [{ attribute, value }] }));
		return rows.some((row) => row.id === id);
	}

	// The record and its index entries must agree: either the record is gone and nothing indexes it,
	// or it is present and every indexed attribute finds it. A live record missing from its own
	// indexes is unreachable through every indexed search and is not repairable by rewriting it.
	async function assertConsistent(id, note) {
		const record = await Inst.get(id);
		const inLine = await indexedUnder('line', 'L', id);
		const inUser = await indexedUnder('user', 'U', id);
		if (record) {
			assert.ok(inLine, `${note}: record is present but missing from the line index`);
			assert.ok(inUser, `${note}: record is present but missing from the user index`);
		} else {
			assert.ok(!inLine, `${note}: record is deleted but still in the line index`);
			assert.ok(!inUser, `${note}: record is deleted but still in the user index`);
		}
		return record;
	}

	it('delete staged before put: the record is recreated and indexed', async () => {
		await Inst.put({ id: 'in-order', line: 'L', user: 'U', n: 1 });
		const context = {};
		await transaction(context, async () => {
			await applyDelete(Inst, 'in-order', context);
			await applyPut(Inst, 'in-order', { id: 'in-order', line: 'L', user: 'U', n: 2 }, context);
		});
		const record = await assertConsistent('in-order', 'delete-then-put');
		assert.strictEqual(record?.n, 2, 'the put must win, it was staged last');
	});

	it('put staged before delete: the delete wins and leaves no index entries behind', async () => {
		await Inst.put({ id: 'reordered', line: 'L', user: 'U', n: 1 });
		assert.ok(await indexedUnder('line', 'L', 'reordered'), 'precondition: the record starts indexed');
		const context = {};
		await transaction(context, async () => {
			await applyPut(Inst, 'reordered', { id: 'reordered', line: 'L', user: 'U', n: 2 }, context);
			await applyDelete(Inst, 'reordered', context);
		});
		const record = await assertConsistent('reordered', 'put-then-delete');
		assert.ok(record == null, 'the delete must win, it was staged last');
	});

	// An eager write that neither reads nor publishes staged state (invalidate, relocate, publish) sits
	// between the put and the delete. It saves eagerly, so the delete's IMMEDIATE prior is already saved
	// — only walking the whole per-key chain keeps the delete behind the still-unsaved put.
	it('an intervening eager write does not let a delete run ahead of the staged put', async () => {
		await Inst.put({ id: 'sandwich', line: 'L', user: 'U', n: 1 });
		assert.ok(await indexedUnder('line', 'L', 'sandwich'), 'precondition: the record starts indexed');
		const context = {};
		await transaction(context, async () => {
			await applyPut(Inst, 'sandwich', { id: 'sandwich', line: 'L', user: 'U', n: 2 }, context);
			await applyInvalidate(Inst, 'sandwich', { id: 'sandwich', line: 'L', user: 'U', n: 2 }, context);
			await applyDelete(Inst, 'sandwich', context);
		});
		const record = await assertConsistent('sandwich', 'put-invalidate-delete');
		assert.ok(record == null, 'the delete must win, it was staged last');
	});

	// Many writes to one key in a single transaction: exercises addWrite's compressed chain walk and
	// keeps the final state consistent whichever way the pair is staged.
	it('a burst of same-key writes in one transaction stays consistent', async () => {
		await Inst.put({ id: 'burst', line: 'L', user: 'U', n: 0 });
		const context = {};
		await transaction(context, async () => {
			for (let i = 1; i <= 20; i++) {
				await applyPut(Inst, 'burst', { id: 'burst', line: 'L', user: 'U', n: i }, context);
				await applyDelete(Inst, 'burst', context);
			}
			await applyPut(Inst, 'burst', { id: 'burst', line: 'L', user: 'U', n: 99 }, context);
		});
		const record = await assertConsistent('burst', 'same-key burst');
		assert.strictEqual(record?.n, 99, 'the last staged write must win');
	});

	// ImmediateTransaction.save() IS its commit trigger, so a write deferred there would have nothing to
	// run it. addWrite must never hold a write back on such a transaction, however its predecessors look.
	// save() is stubbed so this exercises addWrite's decision alone, on either storage engine —
	// ImmediateTransaction is RocksDB-only and its real save() builds a RocksTransaction from the store.
	it('never defers a write on a transaction whose save() is the commit trigger', () => {
		const store = { name: 'stub' };
		const txn = new ImmediateTransaction(store);
		const saved = [];
		txn.save = (operation) => {
			saved.push(operation);
			operation.saved = true;
		};
		const unsavedPut = { key: 'guard', store, deferSave: true };
		txn.addWrite(unsavedPut);
		assert.deepStrictEqual(saved, [], 'a deferSave write must not be saved at addWrite');
		const chainedDelete = { key: 'guard', store, chainsStagedState: true };
		txn.addWrite(chainedDelete);
		assert.deepStrictEqual(saved, [chainedDelete], 'the write was deferred with nothing left to run it');
	});

	// The permanence half of harper#2211: updateIndices() short-circuits when the indexed value is
	// unchanged, so a record that ever loses an entry can never get it back from an ordinary write.
	// With the ordering fixed there is nothing to repair, but a divergence must not be reachable by
	// simply replaying the same write.
	it('repeated replace-all rounds stay consistent', async () => {
		await Inst.put({ id: 'repeat', line: 'L', user: 'U', n: 0 });
		for (let round = 1; round <= 5; round++) {
			const context = {};
			await transaction(context, async () => {
				// alternate the staging order to cover both races
				if (round % 2) {
					await applyPut(Inst, 'repeat', { id: 'repeat', line: 'L', user: 'U', n: round }, context);
					await applyDelete(Inst, 'repeat', context);
				} else {
					await applyDelete(Inst, 'repeat', context);
					await applyPut(Inst, 'repeat', { id: 'repeat', line: 'L', user: 'U', n: round }, context);
				}
			});
			await assertConsistent('repeat', `round ${round}`);
		}
	});
});
