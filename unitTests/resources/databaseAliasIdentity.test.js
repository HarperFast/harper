'use strict';

require('../testUtils');
const assert = require('node:assert');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { dropSchema } = require('#src/dataLayer/schema');
const { table, closeDatabase, getDatabases, resetDatabases } = require('#src/resources/databases');
const { databasePaths, getRootBlobPathsForDB } = require('#src/resources/blob');
const {
	onMessageByType,
	registerWorkerDataProvider,
	setMainIsWorker,
	startWorker,
} = require('#js/server/threads/manageThreads');

const WORKER_FIXTURE = join(__dirname, 'databaseAliasIdentity-thread.js');
const MESSAGE_TYPE = 'database-alias-identity-test';
const CONTROL_TYPE = 'database-alias-identity-control';

function closeAliases(aliases) {
	for (const alias of aliases) closeDatabase(alias);
}

async function createPhysicalStore(storageRoot, databaseName, tableName) {
	mkdirSync(storageRoot, { recursive: true });
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storageRoot);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});
	resetDatabases();
	const Table = table({
		database: databaseName,
		table: tableName,
		attributes: [{ name: 'id', isPrimaryKey: true }],
	});
	await Table.dbisDB.committed;
	closeDatabase(databaseName);
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

function startFixtureWorker(aliases) {
	const queued = [];
	const waiting = [];
	let failure;
	let closing = false;
	const unregisterAliases = registerWorkerDataProvider('databaseAliasIdentityAliases', () => aliases);
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
	}
	const next = () => {
		if (failure) return Promise.reject(failure);
		if (queued.length) return Promise.resolve(queued.shift());
		return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
	};
	return {
		worker,
		send(command) {
			worker.postMessage({ type: CONTROL_TYPE, command });
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
		await fixture?.close();
		fixture = undefined;
		closeAliases(loadedAliases);
		loadedAliases = [];
		setupTestDBPath();
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

	it('prunes both aliases on the originating thread and another worker after the shared store is dropped', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const storageRoot = join(testRoot, 'alias-drop');
		const tableName = 'AliasDrop';
		await createPhysicalStore(storageRoot, 'physicalalias', tableName);
		loadAliases(storageRoot, { configured: ['configuredalias'] });
		loadedAliases = ['physicalalias', 'configuredalias'];
		fixture = startFixtureWorker(loadedAliases);
		assert.deepStrictEqual((await fixture.expect('booted')).aliases, {
			physicalalias: true,
			configuredalias: true,
		});

		await dropSchema({ operation: terms.OPERATIONS_ENUM.DROP_SCHEMA, schema: 'physicalalias' });
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
});
