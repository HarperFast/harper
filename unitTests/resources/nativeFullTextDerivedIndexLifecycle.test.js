require('../testUtils');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
	retireNativeFullTextDerivedIndexStorage,
} = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { DERIVED_INDEX_ACCEPTED, DERIVED_INDEX_DEFERRED } = require('#src/resources/derivedIndexRuntime');
const { waitFor } = require('../waitFor');

const limits = {
	indexingThreads: 2,
	searchThreads: 1,
	writerMemoryBytes: 64 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
};
const readerLimits = { ...limits, searchThreads: 2 };

function options(storePath, binding, overrides = {}) {
	return {
		storePath,
		storeName: 'catalog.Product.title',
		indexId: 'products-title',
		sourceGeneration: 'table-generation-1',
		fields: [{ name: 'title', weight: 2 }],
		analyzer: 'english@2',
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
		this.maxCommitPayloadBytes = 64 * 1024;
	}

	async runtimeInfo() {
		this.runtimeInfoCalls++;
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 5,
			queryClassIsolationMinimumSearchThreads: 2,
			lifecycleApiVersion: 1,
			mutationBatchApiVersion: 4,
			queryApiVersion: 2,
			storageBackends: ['native'],
			limits: {
				maxCommitPayloadBytes: this.maxCommitPayloadBytes,
				maxSearchWindow: 10_000,
				maxSearchBudgetMilliseconds: 30_000,
				maxTraceRecords: 128,
				maxTraceSourceBytes: 1024 * 1024,
			},
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

	async openNativeFullTextReader() {
		throw Object.assign(new Error('test reader is not configured'), { code: 'E_INDEX_NOT_READY' });
	}

	async resetNativeFullTextIndex(resetOptions) {
		this.resets.push(resetOptions);
		return this.resetResult ?? { state: 'missing' };
	}

	async reclaimRetiredNativeFullTextIndexes(reclaimOptions) {
		this.reclaims.push(reclaimOptions);
		if (this.reclaimWait) await this.reclaimWait;
		return this.reclaimResult ?? { removed: 0, failed: 0 };
	}
}

describe('NativeFullTextDerivedIndexLifecycle', () => {
	let storePath;

	beforeEach(() => {
		storePath = path.join(setupTestDBPath(), `fulltext-lifecycle-${Date.now()}-${Math.random()}`);
		fs.mkdirSync(storePath, { recursive: true });
	});

	it('loads the published registry package and persists a searchable checkpoint', async function () {
		const glibcVersion =
			process.platform === 'linux' ? process.report?.getReport().header.glibcVersionRuntime : undefined;
		const supportedTarget =
			(process.platform === 'darwin' && process.arch === 'arm64') ||
			(process.platform === 'linux' && glibcVersion && ['arm64', 'x64'].includes(process.arch)) ||
			(process.platform === 'win32' && process.arch === 'x64');
		if (!supportedTarget) this.skip();

		const binding = await loadFullTextNativeBinding();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding, { surfaceTerms: true }));
		await lifecycle.initialize();
		const index = await lifecycle.open();
		await index.applyMutationBatch(
			{
				upserts: [{ id: 'product-1', version: '7', fields: { title: 'Café running shoes' } }],
				deletes: [],
			},
			{ assumeDistinctIds: true, rejectedUpsert: 'delete' }
		);
		await index.publish('registry-checkpoint');
		const result = await index.search({ text: 'running', limit: 10 });
		assert.deepStrictEqual(
			result.hits.map(({ id }) => id),
			['product-1']
		);
		await index.close({ mode: 'require-clean' });
		const reader = await binding.openNativeFullTextReader({
			fields: [{ name: 'title', weight: 2 }],
			analyzer: 'english@2',
			positions: true,
			surfaceTerms: true,
			limits: readerLimits,
			path: lifecycle.path,
			indexId: 'products-title',
			generation: createHash('sha256').update('table-generation-1').digest('hex'),
		});
		assert.strictEqual(reader.committedPayload, 'registry-checkpoint');
		const readerResult = await reader.search({ text: 'running', limit: 10 });
		assert.deepStrictEqual(
			readerResult.hits.map(({ id, version }) => ({ id, version })),
			[{ id: 'product-1', version: '7' }]
		);
		const traced = await reader.traceMatches(
			{ text: 'cafe', mode: 'any' },
			[{ id: 'product-1', fields: { title: 'Café running shoes' } }],
			{ snippets: true, fragmentLength: 40, maxFragmentsPerValue: 1 }
		);
		assert.strictEqual(traced.complete, true);
		assert.deepStrictEqual(traced.records[0].values[0].spans, [{ start: 0, end: 4 }]);
		assert.strictEqual('Café running shoes'.slice(0, 4), 'Café');
		const [searchDuringReload] = await Promise.all([reader.search({ text: 'running', limit: 10 }), reader.reload()]);
		assert.deepStrictEqual(
			searchDuringReload.hits.map(({ id }) => id),
			['product-1']
		);
		const updater = await lifecycle.open();
		await updater.publish('registry-checkpoint-2');
		await updater.close({ mode: 'require-clean' });
		await reader.reload();
		assert.strictEqual(reader.committedPayload, 'registry-checkpoint-2');
		await reader.close();
		const reweightedReader = await binding.openNativeFullTextReader({
			fields: [{ name: 'title', weight: 7 }],
			analyzer: 'english@2',
			positions: true,
			surfaceTerms: true,
			limits: readerLimits,
			path: lifecycle.path,
			indexId: 'products-title',
			generation: createHash('sha256').update('table-generation-1').digest('hex'),
		});
		assert.deepStrictEqual(
			(await reweightedReader.search({ text: 'running', limit: 10 })).hits.map(({ id }) => id),
			['product-1']
		);
		await reweightedReader.close();

		assert.deepStrictEqual(lifecycle.inspect(), {
			state: 'checkpointed',
			committedPayload: 'registry-checkpoint-2',
		});

		const nextGeneration = new NativeFullTextDerivedIndexLifecycle(
			options(storePath, binding, { sourceGeneration: 'table-generation-2', surfaceTerms: true })
		);
		await nextGeneration.initialize();
		assert.deepStrictEqual(nextGeneration.inspect(), { state: 'incompatible', code: 'E_IDENTITY_MISMATCH' });
		await nextGeneration.reset();
		const rebuilt = await nextGeneration.open();
		const rebuiltResult = await rebuilt.search({ text: 'running', limit: 10 });
		assert.deepStrictEqual(rebuiltResult.hits, []);
		await rebuilt.close({ mode: 'require-clean' });
		await nextGeneration.reset();
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
		assert.strictEqual(binding.opens[0].analyzer, 'english@2');
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
		await waitFor(() => binding.reclaims.length === 2);
		assert.deepStrictEqual(binding.resets, [{ path: lifecycle.path, indexId: 'products-title' }]);
		assert.deepStrictEqual(binding.reclaims, [
			{ path: lifecycle.path, retiredPath: undefined },
			{ path: lifecycle.path, retiredPath: 'wrapper-owned' },
		]);
	});

	it('quiesces query readers before reset and resumes them after success', async () => {
		const binding = new FakeNativeModule();
		const events = [];
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(
			options(storePath, binding, {
				beforeReset: async () => events.push('paused'),
				afterReset: () => events.push('resumed'),
			})
		);
		binding.resetNativeFullTextIndex = async (resetOptions) => {
			events.push('reset');
			binding.resets.push(resetOptions);
			return { state: 'missing' };
		};
		await lifecycle.initialize();
		await lifecycle.reset();
		assert.deepStrictEqual(events, ['paused', 'reset', 'resumed']);
	});

	it('resumes query readers when reset preparation or native reset fails', async () => {
		for (const failure of ['prepare', 'reset']) {
			const binding = new FakeNativeModule();
			const events = [];
			const lifecycle = new NativeFullTextDerivedIndexLifecycle(
				options(storePath, binding, {
					beforeReset: async () => {
						events.push('paused');
						if (failure === 'prepare') throw new Error('pause failed');
					},
					afterReset: async () => events.push('resumed'),
				})
			);
			if (failure === 'reset')
				binding.resetNativeFullTextIndex = async () => {
					events.push('reset');
					throw new Error('reset failed');
				};
			await lifecycle.initialize();
			await assert.rejects(lifecycle.reset(), /failed/);
			assert.deepStrictEqual(events, failure === 'prepare' ? ['paused', 'resumed'] : ['paused', 'reset', 'resumed']);
		}
	});

	it('does not block reset on best-effort retired storage reclamation', async () => {
		let finishReclaim;
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		binding.resetResult = { state: 'reset', retiredPath: 'wrapper-owned' };
		await lifecycle.initialize();
		await waitFor(() => binding.reclaims.length === 1);
		binding.reclaimWait = new Promise((resolve) => (finishReclaim = resolve));

		await lifecycle.reset();
		await waitFor(() => binding.reclaims.length === 2);
		assert.deepStrictEqual(binding.reclaims.at(-1), { path: lifecycle.path, retiredPath: 'wrapper-owned' });
		finishReclaim();
	});

	it('retires a missing native directory without loading the optional binding', async () => {
		fs.mkdirSync(path.join(storePath, '.fulltext-retired'));
		await assert.doesNotReject(
			retireNativeFullTextDerivedIndexStorage({
				storePath,
				storeName: 'catalog.Product.missing',
				indexId: 'missing-index',
				binding: async () => {
					throw new Error('native module unavailable');
				},
			})
		);
	});

	it('serializes best-effort retired storage reclamation', async () => {
		let finishReclaim;
		const binding = new FakeNativeModule();
		binding.reclaimWait = new Promise((resolve) => (finishReclaim = resolve));
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await lifecycle.initialize();
		assert.deepStrictEqual(binding.reclaims, [{ path: lifecycle.path, retiredPath: undefined }]);
		await lifecycle.reset();
		assert.strictEqual(binding.reclaims.length, 1);
		finishReclaim();
		await waitFor(() => binding.reclaims.length === 2);
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
		assert.strictEqual(binding.runtimeInfoCalls, 0);
		assert.strictEqual(binding.reclaims.length, 0);
		assert.strictEqual(binding.opens.length, 0);
	});

	it('rejects a cursor payload limit above a smaller native commit capacity without touching storage', async () => {
		const binding = new FakeNativeModule();
		binding.maxCommitPayloadBytes = 32 * 1024;
		await assert.rejects(
			createNativeFullTextDerivedIndexBackend({
				...options(storePath, binding),
				id: 'products-title',
				maxCursorPayloadBytes: 48 * 1024,
			}),
			/native commit payload capacity/
		);
		assert.strictEqual(binding.runtimeInfoCalls, 1);
		assert.strictEqual(binding.reclaims.length, 0);
		assert.strictEqual(binding.opens.length, 0);
	});

	it('clamps the default cursor payload limit to a smaller native commit capacity', async () => {
		const binding = new FakeNativeModule();
		binding.maxCommitPayloadBytes = 32 * 1024;
		const backendOptions = {
			...options(storePath, binding),
			id: 'products-title',
		};
		assert.strictEqual(backendOptions.maxCursorPayloadBytes, undefined);
		const backend = await createNativeFullTextDerivedIndexBackend(backendOptions);

		assert.strictEqual(backend.id, 'products-title');
		assert.strictEqual(binding.runtimeInfoCalls, 1);
		assert.strictEqual(binding.reclaims.length, 1);
		assert.strictEqual(binding.opens.length, 0);
	});

	it('validates backend options before starting retired storage reclamation', async () => {
		const binding = new FakeNativeModule();
		await assert.rejects(
			createNativeFullTextDerivedIndexBackend({
				...options(storePath, binding),
				id: 'products-title',
				closeTimeoutMilliseconds: 35_000,
				shutdownTimeoutMilliseconds: 40_000,
			}),
			/shutdownTimeoutMilliseconds must be at least twice closeTimeoutMilliseconds/
		);
		assert.strictEqual(binding.runtimeInfoCalls, 1);
		assert.strictEqual(binding.reclaims.length, 0);
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
			queryClassIsolationMinimumSearchThreads: 2,
			lifecycleApiVersion: 2,
			mutationBatchApiVersion: 4,
			queryApiVersion: 2,
			storageBackends: ['native'],
			limits: {
				maxCommitPayloadBytes: 64 * 1024,
				maxSearchWindow: 10_000,
				maxSearchBudgetMilliseconds: 30_000,
				maxTraceRecords: 128,
				maxTraceSourceBytes: 1024 * 1024,
			},
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
			queryClassIsolationMinimumSearchThreads: 2,
			lifecycleApiVersion: 1,
			storageBackends: ['native'],
			limits: {
				maxCommitPayloadBytes: 64 * 1024,
				maxSearchWindow: 10_000,
				maxSearchBudgetMilliseconds: 30_000,
				maxTraceRecords: 128,
				maxTraceSourceBytes: 1024 * 1024,
			},
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('rejects an unknown mutation-batch API version', async () => {
		const binding = new FakeNativeModule();
		const runtimeInfo = binding.runtimeInfo.bind(binding);
		binding.runtimeInfo = async () => ({ ...(await runtimeInfo()), mutationBatchApiVersion: 5 });
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('requires the native trace source-byte limit', async () => {
		const binding = new FakeNativeModule();
		const runtimeInfo = binding.runtimeInfo.bind(binding);
		binding.runtimeInfo = async () => {
			const info = await runtimeInfo();
			delete info.limits.maxTraceSourceBytes;
			return info;
		};
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.initialize(), /incompatible runtime capabilities/);
	});

	it('requires the native search execution budget', async () => {
		const binding = new FakeNativeModule();
		const runtimeInfo = binding.runtimeInfo.bind(binding);
		binding.runtimeInfo = async () => {
			const info = await runtimeInfo();
			delete info.limits.maxSearchBudgetMilliseconds;
			return info;
		};
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
		const binding = new FakeNativeModule();
		const backend = await createNativeFullTextDerivedIndexBackend({
			...options(storePath, binding, {
				limits: { ...limits, maxBatchBytes: 2048, maxQueuedBytes: 2048 },
			}),
			id: 'products-title',
			maxQueuedBytes: 1024,
		});
		backend.attach({
			isOwnerEpoch: (epoch) => epoch === 1n,
			getReadiness: () => ({ state: 'ready', ownerEpoch: 1n, rebuildAttempts: 0 }),
			publicationChanged() {},
		});
		const batch = { ownerEpoch: 1n, transactions: [], records: [], bytes: 800 };
		assert.strictEqual(backend.deliver(batch), DERIVED_INDEX_ACCEPTED);
		assert.strictEqual(backend.deliver(batch), DERIVED_INDEX_DEFERRED);
		await backend.shutdown(1n);
		assert.strictEqual(binding.opens[0].limits.maxQueuedBytes, 2048);
	});
});
