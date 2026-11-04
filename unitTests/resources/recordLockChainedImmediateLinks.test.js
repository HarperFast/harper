const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RELEASED_TRANSACTION, writeKeyId } = require('#src/resources/DatabaseTransaction');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// harper#3872: txnForContext drops a spent self-committing link (#2323); its record locks must reach the link that replaces it
describe('Record locks on a chained self-committing link survive the link being unlinked', function () {
	this.timeout(15000);

	let TableA;
	let TableBAudited;
	let TableBUnaudited;
	let TableC;
	let nextId = 1;
	const id = (prefix = 'chained') => `${prefix}-${nextId++}`;
	const cleanups = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);

		TableA = table({
			table: 'ChainedLinksTableA',
			database: 'data',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});

		TableBAudited = table({
			table: 'ChainedLinksTableBAudited',
			database: 'chained_links_db_b',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});

		TableBUnaudited = table({
			table: 'ChainedLinksTableBUnaudited',
			database: 'chained_links_db_b',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});

		TableC = table({
			table: 'ChainedLinksTableC',
			database: 'chained_links_db_c',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
	});

	afterEach(async function () {
		while (cleanups.length) {
			const fn = cleanups.pop();
			try {
				await fn();
			} catch {}
		}
	});

	after(async function () {
		await resetDatabases();
	});

	it('cross-database ImmediateTransaction writes commit durably on rocksdb and lmdb, and head-database { hold: true } recordLocks survive per-write commits on rocksdb while lmdb rejects lock() with 501', async function () {
		const pcA = id('pc-a');
		const pcB = id('pc-b');
		const pcC = id('pc-c');
		await TableA.put(pcA, { id: pcA, n: 0 });
		await TableBAudited.put(pcB, { id: pcB, n: 0 });
		await TableC.put(pcC, { id: pcC, n: 0 });

		const ctx = { transaction: RELEASED_TRANSACTION };
		await TableA.getResource({ id: pcA }, ctx, {});
		assert.strictEqual(ctx.transaction?.saveCommits, true, 'Expected self-committing head transaction on dbA');

		for (const round of [1, 2]) {
			const resB = await TableBAudited.getResource({ id: pcB }, ctx, {});
			resB.update({ n: round }, false);
			const savedB = resB.save();
			assert.strictEqual(
				typeof savedB?.then,
				'function',
				`Expected dbB save() in round ${round} to return a Promise (#2323)`
			);
			await savedB;

			const resC = await TableC.getResource({ id: pcC }, ctx, {});
			resC.update({ n: round * 10 }, false);
			const savedC = resC.save();
			assert.strictEqual(
				typeof savedC?.then,
				'function',
				`Expected dbC save() in round ${round} to return a Promise (#2323)`
			);
			await savedC;
		}

		assert.strictEqual((await TableBAudited.get(pcB))?.n, 2, 'Expected second sequential write on dbB to persist');
		assert.strictEqual((await TableC.get(pcC))?.n, 20, 'Expected second sequential write on dbC to persist');

		if (isLMDB) {
			await assert.rejects(
				() => TableBAudited.lock(id('pc-lock'), { hold: true }, {}),
				(err) => err?.statusCode === 501,
				'LMDB must reject Table.lock() with statusCode 501'
			);
			return;
		}

		const idA = id('head-a');
		await TableA.put(idA, { id: idA, n: 1 });
		const futureStamp = Date.now() + 2500;
		const headCtx = { timestamp: futureStamp };
		const holderA = await TableA.lock(idA, { hold: true, lease: 5000 }, headCtx);
		cleanups.push(() => holderA.unlock());
		delete headCtx.timestamp;

		holderA.set('n', 10);
		await holderA.save();

		await new TableA(idA, headCtx).put(idA, { id: idA, n: 20 });
		await new TableA(idA, headCtx).patch(idA, { n: 21 });

		const afterHead = await TableA.get(idA);
		assert.strictEqual(afterHead?.n, 21, 'Head-database put/patch on held key must advance past futureStamp');
		assert.ok(
			TableA.primaryStore.getEntry(idA).version > futureStamp,
			`Expected head entry version (${TableA.primaryStore.getEntry(idA).version}) > futureStamp (${futureStamp})`
		);

		const reA = await TableA.lock(idA, { hold: true, timeout: 100 }, headCtx);
		assert.strictEqual(reA?.n, 21, 'Re-entrant lock() on head database must succeed and return latest record');

		const idAExp = id('head-exp');
		await TableA.put(idAExp, { id: idAExp, n: 1 });
		const expHeadCtx = {};
		const holderAExp = await TableA.lock(idAExp, { hold: true, lease: 150 }, expHeadCtx);
		cleanups.push(() => holderAExp.unlock());
		const expHeadHandle = expHeadCtx.transaction.recordLockFor(TableA.primaryStore, writeKeyId(idAExp));

		holderAExp.set('n', 10);
		await holderAExp.save();
		await waitFor(() => expHeadHandle?.isExpired(), 2000);

		await assert.rejects(
			async () => await new TableA(idAExp, expHeadCtx).put(idAExp, { id: idAExp, n: 999 }),
			(err) => err?.statusCode === 409,
			'Expired head-database hold lock must fence subsequent new TableA(id, ctx).put with 409'
		);
		assert.strictEqual((await TableA.get(idAExp))?.n, 10, 'Fenced head-database write must not overwrite record');
	});

	it('new TableB(id, immCtx).put, .patch, and .delete on a chained second database (dbB) after a committed write under { hold: true } must bind recordLocks and stamp above holderVersionCandidate() across audit:true and audit:false', async function () {
		if (isLMDB) {
			const idLmdb = id('arm1-lmdb');
			const immCtx = {};
			await TableA.put('arm1-lmdb-head', { id: 'arm1-lmdb-head', n: 1 });
			await TableA.getResource({ id: 'arm1-lmdb-head' }, immCtx, {});
			await new TableBAudited(idLmdb, immCtx).put(idLmdb, { id: idLmdb, n: 20 });
			await new TableBAudited(idLmdb, immCtx).patch(idLmdb, { n: 21 });
			assert.strictEqual((await TableBAudited.get(idLmdb))?.n, 21);
			await new TableBAudited(idLmdb, immCtx).delete(idLmdb);
			await TableBAudited._txnForContext(immCtx).save();
			assert.strictEqual((await TableBAudited.get(idLmdb)) == null, true);
			return;
		}

		const results = [];
		for (const [label, TargetTable] of [
			['audit:true', TableBAudited],
			['audit:false', TableBUnaudited],
		]) {
			const idHead = id(`arm1-head-${label}`);
			const idPut = id(`arm1-put-${label}`);
			const idDel = id(`arm1-del-${label}`);
			await TableA.put(idHead, { id: idHead, n: 1 });
			await TargetTable.put(idPut, { id: idPut, n: 1 });
			await TargetTable.put(idDel, { id: idDel, n: 1 });

			const futureStamp = Date.now() + 2500;
			const immPutCtx = { timestamp: futureStamp };
			await TableA.getResource({ id: idHead }, immPutCtx, {});
			assert.strictEqual(immPutCtx.transaction?.constructor?.name, 'ImmediateTransaction');

			const holderPut = await TargetTable.lock(idPut, { hold: true, lease: 5000 }, immPutCtx);
			cleanups.push(() => holderPut.unlock());
			delete immPutCtx.timestamp;

			holderPut.set('n', 10);
			await holderPut.save();

			await new TargetTable(idPut, immPutCtx).put(idPut, { id: idPut, n: 20 });
			await new TargetTable(idPut, immPutCtx).patch(idPut, { n: 21 });

			const immDelCtx = { timestamp: futureStamp };
			await TableA.getResource({ id: idHead }, immDelCtx, {});
			const holderDel = await TargetTable.lock(idDel, { hold: true, lease: 5000 }, immDelCtx);
			cleanups.push(() => holderDel.unlock());
			delete immDelCtx.timestamp;

			holderDel.set('n', 10);
			await holderDel.save();

			await new TargetTable(idDel, immDelCtx).delete(idDel);

			const afterPut = await TargetTable.get(idPut);
			const afterPutVersion = TargetTable.primaryStore.getEntry(idPut)?.version;
			await waitFor(async () => (await TargetTable.get(idDel)) == null, {
				timeout: 2000,
				message: `[${label}] delete on the held key must land`,
			});
			const afterDel = await TargetTable.get(idDel);

			results.push({ label, afterPut, afterPutVersion, futureStamp, afterDel });
		}

		for (const { label, afterPut, afterPutVersion, futureStamp, afterDel } of results) {
			assert.strictEqual(afterPut?.n, 21, `[${label}] put+patch on the held key must not lose to the lock's floor`);
			assert.ok(afterPutVersion > futureStamp, `[${label}] version ${afterPutVersion} must exceed ${futureStamp}`);
			assert.equal(afterDel, null, `[${label}] delete on the held key must land`);
		}
	});

	it('expired-lease { hold: true } lock on a chained second database (dbB) must still fence subsequent new TableB(id, immCtx).put / .patch / .delete writes with 409 Conflict after a prior commit on dbB', async function () {
		if (isLMDB) {
			await assert.rejects(
				() => TableBAudited.lock(id('arm2-lmdb'), { hold: true }, {}),
				(err) => err?.statusCode === 501
			);
			return;
		}

		const idHead = id('arm2-head');
		const idExp = id('arm2-exp');
		await TableA.put(idHead, { id: idHead, n: 1 });
		await TableBAudited.put(idExp, { id: idExp, n: 1 });

		const immExpCtx = {};
		await TableA.getResource({ id: idHead }, immExpCtx, {});

		const holderExp = await TableBAudited.lock(idExp, { hold: true, lease: 180 }, immExpCtx);
		cleanups.push(() => holderExp.unlock());
		const expBHandle = TableBAudited._txnForContext(immExpCtx).recordLockFor(
			TableBAudited.primaryStore,
			writeKeyId(idExp)
		);

		holderExp.set('n', 10);
		await holderExp.save();
		assert.strictEqual((await TableBAudited.get(idExp))?.n, 10);

		await waitFor(() => expBHandle?.isExpired(), 2000);

		await assert.rejects(
			async () => await new TableBAudited(idExp, immExpCtx).put(idExp, { id: idExp, n: 999 }),
			(err) => err?.statusCode === 409
		);
		assert.strictEqual((await TableBAudited.get(idExp))?.n, 10);
	});

	it('re-entrant TableB.lock() and holderB.unlock() on a chained second database (dbB) must preserve recordLocks across dbB commits and dbC chain traversals while keeping subsequent dbB writes awaitable (#2323)', async function () {
		if (isLMDB) {
			await assert.rejects(
				() => TableBAudited.lock(id('arm3-lmdb'), { hold: true }, {}),
				(err) => err?.statusCode === 501
			);
			return;
		}

		const idHead = id('arm3-head');
		const idLock = id('arm3-lock');
		const idOther = id('arm3-other');
		const idC = id('arm3-c');
		await TableA.put(idHead, { id: idHead, n: 1 });
		await TableBAudited.put(idLock, { id: idLock, n: 1 });
		await TableBAudited.put(idOther, { id: idOther, n: 1 });
		await TableC.put(idC, { id: idC, n: 1 });

		const immChainCtx = {};
		await TableA.getResource({ id: idHead }, immChainCtx, {});

		const holderB = await TableBAudited.lock(idLock, { hold: true, lease: 5000 }, immChainCtx);
		cleanups.push(() => holderB.unlock());

		holderB.set('n', 10);
		await holderB.save();

		const recC = await TableC.getResource({ id: idC }, immChainCtx, {});
		recC.update({ n: 30 }, false);
		const savedC = recC.save();
		assert.strictEqual(typeof savedC?.then, 'function', 'Expected dbC save() to return a Promise');
		await savedC;
		assert.strictEqual((await TableC.get(idC))?.n, 30);

		const recBOther = await TableBAudited.getResource({ id: idOther }, immChainCtx, {});
		recBOther.update({ n: 22 }, false);
		const savedBOther = recBOther.save();
		assert.strictEqual(typeof savedBOther?.then, 'function', 'Expected second dbB save() to return a Promise (#2323)');
		await savedBOther;
		assert.strictEqual((await TableBAudited.get(idOther))?.n, 22);

		let reLocked;
		let reLockErr;
		try {
			reLocked = await TableBAudited.lock(idLock, { hold: true, timeout: 120 }, immChainCtx);
		} catch (err) {
			reLockErr = err;
		}

		assert.strictEqual(
			reLockErr,
			undefined,
			`re-entrant lock() must not 423 against its own lock: ${reLockErr?.message}`
		);
		assert.strictEqual(reLocked?.n, 10);

		assert.strictEqual(await holderB.unlock(), true);
		const dbBLink = TableBAudited._txnForContext(immChainCtx);
		assert.strictEqual(dbBLink.recordLockFor(TableBAudited.primaryStore, writeKeyId(idLock)), undefined);
		assert.strictEqual(immChainCtx.transaction.detachedRecordLocks, undefined);

		await new TableBAudited(idLock, immChainCtx).put(idLock, { id: idLock, n: 55 });
		assert.strictEqual((await TableBAudited.get(idLock))?.n, 55);
	});

	function registeredHandles(ctx, store, keyId) {
		const found = [];
		for (let link = ctx.transaction; link; link = link.next) {
			const handle = link.recordLocks?.get(store)?.get(keyId);
			if (handle) found.push(handle);
		}
		for (const recordLocks of ctx.transaction.detachedRecordLocks?.values() ?? []) {
			const handle = recordLocks.get(store)?.get(keyId);
			if (handle) found.push(handle);
		}
		return found;
	}

	it('a spent chained link without record locks is still unlinked rather than reused (#2323)', async function () {
		if (isLMDB) return this.skip();
		const idHead = id('spent-head');
		const idB1 = id('spent-b');
		const idB2 = id('spent-b');
		await TableA.put(idHead, { id: idHead, n: 1 });
		const ctx = {};
		await TableA.getResource({ id: idHead }, ctx, {});
		await new TableBAudited(idB1, ctx).put(idB1, { id: idB1, n: 1 });
		const spent = ctx.transaction.next;
		assert.ok(spent);
		await new TableBAudited(idB2, ctx).put(idB2, { id: idB2, n: 2 });
		assert.notStrictEqual(ctx.transaction.next, spent);
		assert.strictEqual(ctx.transaction.detachedRecordLocks, undefined);
		assert.strictEqual((await TableBAudited.get(idB2))?.n, 2);
	});

	it('a lock() that waits while its link leaves the chain registers on the link that replaces it', async function () {
		if (isLMDB) return this.skip();
		const idHead = id('wait-head');
		const idB = id('wait-b');
		await TableA.put(idHead, { id: idHead, n: 1 });
		await TableBAudited.put(idB, { id: idB, n: 1 });
		const contender = await TableBAudited.lock(idB, { hold: true, lease: 5000 }, {});
		cleanups.push(() => contender.unlock());

		const ctx = {};
		await TableA.getResource({ id: idHead }, ctx, {});
		const waiting = TableBAudited.lock(idB, { hold: true, lease: 5000, timeout: 5000 }, ctx);
		const waitingLink = ctx.transaction.next;
		assert.ok(waitingLink?.pendingLockFor(TableBAudited.primaryStore, writeKeyId(idB)));
		// the head's commit drops the OPEN, write-free link the waiting lock() was made through
		await new TableA(idHead, ctx).put(idHead, { id: idHead, n: 2 });
		assert.notStrictEqual(ctx.transaction.next, waitingLink);

		await contender.unlock();
		const holder = await waiting;
		cleanups.push(() => holder.unlock());
		const reentrant = await TableBAudited.lock(idB, { hold: true, timeout: 100 }, ctx);
		assert.strictEqual(reentrant.id, idB);
		assert.strictEqual(registeredHandles(ctx, TableBAudited.primaryStore, writeKeyId(idB)).length, 1);

		assert.strictEqual(await holder.unlock(), true);
		assert.strictEqual(registeredHandles(ctx, TableBAudited.primaryStore, writeKeyId(idB)).length, 0);
		const fresh = await TableBAudited.lock(idB, { hold: true, timeout: 500 }, {});
		await fresh.unlock();
	});

	it('a lock() that waits while its link leaves the chain is refused over a write staged on the replacement link', async function () {
		if (isLMDB) return this.skip();
		const idHead = id('replaced-head');
		const idB = id('replaced-b');
		await TableA.put(idHead, { id: idHead, n: 1 });
		await TableBAudited.put(idB, { id: idB, n: 1 });
		const contender = await TableBAudited.lock(idB, { hold: true, lease: 5000 }, {});
		cleanups.push(() => contender.unlock());

		const ctx = {};
		await TableA.getResource({ id: idHead }, ctx, {});
		const waiting = TableBAudited.lock(idB, { hold: true, lease: 5000, timeout: 5000 }, ctx);
		const waitingLink = ctx.transaction.next;
		await new TableA(idHead, ctx).put(idHead, { id: idHead, n: 2 });
		assert.notStrictEqual(ctx.transaction.next, waitingLink);
		const recB = await TableBAudited.getResource({ id: idB }, ctx, {});
		await recB.update({ n: 7 });
		assert.notStrictEqual(ctx.transaction.next, waitingLink);

		assert.strictEqual(await contender.unlock(), true);
		await assert.rejects(waiting, (err) => err?.statusCode === 409);
		assert.strictEqual(registeredHandles(ctx, TableBAudited.primaryStore, writeKeyId(idB)).length, 0);
		const other = await TableBAudited.lock(idB, { timeout: 500 }, {});
		await other.unlock();
		await recB.save();
		assert.strictEqual((await TableBAudited.get(idB))?.n, 7);
	});

	it('a hold lock on a second database keeps its writes across commits and a third database', async function () {
		if (isLMDB) return this.skip();
		const idHead = id('combined-head');
		const idB = id('combined-b');
		const idExp = id('combined-exp');
		const idC = id('combined-c');
		await TableA.put(idHead, { id: idHead, n: 1 });
		await TableBAudited.put(idB, { id: idB, n: 1 });
		await TableBAudited.put(idExp, { id: idExp, n: 1 });
		await TableC.put(idC, { id: idC, n: 1 });

		const ctx = {};
		await TableA.getResource({ id: idHead }, ctx, {});
		const recB = await TableBAudited.getResource({ id: idB }, ctx, {});
		await recB.lock({ hold: true, lease: 5000 });
		cleanups.push(() => recB.unlock());
		recB.addTo('n', 2);
		await recB.save();
		assert.strictEqual((await TableBAudited.get(idB))?.n, 3);

		const holderExp = await TableBAudited.lock(idExp, { hold: true, lease: 150 }, ctx);
		cleanups.push(() => holderExp.unlock());
		const expHandle = registeredHandles(ctx, TableBAudited.primaryStore, writeKeyId(idExp))[0];
		holderExp.set('n', 10);
		await holderExp.save();

		await new TableC(idC, ctx).put(idC, { id: idC, n: 5 });
		recB.addTo('n', 4);
		await recB.save();
		await new TableC(idC, ctx).put(idC, { id: idC, n: 6 });

		await waitFor(() => expHandle?.isExpired(), 2000);
		await assert.rejects(
			async () => await new TableBAudited(idExp, ctx).put(idExp, { id: idExp, n: 999 }),
			(err) => err?.statusCode === 409
		);

		assert.strictEqual(await recB.unlock(), true);
		assert.strictEqual((await TableBAudited.get(idB))?.n, 7);
		assert.strictEqual((await TableBAudited.get(idExp))?.n, 10);
		assert.strictEqual((await TableC.get(idC))?.n, 6);
		assert.strictEqual(registeredHandles(ctx, TableBAudited.primaryStore, writeKeyId(idB)).length, 0);
		const contender = await TableBAudited.lock(idB, { hold: true, timeout: 500 }, {});
		await contender.unlock();
	});
});
