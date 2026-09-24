require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, database: openDatabase, dropDatabase, table } = require('#src/resources/databases');
const { acquireUpdateAttributesLock, releaseUpdateAttributesLock } = require('#src/resources/Table');
const { publishDerivedIndexReadiness } = require('#src/resources/derivedIndexRuntime');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { fullTextRetirementInProgress, hasDerivedIndexRegistration } = require('#src/resources/derivedIndexRegistry');
const {
	fullTextDerivedIndexId,
	fullTextDerivedIndexReadiness,
	refreshDerivedIndexes,
	setFullTextNativeBindingForTests,
	suspendDerivedIndexActivation,
} = require('#src/resources/derivedIndexes');
const { FullTextNativeTestBinding } = require('./fullTextNativeTestBinding');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const rocksOnly = isLMDB ? it.skip : it;
const lmdbOnly = isLMDB ? it : it.skip;

function definition(weight = 1) {
	return {
		name: 'search',
		fields: [
			{ name: 'title', weight },
			{ name: 'tags', weight: 1 },
		],
		analyzer: 'english@1',
		stopWords: true,
		positions: true,
		surfaceTerms: true,
		synonyms: [],
	};
}

function latestOpen(binding, Table) {
	const opened = binding.opens.findLast((options) =>
		options.path.startsWith(Table.primaryStore.rootStore.path + path.sep)
	);
	assert(opened);
	return opened;
}

