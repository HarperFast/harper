require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
} = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');

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
		this.NativeFullTextIndex = class {
			applyMutationBatch() {}
			publish() {}
			close() {}
		};
		this.runtimeInfoCalls = 0;
		this.inspection = { state: 'missing' };
		this.inspections = [];
		this.opens = [];
		this.resets = [];
		this.validations = [];
		this.reclaims = [];
	}

	async runtimeInfo() {
		this.runtimeInfoCalls++;
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 5,
			lifecycleApiVersion: 1,
			mutationBatchApiVersion: 3,
			storageBackends: ['native'],
			limits: { maxCommitPayloadBytes: 64 * 1024 },
		};
	}

	validateNativeFullTextIndexOptions(validateOptions) {
		this.validations.push(validateOptions);
		if (this.validationError) throw this.validationError;
	}

	inspectNativeFullTextIndex(inspectOptions) {
		this.inspections.push(inspectOptions);
		return this.inspection;
	}

	async openNativeFullTextIndex(openOptions) {
		this.opens.push(openOptions);
		return {
			committedPayload: this.inspection.state === 'checkpointed' ? this.inspection.committedPayload : undefined,
			async applyMutationBatch(batch) {
				return {
					processed: batch.upserts.length + batch.deletes.length,
					rejected: [],
					encodedBytes: 1,
					frames: 1,
				};
			},
			async publish() {
				return 1n;
			},
			async close() {
				return {};
			},
		};
	}

	async resetNativeFullTextIndex(resetOptions) {
		this.resets.push(resetOptions);
		return this.resetResult ?? { state: 'missing' };
	}

	async reclaimRetiredNativeFullTextIndexes(reclaimOptions) {
		this.reclaims.push(reclaimOptions);
		return this.reclaimResult ?? { removed: 0, failed: 0 };
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
		assert.strictEqual(binding.runtimeInfoCalls, 1);
		assert.deepStrictEqual(binding.opens[0].fields, [{ name: 'title', weight: 2 }]);
		assert.strictEqual(binding.opens[0].analyzer, 'english@1');
		assert.strictEqual(binding.opens[0].positions, true);
		assert.strictEqual(binding.opens[0].surfaceTerms, false);
		assert.deepStrictEqual(binding.opens[0].limits, limits);
	});

	it('delegates reset and asks the wrapper to reclaim retired storage', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		binding.resetResult = { state: 'reset', retiredPath: 'wrapper-owned' };
		await lifecycle.initialize();
		await lifecycle.reset();
		assert.deepStrictEqual(binding.resets, [{ path: lifecycle.path, indexId: 'products-title' }]);
		assert.deepStrictEqual(binding.reclaims, [
			{ path: lifecycle.path, retiredPath: undefined },
			{ path: lifecycle.path, retiredPath: 'wrapper-owned' },
		]);
	});

	it('asks the wrapper to reclaim retired storage during initialization', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		assert.deepStrictEqual(binding.reclaims, [{ path: lifecycle.path, retiredPath: undefined }]);
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

	it('rejects a cursor payload limit above the native commit limit', async () => {
		const binding = new FakeNativeModule();
		await assert.rejects(
			createNativeFullTextDerivedIndexBackend({
				...options(storePath, binding),
				id: 'products-title',
				maxCursorPayloadBytes: 64 * 1024 + 1,
			}),
			/maxCursorPayloadBytes must not exceed 65536/
		);
		assert.strictEqual(binding.opens.length, 0);
	});

	it('rejects a module without the native lifecycle contract', async () => {
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, { runtimeInfo: async () => ({}) }));
		await assert.rejects(lifecycle.initialize(), /required Harper binding contract/);
	});

	it('rejects an incompatible lifecycle API before activation', async () => {
		const binding = new FakeNativeModule();
		binding.runtimeInfo = async () => ({
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 5,
			lifecycleApiVersion: 2,
			mutationBatchApiVersion: 3,
			storageBackends: ['native'],
			limits: { maxCommitPayloadBytes: 64 * 1024 },
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('rejects a wrapper without logical mutation-batch support', async () => {
		const binding = new FakeNativeModule();
		binding.runtimeInfo = async () => ({
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 5,
			lifecycleApiVersion: 1,
			storageBackends: ['native'],
			limits: { maxCommitPayloadBytes: 64 * 1024 },
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('rejects an unknown mutation-batch API version', async () => {
		const binding = new FakeNativeModule();
		const runtimeInfo = binding.runtimeInfo.bind(binding);
		binding.runtimeInfo = async () => ({ ...(await runtimeInfo()), mutationBatchApiVersion: 4 });
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('delegates native configuration validation without touching storage', async () => {
		const binding = new FakeNativeModule();
		binding.validationError = new TypeError('invalid native configuration');
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding, { fields: [] }));
		await assert.rejects(lifecycle.initialize(), /invalid native configuration/);
		assert.strictEqual(binding.validations.length, 1);
		assert.strictEqual(binding.opens.length, 0);
		assert.throws(
			() => new NativeFullTextDerivedIndexLifecycle(options('relative', new FakeNativeModule())),
			/storePath must be absolute/
		);
	});

	it('keeps native frame and retained-source queue limits independent', async () => {
		const backend = await createNativeFullTextDerivedIndexBackend({
			...options(storePath, new FakeNativeModule(), {
				limits: { ...limits, maxBatchBytes: 2048, maxQueuedBytes: 2048 },
			}),
			id: 'products-title',
			maxQueuedBytes: 1024,
		});
		assert.strictEqual(backend.id, 'products-title');
	});
});
