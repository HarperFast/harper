'use strict';

require('../testUtils');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { signalSchemaChange } = require('#src/utility/signalling');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { dropSchema } = require('#src/dataLayer/schema');
const { getRegistryStatus, RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();
const {
	abandonDatabaseDrop,
	abandonRestore,
	beginDatabaseDrop,
	beginRestore,
	completeRestore,
	scanBlockedDatabaseDrops,
} = require('#src/dataLayer/restoreMarker');
const {
	databases,
	table,
	database,
	databaseDropPreparationTargets,
	closeDatabase,
	completeDatabaseDropPreparation,
	dropDatabase,
	getDatabases,
	prepareDatabaseDrop,
	resetDatabases,
} = require('#src/resources/databases');
const { databasePaths, getRootBlobPathsForDB } = require('#src/resources/blob');
const {
	onMessageByType,
	registerWorkerDataProvider,
	setMainIsWorker,
	startWorker,
} = require('#src/server/threads/manageThreads');

const WORKER_FIXTURE = join(__dirname, 'databaseAliasIdentity-thread.js');
const MESSAGE_TYPE = 'database-alias-identity-test';
const CONTROL_TYPE = 'database-alias-identity-control';

async function closeAliases(aliases) {
	for (const alias of aliases) await closeDatabase(alias);
}

async function createPhysicalStore(storageRoot, databaseName, tableName, attributes = []) {
	mkdirSync(storageRoot, { recursive: true });
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storageRoot);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});
	resetDatabases();
	const Table = table({
		database: databaseName,
		table: tableName,
		attributes: [{ name: 'id', isPrimaryKey: true }, ...attributes],
	});
	await Table.dbisDB.committed;
	await closeDatabase(databaseName);
}

function loadAliases(storageRoot, aliases) {
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storageRoot);
	env.setProperty(
		terms.CONFIG_PARAMS.DATABASES,
		Object.fromEntries(aliases.configured.map((name) => [name, { path: storageRoot }]))
	);
	return resetDatabases();
}

function assertStableIdentity({ aliases, expectedIdentity, tableName, passes = 3 }) {
	let rootStore;
	for (let pass = 0; pass < passes; pass++) {
		const databases = pass === 0 ? getDatabases() : resetDatabases();
		const aliasStores = aliases.map((name) => databases[name][tableName].primaryStore.rootStore);
		rootStore ??= aliasStores[0];
		assert(
			aliasStores.every((store) => store === rootStore),
			'aliases must share one physical root store'
		);
		assert.strictEqual(rootStore.databaseName, expectedIdentity, `identity moved on reconcile pass ${pass}`);
		databasePaths.delete(rootStore);
		const expectedBlobPaths = getRootBlobPathsForDB(aliasStores[0]);
		for (const store of aliasStores.slice(1)) assert.deepStrictEqual(getRootBlobPathsForDB(store), expectedBlobPaths);
		assert(expectedBlobPaths[0].endsWith(join('blobs', expectedIdentity)));
	}
}

function restoreEvent(restorePhase, { databaseName, databaseDir, restoreToken }) {
	return {
		originator: process.pid,
		operation: terms.OPERATIONS_ENUM.RESTORE_BACKUP,
		schema: databaseName,
		restorePhase,
		databaseDir,
		restoreToken,
		generationReplaced: true,
	};
}

