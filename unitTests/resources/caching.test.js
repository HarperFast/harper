require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { waitFor } = require('../waitFor.js');

describe('Caching', () => {
	let CachingTable,
		IndexedCachingTable,
		CachingTableStaleWhileRevalidate,
		SwrQueryTable,
		Source,
		sourceRequests = 0,
		sourceResponses = 0;
	let swrEnabled = true;
	let sourceGate = null; // when set, SwrQueryTable's source defers responding until the test releases it
	let observedSwrIds = []; // ids the SwrQueryTable SWR hook saw via this.getId(), for the per-row-identity test
	let events = [];
	let timer = 0;
	let return_value = true;
	let return_error;
	// skip LMDB test for now, https://github.com/HarperFast/harper/issues/414 for re-enabling
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		CachingTable = table({
			table: 'CachingTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'createdAt', type: 'Date', assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Date', assignUpdatedTime: true },
			],
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
				let expiresAt = Date.now() + 2;
				this.getContext().expiresAt = expiresAt;
				return new Promise((resolve, reject) => {
					setTimeout(() => {
						sourceRequests++;
						if (return_error) {
							let error = new Error('test source error');
							error.statusCode = return_error;
							reject(error);
						}
						resolve(
							return_value && {
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
							return_value && {
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
			allowStaleWhileRevalidate(_entry, _id) {
				return true;
			}
		};
		// Indexed, object-sourced table whose allowStaleWhileRevalidate is gated by `swrEnabled`, so the
		// same table exercises both the SWR and non-SWR query paths (harper#1578).
		SwrQueryTable = table({
			table: 'SwrQueryTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		SwrQueryTable.sourcedFrom({
			get(id) {
				sourceRequests++;
				return new Promise((resolve) => {
					const respond = () => {
						sourceResponses++;
						resolve(return_value && { id, name: 'name ' + id });
					};
					// A gate lets a test hold the source response open deterministically (no timing races);
					// otherwise fall back to the shared `timer` delay.
					if (sourceGate) sourceGate(respond);
					else setTimeout(respond, timer);
				});
			},
		});
		SwrQueryTable.prototype.allowStaleWhileRevalidate = function () {
			// Record the identity the hook sees so a test can assert it matches the current row (harper#1578).
			observedSwrIds.push(this.getId());
			// The stale record must be loaded on the query-path instance, matching the single-record get path:
			// a hook consulting this.getRecord()/this.<field> should see the stale row, not undefined (harper#1578).
			assert.ok(this.getRecord(), 'SWR hook should see the loaded stale record, not undefined');
			assert.equal(this.getRecord().id, this.getId());
			return swrEnabled;
		};
	});
	it('Has isCaching flag', async function () {
		assert(CachingTable.isCaching);
		assert(IndexedCachingTable.isCaching);
		assert(!Source.isCaching);
	});
	it('Can load cached data', async function () {
		sourceRequests = 0;
		events = [];
		const start = new Date();
		CachingTable.setTTLExpiration(0.01);
		await CachingTable.invalidate(23);
		let result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert(result.createdAt >= start);
		assert(result.updatedAt >= start);
		assert.equal(sourceRequests, 1);
		await delay(5);
		let target23 = new RequestTarget();
		target23.id = 23;
		result = await CachingTable.get(target23);
		assert.equal(target23.loadedFromSource, false);
		assert.equal(result.id, 23);
		assert.equal(sourceRequests, 1);
		// let it expire
		await delay(10);
		result = await CachingTable.get(target23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 2);
		if (events.length > 0) console.log(events);
		//assert.equal(events.length, 0);
		await CachingTable.put(23, { name: 'expires in past' }, { expiresAt: 0 });
		result = await CachingTable.get(target23);
		assert(result.createdAt >= start);
		assert(result.updatedAt >= start);
		assert.equal(sourceRequests, 3);
		assert.equal(target23.loadedFromSource, true);
	});

	it('loadedFromSource is observable on the target with loadAsInstance = false (#1576)', async function () {
		// disposition is recorded on the RequestTarget of the get; verify the loadAsInstance=false
		// value path marks it on both cache miss (true) and cache hit (false)
		const previousLoadAsInstance = CachingTable.loadAsInstance;
		try {
			CachingTable.loadAsInstance = false;
			CachingTable.setTTLExpiration(30);
			await CachingTable.invalidate(32);
			let target = new RequestTarget();
			target.id = 32;
			let result = await CachingTable.get(target);
			assert.equal(result.id, 32);
			assert.equal(target.loadedFromSource, true);
			target = new RequestTarget();
			target.id = 32;
			result = await CachingTable.get(target);
			assert.equal(result.id, 32);
			assert.equal(target.loadedFromSource, false);
		} finally {
			CachingTable.loadAsInstance = previousLoadAsInstance;
		}
	});

	it('onlyIfCached cache hit marks loadedFromSource=false with loadAsInstance=false (#1576)', async function () {
		// exercises the value path onlyIfCached cache-hit marking (Table.ts, loadAsInstance=false branch),
		// the twin of the loadAsInstance=true instance path — previously untested.
		const previousLoadAsInstance = CachingTable.loadAsInstance;
		try {
			CachingTable.setTTLExpiration(30);
			await CachingTable.invalidate(42);
			// prime the cache from source and wait until the record is durably cached, so the
			// onlyIfCached read below is a deterministic cache hit rather than racing the write
			assert.equal((await CachingTable.get(42)).id, 42);
			await CachingTable.primaryStore.committed;
			await waitFor(() => CachingTable.primaryStore.getEntry(42)?.value);
			// onlyIfCached hit on the loadAsInstance=false value path: served from cache, so the
			// per-get disposition must be recorded as false on the RequestTarget
			CachingTable.loadAsInstance = false;
			const target = new RequestTarget();
			target.id = 42;
			const result = await CachingTable.get(target, { onlyIfCached: true });
			assert.equal(result.id, 42);
			assert.equal(target.loadedFromSource, false);
		} finally {
			CachingTable.loadAsInstance = previousLoadAsInstance;
		}
	});

	it('primitive-id instance-API get does not throw setting cache disposition (#1576)', async function () {
		// getResource() (the instance API) can be called with a primitive id as the target — this is
		// how source-apply/replication loads a record (see Table.ts Table.getResource(id, ...)). A
		// primitive can't hold the loadedFromSource flag; without the `typeof target === 'object'`
		// guard, setLoadedFromSource does `(41).loadedFromSource = ...`, which throws in strict mode
		// ("Cannot create property 'loadedFromSource' on number '41'"). ensureLoaded routes through
		// setLoadedFromSource on both the cache-hit and source-load branches, so this covers the guard
		// regardless of current cache state.
		CachingTable.setTTLExpiration(30);
		await CachingTable.invalidate(41);
		const resource = await CachingTable.getResource(41, {}, { ensureLoaded: true });
		assert(resource); // resolved without throwing → guard held on the primitive-id target
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
			await waitFor(() => sourceRequests > 0);
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
		CachingTable.invalidate(23);
		await new Promise((resolve) => setTimeout(resolve, 20));
		let target23 = new RequestTarget();
		target23.id = 23;
		result = await CachingTable.get(target23);
		assert.equal(target23.loadedFromSource, true);
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

		await new Promise((resolve) => setTimeout(resolve, 20));
		result = await CachingTable.get(23);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(result.id, 23);
		assert.equal(sourceRequests, 1);
		assert(events.length <= 2);
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
		let result = CachingTable.primaryStore.getSync(23);
		assert(result); // should exist in database even though it is expired
		// should be evicted and no longer exist in database
		await waitFor(() => !CachingTable.primaryStore.getSync(23));
	});

	it('Handles eviction-only config without expiration:', async function () {
		// { eviction: N } alone schedules the scanner and reaps records past their per-record expiresAt
		CachingTable.setTTLExpiration({ eviction: 0.02 });
		await CachingTable.put(99, { id: 99, name: 'expires soon' }, { expiresAt: Date.now() + 20 });
		// should be evicted
		await waitFor(() => !CachingTable.primaryStore.getSync(99));
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
		const swrTarget = new RequestTarget();
		swrTarget.id = 23;
		let result = await CachingTableStaleWhileRevalidate.get(swrTarget);
		assert(result); // should exist in database even though it is stale
		assert.equal(swrTarget.loadedFromSource, false); // stale value served from cache while revalidating
		assert.equal(sourceRequests, 1); // the source request should be started
		assert.equal(sourceResponses, 0); // the source request should not be completed yet
		// the source request should be completed
		await waitFor(() => sourceResponses === 1);
		result = await CachingTableStaleWhileRevalidate.primaryStore.get(23);
		assert.equal(sourceRequests, 1); // should be cached again
		assert(result);
	});

	// harper#1578: a query touching an expired row must consult allowStaleWhileRevalidate and serve the
	// stale row while revalidating in the background, matching the single-record get path above.
	it('Allows stale-while-revalidate for queries', async function () {
		try {
			swrEnabled = true;
			timer = 0;
			SwrQueryTable.setTTLExpiration({ expiration: 50, eviction: 100 }); // don't expire/evict on a timer; we force staleness explicitly
			await SwrQueryTable.get(23); // warm the cache with a fresh entry (ungated)
			// Force the entry stale (present but expired) deterministically, avoiding TTL timing races.
			await SwrQueryTable.put(23, { id: 23, name: 'name 23' }, { expiresAt: 1 });
			sourceRequests = 0;
			sourceResponses = 0;
			// Gate the revalidation so we can assert the query returned the stale row WITHOUT the source
			// having responded — no timing race.
			let releaseSource;
			sourceGate = (respond) => (releaseSource = respond);
			const results = [];
			for await (const record of SwrQueryTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
				results.push(record);
			}
			assert.equal(results.length, 1); // stale row served without waiting on source
			assert.equal(results[0].id, 23);
			assert.equal(sourceRequests, 1); // background revalidation was started
			assert.equal(sourceResponses, 0); // and the query did NOT block on it (response still gated)
			assert(releaseSource, 'the source revalidation should be in-flight (gated)');
			releaseSource(); // now let the background revalidation complete
			await waitFor(() => sourceResponses === 1);
		} finally {
			sourceGate = null;
			timer = 0;
		}
	});

	// Guard the negative: without SWR (or when it returns false), a query over an expired row must still
	// block on the upstream fetch, so the fix does not silently change non-SWR tables.
	it('Query over expired row blocks on source when stale-while-revalidate is not allowed', async function () {
		try {
			swrEnabled = false;
			timer = 0;
			SwrQueryTable.setTTLExpiration({ expiration: 50, eviction: 100 });
			await SwrQueryTable.get(23); // warm the cache with a fresh entry
			await SwrQueryTable.put(23, { id: 23, name: 'name 23' }, { expiresAt: 1 }); // force stale
			sourceRequests = 0;
			sourceResponses = 0;
			const results = [];
			for await (const record of SwrQueryTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			assert.equal(results[0].id, 23);
			assert.equal(sourceRequests, 1);
			assert.equal(sourceResponses, 1); // the query blocked until the source responded
		} finally {
			timer = 0;
			swrEnabled = true;
		}
	});

	// Guard against a single shared SWR instance leaking one row's identity to the others: a query over
	// several expired rows must invoke allowStaleWhileRevalidate with each row's own id (harper#1578).
	it('Query revalidation sees each row identity for a per-row SWR policy', async function () {
		const ids = [24, 25, 26];
		try {
			swrEnabled = true;
			timer = 0;
			SwrQueryTable.setTTLExpiration({ expiration: 50, eviction: 100 });
			for (const id of ids) await SwrQueryTable.get(id); // warm each entry
			// Force all three stale and give them a shared indexed name so one query returns all of them.
			for (const id of ids) await SwrQueryTable.put(id, { id, name: 'shared-swr' }, { expiresAt: 1 });
			observedSwrIds = [];
			const results = [];
			for await (const record of SwrQueryTable.search({ conditions: [{ attribute: 'name', value: 'shared-swr' }] })) {
				results.push(record.id);
			}
			assert.deepEqual(
				[...results].sort((a, b) => a - b),
				ids
			); // all three stale rows served
			// The SWR hook must have seen each row's own id via this.getId(), not the first row's repeated.
			assert.deepEqual(
				[...observedSwrIds].sort((a, b) => a - b),
				ids
			);
		} finally {
			timer = 0;
			observedSwrIds = [];
		}
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
			return_value = undefined;
			let result = await IndexedCachingTable.get(29);
			assert.equal(result, undefined);
			assert.equal(sourceRequests, 1);
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
			sourceRequests = 0;
			events = [];
			return_error = 500;
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
			return_error = false;
			IndexedCachingTable.invalidate(23); // reset the entry
			await IndexedCachingTable.get(23);
			sourceRequests = 0;
			sourceResponses = 0;
			events = [];
			await new Promise((resolve) => setTimeout(resolve, 10));
			// should be stale but not evicted
			return_error = 504;
			result = await IndexedCachingTable.get(23, { staleIfError: true });
			assert(result); // should return stale value despite error
			assert.equal(sourceRequests, 1); // the source request should be started
		} finally {
			return_error = false;
		}
	});
	it('Can load cached indexed data', async function () {
		sourceRequests = 0;
		events = [];
		IndexedCachingTable.setTTLExpiration(0.005);
		let result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		events = [];
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		let results = [];
		for await (let record of IndexedCachingTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		assert.equal(sourceRequests, 2);
		result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		sourceRequests = 0;
		// let it expire
		await delay(10);
		result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(sourceRequests, 1);
		assert.equal(events.length, 0);
		result = await IndexedCachingTable.get(23);
		await delay(10); // give the lock a chance to be released
		assert(result.getExpiresAt());
		result = IndexedCachingTable.primaryStore.getEntry(23);
		await IndexedCachingTable.evict(23, result, result.version);
		// evict should completely eliminate the record
		await waitFor(() => IndexedCachingTable.primaryStore.getSync(23) === undefined);
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
				console.log({ sourceRequests, i, history_length: history.length });
			}
			assert(history.length > 40);
			for (let entry of history) {
				assert(entry.localTime > 1);
			}
		} finally {
			timer = 0;
		}
	});

	it('Extended class with sourcedFrom does not impact base class', async function () {
		// Create a base table without a source
		const BaseTable = table({
			table: 'BaseTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});

		// Create an extended class and give it a source
		class ExtendedTable extends BaseTable {}

		let extendedSourceCalls = 0;
		ExtendedTable.sourcedFrom({
			get(id) {
				return new Promise((resolve) => {
					extendedSourceCalls++;
					resolve({
						id,
						value: 'extended-' + id,
					});
				});
			},
		});

		// Verify the extended class has a source
		assert(ExtendedTable.source);
		assert.equal(typeof ExtendedTable.source.get, 'function');

		// Verify the base class does NOT have a source
		assert(!BaseTable.source);

		// Test that the extended class uses its source
		extendedSourceCalls = 0;
		await ExtendedTable.invalidate(100);
		const extendedResult = await ExtendedTable.get(100);
		assert.equal(extendedResult.value, 'extended-100');
		assert.equal(extendedSourceCalls, 1);

		// Test that the base class doesn't call any source
		await BaseTable.invalidate(101);
		const baseResult = await BaseTable.get(101);
		assert.equal(baseResult, undefined); // Should be undefined since there's no source
		assert.equal(extendedSourceCalls, 1); // Should not have called extended source

		// Create another extended class with a different source
		class AnotherExtendedTable extends BaseTable {}

		let anotherSourceCalls = 0;
		AnotherExtendedTable.sourcedFrom({
			get(id) {
				return new Promise((resolve) => {
					anotherSourceCalls++;
					resolve({
						id,
						value: 'another-' + id,
					});
				});
			},
		});

		// Verify each extended class has its own independent source
		assert(AnotherExtendedTable.source);
		assert(AnotherExtendedTable.source !== ExtendedTable.source);

		// Test that each extended class uses its own source
		await AnotherExtendedTable.invalidate(102);
		const anotherResult = await AnotherExtendedTable.get(102);
		assert.equal(anotherResult.value, 'another-102');
		assert.equal(anotherSourceCalls, 1);
		assert.equal(extendedSourceCalls, 1); // ExtendedTable source should not be called

		// Verify ExtendedTable still uses its own source
		await ExtendedTable.invalidate(103);
		const extendedResult2 = await ExtendedTable.get(103);
		assert.equal(extendedResult2.value, 'extended-103');
		assert.equal(extendedSourceCalls, 2);
		assert.equal(anotherSourceCalls, 1); // AnotherExtendedTable source should not be called
	});

	it('intermediate (replication) source events are applied, not revalidated/invalidated (#1302)', async function () {
		// A table that is BOTH cache-sourced (its caching source opts into event revalidation) AND
		// fed by an intermediate source (how replication registers itself — see harper-pro
		// replication/replicator.ts, `{ intermediateSource: true }`).
		//
		// Bug: shouldRevalidateEvents was read from this.source (the canonical caching source) for
		// EVERY sourcedFrom() subscription closure, including the intermediate one. So authoritative
		// replicated put/patch events were down-converted to invalidate — stripping the row to an
		// index stub and (for file-backed blobs) deleting data no peer re-supplies. The fix gates
		// revalidation off the intermediate source, so replicated writes apply via _writeUpdate.
		// The caching source is gated: a read-miss on a cache-sourced table triggers a source load,
		// and we must not let a poll-before-apply write a competing 'CACHE' record while we wait for
		// the replicated event. Gating makes any premature load stall instead of polluting state.
		let allowCacheLoad;
		const cacheLoadGate = new Promise((resolve) => (allowCacheLoad = resolve));
		const CacheSource = {
			async get(id) {
				await cacheLoadGate;
				return { id, name: 'from-cache-source', payload: 'CACHE' };
			},
			// the caching source pushes change notifications it wants treated as invalidations
			shouldRevalidateEvents: true,
		};
		const ReplAndCacheTable = table({
			table: 'ReplAndCacheTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'payload' }],
		});
		// Order matters: the caching source is registered before the intermediate (replication)
		// source, so this.source is already set when the intermediate subscription closure captures
		// the flag — the exact condition that triggered the leak.
		ReplAndCacheTable.sourcedFrom(CacheSource);

		let releaseSubscription;
		const subscriptionDone = new Promise((resolve) => (releaseSubscription = resolve));
		const replicatedValue = { id: 500, name: 'from-peer', payload: 'PEER' };
		const IntermediateSource = {
			subscribeOnThisThread() {
				return true;
			},
			async *subscribe() {
				yield { type: 'put', id: 500, value: replicatedValue, version: Date.now() };
				await subscriptionDone; // hold the subscription open until the assertions are done
			},
		};
		ReplAndCacheTable.sourcedFrom(IntermediateSource, { intermediateSource: true });

		try {
			// A record that surfaces as 'PEER' proves the replicated event was applied as an update.
			// Pre-fix it was down-converted to an invalidate, so the read would resolve to the source's
			// 'CACHE' value instead and this would time out. The race against a short timer ensures a
			// gated (stalled) load on a not-yet-applied record counts as "not ready", not a hang.
			await waitFor(
				async () =>
					(await Promise.race([
						ReplAndCacheTable.get(500).then((record) => record?.payload),
						delay(20).then(() => undefined),
					])) === 'PEER',
				{ timeout: 5000, message: 'replicated intermediate-source put should be applied as an update, not invalidated' }
			);
		} finally {
			allowCacheLoad();
			releaseSubscription();
		}
	});
});
