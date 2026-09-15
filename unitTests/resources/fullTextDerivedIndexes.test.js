require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const {
	assertFullTextActivationSupported,
	fullTextDerivedIndexId,
	fullTextDerivedIndexReadiness,
	setFullTextNativeBindingForTests,
} = require('#src/resources/derivedIndexes');

class FakeNativeModule {
	constructor() {
		this.generations = new Map();
		this.opens = [];
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 2,
			storageBackends: ['native'],
		};
	}

	async openNativeFullTextIndex(options) {
		this.opens.push(options);
		let state = this.generations.get(options.generation);
		if (!state) {
			state = { documents: new Map(), payload: undefined };
			this.generations.set(options.generation, state);
		}
		return {
			committedPayload: state.payload,
			async apply(bytes) {
				const batch = JSON.parse(Buffer.from(bytes).toString());
				for (const id of batch.deletes) state.documents.delete(id);
				for (const document of batch.upserts) state.documents.set(document.id, document);
				return batch.upserts.length + batch.deletes.length;
			},
			async publish(payload) {
				state.payload = payload;
				this.committedPayload = payload;
				return 1n;
			},
			async close() {},
		};
	}

	encodeMutationBatch(batch) {
		return Buffer.from(JSON.stringify(batch));
	}
}

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
		binding = new FakeNativeModule();
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
				{ name: 'titleSearch', type: 'FullText', fullText: definition('title', 3) },
				{ name: 'descriptionSearch', type: 'FullText', fullText: definition('description') },
			],
		});
		await Product.put('shoe-1', { title: 'Trail shoe', description: 'Waterproof catalog entry' });

		await waitFor(() => new Set(binding.opens.map(({ indexId }) => indexId)).size === 2, 30_000);
		try {
			await waitFor(() => {
				const latest = new Map(binding.opens.map((options) => [options.indexId, options]));
				const committed = [...latest.values()].every((options) => {
					const state = binding.generations.get(options.generation);
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
			)}; generations=${JSON.stringify(
				[...binding.generations.values()].map((state) => ({ documents: state.documents.size, payload: state.payload }))
			)}`;
			throw error;
		}
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'titleSearch').state, 'ready');
		assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'descriptionSearch').state, 'ready');

		const byId = new Map(binding.opens.map((options) => [options.indexId, options]));
		const title = byId.get(fullTextDerivedIndexId(Product, 'titleSearch'));
		const description = byId.get(fullTextDerivedIndexId(Product, 'descriptionSearch'));
		assert.deepStrictEqual(title.fields, [{ name: 'title', weight: 3 }]);
		assert.deepStrictEqual(description.fields, [{ name: 'description', weight: 1 }]);
		assert.strictEqual(title.limits.indexingThreads, 1);
		assert.strictEqual(title.limits.searchThreads, 1);
		assert(path.isAbsolute(title.path));
		assert(title.path.startsWith(Product.primaryStore.rootStore.path + path.sep));

		const titleDocument = [...binding.generations.get(title.generation).documents.values()][0];
		const descriptionDocument = [...binding.generations.get(description.generation).documents.values()][0];
		assert.deepStrictEqual(titleDocument.fields, { title: 'Trail shoe' });
		assert.deepStrictEqual(descriptionDocument.fields, { description: 'Waterproof catalog entry' });
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
	});
});
