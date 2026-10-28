'use strict';

const assert = require('node:assert');
const { createServer } = require('node:http');
const { pipeline } = require('node:stream');
const { toBufferKey } = require('ordered-binary');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { getDatabases } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { Resources } = require('#src/resources/Resources');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { derivedIndexWriteRejection } = require('#src/resources/derivedIndexRegistry');
const {
	encodeFullTextCursorPayload,
	decodeFullTextCursorPayload,
} = require('#src/resources/indexes/fullTextDerivedIndex');
const { handleApplication } = require('#src/server/REST');
const { Request } = require('#src/server/serverHelpers/Request');
const { getWorkerIndex, setMainIsWorker } = require('#src/server/threads/manageThreads');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { previousFullTextProcess } = require('./fixtures/fullTextUpgradeHelpers.cjs');
require('#src/server/serverHelpers/serverUtilities');

async function collect(iterable) {
	const rows = [];
	for await (const row of iterable) rows.push(row);
	return rows;
}

function gate() {
	let release;
	const promise = new Promise((resolve) => (release = resolve));
	return { promise, release };
}

describe('schema-declared full-text 0.5.0 to 0.7.0 checkpoint upgrade', function () {
	this.timeout(60_000);

	it('fences public search, rebuilds the old checkpoint and replays writes through the production runtime', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		setupTestDBPath();
		const previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		const database = 'fulltext_schema_upgrade';
		const name = 'SchemaUpgradeProduct';
		const schema = (search) => `
			type ${name} @table(database: "${database}", audit: true) {
				id: ID @primaryKey
				title: String
				${search ? 'catalogSearch: FullText @fullText(fields: [{ name: "title" }], surfaceTerms: true)' : ''}
			}
		`;
		let Product;
		let server;
		let failedResponse;
		let streamFailure;
		let reader;
		const resetGate = gate();
		const publishGate = gate();
		const lagPublishGate = gate();
		let holdLagPublication = false;
		let lagPublishEntered = false;
		let resetEntered = false;
		let publishEntered = false;
		let seeded;
		let native;
		let generation;
		let resets = 0;
		let firstRebuildIds;
		try {
			await loadGQLSchema(schema(false));
			Product = getDatabases()[database][name];
			await Product.put([
				{ id: 'a-updated', title: 'added boots' },
				{ id: 'b-ad', title: 'ad' },
				{ id: 'c-deleted', title: 'obsolete deletedwitness' },
				{ id: 'd-steady', title: 'added shoes' },
			]);
			const nativeId = (id) => `${Product.tableId}.${toBufferKey(id).toString('base64url')}`;
			const audit = () =>
				[...Product.auditStore.getRange({ start: 1 })].map(({ txnLogKey, recordId, tableId, type, version }) => ({
					txnLogKey,
					recordId,
					tableId,
					type,
					version,
				}));
			const auditBefore = audit();
			const cursor = { format: 1, logs: { local: auditBefore.at(-1).txnLogKey } };
			const binding = await loadFullTextNativeBinding();
			let validated;
			setFullTextNativeBindingForTests({
				binding: {
					...binding,
					validateNativeFullTextIndexOptions(options) {
						validated = options;
						return binding.validateNativeFullTextIndexOptions(options);
					},
					inspectNativeFullTextIndex(options) {
						if (!seeded) {
							assert.strictEqual(binding.inspectNativeFullTextIndex(options).state, 'missing');
							native = { ...options, limits: validated.limits };
							seeded = previousFullTextProcess(
								'seed',
								native,
								[
									...[...Product.primaryStore.getRange({ versions: true })]
										.filter(({ key, value }) => typeof key !== 'symbol' && value != null)
										.map(({ key, value, version }) => ({
											id: nativeId(key),
											version: String(version),
											fields: { title: value.title },
										})),
									{ id: 'native-only-ghost', version: '1', fields: { title: 'migrationghost' } },
								],
								encodeFullTextCursorPayload(cursor)
							);
							assert.strictEqual(seeded.inspection.state, 'checkpointed');
							assert.deepStrictEqual(seeded.ghostIds, ['native-only-ghost']);
							assert.deepStrictEqual(
								{ ...decodeFullTextCursorPayload(seeded.inspection.committedPayload).logs },
								cursor.logs
							);
							assert.deepStrictEqual(binding.inspectNativeFullTextIndex(options), {
								state: 'incompatible',
								code: 'E_IDENTITY_MISMATCH',
							});
						}
						return binding.inspectNativeFullTextIndex(options);
					},
					async resetNativeFullTextIndex(options) {
						resets++;
						resetEntered = true;
						await resetGate.promise;
						return binding.resetNativeFullTextIndex(options);
					},
					async openNativeFullTextIndex(options) {
						const index = await binding.openNativeFullTextIndex(options);
						let applied = false;
						return new Proxy(index, {
							get(target, key) {
								if (key === 'applyMutationBatch')
									return async (batch) => {
										const result = await target.applyMutationBatch(batch);
										if (batch.upserts.length) {
											applied = true;
											firstRebuildIds ??= batch.upserts.map(({ id }) => id);
										}
										return result;
									};
								if (key === 'publish')
									return async (...args) => {
										if (applied && !publishEntered) {
											publishEntered = true;
											await publishGate.promise;
										}
										if (holdLagPublication) {
											holdLagPublication = false;
											lagPublishEntered = true;
											await lagPublishGate.promise;
										}
										return target.publish(...args);
									};
								const value = Reflect.get(target, key);
								return typeof value === 'function' ? value.bind(target) : value;
							},
						});
					},
				},
				runnerOptions: {
					maxChunkRecords: 1,
					flushAfterMutations: 1,
					maxFlushAgeMilliseconds: 10,
					maxLagMilliseconds: 10000,
				},
				closeTimeoutMilliseconds: 5000,
				shutdownTimeoutMilliseconds: 10000,
			});
			await loadGQLSchema(schema(true));
			Product = getDatabases()[database][name];
			generation = Product.fullTextIndexGenerations.catalogSearch;
			await waitFor(() => resetEntered, 30000);
			assert.strictEqual(fullTextDerivedIndexReadiness(Product, 'catalogSearch').state, 'rebuilding');
			const query = (text, waiting = false) => ({
				conditions: [
					{
						attribute: 'catalogSearch',
						comparator: 'matches',
						value: text,
						maxIndexLagMilliseconds: 0,
						waitForIndexMilliseconds: waiting ? 30000 : 0,
					},
				],
				select: ['id', 'title'],
			});
			await assert.rejects(
				() => collect(Product.search(query('added'))),
				(error) => error.statusCode === 503
			);
			const resources = new Resources();
			resources.set('Product', Product);
			let rest;
			handleApplication({
				resources,
				options: { getAll: () => ({ webSocket: false, exactCount: true }) },
				routeFor: () => ({ urlPath: '/upgrade' }),
				server: { http: (handler) => (rest = handler), ws: () => [] },
			});
			server = createServer(async (input, output) => {
				try {
					const request = new Request(input, output);
					request.user = input.headers['x-fixture-deny-title']
						? {
								role: {
									permission: {
										[database]: {
											tables: {
												[name]: {
													read: true,
													attribute_permissions: [
														{ attribute_name: 'id', read: true },
														{ attribute_name: 'title', read: false },
													],
												},
											},
										},
									},
								},
							}
						: { role: { permission: { super_user: true } } };
					const response = await rest(request, () => ({ status: 404, headers: new Map(), body: 'not found' }));
					output.writeHead(response.status, Object.fromEntries(response.headers));
					if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) output.end(response.body);
					else {
						pipeline(response.body, output, (error) => {
							if (error) {
								streamFailure = error;
								failedResponse = output;
							}
						});
					}
				} catch (error) {
					if (output.headersSent || output.destroyed) {
						streamFailure = error;
						failedResponse = output;
						output.destroy(error);
						return;
					}
					output.writeHead(error.statusCode || 500);
					output.end(error.message);
				}
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			const url = `http://127.0.0.1:${server.address().port}/Product/?catalogSearch=matches=added&select(id,title)&limit(20)`;
			const terminated = (error) =>
				error.name === 'TypeError' && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code);
			const streamed = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch((error) => {
				assert.ok(terminated(error), String(error.cause ?? error));
			});
			if (streamed?.status === 200) await assert.rejects(() => streamed.text(), terminated);
			else if (streamed) assert.strictEqual(streamed.status, 503, await streamed.text());
			if (!streamed || streamed.status === 200) {
				await waitFor(() => streamFailure !== undefined, 5000);
				assert.strictEqual(streamFailure.code, 'INDEX_REBUILDING');
				assert.strictEqual(failedResponse.destroyed, true);
			}
			const unavailable = await fetch(url, { headers: { Prefer: 'count=exact' }, signal: AbortSignal.timeout(30000) });
			assert.strictEqual(unavailable.status, 503, await unavailable.text());
			resetGate.release();
			await waitFor(() => publishEntered, 30000);
			assert.deepStrictEqual(firstRebuildIds, [nativeId('a-updated')]);
			const stillUnavailable = await fetch(url, {
				headers: { Prefer: 'count=exact' },
				signal: AbortSignal.timeout(30000),
			});
			assert.strictEqual(stillUnavailable.status, 503, await stillUnavailable.text());
			await assert.rejects(
				() => collect(Product.search(query('added'))),
				(error) => error.statusCode === 503
			);
			await Product.put('a-updated', { title: 'added waterproof jacket' });
			await Product.delete('c-deleted');
			await Product.put('0-created', { title: 'added waterproof boots' });
			const auditAfterWrites = audit();
			publishGate.release();
			await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
			assert.deepStrictEqual((await collect(Product.search(query('waterproof', true)))).map(({ id }) => id).sort(), [
				'0-created',
				'a-updated',
			]);
			assert.deepStrictEqual(
				(await collect(Product.search(query('ad', true)))).map(({ id }) => id),
				['b-ad']
			);
			assert.deepStrictEqual((await collect(Product.search(query('added', true)))).map(({ id }) => id).sort(), [
				'0-created',
				'a-updated',
				'd-steady',
			]);
			assert.deepStrictEqual(await collect(Product.search(query('migrationghost deletedwitness', true))), []);
			const ready = await fetch(url);
			assert.strictEqual(ready.status, 200, await ready.clone().text());
			assert.deepStrictEqual((await ready.json()).map(({ id }) => id).sort(), ['0-created', 'a-updated', 'd-steady']);
			const denied = await fetch(url, { headers: { 'x-fixture-deny-title': 'yes' } });
			assert.strictEqual(denied.status, 403, await denied.text());
			reader = await binding.openNativeFullTextReader(native);
			const exact = await reader.search({ text: 'waterproof', exactTotal: true });
			assert.strictEqual(exact.total, 2);
			assert.strictEqual(exact.totalRelation, 'exact');
			assert.deepStrictEqual(
				exact.hits.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
				['0-created', 'a-updated']
					.map((id) => ({ id: nativeId(id), version: String(Product.primaryStore.getEntry(id).version) }))
					.sort((a, b) => a.id.localeCompare(b.id))
			);
			assert.strictEqual((await reader.search({ text: 'migrationghost deletedwitness', exactTotal: true })).total, 0);
			const committed = binding.inspectNativeFullTextIndex(native);
			assert.strictEqual(committed.state, 'checkpointed');
			assert(decodeFullTextCursorPayload(committed.committedPayload).logs.local >= auditAfterWrites.at(-1).txnLogKey);
			assert.strictEqual(resets, 1);
			assert.strictEqual(Product.fullTextIndexGenerations.catalogSearch, generation);
			assert.deepStrictEqual(audit(), auditAfterWrites);
			assert.deepStrictEqual(auditAfterWrites.slice(0, auditBefore.length), auditBefore);
			assert.strictEqual(derivedIndexWriteRejection(Product.auditStore, Product.tableId), undefined);
			holdLagPublication = true;
			await Product.put('lag-trigger', { title: 'backlogprobe' });
			await waitFor(() => lagPublishEntered, 5000);
			await waitFor(() => derivedIndexWriteRejection(Product.auditStore, Product.tableId) !== undefined, 20000);
			const beforeRefusal = audit();
			await assert.rejects(
				async () => Product.put('retry-write', { title: 'retryprobe' }),
				(error) => error.statusCode === 503 && error.code === 'DERIVED_INDEX_LAGGING' && error.retryable === true
			);
			assert.strictEqual(Product.primaryStore.get('retry-write'), undefined);
			assert.deepStrictEqual(audit(), beforeRefusal);
			lagPublishGate.release();
			await waitFor(() => derivedIndexWriteRejection(Product.auditStore, Product.tableId) === undefined, 15000);
			await Product.put('retry-write', { title: 'retryprobe' });
			assert.deepStrictEqual(
				(await collect(Product.search(query('retryprobe', true)))).map(({ id }) => id),
				['retry-write']
			);
		} finally {
			lagPublishGate.release();
			resetGate.release();
			publishGate.release();
			await reader?.close();
			if (server) await new Promise((resolve) => server.close(resolve));
			const runtime = Product?.derivedIndexRuntime;
			if (Product) Product.derivedIndexRuntime = undefined;
			await runtime?.close();
			setFullTextNativeBindingForTests(undefined);
			setMainIsWorker(previousMainIsWorker);
		}
	});
});
