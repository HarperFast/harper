const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');

async function run() {
	const maxSearchThreads = Number(process.argv[2]);
	env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME, { maxSearchThreads });
	if (process.argv[3] === 'invalid-query') env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_QUERY, { maxQueryTerms: 0 });
	if (process.argv[3] === 'policy') env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_QUERY, JSON.parse(process.argv[4]));
	if (process.argv[3] === 'unmanaged' || process.argv[3] === 'early-worker') {
		const { Worker } = require('node:worker_threads');
		const early = process.argv[3] === 'early-worker';
		if (!early) getFullTextRuntimeConfiguration();
		const result = await new Promise((resolve, reject) => {
			const worker = new Worker(
				`
				const { parentPort, workerData } = require('node:worker_threads');
				const env = require('#src/utility/environment/environmentManager');
				const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME, { maxSearchThreads: workerData.maxSearchThreads + 1 });
				const optionalRuntime = require('#src/resources/indexes/fullTextRuntimeConfiguration').getFullTextRuntimeConfiguration(false);
				require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding().then(
					() => parentPort.postMessage('ready'),
					(error) => parentPort.postMessage({ status: error.statusCode, error: error.message, name: error.name, retryable: error.retryable, optionalRuntimeAvailable: optionalRuntime !== undefined })
				);
			`,
				{ eval: true, workerData: { maxSearchThreads } }
			);
			if (early) getFullTextRuntimeConfiguration();
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		await require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding();
		console.log(JSON.stringify({ unmanaged: result }));
		return;
	}
	const snapshot = getFullTextRuntimeConfiguration();
	if (process.argv[3] === 'invalid-query') {
		const assert = require('node:assert');
		const {
			NativeFullTextDerivedIndexLifecycle,
		} = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');
		const { getFullTextQueryPolicy } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
		const lifecycle = new NativeFullTextDerivedIndexLifecycle({
			storePath: process.argv[5],
			storeName: 'writer-isolation',
			indexId: 'writer-isolation',
			sourceGeneration: 'one',
			analyzer: 'english@2',
			fields: [{ name: 'title' }],
			limits: {
				indexingThreads: 1,
				searchThreads: 2,
				writerMemoryBytes: 64000000,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64000000,
				maxBatchBytes: 8388608,
			},
		});
		await lifecycle.initialize({ reclaimRetired: false });
		const writer = await lifecycle.open();
		try {
			assert.throws(() => getFullTextQueryPolicy(), /positive safe integer/);
			await writer.publish('writer-alive');
			assert.strictEqual(lifecycle.inspect().state, 'checkpointed');
		} finally {
			await writer.close({ mode: 'rollback' });
		}
		const { FullTextQueryIndex } = require('#src/resources/indexes/fullTextQueryIndex');
		const query = new FullTextQueryIndex({
			Table: {},
			definition: {
				name: 'catalogSearch',
				fields: [{ name: 'title', weight: 1 }],
				analyzer: 'english@2',
				stopWords: true,
				positions: true,
				surfaceTerms: true,
				synonyms: [],
			},
			auditStore: {},
			readinessId: 'invalid-policy',
			indexId: 'invalid-policy',
			storePath: process.argv[5],
			storeName: 'invalid-policy',
			sourceGeneration: 'one',
			limits: {},
		});
		try {
			await assert.rejects(
				async () => query.search({ comparator: 'matches', value: 'catalog' }, {}),
				(error) => error.statusCode === 500 && error.message === "Full-text search on 'catalogSearch' failed"
			);
		} finally {
			await query.close();
		}
		console.log(JSON.stringify({ writerAlive: true }));
		return;
	}

	if (process.argv[3] === 'policy') {
		const assert = require('node:assert');
		const { Worker } = require('node:worker_threads');
		const { once } = require('node:events');
		const { join } = require('node:path');
		const {
			loadFullTextNativeBinding,
			nativeFullTextQueryLimits,
		} = require('#src/resources/indexes/fullTextNativeBinding');
		const binding = await loadFullTextNativeBinding();
		const policy = nativeFullTextQueryLimits(await binding.runtimeInfo(), snapshot.query);
		env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_QUERY, {
			maxQueryTerms: 1,
			maxQueryClauses: 1,
			maxFuzzyDistance: 0,
		});
		const worker = new Worker(
			`
			const { parentPort } = require('node:worker_threads');
			parentPort.postMessage(require('#src/resources/indexes/fullTextRuntimeConfiguration').getFullTextRuntimeConfiguration().query);
		`,
			{ eval: true }
		);
		const [inherited] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) }).finally(() =>
			worker.terminate()
		);
		assert.deepStrictEqual(inherited, JSON.parse(process.argv[4]));
		const options = {
			path: join(process.argv[5], 'native-policy'),
			indexId: 'capacity',
			generation: 'one',
			analyzer: 'english@2',
			fields: [{ name: 'title' }],
			limits: {
				indexingThreads: 1,
				searchThreads: 2,
				writerMemoryBytes: 64000000,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64000000,
				maxBatchBytes: 8388608,
			},
		};
		let index = await binding.openNativeFullTextIndex(options);
		let reader;
		let overCode;
		try {
			assert.deepStrictEqual(index.queryLimits, { maxQueryTerms: 64, maxQueryClauses: 256 });
			await index.applyMutationBatch({
				upserts: [{ id: 'late', version: '1', fields: { title: 'qword064' } }],
				deletes: [],
			});
			await index.publish('policy');
			await index.close({ mode: 'require-clean' });
			index = undefined;
			reader = await binding.openNativeFullTextReader({
				...options,
				limits: { ...options.limits, maxQueryTerms: policy.maxQueryTerms, maxQueryClauses: policy.maxQueryClauses },
			});
			assert.deepStrictEqual(reader.queryLimits, {
				maxQueryTerms: policy.maxQueryTerms,
				maxQueryClauses: policy.maxQueryClauses,
			});
			const text = Array.from({ length: 65 }, (_, i) => `qword${String(i).padStart(3, '0')}`).join(' ');
			if (policy.maxQueryTerms >= 65 && policy.maxQueryClauses >= 65) {
				assert.deepStrictEqual(
					(await reader.search({ text })).hits.map(({ id }) => id),
					['late']
				);
				assert.strictEqual((await reader.search({ text, mode: 'all' })).hits.length, 0);
				assert.strictEqual((await reader.search({ text, mode: 'phrase' })).hits.length, 0);
			}
			try {
				await reader.search({
					text: Array.from({ length: policy.maxQueryTerms + 1 }, (_, i) => `qword${String(i).padStart(3, '0')}`).join(
						' '
					),
				});
			} catch (error) {
				overCode = error.code;
			}
			assert.strictEqual(overCode, 'E_INVALID_ARGUMENT');
		} finally {
			await reader?.close();
			await index?.close({ mode: 'rollback' });
		}
		console.log(JSON.stringify({ policy, inherited, overCode }));
		return;
	}

	env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME, { maxSearchThreads: maxSearchThreads + 1 });
	if (getFullTextRuntimeConfiguration() !== snapshot) throw new Error('Runtime snapshot changed');
	const runtime = resolveFullTextSearchLimits(snapshot).runtime;
	const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
	await loadFullTextNativeBinding();
	console.log(JSON.stringify({ runtime }));
}
run().catch((error) => {
	console.log(JSON.stringify({ error: error.message }));
	process.exitCode = 1;
});
