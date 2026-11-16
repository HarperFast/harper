// A same-thread subscriber has no shared log cursor with the cross-thread broadcast. On RocksDB,
// the older transaction reserves its key before a newer transaction commits, so key-gated live
// delivery must not discard the older transaction after replay has advanced past the newer key.
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

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

describe('same-thread startTime replay handoff', () => {
	let tableSequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('delivers a lower-key commit that completes after replay passes a newer key', async () => {
		const T = table({
			table: `SubReplaySameThreadLateCommit${++tableSequence}`,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		const startTime = Date.now() - 10_000;
		// The production same-thread registry already has an active subscriber when a replay joins it.
		const opening = await T.subscribe({ omitCurrent: true, crossThreads: false });
		const older = stageHeldTransaction((context) => T.put('older', { name: 'older' }, context));
		let subscription;
		try {
			await older.isStaged;
			await T.put('newer', { name: 'newer' });
			subscription = await T.subscribe({ startTime, isCollection: true, crossThreads: false });
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => events.some((event) => event.id === 'newer'), { timeout: 5000 });
			await waitFor(() => subscription.replayedThrough > startTime, { timeout: 5000 });
			older.release();
			await older.committed;
			await T.put('sentinel', { name: 'sentinel' });
			await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
			await waitFor(() => events.some((event) => event.id === 'older'), { timeout: 2000 }).catch(() => {});
			assert.equal(
				events.filter((event) => event.id === 'older').length,
				1,
				`late lower-key commit was not delivered exactly once: ${JSON.stringify(events.map((event) => event.id))}`
			);
			assert.equal(events.filter((event) => event.id === 'newer').length, 1);
			assert.equal(events.filter((event) => event.id === 'sentinel').length, 1);
		} finally {
			older.release();
			await older.committed.catch(() => {});
			subscription?.end();
			opening.end();
		}
	});

	it('does not redeliver the triggering commit when a replay starts inside its listener', async () => {
		const T = table({
			table: `SubReplaySameThreadDispatch${++tableSequence}`,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		const startTime = Date.now() - 10_000;
		const events = [];
		let collectionSubPromise;
		const leaf = await T.subscribe({
			id: 'trigger',
			omitCurrent: true,
			crossThreads: false,
			listener(event) {
				if (event.id !== 'trigger' || collectionSubPromise) return;
				collectionSubPromise = T.subscribe({
					startTime,
					isCollection: true,
					crossThreads: false,
					listener: (replayedEvent) => events.push(replayedEvent),
				});
			},
		});
		let collection;
		try {
			await T.put('trigger', { name: 'trigger' });
			collection = await collectionSubPromise;
			await waitFor(() => events.some((event) => event.id === 'trigger'), { timeout: 5000 });
			await T.put('sentinel', { name: 'sentinel' });
			await waitFor(() => events.some((event) => event.id === 'sentinel'), { timeout: 5000 });
			assert.equal(
				events.filter((event) => event.id === 'trigger').length,
				1,
				`triggering commit was delivered more than once: ${JSON.stringify(events.map((event) => event.id))}`
			);
		} finally {
			collection?.end();
			leaf.end();
		}
	});
});