function startFixtureWorker(aliases, loadOnly) {
	const queued = [];
	const waiting = [];
	let failure;
	let closing = false;
	const unregisterAliases = registerWorkerDataProvider('databaseAliasIdentityAliases', () => aliases);
	const unregisterLoadOnly = registerWorkerDataProvider('databaseAliasIdentityLoadOnly', () => loadOnly);
	let worker;
	let resolveExit;
	const exited = new Promise((resolve) => (resolveExit = resolve));
	try {
		worker = startWorker(WORKER_FIXTURE, {
			name: 'database-alias-identity-test',
			workerIndex: 1,
			threadCount: 2,
			autoRestart: false,
			onStarted(spawned) {
				spawned.on('message', (message) => {
					if (message?.type !== MESSAGE_TYPE) return;
					const waiter = waiting.shift();
					if (waiter) waiter.resolve(message);
					else queued.push(message);
				});
				spawned.on('error', (error) => {
					failure = error;
					for (const waiter of waiting.splice(0)) waiter.reject(error);
				});
				spawned.on('exit', (code) => {
					if (code !== 0 || !closing) {
						failure = new Error(`fixture worker exited with code ${code}`);
						for (const waiter of waiting.splice(0)) waiter.reject(failure);
					}
					resolveExit(code);
				});
			},
		});
	} finally {
		unregisterAliases();
		unregisterLoadOnly();
	}
	const next = () => {
		if (failure) return Promise.reject(failure);
		if (queued.length) return Promise.resolve(queued.shift());
		return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
	};
	return {
		worker,
		send(command, details = {}) {
			worker.postMessage({ type: CONTROL_TYPE, command, ...details });
		},
		async expect(event) {
			const message = await next();
			assert.strictEqual(message.event, event, `expected worker event '${event}', received '${message.event}'`);
			return message;
		},
		async close() {
			closing = true;
			this.send('close');
			await this.expect('closed');
			assert.strictEqual(await exited, 0);
		},
	};
}

