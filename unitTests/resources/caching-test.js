require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Resource } = require('../../resources/Resource');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
// might want to enable an iteration with NATS being assigned as a source
const {
	setNATSReplicator,
	setPublishToStream,
	publishToStream,
	setSubscription,
} = require('../../server/nats/natsReplicator');
describe('Caching', () => {
	let CachingTable,
		IndexedCachingTable,
		source_requests = 0;
	let events = [];
	let timer = 0;
	let return_value = true;
	let return_error;
	let natsPublishToStream = publishToStream;
	let natsSetSubscription = setSubscription;
	let published_messages = [];
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		CachingTable = table({
			table: 'CachingTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		IndexedCachingTable = table({
			table: 'IndexedCachingTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		class Source extends Resource {
			get() {
				return new Promise((resolve, reject) => {
					setTimeout(() => {
						source_requests++;
						if (return_error) reject(new Error('test source error'));
						resolve(
							return_value && {
								id: this.getId(),
								name: 'name ' + this.getId(),
							}
						);
					}, timer);
				});
			}
		}
		setPublishToStream(
			(subject, stream, header, message) => {
				published_messages.push(message);
			},
			() => {}
		);
		setNATSReplicator('CachingTable', 'test', CachingTable);

		CachingTable.sourcedFrom({
			get(id) {
				return new Promise((resolve) => {
					source_requests++;
					setTimeout(() => {
						resolve(
							return_value && {
								id,
								name: 'name ' + id,
							}
						);
					}, timer);
				});
			},
		});
		//setNATSReplicator('IndexedCachingTable', 'test', IndexedCachingTable);
		IndexedCachingTable.sourcedFrom(Source);
		let subscription = await CachingTable.subscribe({});

		subscription.on('data', (event) => {
			events.push(event);
		});
	});
	after(() => {
		setPublishToStream(natsPublishToStream, natsSetSubscription); // restore
	});
	it('Can load cached data', async function () {
		source_requests = 0;
		events = [];
		CachingTable.setTTLExpiration(0.008);
		await CachingTable.invalidate(23);
		let result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 1);
		result = await CachingTable.get(23);
		assert.equal(result.wasLoadedFromSource(), false);
		assert.equal(result.id, 23);
		assert.equal(source_requests, 1);
		// let it expire
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 2);
		assert(published_messages.length >= 2);
		for (let message of published_messages) {
			assert.equal(message.hash_values[0], 23);
			assert.equal(message.table, 'CachingTable');
		}
		assert(published_messages[1].expiresAt > 1);
		assert(published_messages[1].records[0].name, 'name 23');
		if (events.length > 0) console.log(events);
		//assert.equal(events.length, 0);
	});

	it('Cache stampede is handled', async function () {
		try {
			CachingTable.setTTLExpiration(0.01);
			await new Promise((resolve) => setTimeout(resolve, 15));
			CachingTable.setTTLExpiration(40);
			await new Promise((resolve) => setTimeout(resolve, 5));
			source_requests = 0;
			events = [];
			timer = 10;
			CachingTable.get(23);
			while (source_requests === 0) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await CachingTable.primaryStore.committed; // wait for the record to update to updating status
			CachingTable.get(23);
			let result = await CachingTable.get(23);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert(source_requests <= 1);
		} finally {
			timer = 0;
		}
	});
	it('Cache invalidation triggers updates', async function () {
		CachingTable.setTTLExpiration(0.005);
		await new Promise((resolve) => setTimeout(resolve, 10));
		CachingTable.setTTLExpiration(50);
		let result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		source_requests = 0;
		events = [];
		result.invalidate();
		await new Promise((resolve) => setTimeout(resolve, 20));
		result = await CachingTable.get(23);
		assert.equal(result.wasLoadedFromSource(), true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(result.id, 23);
		assert.equal(source_requests, 1);
		if (events.length > 2) console.log(events);
		assert(events.length <= 2);

		source_requests = 0;
		events = [];
		CachingTable.invalidate(23); // show not load from cache
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(source_requests, 0);
		assert.equal(events.length, 1);
		let resource = await CachingTable.get({ id: 23, ensureLoaded: false });
		resource.invalidate(); // show not load from cache
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(source_requests, 0);
		assert.equal(events.length, 2);

		await new Promise((resolve) => setTimeout(resolve, 20));
		result = await CachingTable.get(23);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(result.id, 23);
		assert.equal(source_requests, 1);
		assert(events.length <= 3);
	});
	it('Source returns undefined', async function () {
		try {
			IndexedCachingTable.setTTLExpiration(0.005);
			await new Promise((resolve) => setTimeout(resolve, 10));
			source_requests = 0;
			events = [];
			return_value = undefined;
			let result = await IndexedCachingTable.get(29);
			assert.equal(result, undefined);
			assert.equal(source_requests, 1);
			result = await IndexedCachingTable.get(29);
			assert.equal(result, undefined);
		} finally {
			return_value = true;
		}
	});
	it('Source throw error', async function () {
		try {
			IndexedCachingTable.setTTLExpiration(0.005);
			await new Promise((resolve) => setTimeout(resolve, 10));
			source_requests = 0;
			events = [];
			return_error = true;
			let returned_error;
			let result;
			try {
				result = await IndexedCachingTable.get(30);
			} catch (error) {
				returned_error = error;
			}
			assert.equal(returned_error?.message, 'test source error');
			assert.equal(source_requests, 1);
		} finally {
			return_error = false;
		}
	});
	it('Can load cached indexed data', async function () {
		source_requests = 0;
		events = [];
		IndexedCachingTable.setTTLExpiration(0.005);
		let result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		let results = [];
		for await (let record of IndexedCachingTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(source_requests, 2);
		// let it expire
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 2);
		assert.equal(events.length, 0);
	});

	it('Bigger stampede is handled', async function () {
		this.timeout(5000);
		try {
			timer = 2;
			CachingTable.setTTLExpiration(0.01);
			let i = 0;
			source_requests = 0;
			let results = [];
			let interval = setInterval(async () => {
				i++;
				if (i % 16 == 1) CachingTable.invalidate(23);
				else {
					// clearing the cache kind of emulates what another thread would see
					if (i % 4 == 0) CachingTable.primaryStore.cache.clear();
					let raw_result = CachingTable.get(23);
					let my_i = i;
					let result = await raw_result;
					results.push(result);
				}
			}, 1);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			clearInterval(interval);
			for (let result of results) {
				assert.equal(result.name, 'name 23');
			}
			assert(source_requests <= 600);
			await new Promise((resolve) => setTimeout(resolve, 300));

			let history = await CachingTable.getHistoryOfRecord(23);
			if (history.length < 40) {
				console.log({ source_requests, i, history_length: history.length });
			}
			assert(history.length > 40);
			for (let entry of history) {
				assert(entry.localTime > 1);
			}
		} finally {
			timer = 0;
		}
	});
});
