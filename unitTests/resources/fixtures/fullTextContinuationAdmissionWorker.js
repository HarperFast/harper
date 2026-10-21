'use strict';
const { parentPort, threadId, workerData } = require('node:worker_threads');
workerData.noServerStart = true;
const { onMessageByType } = require('#js/server/threads/manageThreads');
const {
	reserveFullTextContinuation,
	releaseFullTextContinuation,
	fullTextContinuationDeadline,
} = require('#src/resources/indexes/fullTextContinuation');
const claims = [];
let writer, reader, releaseGate, restoreReleasePolicy, releaseFailure, sharedProduct;
onMessageByType('full-text-admission-test-command', async (event) => {
	try {
		if (event.message.operation === 'runtime-configuration') {
			const { getFullTextRuntimeConfiguration } = require('#src/resources/indexes/fullTextRuntimeConfiguration');
			const { resolveFullTextSearchLimits } = require('#src/resources/indexes/fullTextSearchLimits');
			const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
			const runtime = resolveFullTextSearchLimits(getFullTextRuntimeConfiguration()).runtime;
			const binding = await loadFullTextNativeBinding();
			binding.configureNativeFullTextRuntime(runtime);
			let changedCode;
			try {
				binding.configureNativeFullTextRuntime({ ...runtime, maxSearchThreads: runtime.maxSearchThreads + 1 });
			} catch (error) {
				changedCode = error.code;
			}
			const { Worker } = require('node:worker_threads');
			const { once } = require('node:events');
			const child = new Worker(
				`
				const { parentPort, workerData } = require('node:worker_threads');
				const env = require('#src/utility/environment/environmentManager');
				const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { runtime: { maxSearchThreads: workerData.maxSearchThreads + 1 } });
				require('#src/resources/indexes/fullTextNativeBinding').loadFullTextNativeBinding().then(
					() => parentPort.postMessage({ ready: true }),
					(error) => parentPort.postMessage({ error: error.message })
				);
			`,
				{ eval: true, workerData: { maxSearchThreads: runtime.maxSearchThreads } }
			);
			const [rawChild] = await once(child, 'message', { signal: AbortSignal.timeout(10000) }).finally(() =>
				child.terminate()
			);
			if (!rawChild.ready) throw new Error(rawChild.error);
			parentPort.postMessage({
				type: 'full-text-admission-test-response',
				message: { originator: threadId, value: { runtime, changedCode, rawChildReady: rawChild.ready } },
			});
			return;
		} else if (event.message.operation === 'table-terminal-release') {
			const { fullTextDerivedIndexReadiness } = require('#src/resources/derivedIndexes');
			const { fullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuationOwner');
			const env = require('#src/utility/environment/environmentManager');
			const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
			const { waitFor } = require('../../waitFor');
			const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
			let Product, leaseId, value;
			try {
				Product = createProduct(event.message.database);
				await Product.put('one', { title: 'widget' });
				await Product.put('two', { title: 'widget' });
				await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 10000);
				const query = {
					conditions: [
						{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget', waitForIndexMilliseconds: 5000 },
					],
					limit: 1,
				};
				let indexedIds = [];
				await waitFor(
					async () => {
						indexedIds = [];
						for await (const record of Product.search({ ...query, limit: 2 })) indexedIds.push(record.id);
						return indexedIds.length === 2;
					},
					{ timeout: 10000, message: () => `Expected two indexed records, got ${JSON.stringify(indexedIds)}` }
				);
				const first = await Product.searchPage({ ...query, continuation: true });
				leaseId = (await fullTextContinuationOwner()).tokens.route(first.continuation).lease;
				const last = await Product.searchPage({
					...query,
					continuation: first.continuation,
					rowFilter: () => {
						env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previous, maxPendingResponseBytes: 1 });
						return true;
					},
				});
				value = { complete: last.complete, count: last.length };
			} finally {
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
				if (leaseId) await releaseFullTextContinuation(leaseId);
				await Product?.derivedIndexRuntime?.close();
			}
			parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, value } });
			return;
		} else if (event.message.operation?.startsWith('table-identity-')) {
			const { waitFor } = require('../../waitFor');
			let value;
			if (event.message.operation === 'table-identity-initialize') {
				sharedProduct = createProduct(event.message.database);
				const { fullTextDerivedIndexReadiness } = require('#src/resources/derivedIndexes');
				await waitFor(() => fullTextDerivedIndexReadiness(sharedProduct, 'catalogSearch').state === 'ready', 10000);
				value = { initialized: true };
			} else if (event.message.operation === 'table-identity-seed') {
				for (const id of ['one', 'two', 'three']) await sharedProduct.put(id, { title: 'widget' });
				await waitFor(async () => {
					let count = 0;
					for await (const _record of sharedProduct.search({
						conditions: [
							{
								attribute: 'catalogSearch',
								comparator: 'matches',
								value: 'widget',
								maxIndexLagMilliseconds: 0,
								waitForIndexMilliseconds: 5000,
							},
						],
						limit: 3,
					}))
						count++;
					return count === 3;
				}, 10000);
				value = { seeded: true };
			} else if (event.message.operation === 'table-identity-update') {
				sharedProduct.fullTextIndexes = sharedProduct.fullTextIndexes.map((definition) => ({
					...definition,
					fields: definition.fields.map((field) => ({ ...field, ...event.message.field })),
					...(event.message.highlighting ? { highlighting: event.message.highlighting } : {}),
				}));
				sharedProduct.derivedIndexRuntime.matchesCurrent();
				value = {
					generation: sharedProduct.fullTextIndexGenerations.catalogSearch,
					identity: sharedProduct.fullTextQueryIndexes.catalogSearch.customIndex.configurationIdentity,
				};
			} else if (event.message.operation === 'table-identity-search') {
				const page = await sharedProduct.searchPage(event.message.query);
				value = {
					ids: page.map(({ id }) => id),
					continuation: page.continuation,
					complete: page.complete,
					generation: sharedProduct.fullTextIndexGenerations.catalogSearch,
					identity: sharedProduct.fullTextQueryIndexes.catalogSearch.customIndex.configurationIdentity,
				};
			} else if (event.message.operation === 'table-identity-shutdown') {
				await sharedProduct?.derivedIndexRuntime?.close();
				value = { closed: true };
			}
			parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, value } });
			return;
		} else if (event.message.operation === 'native') {
			const { requestFullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuation');
			const value = await requestFullTextContinuationOwner(
				event.message.owner,
				event.message.command,
				fullTextContinuationDeadline()
			);
			parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, value } });
			return;
		} else if (event.message.operation === 'open') {
			const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
			const { fullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuationOwner');
			const { confirmFullTextContinuation } = require('#src/resources/indexes/fullTextContinuation');
			const binding = await loadFullTextNativeBinding();
			const info = await binding.runtimeInfo();
			const options = {
				path: event.message.path,
				indexId: 'worker-continuation',
				generation: '1',
				fields: [{ name: 'title' }],
				analyzer: 'english@2',
				limits: {
					indexingThreads: 1,
					searchThreads: Math.max(2, info.queryClassIsolationMinimumSearchThreads),
					writerMemoryBytes: 30000000,
					maxQueuedCommands: 16,
					maxQueuedBytes: 8388608,
					maxBatchBytes: 8388608,
				},
			};
			writer = await binding.openNativeFullTextIndex(options);
			await writer.applyMutationBatch({
				upserts: Array.from({ length: 40 }, (_, n) => ({ id: String(n), version: '1', fields: { title: 'widget' } })),
			});
			await writer.commit();
			reader = await binding.openNativeFullTextReader(options);
			const owner = await fullTextContinuationOwner();
			const claim = await reserveFullTextContinuation(128, fullTextContinuationDeadline());
			claims.push(claim);
			if (event.message.holdRelease) releaseGate = Promise.withResolvers();
			owner.leases.register(claim, 'b'.repeat(64), { text: 'widget' }, reader, async () => {
				if (releaseGate) {
					parentPort.postMessage({
						type: 'full-text-admission-test-response',
						message: { originator: threadId, releaseStarted: true },
					});
					await releaseGate.promise;
				}
				try {
					await releaseFullTextContinuation(claim.id);
					if (releaseFailure) throw releaseFailure.value;
				} finally {
					restoreReleasePolicy?.();
					restoreReleasePolicy = undefined;
				}
			});
			await confirmFullTextContinuation(claim.id, fullTextContinuationDeadline());
			const token = owner.leases.seal(claim.id, 'b'.repeat(64), { batchSize: 7, consumed: 2 });
			parentPort.postMessage({
				type: 'full-text-admission-test-response',
				message: { originator: threadId, token, claim, responseBytes: owner.responseBytes(7) },
			});
			return;
		} else if (event.message.operation === 'update') {
			await writer.applyMutationBatch({
				upserts: [{ id: 'new', version: '2', fields: { title: 'widget widget widget' } }],
			});
			await writer.commit();
		} else if (event.message.operation === 'shutdown') {
			releaseGate?.resolve();
			const { fullTextContinuationOwner } = require('#src/resources/indexes/fullTextContinuationOwner');
			await (await fullTextContinuationOwner()).leases.revokeReader(reader);
			await reader.close();
			await writer.close();
			for (const claim of claims.splice(0)) await releaseFullTextContinuation(claim.id);
		} else if (event.message.operation === 'unblock-release') {
			if (event.message.failRelease === true) {
				const env = require('#src/utility/environment/environmentManager');
				const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
				const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
				restoreReleasePolicy = () => env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previous, maxPendingResponseBytes: 1 });
			}
			if (event.message.failRelease !== false && event.message.failRelease !== true)
				releaseFailure = { value: event.message.failRelease };
			releaseGate?.resolve();
		} else if (event.message.operation === 'reserve')
			claims.push(await reserveFullTextContinuation(128, fullTextContinuationDeadline()));
		else if (event.message.operation === 'release') await releaseFullTextContinuation(claims.pop().id);
		parentPort.postMessage({
			type: 'full-text-admission-test-response',
			message: { originator: threadId, count: claims.length },
		});
	} catch (error) {
		parentPort.postMessage({
			type: 'full-text-admission-test-response',
			message: { originator: threadId, error: error.message, status: error.statusCode },
		});
	}
});
parentPort.ref();
parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, ready: true } });

function createProduct(database) {
	const { setupTestDBPath } = require('../../testUtils');
	const { table } = require('#src/resources/databases');
	setupTestDBPath();
	return table({
		database,
		table: 'Product',
		audit: true,
		attributes: [
			{ name: 'id', type: 'ID', isPrimaryKey: true },
			{ name: 'title', type: 'String' },
		],
		fullTextIndexes: [
			{
				name: 'catalogSearch',
				fields: [{ name: 'title', weight: 1 }],
				analyzer: 'english@2',
				stopWords: true,
				positions: true,
				surfaceTerms: true,
				synonyms: [],
			},
		],
	});
}
