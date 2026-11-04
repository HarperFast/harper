const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { writeKeyId } = require('#src/resources/DatabaseTransaction');
require('#src/server/serverHelpers/serverUtilities');

const SKIP_ON_LMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

const isConflict = (err) => err?.statusCode === 409;

// harper#3896: lock first, then write. A fresh lock() refuses a record its transaction has an uncommitted write to.
describe('Record locks: lock() refuses a record its transaction has a pending write to', function () {
	this.timeout(10000);
	let Audited;
	let Unaudited;
	let Embedded;
	let releaseEmbed;
	let embedEntered;
	let gate;
	let nextId = 1;
	const makeId = (prefix) => `${prefix}-${nextId++}`;
	const cleanups = [];
	const nextHook = () => {
		gate = new Promise((resolve) => (releaseEmbed = resolve));
		return new Promise((resolve) => (embedEntered = resolve));
	};
	// nothing may be left holding the key: another context takes it at once
	const assertLockable = async (Table, recordId) => {
		const other = await Table.lock(recordId, { timeout: 100 }, {});
		await other.unlock();
	};

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Audited = table({
			table: 'RecordLockPendingWriteAudited',
			database: 'record_lock_pending_write',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'label' },
				{ name: 'tag' },
				{ name: 'items' },
			],
		});
		Audited.loadAsInstance = true;
		Audited.getReturnMutable = true;
		Unaudited = table({
			table: 'RecordLockPendingWriteUnaudited',
			database: 'record_lock_pending_write',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'label' }, { name: 'tag' }],
		});
		Unaudited.loadAsInstance = true;
		Unaudited.getReturnMutable = true;
		if (SKIP_ON_LMDB) return;
		Embedded = table({
			table: 'RecordLockPendingWriteEmbedded',
			database: 'record_lock_pending_write',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'vector', type: 'Array', embed: { source: 'name', model: 'unused' } },
			],
		});
		Embedded.loadAsInstance = true;
		Embedded.getReturnMutable = true;
		Embedded.setEmbedAttribute('vector', async () => {
			const wait = gate;
			gate = undefined;
			if (wait) {
				embedEntered();
				await wait;
			}
			return [1, 2, 3];
		});
	});

	afterEach(async function () {
		while (cleanups.length) await cleanups.pop()();
	});

	after(async function () {
		await resetDatabases();
	});

	it('LMDB keeps its 501 lock contract and ordinary same-instance saves', async function () {
		if (!SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('lmdb');
		await Audited.put({ id: recordId, n: 10, label: 'v0' });
		await assert.rejects(
			() => Audited.lock(recordId),
			(err) => err?.statusCode === 501
		);
		const ctx = {};
		await transaction(ctx, async () => {
			const rec = await Audited.get(recordId, ctx);
			rec.addTo('n', 5);
			rec.set('label', 'lmdb-ok');
			await rec.save();
		});
		const after = await Audited.get(recordId);
		assert.strictEqual(after.n, 15);
		assert.strictEqual(after.label, 'lmdb-ok');
	});

	it("an instance's own write staged before its lock() is refused, nothing is held, and the write still saves", async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const idAddTo = makeId('own-addto');
		const idLazy = makeId('own-lazy');
		const idImmediate = makeId('own-immediate');
		await Audited.put({ id: idAddTo, n: 10, label: 'v0', tag: 'init' });
		await Unaudited.put({ id: idLazy, n: 100, label: 'v0', tag: 'init' });
		await Audited.put({ id: idImmediate, n: 10, label: 'v0', tag: 'init' });

		const ctx1 = {};
		await transaction(ctx1, async () => {
			const rec = await Audited.get(idAddTo, ctx1);
			rec.addTo('n', 5);
			rec.set('label', 'pre-lock');
			await assert.rejects(() => rec.lock(), isConflict);
			await assertLockable(Audited, idAddTo);
			await rec.save();
		});

		const ctx2 = {};
		await transaction(ctx2, async () => {
			const rec = await Unaudited.update(idLazy, undefined, ctx2);
			rec.set('label', 'pre-lock');
			rec.addTo('n', 25);
			await assert.rejects(() => rec.lock({ hold: true, lease: 5000 }), isConflict);
			await assertLockable(Unaudited, idLazy);
			await rec.save();
		});

		// self-committing context: the staged update() is still pending until save()
		const rec = await Audited.get(idImmediate);
		await rec.update({ n: 25 });
		await assert.rejects(() => rec.lock(), isConflict);
		await assert.rejects(() => rec.lock({ hold: true, lease: 5000 }), isConflict);
		await assertLockable(Audited, idImmediate);
		await rec.save();

		const afterAddTo = await Audited.get(idAddTo);
		assert.strictEqual(afterAddTo.n, 15);
		assert.strictEqual(afterAddTo.label, 'pre-lock');
		const afterLazy = await Unaudited.get(idLazy);
		assert.strictEqual(afterLazy.n, 125);
		assert.strictEqual(afterLazy.label, 'pre-lock');
		assert.strictEqual((await Audited.get(idImmediate)).n, 25);
	});

	it('a write staged earlier in the transaction by a static verb or another instance is refused; caught, the write still commits', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const idStatic = makeId('static');
		const idSaved = makeId('saved');
		const idOther = makeId('other-instance');
		await Audited.put({ id: idStatic, n: 1 });
		await Audited.put({ id: idSaved, n: 1 });
		await Audited.put({ id: idOther, n: 1 });

		const ctx = {};
		await transaction(ctx, async () => {
			await Audited.update(idStatic, { n: 20 }, ctx);
			await assert.rejects(() => Audited.lock(idStatic, undefined, ctx), isConflict);
			// a saved write is still uncommitted until the transaction commits
			await Audited.put({ id: idSaved, n: 30 }, ctx);
			await assert.rejects(() => Audited.lock(idSaved, { hold: true, lease: 5000 }, ctx), isConflict);
			const writer = await Audited.get(idOther, ctx);
			await writer.update({ n: 40 });
			await writer.save();
			const locker = await Audited.get(idOther, ctx);
			await assert.rejects(() => locker.lock(), isConflict);
		});
		assert.strictEqual((await Audited.get(idStatic)).n, 20);
		assert.strictEqual((await Audited.get(idSaved)).n, 30);
		assert.strictEqual((await Audited.get(idOther)).n, 40);
		await assertLockable(Audited, idSaved);
	});

	it('a refusal that escapes the transaction rolls its write back', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('escape');
		await Audited.put({ id: recordId, n: 1 });
		await assert.rejects(
			() =>
				transaction({}, async () => {
					await Audited.put({ id: recordId, n: 2 });
					await Audited.lock(recordId);
				}),
			isConflict
		);
		assert.strictEqual((await Audited.get(recordId)).n, 1);
		await assertLockable(Audited, recordId);
	});

	it('a committed write, a write to another record or store, and a write under the lock do not refuse lock()', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const committedId = makeId('committed');
		const lockedId = makeId('locked');
		const otherId = makeId('other-record');
		await Audited.put({ id: committedId, n: 1 });
		await Audited.put({ id: lockedId, n: 1 });
		await Audited.put({ id: otherId, n: 1 });
		await Unaudited.put({ id: lockedId, n: 1 });

		// a self-committing context's put has committed by the time lock() runs
		const immediate = {};
		await Audited.getResource({ id: committedId }, immediate, {});
		await Audited.put({ id: committedId, n: 2 }, immediate);
		const holder = await Audited.lock(committedId, { hold: true, lease: 5000 }, immediate);
		cleanups.push(() => holder.unlock());
		holder.set('n', 3);
		await holder.save();
		assert.strictEqual(await holder.unlock(), true);
		assert.strictEqual((await Audited.get(committedId)).n, 3);

		const ctx = {};
		await transaction(ctx, async () => {
			await Audited.put({ id: otherId, n: 2 }, ctx);
			await Unaudited.put({ id: lockedId, n: 2 }, ctx);
			const locked = await Audited.lock(lockedId, undefined, ctx);
			locked.set('n', 2);
			await locked.save();
			const reentrant = await Audited.lock(lockedId, undefined, ctx);
			assert.strictEqual(reentrant.n, 2);
			const upgraded = await Audited.lock(lockedId, { hold: true, lease: 5000 }, ctx);
			cleanups.push(() => upgraded.unlock());
			upgraded.set('tag', 'held');
			await upgraded.save();
		});
		const after = await Audited.get(lockedId);
		assert.strictEqual(after.n, 2);
		assert.strictEqual(after.tag, 'held');
		assert.strictEqual((await Audited.get(otherId)).n, 2);
		assert.strictEqual((await Unaudited.get(lockedId)).n, 2);
	});

	it('a refused lock() does not wait for a key another context holds', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('no-wait');
		await Audited.put({ id: recordId, n: 1 });
		const contender = await Audited.lock(recordId, { hold: true, lease: 5000 }, {});
		cleanups.push(() => contender.unlock());
		const ctx = {};
		await transaction(ctx, async () => {
			await Audited.update(recordId, { n: 2 }, ctx);
			await assert.rejects(() => Audited.lock(recordId, { timeout: 2000 }, ctx), isConflict);
			assert.strictEqual(ctx.transaction.pendingLockFor(Audited.primaryStore, writeKeyId(recordId)), undefined);
		});
		assert.strictEqual(await contender.unlock(), true);
		assert.strictEqual((await Audited.get(recordId)).n, 2);
	});

	it('a write staged while lock() waits for the key is refused once the key is acquired, and the key is given back', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('during-wait');
		await Audited.put({ id: recordId, n: 1 });
		const contender = await Audited.lock(recordId, { hold: true, lease: 5000 }, {});
		cleanups.push(() => contender.unlock());
		const ctx = {};
		await transaction(ctx, async () => {
			const waiting = Audited.lock(recordId, { timeout: 5000 }, ctx);
			assert.ok(ctx.transaction.pendingLockFor(Audited.primaryStore, writeKeyId(recordId)));
			await Audited.update(recordId, { n: 5 }, ctx);
			assert.strictEqual(await contender.unlock(), true);
			await assert.rejects(waiting, isConflict);
			await assertLockable(Audited, recordId);
		});
		assert.strictEqual((await Audited.get(recordId)).n, 5);
	});

	it("an instance's own update() still running its model hook refuses that instance's lock() and keeps its changes", async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('hook');
		await Embedded.put({ id: recordId, name: 'a' });
		const ctx = {};
		await transaction(ctx, async () => {
			const rec = await Embedded.get(recordId, ctx);
			const hookEntered = nextHook();
			const pending = rec.update({ name: 'b' });
			await hookEntered;
			await assert.rejects(() => rec.lock(), isConflict);
			await assertLockable(Embedded, recordId);
			releaseEmbed();
			await pending;
			await rec.save();
		});
		assert.strictEqual((await Embedded.get(recordId)).name, 'b');
	});

	it("unlock() keeps a write bound from another instance's lock, which then lands as an ordinary write and closes the instance", async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('joined');
		await Audited.put({ id: recordId, n: 10 });
		const ctx = {};
		await Audited.getResource({ id: recordId }, ctx, {});
		const holder = await Audited.lock(recordId, { hold: true, lease: 5000 }, ctx);
		cleanups.push(() => holder.unlock());
		const rec = await Audited.getResource({ id: recordId }, ctx, {});
		await rec.update({ n: 25 });
		await rec.lock();
		assert.strictEqual(await rec.unlock(), true);
		await rec.save();
		assert.strictEqual((await Audited.get(recordId)).n, 25);
		assert.throws(() => rec.set('n', 26), isConflict);
	});

	it('an instance joining a lock another instance holds in its transaction drops its own unstaged changes', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('join-unstaged');
		await Audited.put({ id: recordId, n: 1, items: ['a'] });
		const ctx = {};
		await transaction(ctx, async () => {
			const rec = await Audited.get(recordId, ctx);
			rec.set('n', 99);
			const captured = rec.items;
			captured.push('stale');
			const holder = await Audited.lock(recordId, undefined, ctx);
			holder.set('tag', 'locked');
			await holder.save();
			await rec.lock();
			assert.throws(() => captured.push('x'), isConflict);
			rec.set('label', 'joined');
			await rec.save();
		});
		const after = await Audited.get(recordId);
		assert.strictEqual(after.n, 1);
		assert.deepStrictEqual([...after.items], ['a']);
		assert.strictEqual(after.tag, 'locked');
		assert.strictEqual(after.label, 'joined');
	});

	it('an instance whose shared scoped lock another instance released can still write after its own unlock()', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('shared-scoped');
		await Audited.put({ id: recordId, n: 1 });
		const ctx = {};
		await transaction(ctx, async () => {
			const first = await Audited.lock(recordId, undefined, ctx);
			const second = await Audited.lock(recordId, undefined, ctx);
			assert.strictEqual(await second.unlock(), true);
			assert.strictEqual(await first.unlock(), false);
			first.addTo('n', 5);
			await first.save();
		});
		assert.strictEqual((await Audited.get(recordId)).n, 6);
	});

	it('unlock() discards changes made under a lock it abandons, scoped or held', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const idScoped = makeId('abandoned-scoped');
		const idHold = makeId('abandoned-hold');
		await Audited.put({ id: idScoped, n: 10, tag: 'init' });
		await Audited.put({ id: idHold, n: 10, tag: 'init' });

		const ctx = {};
		await transaction(ctx, async () => {
			const scoped = await Audited.lock(idScoped, undefined, ctx);
			scoped.set('tag', 'abandoned');
			await scoped.unlock();
			scoped.addTo('n', 5);
			await scoped.save();
		});
		const held = await Audited.lock(idHold, { hold: true, lease: 5000 });
		held.set('tag', 'abandoned');
		await held.unlock();
		held.addTo('n', 6);
		await held.save();

		const afterScoped = await Audited.get(idScoped);
		assert.strictEqual(afterScoped.n, 15);
		assert.strictEqual(afterScoped.tag, 'init');
		const afterHold = await Audited.get(idHold);
		assert.strictEqual(afterHold.n, 16);
		assert.strictEqual(afterHold.tag, 'init');
	});

	it('a nested array captured in changes that lock() or unlock() discards is refused', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const idLock = makeId('nested-lock');
		const idUnlock = makeId('nested-unlock');
		await Audited.put({ id: idLock, n: 1, items: ['a'] });
		await Audited.put({ id: idUnlock, n: 1, items: ['a'] });

		const rec = await Audited.get(idLock);
		const captured = rec.items;
		captured.push('b');
		await rec.lock({ hold: true, lease: 5000 });
		cleanups.push(() => rec.unlock());
		assert.throws(() => captured.push('c'), isConflict);
		rec.items.push('d');
		await rec.save();
		assert.deepStrictEqual([...(await Audited.get(idLock)).items], ['a', 'd']);

		const held = await Audited.lock(idUnlock, { hold: true, lease: 5000 });
		const items = held.items;
		items.push('b');
		await held.unlock();
		assert.throws(() => items.push('c'), isConflict);
		held.addTo('n', 1);
		await held.save();
		const after = await Audited.get(idUnlock);
		assert.strictEqual(after.n, 2);
		assert.deepStrictEqual([...after.items], ['a']);
	});
});
