const { setReplicaDeadline } = require('./fixtures/replicaDeadline.cjs');
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const {
	table,
	databases,
	closeDatabase,
	resetDatabases,
	__setReadOnlyModeForTest,
} = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { loadGQLSchema } = require('#src/resources/graphql');
const { transaction } = require('#src/resources/transaction');
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const {
	INVALIDATED,
	REPLICA,
	setMinReplicaScanIntervalForTesting,
	setReplicaReclaimLimitsForTesting,
} = require('#src/resources/Table');
const {
	runReclamationHandlers,
	setAvailableSpaceRatioGetter,
	getStorageReclamationPriority,
} = require('#src/server/storageReclamation');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { server } = require('#src/server/Server');
const env = require('#src/utility/environment/environmentManager');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const RESIDENCY_ID = 123;
const LIFETIME_MS = 1_000_000;
const DATABASE = 'replicaReclamation';

let threshold;
function reportPressure(priority) {
	setAvailableSpaceRatioGetter(async () => threshold / priority);
}
async function reclaimAt(priority) {
	reportPressure(priority);
	await runReclamationHandlers();
}

(isLMDB ? describe.skip : describe)('Replicas under storage pressure', function () {
	this.timeout(30_000);
	let Rows, responses, loads;
	let tables = 0;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		setAvailableSpaceRatioGetter(async () => 1);
		threshold = await getStorageReclamationPriority('any path');
	});
	after(() => {
		setAvailableSpaceRatioGetter();
		setMinReplicaScanIntervalForTesting(undefined);
	});

	function declare(name, source = true) {
		const Declared = table({
			database: DATABASE,
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
		});
		Declared.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], ['resident-a']);
		if (source) {
			Declared.sourcedFrom(
				class extends Resource {
					static async load(entry) {
						loads.push(entry.key);
						const found = responses.get(String(entry.key));
						if (found) await Declared._storeReplica(entry, found);
						return found;
					}
				},
				{ intermediateSource: true }
			);
			Declared.setTTLExpiration({ replicaExpiration: LIFETIME_MS / 1000, replicaRefreshFraction: 1 });
		}
		return Declared;
	}

	// the fixtures are all freshly written, so only the tests of the minimum age leave it in place
	const limits = (overrides) => setReplicaReclaimLimitsForTesting({ minAgeMs: 0, ...overrides });

	beforeEach(() => {
		limits();
		responses = new Map();
		loads = [];
		Rows = declare(`Rows${++tables}`);
	});
	afterEach(async () => {
		setReplicaReclaimLimitsForTesting();
		await reclaimAt(0.5);
	});

	async function stub(id, Table = Rows) {
		const context = {};
		await transaction(context, async () => {
			const resource = await Table.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id, { name: 'indexed' }, { residencyId: RESIDENCY_ID });
		});
		return Table.primaryStore.getEntry(id);
	}
	async function replica(id, remainingMs, Table = Rows) {
		const entry = await stub(id, Table);
		responses.set(String(id), {
			key: id,
			value: { id, name: 'indexed', body: `body of ${id}` },
			version: entry.version,
			originNode: server.hostname,
			fullWriteHead: entry.version,
		});
		assert.equal((await Table.get(id)).body, `body of ${id}`);
		assert.ok(Table.primaryStore.getEntry(id).metadataFlags & REPLICA, `${id} must be stored as a replica`);
		loads.length = 0;
		setReplicaDeadline(Table, id, Date.now() + remainingMs);
	}
	const isReplica = (id, Table = Rows) => Boolean(Table.primaryStore.getEntry(id).metadataFlags & REPLICA);
	function assertDemoted(id, Table = Rows) {
		const entry = Table.primaryStore.getEntry(id);
		assert.ok(entry.metadataFlags & INVALIDATED, `${id} must be a stub`);
		assert.ok(!(entry.metadataFlags & REPLICA), `${id} must not be a replica`);
		assert.equal(entry.value.body, undefined);
		assert.equal(entry.value.name, 'indexed', `${id} keeps its indexed field`);
		assert.equal(Table.primaryStore.getEntry(id).replicaDeadline, undefined, `${id} keeps no deadline`);
	}
	function assertKept(id, Table = Rows) {
		const entry = Table.primaryStore.getEntry(id);
		assert.ok(entry.metadataFlags & REPLICA, `${id} must still be a replica`);
		assert.equal(entry.value.body, `body of ${id}`);
	}

	it('demotes replicas within the window, and nothing else; a later read refetches from the owner', async () => {
		await replica('passed', -1000);
		await replica('near', LIFETIME_MS * 0.1);
		await replica('within', LIFETIME_MS * 0.45);
		await replica('beyond', LIFETIME_MS * 0.55);
		await replica('far', LIFETIME_MS * 0.9);
		await Rows.put('owned', { id: 'owned', name: 'indexed', body: 'mine' });
		const owned = Rows.primaryStore.getEntry('owned');
		const { version: stubVersion } = await stub('stub');
		const history = async (id) => (await Rows.getHistoryOfRecord(id)).length;
		const historyBefore = await history('near');

		await reclaimAt(2);

		for (const id of ['passed', 'near', 'within']) assertDemoted(id);
		for (const id of ['beyond', 'far']) assertKept(id);
		const ownedAfter = Rows.primaryStore.getEntry('owned');
		assert.equal(ownedAfter.version, owned.version);
		assert.equal(ownedAfter.value.body, 'mine');
		assert.ok(!(ownedAfter.metadataFlags & (INVALIDATED | REPLICA)));
		const stubAfter = Rows.primaryStore.getEntry('stub');
		assert.equal(stubAfter.version, stubVersion);
		assert.ok(stubAfter.metadataFlags & INVALIDATED);
		assert.equal(await history('near'), historyBefore, 'a demotion adds no audit entry');

		assert.equal((await Rows.get('near')).body, 'body of near');
		assert.deepEqual(loads, ['near'], 'the read fetched the demoted record from its owner');
		assert.ok(isReplica('near'), 'and kept it again');
	});

	it('widens the window as pressure rises, and takes every replica on a full disk', async () => {
		await replica('tenth', LIFETIME_MS * 0.1);
		await replica('half', LIFETIME_MS * 0.5);
		await replica('most', LIFETIME_MS * 0.9);
		await replica('whole', LIFETIME_MS * 0.99);

		await reclaimAt(1.25);
		assertDemoted('tenth');
		for (const id of ['half', 'most', 'whole']) assertKept(id);

		await reclaimAt(5);
		assertDemoted('half');
		for (const id of ['most', 'whole']) assertKept(id);

		await reclaimAt(20);
		assertDemoted('most');
		assertKept('whole');

		await reclaimAt(Infinity);
		assertDemoted('whole');
	});

	it('keeps a replica younger than the minimum age on a full disk', async () => {
		setReplicaReclaimLimitsForTesting();
		await replica('in the window', LIFETIME_MS * 0.5);
		await replica('just stored', LIFETIME_MS);
		await reclaimAt(Infinity);
		assertKept('in the window');
		assertKept('just stored');
	});

	it('reaches an older replica behind a batch of fresh rows with earlier deadlines', async () => {
		limits({ batch: 2, minAgeMs: 1000 });
		await replica('older', 5000);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const fresh = ['fresh-1', 'fresh-2', 'fresh-3'];
		for (const id of fresh) await replica(id, 1000);
		await reclaimAt(Infinity);
		assertDemoted('older');
		for (const id of fresh) assertKept(id);
	});

	it('reaches an older replica behind fresh rows with composite ids', async () => {
		limits({ batch: 2, minAgeMs: 1000 });
		await replica('older', 5000);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const fresh = [
			['fresh', 1],
			['fresh', 2],
			['fresh', 3],
		];
		for (const id of fresh) await replica(id, 1000);
		const started = performance.now();
		await reclaimAt(Infinity);
		assert.ok(performance.now() - started < 10_000, 'the pass moved past them rather than rescanning to its budget');
		assertDemoted('older');
		for (const id of fresh) assertKept(id);
	});

	it('reclaims a replica whose composite key starts with null', async () => {
		const key = [null, 'low'];
		await replica(key, 1000);
		await reclaimAt(10);
		assertDemoted(key);
	});

	it('does not accelerate a lifetime no longer than the minimum age', async () => {
		limits({ minAgeMs: 1500 });
		await replica('near', LIFETIME_MS);
		// past the minimum age by write time, so only the window decides
		await new Promise((resolve) => setTimeout(resolve, 1600));
		Rows.setTTLExpiration({ replicaExpiration: 1, replicaRefreshFraction: 1 });
		setReplicaDeadline(Rows, 'near', Date.now() + 700);
		await reclaimAt(Infinity);
		assertKept('near');
		await Rows.closeMaintenance();
	});

	it('demotes eligible keys in primary order, and stops once the priority falls below 1', async () => {
		limits({ batch: 2, checkEvery: 1 });
		const remaining = { e: 100, c: 300, a: 500, d: 200, b: 400 };
		for (const [id, seconds] of Object.entries(remaining)) await replica(id, seconds * 1000);
		const order = [];
		const evict = Rows.evict;
		Rows.evict = function (id, ...rest) {
			order.push(id);
			return evict.call(this, id, ...rest);
		};
		setAvailableSpaceRatioGetter(async () => {
			const kept = Object.keys(remaining).filter((id) => isReplica(id)).length;
			return threshold / (kept > 2 ? 10 : 0.5);
		});
		await runReclamationHandlers();
		assert.deepEqual(order, ['a', 'b', 'c']);
		for (const id of ['a', 'b', 'c']) assertDemoted(id);
		for (const id of ['d', 'e']) assertKept(id);
	});

	it('visits every eligible key when more than a batch share a deadline', async () => {
		limits({ batch: 2 });
		const tied = Date.now() + 1000;
		const ids = ['t1', 't2', 't3', 't4', 't5'];
		for (const id of ids) {
			await replica(id, 0);
			setReplicaDeadline(Rows, id, tied);
		}
		await replica('later', 2000);
		const order = [];
		const evict = Rows.evict;
		Rows.evict = function (id, ...rest) {
			order.push(id);
			return evict.call(this, id, ...rest);
		};
		await reclaimAt(10);
		assert.deepEqual(order, ['later', ...ids]);
		for (const id of [...ids, 'later']) assertDemoted(id);
	});

	it('stops after a batch that could demote nothing, and tries again on the next run', async () => {
		limits({ batch: 2 });
		for (const id of ['a', 'b', 'c']) await replica(id, 1000);
		const evict = Rows.evict;
		let attempts = 0;
		Rows.evict = () => {
			attempts++;
			return Promise.resolve();
		};
		await reclaimAt(10);
		assert.equal(attempts, 2, 'one batch, no spinning on entries that stay');
		for (const id of ['a', 'b', 'c']) assertKept(id);
		Rows.evict = evict;
		await reclaimAt(10);
		for (const id of ['a', 'b', 'c']) assertDemoted(id);
	});

	it('resumes a sparse pressure scan beyond its budget without skipping the next key', async () => {
		limits({ batch: 2, checkEvery: 1, budgetMs: 0 });
		for (const key of ['a', 'b', 'c', 'd']) await stub(key);
		await replica('z', 1000);
		await reclaimAt(10);
		assertKept('z');
		await reclaimAt(10);
		assertKept('z');
		await reclaimAt(10);
		assertDemoted('z');
	});

	it('finishes a batch past its budget, however long the scan took, and leaves the rest for the next run', async () => {
		limits({ batch: 2, budgetMs: 0 });
		await replica('earliest', 1000);
		await replica('next', 2000);
		await replica('last', 3000);
		await reclaimAt(10);
		assertDemoted('earliest');
		assertDemoted('last');
		assertKept('next');
		await reclaimAt(10);
		assertDemoted('next');
	});

	it('includes a deadline from a longer earlier lifetime under pressure', async () => {
		await replica('longer', LIFETIME_MS * 3);
		await replica('within', LIFETIME_MS * 0.1);
		await replica('kept', LIFETIME_MS * 0.5);
		const order = [];
		const evict = Rows.evict;
		Rows.evict = function (id, ...rest) {
			order.push(id);
			return evict.call(this, id, ...rest);
		};
		await reclaimAt(1.25);
		assert.deepEqual(order, ['longer', 'within']);
		assertKept('kept');
	});

	it('keeps a replica renewed after a pressure pass starts but before it reaches the key', async () => {
		for (const id of ['a', 'b']) await replica(id, 1000);
		const evict = Rows.evict;
		Rows.evict = async function (id, ...rest) {
			if (id === 'a') {
				const observed = Date.now();
				await waitFor(() => Date.now() > observed);
				setReplicaDeadline(Rows, 'b', Date.now() + LIFETIME_MS);
			}
			return evict.call(this, id, ...rest);
		};
		await reclaimAt(2);
		assertDemoted('a');
		assertKept('b');
	});

	it('keeps a replica renewed after the pass selected it', async () => {
		await replica('renewed', 1000);
		const evict = Rows.evict;
		Rows.evict = function (id, ...rest) {
			setReplicaDeadline(Rows, id, Date.now() + LIFETIME_MS);
			return evict.call(this, id, ...rest);
		};
		await reclaimAt(10);
		assertKept('renewed');
		assert.ok(Rows.primaryStore.getEntry('renewed').replicaDeadline > Date.now() + LIFETIME_MS / 2);
	});

	it('demotes only passed deadlines once the priority returns to 0', async () => {
		for (const id of ['a', 'b', 'c']) await replica(id, 1000);
		await reclaimAt(10);
		for (const id of ['a', 'b', 'c']) assertDemoted(id);

		await replica('near', 1000);
		await replica('passed', 1000);
		await reclaimAt(0.5);
		assertKept('near');
		assertKept('passed');

		setMinReplicaScanIntervalForTesting(20);
		Rows.setTTLExpiration({ replicaExpiration: 0.04 });
		setReplicaDeadline(Rows, 'near', Date.now() + LIFETIME_MS);
		setReplicaDeadline(Rows, 'passed', Date.now() - 1);
		await waitFor(() => !isReplica('passed'), { timeout: 5000, message: 'the sweep to demote the passed deadline' });
		assertDemoted('passed');
		assertKept('near');
		await Rows.closeMaintenance();
	});

	it('does nothing with maintenance closed, in read-only mode, or on a thread that does not own the sweep', async () => {
		await replica('a', 1000);

		await Rows.closeMaintenance();
		await reclaimAt(10);
		assertKept('a');
		Rows.resumeMaintenance();

		__setReadOnlyModeForTest(true);
		try {
			await reclaimAt(10);
			assertKept('a');
		} finally {
			__setReadOnlyModeForTest(false);
		}

		setMainIsWorker(false);
		try {
			await reclaimAt(10);
			assertKept('a');
		} finally {
			setMainIsWorker(true);
		}

		await reclaimAt(10);
		assertDemoted('a');
	});

	it('lets closeMaintenance end a pass in progress', async () => {
		for (const id of ['a', 'b', 'c']) await replica(id, 1000);
		const evict = Rows.evict;
		let closing;
		Rows.evict = function (...args) {
			closing ??= Rows.closeMaintenance();
			return evict.apply(this, args);
		};
		await reclaimAt(10);
		await closing;
		const kept = ['a', 'b', 'c'].filter((id) => isReplica(id));
		assert.ok(kept.length >= 2, `the pass stopped at closing, leaving ${kept}`);
		Rows.resumeMaintenance();
	});

	it('stands down after a full pressure scan finds only stubs and wakes on admission', async () => {
		await replica('first', 1000);
		await reclaimAt(10);
		assertDemoted('first');
		const state = new Int32Array(
			Rows.primaryStore.getUserSharedBuffer(`replica-sweep:${Rows.tableId}`, new ArrayBuffer(8))
		);
		await reclaimAt(10);
		assert.equal(Atomics.load(state, 1), 0);
		await replica('next', 1000);
		await reclaimAt(10);
		assertDemoted('next');
	});

	it('leaves the normal sweep armed after a pass', async () => {
		setMinReplicaScanIntervalForTesting(20);
		await replica('demoted', 1000);
		await reclaimAt(10);
		assertDemoted('demoted');
		await replica('expiring', 1000);
		Rows.setTTLExpiration({ replicaExpiration: 0.04 });
		setReplicaDeadline(Rows, 'expiring', Date.now() - 1);
		await waitFor(() => !isReplica('expiring'), { timeout: 5000, message: 'the sweep after the pass' });
		await Rows.closeMaintenance();
	});

	it('reclaims on a thread that came to own the sweep after loading the table, with one handler', async () => {
		const databaseName = 'replicaReclamationOwner';
		const Created = table({
			database: databaseName,
			table: 'Takeover',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			replicaExpiration: LIFETIME_MS / 1000,
			replicaRefreshFraction: 1,
		});
		Created.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], ['resident-a']);
		const entry = await stub('loaded', Created);
		const answer = {
			key: 'loaded',
			value: { id: 'loaded', name: 'indexed', body: 'body of loaded' },
			version: entry.version,
			originNode: server.hostname,
			fullWriteHead: entry.version,
		};
		assert.equal(await Created._storeReplica(entry, answer), true);
		await closeDatabase(databaseName);
		let Reloaded;
		setMainIsWorker(false);
		try {
			Reloaded = resetDatabases()[databaseName].Takeover;
			await reclaimAt(10);
			assertKept('loaded', Reloaded);
			setMainIsWorker(true);
			for (let i = 0; i < 2; i++)
				Reloaded.setTTLExpiration({
					replicaExpiration: LIFETIME_MS / 1000,
					replicaRefreshFraction: 1,
					fromSchema: true,
				});
			const evict = Reloaded.evict;
			let attempts = 0;
			Reloaded.evict = () => {
				attempts++;
				return Promise.resolve();
			};
			await reclaimAt(10);
			assert.equal(attempts, 0, 'a fresh deadline is outside the window at this priority');
			setReplicaDeadline(Reloaded, 'loaded', Date.now() + 1000);
			await reclaimAt(11);
			assert.equal(attempts, 1, 'a single handler ran on the new owner');
			Reloaded.evict = evict;
			await reclaimAt(12);
			assertDemoted('loaded', Reloaded);
		} finally {
			setMainIsWorker(true);
			await Reloaded?.closeMaintenance();
		}
	});

	describe('tables with no replicas', () => {
		const replicaCatalogRow = (Table) => Table.dbisDB.getSync(`${Table.tableName}/@replicas`);

		it('opens no deadline store on a plain table', async () => {
			const Plain = declare(`Plain${++tables}`, false);
			await Plain.put('row', { id: 'row', name: 'indexed', body: 'mine' });
			await reclaimAt(10);
			assert.equal(replicaCatalogRow(Plain), undefined);
			assert.equal(Plain.primaryStore.getEntry('row').value.body, 'mine');
			const description = await describeTable({ database: DATABASE, table: Plain.tableName });
			assert.equal(description.replica_count, undefined);
			assert.equal(description.replica_size_estimate, undefined);
		});

		it('keeps a caching table evicting through its cleanup scan, with no replica pass', async () => {
			const Cached = declare(`Cached${++tables}`, false);
			Cached.sourcedFrom(
				class extends Resource {
					get() {
						return { id: this.getId(), name: 'indexed', body: 'cached' };
					}
				}
			);
			Cached.setTTLExpiration({ expiration: 0.01, eviction: 0.01 });
			await Cached.get('cached');
			await waitFor(() => Cached.primaryStore.getEntry('cached')?.value?.body === 'cached', {
				timeout: 5000,
				message: 'the source fill to commit',
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			await reclaimAt(5);
			await waitFor(() => !Cached.primaryStore.getEntry('cached'), {
				timeout: 5000,
				message: 'the cleanup scan to evict the expired record',
			});
			assert.equal(replicaCatalogRow(Cached), undefined);
			await Cached.closeMaintenance();
		});

		it('runs both for a table with a caching source that also keeps replicas', async () => {
			await replica('kept', 1000);
			Rows.sourcedFrom(
				class extends Resource {
					get() {
						return { id: this.getId(), name: 'indexed', body: 'cached' };
					}
				},
				{ intermediateSource: true }
			);
			Rows.setTTLExpiration({ expiration: 0.01, eviction: 0.01, replicaRefreshFraction: 1 });
			await Rows.put('expired', { id: 'expired', name: 'indexed', body: 'cached' });
			await new Promise((resolve) => setTimeout(resolve, 50));
			await reclaimAt(10);
			assertDemoted('kept');
			await waitFor(() => !Rows.primaryStore.getEntry('expired'), {
				timeout: 5000,
				message: 'the cleanup scan to evict the expired record',
			});
			await Rows.closeMaintenance();
		});
	});

	describe('on a table declared @sharded', () => {
		let priorShards, priorList, priorShard;

		before(() => {
			priorShards = server.shards;
			priorList = env.get('replication_shards');
			priorShard = env.get('replication_shard');
			env.setProperty('replication_shards', [0, 1]);
			env.setProperty('replication_shard', 0);
			server.shards = new Map([
				[0, [{ name: server.hostname }]],
				[1, [{ name: 'reclamation-owner' }]],
			]);
		});
		after(() => {
			env.setProperty('replication_shards', priorList);
			env.setProperty('replication_shard', priorShard);
			server.shards = priorShards;
		});

		const flags = (Table, id) => Table.primaryStore.getEntry(id).metadataFlags;
		async function writeRows(Table, prefix, count = 16) {
			const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
			for (const id of ids) await Table.put(id, { id, tag: 'indexed', body: 'complete' });
			const replicas = ids.filter((id) => flags(Table, id) & REPLICA);
			const owned = ids.filter((id) => !(flags(Table, id) & REPLICA));
			assert.ok(replicas.length > 0 && owned.length > 0, 'the hash places rows on both sides');
			return { replicas, owned };
		}

		it('reports the last complete cleanup tally by default and scans primary flags for an exact count', async () => {
			await loadGQLSchema(`type Described @table(database: "shardedReclamation", replicaExpiration: 3600)
				@sharded(slots: 2) { id: Any @primaryKey tag: String @indexed body: String }`);
			const Table = databases.shardedReclamation.Described;
			const describeRows = (options) =>
				describeTable({ database: Table.databaseName, table: Table.tableName, ...options });
			assert.equal((await describeRows()).replica_count, undefined);
			assert.equal((await describeRows({ exact_count: true })).replica_count, 0);
			const { replicas, owned } = await writeRows(Table, 'stats');
			await reclaimAt(1.01);
			const stats = await describeRows();
			assert.equal(stats.record_count, owned.length + replicas.length);
			assert.equal(stats.replica_count, replicas.length);
			assert.ok(stats.replica_size_estimate > 0);
			assert.equal(stats.estimated_replica_range, undefined);
			const lowKey = Array.from({ length: 32 }, (_, i) => [null, i]).find(
				(key) => !Table.getRecordResidency({ key }).includes(server.hostname)
			);
			assert.ok(lowKey);
			await Table.put({ id: lowKey, tag: 'indexed', body: 'complete' });
			assert.ok(flags(Table, lowKey) & REPLICA);
			assert.equal((await describeRows()).replica_count, replicas.length);
			assert.equal((await describeRows({ exact_count: true })).replica_count, replicas.length + 1);
			limits({ batch: 1, checkEvery: 1, budgetMs: 0 });
			await reclaimAt(1.01);
			assert.equal((await describeRows()).replica_count, replicas.length, 'a partial scan cannot publish a tally');
			limits();
			await reclaimAt(1.01); // complete the suffix
			await reclaimAt(1.01); // complete a full pass
			assert.equal((await describeRows()).replica_count, replicas.length + 1);
			setReplicaDeadline(Table, lowKey, Date.now() - 1);
			await reclaimAt(1.01);
			assert.equal((await describeRows()).replica_count, replicas.length, 'exclude a committed demotion');
			assert.equal((await describeRows({ exact_count: true })).replica_count, replicas.length);
			assert.equal((await describeRows({ skip_record_count: true })).replica_count, undefined);
			await Table.clear();
			assert.equal((await describeRows({ exact_count: true })).replica_count, 0);
		});

		it('demotes an older write replica on a full disk, keeps a fresh one and every owned row', async () => {
			limits({ minAgeMs: 3000 });
			await loadGQLSchema(`type ShardedReclamation @table(database: "shardedReclamation", replicaExpiration: 3600)
				@sharded(slots: 2) {
				id: ID @primaryKey tag: String @indexed body: String
			}`);
			const Sharded = databases.shardedReclamation.ShardedReclamation;
			const older = await writeRows(Sharded, 'older');
			const versions = new Map(older.owned.map((id) => [id, Sharded.primaryStore.getEntry(id).version]));
			await new Promise((resolve) => setTimeout(resolve, 3100));
			const fresh = await writeRows(Sharded, 'fresh');

			await reclaimAt(Infinity);

			for (const id of older.replicas) {
				const demoted = Sharded.primaryStore.getEntry(id);
				assert.ok(demoted.metadataFlags & INVALIDATED, `${id} must be a stub`);
				assert.ok(!(demoted.metadataFlags & REPLICA));
				assert.equal(demoted.value.body, undefined);
				assert.equal(demoted.value.tag, 'indexed');
			}
			for (const id of fresh.replicas) {
				assert.ok(flags(Sharded, id) & REPLICA, `the fresh write ${id} stays`);
				assert.equal((await Sharded.get(id)).body, 'complete');
			}
			for (const id of older.owned) {
				const row = Sharded.primaryStore.getEntry(id);
				assert.equal(row.version, versions.get(id));
				assert.equal(row.value.body, 'complete');
				assert.ok(!(row.metadataFlags & (REPLICA | INVALIDATED)));
			}
			await Sharded.closeMaintenance();
		});

		it('keeps a fresh write replica whose deadline the record expiry capped', async () => {
			setReplicaReclaimLimitsForTesting();
			await loadGQLSchema(`type ShardedCapped @table(database: "shardedReclamation", expiration: 600, replicaExpiration: 3600)
				@sharded(slots: 2) {
				id: ID @primaryKey tag: String @indexed body: String
			}`);
			const Capped = databases.shardedReclamation.ShardedCapped;
			const { replicas } = await writeRows(Capped, 'capped');
			const deadline = Capped.primaryStore.getEntry(replicas[0]).replicaDeadline;
			assert.ok(deadline < Date.now() + 700_000, 'the record expiry capped the deadline');

			await reclaimAt(Infinity);
			for (const id of replicas) assert.ok(flags(Capped, id) & REPLICA, `the fresh write ${id} stays`);

			limits();
			await reclaimAt(Infinity);
			for (const id of replicas) assert.ok(!(flags(Capped, id) & REPLICA), `${id} is demoted past the minimum age`);
			await Capped.closeMaintenance();
		});
	});
});

(isLMDB ? describe : describe.skip)('Replicas under storage pressure on LMDB', () => {
	it('runs no replica pass and reports no replicas', async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const Rows = table({
			database: DATABASE,
			table: 'LmdbRows',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
		});
		await Rows.put('row', { id: 'row', body: 'mine' });
		setAvailableSpaceRatioGetter(async () => 0.0001);
		try {
			await runReclamationHandlers();
		} finally {
			setAvailableSpaceRatioGetter();
		}
		assert.equal((await Rows.get('row')).body, 'mine');
		assert.equal(await Rows.getReplicaStats(), undefined);
		const description = await describeTable({ database: DATABASE, table: 'LmdbRows' });
		assert.equal(description.replica_count, undefined);
	});
});
