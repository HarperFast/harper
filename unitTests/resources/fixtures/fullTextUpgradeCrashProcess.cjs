'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { toBufferKey } = require('ordered-binary');
const { previousFullTextProcess } = require('./fullTextUpgradeHelpers.cjs');

(async () => {
	const [directory, phase] = process.argv.slice(2);
	const watchdog = setTimeout(() => {
		console.error(`Incomplete full-text upgrade crash phase: ${phase}`);
		process.exit(1);
	}, 40_000);
	const env = require('#src/utility/environment/environmentManager');
	const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
	env.initSync();
	env.setProperty(CONFIG_PARAMS.STORAGE_PATH, path.join(directory, 'database'));
	const { table, closeLoadedDatabases } = require('#src/resources/databases');
	const {
		setFullTextNativeBindingForTests,
		fullTextDerivedIndexReadiness,
		fullTextDerivedIndexId,
		suspendDerivedIndexActivation,
	} = require('#src/resources/derivedIndexes');
	const { nativeFullTextIndexPath } = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');
	const {
		encodeFullTextCursorPayload,
		decodeFullTextCursorPayload,
	} = require('#src/resources/indexes/fullTextDerivedIndex');
	const { setMainIsWorker } = require('#src/server/threads/manageThreads');
	const { waitFor } = require('../../waitFor');
	const binding = await import('@harperfast/fulltext/native');
	setMainIsWorker(true);
	let activate;
	const activation = new Promise((resolve) => (activate = resolve));
	let Product;
	let resets = 0;
	let applied = 0;
	let publishes = 0;
	let admissionChecks = 0;
	let nativeOptions;
	const records = () =>
		[...Product.primaryStore.getRange({ versions: true })]
			.filter(({ key, value }) => typeof key !== 'symbol' && value != null)
			.map(({ key, value, version }) => ({ id: key, title: value.title, version: String(version) }));
	const audit = () =>
		[...Product.auditStore.getRange({ start: 1 })].map(({ txnLogKey, recordId, tableId, type, version }) => ({
			txnLogKey,
			recordId,
			tableId,
			type,
			version,
		}));
	const marker = () =>
		Product.primaryStore.rootStore.getSync(
			Symbol.for(`derived-index:${fullTextDerivedIndexId(Product, 'catalogSearch')}:condemned`)
		);
	const search = async (value) => {
		const result = [];
		for await (const record of Product.search({
			conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value }],
			limit: 100,
		}))
			result.push(record);
		return result;
	};
	const assertFenced = async () => {
		assert.notStrictEqual(fullTextDerivedIndexReadiness(Product, 'catalogSearch').state, 'ready');
		await assert.rejects(
			() => search('added'),
			(error) => error.statusCode === 503
		);
		admissionChecks++;
	};
	const crash = async (checkpoint, payload) => {
		assert.notStrictEqual(marker(), undefined);
		await assertFenced();
		const inspection = binding.inspectNativeFullTextIndex(nativeOptions);
		if (checkpoint === 'K1') assert.strictEqual(inspection.state, 'missing');
		else {
			assert.strictEqual(inspection.state, 'checkpointed');
			assert.strictEqual(inspection.committedPayload, payload);
		}
		fs.writeFileSync(
			path.join(directory, 'crash.json'),
			JSON.stringify({ checkpoint, applied, publishes, payload, inspection, condemned: true, admissionChecks })
		);
		process.kill(process.pid, 'SIGKILL');
		await new Promise(() => {});
	};
	const forwarding = {
		...binding,
		async runtimeInfo() {
			await activation;
			return binding.runtimeInfo();
		},
		validateNativeFullTextIndexOptions(options) {
			nativeOptions = options;
			const seeded = JSON.parse(fs.readFileSync(path.join(directory, 'seed.json')));
			for (const key of [
				'path',
				'indexId',
				'generation',
				'fields',
				'analyzer',
				'stopWords',
				'positions',
				'surfaceTerms',
				'synonyms',
			])
				assert.deepStrictEqual(options[key], seeded.options[key], `production native identity ${key}`);
			return binding.validateNativeFullTextIndexOptions(options);
		},
		async resetNativeFullTextIndex(options) {
			assert.notStrictEqual(marker(), undefined);
			resets++;
			const result = await binding.resetNativeFullTextIndex(options);
			if (phase === 'K1') await crash('K1');
			return result;
		},
		async openNativeFullTextIndex(options) {
			const writer = await binding.openNativeFullTextIndex(options);
			return new Proxy(writer, {
				get(target, property) {
					if (property === 'applyMutationBatch')
						return async (batch) => {
							const result = await writer.applyMutationBatch(batch);
							applied += batch.upserts.length;
							return result;
						};
					if (property === 'publish')
						return async (payload) => {
							const result = await writer.publish(payload);
							publishes++;
							if (phase === 'K2' && applied > 0 && applied < 5) await crash('K2', payload);
							if (
								phase === 'K3' &&
								applied === 5 &&
								Object.keys(decodeFullTextCursorPayload(payload)?.logs ?? {}).length
							)
								await crash('K3', payload);
							if (phase === 'recover') {
								assert.notStrictEqual(marker(), undefined);
								await assertFenced();
							}
							return result;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		},
	};
	setFullTextNativeBindingForTests({
		binding: forwarding,
		runnerOptions: {
			maxChunkRecords: 2,
			maxMillisecondsPerTurn: 1_000_000,
			flushAfterMutations: 1,
			maxFlushAgeMilliseconds: 5,
		},
	});
	const declaration = {
		database: 'upgradeCrash',
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
				stopWords: false,
				positions: true,
				surfaceTerms: true,
				synonyms: [],
			},
		],
	};
	let releaseActivation;
	if (phase === 'seed') {
		const { fullTextIndexes: _, ...plainDeclaration } = declaration;
		Product = table(plainDeclaration);
		releaseActivation = suspendDerivedIndexActivation(Product.primaryStore.rootStore);
	}
	Product = table(declaration);
	if (phase === 'seed') {
		await Product.put(['a', 'b', 'c', 'd'].map((id) => ({ id, title: 'added boots' })));
		await Product.put('ad', { title: 'ad' });
		const source = records();
		const before = audit();
		const nativeId = (id) => `${Product.tableId}.${toBufferKey(id).toString('base64url')}`;
		const options = {
			path: nativeFullTextIndexPath(Product.primaryStore.rootStore.path, 'Product/catalogSearch'),
			indexId: fullTextDerivedIndexId(Product, 'catalogSearch'),
			generation: createHash('sha256')
				.update(`${Product.tableId}:${Product.fullTextIndexGenerations.catalogSearch}`)
				.digest('hex'),
			fields: [{ name: 'title', weight: 1 }],
			analyzer: 'english@2',
			stopWords: false,
			positions: true,
			surfaceTerms: true,
			synonyms: [],
			limits: {
				indexingThreads: 2,
				searchThreads: 1,
				writerMemoryBytes: 64 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
		};
		const payload = encodeFullTextCursorPayload({ format: 1, logs: { local: before.at(-1).txnLogKey } });
		const seeded = previousFullTextProcess(
			'seed',
			options,
			[
				...source.map(({ id, title, version }) => ({ id: nativeId(id), version, fields: { title } })),
				{ id: 'native-only-ghost', version: '1', fields: { title: 'migrationghost' } },
			],
			payload
		);
		assert.strictEqual(seeded.inspection.state, 'checkpointed');
		assert.strictEqual(seeded.inspection.committedPayload, payload);
		assert.deepStrictEqual(seeded.ghostIds, ['native-only-ghost']);
		assert.deepStrictEqual(binding.inspectNativeFullTextIndex(options), {
			state: 'incompatible',
			code: 'E_IDENTITY_MISMATCH',
		});
		fs.writeFileSync(
			path.join(directory, 'seed.json'),
			JSON.stringify({ source, audit: before, generation: Product.fullTextIndexGenerations.catalogSearch, options })
		);
		await closeLoadedDatabases();
		releaseActivation();
		clearTimeout(watchdog);
		console.log(JSON.stringify({ seeded: true }));
		process.exit(0);
	}
	const seeded = JSON.parse(fs.readFileSync(path.join(directory, 'seed.json')));
	assert.deepStrictEqual(records(), seeded.source);
	assert.deepStrictEqual(audit(), seeded.audit);
	assert.strictEqual(Product.fullTextIndexGenerations.catalogSearch, seeded.generation);
	if (phase === 'recover') assert.notStrictEqual(marker(), undefined);
	await assertFenced();
	activate();
	await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30_000);
	assert.strictEqual(phase, 'recover', `missed crash checkpoint ${phase}`);
	assert.strictEqual(resets, 1);
	assert.strictEqual(applied, seeded.source.length);
	assert.ok(admissionChecks >= 2);
	assert.strictEqual(marker(), undefined);
	assert.deepStrictEqual((await search('added')).map(({ id }) => id).sort(), ['a', 'b', 'c', 'd']);
	assert.deepStrictEqual(
		(await search('ad')).map(({ id }) => id),
		['ad']
	);
	assert.deepStrictEqual(await search('migrationghost'), []);
	const reader = await binding.openNativeFullTextReader(seeded.options);
	try {
		const result = await reader.search({ text: 'added ad', exactTotal: true, limit: 100 });
		assert.strictEqual(result.total, 5);
		assert.deepStrictEqual(
			result.hits.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
			seeded.source
				.map(({ id, version }) => ({ id: `${Product.tableId}.${toBufferKey(id).toString('base64url')}`, version }))
				.sort((a, b) => a.id.localeCompare(b.id))
		);
		assert.strictEqual((await reader.search({ text: 'migrationghost', exactTotal: true })).total, 0);
	} finally {
		await reader.close();
	}
	assert.deepStrictEqual(records(), seeded.source);
	assert.deepStrictEqual(audit(), seeded.audit);
	await closeLoadedDatabases();
	clearTimeout(watchdog);
	console.log(JSON.stringify({ recovered: true, resets, applied, admissionChecks }));
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
