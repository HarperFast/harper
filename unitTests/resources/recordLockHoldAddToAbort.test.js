const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Record locks (QA-5083): { hold: true } cross-transaction staging and abort lifecycle', () => {
	let TestTable;
	let NoAuditTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TestTable = table({
			table: 'Qa5083HoldLockAuditTest',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'label' }],
		});
		NoAuditTable = table({
			table: 'Qa5083HoldLockNoAuditTest',
			database: 'test',
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'label' }],
		});
	});

	it('holder.addTo() on a { hold: true } lock acquired inside Transaction 1 remains deferred until explicit holder.save()', async function () {
		if (isLMDB) return this.skip();
		const recordId = 'hold-addto-defer';
		await TestTable.put({ id: recordId, n: 10, label: 'v0' });

		const ctx1 = {};
		let holder;
		try {
			await transaction(ctx1, async () => {
				await TestTable.put({ id: 'other-1', n: 1, label: 'txn1' }, ctx1);
				holder = await TestTable.lock(recordId, { hold: true, lease: 5000 }, ctx1);
				holder.addTo('n', 5);
				holder.set('label', 'deferred');
			});

			const afterTxn1 = await TestTable.get(recordId);
			assert.strictEqual(
				afterTxn1.n,
				10,
				'un-saved holder.addTo() on a { hold: true } lock must not auto-commit when the acquiring transaction commits'
			);
			assert.strictEqual(
				afterTxn1.label,
				'v0',
				'un-saved holder.set() alongside holder.addTo() on a { hold: true } lock must remain deferred until holder.save()'
			);

			await holder.save();
			const afterExplicitSave = await TestTable.get(recordId);
			assert.strictEqual(afterExplicitSave.n, 15);
			assert.strictEqual(afterExplicitSave.label, 'deferred');
		} finally {
			await holder?.unlock();
		}
	});

	it('holder.save() outside a transaction (ImmediateTransaction) persists after an earlier transaction staged an unsaved write on holder and aborted', async function () {
		if (isLMDB) return this.skip();
		const recordId = 'hold-abort-imm';
		await TestTable.put({ id: recordId, n: 10, label: 'v0' });

		const holder = await TestTable.lock(recordId, { hold: true, lease: 5000 });
		const ctx1 = holder.getContext();
		try {
			await assert.rejects(
				transaction(ctx1, async () => {
					await holder.update(recordId, { label: 'aborted' });
					throw new Error('abort-txn1');
				}),
				/abort-txn1/
			);

			const afterAbort = await TestTable.get(recordId);
			assert.strictEqual(afterAbort.n, 10);
			assert.strictEqual(afterAbort.label, 'v0');

			holder.set('n', 42);
			holder.set('label', 'saved-after-abort');
			await holder.save();

			const persisted = await TestTable.get(recordId);
			assert.strictEqual(
				persisted.n,
				42,
				'holder.save() via ImmediateTransaction after an aborted transaction must persist the new mutation'
			);
			assert.strictEqual(persisted.label, 'saved-after-abort');
		} finally {
			await holder.unlock();
		}
	});

	it('holder.save() inside a second explicit transaction (txn2) on an audit: false table persists after txn1 staged an unsaved write on holder and aborted', async function () {
		if (isLMDB) return this.skip();
		const recordId = 'hold-abort-txn2-noaudit';
		await NoAuditTable.put({ id: recordId, n: 100, label: 'v0' });

		const holder = await NoAuditTable.lock(recordId, { hold: true, lease: 5000 });
		const ctx = holder.getContext();
		try {
			await assert.rejects(
				transaction(ctx, async () => {
					await holder.update(recordId, { n: 200 });
					throw new Error('abort-txn1');
				}),
				/abort-txn1/
			);

			await transaction(ctx, async () => {
				holder.set('n', 300);
				await holder.save();
			});

			const persisted = await NoAuditTable.get(recordId);
			assert.strictEqual(
				persisted.n,
				300,
				'holder.save() inside txn2 on an audit: false table after txn1 aborted must not be dropped as an empty commit'
			);
		} finally {
			await holder.unlock();
		}
	});

	it('holder.save() inside a second explicit transaction (txn2) on an audit: true table after txn1 aborted tracks the write in txn2.writes so noteCommittedLockVersions updates holderVersionFloor', async function () {
		if (isLMDB) return this.skip();
		const recordId = 'hold-abort-txn2-floor';
		await TestTable.put({ id: recordId, n: 1, label: 'v0' });

		const holder = await TestTable.lock(recordId, { hold: true, lease: 5000 });
		const ctx = holder.getContext();
		const lockHandle = ctx.transaction.recordLockFor(TestTable.primaryStore, recordId);
		assert.ok(lockHandle, 'expected active RecordLockHandle for held lock');

		try {
			await assert.rejects(
				transaction(ctx, async () => {
					await holder.update(recordId, { n: 2 });
					throw new Error('abort-txn1');
				}),
				/abort-txn1/
			);

			await transaction(ctx, async () => {
				holder.set('n', 3);
				await holder.save();
			});

			const persisted = await TestTable.get(recordId);
			assert.strictEqual(persisted.n, 3);

			const committedEntry = TestTable.primaryStore.getEntry(recordId);
			assert.ok(
				lockHandle.holderVersionFloor() > committedEntry.version,
				`expected holderVersionFloor (${lockHandle.holderVersionFloor()}) to advance above committed version (${committedEntry.version}) via noteCommittedLockVersions`
			);
		} finally {
			await holder.unlock();
		}
	});
});