describe('@fullText derived-index activation', () => {
	let Product;
	let binding;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(() => {
		binding = new FullTextNativeTestBinding();
		setFullTextNativeBindingForTests({
			binding,
			closeTimeoutMilliseconds: 50,
			shutdownTimeoutMilliseconds: 100,
			runnerOptions: {
				rebuildBackoffMilliseconds: 10,
				maxRebuildBackoffMilliseconds: 50,
				maxRebuildAttempts: 2,
				lockRetryMilliseconds: 10,
			},
		});
	});

	afterEach(async () => {
		const runtime = Product?.derivedIndexRuntime;
		if (Product) Product.derivedIndexRuntime = undefined;
		if (runtime) await runtime.close();
		Product = undefined;
		setFullTextNativeBindingForTests(undefined);
	});

	lmdbOnly('rejects activation before persisting an LMDB declaration', () => {
		const database = `fulltext-lmdb-${Date.now()}`;
		assert.throws(
			() =>
				table({
					database,
					table: 'Product',
					audit: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'title', type: 'String' },
						{ name: 'tags', type: 'array', elements: { type: 'String' } },
					],
					fullTextIndexes: [definition()],
				}),
			/LMDB storage engine/
		);
	});

	lmdbOnly('ignores unsupported peer declarations without blocking the rest of the schema', () => {
		Product = table({
			database: `fulltext-lmdb-peer-${Date.now()}`,
			table: 'Product',
			origin: 'cluster',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		assert.deepStrictEqual(Product.fullTextIndexes, []);
		assert.strictEqual(
			Product.attributes.some(({ name }) => name === 'title'),
			true
		);
	});

	lmdbOnly('drops a table with inactive persisted full-text metadata', async () => {
		Product = table({
			database: `fulltext-lmdb-drop-${Date.now()}`,
			table: 'Product',
			origin: 'cluster',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		assert.deepStrictEqual(Product.fullTextIndexes, []);

		await Product.dropTable();
	});

	lmdbOnly('preserves inactive catalog metadata across an unrelated peer schema change', async () => {
		const database = `fulltext-lmdb-preserved-${Date.now()}`;
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({ database, table: 'Product', audit: true, attributes });
		const primaryKey = `${Product.tableName}/`;
		const descriptor = Product.dbisDB.getSync(primaryKey);
		const durableIndexes = [definition()];
		const durableGenerations = { search: 'preserved-generation' };
		Product.dbisDB.putSync(primaryKey, {
			...descriptor,
			fullTextIndexes: durableIndexes,
			fullTextIndexGenerations: durableGenerations,
		});

		Product = table({
			database,
			table: 'Product',
			origin: 'cluster',
			audit: true,
			attributes: [...attributes, { name: 'sku', type: 'String' }],
		});

		const preserved = Product.dbisDB.getSync(primaryKey);
		assert.deepStrictEqual(preserved.fullTextIndexes, durableIndexes);
		assert.deepStrictEqual(preserved.fullTextIndexGenerations, durableGenerations);
		assert.deepStrictEqual(Product.fullTextIndexes, []);
		assert(Product.attributes.some(({ name }) => name === 'sku'));
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await Product.clear();
		assert.strictEqual(Product.primaryStore.getSync('shoe-1'), undefined);

		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [...attributes, { name: 'sku', type: 'String' }],
			fullTextIndexes: [],
		});
		const cleared = Product.dbisDB.getSync(primaryKey);
		assert.strictEqual(Object.hasOwn(cleared, 'fullTextIndexes'), false);
		assert.strictEqual(Object.hasOwn(cleared, 'fullTextIndexGenerations'), false);
	});

	rocksOnly('observes replacement shutdown when the next attachment fails synchronously', () => {
		let rejectionHandlerAttached = false;
		const current = {
			matchesCurrent: () => false,
			close: () => ({
				then(_onFulfilled, onRejected) {
					rejectionHandlerAttached = typeof onRejected === 'function';
				},
			}),
		};
		const Table = {
			derivedIndexRuntime: current,
			attributes: [],
			fullTextIndexes: [definition()],
			indices: {},
			audit: false,
			databaseName: 'test',
			tableName: 'Product',
		};

		assert.throws(() => refreshDerivedIndexes(Table), /must enable audit logging/);
		assert.strictEqual(rejectionHandlerAttached, true);
	});

	rocksOnly('indexes declared fields through the shared derived-index runtime', async () => {
		Product = table({
			database: `fulltext-activation-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail', null, 'waterproof'] });

		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = binding.opens.find((options) => options.indexId === fullTextDerivedIndexId(Product, 'search'));
		assert(opened);
		assert(path.isAbsolute(opened.path));
		assert(opened.path.startsWith(Product.primaryStore.rootStore.path + path.sep));
		assert.strictEqual(opened.limits.indexingThreads, 1);
		assert.strictEqual(opened.limits.searchThreads, 1);
		const state = binding.states.get(`${opened.path}\0${opened.indexId}\0${opened.generation}`);
		await waitFor(() => state.documents.size === 1 && state.payload, 30_000);
		const document = [...state.documents.values()][0];
		assert.deepStrictEqual({ ...document.fields }, { title: 'Trail shoe', tags: ['trail', 'waterproof'] });
		assert.throws(() => Product.clear(), /whole-table invalidation is crash-safe/);
	});

	rocksOnly('keeps quarantined full-text metadata inert during clear and drop', async () => {
		Product = table({
			database: `fulltext-invalid-drop-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
		});
		const primaryKey = `${Product.tableName}/`;
		Product.dbisDB.putSync(primaryKey, {
			...Product.dbisDB.getSync(primaryKey),
			fullTextIndexes: [null],
		});

		await Product.clear();
		await Product.dropTable();
	});

	rocksOnly('does not replace a derived-index attachment while activation is suspended', async () => {
		Product = table({
			database: `fulltext-suspended-activation-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const original = Product.derivedIndexRuntime;
		const release = suspendDerivedIndexActivation(Product.primaryStore.rootStore);
		try {
			refreshDerivedIndexes(Product);
			await waitFor(() => Product.derivedIndexRuntime === undefined, 30_000);
			assert.strictEqual(Product.derivedIndexRuntime, undefined);
			assert.strictEqual(Product.derivedIndexRuntime === original, false);
		} finally {
			release();
		}
	});

	rocksOnly('waits for native writers before closing a database', async () => {
		const database = `fulltext-close-database-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ ...definition(), fields: [{ name: 'title', weight: 1 }] }],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		let releaseClose;
		binding.closeBarrier = new Promise((resolve) => (releaseClose = resolve));
		const originalAttachment = Product.derivedIndexRuntime;
		let closed = false;
		const closing = closeDatabase(database).then((result) => {
			closed = true;
			return result;
		});
		try {
			await waitFor(() => binding.closeAttempts > 0);
			assert.strictEqual(closed, false);
			Product.fullTextIndexGenerations = { search: 'replacement-during-close' };
			refreshDerivedIndexes(Product);
			assert.strictEqual(Product.derivedIndexRuntime, originalAttachment);
			releaseClose();
			assert.strictEqual(await closing, true);
		} finally {
			releaseClose?.();
		}
		Product = undefined;
	});

	rocksOnly('suspends first-table activation while a tableless database closes', async () => {
		const database = `fulltext-tableless-close-${Date.now()}`;
		const EmptyingTable = table({
			database,
			table: 'EmptyingTable',
			audit: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		const rootStore = EmptyingTable.primaryStore.rootStore;
		await EmptyingTable.dropTable();

		const originalStopAuditCleanup = rootStore.auditStore.stopAuditCleanup.bind(rootStore.auditStore);
		let cleanupStarted = false;
		let releaseCleanup;
		const cleanupBarrier = new Promise((resolve) => (releaseCleanup = resolve));
		rootStore.auditStore.stopAuditCleanup = async () => {
			cleanupStarted = true;
			await cleanupBarrier;
			return originalStopAuditCleanup();
		};
		const closing = closeDatabase(database);
		try {
			await waitFor(() => cleanupStarted);
			Product = table({
				database,
				table: 'Product',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{ name: 'tags', type: 'array', elements: { type: 'String' } },
				],
				fullTextIndexes: [definition()],
			});
			assert.strictEqual(Product.derivedIndexRuntime, undefined);
			releaseCleanup();
			assert.strictEqual(await closing, true);
		} finally {
			releaseCleanup?.();
		}
		Product = undefined;
	});

	rocksOnly('waits for native writers before dropping a database', async () => {
		const database = `fulltext-drop-database-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ ...definition(), fields: [{ name: 'title', weight: 1 }] }],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		let releaseClose;
		binding.closeBarrier = new Promise((resolve) => (releaseClose = resolve));
		const originalAttachment = Product.derivedIndexRuntime;
		let dropped = false;
		const dropping = dropDatabase(database).then(() => {
			dropped = true;
		});
		try {
			await waitFor(() => binding.closeAttempts > 0);
			assert.strictEqual(dropped, false);
			Product.fullTextIndexGenerations = { search: 'replacement-during-drop' };
			refreshDerivedIndexes(Product);
			assert.strictEqual(Product.derivedIndexRuntime, originalAttachment);
			releaseClose();
			await dropping;
			assert.strictEqual(dropped, true);
		} finally {
			releaseClose?.();
		}
		Product = undefined;
	});

	rocksOnly('keeps a database registered when a derived writer prevents its drop', async () => {
		const database = `fulltext-failed-drop-database-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [{ ...definition(), fields: [{ name: 'title', weight: 1 }] }],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const rootStore = Product.primaryStore.rootStore;
		binding.closeError = new Error('writer did not quiesce');

		await assert.rejects(dropDatabase(database), /shutdown failed|did not prove quiescence/);

		assert.strictEqual(rootStore.status, 'open');
		assert.strictEqual(openDatabase({ database }), rootStore, 'a failed drop must retain the registered root store');
		binding.closeError = undefined;
		await dropDatabase(database);
		Product = undefined;
	});

	rocksOnly('restores activation after a database writer close throws synchronously', async () => {
		const database = `fulltext-sync-close-failure-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		let closeAttempts = 0;
		Product.derivedIndexRuntime = {
			close() {
				if (++closeAttempts === 1) throw new Error('synchronous writer close failure');
				return Promise.resolve();
			},
			completeDrop() {},
		};

		await assert.rejects(dropDatabase(database), /synchronous writer close failure/);
		assert.strictEqual(closeAttempts, 2, 'failure recovery must be able to re-run attachment cleanup');
		await waitFor(() => Product.derivedIndexRuntime === undefined);
		await dropDatabase(database);
		Product = undefined;
	});

	rocksOnly('rejects clear when a stale table view misses a durable full-text declaration', () => {
		const database = `fulltext-stale-clear-${Date.now()}`;
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({ database, table: 'Product', audit: true, attributes });
		const primaryKey = `${Product.tableName}/`;
		const descriptor = Product.dbisDB.getSync(primaryKey);
		Product.dbisDB.putSync(primaryKey, {
			...descriptor,
			fullTextIndexes: [definition()],
			fullTextIndexGenerations: { search: 'peer-generation' },
		});
		const shadowPrimaryKey = `${Product.tableName}/${Product.primaryKey}`;
		Product.dbisDB.putSync(shadowPrimaryKey, { name: Product.primaryKey, type: 'String' });

		assert.throws(() => Product.clear(), /whole-table invalidation is crash-safe/);

		Product.dbisDB.removeSync(shadowPrimaryKey);
		Product = table({ database, table: 'Product', audit: true, attributes, fullTextIndexes: [] });
	});

	rocksOnly('blocks full-text activation until an asynchronous table clear finishes', async () => {
		const database = `fulltext-clear-fence-${Date.now()}`;
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({ database, table: 'Product', audit: true, attributes });
		const originalClear = Product.primaryStore.clear;
		let finishClear;
		Product.primaryStore.clear = () => new Promise((resolve) => (finishClear = resolve));
		try {
			const clearing = Product.clear();
			assert.throws(
				() => table({ database, table: 'Product', audit: true, attributes, fullTextIndexes: [definition()] }),
				/Table\.clear\(\) is in progress/
			);
			finishClear();
			await clearing;
		} finally {
			Product.primaryStore.clear = originalClear;
		}

		Product = table({ database, table: 'Product', audit: true, attributes, fullTextIndexes: [definition()] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
	});

	rocksOnly('coalesces concurrent table clears behind the activation fence', async () => {
		const database = `fulltext-concurrent-clear-${Date.now()}`;
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		Product = table({ database, table: 'Product', audit: true, attributes });
		const originalClear = Product.primaryStore.clear;
		let finishFirstClear;
		let clearAttempts = 0;
		Product.primaryStore.clear = () => {
			clearAttempts++;
			if (clearAttempts === 1) return new Promise((resolve) => (finishFirstClear = resolve));
			return Promise.resolve();
		};
		try {
			const first = Product.clear();
			const second = Product.clear();
			assert.strictEqual(clearAttempts, 1);
			finishFirstClear();
			await Promise.all([first, second]);
			assert.strictEqual(clearAttempts, 2);
		} finally {
			finishFirstClear?.();
			Product.primaryStore.clear = originalClear;
		}
	});

	rocksOnly('waits for the schema lock without blocking the worker during clear', async () => {
		Product = table({
			database: `fulltext-clear-schema-lock-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
		});
		const rootStore = Product.primaryStore.rootStore;
		acquireUpdateAttributesLock(rootStore, 'test clear contention');
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
			releaseUpdateAttributesLock(rootStore);
		}, 25);
		try {
			await Product.clear();
			assert.strictEqual(timerFired, true);
		} finally {
			clearTimeout(timer);
			if (!timerFired) releaseUpdateAttributesLock(rootStore);
		}
	});

	rocksOnly('holds the clear fence until every started clear settles after one fails', async () => {
		const database = `fulltext-clear-failure-fence-${Date.now()}`;
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String', indexed: true },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({ database, table: 'Product', audit: true, attributes });
		if (Product.indexingOperation) await Product.indexingOperation;
		const originalPrimaryClear = Product.primaryStore.clear;
		const originalIndexClear = Product.indices.title.clearAsync;
		let finishPrimaryClear;
		let indexClearAttempted = false;
		Product.primaryStore.clear = () => new Promise((resolve) => (finishPrimaryClear = resolve));
		Product.indices.title.clearAsync = () => {
			indexClearAttempted = true;
			return Promise.reject(new Error('injected secondary clear failure'));
		};
		try {
			const clearing = Product.clear();
			void clearing.catch(() => {});
			await waitFor(() => indexClearAttempted);
			assert.throws(
				() => table({ database, table: 'Product', audit: true, attributes, fullTextIndexes: [definition()] }),
				/Table\.clear\(\) is in progress/
			);
			finishPrimaryClear();
			await assert.rejects(clearing, /injected secondary clear failure/);
		} finally {
			finishPrimaryClear?.();
			Product.primaryStore.clear = originalPrimaryClear;
			Product.indices.title.clearAsync = originalIndexClear;
		}

		Product = table({ database, table: 'Product', audit: true, attributes, fullTextIndexes: [definition()] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
	});

	rocksOnly('preserves query-only generations and rebuilds storage changes', async () => {
		const database = `fulltext-generation-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const initialGeneration = Product.fullTextIndexGenerations.search;
		const initialNativeGeneration = latestOpen(binding, Product).generation;
		const initialRuntime = Product.derivedIndexRuntime;
		const initialOpenCount = binding.opens.length;
		const initialResetCount = binding.resets.length;

		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [{ ...definition(), synonyms: [{ source: 'shoe', replacements: ['sneaker'] }] }],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert.strictEqual(Product.fullTextIndexGenerations.search, initialGeneration);
		assert.strictEqual(latestOpen(binding, Product).generation, initialNativeGeneration);
		assert.strictEqual(Product.derivedIndexRuntime, initialRuntime);
		assert.strictEqual(binding.opens.length, initialOpenCount);
		assert.strictEqual(binding.resets.length, initialResetCount);

		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition(2)],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert.notStrictEqual(Product.fullTextIndexGenerations.search, initialGeneration);
		assert.notStrictEqual(latestOpen(binding, Product).generation, initialNativeGeneration);
		assert.notStrictEqual(Product.derivedIndexRuntime, initialRuntime);
		assert(binding.resets.length > 0);
	});

	rocksOnly('reports activation failure and retries on the next schema installation', async () => {
		const database = `fulltext-activation-failure-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		binding.runtimeInfo = async () => {
			throw new Error('native module unavailable');
		};
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});

		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'unavailable', 30_000);
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'search').reason, 'backend-failed');
		assert.strictEqual(hasDerivedIndexRegistration(Product.auditStore, Product.tableId), true);
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		const entry = Product.primaryStore.getEntry('shoe-1');
		await Product.evict('shoe-1', entry.value, entry.version);
		assert(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'shoe-1'
			),
			'evictions must remain recoverable while activation is unavailable'
		);

		delete binding.runtimeInfo;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert(binding.opens.some((options) => options.indexId === fullTextDerivedIndexId(Product, 'search')));
		const opened = latestOpen(binding, Product);
		const state = binding.states.get(`${opened.path}\0${opened.indexId}\0${opened.generation}`);
		assert.strictEqual(state.documents.size, 0);
	});

	rocksOnly('keeps eviction auditing registered while native activation is pending', async () => {
		let finishRuntimeInfo;
		const runtimeInfoGate = new Promise((resolve) => {
			finishRuntimeInfo = resolve;
		});
		binding.runtimeInfo = async () => {
			await runtimeInfoGate;
			return FullTextNativeTestBinding.prototype.runtimeInfo.call(binding);
		};
		Product = table({
			database: `fulltext-pending-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		assert.strictEqual(hasDerivedIndexRegistration(Product.auditStore, Product.tableId), true);
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		const entry = Product.primaryStore.getEntry('shoe-1');
		await Product.evict('shoe-1', entry.value, entry.version);
		assert(
			[...Product.auditStore.getRange({ start: 1 })].some(
				(record) => record.type === 'evict' && record.recordId === 'shoe-1'
			),
			'eviction must be audited while native activation is pending'
		);

		const runtime = Product.derivedIndexRuntime;
		Product.derivedIndexRuntime = undefined;
		const closed = runtime.close();
		finishRuntimeInfo();
		await closed;

		assert.strictEqual(hasDerivedIndexRegistration(Product.auditStore, Product.tableId), false);
		assert.strictEqual(binding.opens.length, 0);
	});

	rocksOnly('keeps eviction auditing registered until a pending drop is durable', async () => {
		let finishRuntimeInfo;
		let markRuntimeInfoStarted;
		const runtimeInfoGate = new Promise((resolve) => {
			finishRuntimeInfo = resolve;
		});
		const runtimeInfoStarted = new Promise((resolve) => {
			markRuntimeInfoStarted = resolve;
		});
		binding.runtimeInfo = async () => {
			markRuntimeInfoStarted();
			await runtimeInfoGate;
			return FullTextNativeTestBinding.prototype.runtimeInfo.call(binding);
		};
		Product = table({
			database: `fulltext-pending-drop-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await runtimeInfoStarted;

		const dropping = Product.dropTable();
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(hasDerivedIndexRegistration(Product.auditStore, Product.tableId), true);
		finishRuntimeInfo();
		await dropping;
		assert.strictEqual(hasDerivedIndexRegistration(Product.auditStore, Product.tableId), false);
		Product = undefined;
	});

	rocksOnly('keeps a mixed HNSW and full-text attachment across a no-op refresh', async () => {
		Product = table({
			database: `fulltext-mixed-refresh-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const values = new Map();
		const indexStore = {
			name: 'Product/vector',
			getSync: (key) => values.get(key),
			putSync: (key, value) => values.set(key, value),
			removeSync: (key) => values.delete(key),
			clear: async () => values.clear(),
		};
		indexStore.customIndex = {
			postCommit: true,
			indexStore,
			attachDerivedHost() {},
			assertDerivedValue() {},
			applyDerivedValue() {},
			async flushDerived() {},
			resetDerivedStorage() {},
			propertyResolver(value) {
				return value;
			},
		};
		Product.attributes.push({ name: 'vector', indexed: { type: 'HNSW', nativePlane: true } });
		Product.indices.vector = indexStore;
		Product.updatedAttributes();

		refreshDerivedIndexes(Product);
		const mixedRuntime = Product.derivedIndexRuntime;
		const initialResolver = Product.propertyResolvers.vector;
		Product.updatedAttributes();
		assert.notStrictEqual(Product.propertyResolvers.vector, initialResolver);
		refreshDerivedIndexes(Product);

		assert.strictEqual(Product.derivedIndexRuntime, mixedRuntime);
		const openCount = binding.opens.length;
		publishDerivedIndexReadiness(Product.auditStore, `hnsw:${indexStore.name}`, 'unavailable', 'runner-failed');
		refreshDerivedIndexes(Product);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(Product.derivedIndexRuntime, mixedRuntime);
		assert.strictEqual(binding.opens.length, openCount, 'an unavailable HNSW sibling must not reopen full-text');
	});

	rocksOnly('retries failed full-text activation without replacing a healthy HNSW attachment', async () => {
		binding.runtimeInfo = async () => {
			throw new Error('native module unavailable');
		};
		Product = table({
			database: `fulltext-mixed-failure-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'unavailable', 30_000);
		const values = new Map();
		const indexStore = {
			name: 'Product/vector',
			getSync: (key) => values.get(key),
			putSync: (key, value) => values.set(key, value),
			removeSync: (key) => values.delete(key),
			clear: async () => values.clear(),
		};
		indexStore.customIndex = {
			postCommit: true,
			indexStore,
			attachDerivedHost() {},
			assertDerivedValue() {},
			applyDerivedValue() {},
			async flushDerived() {},
			resetDerivedStorage() {},
			propertyResolver(value) {
				return value;
			},
		};
		Product.attributes.push({ name: 'vector', indexed: { type: 'HNSW', nativePlane: true } });
		Product.indices.vector = indexStore;
		Product.updatedAttributes();
		refreshDerivedIndexes(Product);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'unavailable', 30_000);
		const mixedRuntime = Product.derivedIndexRuntime;

		refreshDerivedIndexes(Product);
		await new Promise((resolve) => setImmediate(resolve));

		assert.strictEqual(Product.derivedIndexRuntime, mixedRuntime);
	});

	rocksOnly('rotates and rebuilds when the same declaration is removed, cleared, and re-added', async () => {
		const database = `fulltext-readd-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const initialGeneration = Product.fullTextIndexGenerations.search;
		const initialOpen = latestOpen(binding, Product);
		const initialStateKey = `${initialOpen.path}\0${initialOpen.indexId}\0${initialOpen.generation}`;

		Product = table({ database, table: 'Product', audit: true, attributes: attributes(), fullTextIndexes: [] });
		await waitFor(() => !binding.states.has(initialStateKey), 30_000);
		await Product.clear();
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);

		assert.notStrictEqual(Product.fullTextIndexGenerations.search, initialGeneration);
		const opened = latestOpen(binding, Product);
		const state = binding.states.get(`${opened.path}\0${opened.indexId}\0${opened.generation}`);
		assert.strictEqual(state.documents.size, 0);
		assert(binding.resets.length > 0);
	});

	rocksOnly('waits for removal retirement before reopening the same native path', async () => {
		const database = `fulltext-retirement-readd-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opensBeforeRemoval = binding.opens.length;
		let releaseReset;
		binding.resetWait = new Promise((resolve) => {
			releaseReset = resolve;
		});

		Product = table({ database, table: 'Product', audit: true, attributes: attributes(), fullTextIndexes: [] });
		await waitFor(() => binding.resets.length > 0, 30_000);
		const retirementInProgress = fullTextRetirementInProgress(Product.primaryStore.rootStore, Product.tableName);
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(binding.opens.length, opensBeforeRemoval);
		releaseReset();
		await waitFor(() => binding.reclaims.length > 0, 30_000);

		assert.strictEqual(retirementInProgress, true);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = latestOpen(binding, Product);
		assert(binding.states.has(`${opened.path}\0${opened.indexId}\0${opened.generation}`));
	});

	rocksOnly('retires native storage after a successful table drop', async () => {
		Product = table({
			database: `fulltext-drop-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = latestOpen(binding, Product);
		const stateKey = `${opened.path}\0${opened.indexId}\0${opened.generation}`;
		const matchingResets = () =>
			binding.resets.filter((options) => options.path === opened.path && options.indexId === opened.indexId).length;
		const resetsBeforeDrop = matchingResets();

		await Product.dropTable();

		assert.strictEqual(binding.states.has(stateKey), false);
		assert(matchingResets() > resetsBeforeDrop);
		Product = undefined;
	});

	rocksOnly('retires durable native storage when the in-memory attachment is absent', async () => {
		Product = table({
			database: `fulltext-detached-drop-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = latestOpen(binding, Product);
		const stateKey = `${opened.path}\0${opened.indexId}\0${opened.generation}`;
		const runtime = Product.derivedIndexRuntime;
		Product.derivedIndexRuntime = undefined;
		await runtime.close();

		await Product.dropTable();

		assert.strictEqual(binding.states.has(stateKey), false);
		assert(binding.resets.some((options) => options.path === opened.path && options.indexId === opened.indexId));
		Product = undefined;
	});

	rocksOnly('does not hold table retirement on best-effort native reclamation', async () => {
		Product = table({
			database: `fulltext-retirement-reclaim-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		let finishReclaim;
		binding.reclaimWait = new Promise((resolve) => (finishReclaim = resolve));
		let dropFinished = false;
		const dropping = Product.dropTable().then(() => {
			dropFinished = true;
		});
		try {
			await waitFor(() => binding.reclaims.some(({ retiredPath }) => retiredPath === 'test-retired'));
			await waitFor(() => dropFinished);
			await dropping;
		} finally {
			finishReclaim?.();
		}
		Product = undefined;
	});

	rocksOnly('fences same-name recreation until the native reset settles', async () => {
		const database = `fulltext-retirement-fence-${Date.now()}`;
		const tableOptions = () => ({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		Product = table(tableOptions());
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		let finishReset;
		binding.resetWait = new Promise((resolve) => {
			finishReset = resolve;
		});

		const dropping = Product.dropTable();
		await waitFor(() => fullTextRetirementInProgress(Product.primaryStore.rootStore, Product.tableName), 30_000);
		assert.throws(() => table(tableOptions()), /previous full-text storage is being retired/);
		finishReset();
		await dropping;

		Product = table(tableOptions());
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
	});

	rocksOnly('rejects a drop before persisting its tombstone while retirement is already fenced', async () => {
		Product = table({
			database: `fulltext-retirement-busy-drop-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert.strictEqual(Product.dbisDB.getSync(`${Product.tableName}/`).dropping, undefined);
		const rootStore = Product.primaryStore.rootStore;
		const tryLock = rootStore.tryLock;
		rootStore.tryLock = function (key) {
			return Buffer.isBuffer(key) && key.equals(Buffer.from('update-attributes')) ? tryLock.call(this, key) : false;
		};
		try {
			await assert.rejects(Product.dropTable(), /while its full-text storage is being retired/);
			assert.strictEqual(Product.dbisDB.getSync(`${Product.tableName}/`).dropping, undefined);
			assert(Product.derivedIndexRuntime, 'a rejected drop restores its derived-index attachment');
		} finally {
			rootStore.tryLock = tryLock;
		}
	});

	rocksOnly('does not retire native storage when a stale table drop is rejected', async () => {
		const database = `fulltext-stale-drop-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = latestOpen(binding, Product);
		const stateKey = `${opened.path}\0${opened.indexId}\0${opened.generation}`;
		const matchingResets = () =>
			binding.resets.filter((options) => options.path === opened.path && options.indexId === opened.indexId).length;
		const resetsBeforeDrop = matchingResets();
		const primaryKey = `${Product.tableName}/`;
		const descriptor = { ...Product.dbisDB.getSync(primaryKey) };
		const replacementTableId =
			typeof descriptor.tableId === 'bigint' ? descriptor.tableId + 1n : descriptor.tableId + 1;
		Product.dbisDB.putSync(primaryKey, { ...descriptor, tableId: replacementTableId });

		await Product.dropTable();

		assert.strictEqual(binding.states.has(stateKey), true);
		assert.strictEqual(matchingResets(), resetsBeforeDrop);
		Product.dbisDB.putSync(primaryKey, descriptor);
		Product = undefined;
	});

	rocksOnly('does not fail an authoritative drop when native retirement is busy', async () => {
		Product = table({
			database: `fulltext-busy-retirement-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = latestOpen(binding, Product);
		const stateKey = `${opened.path}\0${opened.indexId}\0${opened.generation}`;
		binding.resetError = Object.assign(new Error('another writer owns the index'), { code: 'E_LOCK_BUSY' });

		await Product.dropTable();

		assert.strictEqual(binding.states.has(stateKey), true);
		Product = undefined;
	});

	rocksOnly('retries retirement after a peer writer releases the native index', async () => {
		Product = table({
			database: `fulltext-peer-retirement-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const opened = latestOpen(binding, Product);
		const stateKey = `${opened.path}\0${opened.indexId}\0${opened.generation}`;
		const resetsBeforeDrop = binding.resets.length;
		binding.resetFailuresRemaining = 2;

		await Product.dropTable();

		assert.strictEqual(binding.states.has(stateKey), false);
		assert(binding.resets.length >= resetsBeforeDrop + 3);
		Product = undefined;
	});

	rocksOnly('keeps a failed removal settlement available for a later drop retry', async () => {
		const database = `fulltext-removal-retry-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		binding.closeError = new Error('writer did not quiesce');

		Product = table({ database, table: 'Product', audit: true, attributes: attributes(), fullTextIndexes: [] });
		await waitFor(() => binding.closeAttempts > 0);
		assert(Product.derivedIndexRuntime, 'failed settlement must remain retryable after declaration removal');
		assert.strictEqual(Product.derivedIndexRuntime.hasFullTextIndexes(), true);

		binding.closeError = undefined;
		let finishReset;
		binding.resetWait = new Promise((resolve) => {
			finishReset = resolve;
		});
		const dropping = Product.dropTable();
		await waitFor(() => fullTextRetirementInProgress(Product.primaryStore.rootStore, Product.tableName), 30_000);
		assert.throws(
			() =>
				table({
					database,
					table: 'Product',
					audit: true,
					attributes: attributes(),
					fullTextIndexes: [definition()],
				}),
			/previous full-text storage is being retired/
		);
		finishReset();
		await dropping;
		assert(binding.closeAttempts > 1);
		Product = undefined;
	});

	rocksOnly('keeps a failed predecessor in the handoff chain across later generations', async () => {
		const database = `fulltext-handoff-chain-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		const declare = (weight) =>
			table({
				database,
				table: 'Product',
				audit: true,
				attributes: attributes(),
				fullTextIndexes: [definition(weight)],
			});

		Product = declare(1);
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const initialOpenCount = binding.opens.length;
		binding.closeError = new Error('writer did not quiesce');

		Product = declare(2);
		await waitFor(() => binding.closeAttempts > 0);
		const attemptsBeforeThirdGeneration = binding.closeAttempts;
		Product = declare(3);
		await waitFor(() => binding.closeAttempts > attemptsBeforeThirdGeneration);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(binding.opens.length, initialOpenCount, 'a later generation must not bypass the failed writer');

		const failedAttempts = binding.closeAttempts;
		binding.closeError = undefined;
		Product = declare(3);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert(binding.closeAttempts > failedAttempts, 'the retained handoff chain must retry the failed writer first');
	});

	rocksOnly('retries a failed writer shutdown before replacing the index', async () => {
		const database = `fulltext-shutdown-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', tags: ['trail'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const failedRuntime = Product.derivedIndexRuntime;
		binding.closeError = new Error('writer did not quiesce');

		await assert.rejects(Product.dropTable(), /shutdown failed|did not prove quiescence/);
		assert(Product.derivedIndexRuntime, 'failed drop must restore a derived-index lifecycle handle');
		assert.notStrictEqual(Product.derivedIndexRuntime, failedRuntime);
		binding.closeError = undefined;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition()],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert.notStrictEqual(Product.derivedIndexRuntime, failedRuntime);
		assert(binding.closeAttempts > 1);
	});
});
