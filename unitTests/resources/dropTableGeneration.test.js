'use strict';

require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const {
	table,
	database,
	databases,
	resetDatabases,
	openRocksDatabase,
	setDroppedBlobSweepBatchMsForTesting,
} = require('#src/resources/databases');
const { createBlob, getFilePathForBlob } = require('#src/resources/blob');
const { logger } = require('#src/utility/logging/logger');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { derivedIndexReadiness } = require('#src/resources/indexes/hnswDerivedIndex');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { schemaHandler } = require('#js/server/itc/serverHandlers');

const TEST_DB = 'test';
const IS_LMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const GENERATION_ROW_PREFIX = '/generation/';

function defineTable(name, extraAttributes = []) {
	return table({
		table: name,
		database: TEST_DB,
		attributes: [
			{ name: 'id', type: 'Int', isPrimaryKey: true },
			{ name: 'str', type: 'String', indexed: true },
			...extraAttributes,
		],
	});
}

function rootStore() {
	return database({ database: TEST_DB, table: null });
}

function dbisDb() {
	return rootStore().dbisDb;
}

function generationRows() {
	return [...dbisDb().getRange({ start: GENERATION_ROW_PREFIX, end: '/generation0' })];
}

function catalogRows(name) {
	return [...dbisDb().getRange({ start: `${name}/`, end: `${name}0` })].map(({ key }) => key);
}

const REQUIRES_DEFERRED_RECLAMATION =
	'the drop path no longer drains in-flight writes and needs a @harperfast/rocksdb-js that defers physical column-family drops behind admitted commits (rocksdb-js#850); bump the pin';
/** The binding defers a physical drop behind admitted commits (rocksdb-js#850); older bindings drop inline. */
function hasDeferredReclamation() {
	return 'columnFamily.pendingReclaims' in (rootStore().getStats?.() ?? {});
}

/** Captures logger.warn calls for the duration of `run`; the sweep after a drop reports leaks there. */
async function capturingWarnings(run) {
	const warnings = [];
	const originalWarn = logger.warn;
	logger.warn = (...args) => {
		warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
		return originalWarn?.apply(logger, args);
	};
	try {
		await run();
	} finally {
		logger.warn = originalWarn;
	}
	return warnings;
}

async function fromAsync(iterable) {
	const out = [];
	for await (const value of iterable) out.push(value);
	return out;
}

