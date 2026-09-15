require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
} = require('#src/resources/NativeFullTextDerivedIndexLifecycle');
const { waitFor } = require('../waitFor');

const limits = {
	indexingThreads: 1,
	searchThreads: 1,
	writerMemoryBytes: 32 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
};

function options(storePath, binding, overrides = {}) {
	return {
		storePath,
		storeName: 'catalog.Product.title',
		indexId: 'products-title',
		sourceGeneration: 'table-generation-1',
		fields: [{ name: 'title', weight: 2 }],
		analyzer: 'english@1',
		positions: true,
		surfaceTerms: false,
		limits,
		binding,
		...overrides,
	};
}

class FakeNativeModule {
	constructor() {
		this.inspection = { state: 'missing' };
		this.inspections = [];
		this.opens = [];
		this.resets = [];
		this.encodes = [];
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 4,
			storageBackends: ['native'],
		};
	}

	inspectNativeFullTextIndex(inspectOptions) {
		this.inspections.push(inspectOptions);
		return this.inspection;
	}

	async openNativeFullTextIndex(openOptions) {
		this.opens.push(openOptions);
		return {
			committedPayload: this.inspection.state === 'checkpointed' ? this.inspection.committedPayload : undefined,
			async apply() {
				return 0;
			},
			async publish() {
				return 1n;
			},
			async close() {},
		};
	}

	async resetNativeFullTextIndex(resetOptions) {
		this.resets.push(resetOptions);
		return this.resetResult ?? { state: 'missing' };
	}

	encodeMutationBatch(batch, maxBytes) {
		this.encodes.push({ batch, maxBytes });
		return Buffer.from(JSON.stringify(batch));
	}
}

describe('NativeFullTextDerivedIndexLifecycle', () => {
	let storePath;

	beforeEach(() => {
		storePath = path.join(setupTestDBPath(), `fulltext-lifecycle-${Date.now()}-${Math.random()}`);
		fs.mkdirSync(storePath, { recursive: true });
	});

	it('uses one deterministic native directory and stable source generation', async () => {
		const binding = new FakeNativeModule();
		const first = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const second = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await first.initialize();
		await second.initialize();
		await first.open();
		await second.open();
		assert.strictEqual(first.path, second.path);
		assert.strictEqual(binding.opens[0].path, first.path);
		assert.strictEqual(binding.opens[0].generation, binding.opens[1].generation);
		assert(!binding.opens[0].path.includes(`${path.sep}generations${path.sep}`));
	});

	it('keeps path identity separate from source-generation compatibility', async () => {
		const binding = new FakeNativeModule();
		const first = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const changed = new NativeFullTextDerivedIndexLifecycle(
			options(storePath, binding, { sourceGeneration: 'table-generation-2' })
		);
		await first.initialize();
		await changed.initialize();
		first.inspect();
		changed.inspect();
		assert.strictEqual(first.path, changed.path);
		assert.notStrictEqual(binding.inspections[0].generation, binding.inspections[1].generation);
	});

	it('delegates synchronous inspection without opening a writer', async () => {
		const binding = new FakeNativeModule();
		binding.inspection = { state: 'checkpointed', committedPayload: 'cursor' };
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		assert.deepStrictEqual(lifecycle.inspect(), binding.inspection);
		assert.strictEqual(binding.inspections.length, 1);
		assert.strictEqual(binding.opens.length, 0);
		assert.strictEqual(binding.inspections[0].limits, undefined);
	});

	it('passes native configuration through on lazy open', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		await lifecycle.open();
		assert.deepStrictEqual(binding.opens[0].fields, [{ name: 'title', weight: 2 }]);
		assert.strictEqual(binding.opens[0].analyzer, 'english@1');
		assert.strictEqual(binding.opens[0].positions, true);
		assert.strictEqual(binding.opens[0].surfaceTerms, false);
		assert.deepStrictEqual(binding.opens[0].limits, limits);
	});

	it('delegates reset and reclaims the wrapper-retired directory asynchronously', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const retiredPath = path.join(storePath, '.fulltext-retired', 'retired-index');
		fs.mkdirSync(retiredPath, { recursive: true });
		binding.resetResult = { state: 'reset', retiredPath };
		await lifecycle.initialize();
		await lifecycle.reset();
		assert.deepStrictEqual(binding.resets, [{ path: lifecycle.path, indexId: 'products-title' }]);
		await waitFor(() => !fs.existsSync(retiredPath));
	});

	it('does not remove a retirement path outside the wrapper retirement root', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const unrelatedPath = path.join(storePath, 'unrelated');
		fs.mkdirSync(unrelatedPath);
		binding.resetResult = { state: 'reset', retiredPath: unrelatedPath };
		await lifecycle.initialize();
		await lifecycle.reset();
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(fs.existsSync(unrelatedPath), true);
	});

	it('uses the wrapper encoder and its configured batch limit', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		const batch = { upserts: [], deletes: ['one'] };
		assert(lifecycle.encodeMutationBatch(batch) instanceof Uint8Array);
		assert.deepStrictEqual(binding.encodes, [{ batch, maxBytes: limits.maxBatchBytes }]);
	});

	it('preloads and validates the binding before returning a backend', async () => {
		const binding = new FakeNativeModule();
		let loaded = 0;
		const backend = await createNativeFullTextDerivedIndexBackend({
			...options(storePath, async () => {
				loaded++;
				return binding;
			}),
			id: 'products-title',
		});
		assert.strictEqual(backend.id, 'products-title');
		assert.strictEqual(loaded, 1);
		assert.strictEqual(binding.opens.length, 0);
	});

	it('rejects a module without the native lifecycle contract', async () => {
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, { runtimeInfo: async () => ({}) }));
		await assert.rejects(lifecycle.initialize(), /required Harper binding contract/);
	});

	it('rejects an incompatible ABI before activation', async () => {
		const binding = new FakeNativeModule();
		binding.runtimeInfo = async () => ({
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 3,
			storageBackends: ['native'],
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('validates native configuration without touching storage', () => {
		assert.throws(
			() => new NativeFullTextDerivedIndexLifecycle(options(storePath, new FakeNativeModule(), { fields: [] })),
			/fields must contain/
		);
		assert.throws(
			() =>
				new NativeFullTextDerivedIndexLifecycle(
					options(storePath, new FakeNativeModule(), { limits: { ...limits, writerMemoryBytes: 1 } })
				),
			/Tantivy limits/
		);
		assert.throws(
			() => new NativeFullTextDerivedIndexLifecycle(options('relative', new FakeNativeModule())),
			/storePath must be absolute/
		);
	});
});
