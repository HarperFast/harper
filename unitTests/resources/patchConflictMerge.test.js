require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Table patch conflict merging', () => {
	let PatchMerge;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		PatchMerge = table({
			table: 'PatchConflictMerge',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'lastActivity' },
				{ name: 'terminated' },
				{ name: 'subscriptions' },
			],
		});
	});

	it('preserves a concurrently committed field when retrying a stale patch', async () => {
		await PatchMerge.put('session', { id: 'session', lastActivity: 1 });
		let releaseStale;
		let staleReadComplete;
		const staleRead = new Promise((resolve) => (staleReadComplete = resolve));
		const staleRelease = new Promise((resolve) => (releaseStale = resolve));
		const context = {};
		const stalePatch = transaction(context, async () => {
			await PatchMerge.get('session', context);
			staleReadComplete();
			await staleRelease;
			await PatchMerge.patch('session', { lastActivity: 2 }, context);
		});

		await staleRead;
		await PatchMerge.patch('session', { terminated: true });
		releaseStale();
		await stalePatch;

		const saved = await PatchMerge.get('session');
		assert.equal(saved.lastActivity, 2);
		assert.equal(saved.terminated, true);
	});

	it('creates a partial record when patching a deleted key', async () => {
		await PatchMerge.put('evicted-session', { id: 'evicted-session', lastActivity: 1 });
		await PatchMerge.delete('evicted-session');
		await PatchMerge.patch('evicted-session', { lastActivity: 2 });

		const saved = await PatchMerge.get('evicted-session');
		assert.equal(saved.lastActivity, 2);
		assert.equal(saved.terminated, undefined);
	});

	it('replaces an array field instead of merging its elements', async () => {
		await PatchMerge.put('subscriptions', { id: 'subscriptions', subscriptions: ['first', 'second'] });
		await PatchMerge.patch('subscriptions', { subscriptions: ['second'] });
		const saved = await PatchMerge.get('subscriptions');
		assert.deepEqual(saved.subscriptions, ['second']);
	});
});
