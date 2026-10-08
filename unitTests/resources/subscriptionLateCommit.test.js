// A collection current-state subscription must not use the newest record time its scan saw as a
// delivery boundary: writes to records the scan already passed, messages, and transactions older than
// a scanned record that commit after the scan all fall at or below it (harper#2933). A transaction
// whose body awaits stands in for one that commits late, which concurrent commit threads make routine.
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

function stageHeldTransaction(write) {
	let release;
	const mayCommit = new Promise((resolve) => (release = resolve));
	let staged;
	const isStaged = new Promise((resolve) => (staged = resolve));
	const context = {};
	const committed = transaction(context, async () => {
		await write(context);
		staged();
		await mayCommit;
	});
	return { isStaged, release, committed };
}

describe('Current-state subscription delivery boundary', () => {
	let LateTable;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		LateTable = table({
			table: 'SubLateCommit',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
	});

	it('delivers an older transaction that commits after the scan saw a newer one', async () => {
		const older = stageHeldTransaction((context) => LateTable.put('older', { name: 'older' }, context));
		let subscription;
		try {
			await older.isStaged;
			await LateTable.put('newer', { name: 'newer' });
			subscription = await LateTable.subscribe({ isCollection: true });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => events.some((event) => event.id === 'newer'));
			older.release();
			await older.committed;
			await waitFor(() => events.some((event) => event.id === 'older'), { timeout: 2000 }).catch(() => {});
			assert.ok(
				events.some((event) => event.id === 'older'),
				`the older transaction's write was never delivered: ${JSON.stringify(events.map((e) => e.id))}`
			);
		} finally {
			older.release();
			subscription?.end();
		}
	});

	it('delivers a message from a transaction older than a record the scan saw', async () => {
		const older = stageHeldTransaction((context) => LateTable.publish('topic', { name: 'message' }, context));
		let subscription;
		try {
			await older.isStaged;
			await LateTable.put('newer-than-message', { name: 'newer' });
			subscription = await LateTable.subscribe({ isCollection: true });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => events.some((event) => event.id === 'newer-than-message'));
			older.release();
			await older.committed;
			await waitFor(() => events.some((event) => event.type === 'message'), { timeout: 2000 }).catch(() => {});
			assert.ok(
				events.some((event) => event.id === 'topic' && event.type === 'message'),
				`the message was never delivered: ${JSON.stringify(events.map((e) => [e.id, e.type]))}`
			);
		} finally {
			older.release();
			subscription?.end();
		}
	});

	it('does not replay writes made while the database had no subscribers', async function () {
		// LMDB's broadcast cursor resumes from its last transaction time instead
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const IdleTable = table({
			table: 'SubIdleBacklog',
			database: 'subIdleBacklog',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		const first = await IdleTable.subscribe({ isCollection: true, omitCurrent: true });
		const firstEvents = [];
		first.on('data', (event) => firstEvents.push(event));
		await IdleTable.put('before', { name: 'before' });
		// the broadcaster has dispatched everything committed so far, so ending leaves no pass pending
		await waitFor(() => firstEvents.some((event) => event.id === 'before'));
		first.end();
		for (let i = 0; i < 20; i++) await IdleTable.put(i, { name: 'idle' + i });

		const subscription = await IdleTable.subscribe({ isCollection: true, omitCurrent: true });
		try {
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await IdleTable.put('live', { name: 'live' });
			await waitFor(() => events.some((event) => event.id === 'live'));
			assert.deepEqual(
				events.map((event) => event.id),
				['live'],
				'a new subscriber received writes made before it subscribed'
			);
		} finally {
			subscription.end();
		}
	});
});
