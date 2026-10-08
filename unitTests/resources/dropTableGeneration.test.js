'use strict';

require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const {
	table,
	database,
	databases,
	resetDatabases,
	openRocksDatabase,
	setDroppedBlobSweepBatchMsForTesting,
	getTableDrops,
	markDropInProgress,
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

	it('keeps first-time creates readable by legacy readers and stamps every store of a recreate', async function () {
		if (IS_LMDB) return this.skip();
		const First = defineTable('GenStamped');
		assert.equal(dbisDb().getSync('GenStamped/').generation, undefined);
		assert.equal(First.primaryStore.name, 'GenStamped/');
		assert.equal(First.indices.str.name, 'GenStamped/str');
		await First.dropTable();
		resetDatabases();
		assert.deepStrictEqual(generationRows(), [], 'the recreate is stamped even after retirement finishes');
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

	it('keeps local-only name history after reclamation without advertising a replicated drop', async function () {
		if (IS_LMDB) return this.skip();
		const First = defineTable('GenLocalDrop');
		assert.equal(First.storageGeneration, undefined);
		await First.dropTable({ localOnly: true });
		resetDatabases();
		assert.ok(dbisDb().getSync('/dropped/GenLocalDrop'));
		assert.ok(!getTableDrops(TEST_DB).some(({ table }) => table === 'GenLocalDrop'));
		assert.deepStrictEqual(generationRows(), []);
		const Fresh = defineTable('GenLocalDrop');
		assert.match(Fresh.storageGeneration, /^[0-9a-f-]{36}$/);
		assert.notEqual(Fresh.primaryStore.name, First.primaryStore.name);
		await Fresh.dropTable();
	});

	it('persists the local store name when a peer primary attribute carries a generation', async function () {
		const PeerDefined = table({
			database: TEST_DB,
			table: 'GenPeerStamp',
			origin: 'cluster',
			attributes: [{ name: 'id', isPrimaryKey: true, generation: randomUUID() }],
		});
		assert.equal(dbisDb().getSync('GenPeerStamp/').generation, undefined);
		await PeerDefined.put({ id: 1 });
		resetDatabases();
		const Reloaded = databases[TEST_DB].GenPeerStamp;
		assert.equal((await Reloaded.get(1)).id, 1);
		await Reloaded.dropTable();
	});

	it('does not retire catalog stores after a schema listener completes the drop and recreates the table', async function () {
		if (IS_LMDB) return this.skip();
		const First = defineTable('GenListenerRecreate');
		let Fresh;
		const removeListener = schemaHandler.addListener((message) => {
			if (message.operation === 'drop_table' && message.table === First.tableName && !Fresh)
				Fresh = defineTable(First.tableName, [{ name: 'replacementOnly', type: 'String', indexed: true }]);
		});
		try {
			await First.dropTable({ localOnly: true });
		} finally {
			removeListener();
		}
		assert.ok(Fresh, 'the recreate runs before the old drop resumes from its broadcast');
		await Fresh.put({ id: 1, str: 'replacement' });
		assert.equal((await Fresh.get(1)).str, 'replacement');
		assert.ok(!generationRows().some(({ value }) => value.stores?.includes(Fresh.primaryStore.name)));
		assert.ok(
			!generationRows().some(
				({ value }) =>
					value.table === Fresh.tableName &&
					value.stores?.some((name) => name.startsWith(`${Fresh.tableName}/replacementOnly`))
			),
			'the resumed drop must not journal the replacement catalog'
		);
		await Fresh.dropTable();
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

	it('preserves bare stores and blobs recreated by a legacy writer despite a retired journal', async function () {
		if (IS_LMDB) return this.skip();
		const First = defineTable('GenLegacyRecreate', [{ name: 'oldOnly', type: 'String', indexed: true }]);
		await First.put({ id: 1, str: 'retired' });
		await First.dropTable();
		const retired = generationRows().find(({ value }) => value.table === First.tableName);
		assert.ok(retired);
		// 5.2 ignores the drop marker and journal when it chooses physical names.
		dbisDb().removeSync(retired.key);
		dbisDb().removeSync('/dropped/' + First.tableName);
		const Fresh = defineTable(First.tableName, [{ name: 'blob', type: 'Blob' }]);
		assert.equal(Fresh.primaryStore.name, First.tableName + '/');
		const blob = await createBlob(Buffer.alloc(50_000, 3));
		await Fresh.put({ id: 2, str: 'rollback', blob });
		const blobPath = getFilePathForBlob((await Fresh.get(2)).blob);
		openRocksDatabase(rootStore().path, { name: First.tableName + '/oldOnly' }).close();
		dbisDb().putSync(retired.key, retired.value);
		resetDatabases();
		await waitFor(() => !dbisDb().getSync(retired.key), { timeout: 15_000 });
		const Reloaded = databases[TEST_DB][First.tableName];
		assert.equal((await Reloaded.get(2)).str, 'rollback');
		assert.deepStrictEqual(
			(await fromAsync(Reloaded.search({ conditions: [{ attribute: 'str', value: 'rollback' }] }))).map(({ id }) => id),
			[2]
		);
		assert.ok(fs.existsSync(blobPath), 'reclaiming an old journal must not unlink a live blob');
		assert.ok(
			!rootStore().columns.includes(First.tableName + '/oldOnly'),
			'unowned retired stores still get reclaimed'
		);
		await Reloaded.dropTable();
	});

	it('keeps the retirement journal complete under a redundant concurrent drop', async function () {
		if (IS_LMDB) return this.skip();
		const Twice = defineTable('GenDoubleDrop');
		await Twice.put({ id: 1, str: 'x' });
		const family = Twice.primaryStore.name;
		await Promise.all([Twice.dropTable(), Twice.dropTable()]);
		assert.deepStrictEqual(catalogRows('GenDoubleDrop'), []);
		const journal = generationRows().find(({ value }) => value.table === 'GenDoubleDrop')?.value;
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
		const First = defineTable('GenDelayedDrop');
		const oldTableId = First.tableId;
		let broadcast;
		const removeListener = schemaHandler.addListener((message) => {
			if (message.table === 'GenDelayedDrop' && message.dropTableId === oldTableId) broadcast = message;
		});
		try {
			await First.dropTable();
			await waitFor(() => broadcast, { timeout: 5_000, message: 'drop broadcast did not carry the table identity' });
		} finally {
			removeListener();
		}
		assert.equal(broadcast.dropTableId, oldTableId);
		if (!IS_LMDB) assert.match(broadcast.dropGeneration, /^[0-9a-f-]{36}$/);
		const Replacement = defineTable('GenDelayedDrop');
		await Replacement.put({ id: 1, str: 'replacement' });
		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: 'drop_table',
				schema: TEST_DB,
				table: 'GenDelayedDrop',
			},
		});
		assert.equal((await Replacement.get(1)).str, 'replacement');
		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: 'drop_table',
				schema: TEST_DB,
				table: 'GenDelayedDrop',
				dropGeneration: broadcast.dropGeneration,
				dropTableId: oldTableId,
			},
		});
		assert.equal((await Replacement.get(1)).str, 'replacement');
		await Replacement.dropTable();
	});

	it('disposes the current class for a matching tagged drop event', async function () {
		const Current = defineTable('GenTaggedDrop');
		await Current.put({ id: 1, str: 'current' });
		await schemaHandler({
			type: 'schema',
			message: {
				originator: process.pid,
				operation: 'drop_table',
				schema: TEST_DB,
				table: 'GenTaggedDrop',
				dropGeneration: Current.storageGeneration,
				dropTableId: Current.tableId,
			},
		});
		await assert.rejects(async () => Current.get(1), /has been dropped or unloaded/);
		const Reloaded = databases[TEST_DB].GenTaggedDrop;
		assert.notEqual(Reloaded, Current);
		assert.equal((await Reloaded.get(1)).str, 'current');
		await Reloaded.dropTable();
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
			const generation = randomUUID();
			const family = Doomed.primaryStore.name;
			// the drop died after writing its journal row and removing the catalog rows, before the
			// physical drop landed: the family is still on disk under its name
			dbisDb().putSync(`${GENERATION_ROW_PREFIX}${generation}`, {
				table: 'GenCrashRetired',
				generation,
				phase: 'retired',
				stores: [family, Doomed.indices.str.name],
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

		it('reclaims primary and index stores of an unpublished legacy create', function () {
			const generation = randomUUID();
			const stores = ['GenBareCrash/', 'GenBareCrash/str'];
			dbisDb().putSync(`${GENERATION_ROW_PREFIX}${generation}`, {
				table: 'GenBareCrash',
				generation,
				phase: 'creating',
				primaryStore: stores[0],
				creatingStores: stores,
			});
			for (const name of stores) {
				const orphan = openRocksDatabase(rootStore().path, { name });
				orphan.putSync(1, { id: 1 });
				orphan.close();
			}
			resetDatabases();
			assert.ok(stores.every((name) => !rootStore().columns.includes(name)));
			assert.deepStrictEqual(generationRows(), []);
		});

		it('preserves a published legacy create whose journal removal was interrupted', async function () {
			const Published = defineTable('GenBarePublished');
			assert.equal(Published.primaryStore.name, 'GenBarePublished/');
			await Published.put({ id: 1, str: 'published' });
			const generation = randomUUID();
			const row = {
				table: Published.tableName,
				generation,
				phase: 'creating',
				primaryStore: Published.primaryStore.name,
				creatingStores: [Published.primaryStore.name, Published.indices.str.name],
			};
			dbisDb().putSync(`${GENERATION_ROW_PREFIX}${generation}`, row);
			resetDatabases();
			const Reloaded = databases[TEST_DB].GenBarePublished;
			assert.equal((await Reloaded.get(1)).str, 'published');
			assert.deepStrictEqual(generationRows(), []);
			await Reloaded.dropTable();
		});

		it('leaves a published legacy family to the dropper when its create journal survived publication', async function () {
			const Dropping = defineTable('GenPublishedDropping');
			await Dropping.put({ id: 1, str: 'owned by the dropper' });
			const generation = randomUUID();
			dbisDb().putSync(`${GENERATION_ROW_PREFIX}${generation}`, {
				table: Dropping.tableName,
				generation,
				phase: 'creating',
				primaryStore: Dropping.primaryStore.name,
				creatingStores: [Dropping.primaryStore.name, Dropping.indices.str.name],
			});
			const primary = dbisDb().getSync(`${Dropping.tableName}/`);
			primary.dropping = true;
			primary.dropGeneration = randomUUID();
			dbisDb().putSync(`${Dropping.tableName}/`, primary);
			const releaseDrop = markDropInProgress(primary.dropGeneration);
			try {
				resetDatabases();
				assert.ok(
					rootStore().columns.includes(Dropping.primaryStore.name),
					'create recovery must not retire a live drop'
				);
				assert.equal(Dropping.primaryStore.getSync(1).str, 'owned by the dropper');
			} finally {
				releaseDrop();
				resetDatabases();
			}
		});

		it('journals an interrupted legacy catalog whose primary row carries its attribute name', async function () {
			const Legacy = defineTable('GenLegacyPrimary');
			const primary = dbisDb().getSync('GenLegacyPrimary/');
			const generation = randomUUID();
			const primaryKey = 'GenLegacyPrimary/id';
			const family = primaryKey;
			Legacy.primaryStore.dropSync();
			const legacyStore = openRocksDatabase(rootStore().path, { name: family });
			legacyStore.putSync(1, { id: 1, str: 'legacy' });
			legacyStore.close();
			primary.dropping = true;
			primary.dropGeneration = generation;
			dbisDb().removeSync('GenLegacyPrimary/');
			dbisDb().putSync(primaryKey, { ...primary, key: primaryKey });
			delete databases[TEST_DB].GenLegacyPrimary;

			resetDatabases();

			const journal = dbisDb().getSync(`${GENERATION_ROW_PREFIX}${generation}`);
			assert.equal(journal.primaryStore, family);
			assert.ok(journal.stores.includes(family));
			await waitFor(() => !rootStore().columns.includes(family) && !generationRows().length, {
				timeout: 15_000,
				message: 'legacy named-primary generation was not reclaimed',
			});
		});

		it('keeps a migrated bare tombstone until after its named primary descriptor is removed', async function () {
			const Migrated = defineTable('GenMigratedPrimary');
			const bare = dbisDb().getSync('GenMigratedPrimary/');
			const generation = randomUUID();
			const primaryKey = 'GenMigratedPrimary/id';
			const family = primaryKey;
			Migrated.primaryStore.dropSync();
			const migratedStore = openRocksDatabase(rootStore().path, { name: family });
			migratedStore.putSync(1, { id: 1, str: 'migrated' });
			migratedStore.close();
			dbisDb().putSync(primaryKey, { ...bare, key: primaryKey });
			dbisDb().putSync('GenMigratedPrimary/', {
				...bare,
				isPrimaryKey: false,
				dropping: true,
				dropGeneration: generation,
			});
			delete databases[TEST_DB].GenMigratedPrimary;

			resetDatabases();

			const journal = dbisDb().getSync(`${GENERATION_ROW_PREFIX}${generation}`);
			assert.equal(journal.primaryStore, family);
			assert.ok(journal.stores.includes(family));
			await waitFor(() => !rootStore().columns.includes(family) && !generationRows().length, {
				timeout: 15_000,
				message: 'migrated named-primary generation was not reclaimed',
			});
		});

		it('completes a tombstoned drop by exact store name, leaving a live same-name generation alone', async function () {
			await defineTable('GenTombstoneExact').dropTable();
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
