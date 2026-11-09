const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { lockAttemptKey } = require('#src/resources/recordLock');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const ATTRIBUTES = [
	{ name: 'id', isPrimaryKey: true, type: 'String' },
	{ name: 'n', type: 'Int', indexed: true },
];

// Settled at launch, so a lock() that rejects before the test awaits it is not an unhandled rejection.
function settle(promise) {
	return promise.then(
		(value) => ({ value }),
		(error) => ({ error })
	);
}

const isRelockDuringCommit = (error) =>
	error?.statusCode === 409 && /await that commit, then lock the record again/.test(error.message);
const isClosedForIterators = (error) =>
	error?.statusCode === 409 && /mid-scope commit made while a read iterator was open/.test(error.message);
const isCommittedDatabase = (error) =>
	error?.statusCode === 409 && /whose database this commit has already committed/.test(error.message);
const isEndedScope = (error) =>
	error?.statusCode === 500 && /Transaction was closed while waiting for a record lock/.test(error.message);

// lock() in a transaction() scope whose link is CLOSED but whose scope has not ended (harper#4081)
describe('lock() on a transaction() scope closed by its own commit', function () {
	this.timeout(10000);
	let Head;
	let Other;
	let SourcedOther;
	let sourcePut;
	let nextId = 1;
	const id = () => `closure-${nextId++}`;
	const holds = [];

	before(function () {
		if (isLMDB) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Head = table({
			table: 'ScopeClosureHead',
			database: 'scope_closure_head',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		Other = table({
			table: 'ScopeClosureOther',
			database: 'scope_closure_other',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		SourcedOther = table({
			table: 'ScopeClosureSourced',
			database: 'scope_closure_other',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		SourcedOther.sourcedFrom({
			get() {},
			put(sourcedId, record, context) {
				return sourcePut?.(sourcedId, record, context);
			},
		});
	});

	afterEach(async function () {
		sourcePut = undefined;
		while (holds.length) await holds.pop().unlock();
	});

	after(async function () {
		await resetDatabases();
	});

	// another context's hold, so a lock() of the record in the scope waits for it
	async function contend(Locked, recordId) {
		const contender = await Locked.lock(recordId, { hold: true, lease: 10000 }, {});
		holds.push(contender);
		return contender;
	}

	async function lockableAfterwards(Locked, recordId) {
		holds.push(await Locked.lock(recordId, { hold: true, timeout: 500 }, {}));
	}

	describe('re-locking through the instance that holds the lock while its commit is in flight', function () {
		it('is refused with 409, and a fresh lock after the commit covers the rest of the scope', async function () {
			const recordId = id();
			await Head.put({ id: recordId, n: 1 });
			await transaction({}, async (txn) => {
				const locked = await Head.lock(recordId);
				locked.set('n', 2);
				const committing = txn.commit();
				const relock = await settle(locked.lock());
				assert.ok(isRelockDuringCommit(relock.error), relock.error?.message ?? 'the re-lock was admitted');
				await committing;
				const fresh = await Head.lock(recordId);
				fresh.set('n', 3);
			});
			assert.strictEqual((await Head.get(recordId)).n, 3);
			await lockableAfterwards(Head, recordId);
		});

		it('is still re-entrant for a hold, which outlives the commit', async function () {
			const recordId = id();
			await Head.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async (txn) => {
				const held = await Head.lock(recordId, { hold: true, lease: 5000 });
				holds.push(held);
				held.set('n', 2);
				await held.save();
				const committing = txn.commit();
				assert.strictEqual(await held.lock({ hold: true, lease: 5000 }), held);
				await committing;
			});
			assert.strictEqual((await Head.get(recordId)).n, 2);
		});
	});

	describe('after a mid-scope commit made while a read iterator was open', function () {
		async function commitWithOpenIterator(txn, context) {
			await Head.put({ id: id(), n: 1 }, context);
			const iterator = Head.search({ conditions: [{ attribute: 'n', comparator: 'greater_than', value: 0 }] }, context)[
				Symbol.iterator
			]();
			iterator.next();
			await txn.commit();
			assert.strictEqual(txn.open, TRANSACTION_STATE.CLOSED, 'premise: the open iterator kept the scope closed');
			return iterator;
		}

		for (const [where, lockedTable] of [
			['the head database', () => Head],
			['another database', () => Other],
		]) {
			it(`refuses a lock() on ${where} with 409, before and after the iterator is returned`, async function () {
				const Locked = lockedTable();
				const recordId = id();
				await Locked.put({ id: recordId, n: 1 });
				const context = {};
				await transaction(context, async (txn) => {
					const iterator = await commitWithOpenIterator(txn, context);
					const before = await settle(Locked.lock(recordId, { timeout: 500 }, context));
					assert.ok(isClosedForIterators(before.error), before.error?.message ?? 'the lock was admitted');
					iterator.return();
					const after = await settle(Locked.lock(recordId, { timeout: 500 }, context));
					assert.ok(isClosedForIterators(after.error), after.error?.message ?? 'the lock was admitted');
				});
				await lockableAfterwards(Locked, recordId);
			});
		}

		for (const ending of ['still running', 'aborted']) {
			it(`answers a lock() that was waiting ${ending === 'aborted' ? 'with 500 once the scope aborted' : 'with 409 while the scope still runs'}`, async function () {
				const recordId = id();
				await Head.put({ id: recordId, n: 1 });
				const contender = await contend(Head, recordId);
				const context = {};
				let waiter;
				const scope = transaction(context, async (txn) => {
					waiter = settle(Head.lock(recordId, { timeout: 5000 }, context));
					const iterator = await commitWithOpenIterator(txn, context);
					if (ending === 'aborted') throw new Error('rollback');
					await contender.unlock();
					const outcome = await waiter;
					iterator.return();
					assert.ok(isClosedForIterators(outcome.error), outcome.error?.message ?? 'the lock was admitted');
				});
				if (ending === 'aborted') {
					await assert.rejects(scope, /rollback/);
					await contender.unlock();
					const outcome = await waiter;
					assert.ok(isEndedScope(outcome.error), outcome.error?.message ?? 'the lock was admitted');
				} else await scope;
				await lockableAfterwards(Head, recordId);
			});
		}
	});

	describe("from a chained database's pre-commit hook", function () {
		for (const catches of [true, false]) {
			it(`refuses a lock() of a head-database record with 409 (hook ${catches ? 'catches it' : 'rethrows'})`, async function () {
				const headId = id();
				const sourcedId = id();
				await Head.put({ id: headId, n: 1 });
				await SourcedOther.put({ id: sourcedId, n: 1 });
				let refusal;
				sourcePut = (_id, _record, context) =>
					Head.lock(headId, { timeout: 500 }, context).then(
						(locked) => locked.unlock(),
						(error) => {
							refusal = error;
							if (!catches) throw error;
						}
					);
				const context = {};
				const scope = transaction(context, async () => {
					await Head.put({ id: id(), n: 1 }, context);
					// deferred, so its hook runs in the chained link's own commit, after the head committed
					const sourced = await SourcedOther.update(sourcedId, {}, context);
					sourced.set('n', 2);
				});
				if (catches) await scope;
				else await assert.rejects(scope, isCommittedDatabase);
				assert.ok(isCommittedDatabase(refusal), refusal?.message ?? 'the hook lock was admitted');
				assert.strictEqual((await SourcedOther.get(sourcedId)).n, catches ? 2 : 1);
				await lockableAfterwards(Head, headId);
			});
		}

		it("still admits the hook's lock() of a record in its own database, and releases it with the commit", async function () {
			const otherId = id();
			const sourcedId = id();
			await Other.put({ id: otherId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			let hookLocked;
			sourcePut = (_id, _record, context) =>
				Other.lock(otherId, { timeout: 500 }, context).then((locked) => (hookLocked = locked));
			const context = {};
			await transaction(context, async () => {
				const sourced = await SourcedOther.update(sourcedId, {}, context);
				sourced.set('n', 2);
			});
			assert.strictEqual(hookLocked?.id, otherId);
			await waitFor(() => !Other.primaryStore.hasLock(lockAttemptKey(Other.tableId, otherId)), {
				message: "the hook's scoped lock is released with the commit",
			});
			await lockableAfterwards(Other, otherId);
		});
	});
});
