require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setupTestDBPath } = require('../testUtils');
const {
	createNativeFullTextDerivedIndexBackend,
	NativeFullTextDerivedIndexLifecycle,
} = require('#src/resources/NativeFullTextDerivedIndexLifecycle');
const { FullTextGenerationInvalidError } = require('#src/resources/FullTextDerivedIndexBackend');
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
		this.payloads = new Map();
		this.opens = [];
		this.closes = [];
	}

	async runtimeInfo() {
		return {
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 2,
			storageBackends: ['native'],
		};
	}

	async openNativeFullTextIndex(openOptions) {
		this.opens.push(openOptions);
		if (this.openError) throw this.openError;
		const module = this;
		const engine = {
			committedPayload: module.payloads.get(openOptions.generation),
			async apply(bytes) {
				const batch = JSON.parse(Buffer.from(bytes).toString());
				return batch.upserts.length + batch.deletes.length;
			},
			async publish(payload) {
				module.payloads.set(openOptions.generation, payload);
				this.committedPayload = payload;
				return 1n;
			},
			async close(options) {
				module.closes.push({ generation: openOptions.generation, options });
			},
		};
		this.afterOpen?.(openOptions, engine);
		return engine;
	}

	encodeMutationBatch(batch) {
		return Buffer.from(JSON.stringify(batch));
	}
}

