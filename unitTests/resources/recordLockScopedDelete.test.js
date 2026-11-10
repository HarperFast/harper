const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { INVALIDATED } = require('#src/resources/Table');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

function makeContext() {
	return { user: { username: 'admin', role: { permission: { super_user: true } } } };
}

// harper#3902: a scoped holder's explicit delete() is a caller write, so neither an early unlock() nor a
// scoped -> hold upgrade discards it with the scoped lock's placeholder
describe('An explicit delete() made under a scoped lock', function () {
	let Locked;
	let nextId = 1;
	const holders = [];

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Locked = table({
			table: 'ScopedDeleteLocked',
			database: 'scoped_delete_locked',
			audit: true,
			replicate: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'String' },
				{ name: 'n', type: 'Int', indexed: true },
			],
		});
	});

	afterEach(async () => {
		while (holders.length) {
			try {
				await holders.pop().unlock();
			} catch {}
		}
	});

	after(async () => {
		await resetDatabases();
	});

	async function indexedKeys(n) {
		const keys = [];
		for await (const record of Locked.search({ conditions: [{ attribute: 'n', value: n }] })) keys.push(record.id);
		return keys;
	}

	async function seeded() {
		const key = `scoped-delete-${nextId++}`;
		await Locked.put(key, { id: key, n: 1 });
		return key;
	}

	it('survives an early unlock()', async function () {
		if (isLMDB) return this.skip();
		const key = await seeded();
		const ctx = makeContext();
		await transaction(ctx, async () => {
			const locked = await Locked.lock(key, {}, ctx);
			await locked.delete();
			assert.equal(await locked.unlock(), true);
		});
		assert.equal(await Locked.get(key), undefined, 'the delete commits as an ordinary write');
	});

	it('survives an early unlock() without keeping the changes the lock abandoned', async function () {
		if (isLMDB) return this.skip();
		const key = await seeded();
		const ctx = makeContext();
		await transaction(ctx, async () => {
			const locked = await Locked.lock(key, {}, ctx);
			locked.set('n', 5);
			await locked.delete();
			await locked.unlock();
		});
		assert.equal(await Locked.get(key), undefined, 'the placeholder update does not resurrect the record');
		assert.ok(!(await indexedKeys(1)).includes(key), 'the deleted value left the index');
		assert.ok(!(await indexedKeys(5)).includes(key), 'the abandoned change never reached it');
	});

	for (const [upgrade, through] of [
		['the locked instance', (locked) => locked.lock({ hold: true, lease: 10000 })],
		['a static re-lock', (_locked, key, ctx) => Locked.lock(key, { hold: true, lease: 10000 }, ctx)],
	]) {
		it(`survives a scoped -> hold upgrade through ${upgrade}, released after commit`, async function () {
			if (isLMDB) return this.skip();
			const key = await seeded();
			const ctx = makeContext();
			let holder;
			await transaction(ctx, async () => {
				const locked = await Locked.lock(key, {}, ctx);
				locked.set('n', 5);
				await locked.delete();
				holder = await through(locked, key, ctx);
				holders.push(holder);
				assert.equal(holder.getContext().transaction.recordLockFor(Locked.primaryStore, key)?.hold, true);
			});
			assert.equal(await Locked.get(key), undefined, 'the delete commits with the scope');
			await holder.unlock();
			assert.equal(await Locked.get(key), undefined, 'releasing the hold does not bring the record back');
		});
	}

	for (const [ending, end] of [
		['an early unlock()', (locked) => locked.unlock()],
		[
			'a scoped -> hold upgrade',
			(locked) => locked.lock({ hold: true, lease: 10000 }).then((holder) => holders.push(holder)),
		],
	]) {
		it(`keeps an explicit invalidate() across ${ending}`, async function () {
			if (isLMDB) return this.skip();
			const key = await seeded();
			const ctx = makeContext();
			await transaction(ctx, async () => {
				const locked = await Locked.lock(key, {}, ctx);
				await locked.invalidate();
				await end(locked);
			});
			assert.ok(Locked.primaryStore.getEntry(key).metadataFlags & INVALIDATED, 'the invalidation commits');
		});
	}

	it('is refused, not dropped, when unlock() comes after the lease lapsed', async function () {
		if (isLMDB) return this.skip();
		const key = await seeded();
		const ctx = makeContext();
		await assert.rejects(
			transaction(ctx, async () => {
				const locked = await Locked.lock(key, {}, ctx);
				await locked.delete();
				Locked._txnForContext(ctx).recordLockFor(Locked.primaryStore, key).revokeLease();
				await locked.unlock();
			}),
			(err) => err?.statusCode === 409
		);
		assert.equal((await Locked.get(key))?.n, 1, 'a delete made under a lapsed lock does not land');
	});
});
