const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { lockAttemptKey } = require('#src/resources/recordLock');
const { createBlob } = require('#src/resources/blob');
const { waitFor } = require('../waitFor');
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

describe('lock() waiting across a commit that drops its chained link', () => {
	let TableA;
	let TableB;
	let BlobC;
	let BlobHeadA;
	let SourcedA;
	let sourcePut;
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

	async function parkAcrossMidScopeCommit(ctx, txn, contender, launch) {
		await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
		const waiters = launch(ctx);
		const dropped = txn.next;
		assert.ok(dropped && txn.pendingLocks, 'the waiters chained a dbB link and are pending on the scope root');
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
		BlobC = table({
			table: 'LeftChainLockLinkBlobC',
			database: 'left_chain_lock_link_c',
			audit: true,
			replicate: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'blob', type: 'Blob' },
			],
		});
		BlobHeadA = table({
			table: 'LeftChainLockLinkBlobHeadA',
			database: 'left_chain_lock_link_a',
			audit: true,
			replicate: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'blob', type: 'Blob' },
			],
		});
		SourcedA = table({
			table: 'LeftChainLockLinkSourcedA',
			database: 'left_chain_lock_link_a',
			audit: true,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
		SourcedA.sourcedFrom({
			get() {},
			put(id, record, context) {
				return sourcePut?.(id, record, context);
			},
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
		sourcePut = undefined;
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

	// harper#3913: a lock() made after its link left the chain must find the leader still waiting on that link
	const dropTriggers = {
		// no transaction(): the head database's own write commits and drops the chained link
		async 'a self-committing link commits'(body) {
			const ctx = makeContext();
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			await body(ctx, async () => {
				const dropped = ctx.transaction.next;
				await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 2 });
				assert.notStrictEqual(ctx.transaction.next, dropped, 'the head commit dropped the chained link');
				assert.equal(dropped.leftChain, true);
			});
		},
		async 'a mid-scope commit'(body) {
			const ctx = makeContext();
			await transaction(ctx, async (txn) => {
				await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
				await body(ctx, async () => {
					const dropped = txn.next;
					await txn.commit();
					assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'the scope reopened after the mid-scope commit');
					assert.equal(dropped.leftChain, true);
				});
			});
		},
	};

	function countLockCalls() {
		const originalLock = TableB.prototype.lock;
		const counter = { calls: 0, restore: () => (TableB.prototype.lock = originalLock) };
		TableB.prototype.lock = function (...args) {
			counter.calls++;
			return originalLock.apply(this, args);
		};
		return counter;
	}

	for (const [trigger, run] of Object.entries(dropTriggers)) {
		it(`joins a lock() made after ${trigger} to the leader still waiting on the dropped link`, async function () {
			if (isLMDB) return this.skip();
			const idB = `ls-join-${trigger.split(' ')[1]}`;
			await TableB.put(idB, { id: idB, n: 1 });
			const contender = await hold(idB);
			const counter = countLockCalls();
			try {
				await run(async (ctx, dropLink) => {
					const leader = settle(TableB.lock(idB, { hold: true, lease: 10000, timeout: 5000 }, ctx));
					await dropLink();
					// a second acquisition would queue behind the leader's hold and time out
					const follower = settle(TableB.lock(idB, { hold: true, lease: 10000, timeout: 300 }, ctx));
					await contender.unlock();
					const [led, followed] = await Promise.all([leader, follower]);
					assert.ifError(led.error);
					assert.ifError(followed.error);
					track(led.value);
					assert.equal(counter.calls, 2, 'the follower joined the leader instead of acquiring on its own');
					const handle = TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB);
					assert.ok(handle?.hold, 'one hold handle, on the link that replaced the dropped one');
				});
			} finally {
				counter.restore();
			}
		});

		it(`does not loop a follower of a leader that fails after ${trigger}`, async function () {
			if (isLMDB) return this.skip();
			const idB = `ls-reject-${trigger.split(' ')[1]}`;
			await TableB.put(idB, { id: idB, n: 1 });
			const contender = await hold(idB);
			const counter = countLockCalls();
			try {
				await run(async (ctx, dropLink) => {
					const leader = settle(TableB.lock(idB, { hold: true, lease: 10000, timeout: 150 }, ctx));
					await dropLink();
					const follower = settle(TableB.lock(idB, { hold: true, lease: 10000, timeout: 5000 }, ctx));
					assert.equal((await leader).error?.statusCode, 423, 'premise: the leader times out behind the contender');
					await contender.unlock();
					const followed = await follower;
					assert.ifError(followed.error);
					track(followed.value);
					assert.ok(counter.calls <= 3, `the follower retried ${counter.calls - 2} times instead of once`);
				});
			} finally {
				counter.restore();
			}
		});
	}

	// harper#4080: a mid-scope commit is held open in a chained blob save while the waiter wakes. Launched
	// first, the waiters' link commits ahead of the parked one and reads CLOSED; launched after the blob
	// write, it still reads OPEN, and the in-flight commit reaches it after the waiter registered.
	async function holdMidScopeCommitOpen(ctx, txn, launch, launchFirst) {
		const slow = new PassThrough();
		let launched = launchFirst ? launch() : undefined;
		await BlobC.put({ id: `ls-blob-${Math.random()}`, blob: createBlob(slow) }, ctx);
		if (!launchFirst) launched = launch();
		const blobLink = BlobC._txnForContext(ctx);
		const committing = txn.commit();
		slow.write(Buffer.alloc(16384, 'a'));
		await waitFor(() => blobLink.committing, { message: 'the chained blob save should park the mid-scope commit' });
		assert.equal(txn.open, TRANSACTION_STATE.CLOSED, 'premise: the root reads CLOSED while its commit is in flight');
		return {
			launched,
			finishCommit() {
				slow.end(Buffer.alloc(16384, 'b'));
				return committing;
			},
		};
	}

	// The lock() calls waiting out the scope's in-flight commit, or an early settle that says one was refused.
	function waitForParked(txn, count, outcomes) {
		return waitFor(() => outcomes.length > 0 || (txn.commitSettleWaiters?.length ?? 0) >= count, {
			message: `${count} waiter(s) should park on the scope's commit`,
		});
	}

	const lockedTables = [
		['the head database', () => TableA, true],
		['a chained database the commit reaches first', () => TableB, true],
		['a chained database the commit reaches last', () => TableB, false],
	];
	for (const [where, lockedTable, launchFirst] of lockedTables) {
		it(`admits waiters on ${where} that wake while a mid-scope commit is in flight`, async function () {
			if (isLMDB) return this.skip();
			const Locked = lockedTable();
			const id = `ls-inflight-${where.replaceAll(' ', '-')}`;
			await Locked.put(id, { id, n: 1 });
			const contender = track(await Locked.lock(id, { hold: true, lease: 10000 }, makeContext()));
			const ctx = makeContext();
			await transaction(ctx, async (txn) => {
				await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
				const { launched: waiters, finishCommit } = await holdMidScopeCommitOpen(
					ctx,
					txn,
					() => [settle(Locked.lock(id, { timeout: 5000 }, ctx)), settle(Locked.lock(id, { timeout: 5000 }, ctx))],
					launchFirst
				);
				const outcomes = [];
				for (const waiter of waiters) waiter.then((outcome) => outcomes.push(outcome));
				await contender.unlock();
				await waitForParked(txn, 2, outcomes);
				assert.deepEqual(
					outcomes.map((outcome) => outcome.error?.message ?? 'admitted'),
					[],
					'no waiter settles until the mid-scope commit does'
				);
				assert.equal(
					Locked.primaryStore.hasLock(lockAttemptKey(Locked.tableId, id)),
					false,
					'the woken leader gave the key back'
				);
				await finishCommit();
				const [led, followed] = await Promise.all(waiters);
				assert.ifError(led.error);
				assert.ifError(followed.error);
				const handle = Locked._txnForContext(ctx).recordLockFor(Locked.primaryStore, id);
				assert.ok(handle && !handle.isExpired(), 'the lock is live where the rest of the scope writes');
				led.value.set('n', 2);
			});
			assert.equal((await Locked.get(id))?.n, 2, 'the write made under the lock commits with the scope');
			track(await Locked.lock(id, { hold: true, timeout: 500 }, makeContext()));
		});
	}

	for (const [where, lockedTable] of [
		['the head database', () => TableA],
		['a chained database', () => TableB],
	]) {
		it(`admits waiters on ${where} that wake while the head's own pre-commit work holds a mid-scope commit open`, async function () {
			if (isLMDB) return this.skip();
			const Locked = lockedTable();
			const id = `ls-precommit-${where.replaceAll(' ', '-')}`;
			await Locked.put(id, { id, n: 1 });
			const contender = track(await Locked.lock(id, { hold: true, lease: 10000 }, makeContext()));
			const ctx = makeContext();
			await transaction(ctx, async (txn) => {
				await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
				const waiters = [
					settle(Locked.lock(id, { timeout: 5000 }, ctx)),
					settle(Locked.lock(id, { timeout: 5000 }, ctx)),
				];
				const slow = new PassThrough();
				await BlobHeadA.put({ id: `ls-head-blob-${where}`, blob: createBlob(slow) }, ctx);
				const committing = txn.commit();
				slow.write(Buffer.alloc(16384, 'a'));
				await waitFor(() => txn.committing, { message: 'the head blob save should park the mid-scope commit' });
				assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'premise: the root still reads OPEN in its pre-commit work');
				const outcomes = [];
				for (const waiter of waiters) waiter.then((outcome) => outcomes.push(outcome));
				await contender.unlock();
				await waitForParked(txn, 2, outcomes);
				assert.deepEqual(
					outcomes.map((outcome) => outcome.error?.message ?? 'admitted'),
					[],
					'no waiter settles until the mid-scope commit does'
				);
				slow.end(Buffer.alloc(16384, 'b'));
				await committing;
				const [led, followed] = await Promise.all(waiters);
				assert.ifError(led.error);
				assert.ifError(followed.error);
				const handle = Locked._txnForContext(ctx).recordLockFor(Locked.primaryStore, id);
				assert.ok(handle && !handle.isExpired(), 'the lock is live where the rest of the scope writes');
				led.value.set('n', 2);
			});
			assert.equal((await Locked.get(id))?.n, 2, 'the write made under the lock commits with the scope');
			track(await Locked.lock(id, { hold: true, timeout: 500 }, makeContext()));
		});
	}

	for (const holdLock of [false, true]) {
		it(`keeps a ${holdLock ? 'hold' : 'scoped'} lock live when its self-committing waiter wakes during the head's commit`, async function () {
			if (isLMDB) return this.skip();
			const idB = `ls-imm-inflight-${holdLock}`;
			await TableB.put(idB, { id: idB, n: 1 });
			const contender = await hold(idB);
			const ctx = makeContext();
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			const waiting = settle(TableB.lock(idB, { hold: holdLock, lease: 10000, timeout: 5000 }, ctx));
			const head = ctx.transaction;
			const slow = new PassThrough();
			const blobId = `ls-imm-blob-${holdLock}`;
			const writing = new BlobHeadA(blobId, ctx).put(blobId, { id: blobId, blob: createBlob(slow) });
			slow.write(Buffer.alloc(16384, 'a'));
			await waitFor(() => head.committing, { message: 'the head blob save should park the per-write commit' });
			let outcome;
			waiting.then((settled) => (outcome = settled));
			await contender.unlock();
			await waitFor(() => outcome || TableB.primaryStore.hasLock(lockAttemptKey(TableB.tableId, idB)), {
				message: 'the waiter should wake and take the key',
			});
			slow.end(Buffer.alloc(16384, 'b'));
			await writing;
			outcome = await waiting;
			assert.ifError(outcome.error);
			const holder = track(outcome.value);
			const handle = TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB);
			assert.ok(handle && !handle.isExpired(), 'the lock is live on the current dbB link');
			holder.set('n', 5);
			await holder.save();
			assert.equal((await TableB.get(idB))?.n, 5);
			await assert.rejects(
				() => TableB.lock(idB, { timeout: 100 }, makeContext()),
				(err) => err?.statusCode === 423,
				'the key is still held'
			);
		});
	}

	// One mid-scope commit held open on a head-database blob save, for a scope that runs more than one.
	async function holdHeadCommitOpen(ctx, txn) {
		const slow = new PassThrough();
		await BlobHeadA.put({ id: `ls-held-${Math.random()}`, blob: createBlob(slow) }, ctx);
		const committing = txn.commit();
		slow.write(Buffer.alloc(16384, 'a'));
		await waitFor(() => txn.committing, { message: 'the head blob save should park the mid-scope commit' });
		return {
			finish() {
				slow.end(Buffer.alloc(16384, 'b'));
				return committing;
			},
			fail() {
				slow.destroy(new Error('blob source failed'));
				return committing.then(
					() => assert.fail('the mid-scope commit should fail with its blob'),
					() => {}
				);
			},
		};
	}

	it('makes an uncontended lock() called during a mid-scope commit wait for it', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-uncontended';
		await TableB.put(idB, { id: idB, n: 1 });
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			const held = await holdHeadCommitOpen(ctx, txn);
			const outcomes = [];
			const waiting = settle(TableB.lock(idB, { timeout: 5000 }, ctx));
			waiting.then((outcome) => outcomes.push(outcome));
			await waitForParked(txn, 1, outcomes);
			assert.deepEqual(outcomes, [], 'the lock() waits out the commit');
			assert.equal(TableB.primaryStore.hasLock(lockAttemptKey(TableB.tableId, idB)), false, 'without taking the key');
			await held.finish();
			const locked = await waiting;
			assert.ifError(locked.error);
			assert.ok(!TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB).isExpired());
			locked.value.set('n', 2);
		});
		assert.equal((await TableB.get(idB))?.n, 2);
	});

	it('makes a lock() that waited out one mid-scope commit wait out the next one it wakes in', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-a-then-b';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			const first = await holdHeadCommitOpen(ctx, txn);
			const outcomes = [];
			const waiting = settle(TableB.lock(idB, { timeout: 5000 }, ctx));
			waiting.then((outcome) => outcomes.push(outcome));
			await waitForParked(txn, 1, outcomes);
			await first.finish();
			const second = await holdHeadCommitOpen(ctx, txn);
			await contender.unlock();
			await waitForParked(txn, 1, outcomes);
			assert.deepEqual(outcomes, [], 'the second commit is waited out too');
			await second.finish();
			const locked = await waiting;
			assert.ifError(locked.error);
			locked.value.set('n', 3);
		});
		assert.equal((await TableB.get(idB))?.n, 3);
	});

	it('ends a lock() whose budget runs out while it waits out a mid-scope commit with 423, holding nothing', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-budget-out';
		await TableB.put(idB, { id: idB, n: 1 });
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			const held = await holdHeadCommitOpen(ctx, txn);
			const outcome = await settle(TableB.lock(idB, { timeout: 100 }, ctx));
			assert.equal(outcome.error?.statusCode, 423);
			assert.equal(txn.commitSettleWaiters, undefined, 'the timed-out wait unsubscribed');
			await held.finish();
			assert.equal(TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB), undefined);
		});
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});

	it('refuses waiters with 500, holding nothing, when the mid-scope commit they wait out fails', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-commit-fails';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		let outcomes;
		await settle(
			transaction(ctx, async (txn) => {
				await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
				const waiters = [
					settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
					settle(TableB.lock(idB, { timeout: 5000 }, ctx)),
				];
				const held = await holdHeadCommitOpen(ctx, txn);
				const settled = [];
				for (const waiter of waiters) waiter.then((outcome) => settled.push(outcome));
				await contender.unlock();
				await waitForParked(txn, 2, settled);
				await held.fail();
				outcomes = await Promise.all(waiters);
			})
		);
		for (const outcome of outcomes) assert.equal(outcome.error?.statusCode, 500);
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});

	it("admits a hold whose wait ends during the scope's final commit, as before", async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-final-hold';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		const slow = new PassThrough();
		let waiting;
		const scope = transaction(ctx, async () => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			waiting = settle(TableB.lock(idB, { hold: true, lease: 10000, timeout: 5000 }, ctx));
			await BlobHeadA.put({ id: 'ls-final-blob', blob: createBlob(slow) }, ctx);
		});
		slow.write(Buffer.alloc(16384, 'a'));
		const root = ctx.transaction;
		await waitFor(() => root.committing, { message: "the head blob save should park the scope's final commit" });
		await contender.unlock();
		const holder = await waiting;
		assert.ifError(holder.error);
		track(holder.value);
		slow.end(Buffer.alloc(16384, 'b'));
		await scope;
		await assert.rejects(
			() => TableB.lock(idB, { timeout: 100 }, makeContext()),
			(err) => err?.statusCode === 423,
			'the hold outlives the scope'
		);
	});

	// A source write-through hook runs at staging in an OPEN scope; its completion is what the commit awaits.
	it("lets a source write-through hook's own lock() acquire during the commit that awaits it", async function () {
		if (isLMDB) return this.skip();
		this.timeout(10000);
		const idB = 'ls-hook-alone';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		let hookLocked;
		sourcePut = (_id, _record, context) =>
			TableB.lock(idB, { timeout: 5000 }, context).then((locked) => (hookLocked = locked));
		await transaction(ctx, async (txn) => {
			await SourcedA.put({ id: 'ls-hooked', n: 1 }, ctx);
			const committing = txn.commit();
			await waitFor(() => txn.committing, { message: 'the commit should park on the source hook' });
			const started = Date.now();
			await contender.unlock();
			await committing;
			assert.ok(Date.now() - started < 2000, 'the commit did not wait on a lock waiting on the commit');
			assert.equal(hookLocked?.id, idB);
		});
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});

	it("lets a source write-through hook's lock() coalesced onto an earlier waiter acquire during the commit", async function () {
		if (isLMDB) return this.skip();
		this.timeout(10000);
		const idB = 'ls-hook-follower';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			const earlier = settle(TableB.lock(idB, { timeout: 5000 }, ctx));
			sourcePut = (_id, _record, context) => TableB.lock(idB, { timeout: 5000 }, context);
			await SourcedA.put({ id: 'ls-hooked-follower', n: 1 }, ctx);
			const committing = txn.commit();
			await waitFor(() => txn.committing, { message: 'the commit should park on the source hook' });
			const started = Date.now();
			await contender.unlock();
			await committing;
			assert.ok(Date.now() - started < 2000, 'the commit did not wait on a lock waiting on the commit');
			const locked = await earlier;
			assert.ifError(locked.error);
			assert.ok(
				!TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB).isExpired(),
				'the earlier waiter holds the lock for the rest of the scope'
			);
			locked.value.set('n', 4);
		});
		assert.equal((await TableB.get(idB))?.n, 4);
	});

	it('treats a lock() a source hook left running after it returned as an ordinary caller', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-hook-stale';
		await TableB.put(idB, { id: idB, n: 1 });
		const ctx = makeContext();
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		let stale;
		sourcePut = (_id, _record, context) => {
			stale = settle(gate.then(() => TableB.lock(idB, { timeout: 5000 }, context)));
		};
		await transaction(ctx, async (txn) => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			await SourcedA.put({ id: 'ls-hooked-stale', n: 1 }, ctx);
			await txn.commit();
			const held = await holdHeadCommitOpen(ctx, txn);
			const outcomes = [];
			stale.then((outcome) => outcomes.push(outcome));
			release();
			await waitForParked(txn, 1, outcomes);
			assert.deepEqual(outcomes, [], 'it waits out the later commit like any caller');
			await held.finish();
			const locked = await stale;
			assert.ifError(locked.error);
			assert.ok(!TableB._txnForContext(ctx).recordLockFor(TableB.primaryStore, idB).isExpired());
		});
	});

	it('retries a follower whose leader fails while a mid-scope commit is in flight', async function () {
		if (isLMDB) return this.skip();
		const idB = 'ls-inflight-retry';
		await TableB.put(idB, { id: idB, n: 1 });
		const contender = await hold(idB);
		const ctx = makeContext();
		await transaction(ctx, async (txn) => {
			await new TableA('ls-head', ctx).put('ls-head', { id: 'ls-head', n: 1 });
			const {
				launched: [leader, follower],
				finishCommit,
			} = await holdMidScopeCommitOpen(
				ctx,
				txn,
				() => [settle(TableB.lock(idB, { timeout: 100 }, ctx)), settle(TableB.lock(idB, { timeout: 5000 }, ctx))],
				true
			);
			const outcomes = [];
			follower.then((outcome) => outcomes.push(outcome));
			assert.equal((await leader).error?.statusCode, 423, 'premise: the leader times out behind the contender');
			await waitForParked(txn, 1, outcomes);
			assert.deepEqual(outcomes, [], 'the follower is not refused while the commit is in flight');
			await finishCommit();
			await contender.unlock();
			const followed = await follower;
			assert.ifError(followed.error);
		});
		track(await TableB.lock(idB, { hold: true, timeout: 500 }, makeContext()));
	});
});
