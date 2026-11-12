// Gaps left by the #4206 suites (commitHookSameRecordWrites.test.js, recordLockScopeClosure.test.js): the
// hook-refusal and nested-hook arms those files do not reach.
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { lockAttemptKey } = require('#src/resources/recordLock');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const ATTRIBUTES = [
	{ name: 'id', isPrimaryKey: true, type: 'String' },
	{ name: 'n', type: 'Int', indexed: true },
	{ name: 'b', type: 'Int' },
];

const isLockedChangeRefusal = (error) =>
	error?.statusCode === 409 && /can not be changed by the pre-commit hook of its own write/.test(error.message);
const isCommittedDatabase = (error) =>
	error?.statusCode === 409 && /whose database this commit has already committed/.test(error.message);

// Settled at launch, so a lock() that rejects before the test awaits it is not an unhandled rejection.
function settle(promise) {
	return Promise.resolve(promise).then(
		(value) => ({ value }),
		(error) => ({ error })
	);
}

describe('commit-hook lock refusals: omitted typed attributes and nested hooks', function () {
	this.timeout(15000);

	let Hooked;
	let Head;
	let Other;
	let SourcedOther;
	let SideEffect;
	let sourcePut;
	let sideEffectPut;
	let nextId = 1;
	const id = (prefix = 'hook-lock') => `${prefix}-${nextId++}`;
	const cleanups = [];

	before(function () {
		if (isLMDB) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Hooked = table({
			table: 'CommitHookLockHooked',
			database: 'commit_hook_lock_hooked',
			audit: true,
			replicate: false,
			attributes: ATTRIBUTES,
		});
		Head = table({
			table: 'CommitHookLockHead',
			database: 'commit_hook_lock_head',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		Other = table({
			table: 'CommitHookLockOther',
			database: 'commit_hook_lock_other',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		SourcedOther = table({
			table: 'CommitHookLockSourcedOther',
			database: 'commit_hook_lock_other',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		SourcedOther.sourcedFrom({
			get() {},
			put(sourcedId, record, context) {
				return sourcePut?.(sourcedId, record, context);
			},
		});
		SideEffect = table({
			table: 'CommitHookLockSideEffect',
			database: 'commit_hook_lock_side_effect',
			replicate: false,
			attributes: ATTRIBUTES,
		});
		SideEffect.sourcedFrom({
			get() {},
			put(sideId, record, context) {
				return sideEffectPut?.(sideId, record, context);
			},
		});
	});

	afterEach(async function () {
		delete Hooked.source;
		sourcePut = undefined;
		sideEffectPut = undefined;
		while (cleanups.length) await cleanups.pop()();
	});

	after(async function () {
		await resetDatabases();
	});

	function hookOnce(hook) {
		const once = (...args) => {
			delete Hooked.source;
			return hook(...args);
		};
		Hooked.source = { put: once, patch: once, delete: once, publish: once };
	}

	const storedRecord = (recordId) => {
		const value = Hooked.primaryStore.getEntry(recordId)?.value;
		return value == null ? null : { ...value };
	};

	// a hook on a fresh context, so it commits on a transaction link whose root is not the scope's
	function nestUnderSourceHook(sideId, nestedHook) {
		sourcePut = () => {
			sourcePut = undefined;
			return SideEffect.put({ id: sideId, n: 1 }, {});
		};
		sideEffectPut = () => {
			sideEffectPut = undefined;
			return nestedHook();
		};
	}

	describe("a full write's hook through a lock holder", function () {
		const fullWrites = {
			'put(record)': (holder, recordId) => holder.put({ id: recordId, n: 2 }),
			'update(record, true)': (holder, recordId) => {
				holder.update({ id: recordId, n: 2 }, true);
				return holder.save();
			},
		};
		for (const [write, makeWrite] of Object.entries(fullWrites))
			it(`can not addTo() a schema-typed attribute the ${write} omits, which would store an unresolved add`, async function () {
				const recordId = id('hold');
				await Hooked.put({ id: recordId, n: 1, b: 1 });
				const holder = await Hooked.lock(recordId, { hold: true, lease: 5000 }, {});
				cleanups.push(() => holder.unlock());
				let refusal;
				hookOnce(() => {
					try {
						holder.addTo('b', 7);
					} catch (error) {
						refusal = error;
					}
				});
				await makeWrite(holder, recordId);
				assert.ok(isLockedChangeRefusal(refusal), refusal?.message ?? 'the hook addTo() was admitted');
				assert.deepStrictEqual(storedRecord(recordId), { id: recordId, n: 2 });
			});
	});

	describe("from a hook nested under the commit's hook", function () {
		it('refuses a lock() of a head-database record with 409, after a microtask while a read iterator holds the head open', async function () {
			const headId = id('head');
			const sourcedId = id('sourced');
			await Head.put({ id: headId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			const outerContext = {};
			let outcome;
			nestUnderSourceHook(id('side'), async () => {
				await Promise.resolve();
				outcome = await settle(Head.lock(headId, { timeout: 500 }, outerContext));
				if (outcome.value) await outcome.value.unlock();
			});
			let iterator;
			await transaction(outerContext, async () => {
				await Head.put({ id: id('head-write'), n: 1 }, outerContext);
				iterator = Head.search(
					{ conditions: [{ attribute: 'n', comparator: 'greater_than', value: 0 }] },
					outerContext
				)[Symbol.iterator]();
				iterator.next();
				const sourced = await SourcedOther.update(sourcedId, {}, outerContext);
				sourced.set('n', 2);
			});
			iterator.return();
			assert.ok(isCommittedDatabase(outcome?.error), `${outcome?.error?.statusCode} ${outcome?.error?.message}`);
		});

		it("admits a non-hold re-entry onto the scope's lock through another instance during the final commit", async function () {
			const otherId = id('other');
			const sourcedId = id('sourced');
			await Other.put({ id: otherId, n: 1 });
			await SourcedOther.put({ id: sourcedId, n: 1 });
			const outerContext = {};
			let reentry;
			nestUnderSourceHook(id('side'), async () => {
				reentry = await settle(Other.lock(otherId, { timeout: 500 }, outerContext));
			});
			await transaction(outerContext, async () => {
				const initialLocked = await Other.lock(otherId, {}, outerContext);
				initialLocked.set('n', 2);
				const sourced = await SourcedOther.update(sourcedId, {}, outerContext);
				sourced.set('n', 2);
			});
			assert.ifError(reentry?.error);
			assert.strictEqual(reentry?.value?.id, otherId);
			await waitFor(() => !Other.primaryStore.hasLock(lockAttemptKey(Other.tableId, otherId)), {
				message: 'the scope lock is released once the final commit settles',
			});
			assert.strictEqual((await Other.get(otherId)).n, 2);
		});
	});
});
