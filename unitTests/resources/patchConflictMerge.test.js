require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Table patch conflict merging', () => {
	let PatchMergeTables;

	before(() => {
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
		const [{ Table: PatchMerge }] = PatchMergeTables;
		await PatchMerge.put('evicted-session', { id: 'evicted-session', lastActivity: 1 });
		await PatchMerge.delete('evicted-session');
		await PatchMerge.patch('evicted-session', { lastActivity: 2 });

		const saved = await PatchMerge.get('evicted-session');
		assert.equal(saved.lastActivity, 2);
		assert.equal(saved.terminated, undefined);
	});

	it('replaces an array field instead of merging its elements', async () => {
		const [{ Table: PatchMerge }] = PatchMergeTables;
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
