const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const SKIP_ON_LMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// harper#3896
describe('Record locks: same-instance pre-lock staging, post-lock mutations, and unlock lifecycle', function () {
	this.timeout(10000);
	let Audited;
	let Unaudited;
	let nextId = 1;
	const makeId = (prefix) => `${prefix}-${nextId++}`;
	const cleanups = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Audited = table({
			table: 'RecordLockSameInstanceAudited',
			database: 'record_lock_same_instance_pre_lock',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'label' },
				{ name: 'tag' },
				{ name: 'profile' },
			],
		});
		Audited.loadAsInstance = true;
		Audited.getReturnMutable = true;
		Unaudited = table({
			table: 'RecordLockSameInstanceUnaudited',
			database: 'record_lock_same_instance_pre_lock',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'label' }, { name: 'tag' }],
		});
		Unaudited.loadAsInstance = true;
		Unaudited.getReturnMutable = true;
	});

	afterEach(async function () {
		while (cleanups.length) {
			try {
				await cleanups.pop()();
			} catch {
				// Ignore cleanup errors if already unlocked
			}
		}
	});

	after(async function () {
		await resetDatabases();
	});

	it('LMDB 501 lock contract with ordinary same-instance save, and RocksDB two-instance static update before lock', async function () {
		const recordId = makeId('pos-ctrl');
		await Audited.put({ id: recordId, n: 10, label: 'v0', tag: 'init' });

		if (SKIP_ON_LMDB) {
			await assert.rejects(
				() => Audited.lock(recordId),
				(err) => Boolean(err && err.statusCode === 501),
				'Expected Table.lock(id) on LMDB to reject with statusCode 501'
			);
			const existing = await Audited.get(recordId);
			await assert.rejects(
				() => existing.lock(),
				(err) => Boolean(err && err.statusCode === 501),
				'Expected instance.lock() on LMDB to reject with statusCode 501'
			);

			const ctx = {};
			await transaction(ctx, async () => {
				const rec = await Audited.get(recordId, ctx);
				rec.addTo('n', 5);
				rec.set('label', 'lmdb-ok');
				await rec.save();
			});

			const afterLmdb = await Audited.get(recordId);
			assert.strictEqual(afterLmdb.n, 15);
			assert.strictEqual(afterLmdb.label, 'lmdb-ok');
			assert.strictEqual(afterLmdb.tag, 'init');
			return;
		}

		const ctx = {};
		await transaction(ctx, async () => {
			await Audited.update(recordId, { n: 20, label: 'static-pre' }, ctx);
			const locked = await Audited.lock(recordId, undefined, ctx);
			locked.set('tag', 'locked-post');
			await locked.save();
		});

		const afterRocks = await Audited.get(recordId);
		assert.strictEqual(afterRocks.n, 20);
		assert.strictEqual(afterRocks.label, 'static-pre');
		assert.strictEqual(afterRocks.tag, 'locked-post');
	});

	it('Same-instance lazy staging via addTo() or update(id, undefined) before instance.lock() preserves pre-lock and post-lock mutations across audit modes', async function () {
		if (SKIP_ON_LMDB) return this.skip();

		const id1 = makeId('arm1-audited');
		const id2 = makeId('arm1-unaudited');
		await Audited.put({ id: id1, n: 10, label: 'v0', tag: 'init' });
		await Unaudited.put({ id: id2, n: 100, label: 'v0', tag: 'init' });

		const ctx1 = {};
		await transaction(ctx1, async () => {
			const rec1 = await Audited.get(id1, ctx1);
			rec1.addTo('n', 5);
			rec1.set('label', 'pre-addto');
			await rec1.lock();
			rec1.set('tag', 'post-lock');
			await rec1.save();
		});

		const ctx2 = {};
		await transaction(ctx2, async () => {
			const rec2 = await Unaudited.update(id2, undefined, ctx2);
			rec2.set('label', 'pre-update-undef');
			rec2.addTo('n', 25);
			await rec2.lock();
			rec2.set('tag', 'post-lock-2');
			await rec2.save();
		});

		const after1 = await Audited.get(id1);
		const after2 = await Unaudited.get(id2);

		assert.strictEqual(
			after1.n,
			15,
			`Expected pre-lock rec1.addTo('n', 5) before rec1.lock() on audit:true table to persist n=15, got n=${after1.n}`
		);
		assert.strictEqual(
			after1.label,
			'pre-addto',
			`Expected pre-lock rec1.set('label', 'pre-addto') before rec1.lock() on audit:true table to persist, got label=${after1.label}`
		);
		assert.strictEqual(after1.tag, 'post-lock');
		assert.strictEqual(
			after2.n,
			125,
			`Expected pre-lock rec2.addTo('n', 25) after Unaudited.update(id2, undefined) and before rec2.lock() to persist n=125, got n=${after2.n}`
		);
		assert.strictEqual(
			after2.label,
			'pre-update-undef',
			`Expected pre-lock rec2.set('label', 'pre-update-undef') before rec2.lock() on audit:false table to persist, got label=${after2.label}`
		);
		assert.strictEqual(after2.tag, 'post-lock-2');
	});

	it('Same-instance update(id, { ... }) before instance.lock() or instance.lock({ hold: true }) persists post-lock mutations and allows sequential held saves', async function () {
		if (SKIP_ON_LMDB) return this.skip();

		const idScopedAudit = makeId('arm2-scoped-audit');
		const idScopedNoAudit = makeId('arm2-scoped-noaudit');
		const idHold = makeId('arm2-hold-audit');
		await Audited.put({ id: idScopedAudit, n: 10, label: 'v0', tag: 'init' });
		await Unaudited.put({ id: idScopedNoAudit, n: 10, label: 'v0', tag: 'init' });
		await Audited.put({ id: idHold, n: 10, label: 'v0', tag: 'init' });

		const ctx = {};
		await transaction(ctx, async () => {
			const recA = await Audited.update(idScopedAudit, { label: 'pre-scoped' }, ctx);
			await recA.lock();
			recA.set('tag', 'post-scoped');
			recA.addTo('n', 7);
			await recA.save();

			const recU = await Unaudited.update(idScopedNoAudit, { label: 'pre-scoped-u' }, ctx);
			await recU.lock();
			recU.set('tag', 'post-scoped-u');
			recU.addTo('n', 9);
			await recU.save();
		});

		const afterScopedA = await Audited.get(idScopedAudit);
		const afterScopedU = await Unaudited.get(idScopedNoAudit);

		const holder = await Audited.get(idHold);
		await holder.update({ label: 'pre-hold' });
		await holder.lock({ hold: true, lease: 5000 });
		cleanups.push(() => holder.unlock());
		holder.set('tag', 'post-hold-1');
		await holder.save();

		const afterSave1 = await Audited.get(idHold);

		let secondSaveErr;
		try {
			holder.set('n', 99);
			await holder.save();
		} catch (err) {
			secondSaveErr = err;
		}
		const afterSave2 = await Audited.get(idHold);

		assert.strictEqual(afterScopedA.label, 'pre-scoped');
		assert.strictEqual(
			afterScopedA.tag,
			'post-scoped',
			`Expected post-lock recA.set('tag', 'post-scoped') after pre-lock Audited.update(id, { ... }) to persist, got tag=${afterScopedA.tag}`
		);
		assert.strictEqual(
			afterScopedA.n,
			17,
			`Expected post-lock recA.addTo('n', 7) after pre-lock Audited.update(id, { ... }) to persist n=17, got n=${afterScopedA.n}`
		);

		assert.strictEqual(afterScopedU.label, 'pre-scoped-u');
		assert.strictEqual(
			afterScopedU.tag,
			'post-scoped-u',
			`Expected post-lock recU.set('tag', 'post-scoped-u') after pre-lock Unaudited.update(id, { ... }) to persist, got tag=${afterScopedU.tag}`
		);
		assert.strictEqual(
			afterScopedU.n,
			19,
			`Expected post-lock recU.addTo('n', 9) after pre-lock Unaudited.update(id, { ... }) to persist n=19, got n=${afterScopedU.n}`
		);

		assert.strictEqual(afterSave1.label, 'pre-hold');
		assert.strictEqual(
			afterSave1.tag,
			'post-hold-1',
			`Expected first holder.save() under { hold: true } after pre-lock update(id, { ... }) to persist post-lock tag='post-hold-1', got tag=${afterSave1.tag}`
		);
		assert.strictEqual(
			secondSaveErr,
			undefined,
			`Expected second mutation and holder.save() under { hold: true } to succeed without 409, got ${secondSaveErr?.message}`
		);
		assert.strictEqual(afterSave2.n, 99);
		assert.strictEqual(afterSave2.tag, 'post-hold-1');
	});

	it('instance.unlock() preserves pre-lock staged write on lockJoined operation and clears abandoned post-lock #changes on unsaved lock writes', async function () {
		if (SKIP_ON_LMDB) return this.skip();

		const idJoined = makeId('arm3-joined');
		const idAbandonedScoped = makeId('arm3-abandoned-scoped');
		const idAbandonedHold = makeId('arm3-abandoned-hold');
		await Audited.put({ id: idJoined, n: 10, label: 'v0', tag: 'init' });
		await Audited.put({ id: idAbandonedScoped, n: 10, label: 'v0', tag: 'init' });
		await Audited.put({ id: idAbandonedHold, n: 10, label: 'v0', tag: 'init' });

		const recJoined = await Audited.get(idJoined);
		await recJoined.update({ n: 25, label: 'pre-lock-kept' });
		await recJoined.lock();
		await recJoined.unlock();
		await recJoined.save();
		const afterJoined = await Audited.get(idJoined);

		const ctxS = {};
		await transaction(ctxS, async () => {
			const s = await Audited.lock(idAbandonedScoped, undefined, ctxS);
			s.set('tag', 'abandoned-scoped');
			await s.unlock();
			s.addTo('n', 5);
			await s.save();
		});
		const afterAbandonedScoped = await Audited.get(idAbandonedScoped);

		const h = await Audited.lock(idAbandonedHold, { hold: true, lease: 5000 });
		h.set('tag', 'abandoned-hold');
		await h.unlock();
		h.addTo('n', 6);
		await h.save();
		const afterAbandonedHold = await Audited.get(idAbandonedHold);

		assert.strictEqual(
			afterJoined.n,
			25,
			`Expected pre-lock Audited.update(idJoined, { n: 25 }) to remain staged across lock() + unlock() and commit on recJoined.save(), got n=${afterJoined.n}`
		);
		assert.strictEqual(
			afterJoined.label,
			'pre-lock-kept',
			`Expected pre-lock Audited.update(idJoined, { label: 'pre-lock-kept' }) to remain staged across lock() + unlock(), got label=${afterJoined.label}`
		);

		assert.strictEqual(afterAbandonedScoped.n, 15);
		assert.strictEqual(
			afterAbandonedScoped.tag,
			'init',
			`Expected s.unlock() on an unsaved scoped lock to discard abandoned s.set('tag', 'abandoned-scoped'), got tag=${afterAbandonedScoped.tag}`
		);

		assert.strictEqual(afterAbandonedHold.n, 16);
		assert.strictEqual(
			afterAbandonedHold.tag,
			'init',
			`Expected h.unlock() on an unsaved { hold: true } lock to discard abandoned h.set('tag', 'abandoned-hold'), got tag=${afterAbandonedHold.tag}`
		);
	});

	it('a nested object tracked before lock() stays writable under the lock', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('nested');
		await Audited.put({ id: recordId, n: 1, profile: { city: 'a', zip: '1' } });
		const rec = await Audited.get(recordId);
		rec.update();
		const profile = rec.profile;
		profile.city = 'b';
		await rec.lock({ hold: true, lease: 5000 });
		cleanups.push(() => rec.unlock());
		profile.zip = '2';
		await rec.save();
		const after = await Audited.get(recordId);
		assert.strictEqual(after.profile.city, 'b');
		assert.strictEqual(after.profile.zip, '2');
	});

	it('a joined write kept by unlock() still closes the instance once saved', async function () {
		if (SKIP_ON_LMDB) return this.skip();
		const recordId = makeId('closed-after-unlock');
		await Audited.put({ id: recordId, n: 1 });
		const rec = await Audited.get(recordId);
		await rec.update({ n: 5 });
		await rec.lock();
		await rec.unlock();
		await rec.save();
		assert.strictEqual((await Audited.get(recordId)).n, 5);
		assert.throws(
			() => rec.set('n', 6),
			(err) => err.statusCode === 409
		);
	});
});
