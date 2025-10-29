import { describe, it, before } from 'mocha';
import assert from 'assert';
import { cleanupTestSandbox, createTestSandbox } from '../testUtils';
import { table } from '@/resources/databases';
import { Resource } from '@/resources/Resource';
import { setMainIsWorker } from '@/server/threads/manageThreads';

describe('Caching', () => {
	let CachingTable,
		IndexedCachingTable,
		CachingTableStaleWhileRevalidate,
		Source,
		sourceRequests = 0,
		sourceResponses = 0;
	let events = [];
	let timer = 0;
	let returnValue = true;
	let returnError;

	before(async function () {
		createTestSandbox();
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
		Source = class extends Resource {
			get() {
				return new Promise((resolve, reject) => {
					setTimeout(() => {
						sourceRequests++;
						if (returnError) {
							let error = new Error('test source error');
							error.statusCode = returnError;
							reject(error);
						}
						resolve(
							returnValue && {
								id: this.getId(),
								name: 'name ' + this.getId(),
							}
						);
					}, timer);
				});
			}
		};

		CachingTable.sourcedFrom({
			get(id) {
				return new Promise((resolve) => {
					sourceRequests++;
					setTimeout(() => {
						sourceResponses++;
						resolve(
							returnValue && {
								id,
								name: 'name ' + id,
							}
						);
					}, timer);
				});
			},
		});
		IndexedCachingTable.sourcedFrom(Source);
		let subscription = await CachingTable.subscribe({});

		subscription.on('data', (event) => {
			events.push(event);
		});
		CachingTableStaleWhileRevalidate = class extends CachingTable {
			allowStaleWhileRevalidate(entry, id) {
				return true;
			}
		};
	});

	after(cleanupTestSandbox);

	it('Has isCaching flag', async function () {
		assert(CachingTable.isCaching);
		assert(IndexedCachingTable.isCaching);
		assert(!Source.isCaching);
	});

	it('Can load cached data', async function () {
		sourceRequests = 0;
		events = [];
		CachingTable.setTTLExpiration(0.01);
		await CachingTable.invalidate(23);
		let result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		result = await CachingTable.get(23);
		assert.equal(result.wasLoadedFromSource(), false);
		assert.equal(result.id, 23);
		assert.equal(sourceRequests, 1);
		// let it expire
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 2);
		assert.equal(events.length, 1); // invalidate event
		await CachingTable.put(23, { name: 'expires in past' }, { expiresAt: 0 });
		result = await CachingTable.get(23);
		assert.equal(sourceRequests, 3);
		assert.equal(result.wasLoadedFromSource(), true);
	});

	it('Cache stampede is handled', async function () {
		try {
			CachingTable.setTTLExpiration(0.01);
			await new Promise((resolve) => setTimeout(resolve, 15));
			CachingTable.setTTLExpiration(40);
			await new Promise((resolve) => setTimeout(resolve, 5));
			sourceRequests = 0;
			events = [];
			timer = 10;
			CachingTable.get(23);
			while (sourceRequests === 0) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await CachingTable.primaryStore.committed; // wait for the record to update to updating status
			CachingTable.get(23);
			let result = await CachingTable.get(23);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert(sourceRequests <= 1);
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
		sourceRequests = 0;
		events = [];
		result.invalidate();
		await new Promise((resolve) => setTimeout(resolve, 20));
		result = await CachingTable.get(23);
		assert.equal(result.wasLoadedFromSource(), true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(result.id, 23);
		assert.equal(sourceRequests, 1);
		if (events.length > 2) console.log(events);
		assert(events.length <= 2);

		sourceRequests = 0;
		events = [];
		CachingTable.invalidate(23); // show not load from cache
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(sourceRequests, 0);
		assert.equal(events.length, 1);
		let resource = await CachingTable.get({ id: 23, ensureLoaded: false });
		resource.invalidate(); // show not load from cache
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(sourceRequests, 0);
		assert.equal(events.length, 2);

		await new Promise((resolve) => setTimeout(resolve, 20));
		result = await CachingTable.get(23);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(result.id, 23);
		assert.equal(sourceRequests, 1);
		assert(events.length <= 3);
	});

	it('Handles distinct eviction time', async function () {
		CachingTable.setTTLExpiration({
			expiration: 0.005,
			eviction: 0.01,
		});
		CachingTable.invalidate(23); // reset the entry
		await new Promise((resolve) => setTimeout(resolve, 10));
		await CachingTable.get(23);
		sourceRequests = 0;
		events = [];
		await new Promise((resolve) => setTimeout(resolve, 10));
		let result = CachingTable.primaryStore.get(23);
		assert(result); // should exist in database even though it is expired
		await new Promise((resolve) => setTimeout(resolve, 20));
		result = CachingTable.primaryStore.get(23);
		assert(!result); // should be evicted and no longer exist in database
	});

	it('Allows stale-while-revalidate', async function () {
		CachingTable.setTTLExpiration({
			expiration: 0.005,
			eviction: 0.01,
		});
		CachingTable.invalidate(23); // reset the entry
		await new Promise((resolve) => setTimeout(resolve, 10));
		await CachingTable.get(23);
		sourceRequests = 0;
		sourceResponses = 0;
		events = [];
		await new Promise((resolve) => setTimeout(resolve, 10));
		// should be stale but not evicted
		let result = await CachingTableStaleWhileRevalidate.get(23);
		assert(result); // should exist in database even though it is stale
		assert.equal(sourceRequests, 1); // the source request should be started
		assert.equal(sourceResponses, 0); // the source request should not be completed yet
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(sourceResponses, 1); // the source request should be completed
		result = await CachingTableStaleWhileRevalidate.primaryStore.get(23);
		assert.equal(sourceRequests, 1); // should be cached again
		assert(result);
	});

	it('Caching directives', async function () {
		CachingTable.setTTLExpiration({
			expiration: 0.005,
			eviction: 0.01,
		});
		CachingTable.invalidate(23); // reset the entry
		await new Promise((resolve) => setTimeout(resolve, 10));
		await CachingTable.get(23);
		sourceRequests = 0;
		sourceResponses = 0;
		events = [];
		await new Promise((resolve) => setTimeout(resolve, 10));
		// should be stale but not evicted
		let result = await CachingTable.get(23, { onlyIfCached: true });
		assert(result); // should exist in database even though it is stale
		assert.equal(sourceRequests, 0); // the source request should not be started
		assert.equal(sourceResponses, 0); // the source request should not be completed yet
		result = await CachingTable.get(23);
		assert(result); // should exist now
		assert.equal(sourceRequests, 1);
		assert.equal(sourceResponses, 1);
	});

	it('Source returns undefined', async function () {
		try {
			IndexedCachingTable.setTTLExpiration(0.005);
			await new Promise((resolve) => setTimeout(resolve, 10));
			sourceRequests = 0;
			events = [];
			returnValue = undefined;
			let result = await IndexedCachingTable.get(29);
			assert.equal(result, undefined);
			assert.equal(sourceRequests, 1);
			result = await IndexedCachingTable.get(29);
			assert.equal(result, undefined);
		} finally {
			returnValue = true;
		}
	});

	it('Source throw error', async function () {
		try {
			IndexedCachingTable.setTTLExpiration(0.005);
			await new Promise((resolve) => setTimeout(resolve, 10));
			sourceRequests = 0;
			events = [];
			returnError = 500;
			let returned_error;
			let result;
			try {
				result = await IndexedCachingTable.get(30);
			} catch (error) {
				returned_error = error;
			}
			assert.equal(returned_error?.message, 'test source error while resolving record 30 for IndexedCachingTable');
			assert.equal(sourceRequests, 1);

			IndexedCachingTable.setTTLExpiration({
				expiration: 0.005,
				eviction: 0.01,
			});
			returnError = false;
			IndexedCachingTable.invalidate(23); // reset the entry
			await IndexedCachingTable.get(23);
			sourceRequests = 0;
			sourceResponses = 0;
			events = [];
			await new Promise((resolve) => setTimeout(resolve, 10));
			// should be stale but not evicted
			returnError = 504;
			result = await IndexedCachingTable.get(23, { staleIfError: true });
			assert(result); // should return stale value despite error
			assert.equal(sourceRequests, 1); // the source request should be started
		} finally {
			returnError = false;
		}
	});

	it('Can load cached indexed data', async function () {
		sourceRequests = 0;
		events = [];
		IndexedCachingTable.setTTLExpiration(0.005);
		let result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		let results = [];
		for await (let record of IndexedCachingTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(sourceRequests, 2);
		// let it expire
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 3);
		assert.equal(events.length, 0);
	});

	it('Bigger stampede is handled', async function () {
		this.timeout(5000);
		try {
			timer = 2;
			CachingTable.setTTLExpiration(100); // don't evict during this test since it will clear the history
			let i = 0;
			sourceRequests = 0;
			let results = [];
			let interval = setInterval(async () => {
				i++;
				if (i % 16 == 1) CachingTable.invalidate(23);
				else {
					// clearing the cache kind of emulates what another thread would see
					if (i % 4 == 0) CachingTable.primaryStore.cache.clear();
					let raw_result = CachingTable.get(23);
					let result = await raw_result;
					results.push(result);
				}
			}, 1);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			clearInterval(interval);
			for (let result of results) {
				assert.equal(result.name, 'name 23');
			}
			assert(sourceRequests <= 600);
			await new Promise((resolve) => setTimeout(resolve, 300));

			let history = await CachingTable.getHistoryOfRecord(23);
			if (history.length < 40) {
				console.log({ source_requests: sourceRequests, i, history_length: history.length });
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
