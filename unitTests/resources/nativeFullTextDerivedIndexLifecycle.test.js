require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
} = require('#src/resources/NativeFullTextDerivedIndexLifecycle');

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
			encodeMutationBatches() {}
		};
		this.inspection = { state: 'missing' };
		this.inspections = [];
		this.opens = [];
		this.resets = [];
		this.validations = [];
		this.reclaims = [];
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 5,
			lifecycleApiVersion: 1,
			mutationBatchApiVersion: 2,
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
			encodeMutationBatches(batch) {
				return {
					batches: [
						{
							bytes: Buffer.from(JSON.stringify(batch)),
							mutationCount: batch.upserts.length + batch.deletes.length,
						},
					],
					rejected: [],
					consumedUpserts: batch.upserts.length,
					consumedDeletes: batch.deletes.length,
				};
			},
			async apply() {
				return 0;
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
		assert.deepStrictEqual(binding.opens[0].fields, [{ name: 'title', weight: 2 }]);
		assert.strictEqual(binding.opens[0].analyzer, 'english@1');
		assert.strictEqual(binding.opens[0].positions, true);
		assert.strictEqual(binding.opens[0].surfaceTerms, false);
		assert.deepStrictEqual(binding.opens[0].limits, limits);
	});

	it('rollback-closes an opened handle that does not implement the engine contract', async () => {
		const binding = new FakeNativeModule();
		const closes = [];
		binding.openNativeFullTextIndex = async () => ({
			async close(closeOptions) {
				closes.push(closeOptions);
				return {};
			},
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		await assert.rejects(lifecycle.open(), /invalid index handle/);
		assert.deepStrictEqual(closes, [{ mode: 'rollback' }]);
	});

	it('retains an invalid handle until rollback close proves quiescence', async () => {
		const binding = new FakeNativeModule();
		let closes = 0;
		binding.openNativeFullTextIndex = async () => ({
			async close() {
				if (++closes === 1) throw new Error('writer still active');
				return {};
			},
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		await assert.rejects(lifecycle.open(), /could not be closed/);
		await lifecycle.quiesce();
		assert.strictEqual(closes, 2);
	});

	it('releases an invalid handle after native reports a quiesced cleanup error', async () => {
		const binding = new FakeNativeModule();
		let closes = 0;
		binding.openNativeFullTextIndex = async () => ({
			async close() {
				closes++;
				return { cleanupError: new Error('native cleanup failed after release') };
			},
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		await assert.rejects(lifecycle.open(), /invalid index handle/);
		await lifecycle.quiesce();
		assert.strictEqual(closes, 1);
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
			mutationBatchApiVersion: 2,
			storageBackends: ['native'],
			limits: { maxCommitPayloadBytes: 64 * 1024 },
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('rejects a wrapper without resumable mutation-batch support', async () => {
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

	it('keeps the native frame limit within the backend total limit', async () => {
		await assert.rejects(
			createNativeFullTextDerivedIndexBackend({
				...options(storePath, new FakeNativeModule(), {
					limits: { ...limits, maxBatchBytes: 2048, maxQueuedBytes: 2048 },
				}),
				id: 'products-title',
				maxQueuedBytes: 1024,
			}),
			/backend maxQueuedBytes/
		);
	});
});
