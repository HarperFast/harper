const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

describe('Subscription current-entry reads', () => {
	let T;
	const subscriptions = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			database: 'entryreadbase',
			table: 'EntryRead',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	});
	after(() => {
		for (const subscription of subscriptions.splice(0)) subscription.end();
	});

	async function subscribe(count) {
		const received = [];
		for (let i = 0; i < count; i++) {
			const events = [];
			received.push(events);
			subscriptions.push(await T.subscribe({ id: 'A', listener: (event) => events.push(event) }));
		}
		return received;
	}

	async function readsOfA(update) {
		const store = T.primaryStore;
		const getEntry = store.getEntry;
		let reads = 0;
		store.getEntry = function (id, options) {
			if (id === 'A') reads++;
			return getEntry.call(this, id, options);
		};
		try {
			await update();
		} finally {
			store.getEntry = getEntry;
		}
		return reads;
	}

	it('reads the record once per update, however many subscribers share it', async () => {
		await T.put('A', { value: 1 });
		const first = await subscribe(1);
		const readsWithOne = await readsOfA(async () => {
			await T.put('A', { value: 2 });
			await waitFor(() => first[0].some((event) => event.value?.value === 2));
		});

		const rest = await subscribe(19);
		const all = [...first, ...rest];
		const readsWithTwenty = await readsOfA(async () => {
			await T.put('A', { value: 3 });
			await waitFor(() => all.every((events) => events.some((event) => event.value?.value === 3)));
		});

		for (const events of all) {
			const latest = events.at(-1);
			assert.strictEqual(latest.type, 'put');
			assert.strictEqual(latest.value.value, 3);
		}
		assert.strictEqual(readsWithTwenty, readsWithOne);
	});
});
