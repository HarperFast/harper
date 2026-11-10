const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { lockAttemptKey } = require('#src/resources/recordLock');
const { waitFor } = require('../waitFor');
const { setTimeout: delay } = require('node:timers/promises');
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
const isReleasedContext = (error) =>
	error?.statusCode === 409 && /after its transaction's final commit released the context/.test(error.message);
const isEndedScope = (error) =>
	error?.statusCode === 500 && /Transaction was closed while waiting for a record lock/.test(error.message);

describe('lock() on a transaction() scope closed by its own commit', function () {
	this.timeout(10000);
	let Head;
	let Other;
	let SourcedOther;
	let Nested;
	let sourcePut;
	let nestedPut;
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
		Nested = table({
			table: 'ScopeClosureNested',
			database: 'scope_closure_nested',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		Nested.sourcedFrom({
			get() {},
			put(nestedId, record, context) {
				return nestedPut?.(nestedId, record, context);
			},
		});
	});

	afterEach(async function () {
		sourcePut = undefined;
		nestedPut = undefined;
		while (holds.length) await holds.pop().unlock();
	});

	after(async function () {
		await resetDatabases();
	});

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

		it('is refused with 409 for an upgrade to a hold too, since the commit may be committing its staged write', async function () {
			const recordId = id();
			await Head.put({ id: recordId, n: 1 });
			await transaction({}, async (txn) => {
				const locked = await Head.lock(recordId);
				locked.set('n', 2);
				const committing = txn.commit();
				const upgrade = await settle(locked.lock({ hold: true, lease: 5000 }));
				assert.ok(isRelockDuringCommit(upgrade.error), upgrade.error?.message ?? 'the upgrade was admitted');
				await committing;
			});
			assert.strictEqual((await Head.get(recordId)).n, 2);
			await lockableAfterwards(Head, recordId);
		});

		it("is refused with 409 for another instance's upgrade to a hold too", async function () {
			const recordId = id();
			await Head.put({ id: recordId, n: 1 });
			const context = {};
			await transaction(context, async (txn) => {
				const locked = await Head.lock(recordId);
				locked.set('n', 2);
				const committing = txn.commit();
				const upgrade = await settle(Head.lock(recordId, { hold: true, lease: 5000 }, context));
				assert.ok(isRelockDuringCommit(upgrade.error), upgrade.error?.message ?? 'the upgrade was admitted');
				await committing;
			});
			assert.strictEqual((await Head.get(recordId)).n, 2);
			await lockableAfterwards(Head, recordId);
		});

		it("is refused with 409 for an upgrade from the commit's own pre-commit hook, and the commit keeps the write", async function () {
			const recordId = id();
			await SourcedOther.put({ id: recordId, n: 1 });
			let locked;
			let upgrade;
			sourcePut = async () => {
				sourcePut = undefined;
				upgrade = await settle(locked.lock({ hold: true, lease: 5000 }));
			};
			await transaction({}, async () => {
				locked = await SourcedOther.lock(recordId);
				locked.set('n', 2);
			});
			assert.ok(isRelockDuringCommit(upgrade?.error), upgrade?.error?.message ?? 'the upgrade was admitted');
			assert.strictEqual((await SourcedOther.get(recordId)).n, 2);
			await lockableAfterwards(SourcedOther, recordId);
		});

		for (const upgrade of [false, true])
			it(`is refused with 409 for ${upgrade ? 'an upgrade' : 'a re-lock'} from the commit's own hook after its first await in the final commit`, async function () {
				const recordId = id();
				await SourcedOther.put({ id: recordId, n: 1 });
				let locked;
				let relock;
				sourcePut = async () => {
					sourcePut = undefined;
					await delay(1);
					relock = await settle(upgrade ? locked.lock({ hold: true, lease: 5000 }) : locked.lock());
				};
				const context = {};
				await transaction(context, async () => {
					await Head.put({ id: id(), n: 1 }, context);
					locked = await SourcedOther.lock(recordId, {}, context);
					locked.set('n', 2);
				});
				assert.ok(isReleasedContext(relock?.error), relock?.error?.message ?? 'the re-entry was admitted');
				assert.strictEqual((await SourcedOther.get(recordId)).n, 2);
				await lockableAfterwards(SourcedOther, recordId);
			});

		it("is refused with 409 for an upgrade coalesced onto the commit's own hook's lock()", async function () {
			const recordId = id();
			const sourcedId = id();
			await Other.put({ id: recordId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			let outcomes;
			sourcePut = async (_id, _record, context) => {
				sourcePut = undefined;
				outcomes = await Promise.all([
					settle(Other.lock(recordId, { timeout: 500 }, context)),
					settle(Other.lock(recordId, { hold: true, lease: 5000, timeout: 500 }, context)),
				]);
			};
			await transaction({}, async (txn) => {
				const sourced = await SourcedOther.update(sourcedId, {}, txn);
				sourced.set('n', 2);
			});
			assert.ifError(outcomes[0].error);
			assert.ok(isRelockDuringCommit(outcomes[1].error), outcomes[1].error?.message ?? 'the upgrade was admitted');
			await lockableAfterwards(Other, recordId);
		});

		it("is refused with 409 during the scope's final commit too", async function () {
			const recordId = id();
			const sourcedId = id();
			await Head.put({ id: recordId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			let releaseHook;
			const hookGate = new Promise((resolve) => (releaseHook = resolve));
			let relock;
			sourcePut = () => hookGate;
			const scope = transaction({}, async (txn) => {
				const locked = await Head.lock(recordId);
				locked.set('n', 2);
				await SourcedOther.put({ id: sourcedId, n: 2 }, txn);
				setImmediate(() => (relock = settle(locked.lock())));
			});
			await waitFor(() => relock, { message: 'the re-lock should run while the final commit awaits the hook' });
			releaseHook();
			await scope;
			const outcome = await relock;
			assert.ok(isRelockDuringCommit(outcome.error), outcome.error?.message ?? 'the re-lock was admitted');
			assert.strictEqual((await Head.get(recordId)).n, 2);
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
			it(`refuses a lock() on ${where} with 409, before and after the iterator is returned, until a later commit reopens the scope`, async function () {
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
					await txn.commit();
					assert.strictEqual(
						txn.open,
						TRANSACTION_STATE.OPEN,
						'a commit after the iterator returned reopens the scope'
					);
					const relocked = await Locked.lock(recordId, { timeout: 500 }, context);
					relocked.set('n', 4);
				});
				assert.strictEqual((await Locked.get(recordId)).n, 4);
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

		for (const lockedTable of ['Head', 'Other'])
			it(`refuses a lock() of a ${lockedTable === 'Head' ? 'head-database' : 'same-database'} record after the hook's first await in the final commit, which released the context`, async function () {
				const Locked = lockedTable === 'Head' ? Head : Other;
				const lockedId = id();
				const sourcedId = id();
				await Locked.put({ id: lockedId, n: 1 });
				await SourcedOther.put({ id: sourcedId, n: 1 });
				let refusal;
				sourcePut = async (_id, _record, context) => {
					await delay(1);
					await Locked.lock(lockedId, { timeout: 500 }, context).then(
						(locked) => locked.unlock(),
						(error) => {
							refusal = error;
						}
					);
				};
				const context = {};
				await transaction(context, async () => {
					await Head.put({ id: id(), n: 1 }, context);
					const sourced = await SourcedOther.update(sourcedId, {}, context);
					sourced.set('n', 2);
				});
				assert.ok(isReleasedContext(refusal), refusal?.message ?? 'the hook lock was admitted');
				assert.strictEqual((await SourcedOther.get(sourcedId)).n, 2);
				await lockableAfterwards(Locked, lockedId);
			});

		it('refuses it with 409, not 500, when a head-database read iterator holds the final commit open', async function () {
			const headId = id();
			const sourcedId = id();
			await Head.put({ id: headId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			let refusal;
			sourcePut = async (_id, _record, context) => {
				sourcePut = undefined;
				await delay(1);
				await Head.lock(headId, { timeout: 500 }, context).then(
					(locked) => locked.unlock(),
					(error) => {
						refusal = error;
					}
				);
			};
			const context = {};
			let iterator;
			await transaction(context, async () => {
				await Head.put({ id: id(), n: 1 }, context);
				iterator = Head.search({ conditions: [{ attribute: 'n', comparator: 'greater_than', value: 0 }] }, context)[
					Symbol.iterator
				]();
				iterator.next();
				const sourced = await SourcedOther.update(sourcedId, {}, context);
				sourced.set('n', 2);
			});
			iterator.return();
			assert.ok(isCommittedDatabase(refusal), refusal?.message ?? 'the hook lock was admitted');
			await lockableAfterwards(Head, headId);
		});

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

	describe("from a hook nested under the commit's hook", function () {
		// a fresh context, so the nested hook runs in a commit whose root is not the scope's
		const nestUnderSourceHook = (nestedId) => {
			sourcePut = () => {
				sourcePut = undefined;
				return Nested.put({ id: nestedId, n: 2 }, {});
			};
		};

		for (const afterAwait of [false, true])
			it(`admits a lock() during a mid-scope commit${afterAwait ? ' after its first await' : ''}, and that commit releases it`, async function () {
				const sourcedId = id();
				const otherId = id();
				await SourcedOther.put({ id: sourcedId, n: 1 });
				await Other.put({ id: otherId, n: 1 });
				const context = {};
				let outcome;
				nestedPut = async () => {
					nestedPut = undefined;
					if (afterAwait) await delay(1);
					outcome = await settle(Other.lock(otherId, { timeout: 500 }, context));
				};
				nestUnderSourceHook(id());
				await transaction(context, async (txn) => {
					const sourced = await SourcedOther.update(sourcedId, {}, txn);
					sourced.set('n', 2);
					await txn.commit();
					assert.ifError(outcome?.error);
					assert.strictEqual(outcome?.value?.id, otherId);
					await waitFor(() => !Other.primaryStore.hasLock(lockAttemptKey(Other.tableId, otherId)), {
						message: "the nested hook's scoped lock is released with the mid-scope commit",
					});
				});
				assert.strictEqual((await SourcedOther.get(sourcedId)).n, 2);
				await lockableAfterwards(Other, otherId);
			});

		for (const upgrade of [false, true])
			it(`${upgrade ? "still refuses an upgrade of the scope's lock to a hold" : "admits a re-lock of the scope's lock"} during a mid-scope commit`, async function () {
				const sourcedId = id();
				const lockedId = id();
				await SourcedOther.put({ id: sourcedId, n: 1 });
				await Other.put({ id: lockedId, n: 1 });
				const context = {};
				let locked;
				let relock;
				nestedPut = async () => {
					nestedPut = undefined;
					relock = await settle(upgrade ? locked.lock({ hold: true, lease: 5000 }) : locked.lock());
				};
				nestUnderSourceHook(id());
				await transaction(context, async (txn) => {
					locked = await Other.lock(lockedId, {}, context);
					locked.set('n', 2);
					const sourced = await SourcedOther.update(sourcedId, {}, txn);
					sourced.set('n', 2);
					await txn.commit();
				});
				if (upgrade)
					assert.ok(isRelockDuringCommit(relock?.error), relock?.error?.message ?? 'the upgrade was admitted');
				else {
					assert.ifError(relock?.error);
					assert.ok(relock, 'premise: the nested hook ran');
				}
				assert.strictEqual((await Other.get(lockedId)).n, 2);
				await lockableAfterwards(Other, lockedId);
			});

		for (const catches of [true, false])
			it(`refuses a lock() of a head-database record under a chained database's hook with 409 (hook ${catches ? 'catches it' : 'rethrows'})`, async function () {
				const headId = id();
				const sourcedId = id();
				const nestedId = id();
				await Head.put({ id: headId, n: 1 });
				await SourcedOther.put({ id: sourcedId, n: 1 });
				await Nested.put({ id: nestedId, n: 1 });
				const context = {};
				let refusal;
				nestedPut = () => {
					nestedPut = undefined;
					return Head.lock(headId, { timeout: 500 }, context).then(
						(locked) => locked.unlock(),
						(error) => {
							refusal = error;
							if (!catches) throw error;
						}
					);
				};
				nestUnderSourceHook(nestedId);
				const scope = transaction(context, async () => {
					await Head.put({ id: id(), n: 1 }, context);
					const sourced = await SourcedOther.update(sourcedId, {}, context);
					sourced.set('n', 2);
				});
				if (catches) await scope;
				else await assert.rejects(scope, isCommittedDatabase);
				assert.ok(isCommittedDatabase(refusal), refusal?.message ?? 'the nested hook lock was admitted');
				assert.strictEqual((await SourcedOther.get(sourcedId)).n, catches ? 2 : 1);
				assert.strictEqual((await Nested.get(nestedId)).n, catches ? 2 : 1);
				await lockableAfterwards(Head, headId);
			});

		it('still waits out a later mid-scope commit for work left running by a hook that settled', async function () {
			const firstId = id();
			const secondId = id();
			const otherId = id();
			await SourcedOther.put({ id: firstId, n: 1 });
			await SourcedOther.put({ id: secondId, n: 1 });
			await Other.put({ id: otherId, n: 1 });
			const context = {};
			let startLeftover;
			const leftoverGate = new Promise((resolve) => (startLeftover = resolve));
			let releaseSecondHook;
			const secondHookGate = new Promise((resolve) => (releaseSecondHook = resolve));
			let secondHookRunning = false;
			let leftover;
			let leftoverSettled = false;
			sourcePut = (sourcedId) => {
				if (sourcedId === firstId) {
					// registered inside the first hook, so it runs under that hook's marker after the hook settles
					leftover = leftoverGate
						.then(() => settle(Other.lock(otherId, { timeout: 5000 }, context)))
						.then((outcome) => {
							leftoverSettled = true;
							return outcome;
						});
					return;
				}
				secondHookRunning = true;
				return secondHookGate;
			};
			await transaction(context, async (txn) => {
				const first = await SourcedOther.update(firstId, {}, txn);
				first.set('n', 2);
				await txn.commit();
				const second = await SourcedOther.update(secondId, {}, txn);
				second.set('n', 2);
				const committing = txn.commit();
				try {
					await waitFor(() => secondHookRunning, { message: 'the second mid-scope commit should be in its hook' });
					startLeftover();
					await delay(50);
					assert.strictEqual(leftoverSettled, false, 'the lock() waits for the in-flight commit');
				} finally {
					releaseSecondHook();
					await committing;
				}
				const outcome = await leftover;
				assert.ifError(outcome.error);
				assert.strictEqual(outcome.value.id, otherId);
			});
			await lockableAfterwards(Other, otherId);
		});

		it('waits out the commit for work a settled nested hook left running under a hook that has not settled', async function () {
			const sourcedId = id();
			const otherId = id();
			await SourcedOther.put({ id: sourcedId, n: 1 });
			await Other.put({ id: otherId, n: 1 });
			const context = {};
			let releaseOuterHook;
			const outerHookGate = new Promise((resolve) => (releaseOuterHook = resolve));
			let leftoverLocking = false;
			let leftoverSettled = false;
			let leftover;
			nestedPut = () => {
				nestedPut = undefined;
				// not awaited, so the nested hook settles and nothing the commit awaits waits for this lock()
				leftover = delay(1)
					.then(() => {
						leftoverLocking = true;
						return settle(Other.lock(otherId, { timeout: 5000 }, context));
					})
					.then((outcome) => {
						leftoverSettled = true;
						return outcome;
					});
			};
			sourcePut = async () => {
				sourcePut = undefined;
				await Nested.put({ id: id(), n: 2 }, {});
				await outerHookGate;
			};
			await transaction(context, async (txn) => {
				const sourced = await SourcedOther.update(sourcedId, {}, txn);
				sourced.set('n', 2);
				const committing = txn.commit();
				try {
					await waitFor(() => leftoverLocking, { message: "the nested hook's leftover work should be locking" });
					await delay(50);
					assert.strictEqual(leftoverSettled, false, 'the lock() waits for the in-flight commit');
				} finally {
					releaseOuterHook();
					await committing;
				}
				const outcome = await leftover;
				assert.ifError(outcome.error);
				assert.strictEqual(outcome.value.id, otherId);
				assert.ok(
					Other.primaryStore.hasLock(lockAttemptKey(Other.tableId, otherId)),
					'the lock outlives the mid-scope commit it waited out'
				);
			});
			await lockableAfterwards(Other, otherId);
		});

		it("refuses a lock() after the nested hook's first await in the final commit, which released the context", async function () {
			const otherId = id();
			const sourcedId = id();
			await Other.put({ id: otherId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			let refusal;
			const context = {};
			nestedPut = async () => {
				nestedPut = undefined;
				await delay(1);
				await Other.lock(otherId, { timeout: 500 }, context).then(
					(locked) => locked.unlock(),
					(error) => {
						refusal = error;
					}
				);
			};
			nestUnderSourceHook(id());
			await transaction(context, async () => {
				await Head.put({ id: id(), n: 1 }, context);
				const sourced = await SourcedOther.update(sourcedId, {}, context);
				sourced.set('n', 2);
			});
			assert.ok(isReleasedContext(refusal), refusal?.message ?? 'the nested hook lock was admitted');
			assert.strictEqual((await SourcedOther.get(sourcedId)).n, 2);
			await lockableAfterwards(Other, otherId);
		});
	});
});
