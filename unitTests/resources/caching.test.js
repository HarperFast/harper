require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { VERSION_NOT_UNIQUE_FLAG } = require('#src/resources/RecordEncoder');
const { INVALIDATED } = require('#src/resources/Table');
const { exportIdMapping } = require('#src/resources/nodeIdMapping');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor.js');

describe('Caching', () => {
	let CachingTable,
		IndexedCachingTable,
		ConflictCachingTable,
		CachingTableStaleWhileRevalidate,
		SwrQueryTable,
		Source,
		sourceRequests = 0,
		sourceResponses = 0;
	let swrEnabled = true;
	let sourceGate = null; // when set, SwrQueryTable's source defers responding until the test releases it
	let ConflictSideEffectTable;
	let conflictSourceRequest;
	let conflictSourceWriteId = null;
	let conflictTimestamp = 0;
	// Apply a record the way replication does, attributed to `nodeId`, so a version tie against a fill is
	// resolved against a *peer's* identity rather than this node's own.
	async function applyFromPeer(id, record, timestamp, nodeId) {
		const context = { source: {}, timestamp };
		await transaction(context, async () => {
			const resource = await ConflictCachingTable.getResource(id, context);
			return resource._writeUpdate(id, record, true, { isNotification: true, nodeId });
		});
	}
	function nextConflictTimestamp() {
		return (conflictTimestamp = Math.max(
			conflictTimestamp + 1000,
			ConflictCachingTable.primaryStore.getMonotonicTimestamp() + 1000
		));
	}
	let observedSwrIds = []; // ids the SwrQueryTable SWR hook saw via this.getId(), for the per-row-identity test
	let events = [];
	let timer = 0;
	let sourceExpiresAt;
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
				let expiresAt = sourceExpiresAt ?? Date.now() + 2;
				this.getContext().expiresAt = expiresAt;
				// counted at request start so a concurrent duplicate is observable before the first response
				sourceRequests++;
				return new Promise((resolve, reject) => {
					setTimeout(() => {
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
			get(id, context) {
				return new Promise((resolve) => {
					sourceRequests++;
					if (sourceExpiresAt !== undefined) context.expiresAt = sourceExpiresAt;
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
		ConflictCachingTable = table({
			table: 'ConflictCachingTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'createdAt', type: 'Date', assignCreatedTime: true },
			],
		});
		ConflictSideEffectTable = table({
			table: 'ConflictSideEffectTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		ConflictCachingTable.sourcedFrom({
			get(id, context) {
				return new Promise((resolve) => {
					conflictSourceRequest = {
						id,
						timestamp: context.timestamp,
						respond(value, lastModified) {
							if (conflictSourceWriteId != null)
								ConflictSideEffectTable.put(
									conflictSourceWriteId,
									{ id: conflictSourceWriteId, name: 'side-effect' },
									context
								);
							context.lastModified = lastModified;
							resolve(value);
						},
					};
				});
			},
		});
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
		// expiry here is driven by the expiration the source reports, not by sleeping against the TTL
		CachingTable.setTTLExpiration(30);
		// the fill lock is only released once the fill has settled; a past expiration may also have been
		// evicted by the cleanup scan by the time it is observed
		const entryCommitted = (expiresAt) => {
			if (CachingTable.primaryStore.hasLock(23)) return false;
			const entry = CachingTable.primaryStore.getEntry(23);
			return entry ? entry.expiresAt === expiresAt : expiresAt < Date.now();
		};
		try {
			const liveExpiresAt = (sourceExpiresAt = Date.now() + 60000);
			await CachingTable.invalidate(23);
			let result = await CachingTable.get(23);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert(result.createdAt >= start);
			assert(result.updatedAt >= start);
			assert.equal(sourceRequests, 1);
			await waitFor(() => entryCommitted(liveExpiresAt), { message: 'the source fill should commit' });
			let target23 = new RequestTarget();
			target23.id = 23;
			result = await CachingTable.get(target23);
			assert.equal(target23.loadedFromSource, false);
			assert.equal(result.id, 23);
			assert.equal(sourceRequests, 1);
			const expiredAt = (sourceExpiresAt = Date.now() - 1);
			await CachingTable.invalidate(23);
			await CachingTable.get(23);
			assert.equal(sourceRequests, 2);
			await waitFor(() => entryCommitted(expiredAt), { message: 'the expired source fill should commit' });
			// reloading restores a live entry, so the `expiresAt: 0` write below is the only reason the
			// last get can miss
			const reloadedExpiresAt = (sourceExpiresAt = Date.now() + 60000);
			result = await CachingTable.get(target23);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert.equal(target23.loadedFromSource, true);
			assert.equal(sourceRequests, 3);
			await waitFor(() => entryCommitted(reloadedExpiresAt), { message: 'the reload should commit a live entry' });
			if (events.length > 0) console.log(events);
			//assert.equal(events.length, 0);
			const finalExpiresAt = (sourceExpiresAt = Date.now() - 1);
			await CachingTable.put(23, { name: 'expires in past' }, { expiresAt: 0 });
			await waitFor(() => entryCommitted(0), { message: 'the put should commit its past expiration' });
			const expiredTarget23 = new RequestTarget();
			expiredTarget23.id = 23;
			result = await CachingTable.get(expiredTarget23);
			assert.equal(result.name, 'name ' + 23);
			assert(result.createdAt >= start);
			assert(result.updatedAt >= start);
			assert.equal(sourceRequests, 4);
			assert.equal(expiredTarget23.loadedFromSource, true);
			// the tests below expect their own first get(23) to reach the source
			await waitFor(() => entryCommitted(finalExpiresAt), { message: 'the last fill should commit expired' });
		} finally {
			sourceExpiresAt = undefined;
		}
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
			// The background revalidation is kicked off after the query already returned the stale
			// row, so it may not have started yet on this tick (racy on a loaded CI runner) — poll
			// for it instead, matching the same pattern used for the single-record path above.
			await waitFor(() => sourceRequests === 1, { message: 'background revalidation should have started' });
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
	it('orders first source fills from fetch start without overwriting a later write', async function () {
		const id = 610;
		const sourceTimestamp = nextConflictTimestamp();
		conflictSourceRequest = null;
		const fill = ConflictCachingTable.get(id, { timestamp: sourceTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		assert.equal(conflictSourceRequest.timestamp, undefined);
		await ConflictCachingTable.put(id, { id, name: 'authoritative' }, { timestamp: sourceTimestamp + 1 });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'authoritative');
		const authoritativeVersion = ConflictCachingTable.primaryStore.getEntry(id).version;
		conflictSourceRequest.respond({ id, name: 'source' });
		assert.equal((await fill).name, 'source');
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		assert.equal(ConflictCachingTable.primaryStore.getSync(id).name, 'authoritative');
		assert.equal(ConflictCachingTable.primaryStore.getEntry(id).version, authoritativeVersion);
		assert(ConflictCachingTable.primaryStore.getEntry(id).version > sourceTimestamp);
	});

	it('reuses a revalidation version when the request timestamp predates the cached record', async function () {
		const id = 614;
		await ConflictCachingTable.put(id, { id, name: 'seed-regression' });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'seed-regression');
		const existingVersion = ConflictCachingTable.primaryStore.getEntry(id).version;
		await ConflictCachingTable.invalidate(id);
		await waitFor(() => ConflictCachingTable.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED);
		const invalidatedVersion = ConflictCachingTable.primaryStore.getEntry(id).version;
		conflictSourceRequest = null;
		const requestTimestamp = existingVersion - 1000;
		const fill = ConflictCachingTable.get(id, { timestamp: requestTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		assert.equal(conflictSourceRequest.timestamp, undefined);
		conflictSourceRequest.respond({ id, name: 'refreshed' });
		assert.equal((await fill).name, 'refreshed');
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		assert.equal(ConflictCachingTable.primaryStore.getSync(id).name, 'refreshed');
		const refreshedEntry = ConflictCachingTable.primaryStore.getEntry(id);
		assert.equal(refreshedEntry.version, invalidatedVersion);
		assert(refreshedEntry.metadataFlags & VERSION_NOT_UNIQUE_FLAG);
	});

	it('uses a source-reported version before the transaction timestamp', async function () {
		const id = 615;
		const requestTimestamp = nextConflictTimestamp();
		const reportedVersion = requestTimestamp - 100;
		conflictSourceRequest = null;
		const fill = ConflictCachingTable.get(id, { timestamp: requestTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		conflictSourceRequest.respond({ id, name: 'reported-version' }, reportedVersion);
		assert.equal((await fill).getUpdatedTime(), reportedVersion);
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		assert.equal(ConflictCachingTable.primaryStore.getEntry(id).version, reportedVersion);
	});

	it('delivers a subscription event for a fill whose source-reported version predates the log position', async function () {
		// A dedicated table: ConflictCachingTable's history carries deliberately future-stamped
		// writes, and a fresh subscriber's catch-up cursor raises startTime to the newest record
		// time it sees, which would gate off real-time events until wall-clock catches up.
		const id = 645;
		let reportedVersion;
		const ReportedVersionTable = table({
			table: 'ReportedVersionTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		ReportedVersionTable.sourcedFrom(
			class extends Resource {
				get() {
					reportedVersion = Date.now() - 1000;
					this.getContext().lastModified = reportedVersion;
					return { id: this.getId(), name: 'reported-version-event' };
				}
			}
		);
		const subscription = await ReportedVersionTable.subscribe({});
		const events = [];
		subscription.on('data', (event) => events.push(event));
		try {
			await ReportedVersionTable.get(id);
			await waitFor(() => !ReportedVersionTable.primaryStore.hasLock(id), {
				message: 'the reported-version fill should finish committing',
			});
			assert.equal(ReportedVersionTable.primaryStore.getEntry(id).version, reportedVersion);
			await waitFor(() => events.some((event) => event.id === id && event.type === 'put'), {
				message: 'a backdated source-reported fill should still reach the subscription',
			});
		} finally {
			subscription.close();
		}
	});

	it('clamps an older source-reported revalidation version instead of using the request timestamp', async function () {
		const id = 620;
		await ConflictCachingTable.put(id, { id, name: 'seed-reported-version' });
		await ConflictCachingTable.invalidate(id);
		await waitFor(() => ConflictCachingTable.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED);
		const invalidatedVersion = ConflictCachingTable.primaryStore.getEntry(id).version;
		const requestTimestamp = nextConflictTimestamp();
		const reportedVersion = invalidatedVersion - 1000;
		conflictSourceRequest = null;
		const fill = ConflictCachingTable.get(id, { timestamp: requestTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		conflictSourceRequest.respond({ id, name: 'reported-revalidation' }, reportedVersion);
		assert.equal((await fill).getUpdatedTime(), invalidatedVersion);
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		const refreshedEntry = ConflictCachingTable.primaryStore.getEntry(id);
		assert.equal(refreshedEntry.version, invalidatedVersion);
		assert(refreshedEntry.metadataFlags & VERSION_NOT_UNIQUE_FLAG);
	});

	it('falls back from an invalid source-reported version', async function () {
		for (const [id, reportedVersion] of [
			[616, Infinity],
			[617, NaN],
			[618, -1],
			[619, Number.MAX_VALUE],
		]) {
			const requestTimestamp = nextConflictTimestamp();
			conflictSourceRequest = null;
			const fill = ConflictCachingTable.get(id, { timestamp: requestTimestamp });
			await waitFor(() => conflictSourceRequest?.id === id);
			conflictSourceRequest.respond({ id, name: 'fallback-version' }, reportedVersion);
			assert.equal((await fill).getUpdatedTime(), requestTimestamp);
			await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
			assert.equal(ConflictCachingTable.primaryStore.getEntry(id).version, requestTimestamp);
		}
	});

	it('first source fill replaces an older raced record and its index entries', async function () {
		const id = 611;
		const sourceTimestamp = nextConflictTimestamp();
		conflictSourceRequest = null;
		const fill = ConflictCachingTable.get(id, { timestamp: sourceTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		const createdAt = new Date(sourceTimestamp - 0.0001);
		await ConflictCachingTable.put(id, { id, name: 'older', createdAt }, { timestamp: sourceTimestamp - 1 });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'older');
		const racedEntry = ConflictCachingTable.primaryStore.getEntry(id);
		assert(racedEntry.version < sourceTimestamp);
		const racedCreatedAt = racedEntry.value.createdAt;
		conflictSourceRequest.respond({ id, name: 'source' });
		assert.equal((await fill).name, 'source');
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'source');
		const stored = ConflictCachingTable.primaryStore.getSync(id);
		assert.equal(stored.createdAt.getTime(), racedCreatedAt.getTime());
		const oldIndex = [];
		for await (const record of ConflictCachingTable.search({ conditions: [{ attribute: 'name', value: 'older' }] }))
			oldIndex.push(record);
		assert.equal(oldIndex.length, 0);
		const sourceIndex = [];
		for await (const record of ConflictCachingTable.search({ conditions: [{ attribute: 'name', value: 'source' }] }))
			sourceIndex.push(record);
		assert.deepEqual(
			sourceIndex.map((record) => record.id),
			[id]
		);
	});

	it('revalidation retains exact-CAS when a lower-version write races the source', async function () {
		const id = 612;
		await ConflictCachingTable.put(id, { id, name: 'seed' });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'seed');
		await ConflictCachingTable.invalidate(id);
		await waitFor(() => ConflictCachingTable.primaryStore.getEntry(id)?.metadataFlags & INVALIDATED);
		conflictSourceRequest = null;
		const sourceTimestamp = nextConflictTimestamp();
		const fill = ConflictCachingTable.get(id, { timestamp: sourceTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		await ConflictCachingTable.put(id, { id, name: 'raced' }, { timestamp: sourceTimestamp - 1 });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'raced');
		assert(ConflictCachingTable.primaryStore.getEntry(id).version < sourceTimestamp);
		const racedVersion = ConflictCachingTable.primaryStore.getEntry(id).version;
		conflictSourceRequest.respond({ id, name: 'source' });
		assert.equal((await fill).name, 'source');
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		assert.equal(ConflictCachingTable.primaryStore.getSync(id).name, 'raced');
		assert.equal(ConflictCachingTable.primaryStore.getEntry(id).version, racedVersion);
	});

	it('source deletion does not remove a record that raced the fill', async function () {
		const id = 613;
		const sourceTimestamp = nextConflictTimestamp();
		conflictSourceRequest = null;
		const fill = ConflictCachingTable.get(id, { timestamp: sourceTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		await ConflictCachingTable.put(id, { id, name: 'older-delete' }, { timestamp: sourceTimestamp - 1 });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'older-delete');
		assert(ConflictCachingTable.primaryStore.getEntry(id).version < sourceTimestamp);
		const racedVersion = ConflictCachingTable.primaryStore.getEntry(id).version;
		conflictSourceRequest.respond(undefined);
		assert.equal(await fill, undefined);
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		assert.equal(ConflictCachingTable.primaryStore.getEntry(id).version, racedVersion);
		const indexed = [];
		for await (const record of ConflictCachingTable.search({
			conditions: [{ attribute: 'name', value: 'older-delete' }],
		}))
			indexed.push(record);
		assert.deepEqual(
			indexed.map((record) => record.id),
			[id]
		);
	});

	it('caps a source-reported version ahead of local time so later local writes still land', async function () {
		const id = 621;
		conflictSourceRequest = null;
		// no request timestamp: the ceiling is local time, which is what a skewed source clock outruns
		const fill = ConflictCachingTable.get(id);
		await waitFor(() => conflictSourceRequest?.id === id);
		const futureVersion = Date.now() + 10_000_000;
		conflictSourceRequest.respond({ id, name: 'source-future' }, futureVersion);
		assert.equal((await fill).name, 'source-future');
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		const filled = ConflictCachingTable.primaryStore.getEntry(id);
		assert(
			filled.version < futureVersion,
			`a future source version (${futureVersion}) must not become the record version (${filled.version})`
		);
		// the point of the cap: an ordinary local write is not resequenced away behind the source's floor
		await ConflictCachingTable.put(id, { id, name: 'later-write' });
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'later-write', {
			message: 'a local write after a future-dated fill must not be silently discarded',
		});
		assert(ConflictCachingTable.primaryStore.getEntry(id).version > filled.version);
	});

	it('keeps a raced record when a first fill ties its version', async function () {
		const id = 622;
		// The raced record is attributed to a peer whose name sorts *before* this node's, so
		// precedesExistingVersion() would break the tie in the fill's favor here and in the peer's favor
		// on a node whose name sorts before it — the divergence the fill guard must not depend on.
		const peerNodeId = ConflictCachingTable.auditStore.ensureLogExists('!tie-peer');
		const localNodeName = Object.keys(exportIdMapping(ConflictCachingTable.auditStore)).find(
			(name) => name !== '!tie-peer'
		);
		assert('!tie-peer' < localNodeName, 'the peer node name must sort before this node for this test to bite');
		const sourceTimestamp = nextConflictTimestamp();
		conflictSourceRequest = null;
		const fill = ConflictCachingTable.get(id, { timestamp: sourceTimestamp });
		await waitFor(() => conflictSourceRequest?.id === id);
		await applyFromPeer(id, { id, name: 'raced-tie' }, sourceTimestamp, peerNodeId);
		await waitFor(() => ConflictCachingTable.primaryStore.getSync(id)?.name === 'raced-tie');
		const racedEntry = ConflictCachingTable.primaryStore.getEntry(id);
		assert.equal(racedEntry.version, sourceTimestamp);
		conflictSourceRequest.respond({ id, name: 'source-tie' }, sourceTimestamp);
		assert.equal((await fill).name, 'source-tie');
		await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(id));
		assert.equal(ConflictCachingTable.primaryStore.getSync(id).name, 'raced-tie');
		assert.equal(ConflictCachingTable.primaryStore.getEntry(id).version, racedEntry.version);
	});

	it('converges on the same entry whether the raced write lands during or after the fill', async function () {
		// The same two effects (a first fill at `sourceVersion`, a local write at `writeVersion`) applied in
		// both orders must leave the same (version, value) — the property the single-ordering tests above
		// each pin one instance of. Two replicas resolving the same missing key see exactly this pair of
		// orderings when a write races the fetch on one of them.
		let id = 630;
		// a base in the past: the source-version cap is local time, so a future base would clamp the
		// reported versions together and collapse the two cases this is comparing
		const base = Date.now() - 60_000;
		const commitWrite = async (key, record, timestamp) => {
			const context = { timestamp };
			await transaction(context, () => {
				ConflictCachingTable.put(key, record, context);
			});
		};
		for (const sourceWins of [true, false]) {
			const results = [];
			const sourceVersion = sourceWins ? base + 100 : base;
			const writeVersion = sourceWins ? base : base + 100;
			for (const writeDuringFetch of [true, false]) {
				const key = id++;
				const fillWith = { id: key, name: 'source' };
				const writeWith = { id: key, name: 'write' };
				conflictSourceRequest = null;
				const fill = ConflictCachingTable.get(key, { timestamp: base });
				await waitFor(() => conflictSourceRequest?.id === key);
				if (writeDuringFetch) {
					await commitWrite(key, writeWith, writeVersion);
					conflictSourceRequest.respond(fillWith, sourceVersion);
					await fill;
					await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(key));
				} else {
					conflictSourceRequest.respond(fillWith, sourceVersion);
					await fill;
					await waitFor(() => !ConflictCachingTable.primaryStore.hasLock(key));
					await commitWrite(key, writeWith, writeVersion);
				}
				const entry = ConflictCachingTable.primaryStore.getEntry(key);
				results.push({ name: entry.value.name, version: entry.version });
			}
			assert.deepEqual(
				results[0],
				results[1],
				`fill@${sourceWins ? 'newer' : 'older'} must converge regardless of when the raced write lands`
			);
			assert.equal(results[0].name, sourceWins ? 'source' : 'write');
		}
	});

	it('does not backdate a write the source performs while resolving', async function () {
		const id = 640;
		const sideId = 641;
		const requestTimestamp = Date.now() - 3_600_000;
		const before = Date.now();
		conflictSourceWriteId = sideId;
		try {
			conflictSourceRequest = null;
			const fill = ConflictCachingTable.get(id, { timestamp: requestTimestamp });
			await waitFor(() => conflictSourceRequest?.id === id);
			assert.equal(conflictSourceRequest.timestamp, undefined);
			conflictSourceRequest.respond({ id, name: 'source-with-write' });
			await fill;
			await waitFor(() => ConflictSideEffectTable.primaryStore.getSync(sideId)?.name === 'side-effect');
			const sideEntry = ConflictSideEffectTable.primaryStore.getEntry(sideId);
			assert(
				sideEntry.version >= before,
				`a source-side write must carry its own transaction time (${sideEntry.version}), not the inherited request timestamp (${requestTimestamp})`
			);
		} finally {
			conflictSourceWriteId = null;
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
		const indexedEvents = [];
		const indexedSubscription = await IndexedCachingTable.subscribe({});
		indexedSubscription.on('data', (event) => {
			indexedEvents.push(event);
		});
		let fenceId = 24;
		// publications are delivered in commit order, so a delivered fill of a scratch id proves
		// everything committed before it has been delivered too
		const fenceEvents = async () => {
			const id = fenceId++;
			await IndexedCachingTable.get(id);
			await waitFor(() => indexedEvents.some((event) => event.id === id), {
				message: 'the fencing source fill should reach the indexed subscription',
			});
		};
		try {
			sourceRequests = 0;
			IndexedCachingTable.setTTLExpiration({ expiration: 50, eviction: 100 });
			const firstExpiresAt = (sourceExpiresAt = Date.now() + 1);
			let result = await IndexedCachingTable.get(23);
			assert.equal(result.id, 23);
			await waitFor(() => !IndexedCachingTable.primaryStore.hasLock(23), {
				message: 'initial source fill should finish committing',
			});
			assert.equal(result.name, 'name ' + 23);
			assert.equal(sourceRequests, 1);
			await waitFor(
				() =>
					IndexedCachingTable.primaryStore.getEntry(23)?.expiresAt === firstExpiresAt && firstExpiresAt < Date.now(),
				{
					message: 'initial source fill should expire',
				}
			);
			const revalidatedExpiresAt = (sourceExpiresAt = Date.now() + 1000);
			let results = [];
			for await (let record of IndexedCachingTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
				results.push(record);
			}
			assert.equal(results.length, 1);
			// every revalidation this query can trigger starts before the refreshed entry commits, so
			// waiting on the commit makes the count below exact rather than a floor
			await waitFor(
				() =>
					IndexedCachingTable.primaryStore.getEntry(23)?.expiresAt === revalidatedExpiresAt &&
					!IndexedCachingTable.primaryStore.hasLock(23),
				{ message: 'indexed query should revalidate the expired entry and commit the refreshed cache write' }
			);
			assert.equal(sourceRequests, 2);
			result = await IndexedCachingTable.get(23);
			assert.equal(result.id, 23);
			await IndexedCachingTable.invalidate(23);
			const secondExpiresAt = (sourceExpiresAt = Date.now() + 1);
			await IndexedCachingTable.get(23);
			await waitFor(() => !IndexedCachingTable.primaryStore.hasLock(23), {
				message: 'second source fill should finish committing',
			});
			await waitFor(
				() =>
					IndexedCachingTable.primaryStore.getEntry(23)?.expiresAt === secondExpiresAt && secondExpiresAt < Date.now(),
				{
					message: 'second source fill should expire',
				}
			);
			await fenceEvents();
			indexedEvents.length = 0;
			sourceExpiresAt = Date.now() + 1000;
			sourceRequests = 0;
			result = await IndexedCachingTable.get(23);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert.equal(sourceRequests, 1);
			assert(result.getExpiresAt());
			await waitFor(() => !IndexedCachingTable.primaryStore.hasLock(23), {
				message: 'source revalidation lock should be released',
			});
			await fenceEvents();
			assert.deepEqual(
				indexedEvents.filter((event) => event.id === 23),
				[],
				'source revalidation should not publish an update event'
			);
			const entry = IndexedCachingTable.primaryStore.getEntry(23);
			assert(entry, 'source revalidation should leave a cache entry to evict');
			await IndexedCachingTable.evict(23, entry.value, entry.version);
			// evict should completely eliminate the record
			await waitFor(() => IndexedCachingTable.primaryStore.getSync(23) === undefined, {
				message: 'eviction should remove the primary record',
			});
			await waitFor(() => IndexedCachingTable.indices.name.getValuesCount('name 23') === 0, {
				message: 'eviction should remove the secondary index entry',
			});
		} finally {
			sourceExpiresAt = undefined;
			indexedSubscription.close();
		}
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
