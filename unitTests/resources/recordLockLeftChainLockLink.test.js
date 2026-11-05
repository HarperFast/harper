const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const SCHEMA_ATTRS = [
	{ name: 'id', isPrimaryKey: true, type: 'String' },
	{ name: 'n', type: 'Int' },
];

function makeContext() {
	return { user: { username: 'admin', role: { permission: { super_user: true } } } };
}

// Settled at launch: a waiter that rejects before the test awaits it is not an unhandled rejection.
function settle(promise) {
	return promise.then(
		(value) => ({ value }),
		(error) => ({ error })
	);
}

// harper#3929 resolved the replacement link for a lock() whose wait outlives its link, but several uses after
// the wait stayed on the dropped one.
describe('lock() waiting across a commit that drops its chained link', () => {
	let TableA;
	let TableB;
	let FailingReloadB;
	let failReloadOf;
	let holders = [];

	function track(holder) {
		holders.push(holder);
		return holder;
	}

	function hold(id) {
		return TableB.lock(id, { hold: true, lease: 10000 }, makeContext()).then(track);
	}

	// `launch` starts the waiters on a chained dbB link behind `contender`; txn.commit() then drops that link.
	async function parkAcrossMidScopeCommit(ctx, txn, contender, launch) {
		await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
		const waiters = launch(ctx);
		const dropped = txn.next;
		assert.ok(dropped?.pendingLocks, 'the waiters chained a dbB link');
		await txn.commit();
		assert.equal(txn.open, 1, 'the scope reopened after the mid-scope commit');
		assert.equal(dropped.leftChain, true, 'the waiters link left the chain');
		return waiters;
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		TableA = table({
			table: 'LeftChainLockLinkA',
			database: 'left_chain_lock_link_a',
			audit: true,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
		TableB = table({
			table: 'LeftChainLockLinkB',
			database: 'left_chain_lock_link_b',
			audit: true,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
		FailingReloadB = class extends TableB {
			constructor(id, context) {
				super(id, context);
				if (id === failReloadOf) throw new Error('reload failed');
			}
		};
	});

	afterEach(async () => {
		failReloadOf = undefined;
		while (holders.length > 0) {
			try {
				await holders.pop().unlock();
			} catch {}
		}
	});

	after(async () => {
		await resetDatabases();
	});

	it('does not report the transaction closed while its root is still open', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-closed';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			const [waiting] = await parkAcrossMidScopeCommit(ctx, txn, contender, () => [
				settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
			]);
			await contender.unlock();
			const outcome = await waiting;
			assert.ifError(outcome.error);
			assert.equal(outcome.value.id, idB);
			assert.ok(
				TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB),
				'the lock is on the link that replaced the dropped one'
			);
			await assert.rejects(
				() => TableB.lock(idB, { hold: true, timeout: 100 }, makeContext()),
				(err) => err?.statusCode === 423,
				'the scope still holds the key'
			);
		});
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});

	it('pins the replacement link clock to the admitted floor', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-pin';
		const futureStamp = Date.now() + 3000;
		const seedCtx = makeContext();
		await transaction(seedCtx, async (seedTxn) => {
			seedCtx.timestamp = futureStamp;
			seedTxn.timestamp = futureStamp;
			await new TableB(idB, seedCtx).put(idB, { id: idB, n: 1 });
		});
		const contender = await hold(idB);
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			const [waiting] = await parkAcrossMidScopeCommit(ctx, txn, contender, () => [
				settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
			]);
			await contender.unlock();
			const outcome = await waiting;
			assert.ifError(outcome.error);
			const replacement = TableB._txnForContext(ctx);
			assert.ok(
				replacement.timestamp >= futureStamp,
				`the replacement link clock ${replacement.timestamp} is below the record version ${futureStamp}`
			);
			outcome.value.n = 2;
		});
		assert.equal((await TableB.get(idB))?.n, 2, 'the write under the lock must not lose to the older version');
	});

	it('restores the replacement link clock when the reload of a lock that waited fails', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-reload-fail';
		const futureStamp = Date.now() + 3000;
		const seedCtx = makeContext();
		await transaction(seedCtx, async (seedTxn) => {
			seedCtx.timestamp = futureStamp;
			seedTxn.timestamp = futureStamp;
			await new TableB(idB, seedCtx).put(idB, { id: idB, n: 1 });
		});
		const contender = await hold(idB);
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			const [waiting] = await parkAcrossMidScopeCommit(ctx, txn, contender, () => [
				settle(new FailingReloadB('ls-anchor', ctx).lock(idB, { timeout: 5000 })),
			]);
			const replacement = TableB._txnForContext(ctx);
			const clockBefore = replacement.timestamp;
			failReloadOf = idB;
			await contender.unlock();
			const outcome = await waiting;
			assert.equal(outcome.error?.message, 'reload failed');
			assert.equal(replacement.timestamp, clockBefore, 'the replacement clock was restored');
			assert.equal(replacement.recordLockFor(TableB.primaryStore, idB), undefined, 'the registry was cleared');
		});
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});

	it('lets a coalesced follower join the leader lock registered on the replacement link', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-follow';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		const originalLock = TableB.prototype.lock;
		let lockCalls = 0;
		TableB.prototype.lock = function (...args) {
			lockCalls++;
			return originalLock.apply(this, args);
		};
		try {
			await transaction(ctx, async (txn) => {
				const waiters = await parkAcrossMidScopeCommit(ctx, txn, contender, () => [
					settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
					settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
				]);
				await contender.unlock();
				const [leader, follower] = await Promise.all(waiters);
				assert.ifError(leader.error);
				assert.ifError(follower.error);
				assert.equal(
					lockCalls,
					2,
					'the follower joined the leader lock instead of falling back to a second lock() call'
				);
			});
		} finally {
			TableB.prototype.lock = originalLock;
		}
	});

	it('upgrades a coalesced scoped lock to hold on the replacement link', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-upgrade';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		let holdWriter;
		await transaction(ctx, async (txn) => {
			const waiters = await parkAcrossMidScopeCommit(ctx, txn, contender, () => [
				settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
				settle(TableB.lock(idB, { hold: true, lease: 10000, timeout: 5000 }, ctx)),
			]);
			await contender.unlock();
			const [scoped, upgraded] = await Promise.all(waiters);
			assert.ifError(scoped.error);
			assert.ifError(upgraded.error);
			holdWriter = track(upgraded.value);
			const replacement = TableB._txnForContext(ctx);
			const handle = replacement.recordLockFor(TableB.primaryStore, idB);
			assert.equal(handle?.hold, true, 'the shared handle on the replacement became a hold');
			assert.equal(
				replacement.writes.filter((write) => write && !write.saved && write.lockHandle === handle).length,
				0,
				'the upgrade detached the scoped placeholder write staged on the replacement'
			);
			holdWriter.set('n', 7);
			await holdWriter.save();
		});
		assert.equal((await TableB.get(idB))?.n, 7, 'the scoped placeholder did not clobber the hold write');
		await assert.rejects(
			() => TableB.lock(idB, { timeout: 100 }, makeContext()),
			(err) => err?.statusCode === 423,
			'the hold outlives the transaction'
		);
		await holdWriter.unlock();
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});

	for (const ending of ['commits', 'aborts']) {
		it(`still rejects waiters when the scope ${ending} after their link was dropped`, async function () {
			if (isLMDB) return this.skip();
			const idB = `ls-ended-${ending}`;
			await TableB.put(idB, { id: idB, n: 1 });
			const contender = await hold(idB);
			const ctx = makeContext();
			let waiters;
			const scope = transaction(ctx, async (txn) => {
				waiters = await parkAcrossMidScopeCommit(ctx, txn, contender, () => [
					settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
					settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
				]);
				if (ending === 'aborts') throw new Error('rollback');
			});
			if (ending === 'aborts') await assert.rejects(scope, /rollback/);
			else await scope;
			await contender.unlock();
			for (const outcome of await Promise.all(waiters)) {
				assert.equal(outcome.error?.statusCode, 500, 'a lock waited out by a finished scope is refused');
			}
			track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
		});
	}
});