describe('dropTable generation-distinct stores', function () {
	this.timeout(60_000);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('stamps every physical store of a RocksDB table with the generation on its catalog row', async function () {
		if (IS_LMDB) return this.skip();
		const Stamped = defineTable('GenStamped');
		const generation = dbisDb().getSync('GenStamped/').generation;
		assert.match(generation, /^[0-9a-f-]{36}$/, 'the primary row carries a create-time generation');
		assert.equal(Stamped.primaryStore.name, `GenStamped/@${generation}`);
		assert.equal(Stamped.indices.str.name, `GenStamped/str@${generation}`);
		assert.ok(rootStore().columns.includes(`GenStamped/@${generation}`));
		assert.deepStrictEqual(generationRows(), [], 'a published create leaves no journal row behind');
		await Stamped.dropTable();
	});

	it('keeps catalog-key store names on LMDB', async function () {
		if (!IS_LMDB) return this.skip();
		const Plain = defineTable('GenPlain');
		assert.equal(dbisDb().getSync('GenPlain/').generation, undefined);
		assert.equal(Plain.primaryStore.name, 'GenPlain/');
		assert.equal(Plain.indices.str.name, 'GenPlain/str');
		await Plain.dropTable();
	});

	it('serves nothing from a dropped generation through a same-name recreate, primary or index', async function () {
		const First = defineTable('GenRecreate');
		await First.put({ id: 1, str: 'original' });
		const firstStore = First.primaryStore.name;
		await First.dropTable();
		assert.deepStrictEqual(catalogRows('GenRecreate'), [], 'the drop removes the catalog rows');
		const Second = defineTable('GenRecreate');
		if (!IS_LMDB) {
			assert.notEqual(Second.primaryStore.name, firstStore, 'a recreate never shares a physical store');
			assert.ok(!rootStore().columns.includes(firstStore), 'the retired family is not a registered column');
		}
		assert.equal(await Second.get(1), undefined);
		assert.deepStrictEqual(
			await fromAsync(Second.search({ conditions: [{ attribute: 'str', value: 'original' }] })),
			[],
			'the old index entries must not resolve through the new table'
		);
		await Second.put({ id: 2, str: 'recreated' });
		assert.equal((await Second.get(2)).str, 'recreated');
		await Second.dropTable();
	});

	it('releases the blob files of a dropped RocksDB table', async function () {
		if (IS_LMDB) return this.skip();
		const Blobby = defineTable('GenBlobs', [{ name: 'blob', type: 'Blob' }]);
		const blob = await createBlob(Buffer.alloc(50_000, 2));
		await Blobby.put({ id: 1, str: 'x', blob });
		const blobPath = getFilePathForBlob((await Blobby.get(1)).blob);
		assert.ok(fs.existsSync(blobPath), 'the blob file exists while the table lives');
		const warnings = await capturingWarnings(async () => {
			await Blobby.dropTable();
			await waitFor(() => !fs.existsSync(blobPath), { timeout: 15_000, message: 'the blob file was not released' });
		});
		assert.deepStrictEqual(
			warnings.filter((message) => /Could not sweep|still pending/.test(message)),
			[],
			'the sweep must read the retired generation'
		);
	});

	it('keeps the retirement journal complete under a redundant concurrent drop', async function () {
		if (IS_LMDB) return this.skip();
		const Twice = defineTable('GenDoubleDrop');
		await Twice.put({ id: 1, str: 'x' });
		const { generation } = dbisDb().getSync('GenDoubleDrop/');
		const family = Twice.primaryStore.name;
		await Promise.all([Twice.dropTable(), Twice.dropTable()]);
		assert.deepStrictEqual(catalogRows('GenDoubleDrop'), []);
		const journal = dbisDb().getSync(`${GENERATION_ROW_PREFIX}${generation}`);
		assert.ok(journal, 'the retirement row stays until a load confirms the reclaim');
		assert.ok(journal.stores.includes(family), 'the second drop must not narrow the store list');
		resetDatabases();
		assert.ok(!rootStore().columns.includes(family));
		assert.deepStrictEqual(generationRows(), []);
	});

	it('refuses new operations through a retained class after the drop', async function () {
		const Retained = defineTable('GenRetained');
		await Retained.put({ id: 1, str: 'x' });
		await Retained.dropTable();
		await assert.rejects(
			async () => Retained.get(1),
			(error) => error.statusCode === 404 && /GenRetained has been dropped/.test(error.message)
		);
		await assert.rejects(async () => Retained.put({ id: 2, str: 'y' }), /has been dropped/);
		assert.equal(databases[TEST_DB]?.GenRetained, undefined);
	});

	it('does not dispose a same-name replacement for a delayed old-generation drop event', async function () {
		if (IS_LMDB) return this.skip();
		const First = defineTable('GenDelayedDrop');
		const oldGeneration = First.storageGeneration;
		await First.dropTable();
		const Replacement = defineTable('GenDelayedDrop');
		await Replacement.put({ id: 1, str: 'replacement' });
		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: 'drop_table',
				schema: TEST_DB,
				table: 'GenDelayedDrop',
				dropGeneration: oldGeneration,
			},
		});
		assert.equal((await Replacement.get(1)).str, 'replacement');
		await Replacement.dropTable();
	});

	it('does not wait on, or fail for, a source-fill write still landing when the drop starts', async function () {
		if (IS_LMDB) return this.skip();
		assert.ok(hasDeferredReclamation(), REQUIRES_DEFERRED_RECLAMATION);
		const Cached = defineTable('GenSourceFill', [{ name: 'blob', type: 'Blob' }]);
		// a blob defers the cache write's native commit until the blob file has been written, which is
		// what lets the drop start while the commit is still in flight (the case the old drain waited for)
		let sourceBlob;
		Cached.sourcedFrom({
			get: async (id) => ({ id, str: 'from source', blob: (sourceBlob = await createBlob(Buffer.alloc(100_000, 1))) }),
			available: () => true,
		});
		const resolved = await Cached.get(7, {});
		assert.equal(resolved.str, 'from source');
		const blobPath = getFilePathForBlob(sourceBlob);
		const started = Date.now();
		const warnings = await capturingWarnings(async () => {
			await Cached.dropTable();
			assert.ok(Date.now() - started < 5_000, 'the drop must not run a drain timeout');
			// the racing commit either landed (and its blob is swept) or was refused (and the blob was
			// discarded with the aborted write): the file is gone either way
			await waitFor(() => !fs.existsSync(blobPath), {
				timeout: 15_000,
				message: 'the blob of the write that raced the drop was not released',
			});
		});
		assert.deepStrictEqual(
			warnings.filter((message) => /Could not sweep|still pending/.test(message)),
			[]
		);
		assert.deepStrictEqual(catalogRows('GenSourceFill'), []);
		// the storage environment is not poisoned by the racing commit
		const Probe = defineTable('GenSourceFillProbe');
		await Probe.put({ id: 1, str: 'writable' });
		assert.equal((await Probe.get(1)).str, 'writable');
		await Probe.dropTable();
	});

	describe('interrupted before reclamation', function () {
		before(function () {
			if (IS_LMDB) this.skip();
		});

		it('reclaims a retired generation whose family survived a crash, then lets a same-name create start clean', async function () {
			const Doomed = defineTable('GenCrashRetired', [{ name: 'blob', type: 'Blob' }]);
			const blobPaths = [];
			for (let id = 1; id <= 3; id++) {
				const blob = await createBlob(Buffer.alloc(50_000, id));
				await Doomed.put({ id, str: 'old', blob });
				blobPaths.push(getFilePathForBlob((await Doomed.get(id)).blob));
			}
			const { generation } = dbisDb().getSync('GenCrashRetired/');
			const family = Doomed.primaryStore.name;
			// the drop died after writing its journal row and removing the catalog rows, before the
			// physical drop landed: the family is still on disk under its name
			dbisDb().putSync(`${GENERATION_ROW_PREFIX}${generation}`, {
				table: 'GenCrashRetired',
				generation,
				phase: 'retired',
				primaryStore: family,
			});
			for (const key of catalogRows('GenCrashRetired')) dbisDb().removeSync(key);
			delete databases[TEST_DB].GenCrashRetired;
			assert.ok(rootStore().columns.includes(family));

			let Fresh;
			setDroppedBlobSweepBatchMsForTesting(-1);
			try {
				resetDatabases();
				await new Promise((resolve) => setImmediate(resolve));

				assert.ok(rootStore().columns.includes(family), 'the family remains durable while blob deletion is pending');
				assert.equal(generationRows().length, 1, 'the journal remains durable while blob deletion is pending');
				Fresh = defineTable('GenCrashRetired');
				assert.notEqual(Fresh.primaryStore.name, family, 'a recreate while the sweep yields gets a fresh family');
				assert.equal(await Fresh.get(1), undefined);
				await waitFor(() => blobPaths.every((path) => !fs.existsSync(path)), {
					timeout: 15_000,
					message: 'restart recovery did not release the retired generation blob',
				});
				await waitFor(() => !rootStore().columns.includes(family) && generationRows().length === 0, {
					timeout: 15_000,
					message: 'restart recovery did not retire the generation after its blob unlink completed',
				});
			} finally {
				setDroppedBlobSweepBatchMsForTesting(undefined);
			}
			await Fresh.dropTable();
		});

		it('reclaims the families of a create that died before publishing its primary row', async function () {
			const generation = 'deadbeef-dead-dead-dead-deaddeadbeef';
			dbisDb().putSync(`${GENERATION_ROW_PREFIX}${generation}`, {
				table: 'GenCrashCreate',
				generation,
				phase: 'creating',
			});
			const orphan = openRocksDatabase(rootStore().path, { name: `GenCrashCreate/@${generation}` });
			orphan.putSync(1, { id: 1 });
			orphan.close();
			assert.ok(rootStore().columns.includes(`GenCrashCreate/@${generation}`));

			resetDatabases();

			assert.ok(!rootStore().columns.includes(`GenCrashCreate/@${generation}`));
			assert.deepStrictEqual(generationRows(), []);
		});

		it('completes a tombstoned drop by exact store name, leaving a live same-name generation alone', async function () {
			const Old = defineTable('GenTombstoneExact', [{ name: 'blob', type: 'Blob' }]);
			const blob = await createBlob(Buffer.alloc(50_000, 4));
			await Old.put({ id: 1, str: 'old', blob });
			const blobPath = getFilePathForBlob((await Old.get(1)).blob);
			const oldFamily = Old.primaryStore.name;
			const meta = dbisDb().getSync('GenTombstoneExact/');
			meta.dropping = true;
			meta.dropGeneration = meta.generation;
			dbisDb().putSync('GenTombstoneExact/', meta);
			delete databases[TEST_DB].GenTombstoneExact;
			// the create path completes the interrupted drop under the lock, then creates fresh
			const Fresh = defineTable('GenTombstoneExact');
			assert.notEqual(Fresh.primaryStore.name, oldFamily);
			assert.ok(rootStore().columns.includes(oldFamily), 'the readable family remains until its blobs are swept');
			assert.ok(rootStore().columns.includes(Fresh.primaryStore.name));
			await Fresh.put({ id: 2, str: 'new' });
			// a later load must not sweep the live generation by table-name prefix
			resetDatabases();
			await waitFor(() => !fs.existsSync(blobPath) && !rootStore().columns.includes(oldFamily), {
				timeout: 15_000,
				message: 'the tombstoned generation was not swept before its family was reclaimed',
			});
			const Reloaded = databases[TEST_DB].GenTombstoneExact;
			assert.ok(rootStore().columns.includes(Reloaded.primaryStore.name));
			assert.equal((await Reloaded.get(2)).str, 'new');
			assert.equal(await Reloaded.get(1), undefined);
			await Reloaded.dropTable();
		});
	});

	describe('HNSW plane file', function () {
		before(function () {
			if (IS_LMDB || !getPlaneBinding()) this.skip();
		});
		const DIMS = 8;
		const vectorFor = (seed) => Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 7 + i));

		function defineVectorTable() {
			return table({
				table: 'GenPlane',
				database: TEST_DB,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 }, type: 'Array' },
				],
			});
		}
		async function readySearch(Table, target) {
			return waitFor(
				async () => {
					if (derivedIndexReadiness(Table.auditStore, Table.indices.vector.name).state !== 'ready') return false;
					try {
						return await Table.indices.vector.customIndex.search(
							{ target, comparator: 'sort', distance: 'cosine', ef: 200 },
							{ transaction: undefined }
						);
					} catch (error) {
						if (/rebuilding/.test(error.message)) return false;
						throw error;
					}
				},
				{ timeout: 15_000, message: 'native plane did not become searchable' }
			);
		}

		it('follows the generation, so a recreate never opens the dropped plane', async function () {
			const First = defineVectorTable();
			await First.indexingOperation;
			await First.put(1, { vector: vectorFor(1) });
			await waitFor(async () => (await readySearch(First, vectorFor(1))).some((entry) => entry.key === 1), {
				timeout: 15_000,
				message: 'the first generation did not index its record',
			});
			const firstPlane = First.indices.vector.customIndex.planeFilePath();
			assert.ok(fs.existsSync(firstPlane), 'the first generation has a plane file');
			await First.dropTable();
			assert.ok(!fs.existsSync(firstPlane), 'the drop removes the plane file');

			const Second = defineVectorTable();
			await Second.indexingOperation;
			const secondPlane = Second.indices.vector.customIndex.planeFilePath();
			assert.notEqual(secondPlane, firstPlane, 'the plane file path carries the generation');
			await Second.put(2, { vector: vectorFor(2) });
			const results = await waitFor(
				async () => {
					const found = await readySearch(Second, vectorFor(1));
					return found.some((entry) => entry.key === 2) ? found : false;
				},
				{ timeout: 15_000, message: 'the second generation did not index its record' }
			);
			assert.ok(!results.some((entry) => entry.key === 1), 'the dropped generation must not resolve');
			await Second.dropTable();
		});
	});
});
