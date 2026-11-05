const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const SCHEMA_ATTRS = [
	{ name: 'id', isPrimaryKey: true, type: 'String' },
	{ name: 'n', type: 'Int' },
];

function makeContext(extra = {}) {
	return {
		user: { username: 'admin', role: { permission: { super_user: true } } },
		...extra,
	};
}

async function unlockSafe(holder) {
	if (!holder || typeof holder.unlock !== 'function') return;
	try {
		await holder.unlock();
	} catch {}
}

// harper#3872: a commit's completeMidScopeCommit drops the chained links; their surviving record locks must reach the links that replace them
describe('Record locks on chained links survive a commit that drops the chain', () => {
	let TableAAudited;
	let TableBAudited;
	let TableBUnaudited;
	let TableC;
	let trackedHolders = [];

	function trackHolder(holder) {
		if (holder) trackedHolders.push(holder);
		return holder;
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);

		TableAAudited = table({
			table: 'MidScopeLockTableA',
			database: 'mid_scope_lock_db_a',
			audit: true,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
		TableBAudited = table({
			table: 'MidScopeLockTableBAudited',
			database: 'mid_scope_lock_db_b',
			audit: true,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
		TableBUnaudited = table({
			table: 'MidScopeLockTableBUnaudited',
			database: 'mid_scope_lock_db_b',
			audit: false,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
		TableC = table({
			table: 'MidScopeLockTableC',
			database: 'mid_scope_lock_db_c',
			audit: true,
			replicate: false,
			attributes: SCHEMA_ATTRS,
		});
	});

	afterEach(async () => {
		while (trackedHolders.length > 0) {
			await unlockSafe(trackedHolders.pop());
		}
	});

	after(async () => {
		await resetDatabases();
	});

	it('transaction-scoped lock() on chained dbB without dbB writes releases across mid-scope commit, scope-exit commit, and scope-exit abort', async () => {
		const idAHold = 'pc1-a-hold';
		const idBMid = 'pc1-b-mid';
		const idBExitCommit = 'pc1-b-exit-commit';
		const idBExitAbort = 'pc1-b-exit-abort';

		await TableAAudited.put(idAHold, { id: idAHold, n: 1 });
		await TableBAudited.put(idBMid, { id: idBMid, n: 1 });
		await TableBAudited.put(idBExitCommit, { id: idBExitCommit, n: 1 });
		await TableBAudited.put(idBExitAbort, { id: idBExitAbort, n: 1 });

		if (isLMDB) {
			const ctxLmdb = makeContext();
			await transaction(ctxLmdb, async (txn) => {
				await new TableAAudited('pc1-lmdb-a', ctxLmdb).put('pc1-lmdb-a', { id: 'pc1-lmdb-a', n: 10 });
				await new TableBAudited(idBMid, ctxLmdb).put(idBMid, { id: idBMid, n: 11 });
				await txn.commit();
				await new TableBAudited(idBMid, ctxLmdb).put(idBMid, { id: idBMid, n: 12 });
			});
			assert.equal((await TableBAudited.get(idBMid))?.n, 12);
			await assert.rejects(
				() => TableBAudited.lock(idBMid, { hold: true }, makeContext()),
				(err) => err?.statusCode === 501,
				'LMDB must reject Table.lock() with statusCode 501'
			);
			return;
		}

		let holderA;
		try {
			const ctxMid = makeContext();
			await transaction(ctxMid, async (txn) => {
				holderA = trackHolder(await TableAAudited.lock(idAHold, { hold: true, lease: 5000 }, ctxMid));
				await new TableAAudited('pc1-a-write-1', ctxMid).put('pc1-a-write-1', {
					id: 'pc1-a-write-1',
					n: 10,
				});
				const scopedBMid = await TableBAudited.lock(idBMid, ctxMid);
				assert.equal(scopedBMid.id, idBMid);
				assert.ok(txn.next?.recordLocks?.get(TableBAudited.primaryStore)?.get(idBMid));

				await txn.commit();

				assert.equal(txn.open, 1);
				assert.ok(txn.recordLocks?.get(TableAAudited.primaryStore)?.get(idAHold));

				const contenderMid = trackHolder(await TableBAudited.lock(idBMid, { hold: true, timeout: 150 }, makeContext()));
				assert.equal(contenderMid.id, idBMid);
				await unlockSafe(contenderMid);
			});

			const ctxCommit = makeContext();
			await transaction(ctxCommit, async () => {
				await new TableAAudited('pc1-a-write-2', ctxCommit).put('pc1-a-write-2', {
					id: 'pc1-a-write-2',
					n: 20,
				});
				const scopedBCommit = await TableBAudited.lock(idBExitCommit, ctxCommit);
				assert.equal(scopedBCommit.id, idBExitCommit);
			});

			const contenderCommit = trackHolder(
				await TableBAudited.lock(idBExitCommit, { hold: true, timeout: 150 }, makeContext())
			);
			assert.equal(contenderCommit.id, idBExitCommit);
			await unlockSafe(contenderCommit);

			const ctxAbort = makeContext();
			await assert.rejects(
				async () =>
					transaction(ctxAbort, async () => {
						await new TableAAudited('pc1-a-write-3', ctxAbort).put('pc1-a-write-3', {
							id: 'pc1-a-write-3',
							n: 30,
						});
						const scopedBAbort = await TableBAudited.lock(idBExitAbort, ctxAbort);
						assert.equal(scopedBAbort.id, idBExitAbort);
						throw new Error('rollback');
					}),
				/rollback/
			);

			const contenderAbort = trackHolder(
				await TableBAudited.lock(idBExitAbort, { hold: true, timeout: 150 }, makeContext())
			);
			assert.equal(contenderAbort.id, idBExitAbort);
			await unlockSafe(contenderAbort);
		} finally {
			await unlockSafe(holderA);
		}
	});

	it('an ImmediateTransaction head commit keeps the hold locks of an OPEN chained link with no writes', async () => {
		const idPut = 'arm1-put-b';
		const idDel = 'arm1-del-b';
		const idExp = 'arm1-exp-b';

		if (isLMDB) {
			await assert.rejects(
				() => TableBAudited.lock(idPut, { hold: true }, makeContext()),
				(err) => err?.statusCode === 501,
				'LMDB must reject Table.lock() with statusCode 501'
			);
			const immLmdbCtx = makeContext();
			await TableAAudited.getResource({ id: 'arm1-lmdb-head-init' }, immLmdbCtx, {});
			await new TableAAudited('arm1-lmdb-head-1', immLmdbCtx).put('arm1-lmdb-head-1', {
				id: 'arm1-lmdb-head-1',
				n: 1,
			});
			await new TableBAudited(idPut, immLmdbCtx).put(idPut, { id: idPut, n: 20 });
			await new TableBAudited(idPut, immLmdbCtx).patch(idPut, { n: 21 });
			assert.equal((await TableBAudited.get(idPut))?.n, 21);
			return;
		}

		const futureStamp = Date.now() + 2500;

		await TableBAudited.put(idExp, { id: idExp, n: 1 });

		const immCtx = makeContext();
		await TableAAudited.getResource({ id: 'head-init' }, immCtx, {});
		assert.equal(immCtx.transaction.open, 1);

		let holderPut;
		let holderDel;
		let holderPutU;
		let holderDelU;
		let holderExp;
		try {
			immCtx.timestamp = futureStamp + 5;
			holderPut = trackHolder(await TableBAudited.lock(idPut, { hold: true, lease: 5000 }, immCtx));
			holderDel = trackHolder(await TableBAudited.lock(idDel, { hold: true, lease: 5000 }, immCtx));
			holderPutU = trackHolder(await TableBUnaudited.lock(idPut, { hold: true, lease: 5000 }, immCtx));
			holderDelU = trackHolder(await TableBUnaudited.lock(idDel, { hold: true, lease: 5000 }, immCtx));
			delete immCtx.timestamp;
			holderExp = trackHolder(await TableBAudited.lock(idExp, { hold: true, lease: 5000 }, immCtx));

			// seeded through another context, so the dbB link stays write-free
			const seedCtx = makeContext();
			await transaction(seedCtx, async (seedTxn) => {
				seedCtx.timestamp = futureStamp;
				seedTxn.timestamp = futureStamp;
				await new TableBAudited(idPut, seedCtx).put(idPut, { id: idPut, n: 10 });
				seedTxn.timestamp = futureStamp;
				await new TableBAudited(idDel, seedCtx).put(idDel, { id: idDel, n: 10 });
				seedTxn.timestamp = futureStamp;
				await new TableBUnaudited(idPut, seedCtx).put(idPut, { id: idPut, n: 10 });
				seedTxn.timestamp = futureStamp;
				await new TableBUnaudited(idDel, seedCtx).put(idDel, { id: idDel, n: 10 });
			});

			const dbBLinkBefore = immCtx.transaction.next;
			assert.ok(dbBLinkBefore);
			assert.equal(dbBLinkBefore.open, 1);
			assert.equal(dbBLinkBefore.writes?.length ?? 0, 0);
			assert.ok(dbBLinkBefore.recordLocks?.get(TableBAudited.primaryStore)?.get(idPut));
			const expHandle = dbBLinkBefore.recordLocks?.get(TableBAudited.primaryStore)?.get(idExp);
			assert.ok(expHandle);

			await new TableAAudited('head-1', immCtx).put('head-1', { id: 'head-1', n: 1 });

			await new TableBAudited(idPut, immCtx).put(idPut, { id: idPut, n: 20 });
			await new TableBAudited(idPut, immCtx).patch(idPut, { n: 21 });
			await new TableBAudited(idDel, immCtx).delete(idDel);

			await new TableBUnaudited(idPut, immCtx).put(idPut, { id: idPut, n: 20 });
			await new TableBUnaudited(idPut, immCtx).patch(idPut, { n: 21 });
			await new TableBUnaudited(idDel, immCtx).delete(idDel);

			assert.equal((await TableBAudited.get(idPut))?.n, 21);
			assert.equal((await TableBUnaudited.get(idPut))?.n, 21);
			await waitFor(
				async () => (await TableBAudited.get(idDel)) == null && (await TableBUnaudited.get(idDel)) == null,
				{
					timeout: 2000,
					message: 'deletes on the held keys must land',
				}
			);

			const reentrant = await TableBAudited.lock(idPut, { hold: true, timeout: 120 }, immCtx);
			assert.equal(reentrant?.id, idPut);

			assert.strictEqual(
				TableBAudited._txnForContext(immCtx).recordLocks?.get(TableBAudited.primaryStore)?.get(idExp),
				expHandle,
				'the head commit and the dbB writes must hand the idExp hold lock on'
			);
			// Lapsed on demand: each per-write commit above prunes a lapsed handle (ImmediateTransaction's
			// releaseRecordLocks), so a lease short enough to wait out races them.
			expHandle.revokeLease();
			await assert.rejects(
				async () => await new TableBAudited(idExp, immCtx).put(idExp, { id: idExp, n: 999 }),
				(err) => err?.statusCode === 409
			);
			assert.equal((await TableBAudited.get(idExp))?.n, 1);
		} finally {
			await unlockSafe(holderPut);
			await unlockSafe(holderDel);
			await unlockSafe(holderPutU);
			await unlockSafe(holderDelU);
			await unlockSafe(holderExp);
		}
	});

	it('a mid-scope txn.commit() keeps the chained hold locks for the rest of the scope', async () => {
		const idA = 'arm2-head-a';
		const idPut = 'arm2-put-b';
		const idDel = 'arm2-del-b';

		if (isLMDB) {
			await assert.rejects(
				() => TableBAudited.lock(idPut, { hold: true }, makeContext()),
				(err) => err?.statusCode === 501,
				'LMDB must reject Table.lock() with statusCode 501'
			);
			return;
		}

		const futureStamp = Date.now() + 2500;

		let holderA;
		let holderPut;
		let holderDel;
		let holderPutU;
		let holderDelU;
		try {
			const ctx = makeContext();
			await transaction(ctx, async (txn) => {
				ctx.timestamp = futureStamp;
				txn.timestamp = futureStamp;

				holderA = trackHolder(await TableAAudited.lock(idA, { hold: true, lease: 5000 }, ctx));
				txn.timestamp = futureStamp;
				await new TableAAudited(idA, ctx).put(idA, { id: idA, n: 10 });

				holderPut = trackHolder(await TableBAudited.lock(idPut, { hold: true, lease: 5000 }, ctx));
				holderDel = trackHolder(await TableBAudited.lock(idDel, { hold: true, lease: 5000 }, ctx));
				holderPutU = trackHolder(await TableBUnaudited.lock(idPut, { hold: true, lease: 5000 }, ctx));
				holderDelU = trackHolder(await TableBUnaudited.lock(idDel, { hold: true, lease: 5000 }, ctx));

				txn.next.timestamp = futureStamp;
				await new TableBAudited(idPut, ctx).put(idPut, { id: idPut, n: 10 });
				txn.next.timestamp = futureStamp;
				await new TableBAudited(idDel, ctx).put(idDel, { id: idDel, n: 10 });
				txn.next.timestamp = futureStamp;
				await new TableBUnaudited(idPut, ctx).put(idPut, { id: idPut, n: 10 });
				txn.next.timestamp = futureStamp;
				await new TableBUnaudited(idDel, ctx).put(idDel, { id: idDel, n: 10 });

				await txn.commit();

				delete ctx.timestamp;
				txn.timestamp = 0;

				await new TableAAudited(idA, ctx).put(idA, { id: idA, n: 20 });
				await new TableAAudited(idA, ctx).patch(idA, { n: 21 });

				await new TableBAudited(idPut, ctx).put(idPut, { id: idPut, n: 20 });
				await new TableBAudited(idPut, ctx).patch(idPut, { n: 21 });
				await new TableBAudited(idDel, ctx).delete(idDel);

				await new TableBUnaudited(idPut, ctx).put(idPut, { id: idPut, n: 20 });
				await new TableBUnaudited(idPut, ctx).patch(idPut, { n: 21 });
				await new TableBUnaudited(idDel, ctx).delete(idDel);
			});

			const afterA = await TableAAudited.get(idA);
			assert.equal(afterA?.n, 21);

			const afterPut = await TableBAudited.get(idPut);
			const afterDel = await TableBAudited.get(idDel);
			const afterPutU = await TableBUnaudited.get(idPut);
			const afterDelU = await TableBUnaudited.get(idDel);

			assert.equal(afterPut?.n, 21);
			assert.equal(afterDel, null);
			assert.equal(afterPutU?.n, 21);
			assert.equal(afterDelU, null);
		} finally {
			await unlockSafe(holderA);
			await unlockSafe(holderPut);
			await unlockSafe(holderDel);
			await unlockSafe(holderPutU);
			await unlockSafe(holderDelU);
		}
	});

	it('a mid-scope txn.commit() keeps second- and third-database hold locks for re-entry, the expired-lease 409 and unlock()', async () => {
		const idExpA = 'arm3-exp-a';
		const idLockA = 'arm3-lock-a';
		const idExpB = 'arm3-exp-b';
		const idLockB = 'arm3-lock-b';
		const idLockC = 'arm3-lock-c';

		await TableAAudited.put(idExpA, { id: idExpA, n: 1 });
		await TableAAudited.put(idLockA, { id: idLockA, n: 1 });
		await TableBAudited.put(idExpB, { id: idExpB, n: 1 });
		await TableBAudited.put(idLockB, { id: idLockB, n: 1 });
		await TableC.put(idLockC, { id: idLockC, n: 1 });

		if (isLMDB) {
			await assert.rejects(
				() => TableBAudited.lock(idLockB, { hold: true }, makeContext()),
				(err) => err?.statusCode === 501,
				'LMDB must reject Table.lock() with statusCode 501'
			);
			const lmdbCtx = makeContext();
			await transaction(lmdbCtx, async (txn) => {
				await new TableAAudited('arm3-lmdb-a', lmdbCtx).put('arm3-lmdb-a', { id: 'arm3-lmdb-a', n: 1 });
				await new TableBAudited(idLockB, lmdbCtx).put(idLockB, { id: idLockB, n: 10 });
				await new TableC(idLockC, lmdbCtx).put(idLockC, { id: idLockC, n: 10 });
				await txn.commit();
				await new TableBAudited(idLockB, lmdbCtx).put(idLockB, { id: idLockB, n: 20 });
				await new TableC(idLockC, lmdbCtx).put(idLockC, { id: idLockC, n: 20 });
			});
			assert.equal((await TableBAudited.get(idLockB))?.n, 20);
			assert.equal((await TableC.get(idLockC))?.n, 20);
			return;
		}

		let holderExpA;
		let holderLockA;
		let holderExpB;
		let holderLockB;
		let holderLockC;
		try {
			const ctx = makeContext();
			await transaction(ctx, async (txn) => {
				holderExpA = trackHolder(await TableAAudited.lock(idExpA, { hold: true, lease: 180 }, ctx));
				holderLockA = trackHolder(await TableAAudited.lock(idLockA, { hold: true, lease: 5000 }, ctx));
				await new TableAAudited('arm3-a-init', ctx).put('arm3-a-init', {
					id: 'arm3-a-init',
					n: 1,
				});

				holderExpB = trackHolder(await TableBAudited.lock(idExpB, { hold: true, lease: 180 }, ctx));
				holderLockB = trackHolder(await TableBAudited.lock(idLockB, { hold: true, lease: 5000 }, ctx));
				holderLockC = trackHolder(await TableC.lock(idLockC, { hold: true, lease: 5000 }, ctx));

				assert.ok(txn.next?.next, 'the scope chains a second and a third database');

				await txn.commit();

				const reentrantA = await TableAAudited.lock(idLockA, { hold: true, timeout: 120 }, ctx);
				assert.equal(reentrantA.id, idLockA);

				const reentrantB = await TableBAudited.lock(idLockB, { hold: true, timeout: 120 }, ctx);
				const reentrantC = await TableC.lock(idLockC, { hold: true, timeout: 120 }, ctx);
				assert.equal(reentrantB?.id, idLockB);
				assert.equal(reentrantC?.id, idLockC);

				const linkB = TableBAudited._txnForContext(ctx);
				await waitFor(
					() =>
						txn.recordLocks?.get(TableAAudited.primaryStore)?.get(idExpA)?.isExpired() &&
						linkB.recordLocks?.get(TableBAudited.primaryStore)?.get(idExpB)?.isExpired(),
					2000
				);

				await assert.rejects(
					async () => await new TableAAudited(idExpA, ctx).put(idExpA, { id: idExpA, n: 999 }),
					(err) => {
						assert.equal(err?.statusCode, 409);
						return true;
					}
				);

				await assert.rejects(
					async () => await new TableBAudited(idExpB, ctx).put(idExpB, { id: idExpB, n: 999 }),
					(err) => err?.statusCode === 409
				);
				assert.equal(await holderLockB.unlock(), true);
				assert.equal(TableBAudited._txnForContext(ctx).recordLockFor(TableBAudited.primaryStore, idLockB), undefined);
			});

			assert.equal((await TableBAudited.get(idExpB))?.n, 1);
		} finally {
			await unlockSafe(holderExpA);
			await unlockSafe(holderLockA);
			await unlockSafe(holderExpB);
			await unlockSafe(holderLockB);
			await unlockSafe(holderLockC);
		}
	});
});
