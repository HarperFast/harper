require('../testUtils');
const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Exercises the RocksDB batched-eviction path in Table.ts's cleanup scan: when more than
// EVICTION_BATCH_SIZE (100) records are evictable in a single scan, removals are coalesced into
// shared transactions instead of one commit per record. LMDB keeps the per-record path (its async
// writes are already coalesced per event turn), so this is RocksDB-only.
//
// Eviction is verified against the *raw* store (primaryStore.getSync / index getValuesCount), not a
// resource get(): a get() on a sourced table revalidates an expired entry from the source whether or
// not the cleanup scan removed it, so it can't distinguish eviction from normal TTL revalidation.
//
// Each record is stored with an expiresAt ~5ms out. To keep records resident through warming (caching
// writes arm the cleanup scan themselves), warming runs with a long eviction window so nothing is
// evictable yet; the eviction window is then shortened to drive the scan deterministically.
describe('Batched eviction (RocksDB)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let EvictTable;
	let RetryTable;

	const makeSource = () =>
		class extends Resource {
			get() {
				const id = this.getId();
				this.getContext().expiresAt = Date.now() + 5;
				return { id, name: 'group ' + (Number(id) % 10) };
			}
		};

	const residentCount = (store, ids) =>
		ids.reduce((c, id) => c + (store.primaryStore.getSync(id) !== undefined ? 1 : 0), 0);

	// Cache-fill writes commit asynchronously after get() resolves, so poll until they all land. Under
	// HOLD the cleanup scan can't evict, so the resident count only grows toward the full set.
	async function waitForResident(store, ids) {
		let resident = residentCount(store, ids);
		for (let attempt = 0; attempt < 50 && resident < ids.length; attempt++) {
			await delay(20);
			resident = residentCount(store, ids);
		}
		return resident;
	}

	const HOLD = { expiration: 0.005, eviction: 3600 }; // expired but not evictable for an hour
	const EVICT_NOW = { expiration: 0.005, eviction: 0.005 }; // evictable ~10ms after write

	// Drive the background cleanup scan until the raw store no longer holds any of `ids`.
	async function evictAndWait(store, ids) {
		let resident = ids.length;
		for (let attempt = 0; attempt < 80 && resident > 0; attempt++) {
			store.setTTLExpiration(EVICT_NOW);
			await delay(25);
			resident = residentCount(store, ids);
		}
		return resident;
	}

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		EvictTable = table({
			table: 'EvictBatchTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		EvictTable.sourcedFrom(makeSource());
		RetryTable = table({
			table: 'EvictRetryTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		RetryTable.sourcedFrom(makeSource());
	});

	it('physically evicts >EVICTION_BATCH_SIZE records across multiple batches and cleans indices', async function () {
		const N = 250; // > EVICTION_BATCH_SIZE (100) so the scan must commit multiple batches
		const ids = Array.from({ length: N }, (_, i) => i);
		EvictTable.setTTLExpiration(HOLD); // keep records resident through warming
		for (const id of ids) await EvictTable.get(id);

		// Sanity: records and their index entries are resident before eviction.
		assert.equal(await waitForResident(EvictTable, ids), N, 'records should be resident after warming');
		assert.equal(
			EvictTable.indices['name'].getValuesCount('group 7'),
			N / 10,
			'index should be populated before eviction'
		);

		// No resource get() here — the only thing that can remove these records is the batched scan.
		const resident = await evictAndWait(EvictTable, ids);
		assert.equal(resident, 0, 'cleanup scan should physically evict every expired record');
		assert.equal(
			EvictTable.indices['name'].getValuesCount('group 7'),
			0,
			'index entries must be removed with the records'
		);
	});

	it('recovers from an optimistic commit conflict (ERR_BUSY) and still evicts', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		let injected = false;
		let armed = false;
		// Inject a single ERR_BUSY into the first commit after arming, simulating an optimistic
		// write-write conflict. The batcher must abort, re-stage into a fresh transaction, and commit.
		Transaction.prototype.commit = async function (...args) {
			if (armed && !injected) {
				injected = true;
				const error = new Error('injected optimistic conflict');
				error.code = 'ERR_BUSY';
				throw error;
			}
			return originalCommit.apply(this, args);
		};

		const ids = [1000, 1001, 1002, 1003, 1004];
		try {
			RetryTable.setTTLExpiration(HOLD); // keep records resident (and un-evicted) until the conflict is armed
			for (const id of ids) await RetryTable.get(id);
			assert.equal(await waitForResident(RetryTable, ids), ids.length, 'records should be resident after warming');

			armed = true; // the next commit (an eviction-batch commit) will hit the injected conflict
			const resident = await evictAndWait(RetryTable, ids);
			assert(injected, 'the injected ERR_BUSY conflict should have fired on a commit');
			assert.equal(resident, 0, 'eviction should still complete after retrying the conflicting batch');
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
	});
});