describe('NativeFullTextDerivedIndexLifecycle', () => {
	let storePath;

	beforeEach(() => {
		storePath = path.join(setupTestDBPath(), `fulltext-lifecycle-${Date.now()}-${Math.random()}`);
		fs.mkdirSync(storePath, { recursive: true });
	});

	it('reopens the selected native generation and its committed cursor', async () => {
		const binding = new FakeNativeModule();
		const firstLifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const first = await firstLifecycle.replace(1n);
		assert.strictEqual(first.committedPayload, undefined);
		await first.publish('cursor-1');
		await first.close({ mode: 'require-clean' });

		const secondLifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const reopened = await secondLifecycle.open(2n);
		assert.strictEqual(reopened.committedPayload, 'cursor-1');
		assert.strictEqual(binding.opens.length, 2);
		assert.strictEqual(binding.opens[0].generation, binding.opens[1].generation);
		assert(binding.opens[1].path.startsWith(`${firstLifecycle.path}${path.sep}`));
		await reopened.close({ mode: 'require-clean' });
	});

	it('requires reset to create the first generation', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.open(1n), FullTextGenerationInvalidError);
		assert.strictEqual(binding.opens.length, 0);
	});

	it('closes an opened writer when post-open cleanup fails', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const seeded = await lifecycle.replace(1n);
		await seeded.close({ mode: 'rollback' });
		binding.afterOpen = () => fs.rmSync(path.join(lifecycle.path, 'generations'), { recursive: true });
		await assert.rejects(lifecycle.open(2n), /ENOENT/);
		assert.strictEqual(binding.closes.length, 2);
		assert.deepStrictEqual(binding.closes.at(-1).options, { mode: 'rollback' });
	});

	it('repairs corrupt Harper metadata while replacing the derived index', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const seeded = await lifecycle.replace(1n);
		await seeded.close({ mode: 'rollback' });
		fs.writeFileSync(path.join(lifecycle.path, 'STORE.json'), '{truncated');
		await assert.rejects(lifecycle.open(2n), FullTextGenerationInvalidError);
		const replacement = await lifecycle.replace(2n);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(lifecycle.path, 'STORE.json'))), {
			format: 1,
			storeName: 'catalog.Product.title',
		});
		await replacement.close({ mode: 'rollback' });
	});

	it('canonicalizes malformed version-one metadata during replacement', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const seeded = await lifecycle.replace(1n);
		await seeded.close({ mode: 'rollback' });
		fs.writeFileSync(
			path.join(lifecycle.path, 'STORE.json'),
			JSON.stringify({ format: 1, storeName: 'catalog.Product.title', unexpected: true })
		);
		const replacement = await lifecycle.replace(2n);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(lifecycle.path, 'STORE.json'))), {
			format: 1,
			storeName: 'catalog.Product.title',
		});
		await replacement.close({ mode: 'rollback' });
	});

	it('rejects a native module without the required runtime contract', async () => {
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(
			options(storePath, { openNativeFullTextIndex() {}, encodeMutationBatch() {} })
		);
		await assert.rejects(lifecycle.replace(1n), /required Harper binding contract/);
	});

	it('rejects a native module with an incompatible ABI', async () => {
		const binding = new FakeNativeModule();
		binding.runtimeInfo = async () => ({
			packageVersion: 'test',
			tantivyVersion: 'test',
			nativeAbiVersion: 3,
			storageBackends: ['native'],
		});
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		await assert.rejects(lifecycle.replace(1n), /incompatible runtime capabilities/);
	});

	it('validates native configuration before creating storage', () => {
		assert.throws(
			() => new NativeFullTextDerivedIndexLifecycle(options(storePath, new FakeNativeModule(), { fields: [] })),
			/fields must contain/
		);
		assert.throws(
			() =>
				new NativeFullTextDerivedIndexLifecycle(
					options(storePath, new FakeNativeModule(), {
						limits: { ...limits, writerMemoryBytes: 1 },
					})
				),
			/Tantivy limits/
		);
	});

	it('selects a cursorless replacement before reclaiming the old generation', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const first = await lifecycle.replace(1n);
		const firstPath = binding.opens[0].path;
		await first.close({ mode: 'require-clean' });

		const replacement = await lifecycle.replace(2n);
		const replacementPath = binding.opens.at(-1).path;
		assert.notStrictEqual(replacementPath, firstPath);
		assert.strictEqual(replacement.committedPayload, undefined);
		const selector = JSON.parse(fs.readFileSync(path.join(lifecycle.path, 'CURRENT')));
		assert.strictEqual(path.basename(replacementPath), selector.generationId);
		await waitFor(() => !fs.existsSync(firstPath));
		await replacement.close({ mode: 'require-clean' });
	});

	it('fails closed when a restored selector belongs to another source generation', async () => {
		const binding = new FakeNativeModule();
		const original = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const engine = await original.replace(1n);
		await engine.close({ mode: 'rollback' });

		const restored = new NativeFullTextDerivedIndexLifecycle(
			options(storePath, binding, { sourceGeneration: 'table-generation-2' })
		);
		await assert.rejects(restored.open(2n), FullTextGenerationInvalidError);
	});

	it('never uses selector content as an unchecked removal path', async () => {
		const binding = new FakeNativeModule();
		const lifecycle = new NativeFullTextDerivedIndexLifecycle(options(storePath, binding));
		const first = await lifecycle.replace(1n);
		await first.close({ mode: 'rollback' });
		const outside = path.join(storePath, 'outside');
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'keep'), 'keep');
		fs.writeFileSync(
			path.join(lifecycle.path, 'CURRENT'),
			JSON.stringify({ format: 1, sourceIdentity: 'bad', generationId: '../../outside' })
		);

		const replacement = await lifecycle.replace(2n);
		assert.strictEqual(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
		await replacement.close({ mode: 'rollback' });
	});

	for (const operation of ['activate', 'replace']) {
		for (const crashPoint of ['before-selector', 'after-selector']) {
			it(`recovers after process termination ${crashPoint.replace('-', ' ')} during ${operation}`, async function () {
				this.timeout(10_000);
				let priorGenerationId;
				if (operation === 'replace') {
					const seed = new NativeFullTextDerivedIndexLifecycle(
						options(storePath, new FakeNativeModule(), {
							storeName: 'crash-test-index',
							indexId: 'crash-test-index',
							sourceGeneration: 'source-generation-1',
						})
					);
					const engine = await seed.replace(1n);
					await engine.close({ mode: 'rollback' });
					priorGenerationId = JSON.parse(fs.readFileSync(path.join(seed.path, 'CURRENT'))).generationId;
				}
				const child = spawn(
					process.execPath,
					[path.join(__dirname, 'nativeFullTextLifecycleCrash.cjs'), storePath, crashPoint, operation],
					{
						stdio: ['ignore', 'pipe', 'pipe'],
						env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=typestrip`.trim() },
					}
				);
				const expected = crashPoint === 'before-selector' ? 'generation-open' : 'selector-published';
				try {
					await outputContains(child, expected);
				} catch (error) {
					child.kill('SIGKILL');
					throw error;
				}
				const exited = new Promise((resolve) => child.once('exit', resolve));
				child.kill('SIGKILL');
				await exited;

				const binding = new FakeNativeModule();
				const lifecycle = new NativeFullTextDerivedIndexLifecycle(
					options(storePath, binding, {
						storeName: 'crash-test-index',
						indexId: 'crash-test-index',
						sourceGeneration: 'source-generation-1',
					})
				);
				let engine;
				if (operation === 'activate' && crashPoint === 'before-selector') {
					await assert.rejects(lifecycle.open(2n), FullTextGenerationInvalidError);
					engine = await lifecycle.replace(2n);
				} else {
					engine = await lifecycle.open(2n);
				}
				const selector = JSON.parse(fs.readFileSync(path.join(lifecycle.path, 'CURRENT')));
				if (operation === 'replace')
					assert.strictEqual(selector.generationId === priorGenerationId, crashPoint === 'before-selector');
				assert.strictEqual(path.basename(binding.opens[0].path), selector.generationId);
				await waitFor(
					() =>
						fs.readdirSync(path.join(lifecycle.path, 'generations')).filter((name) => /^[0-9a-f-]{36}$/.test(name))
							.length === 1
				);
				await engine.close({ mode: 'rollback' });
			});
		}
	}

	for (const code of ['E_IDENTITY_MISMATCH', 'E_INCOMPLETE_CREATE', 'E_SCHEMA_MISMATCH']) {
		it(`routes ${code} through acquisition as a rebuildable generation`, async () => {
			const binding = new FakeNativeModule();
			const seeded = await new NativeFullTextDerivedIndexLifecycle(options(storePath, binding)).replace(0n);
			await seeded.close({ mode: 'rollback' });
			const opensBeforeAcquire = binding.opens.length;
			binding.openError = Object.assign(new Error(code), { code });
			const backend = createNativeFullTextDerivedIndexBackend({
				...options(storePath, binding),
				id: `invalid-${code}`,
				openAttempts: 3,
				openRetryMilliseconds: 0,
			});
			backend.attach({ isOwnerEpoch: (epoch) => epoch === 1n });
			assert.strictEqual(await backend.acquire(1n), undefined);
			assert.strictEqual(binding.opens.length - opensBeforeAcquire, 1);
		});
	}

	it('keeps storage failures transient instead of replacing a generation', async () => {
		const binding = new FakeNativeModule();
		const seeded = await new NativeFullTextDerivedIndexLifecycle(options(storePath, binding)).replace(0n);
		await seeded.close({ mode: 'rollback' });
		const opensBeforeAcquire = binding.opens.length;
		binding.openError = Object.assign(new Error('disk unavailable'), { code: 'E_STORAGE' });
		const backend = createNativeFullTextDerivedIndexBackend({
			...options(storePath, binding),
			id: 'transient-storage',
			openAttempts: 2,
			openRetryMilliseconds: 0,
		});
		backend.attach({ isOwnerEpoch: (epoch) => epoch === 1n });
		await assert.rejects(backend.acquire(1n), /generation could not be opened/);
		assert.strictEqual(binding.opens.length - opensBeforeAcquire, 2);
	});
});

function outputContains(child, expected) {
	return new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error(`Child did not report ${expected}: ${output}`)), 5000);
		child.stdout.on('data', (chunk) => {
			output += chunk;
			if (!output.includes(expected)) return;
			clearTimeout(timer);
			resolve();
		});
		child.stderr.on('data', (chunk) => (output += chunk));
		child.once('exit', (code) => {
			if (code === 0 || output.includes(expected)) return;
			clearTimeout(timer);
			reject(new Error(`Child exited ${code}: ${output}`));
		});
	});
}
