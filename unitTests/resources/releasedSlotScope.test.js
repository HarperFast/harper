const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { DatabaseTransaction, RELEASED_TRANSACTION, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');

// The invariant under test is stated on isJoinableScope (DatabaseTransaction.ts) and in DESIGN.md.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('A self-committing transaction in the context slot is not a scope', () => {
	let A, Other, Third;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		A = table({ table: 'SlotA', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
		// A separate DATABASE, not just a second table: only this reaches txnForContext's `next` chain.
		Other = table({
			database: 'slot_other',
			table: 'SlotOther',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
		Third = table({
			database: 'slot_third',
			table: 'SlotThird',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
	});

	// The install path the #2288/#2292 traces go through: an instance load, which reaches txnForContext
	// directly rather than through the static-API wrapper that would have replaced a not-OPEN slot.
	async function installImmediateTransaction(context) {
		await A.put('installed', { v: 0 }, {});
		await A.getResource({ id: 'installed' }, context, {});
		assert.equal(
			context.transaction?.constructor?.name,
			'ImmediateTransaction',
			'premise: the slot must hold an ImmediateTransaction'
		);
		return context.transaction;
	}

	for (const [label, seed] of [
		['a released slot', () => RELEASED_TRANSACTION],
		['a slot that never had a transaction', () => undefined],
	]) {
		it(`rolls back a failed scope started from ${label}`, async function () {
			const context = { transaction: seed() };
			const installed = await installImmediateTransaction(context);
			await assert.rejects(
				transaction(context, async () => {
					await A.put(`fail-1-${label}`, { v: 1 }, context);
					await A.put(`fail-2-${label}`, { v: 2 }, context);
					throw new Error('forced failure');
				}),
				/forced failure/
			);
			assert.notEqual(context.transaction, installed, 'transaction() must not have joined the installed instance');
			assert.equal(await A.get(`fail-1-${label}`), undefined, 'the scope must roll its writes back as one unit');
			assert.equal(await A.get(`fail-2-${label}`), undefined);
		});

		it(`rolls a chained second database back with a failed scope started from ${label}`, async function () {
			const context = { transaction: seed() };
			await installImmediateTransaction(context);
			await assert.rejects(
				transaction(context, async () => {
					await A.put(`split-${label}`, { v: 1 }, context);
					await Other.put(`split-${label}`, { v: 1 }, context);
					throw new Error('forced failure');
				}),
				/forced failure/
			);
			assert.equal(await A.get(`split-${label}`), undefined, 'the head database must roll back');
			assert.equal(await Other.get(`split-${label}`), undefined, 'and so must the chained one — no split brain');
		});

		it(`commits a successful scope started from ${label}`, async function () {
			const context = { transaction: seed() };
			await installImmediateTransaction(context);
			await transaction(context, async () => {
				await A.put(`ok-1-${label}`, { v: 1 }, context);
				await Other.put(`ok-1-${label}`, { v: 1 }, context);
			});
			assert.ok(await A.get(`ok-1-${label}`), 'the scope’s writes must be durable once it completes');
			assert.ok(await Other.get(`ok-1-${label}`), 'including on a chained second database');
		});
	}

	// The dispatcher gates on the same slot state as transaction(), so a static-API call must not fold
	// its write into the installed instance either.
	it('does not let the dispatcher fold a write into the installed instance', async function () {
		const context = { transaction: RELEASED_TRANSACTION };
		const installed = await installImmediateTransaction(context);
		await A.put('dispatched', { v: 1 }, context);
		assert.equal(installed.open, TRANSACTION_STATE.OPEN, 'the installed instance must never have committed anything');
		assert.notEqual(context.transaction, installed, 'the dispatcher must have replaced the slot');
		assert.ok(await A.get('dispatched'), 'and the write must still be durable');
	});

	// A chained link inherits the head's commit discipline.
	it('commits further databases written through a self-committing head', async function () {
		await Other.put('chained', { v: 0 }, {});
		await Third.put('chained', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		await installImmediateTransaction(context);
		for (const [t, v] of [
			[Other, 7],
			[Third, 8], // a link off a link: the discipline has to be transitive down the chain
		]) {
			const resource = await t.getResource({ id: 'chained' }, context, {});
			resource.update({ v }, false);
			await resource.save();
		}
		assert.equal((await Other.get('chained'))?.v, 7, 'a write to the chained database must not be stranded');
		assert.equal((await Third.get('chained'))?.v, 8, 'nor one to a link chained off that link');
		// The link committed and closed on that first write. A second write must not be handed back to it:
		// its commit re-entry drops the promise the native commit resolves on (#2323).
		// Both links are spent by now, so this also covers a spent link behind another spent one.
		for (const [t, v] of [
			[Other, 71],
			[Third, 81],
		]) {
			const again = await t.getResource({ id: 'chained' }, context, {});
			again.update({ v }, false);
			const saved = again.save();
			assert.ok(typeof saved?.then === 'function', 'a further write to a spent link must be awaitable');
			await saved;
			assert.equal((await t.get('chained'))?.v, v, 'and durable by the time it resolves');
		}
		// The head's own commit now cascades onto links that already committed their own writes.
		const head = await A.getResource({ id: 'installed' }, context, {});
		head.update({ v: 9 }, false);
		await head.save();
		assert.equal((await A.get('installed'))?.v, 9, 'and a later write to the head’s database still commits');
	});

	// The gate is "commits each write itself", not "owned by a transaction() scope": a context pre-seeded
	// with an externally-driven DatabaseTransaction (replayLogs.ts, Table.ts) still owns the static API's
	// writes, so its own commit/abort still governs them.
	// RocksDB only: an LMDB seed has no db of its own, so the write lands on `next`, which
	// LMDBTransaction.abort() does not walk — the assertion would then hold either way.
	(isLMDB ? it.skip : it)('still lets a pre-seeded transaction own the writes it is given', async function () {
		const context = { transaction: new DatabaseTransaction() };
		await A.put('preseeded', { v: 1 }, context);
		assert.ok(context.transaction.writes.length > 0, 'premise: the write must have staged on the caller’s instance');
		context.transaction.abort();
		assert.equal(await A.get('preseeded'), undefined, 'the caller’s abort must still roll its write back');
	});

	// A tracked-instance update stages a DEFERRED write (deferSave) and resource.save() is only its
	// trigger, so save() has to reach the transaction that holds it.
	it('saves a deferred instance update even when the slot changes before save()', async function () {
		await A.put('deferred', { v: 0 }, {});
		await A.put('unrelated', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'deferred' }, context, {});
		row.update({ v: 9 }, false);
		await A.get('unrelated', context); // a static call in between, which may replace the slot
		await row.save();
		assert.equal((await A.get('deferred'))?.v, 9, 'the deferred update must not be dropped by a slot change');
	});

	it('saves a deferred instance update when an explicit scope opens before save()', async function () {
		await A.put('deferred-scope', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'deferred-scope' }, context, {});
		row.update({ v: 11 }, false);
		await transaction(context, () => row.save());
		assert.equal((await A.get('deferred-scope'))?.v, 11, 'the deferred update must not be dropped by a new scope');
	});

	// A deferred write triggered inside a scope belongs to that scope, even though it was staged before
	// the scope existed. The engines differ on how far that reaches: RocksDB's save() stages into the
	// scope's handle, so the scope can own a write held in another transaction's list; LMDB's save() is a
	// no-op (its commit applies its own `writes`), so there the holder keeps it.
	it('gives a deferred update saved inside a scope to that scope', async function () {
		await A.put('deferred-scoped', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'deferred-scoped' }, context, {});
		row.update({ v: 13 }, false);
		await assert.rejects(
			transaction(context, async () => {
				await row.save();
				await A.put('deferred-scoped-sibling', { v: 1 }, context);
				throw new Error('forced failure');
			}),
			/forced failure/
		);
		assert.equal(await A.get('deferred-scoped-sibling'), undefined, 'the scope’s own write must roll back');
		assert.equal(
			(await A.get('deferred-scoped'))?.v,
			isLMDB ? 13 : 0,
			isLMDB
				? 'on LMDB the write stays with the transaction holding it'
				: 'the deferred update must roll back with the scope'
		);
	});

	// The same scope with nothing of its own to commit: the write is staged in the earlier transaction's
	// list, so the scope's commit has to keep the handle that actually carries it.
	it('commits a deferred update that is the scope’s only write', async function () {
		await A.put('deferred-only', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'deferred-only' }, context, {});
		row.update({ v: 17 }, false);
		await transaction(context, () => row.save());
		assert.equal((await A.get('deferred-only'))?.v, 17, 'the scope must commit the write it was handed');
	});

	// An outstanding iterator makes the scope's commit replay its write set onto a fresh handle. A write
	// the scope took over has to be in that set, or the replay has nothing to commit and the handler is
	// told it succeeded over a record that never changed.
	it('commits a taken-over update whose scope commits under an open iterator', async function () {
		await A.put('foreign-iter', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'foreign-iter' }, context, {});
		row.update({ v: 23 }, false);
		let iterator;
		await transaction(context, async () => {
			await row.save();
			const results = await A.search([{ attribute: 'v', comparator: 'greater_than', value: -1 }], context);
			iterator = results[Symbol.asyncIterator]();
			await iterator.next(); // hold the handle open across the scope's commit
		});
		while (!(await iterator.next()).done); // drain, so the retained handle does not outlive the test
		assert.equal((await A.get('foreign-iter'))?.v, 23, 'the taken-over write must survive the replay commit');
	});

	// Two deferred writes to the SAME key chain to each other. When a scope takes the earlier one, the
	// later one must stop deriving its merge basis and index diff from it — that write is the scope's
	// now, and the scope may roll it back.
	// RocksDB only: LMDB has no takeover (stagesWriteOnSave), so both writes stay with their holder.
	(isLMDB ? it.skip : it)('unchains a same-key write left behind by a takeover', async function () {
		await A.put('same-key', { v: 0, other: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const first = await A.getResource({ id: 'same-key' }, context, {});
		first.update({ v: 31 }, false);
		const second = await A.getResource({ id: 'same-key' }, context, {});
		second.update({ other: 41 }, false);
		await assert.rejects(
			transaction(context, async () => {
				await first.save();
				throw new Error('forced failure');
			}),
			/forced failure/
		);
		await second.save();
		const record = await A.get('same-key');
		assert.equal(record?.v, 0, 'the taken-over write rolled back with the scope');
		assert.equal(record?.other, 41, 'and the write left behind still landed, on the committed record');
	});

	// A canonical-source apply never gives its write up: never-drop-on-conflict lives on the transaction,
	// so a scope taking the write over would silently drop it on a sustained conflict rather than retry
	// uncapped, and replication has no resume path for that (harper-pro#348).
	(isLMDB ? it.skip : it)('keeps a source-applied deferred write with its holder', async function () {
		await A.put('applied', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'applied' }, context, {});
		const holder = context.transaction;
		holder.sourceApply = true;
		row.update({ v: 61 }, false);
		await assert.rejects(
			transaction(context, async () => {
				await row.save();
				throw new Error('forced failure');
			}),
			/forced failure/
		);
		assert.equal((await A.get('applied'))?.v, 61, 'the apply must have committed on its own transaction');
	});

	// Non-regression: a deferred write triggered after the long-transaction monitor poisoned the
	// transaction holding it still fails with the rest of the operation (#1411).
	(isLMDB ? it.skip : it)('fails a deferred update whose holder was poisoned by a timeout', async function () {
		await A.put('poisoned', { v: 0 }, {});
		const context = { transaction: RELEASED_TRANSACTION };
		const row = await A.getResource({ id: 'poisoned' }, context, {});
		row.update({ v: 71 }, false);
		context.transaction.abortDueToTimeout();
		await assert.rejects(async () => row.save(), /open too long|transaction/i);
		assert.equal((await A.get('poisoned'))?.v, 0, 'the write must not have committed on the poisoned holder');
	});
});
