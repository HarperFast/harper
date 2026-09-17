require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { databaseEventsEmitter, resetDatabases, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const {
	assertFullTextActivationSupported,
	fullTextDerivedIndexId,
	fullTextDerivedIndexReadiness,
	setFullTextNativeBindingForTests,
} = require('#src/resources/derivedIndexes');
const { FullTextNativeTestBinding } = require('./fullTextNativeTestBinding');

function definition(field, weight = 1) {
	return {
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
		const runtime = Product?.derivedIndexRuntime;
		if (Product) Product.derivedIndexRuntime = undefined;
		await runtime?.close();
		Product = undefined;
		setFullTextNativeBindingForTests(undefined);
	});

	it('registers multiple native indexes with one shared derived runtime', async () => {
		Product = table({
			database: `fulltext-activation-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'description', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
				{
					name: 'titleSearch',
					type: 'FullText',
					fullText: {
						...definition('title', 3),
						fields: [
							{ name: 'title', weight: 3 },
							{ name: 'tags', weight: 1 },
						],
					},
				},
				{ name: 'descriptionSearch', type: 'FullText', fullText: definition('description') },
			],
		});
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
		const fullText = { name: 'search', type: 'FullText', fullText: definition('manual') };
		const attributes = [{ name: 'id', type: 'ID', isPrimaryKey: true }, { name: 'manual', type: 'Blob' }, fullText];
		assert.throws(
			() => assertFullTextActivationSupported({}, 'catalog', 'Product', attributes, [fullText]),
			/LMDB storage engine/
		);

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
		fullText.fullText = definition('label');
		assert.throws(
			() =>
				assertFullTextActivationSupported(
					Root.primaryStore.rootStore,
					'catalog',
					'Product',
					[{ name: 'id', type: 'ID', isPrimaryKey: true }, computed, fullText],
					[fullText]
				),
			/versioned resolvers/
		);
	});

	it('reports unavailable and retries when native activation initially fails', async () => {
		const database = `fulltext-activation-failure-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'search', type: 'FullText', fullText: definition('title') },
		];
		binding.runtimeInfo = async () => {
			throw new Error('native module unavailable');
		};
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
		});

		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'unavailable', 30_000);
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'search').reason, 'backend-failed');

		delete binding.runtimeInfo;
		Product = table({ database, table: 'Product', audit: true, attributes: attributes() });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert(binding.opens.some((options) => options.indexId === fullTextDerivedIndexId(Product, 'search')));
	});

	it('retries failed shutdown before a same-definition activation can replace it', async () => {
		const database = `fulltext-drop-shutdown-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'search', type: 'FullText', fullText: definition('title') },
		];
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: attributes(),
		});
		await Product.put('shoe-1', { title: 'Trail shoe' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		const failedRuntime = Product.derivedIndexRuntime;
		binding.closeError = new Error('writer did not quiesce');

		await assert.rejects(Product.dropTable(), /shutdown failed|did not prove quiescence/);
		assert.strictEqual(Product.derivedIndexRuntime, failedRuntime);
		binding.closeError = undefined;
		Product = table({ database, table: 'Product', audit: true, attributes: attributes() });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
		assert.notStrictEqual(Product.derivedIndexRuntime, failedRuntime);
		assert(binding.closeAttempts > 1, 'replacement activation must re-prove predecessor quiescence');
	});

	it('rotates the native generation when a full-text declaration is removed and re-added', async () => {
		const database = `fulltext-activation-generation-${Date.now()}`;
		const attributes = () => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'search', type: 'FullText', fullText: definition('title') },
		];
		Product = table({ database, table: 'Product', audit: true, attributes: attributes() });
		await Product.put('shoe-1', { title: 'Trail shoe' });
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		const isCurrentIndex = (options) => options.indexId === indexId && path.dirname(options.path) === storePath;
		await waitFor(() => binding.opens.some(isCurrentIndex), 30_000);
		const firstGeneration = binding.opens.find(isCurrentIndex).generation;

		Product = table({ database, table: 'Product', audit: true, attributes: attributes().slice(0, 2) });
		await Product.dbisDB.committed;
		await Product.clear();
		Product = table({ database, table: 'Product', audit: true, attributes: attributes() });
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

	it('rotates the native generation when the full-text definition changes', async () => {
		const database = `fulltext-activation-definition-${Date.now()}`;
		const attributes = (weight) => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{ name: 'search', type: 'FullText', fullText: definition('title', weight) },
		];
		Product = table({ database, table: 'Product', audit: true, attributes: attributes(1) });
		const indexId = fullTextDerivedIndexId(Product, 'search');
		const storePath = Product.primaryStore.rootStore.path;
		const isCurrentIndex = (options) => options.indexId === indexId && path.dirname(options.path) === storePath;
		await waitFor(() => binding.opens.some(isCurrentIndex), 30_000);
		const firstGeneration = binding.opens.find(isCurrentIndex).generation;

		let releaseClose;
		binding.closeBarrier = new Promise((resolve) => (releaseClose = resolve));
		Product = table({ database, table: 'Product', audit: true, attributes: attributes(2) });
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

	it('preserves the native generation when only query behavior changes', async () => {
		const database = `fulltext-activation-query-options-${Date.now()}`;
		const attributes = (queryOptions = {}) => [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
			{
				name: 'search',
				type: 'FullText',
				fullText: { ...definition('title'), ...queryOptions },
			},
		];
		Product = table({ database, table: 'Product', audit: true, attributes: attributes() });
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
			attributes: attributes({
				fields: [{ name: 'title', weight: 1, highlight: true }],
				synonyms: [{ source: 'sneaker', replacements: ['shoe'] }],
				highlighting: { maxFragments: 2, fragmentLength: 80 },
			}),
		});
		assert.strictEqual(Product.derivedIndexRuntime, firstRuntime);
		assert.strictEqual(binding.opens.filter(isCurrentIndex).length, firstOpenCount);
		const latest = binding.opens.findLast(isCurrentIndex);
		assert.strictEqual(latest.generation, firstGeneration);
		assert.deepStrictEqual(latest.fields, [{ name: 'title', weight: 1 }]);
		const fullText = Product.attributes.find((attribute) => attribute.name === 'search').fullText;
		assert.deepStrictEqual(fullText.synonyms, [{ source: 'sneaker', replacements: ['shoe'] }]);
		assert.deepStrictEqual(fullText.highlighting, { maxFragments: 2, fragmentLength: 80 });
	});

	it('quarantines only a persisted table whose full-text recovery contract is invalid', async () => {
		const database = `fulltext-activation-quarantine-${Date.now()}`;
		const Invalid = table({
			database,
			table: 'Invalid',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'search', type: 'FullText', fullText: definition('title') },
			],
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
		const firstGeneration = Invalid.dbisDB.getSync('Invalid/search').fullTextGeneration;
		Invalid.dbisDB.putSync(primaryEntry.key, { ...primaryEntry.value, audit: false });
		await Invalid.dbisDB.committed;

		const reloaded = resetDatabases()[database];
		assert.strictEqual(reloaded.Invalid, undefined);
		const condemnedGeneration = reloaded.Healthy.dbisDB.getSync('Invalid/search').fullTextGeneration;
		assert.match(condemnedGeneration, /^invalid:/);
		assert.notStrictEqual(condemnedGeneration, firstGeneration);
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
					{ name: 'search', type: 'FullText', fullText: definition('title') },
				],
			});
		} finally {
			databaseEventsEmitter.off('updateTable', onUpdate);
		}
		assert.strictEqual(repairUpdates.length, 1);
		assert.strictEqual(repairUpdates[0].audit, true);
		assert(repairUpdates[0].derivedIndexRuntime);
		const repairedGeneration = Product.attributes.find((attribute) => attribute.name === 'search').fullTextGeneration;
		assert.notStrictEqual(repairedGeneration, firstGeneration);
		assert.notStrictEqual(repairedGeneration, condemnedGeneration);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'search').state === 'ready', 30_000);
	});

	it('does not register an index after its table closes during native setup', async () => {
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
				{ name: 'search', type: 'FullText', fullText: definition('title') },
			],
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
