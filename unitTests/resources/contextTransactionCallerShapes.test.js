require('../testUtils');
const assert = require('node:assert');
const vm = require('node:vm');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction, contextStorage } = require('#src/resources/transaction');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const { RELEASED_TRANSACTION } = require('#src/resources/DatabaseTransaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// What application code observes on `context.transaction` once the transaction it held has completed, one
// test per caller shape. The slot's history: v5.2.0 left the completed transaction there; v5.2.1–v5.2.3 set
// it to `null` (#2030); v5.2.4 onward leaves RELEASED_TRANSACTION, a shared frozen placeholder (#2230). Shapes
// already pinned elsewhere: transaction.test.js ("Releasing the context back-reference…"),
// resumeAfterMidScopeCommit.test.js and releasedSlotScope.test.js.
describe('context.transaction after its transaction completes: caller shapes', function () {
	let Shape, ShapeOther;
	let nextId = 1;
	const newId = () => nextId++;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Shape = table({
			table: 'CallerShape',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		ShapeOther = table({
			table: 'CallerShapeOther',
			database: 'caller_shape_other',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	async function releasedContext() {
		const context = {};
		await Shape.put(newId(), { name: 'completes the context’s transaction' }, context);
		assert.ok(context.transaction === RELEASED_TRANSACTION, 'premise: the slot was released');
		return context;
	}

	it('every completion route leaves the released placeholder in a caller-held context', async function () {
		const routes = {
			'a static write with the context': (context) => Shape.put(newId(), { name: 'w' }, context),
			'a static read with the context': (context) => Shape.get(newId(), context),
			'a static write to a second database': (context) => ShapeOther.put(newId(), { name: 'w' }, context),
			'transaction(context, cb) resolving': (context) =>
				transaction(context, () => Shape.put(newId(), { name: 'w' }, context)),
			'transaction(context, cb) rejecting': (context) =>
				assert.rejects(
					transaction(context, async () => {
						await Shape.put(newId(), { name: 'rolled back' }, context);
						throw new Error('callback fails');
					}),
					/callback fails/
				),
		};
		for (const [route, complete] of Object.entries(routes)) {
			const context = {};
			await complete(context);
			assert.ok(context.transaction === RELEASED_TRANSACTION, route);
		}
		// The ambient (request/operation) context is released the same way, including by the no-context form.
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'caller_shape_op', hdb_user: { username: 'shape_user' } } },
			async () => {
				const ambient = contextStorage.getStore();
				await Shape.get(newId());
				assert.ok(ambient.transaction === RELEASED_TRANSACTION, 'a static read with no context argument');
				await transaction(() => Shape.put(newId(), { name: 'w' }));
				assert.ok(ambient.transaction === RELEASED_TRANSACTION, 'transaction(cb) with no context argument');
				return { message: 'ok' };
			}
		);
	});

	// v5.2.1–v5.2.3: falsy and `null`. v5.2.0: truthy (the completed transaction itself).
	it('truthiness and nullish checks on the slot see a non-null object after completion', async function () {
		const context = await releasedContext();
		assert.equal(Boolean(context.transaction), true);
		assert.equal(context.transaction == null, false);
		assert.equal(typeof (context.transaction ?? 'fallback'), 'object');
		assert.equal(context.transaction?.open, 0);
		assert.equal(Object.isFrozen(context.transaction), true);
	});

	// v5.2.1–v5.2.3 opened a scope here, so the write rolled back with the throw.
	it('an open-a-scope-if-absent guard skips the scope after completion, so guarded writes commit one by one', async function () {
		const context = await releasedContext();
		const inTransaction = (ctx, work) => (ctx.transaction ? work() : transaction(ctx, work));
		const written = newId();
		await assert.rejects(
			inTransaction(context, async () => {
				await Shape.put(written, { name: 'committed by its own scope' }, context);
				throw new Error('fails after the first write');
			}),
			/fails after the first write/
		);
		assert.equal((await Shape.get(written))?.name, 'committed by its own scope');
	});

	// v5.2.1–v5.2.3 skipped the guarded call; either way nothing is committed or aborted.
	it('a truthiness-guarded commit() or abort() now runs, and is a no-op', async function () {
		let context = await releasedContext();
		let committed;
		if (context.transaction) committed = await context.transaction.commit();
		assert.deepEqual(committed, { txnTime: 0 });
		context = await releasedContext();
		assert.equal(context.transaction ? context.transaction.abort() : 'skipped', undefined);
		context = await releasedContext();
		// v5.2.1–v5.2.3: undefined, the call short-circuited on `null`.
		assert.deepEqual(await context.transaction?.commit(), { txnTime: 0 });
	});

	// v5.2.1–v5.2.3 skipped the guarded block; v5.2.0 entered it and reached the completed transaction's own methods.
	it('a truthiness-guarded write onto the slot now throws', async function () {
		const context = await releasedContext();
		assert.throws(() => {
			if (context.transaction) context.transaction.addWrite({});
		}, /already completed/);
		assert.throws(() => {
			if (context.transaction) context.transaction.save();
		}, TypeError);
	});

	// v5.2.1–v5.2.3 threw on `null` in both modes; v5.2.0 stored the property on the completed transaction.
	it('assigning a property on the slot throws in strict code and is silently dropped in sloppy code', async function () {
		const context = await releasedContext();
		assert.throws(() => {
			'use strict';
			context.transaction.requestTag = 'tag';
		}, /not extensible/);
		const sloppyAssign = vm.runInThisContext('(slot) => { slot.requestTag = "tag"; return slot.requestTag; }');
		assert.equal(sloppyAssign(context.transaction), undefined);
	});

	// v5.2.1–v5.2.3 threw TypeError on `null` for a non-optional read.
	it('reads off the slot return closed, empty values rather than throwing', async function () {
		const context = await releasedContext();
		assert.equal(context.transaction.timestamp, undefined);
		assert.ok(context.transaction.db === undefined, 'no store is bound to the slot');
		assert.equal(context.transaction.writes.length, 0);
		assert.equal(Object.isFrozen(context.transaction.writes), true);
		assert.ok(context.transaction.getReadTxn() === undefined, 'reads through the slot pin no snapshot');
	});

	// v5.2.1–v5.2.3: `set(null)` threw "Invalid value used as weak map key". v5.2.0: one key per transaction.
	it('the slot is one shared identity across released contexts, so state keyed by it collides', async function () {
		const first = await releasedContext();
		const second = await releasedContext();
		assert.ok(first.transaction === second.transaction, 'both released slots hold the same object');
		const perTransactionState = new WeakMap();
		perTransactionState.set(first.transaction, 'state of the first request');
		assert.equal(perTransactionState.get(second.transaction), 'state of the first request');
	});

	// v5.2.1–v5.2.3: `"transaction":null`, and the context cloned. v5.2.0: JSON threw on a circular structure.
	it('serializing a released context carries the placeholder: JSON keeps two fields, structuredClone throws', async function () {
		const context = await releasedContext();
		context.user = { username: 'u' };
		assert.equal(JSON.stringify(context), '{"transaction":{"open":0,"writes":[]},"user":{"username":"u"}}');
		assert.throws(() => structuredClone(context), { name: 'DataCloneError' });
	});

	// The release targets the slot, not the instance the callback received (v5.2.0 left that instance in the slot).
	it('the transaction handed to the transaction() callback stays a callable, completed transaction afterwards', async function () {
		const context = {};
		let callbackTransaction;
		await transaction(context, (txn) => {
			callbackTransaction = txn;
			return Shape.put(newId(), { name: 'w' }, context);
		});
		assert.ok(callbackTransaction !== context.transaction, 'the slot no longer holds the callback’s transaction');
		assert.equal(callbackTransaction.open, 0);
		assert.deepEqual(await callbackTransaction.commit(), { txnTime: 0 });
	});

	// While the method runs, unchanged since v5.2.0. A context kept past its return holds whatever that version
	// leaves in a released slot (see the first test).
	it('a resource method sees the live transaction in its context, and a context it caches is released after it returns', async function () {
		let cachedContext, liveSlot;
		class Caching extends Shape {
			static loadAsInstance = false;
			async get(target) {
				cachedContext = this.getContext();
				liveSlot = cachedContext.transaction;
				assert.equal(liveSlot.open, 1);
				await Shape.put(newId(), { name: 'written inside the method' }, cachedContext);
				assert.ok(cachedContext.transaction === liveSlot, 'an awaited write joins the method’s scope');
				return super.get(target);
			}
		}
		const context = {};
		await Caching.get(newId(), context);
		assert.ok(cachedContext === context, 'getContext() returned the caller’s context');
		assert.ok(
			cachedContext.transaction === RELEASED_TRANSACTION,
			'the cached context is released once the method returns'
		);
	});

	// Through v5.2.4 the write after the commit ran in its own scope and left that scope's released slot behind:
	// a completed transaction (v5.2.0), `null` (v5.2.1–v5.2.3, so the second commit threw), the placeholder
	// (v5.2.4). Since v5.2.5 (#2239) the mid-scope commit reopens the scope's own transaction instead.
	it('inside a scope, the slot stays the live transaction after a mid-scope commit and a further write', async function () {
		const context = {};
		await transaction(context, async (txn) => {
			await Shape.put(newId(), { name: 'before the commit' }, context);
			await context.transaction.commit();
			await Shape.put(newId(), { name: 'after the commit' }, context);
			assert.ok(context.transaction === txn, 'the slot still holds the scope’s own transaction');
			assert.equal(context.transaction.open, 1);
			await context.transaction.commit();
		});
		assert.ok(context.transaction === RELEASED_TRANSACTION, 'the scope’s completion releases the slot');
	});

	// RocksDB defers the release while an iterator the scope returned still reads through the transaction
	// (true on every version since v5.2.1); LMDB releases at once. After draining, both hold the placeholder,
	// which was `null` on v5.2.1–v5.2.3 — so a truthiness check there depended on iterator timing.
	it('a context whose scope returned an undrained iterator is released once the iterator drains', async function () {
		await Shape.put(newId(), { name: 'iterated' });
		const context = {};
		const results = await transaction(context, () => Shape.search([], context));
		if (isLMDB)
			assert.ok(context.transaction === RELEASED_TRANSACTION, 'LMDB releases without waiting for the iterator');
		else {
			assert.ok(context.transaction !== RELEASED_TRANSACTION, 'RocksDB defers the release');
			assert.equal(context.transaction.open, 0, 'the completed transaction stays until the iterator drains');
		}
		for await (const _row of results);
		assert.ok(context.transaction === RELEASED_TRANSACTION, 'draining the iterator completes the release');
	});

	// The two-argument form detects "is this a context?" by `context.transaction || context.getContext`
	// (Resource.ts, transactional()), for the methods that declare no hasContent: update and subscribe.
	// v5.2.1–v5.2.3: a released context read as DATA — update() wrote its fields into the record and the call
	// ran without the caller's context. v5.2.0 and v5.2.4+: it reads as the context.
	it('update(id, context) and subscribe(id, context) treat a released context as the context', async function () {
		const id = newId();
		await Shape.put(id, { name: 'original' });
		const seen = {};
		class Observed extends Shape {
			static loadAsInstance = false;
			update(target, data) {
				seen.updateContext = this.getContext();
				seen.updateData = data;
				return super.update(target, data);
			}
			subscribe(target) {
				seen.subscribeContext = this.getContext();
				return super.subscribe(target);
			}
		}
		const context = await releasedContext();
		context.marker = 'context only';
		await Observed.update(id, context);
		assert.ok(seen.updateContext === context, 'update() ran with the caller’s context');
		assert.ok(seen.updateData === undefined, 'the context was not taken as update data');
		assert.equal((await Shape.get(id)).marker, undefined, 'no context field may be written into the record');
		const subscription = await Observed.subscribe(id, context);
		assert.ok(seen.subscribeContext === context, 'subscribe() ran with the caller’s context');
		subscription.end();
	});

	// The contrast that makes the previous shape depend on the slot: unchanged in every version.
	it('update(id, context) treats a context that never had a transaction as update data', async function () {
		const id = newId();
		await Shape.put(id, { name: 'original' });
		const freshContext = { marker: 'context only' };
		await Shape.update(id, freshContext);
		assert.equal((await Shape.get(id)).marker, 'context only');
	});

	// Methods that declare content need `context.transaction instanceof DatabaseTransaction` to read the second
	// argument as a context, which neither `null` (v5.2.1–v5.2.3) nor the placeholder is — so both store the
	// context as the record; only the stored slot value differs (`null` there). v5.2.0 read it as the context.
	it('put(id, context) with a released context stores the context as the record, slot included', async function () {
		const id = newId();
		const context = await releasedContext();
		context.marker = 'context only';
		await Shape.put(id, context);
		const stored = await Shape.get(id);
		assert.equal(stored.marker, 'context only');
		assert.equal(JSON.stringify(stored.transaction), '{"open":0,"writes":[]}');
	});
});
