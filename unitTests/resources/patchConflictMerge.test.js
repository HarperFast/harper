require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Table patch conflict merging', () => {
	let PatchMergeTables;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		PatchMergeTables = [false, true].map((audit) => ({
			audit,
			Table: table({
				table: `PatchConflictMerge${audit ? 'Audited' : 'Unaudited'}`,
				database: 'test',
				audit,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'lastActivity' },
					{ name: 'terminated' },
					{ name: 'subscriptions' },
					{ name: 'user' },
					{ name: 'expiresAt', expiresAt: true, indexed: true },
				],
			}),
		}));
		await Promise.all(PatchMergeTables.map(({ Table }) => Table.indexingOperation));
	});

	it('preserves a concurrently committed field when retrying a stale patch', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `session-${audit}`;
			await Table.put(id, { id, lastActivity: 1 });
			let releaseStale;
			let staleReadComplete;
			const staleRead = new Promise((resolve) => (staleReadComplete = resolve));
			const staleRelease = new Promise((resolve) => (releaseStale = resolve));
			const context = {};
			const stalePatch = transaction(context, async () => {
				await Table.get(id, context);
				staleReadComplete();
				await staleRelease;
				await Table.patch(id, { lastActivity: 2 }, context);
			});

			await staleRead;
			await Table.patch(id, { terminated: true });
			releaseStale();
			await stalePatch;

			const saved = await Table.get(id);
			assert.equal(saved.lastActivity, 2);
			assert.equal(saved.terminated, true);
		}
	});

	it('creates a partial record when patching a deleted key', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `evicted-session-${audit}`;
			await Table.put(id, { id, lastActivity: 1 });
			await Table.delete(id);
			await Table.patch(id, { lastActivity: 2 });

			const saved = await Table.get(id);
			assert.equal(saved.lastActivity, 2);
			assert.equal(saved.terminated, undefined);
		}
	});

	it('patches an existing record when ifExists is set', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `conditional-existing-${audit}`;
			await Table.put(id, { id, lastActivity: 1 });
			await Table.patch(id, { lastActivity: 2 }, { ifExists: true });
			assert.equal((await Table.get(id)).lastActivity, 2);
		}
	});

	it('does not create a missing or deleted record when ifExists is set', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const missingId = `conditional-missing-${audit}`;
			const deletedId = `conditional-deleted-${audit}`;
			await Table.put(deletedId, { id: deletedId, lastActivity: 1 });
			await Table.delete(deletedId);
			const auditEntriesBefore = audit ? [...Table.auditStore.getRange({ start: 1 })].length : undefined;

			await Table.patch(missingId, { lastActivity: 2 }, { ifExists: true });
			await Table.patch(deletedId, { lastActivity: 2 }, { ifExists: true });

			assert.equal(await Table.get(missingId), undefined);
			assert.equal(await Table.get(deletedId), undefined);
			if (audit) assert.equal([...Table.auditStore.getRange({ start: 1 })].length, auditEntriesBefore);
		}
	});

	it('does not leak ifExists to a later patch using the same context', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const skippedId = `conditional-consumed-${audit}`;
			const upsertedId = `conditional-upsert-${audit}`;
			const context = { ifExists: true };
			await Table.patch(skippedId, { lastActivity: 1 }, context);
			assert.equal(context.ifExists, undefined);
			await Table.patch(upsertedId, { lastActivity: 2 }, context);

			assert.equal(await Table.get(skippedId), undefined);
			assert.equal((await Table.get(upsertedId)).lastActivity, 2);
		}
	});

	it('does not patch a record deleted earlier in the same transaction', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `conditional-staged-delete-${audit}`;
			await Table.put(id, { id, lastActivity: 1 });
			const context = {};
			await transaction(context, async () => {
				await Table.delete(id, context);
				context.ifExists = true;
				await Table.patch(id, { lastActivity: 2 }, context);
			});
			assert.equal(await Table.get(id), undefined);
		}
	});

	it('does not retry a stale conditional patch over a concurrent delete', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `conditional-retry-delete-${audit}`;
			await Table.put(id, { id, lastActivity: 1 });
			let releaseStale;
			let staleReadComplete;
			const staleRead = new Promise((resolve) => (staleReadComplete = resolve));
			const staleRelease = new Promise((resolve) => (releaseStale = resolve));
			const context = { ifExists: true };
			const stalePatch = transaction(context, async () => {
				await Table.get(id, context);
				staleReadComplete();
				await staleRelease;
				await Table.patch(id, { lastActivity: 2 }, context);
			});

			await staleRead;
			await Table.delete(id);
			releaseStale();
			await stalePatch;
			assert.equal(await Table.get(id), undefined);
		}
	});

	it('replaces an array field instead of merging its elements', async () => {
		const { Table: PatchMerge } = PatchMergeTables.find(({ audit }) => !audit);
		await PatchMerge.put('subscriptions', { id: 'subscriptions', subscriptions: ['first', 'second'] });
		await PatchMerge.patch('subscriptions', { subscriptions: ['second'] });
		const saved = await PatchMerge.get('subscriptions');
		assert.deepEqual(saved.subscriptions, ['second']);
	});

	it('removes a declared attribute when patching it to undefined', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `scrub-${audit}`;
			await Table.put(id, { id, user: 'alice' });
			await Table.patch(id, { user: undefined });
			assert.equal((await Table.get(id)).user, undefined);
		}
	});

	it('uses a per-record expiresAt value instead of the table default', async () => {
		for (const { audit, Table } of PatchMergeTables) {
			const id = `expires-${audit}`;
			const expiresAt = Date.now() + 60_000;
			await Table.put(id, { id, expiresAt });
			await Table.primaryStore.committed;
			assert.equal(Table.primaryStore.getEntry(id).expiresAt, expiresAt);
		}
	});
});
