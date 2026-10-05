// What a new subscriber receives is bounded by when it registered: messages committed before it are not
// delivered (history comes only from an explicit startTime/previousCount request), and a delete reaches a
// current-state subscriber only while that record's current state is deleted.
require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Subscription registration boundary', () => {
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
	let BoundaryTable, sibling;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		BoundaryTable = table({ table: 'SubBoundary', database: 'subBoundary', attributes, audit: true });
		// keeps the broadcaster active, so a new subscriber registers while notifications are in flight
		sibling = await BoundaryTable.subscribe({ isCollection: true, omitCurrent: true });
		sibling.on('data', () => {});
	});
	after(() => sibling?.end());

	for (const omitCurrent of [true, false]) {
		it(`does not deliver a message published before registering (omitCurrent: ${omitCurrent})`, async () => {
			// not awaited past the commit: its notification is still pending when the subscriber registers
			await BoundaryTable.publish('topic-before', { name: 'before' });
			const subscription = await BoundaryTable.subscribe({ isCollection: true, omitCurrent });
			try {
				const events = [];
				subscription.on('data', (event) => events.push(event));
				await BoundaryTable.publish('topic-after', { name: 'after' });
				await waitFor(() => events.some((event) => event.id === 'topic-after'));
				const messages = events.filter((event) => event.type === 'message').map((event) => event.id);
				assert.deepEqual(messages, ['topic-after'], 'a message from before the subscription was delivered');
			} finally {
				subscription.end();
			}
		});
	}

	it('replays earlier messages for an explicit startTime', async () => {
		const startTime = Date.now() - 1;
		await BoundaryTable.publish('topic-history', { name: 'history' });
		const subscription = await BoundaryTable.subscribe({ isCollection: true, startTime });
		try {
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => events.some((event) => event.id === 'topic-history'));
		} finally {
			subscription.end();
		}
	});

	it('delivers a delete only while the record is deleted', async () => {
		// deleted and re-created just before registering: the delete's notification is stale
		await BoundaryTable.put('recreated', { name: 'v1' });
		await BoundaryTable.delete('recreated');
		await BoundaryTable.put('recreated', { name: 'v2' });
		// deleted just before registering and still deleted
		await BoundaryTable.put('gone', { name: 'v1' });
		await BoundaryTable.delete('gone');
		const subscription = await BoundaryTable.subscribe({ isCollection: true });
		try {
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await BoundaryTable.put('marker', { name: 'marker' });
			await waitFor(() => events.some((event) => event.id === 'marker'));
			for (const event of events) {
				if (event.type !== 'delete') continue;
				assert.equal(
					await BoundaryTable.get(event.id),
					undefined,
					`a delete was delivered for ${event.id}, which exists`
				);
			}
			const recreated = events.filter((event) => event.id === 'recreated');
			assert.deepEqual(
				recreated.map((event) => [event.type, event.value?.name]),
				[['put', 'v2']],
				'the re-created record must arrive as its current value only'
			);
		} finally {
			subscription.end();
		}
	});
});
