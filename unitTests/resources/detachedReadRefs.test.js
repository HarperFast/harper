// harper#3308: read references taken with no handle, or returned after their handle was detached.
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { DatabaseTransaction, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const rocksOnly = isLMDB ? it.skip : it;
const lmdbOnly = isLMDB ? it : it.skip;

describe('harper#3308 read references against a detached handle', function () {
	let Refs;
	const opened = [];

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Refs = table({
			table: 'DetachedReadRefs',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
		for (let i = 0; i < 5; i++) await Refs.put({ id: 'r' + i, v: i });
	});

	afterEach(function () {
		while (opened.length) {
			const txn = opened.pop();
			try {
				if (txn.transaction) txn.releaseReadTxn();
			} catch {}
		}
	});

	function newTransaction() {
		const context = {};
		const txn = new DatabaseTransaction();
		txn.db = Refs.primaryStore;
		context.transaction = txn;
		txn.setContext(context);
		opened.push(txn);
		return { txn, context };
	}

	// abort()'s drain loop is synchronous, so a mocha timeout can never interrupt it; bound it here so
	// the regression fails instead of hanging the run. Callers that swallow the throw check `exhausted`.
	function boundDrain(txn, limit = 1000) {
		const doneReadTxn = txn.doneReadTxn;
		const budget = { calls: 0, exhausted: false };
		txn.doneReadTxn = function (...args) {
			if (++budget.calls > limit) {
				budget.exhausted = true;
				throw new Error(`doneReadTxn() called ${budget.calls} times: abort() is spinning`);
			}
			return doneReadTxn.apply(this, args);
		};
		return budget;
	}

	// The instance method reads through txnForContext(); the static one opens a new transaction once the
	// context's is no longer OPEN.
	async function searchThroughContext(context, target = { conditions: [] }) {
		const resource = await Refs.getResource({ id: null }, context, {});
		return resource.search(target);
	}

	async function drain(results) {
		let count = 0;
		for await (const _record of results) count++;
		return count;
	}

	rocksOnly('a read after commit takes no reference, and abort() then returns', async function () {
		const { txn } = newTransaction();
		txn.getReadTxn();
		await txn.commit();
		assert.equal(txn.open, TRANSACTION_STATE.CLOSED);
		assert.equal(txn.transaction, null, 'premise: commit with no iterators detaches the handle');
		for (let i = 0; i < 3; i++) assert.equal(txn.useReadTxn(), undefined, 'premise: no handle to read from');
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0, 'a reference to no handle must not be counted');
	});

	rocksOnly('searches after commit, streamed, counted, or failing, leave the counter at 0', async function () {
		const { txn, context } = newTransaction();
		txn.getReadTxn();
		await txn.commit();
		const useReadTxn = txn.useReadTxn;
		let searches = 0;
		txn.useReadTxn = function (...args) {
			searches++;
			return useReadTxn.apply(this, args);
		};
		assert.equal(await drain(await searchThroughContext(context)), 5);
		const page = await searchThroughContext(context, { conditions: [], count: 'exact', limit: 2 });
		assert.equal(page.length, 2);
		assert.equal(page.recordCount, 5);
		await assert.rejects(async () =>
			drain(await searchThroughContext(context, { conditions: [{ attribute: 'id', comparator: 'bogus', value: 1 }] }))
		);
		assert.equal(searches, 3, 'premise: each search read through the committed transaction');
		assert.equal(txn.transaction, null);
		assert.equal(txn.readTxnsUsed, 0);
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0);
	});

	rocksOnly('a commit that fails after reads in its detached window rejects with its own error', async function () {
		this.timeout(15000);
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = Refs.primaryStore.store.db;
		const context = {};
		let txn,
			budget,
			failures = 0;
		try {
			await assert.rejects(
				transaction(context, async () => {
					txn = context.transaction;
					budget = boundDrain(txn);
					await Refs.get('r0', context);
					await Refs.put({ id: 'fails', v: 1 }, context);
					Transaction.prototype.commit = function (...args) {
						if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
						failures++;
						return Promise.reject(Object.assign(new Error('forced commit failure'), { code: 'ERR_CORRUPTION' }));
					};
					const commit = txn.commit();
					commit.catch(() => {});
					assert.equal(txn.transaction, null, 'premise: the in-flight commit detached the handle');
					for (let i = 0; i < 3; i++) assert.equal(await drain(await searchThroughContext(context)), 5);
					await commit;
				}),
				/forced commit failure/
			);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		assert.ok(failures > 0, 'premise: the native commit ran and failed');
		assert.equal(budget.exhausted, false, 'abort() must not spin on references taken with no handle');
		assert.equal(txn.readTxnsUsed, 0);
		assert.equal(await Refs.get('fails'), undefined);
		await Refs.put({ id: 'after-failure', v: 1 });
		assert.ok(await Refs.get('after-failure'), 'the thread keeps serving writes');
		await Refs.delete('after-failure');
	});

	rocksOnly(
		'after the monitor force-releases a handle under open iterators, their returns leave the next handle alone',
		function () {
			const { txn } = newTransaction();
			txn.getReadTxn();
			assert.ok(txn.useReadTxn());
			assert.ok(txn.useReadTxn());
			const staleGeneration = txn.readTxnGeneration;
			assert.equal(txn.readTxnsUsed, 3);
			txn.releaseReadTxn();
			assert.equal(txn.transaction, null);
			assert.equal(txn.readTxnsUsed, 0);
			const freshHandle = txn.getReadTxn();
			assert.ok(freshHandle, 'premise: the OPEN transaction acquires a new handle');
			txn.doneReadTxn(staleGeneration);
			txn.doneReadTxn(staleGeneration);
			assert.equal(txn.transaction, freshHandle, 'the stale returns must not release the new handle');
			assert.equal(txn.readTxnsUsed, 1);
			boundDrain(txn);
			txn.abort(true);
			assert.equal(txn.transaction, null);
			assert.equal(txn.readTxnsUsed, 0);
		}
	);

	rocksOnly('abort() stops draining once the handle is gone', function () {
		const { txn } = newTransaction();
		txn.readTxnsUsed = 3;
		const budget = boundDrain(txn);
		txn.abort(true);
		assert.equal(budget.calls, 0);
	});

	rocksOnly('iterators finishing after a detach neither go negative nor release a later handle', async function () {
		const context = {};
		let txn, freshHandle, freshGeneration;
		await transaction(context, async () => {
			txn = context.transaction;
			const stale = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await stale.next();
			const stale2 = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await stale2.next();
			const staleHandle = txn.transaction;
			await txn.commit();
			assert.equal(txn.transaction, staleHandle, 'premise: the open iterators retain the handle');
			txn.releaseReadTxn();
			assert.equal(txn.readTxnsUsed, 0);
			await txn.commit();
			assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'premise: the scope reopened');
			const staleGeneration = txn.readTxnGeneration;
			// A put before any search acquires the new handle on the write's read-before-write path.
			await Refs.put({ id: 'second-generation', v: 1 }, context);
			freshHandle = txn.transaction;
			freshGeneration = txn.readTxnGeneration;
			assert.ok(freshHandle && freshHandle !== staleHandle, 'premise: a new native handle');
			assert.notEqual(freshGeneration, staleGeneration, 'a handle acquired by a put is a new generation too');
			const fresh = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await fresh.next();
			assert.equal(txn.transaction, freshHandle);
			const freshCount = txn.readTxnsUsed;
			assert.equal(freshCount, 2);
			await assert.rejects(async () => {
				while (!(await stale.next()).done);
			}, /snapshot expired/);
			await stale2.return();
			assert.equal(txn.transaction, freshHandle, 'stale references must not release the fresh handle');
			assert.equal(txn.readTxnsUsed, freshCount, 'stale references must not move the fresh handle’s count');
			let rest = 0;
			while (!(await fresh.next()).done) rest++;
			assert.equal(rest, 5, 'the fresh iterator reads to the end on its own handle');
		});
		assert.equal(txn.transaction, null, 'the fresh handle is released once its own references return');
		assert.equal(txn.readTxnsUsed, 0);
		assert.ok(await Refs.get('second-generation'), 'the write staged on the fresh handle commits');
		txn.doneReadTxn(freshGeneration);
		assert.equal(txn.readTxnsUsed, 0, 'a return after release must not go negative');
	});

	lmdbOnly(
		'LMDB: a return for a force-released snapshot does not take a later snapshot’s reference',
		async function () {
			const context = {};
			let txn;
			await transaction(context, async () => {
				const stale = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
				await stale.next();
				for (txn = context.transaction; txn && !txn.readTxn; txn = txn.next);
				assert.ok(txn, 'premise: a link holds the search’s read snapshot');
				const staleGeneration = txn.readTxnGeneration;
				await txn.commit();
				assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'premise: an LMDB mid-scope commit stays OPEN');
				txn.releaseReadTxn();
				assert.equal(txn.readTxn, null);
				await Refs.put({ id: 'lmdb-second-generation', v: 1 });
				const fresh = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
				await fresh.next();
				const freshSnapshot = txn.readTxn;
				assert.ok(freshSnapshot && txn.readTxnGeneration !== staleGeneration, 'premise: a new read snapshot');
				const freshCount = txn.readTxnsUsed;
				await stale.return();
				assert.equal(txn.readTxn, freshSnapshot, 'a stale return must not release the fresh snapshot');
				assert.equal(txn.readTxnsUsed, freshCount);
				let rest = 0;
				while (!(await fresh.next()).done) rest++;
				assert.ok(rest >= 4, 'the fresh iterator reads to the end on its own snapshot');
			});
			assert.equal(txn.readTxnsUsed, 0);
		}
	);

	it('releases a second-generation snapshot via disregardReadTxn before a slow source fetch resolves', async function () {
		let resolveSource;
		let markSourceEntered;
		let sourceEntered = new Promise((resolve) => {
			markSourceEntered = resolve;
		});
		const SourcedRefs = table({
			table: 'DetachedReadRefsSourced',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
		await SourcedRefs.put({ id: 'seeded', v: 1 });
		SourcedRefs.sourcedFrom({
			get(id) {
				markSourceEntered();
				return new Promise((resolve) => {
					resolveSource = () => resolve({ id, v: 42 });
				});
			},
		});

		async function assertMissReleasesSnapshotBeforeSourceResolves(context, missId, previousGeneration) {
			let pendingGet = SourcedRefs.get(missId, context);
			try {
				await Promise.race([
					sourceEntered,
					pendingGet.then(() => assert.fail('the cache miss never reached the source')),
				]);
				let txn;
				for (txn = context.transaction; txn?.next; txn = txn.next);
				assert.ok(txn.readTxnGeneration > previousGeneration, 'premise: cache-miss read opened a new generation');
				assert.equal(
					txn.readTxn ?? txn.transaction,
					null,
					'disregardReadTxn must release the snapshot while the source fetch is still pending'
				);
				assert.equal(txn.readTxnsUsed, 0);
				assert.equal(txn.readTxnRefCount, 0);

				resolveSource();
				resolveSource = null;
				const loaded = await pendingGet;
				pendingGet = null;
				assert.equal(loaded?.v, 42);
			} finally {
				resolveSource?.();
				await pendingGet?.catch(() => {});
				sourceEntered = new Promise((resolve) => {
					markSourceEntered = resolve;
				});
			}
		}

		const releaseContext = {};
		await transaction(releaseContext, async () => {
			const seeded = await SourcedRefs.get('seeded', releaseContext);
			assert.equal(seeded?.v, 1);
			let txn;
			for (txn = releaseContext.transaction; txn && !txn.readTxn && !txn.transaction; txn = txn.next);
			assert.ok(txn, 'premise: first-generation read opened a transaction handle');
			const firstGeneration = txn.readTxnGeneration;
			txn.releaseReadTxn();
			assert.equal(txn.readTxn ?? txn.transaction, null, 'premise: first-generation handle detached');
			assert.equal(txn.readTxnsUsed, 0);

			await assertMissReleasesSnapshotBeforeSourceResolves(releaseContext, 'cache-miss-after-release', firstGeneration);
		});

		const midCommitContext = {};
		await transaction(midCommitContext, async () => {
			await Refs.put({ id: 'r0', v: 10 }, midCommitContext);
			const midCommit = midCommitContext.transaction.commit();
			const seeded = await SourcedRefs.get('seeded', midCommitContext);
			assert.equal(seeded?.v, 1);
			for (let t = midCommitContext.transaction; t; t = t.next) {
				if (t.readTxn) t.releaseReadTxn();
			}
			await midCommit;

			await assertMissReleasesSnapshotBeforeSourceResolves(midCommitContext, 'cache-miss-after-mid-commit', 0);
		});
	});

	it('clamps unpaired disregardReadTxn at 0 so a later shared reader cannot close a live snapshot', async function () {
		const context = {};
		await transaction(context, async () => {
			await Refs.get('r0', context);
			let txn;
			for (txn = context.transaction; txn && !txn.readTxn && !txn.transaction; txn = txn.next);
			assert.ok(txn, 'premise: transaction link acquired a read handle');
			txn.disregardReadTxn();
			assert.equal(
				txn.readTxn ?? txn.transaction,
				null,
				'premise: paired disregardReadTxn released the first snapshot'
			);
			assert.equal(txn.readTxnRefCount, 0);

			txn.disregardReadTxn();

			const snapA = txn.getReadTxn();
			assert.ok(snapA, 'premise: Reader A acquires a fresh snapshot');
			const snapB = txn.getReadTxn();
			assert.equal(snapB, snapA, 'premise: Reader B shares Reader A’s snapshot');
			assert.equal(txn.readTxnsUsed, 1);

			txn.disregardReadTxn();
			assert.equal(
				txn.readTxn ?? txn.transaction,
				snapA,
				'Reader B’s disregardReadTxn must not close the snapshot while Reader A still holds it'
			);
			assert.equal(txn.readTxnsUsed, 1);
			assert.equal(txn.readTxnRefCount, 1);

			txn.useReadTxn();
			assert.equal(txn.readTxnsUsed, 2);
			assert.equal(txn.readTxnRefCount, 2);
			txn.disregardReadTxn();
			txn.disregardReadTxn();
			txn.disregardReadTxn();
			assert.equal(txn.readTxnRefCount, 0, 'extra disregardReadTxn while readTxnsUsed > 1 must clamp at 0');
			txn.doneReadTxn();
			assert.equal(txn.readTxnsUsed, 1);

			txn.getReadTxn();
			txn.getReadTxn();
			txn.disregardReadTxn();
			assert.equal(
				txn.readTxn ?? txn.transaction,
				snapA,
				'in-generation reuse after clamped disregardReadTxn must keep the snapshot open for the remaining reader'
			);
			txn.disregardReadTxn();
			assert.equal(txn.readTxn ?? txn.transaction, null);
			assert.equal(txn.readTxnsUsed, 0);
		});
	});

	it('detach followed by commit never decrements readTxnsUsed below 0', async function () {
		for (const detach of [(txn) => txn.releaseReadTxn(), (txn) => txn.disregardReadTxn()]) {
			const context = {};
			await transaction(context, async () => {
				await Refs.get('r0', context);
				let txn;
				for (txn = context.transaction; txn && !txn.readTxn && !txn.transaction; txn = txn.next);
				assert.ok(txn, 'premise: read handle opened');
				assert.equal(txn.readTxnsUsed, 1);
				assert.equal(txn.baseReadRefConsumed, false);
				detach(txn);
				assert.equal(txn.readTxn ?? txn.transaction, null, 'premise: handle detached before commit');
				assert.equal(txn.readTxnsUsed, 0);
				assert.equal(txn.baseReadRefConsumed, true, 'detaching the handle must mark baseReadRefConsumed');

				let current = txn.readTxnsUsed;
				let minReadTxnsUsed = current;
				Object.defineProperty(txn, 'readTxnsUsed', {
					configurable: true,
					get() {
						return current;
					},
					set(value) {
						current = value;
						if (value < minReadTxnsUsed) minReadTxnsUsed = value;
					},
				});

				await txn.commit();
				assert.equal(minReadTxnsUsed, 0, 'performCommit must not drive readTxnsUsed negative after detach');
				assert.equal(txn.readTxnsUsed, 0);
				assert.equal(txn.baseReadRefConsumed, true);
			});
		}

		const { txn: untouchedTxn } = newTransaction();
		assert.equal(Boolean(untouchedTxn.baseReadRefConsumed), false);
		let current = untouchedTxn.readTxnsUsed ?? 0;
		let minReadTxnsUsed = current;
		Object.defineProperty(untouchedTxn, 'readTxnsUsed', {
			configurable: true,
			get() {
				return current;
			},
			set(value) {
				current = value;
				if (value < minReadTxnsUsed) minReadTxnsUsed = value;
			},
		});
		await untouchedTxn.commit();
		assert.equal(
			minReadTxnsUsed,
			0,
			'performCommit on a transaction that never attached a handle must not decrement readTxnsUsed'
		);
	});
});
