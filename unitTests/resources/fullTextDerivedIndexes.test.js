require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabaseForRestore, databaseEventsEmitter, resetDatabases, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const {
	assertFullTextActivationSupported,
	fullTextDerivedIndexId,
	fullTextDerivedIndexReadiness,
	setFullTextNativeBindingForTests,
} = require('#src/resources/derivedIndexes');
const { FullTextNativeTestBinding } = require('./fullTextNativeTestBinding');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const rocksOnly = isLMDB ? it.skip : it;

function definition(field, weight = 1, name = 'search') {
	return {
		name,
		fields: [{ name: field, weight }],
		analyzer: 'english@1',
		stopWords: true,
		positions: true,
		surfaceTerms: true,
		synonyms: [],
	};
}

describe('@fullText derived-index activation', () => {
	let Product;
	let Other;
	let binding;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(() => {
		binding = new FullTextNativeTestBinding();
		setFullTextNativeBindingForTests(binding);
	});

	afterEach(async () => {
		const runtimes = new Set([Product?.derivedIndexRuntime, Other?.derivedIndexRuntime].filter(Boolean));
		if (Product) Product.derivedIndexRuntime = undefined;
		if (Other) Other.derivedIndexRuntime = undefined;
		for (const runtime of runtimes) await runtime.close();
		Product = undefined;
		Other = undefined;
		setFullTextNativeBindingForTests(undefined);
	});

	rocksOnly('registers multiple native indexes with one shared derived runtime', async () => {
		Product = table({
			database: `fulltext-activation-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'description', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [
				{
					...definition('title', 3, 'titleSearch'),
					fields: [
						{ name: 'title', weight: 3 },
						{ name: 'tags', weight: 1 },
					],
				},
				definition('description', 1, 'descriptionSearch'),
			],
		});
		assert.deepStrictEqual(
			Product.fullTextIndexes.map(({ name }) => name),
			['descriptionSearch', 'titleSearch']
		);
		assert(Product.derivedIndexRuntime, 'full-text declarations must attach the derived-index runtime');
		await Product.put('shoe-1', {
			title: 'Trail shoe',
			description: 'Waterproof catalog entry',
			tags: ['trail', null, 'waterproof'],
		});

		const targetIds = [
			fullTextDerivedIndexId(Product, 'titleSearch'),
			fullTextDerivedIndexId(Product, 'descriptionSearch'),
		];
		await waitFor(
			() => targetIds.every((indexId) => binding.opens.some((options) => options.indexId === indexId)),
			30_000
		);
		try {
			await waitFor(() => {
				const latest = new Map(binding.opens.map((options) => [options.indexId, options]));
				const committed = targetIds.every((indexId) => {
					const options = latest.get(indexId);
					if (!options) return false;
					const state = binding.states.get(`${options.path}\0${options.indexId}\0${options.generation}`);
					return state?.documents.size === 1 && state.payload;
				});
				return (
					committed &&
					fullTextDerivedIndexReadiness(Product, 'titleSearch').state === 'ready' &&
					fullTextDerivedIndexReadiness(Product, 'descriptionSearch').state === 'ready'
				);
			}, 30_000);
		} catch (error) {
			error.message += `; opens=${JSON.stringify(
				binding.opens.map(({ indexId, generation }) => ({ indexId, generation }))
			)}; states=${JSON.stringify(
				[...binding.states.values()].map((state) => ({ documents: state.documents.size, payload: state.payload }))
			)}`;
			throw error;
		}
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'titleSearch').state, 'ready');
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'descriptionSearch').state, 'ready');

		const byId = new Map(binding.opens.map((options) => [options.indexId, options]));
		const title = byId.get(fullTextDerivedIndexId(Product, 'titleSearch'));
		const description = byId.get(fullTextDerivedIndexId(Product, 'descriptionSearch'));
		assert.deepStrictEqual(title.fields, [
			{ name: 'title', weight: 3 },
			{ name: 'tags', weight: 1 },
		]);
		assert.deepStrictEqual(description.fields, [{ name: 'description', weight: 1 }]);
		assert.strictEqual(title.limits.indexingThreads, 1);
		assert.strictEqual(title.limits.searchThreads, 1);
		assert(path.isAbsolute(title.path));
		assert(title.path.startsWith(Product.primaryStore.rootStore.path + path.sep));

		const titleStateKey = `${title.path}\0${title.indexId}\0${title.generation}`;
		const descriptionStateKey = `${description.path}\0${description.indexId}\0${description.generation}`;
		const titleState = binding.states.get(titleStateKey);
		const descriptionState = binding.states.get(descriptionStateKey);
		const titleDocument = [...titleState.documents.values()][0];
		const descriptionDocument = [...descriptionState.documents.values()][0];
		assert.deepStrictEqual({ ...titleDocument.fields }, { title: 'Trail shoe', tags: ['trail', 'waterproof'] });
		assert.deepStrictEqual({ ...descriptionDocument.fields }, { description: 'Waterproof catalog entry' });

		assert.throws(() => Product.clear(), /whole-table invalidation is crash-safe/);
	});

	it('rejects unsupported storage and asynchronous Blob projections before registration', () => {
		let fullText = definition('manual');
		const attributes = [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'manual', type: 'Blob' },
		];
		assert.throws(
			() => assertFullTextActivationSupported({}, 'catalog', 'Product', attributes, [fullText]),
			/LMDB storage engine/
		);
		if (isLMDB) return;

		const Root = table({
			database: `fulltext-activation-root-${Date.now()}`,
			table: 'Root',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		assert.throws(
			() =>
				assertFullTextActivationSupported(Root.primaryStore.rootStore, 'catalog', 'Product', attributes, [fullText]),
			/asynchronous Blob reads/
		);

		const computed = { name: 'label', type: 'String', computed: { from: 'title' } };
		fullText = definition('label');
		assert.throws(
			() =>
				assertFullTextActivationSupported(
					Root.primaryStore.rootStore,
					'catalog',
					'Product',
					[{ name: 'id', type: 'ID', isPrimaryKey: true }, computed],
					[fullText]
				),
			/versioned resolvers/
		);
	});

	rocksOnly('reports unavailable and retries when native activation initially fails', async () => {
		const database = `fulltext-activation-failure-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		binding.runtimeInfo = async () => {
			throw new Error('native module unavailable');
		};
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});

		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'unavailable', 30_000);
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'search').reason, 'backend-failed');

		delete binding.runtimeInfo;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert(binding.opens.some((options) => options.indexId === fullTextDerivedIndexId(Product, 'search')));
	});

	rocksOnly('retries failed shutdown before a same-definition activation can replace it', async () => {
		const database = `fulltext-drop-shutdown-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const failedRuntime = Product.derivedIndexRuntime;
		binding.closeError = new Error('writer did not quiesce');

		await assert.rejects(Product.dropTable(), /shutdown failed|did not prove quiescence/);
		assert.strictEqual(Product.derivedIndexRuntime, failedRuntime);
		binding.closeError = undefined;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert.notStrictEqual(Product.derivedIndexRuntime, failedRuntime);
		assert(binding.closeAttempts > 1, 'replacement activation must re-prove predecessor quiescence');
	});

	rocksOnly('reactivates indexes already quiesced when another index blocks restore', async () => {
		const database = `fulltext-restore-shutdown-${Date.now()}`;
		const tableDefinition = (tableName, field) => ({
			database,
			table: tableName,
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: field, type: 'String' },
			],
			fullTextIndexes: [definition(field)],
		});
		Product = table(tableDefinition('Product', 'title'));
		Other = table(tableDefinition('Other', 'description'));
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await Other.put('coat-1', { description: 'Rain coat' });
		await waitFor(
			() =>
				fullTextDerivedIndexReadiness(Product, 'search').state === 'ready' &&
				fullTextDerivedIndexReadiness(Other, 'search').state === 'ready',
			30_000
		);
		const productRuntime = Product.derivedIndexRuntime;
		binding.closeErrors.set(fullTextDerivedIndexId(Other, 'search'), new Error('writer did not quiesce'));

		await assert.rejects(closeDatabaseForRestore(database), /shutdown failed|did not prove quiescence/);
		assert.notStrictEqual(Product.derivedIndexRuntime, productRuntime);
		assert(Other.derivedIndexRuntime);
		binding.closeErrors.clear();
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
	});

	rocksOnly('reactivates siblings when one derived index cannot quiesce', async () => {
		const database = `fulltext-partial-shutdown-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'description', type: 'String' },
		];
		const fullTextIndexes = () => [
			definition('title', 1, 'titleSearch'),
			definition('description', 1, 'descriptionSearch'),
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: fullTextIndexes(),
		});
		await Product.put('shoe-1', { title: 'Trail shoe', description: 'Waterproof' });
		await waitFor(
			() =>
				fullTextDerivedIndexReadiness(Product, 'titleSearch').state === 'ready' &&
				fullTextDerivedIndexReadiness(Product, 'descriptionSearch').state === 'ready',
			30_000
		);
		const titleId = fullTextDerivedIndexId(Product, 'titleSearch');
		const descriptionId = fullTextDerivedIndexId(Product, 'descriptionSearch');
		const descriptionOpenCount = binding.opens.filter(({ indexId }) => indexId === descriptionId).length;
		binding.closeErrors.set(titleId, new Error('title writer did not quiesce'));

		await assert.rejects(Product.dropTable(), /title writer did not quiesce|shutdown failed/);
		binding.closeErrors.delete(titleId);
		await Product.put('shoe-2', { title: 'Road shoe', description: 'Lightweight' });
		await waitFor(
			() =>
				fullTextDerivedIndexReadiness(Product, 'descriptionSearch').state === 'ready' &&
				binding.opens.filter(({ indexId }) => indexId === descriptionId).length > descriptionOpenCount,
			30_000
		);
		await Product.dropTable();
		Product = undefined;
	});

	rocksOnly('retains the quiescence handle after removing the final derived index', async () => {
		const database = `fulltext-remove-drain-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		let releaseClose;
		binding.closeBarrier = new Promise((resolve) => (releaseClose = resolve));

		Product = table({ database, table: 'Product', audit: true, attributes: attributes(), fullTextIndexes: [] });
		assert(Product.derivedIndexRuntime, 'the closing runtime must remain reachable until it quiesces');
		let dropSettled = false;
		const dropped = Product.dropTable().then(() => (dropSettled = true));
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(dropSettled, false, 'drop must not close storage before the removed index quiesces');
		releaseClose();
		await dropped;
		Product = undefined;
	});

	rocksOnly('rotates the native generation when a full-text declaration is removed and re-added', async () => {
		const database = `fulltext-activation-generation-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		const isCurrentIndex = (options) => options.indexId === indexId && path.dirname(options.path) === storePath;
		await waitFor(() => binding.opens.some(isCurrentIndex), 30_000);
		const firstGeneration = binding.opens.find(isCurrentIndex).generation;

		Product = table({ database, table: 'Product', audit: true, attributes: attributes(), fullTextIndexes: [] });
		await Product.dbisDB.committed;
		await Product.clear();
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		await waitFor(() => {
			const options = binding.opens.findLast(
				(options) => isCurrentIndex(options) && options.generation !== firstGeneration
			);
			if (!options) return false;
			const state = binding.states.get(`${options.path}\0${options.indexId}\0${options.generation}`);
			return state?.documents.size === 0 && fullTextDerivedIndexReadiness(Product, 'search').state === 'ready';
		}, 30_000);
		const latest = binding.opens.findLast(isCurrentIndex);
		assert.notStrictEqual(latest.generation, firstGeneration);
		assert.strictEqual(binding.states.get(`${latest.path}\0${latest.indexId}\0${latest.generation}`).documents.size, 0);
	});

	rocksOnly('rotates the native generation when the full-text definition changes', async () => {
		const database = `fulltext-activation-definition-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title', 1)],
		});
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		const isCurrentIndex = (options) => options.indexId === indexId && path.dirname(options.path) === storePath;
		await waitFor(() => binding.opens.some(isCurrentIndex), 30_000);
		const firstGeneration = binding.opens.find(isCurrentIndex).generation;

		let releaseClose;
		binding.closeBarrier = new Promise((resolve) => (releaseClose = resolve));
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title', 2)],
		});
		await new Promise((resolve) => setImmediate(resolve));
		const readinessDuringHandoff = fullTextDerivedIndexReadiness(Product, 'search');
		const openedReplacementEarly = binding.opens.some(
			(options) => isCurrentIndex(options) && options.generation !== firstGeneration
		);
		releaseClose();
		assert.strictEqual(readinessDuringHandoff.state, 'unknown');
		assert.strictEqual(openedReplacementEarly, false, 'replacement activation must await predecessor quiescence');
		await waitFor(
			() => binding.opens.some((options) => isCurrentIndex(options) && options.generation !== firstGeneration),
			30_000
		);
		const latest = binding.opens.findLast(isCurrentIndex);
		assert.notStrictEqual(latest.generation, firstGeneration);
		assert.deepStrictEqual(latest.fields, [{ name: 'title', weight: 2 }]);
	});

	rocksOnly('reuses the durable native generation after a database reload', async () => {
		const database = `fulltext-activation-reload-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('title')],
		});
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		const isCurrentIndex = (options) => options.indexId === indexId && path.dirname(options.path) === storePath;
		await waitFor(() => binding.opens.some(isCurrentIndex), 30_000);
		const firstOpen = binding.opens.find(isCurrentIndex);
		const firstToken = Product.fullTextIndexGenerations.search;
		assert.strictEqual(typeof firstToken, 'string');
		const runtime = Product.derivedIndexRuntime;
		Product.derivedIndexRuntime = undefined;
		await runtime.close();

		Product = resetDatabases()[database].Product;
		await Product.put('shoe-2', { title: 'Road shoe' });
		try {
			await waitFor(() => binding.opens.filter(isCurrentIndex).length > 1, 30_000);
		} catch (error) {
			const readiness = fullTextDerivedIndexReadiness(Product, 'search');
			error.message += `; opens=${JSON.stringify(
				binding.opens.filter(isCurrentIndex).map(({ indexId, generation }) => ({ indexId, generation }))
			)}; closeAttempts=${binding.closeAttempts}; readiness=${readiness.state}/${readiness.reason ?? ''}`;
			throw error;
		}
		const latest = binding.opens.findLast(isCurrentIndex);
		assert.strictEqual(Product.fullTextIndexGenerations.search, firstToken);
		assert.strictEqual(latest.generation, firstOpen.generation);
	});

	rocksOnly('keeps an unchanged full-text runtime attached across a catalog rescan', async () => {
		const database = `fulltext-activation-rescan-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('title')],
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const runtime = Product.derivedIndexRuntime;
		const openCount = binding.opens.length;

		Product = resetDatabases()[database].Product;

		assert.strictEqual(Product.derivedIndexRuntime, runtime);
		assert.strictEqual(binding.opens.length, openCount);
	});

	rocksOnly('retires a writer when the loaded catalog advances to another generation', async () => {
		const database = `fulltext-generation-fence-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('title')],
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const resetCount = binding.resets.length;
		const primaryEntry = [...Product.dbisDB.getRange({ start: 'Product/', end: 'Product0' })].find(
			({ value }) => value.isPrimaryKey
		);
		Product.dbisDB.putSync(primaryEntry.key, {
			...primaryEntry.value,
			fullTextIndexGenerations: { ...primaryEntry.value.fullTextIndexGenerations, search: 'new-generation' },
		});
		await Product.dbisDB.committed;
		Product.fullTextIndexGenerations = { ...Product.fullTextIndexGenerations, search: 'new-generation' };

		await Product.put('shoe-2', { title: 'Road shoe' });

		await waitFor(() => binding.closeAttempts > 0, 30_000);
		assert.strictEqual(binding.resets.length, resetCount, 'a stale writer must not reset the newer generation');
		const state = binding.states.get(
			`${binding.opens[0].path}\0${binding.opens[0].indexId}\0${binding.opens[0].generation}`
		);
		assert.strictEqual(state.documents.has('shoe-2'), false);
	});

	rocksOnly('preserves the native generation when only query behavior changes', async () => {
		const database = `fulltext-activation-query-options-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		const isCurrentIndex = (options) => options.indexId === indexId && path.dirname(options.path) === storePath;
		await waitFor(() => binding.opens.some(isCurrentIndex), 30_000);
		const firstGeneration = binding.opens.find(isCurrentIndex).generation;
		const firstOpenCount = binding.opens.filter(isCurrentIndex).length;
		const firstRuntime = Product.derivedIndexRuntime;

		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [
				{
					...definition('title'),
					fields: [{ name: 'title', weight: 1, highlight: true }],
					synonyms: [{ source: 'sneaker', replacements: ['shoe'] }],
					highlighting: { maxFragments: 2, fragmentLength: 80 },
				},
			],
		});
		assert.strictEqual(Product.derivedIndexRuntime, firstRuntime);
		assert.strictEqual(binding.opens.filter(isCurrentIndex).length, firstOpenCount);
		const latest = binding.opens.findLast(isCurrentIndex);
		assert.strictEqual(latest.generation, firstGeneration);
		assert.deepStrictEqual(latest.fields, [{ name: 'title', weight: 1 }]);
		const fullText = Product.fullTextIndexes.find((definition) => definition.name === 'search');
		assert.deepStrictEqual(fullText.synonyms, [{ source: 'sneaker', replacements: ['shoe'] }]);
		assert.deepStrictEqual(fullText.highlighting, { maxFragments: 2, fragmentLength: 80 });
	});

	rocksOnly('persists full-text changes on a table without a declared primary key', async () => {
		const database = `fulltext-no-primary-${Date.now()}`;
		const attributes = () => [{ name: 'title', type: 'String' }];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title')],
		});
		const firstGeneration = Product.fullTextIndexGenerations.search;

		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [definition('title', 2)],
		});
		const changedDescriptor = Product.dbisDB.getSync('Product/');
		assert.strictEqual(changedDescriptor.fullTextIndexes[0].fields[0].weight, 2);
		assert.notStrictEqual(changedDescriptor.fullTextIndexGenerations.search, firstGeneration);

		Product = resetDatabases()[database].Product;
		assert.strictEqual(Product.fullTextIndexes[0].fields[0].weight, 2);
		assert.strictEqual(Product.fullTextIndexGenerations.search, changedDescriptor.fullTextIndexGenerations.search);

		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
			fullTextIndexes: [],
		});
		const removedDescriptor = Product.dbisDB.getSync('Product/');
		assert.strictEqual(removedDescriptor.fullTextIndexes, undefined);
		assert.strictEqual(removedDescriptor.fullTextIndexGenerations, undefined);

		Product = resetDatabases()[database].Product;
		assert.deepStrictEqual(Product.fullTextIndexes, []);
	});

	rocksOnly('quarantines only a persisted table whose full-text recovery contract is invalid', async () => {
		const database = `fulltext-activation-quarantine-${Date.now()}`;
		const Invalid = table({
			database,
			table: 'Invalid',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('title')],
		});
		table({
			database,
			table: 'Healthy',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		const primaryEntry = [...Invalid.dbisDB.getRange({ start: 'Invalid/', end: 'Invalid0' })].find(
			({ value }) => value.isPrimaryKey
		);
		assert(primaryEntry);
		const firstGeneration = primaryEntry.value.fullTextIndexGenerations.search;
		Invalid.dbisDB.putSync(primaryEntry.key, { ...primaryEntry.value, audit: false });
		await Invalid.dbisDB.committed;
		const quarantinedPrimaryStore = Invalid.primaryStore;

		const reloaded = resetDatabases()[database];
		assert.strictEqual(reloaded.Invalid, undefined);
		await waitFor(() => quarantinedPrimaryStore.status === 'closed');
		const quarantinedGeneration = reloaded.Healthy.dbisDB.getSync(primaryEntry.key).fullTextIndexGenerations.search;
		assert.strictEqual(quarantinedGeneration, firstGeneration);
		Product = reloaded.Healthy;
		await Product.put('healthy-1', {});
		assert(await Product.get('healthy-1'));

		const repairUpdates = [];
		const onUpdate = (Table) => {
			if (Table.databaseName === database && Table.tableName === 'Invalid') repairUpdates.push(Table);
		};
		databaseEventsEmitter.on('updateTable', onUpdate);
		try {
			Product = table({
				database,
				table: 'Invalid',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
				fullTextIndexes: [definition('title')],
			});
		} finally {
			databaseEventsEmitter.off('updateTable', onUpdate);
		}
		assert.strictEqual(repairUpdates.length, 1);
		assert.strictEqual(repairUpdates[0].audit, true);
		assert(repairUpdates[0].derivedIndexRuntime);
		const repairedGeneration = Product.fullTextIndexGenerations.search;
		assert.strictEqual(repairedGeneration, firstGeneration);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
	});

	rocksOnly('retries a quarantined table runtime when restore quiesces hidden installations', async () => {
		const database = `fulltext-quarantine-restore-${Date.now()}`;
		Product = table({
			database,
			table: 'Invalid',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('title')],
		});
		Other = table({
			database,
			table: 'Healthy',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const runtime = Product.derivedIndexRuntime;
		const primaryEntry = [...Product.dbisDB.getRange({ start: 'Invalid/', end: 'Invalid0' })].find(
			({ value }) => value.isPrimaryKey
		);
		Product.dbisDB.putSync(primaryEntry.key, { ...primaryEntry.value, audit: false });
		await Product.dbisDB.committed;
		binding.closeError = new Error('writer did not quiesce');

		const reloaded = resetDatabases()[database];
		assert.strictEqual(reloaded.Invalid, undefined);
		await assert.rejects(runtime.close(), /shutdown failed|did not prove quiescence/);
		binding.closeError = undefined;

		assert.strictEqual(await closeDatabaseForRestore(database), true);
		assert.strictEqual(Product.primaryStore.status, 'closed');
		Product = undefined;
		Other = undefined;
	});

	rocksOnly('does not register an index after its table closes during native setup', async () => {
		let releaseRuntimeInfo;
		const runtimeInfo = new Promise((resolve) => (releaseRuntimeInfo = resolve));
		binding.runtimeInfo = () => runtimeInfo;
		Product = table({
			database: `fulltext-activation-close-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('title')],
		});
		const runtime = Product.derivedIndexRuntime;
		await Product.put('shoe-1', { title: 'Trail shoe' });
		const entry = Product.primaryStore.getEntry('shoe-1');
		await Product.evict('shoe-1', entry.value, entry.version);
		const hasEvictionMarker = [...Product.auditStore.getRange({ start: 1 })].some(
			(record) => record.type === 'evict' && record.recordId === 'shoe-1'
		);
		Product.derivedIndexRuntime = undefined;
		const closed = runtime.close();
		releaseRuntimeInfo(await FullTextNativeTestBinding.prototype.runtimeInfo.call(binding));
		await closed;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert(hasEvictionMarker, 'full-text tables must record evictions while native setup is pending');
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		assert.strictEqual(
			binding.opens.filter((options) => options.indexId === indexId && path.dirname(options.path) === storePath).length,
			0
		);
	});
});