describe('shared root-store database identity', function () {
	this.timeout(30000);
	let testRoot;
	let loadedAliases = [];
	let fixture;

	before(() => {
		testRoot = setupTestDBPath();
		setMainIsWorker(true);
		onMessageByType(MESSAGE_TYPE, () => {});
	});

	afterEach(async () => {
		try {
			await fixture?.close();
		} finally {
			fixture = undefined;
			await closeAliases(loadedAliases);
			loadedAliases = [];
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_BLOBPATHS, undefined);
			setupTestDBPath();
		}
	});

	after(() => setMainIsWorker(false));

	it('keeps the generic-scan identity when a configured alias reconciles the same store', async () => {
		const storageRoot = join(testRoot, 'alias-generic-first');
		const tableName = 'GenericFirst';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];

		assertStableIdentity({ aliases: loadedAliases, expectedIdentity: 'physicalalias', tableName });
	});

	it('keeps whichever configured alias initializes the shared store first', async () => {
		const storageRoot = join(testRoot, 'alias-config-first');
		const tableName = 'ConfigFirst';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		loadAliases(storageRoot, { configured: ['configuredalias', 'physicalalias'] });
		loadedAliases = ['configuredalias', 'physicalalias'];

		assertStableIdentity({ aliases: loadedAliases, expectedIdentity: 'configuredalias', tableName });
	});

	it('closes a shared LMDB environment once, without natively closing its dbis, and unregisters every alias', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-close-lmdb');
		const tableName = 'AliasCloseLmdb';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName, [{ name: 'name', indexed: true }]);
		const databases = loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		const rootStore = databases.physicalalias[tableName].primaryStore.rootStore;
		assert.strictEqual(databases.configuredalias[tableName].primaryStore.rootStore, rootStore);
		const nativeCloses = [];
		const dbis = [rootStore.dbisDb];
		for (const alias of loadedAliases) {
			const Table = databases[alias][tableName];
			dbis.push(Table.primaryStore, ...Object.values(Table.indices));
		}
		assert.strictEqual(new Set(dbis.map((store) => store.db)).size, 5, 'each alias must hold its own native dbis');
		// recorded, not forwarded: on the unfixed path the second alias's call is the use-after-free
		for (const store of dbis) {
			Object.defineProperty(store.db, 'close', { value: () => nativeCloses.push(store.name), configurable: true });
		}

		assert.strictEqual(await closeDatabase('physicalalias'), true);
		assert.deepStrictEqual(nativeCloses, []);
		assert.notStrictEqual(rootStore.status, 'open');
		const remaining = getDatabases();
		assert.strictEqual(remaining.physicalalias, undefined);
		assert.strictEqual(remaining.configuredalias, undefined);
		assert.strictEqual(await closeDatabase('configuredalias'), false);
		assert.deepStrictEqual(nativeCloses, []);

		const reopened = loadAliases(storageRoot, { configured: ['configuredalias'] });
		assert.notStrictEqual(reopened.configuredalias[tableName].primaryStore.rootStore, rootStore);
		await reopened.physicalalias[tableName].put({ id: 'written-through-physical', name: 'shared' });
		assert.strictEqual((await reopened.configuredalias[tableName].get('written-through-physical')).name, 'shared');
	});

	it('releases every RocksDB handle and unregisters every alias when one alias closes', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-close-rocks');
		const tableName = 'AliasCloseRocks';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName, [{ name: 'name', indexed: true }]);
		const databases = loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		const { path } = databases.physicalalias[tableName].primaryStore.rootStore;
		assert.strictEqual(databases.configuredalias[tableName].primaryStore.rootStore.path, path);
		const handlesOn = () => getRegistryStatus().find((db) => db.path === path)?.refCount ?? 0;
		assert(handlesOn() > 0);

		assert.strictEqual(await closeDatabase('physicalalias'), true);
		loadedAliases = [];
		assert.strictEqual(handlesOn(), 0);
		const remaining = getDatabases();
		assert.strictEqual(remaining.physicalalias, undefined);
		assert.strictEqual(remaining.configuredalias, undefined);
		assert.strictEqual(await closeDatabase('configuredalias'), false);
	});

	it('fences every alias between destructive preparation and completion', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop-fence');
		const tableName = 'AliasDropFence';
		const preparationId = 'alias-drop-fence-test';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		const { rootPaths } = databaseDropPreparationTargets('physicalalias');
		const databaseNames = ['physicalalias', 'configuredalias'];

		try {
			await prepareDatabaseDrop('physicalalias', preparationId, 0, rootPaths);
			for (const name of databaseNames) {
				assert.throws(
					() => database({ database: name }),
					(error) => error.code === 'DATABASE_CLOSING'
				);
			}
		} finally {
			await completeDatabaseDropPreparation('physicalalias', preparationId, rootPaths);
		}
		assert.ok(database({ database: 'configuredalias' }));
	});

	it('closes a loaded sibling when the requested alias is absent from the local catalog', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop-sibling-only');
		const tableName = 'AliasDropSiblingOnly';
		const preparationId = 'alias-drop-sibling-only-test';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		const loaded = loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		const { rootPaths } = databaseDropPreparationTargets('physicalalias');
		const databaseNames = ['physicalalias', 'configuredalias'];
		const path = loaded.configuredalias[tableName].primaryStore.rootStore.path;
		for (const index of Object.values(loaded.physicalalias[tableName].indices)) await index.close();
		await loaded.physicalalias[tableName].primaryStore.close();
		delete loaded.physicalalias;

		try {
			await prepareDatabaseDrop('physicalalias', preparationId, 0, rootPaths);
			assert.strictEqual(getRegistryStatus().find((entry) => entry.path === path)?.refCount ?? 0, 0);
			for (const name of databaseNames) {
				assert.throws(
					() => database({ database: name }),
					(error) => error.code === 'DATABASE_CLOSING'
				);
			}
		} finally {
			await completeDatabaseDropPreparation('physicalalias', preparationId, rootPaths);
		}
		assert.ok(database({ database: 'configuredalias' }));
	});

	it('rejects an alias configured after drop preparation begins', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop-late-config');
		const tableName = 'AliasDropLateConfig';
		const preparationId = 'alias-drop-late-config-test';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias', 'latealias'];
		const { rootPaths } = databaseDropPreparationTargets('physicalalias');

		try {
			await prepareDatabaseDrop('physicalalias', preparationId, 0, rootPaths);
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, { latealias: { path: storageRoot } });
			resetDatabases();
			assert.throws(
				() => database({ database: 'latealias' }),
				(error) => error.code === 'DATABASE_CLOSING'
			);
		} finally {
			await completeDatabaseDropPreparation('physicalalias', preparationId, rootPaths);
		}
		assert.ok(database({ database: 'latealias' }));
	});

	it('does not cold-open a configured alias while a physical child has an incomplete restore', async function () {
		const storageRoot = join(testRoot, 'alias-incomplete-restore');
		const physicalRoot = join(storageRoot, 'physicalalias');
		await createPhysicalStore(storageRoot, 'physicalalias', 'RestoreBlocked');
		abandonRestore(beginRestore(physicalRoot));
		try {
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storageRoot);
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, { configuredalias: { path: storageRoot } });
			resetDatabases();
			assert.throws(
				() => database({ database: 'configuredalias' }),
				(error) => error.statusCode === 409 && /incomplete restore/.test(error.message)
			);
			assert.strictEqual(existsSync(join(storageRoot, 'configuredalias')), false);
		} finally {
			completeRestore(beginRestore(physicalRoot));
		}
	});

	it('keeps every root blocked after a partial multi-root drop and completes on retry', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop-recovery');
		await createPhysicalStore(storageRoot, 'physicala', 'TableA');
		await createPhysicalStore(storageRoot, 'physicalb', 'TableB');
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicala', 'physicalb', 'configuredalias'];
		const rootStores = [
			getDatabases().physicala.TableA.primaryStore.rootStore,
			getDatabases().physicalb.TableB.primaryStore.rootStore,
		];
		const rootPaths = rootStores.map((rootStore) => rootStore.path);
		const blobPaths = [...new Set(rootStores.flatMap((rootStore) => getRootBlobPathsForDB(rootStore)))];
		for (const blobPath of blobPaths) mkdirSync(blobPath, { recursive: true });
		const originalDestroy = RocksDatabase.prototype.destroy;
		let destroyCount = 0;
		RocksDatabase.prototype.destroy = function () {
			if (destroyCount++ === 1) throw new Error('simulated second-root destroy failure');
			return originalDestroy.call(this);
		};
		try {
			await assert.rejects(
				dropSchema({ operation: terms.OPERATIONS_ENUM.DROP_SCHEMA, schema: 'configuredalias' }),
				/simulated second-root destroy failure/
			);
		} finally {
			RocksDatabase.prototype.destroy = originalDestroy;
		}
		await prepareDatabaseDrop('configuredalias', 'alias-drop-recovery-peer', 1, rootPaths);
		await completeDatabaseDropPreparation('configuredalias', 'alias-drop-recovery-peer', rootPaths);

		const unrelatedBlobRoot = join(testRoot, 'new-blob-root');
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_BLOBPATHS, [unrelatedBlobRoot]);
		const unrelatedBlobPaths = ['physicala', 'physicalb'].map((name) => join(unrelatedBlobRoot, name));
		for (const blobPath of unrelatedBlobPaths) mkdirSync(blobPath, { recursive: true });
		resetDatabases();
		assert.strictEqual(databases.configuredalias, undefined);
		assert.strictEqual(databases.physicala, undefined);
		assert.strictEqual(databases.physicalb, undefined);
		assert.strictEqual(scanBlockedDatabaseDrops(storageRoot).length, 2);

		await dropSchema({ operation: terms.OPERATIONS_ENUM.DROP_SCHEMA, schema: 'configuredalias' });
		loadedAliases = [];
		assert.deepStrictEqual(scanBlockedDatabaseDrops(storageRoot), []);
		for (const rootPath of rootPaths) assert.strictEqual(existsSync(rootPath), false);
		for (const blobPath of blobPaths) assert.strictEqual(existsSync(blobPath), false);
		for (const blobPath of unrelatedBlobPaths) assert.strictEqual(existsSync(blobPath), true);
	});

	it('refuses a detached root with a foreign handle before destroying loaded roots', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop-foreign-handle');
		await createPhysicalStore(storageRoot, 'physicalalias', 'TableA');
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		const loadedRootPath = getDatabases().physicalalias.TableA.primaryStore.rootStore.path;
		const detachedRootPath = join(storageRoot, 'detached');
		const foreignRoot = RocksDatabase.open(detachedRootPath);
		try {
			await assert.rejects(
				dropDatabase('configuredalias', [detachedRootPath]),
				(error) => error.code === 'DATABASE_CLOSING'
			);
			assert.strictEqual(existsSync(loadedRootPath), true);
			assert.deepStrictEqual(scanBlockedDatabaseDrops(storageRoot), []);
		} finally {
			await foreignRoot.close();
			await foreignRoot.destroy();
		}
	});

	it('completes a drop whose marker publication was interrupted before deletion', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop-marker-recovery');
		await createPhysicalStore(storageRoot, 'physicala', 'TableA');
		await createPhysicalStore(storageRoot, 'physicalb', 'TableB');
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicala', 'physicalb', 'configuredalias'];
		const rootStores = [
			getDatabases().physicala.TableA.primaryStore.rootStore,
			getDatabases().physicalb.TableB.primaryStore.rootStore,
		];
		const rootPaths = rootStores.map((rootStore) => rootStore.path);
		const blobPaths = [...new Set(rootStores.flatMap((rootStore) => getRootBlobPathsForDB(rootStore)))];
		for (const blobPath of blobPaths) mkdirSync(blobPath, { recursive: true });
		await closeAliases(loadedAliases);
		abandonDatabaseDrop(
			beginDatabaseDrop(rootPaths[0], 'configuredalias', 'physicala', getRootBlobPathsForDB(rootStores[0]))
		);
		resetDatabases();
		assert.strictEqual(databases.physicala, undefined);
		assert.strictEqual(databases.physicalb, undefined);
		assert.throws(
			() => database({ database: 'physicalb' }),
			(error) => error.code === 'DATABASE_CLOSING'
		);

		await dropSchema({ operation: terms.OPERATIONS_ENUM.DROP_SCHEMA, schema: 'configuredalias' });
		loadedAliases = [];
		assert.deepStrictEqual(scanBlockedDatabaseDrops(storageRoot), []);
		for (const rootPath of rootPaths) assert.strictEqual(existsSync(rootPath), false);
		for (const blobPath of blobPaths) assert.strictEqual(existsSync(blobPath), false);
	});

	it('prunes both aliases on the originating thread and another worker after the shared store is dropped', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop');
		const tableName = 'AliasDrop';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		const path = getDatabases().physicalalias[tableName].primaryStore.rootStore.path;
		fixture = startFixtureWorker(loadedAliases);
		assert.deepStrictEqual((await fixture.expect('booted')).aliases, {
			physicalalias: true,
			configuredalias: true,
		});

		await dropSchema({ operation: terms.OPERATIONS_ENUM.DROP_SCHEMA, schema: 'physicalalias' });
		assert.strictEqual(getRegistryStatus().find((database) => database.path === path)?.refCount ?? 0, 0);
		const localDatabases = getDatabases();
		assert.strictEqual(localDatabases.physicalalias, undefined);
		assert.strictEqual(localDatabases.configuredalias, undefined);

		fixture.send('inspect');
		assert.deepStrictEqual((await fixture.expect('inspected')).aliases, {
			physicalalias: false,
			configuredalias: false,
		});
		await fixture.close();
		fixture = undefined;
	});

	describe('a restore close on a thread that loaded only a sibling alias', function () {
		const tableName = 'SiblingOnly';
		let storageRoot;
		let databaseDir;
		let restoreLock;
		const handlesOn = () => getRegistryStatus().find((db) => db.path === databaseDir)?.refCount ?? 0;

		async function startSiblingOnlyWorker(name) {
			storageRoot = join(testRoot, name);
			databaseDir = join(storageRoot, 'physicalalias');
			await createPhysicalStore(storageRoot, 'physicalalias', tableName, [{ name: 'blob', type: 'Blob' }]);
			loadAliases(storageRoot, { configured: [] });
			loadedAliases = ['physicalalias'];
			fixture = startFixtureWorker(['physicalalias', 'configuredalias'], {
				storagePath: join(testRoot, `${name}-empty`),
				database: 'configuredalias',
				table: tableName,
				path: storageRoot,
			});
			const booted = await fixture.expect('booted');
			assert.deepStrictEqual(booted.aliases, { physicalalias: false, configuredalias: true });
			assert.strictEqual(booted.blobIdentity, 'configuredalias', "the worker's blob identity is the sibling's");
			// what an online restore holds across both broadcasts: it keeps every rescan from reopening the root
			restoreLock = beginRestore(databaseDir);
			return { databaseName: 'physicalalias', databaseDir, restoreToken: randomUUID() };
		}

		async function reload(restore) {
			completeRestore(restoreLock);
			restoreLock = undefined;
			await signalSchemaChange(restoreEvent('reload', restore));
		}

		afterEach(() => {
			if (restoreLock) completeRestore(restoreLock);
			restoreLock = undefined;
		});

		before(function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			mkdirSync(testRoot, { recursive: true });
		});

		it('closes the sibling, so no handle on the directory remains', async function () {
			const restore = await startSiblingOnlyWorker('restore-sibling-only');
			assert(handlesOn() > 0);

			await signalSchemaChange(restoreEvent('close', restore));

			assert.strictEqual(handlesOn(), 0, 'a thread holding only the sibling alias kept the directory open');
			fixture.send('inspect');
			assert.deepStrictEqual((await fixture.expect('inspected')).aliases, {
				physicalalias: false,
				configuredalias: false,
			});

			await reload(restore);
			fixture.send('inspect');
			assert.strictEqual((await fixture.expect('inspected')).aliases.configuredalias, true);
		});

		it('closes a root that a rescan detached from the catalog while the restore held it', async function () {
			storageRoot = join(testRoot, 'restore-detached-root');
			databaseDir = join(storageRoot, 'physicalalias');
			await createPhysicalStore(storageRoot, 'physicalalias', tableName);
			env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, join(testRoot, 'restore-detached-root-empty'));
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, { configuredalias: { path: storageRoot } });
			resetDatabases();
			loadedAliases = ['configuredalias'];
			assert(handlesOn() > 0);
			restoreLock = beginRestore(databaseDir);
			// any schema event's rescan now skips the held directory and drops its tables from the catalog
			resetDatabases();
			assert.strictEqual(databases.configuredalias?.[tableName], undefined);
			assert(handlesOn() > 0, 'the rescan cannot close the handles it detached');

			const restore = { databaseName: 'physicalalias', databaseDir, restoreToken: randomUUID() };
			await signalSchemaChange(restoreEvent('close', restore));

			assert.strictEqual(handlesOn(), 0, 'the detached root stayed open');
			await reload(restore);
			assert.ok(getDatabases().configuredalias[tableName]);
		});

		it("fences the sibling's blob work: an unfinished stream holds the close, and a queued deletion never runs", async function () {
			const restore = await startSiblingOnlyWorker('restore-sibling-blobs');
			const deletionDelay = 500;
			fixture.send('queue-deletion', { deletionDelay });
			const { condemnedPath } = await fixture.expect('deletion-queued');
			assert(existsSync(condemnedPath));
			fixture.send('start-blob-stream');
			await fixture.expect('blob-stream-started');

			let closed = false;
			const closing = signalSchemaChange(restoreEvent('close', restore)).then(() => (closed = true));
			try {
				const refused = await waitFor(
					async () => {
						fixture.send('try-save');
						const attempt = await fixture.expect('save-attempted');
						return !attempt.admitted && attempt;
					},
					{ timeout: 5000, message: "the restore never fenced blob saves under the worker's own blob identity" }
				);
				assert.strictEqual(refused.statusCode, 503, refused.message);
				// past the deletion deadline: a fenced reclamation must not run
				await sleep(deletionDelay * 3);
				assert(existsSync(condemnedPath), 'a queued deletion ran while the restore held the fence');
				assert.strictEqual(closed, false, 'the close was acknowledged before the in-flight save drained');
			} finally {
				fixture.send('fail-blob-stream');
				assert.strictEqual((await fixture.expect('blob-stream-settled')).outcome, 'failed');
				await closing;
			}
			assert.strictEqual(handlesOn(), 0);

			// stand in for the restore writing the backup's bytes at the condemned path
			writeFileSync(condemnedPath, 'restored-bytes');
			await reload(restore);
			await sleep(deletionDelay * 3);
			assert.strictEqual(
				readFileSync(condemnedPath, 'utf8'),
				'restored-bytes',
				'a deletion queued against the replaced generation removed the restored file'
			);
			fixture.send('try-save', { reloaded: true });
			const afterReload = await fixture.expect('save-attempted');
			assert.strictEqual(afterReload.admitted, true, afterReload.message);
		});
	});
});
