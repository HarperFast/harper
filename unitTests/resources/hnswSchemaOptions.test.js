const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { resetDatabases, table, tables } = require('#src/resources/databases');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { ClientError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const createdTables = [];

function customIndex(tableName) {
	return tables[tableName].indices.embedding.customIndex;
}

function indexedOptions(tableName) {
	return tables[tableName].attributes.find((attribute) => attribute.name === 'embedding').indexed;
}

async function closeDerivedRuntime(Table) {
	await Table.derivedIndexRuntime?.close();
	Table.derivedIndexRuntime = undefined;
}

async function loadTable(tableName, tableArguments, indexArguments) {
	await loadGQLSchema(`
		type ${tableName} @table${tableArguments} {
			id: ID @primaryKey
			embedding: [Float] @indexed(${indexArguments})
		}
	`);
	createdTables.push(tableName);
	return customIndex(tableName);
}

describe('HNSW GraphQL numeric options', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('preserves GraphQL numeric literal kinds and stores quoted options as numbers', async () => {
		const quoted = await loadTable(
			'HnswQuotedNumericOptions',
			'',
			'type: "HNSW", M: "12", efConstruction: "180", efConstructionSearch: "90", mL: "0.4", optimizeRouting: "0.6", filterExpansion: "18"'
		);
		const unquoted = await loadTable(
			'HnswUnquotedNumericOptions',
			'',
			'type: "HNSW", M: 12, efConstruction: 180, efConstructionSearch: 90, mL: 0.4, optimizeRouting: 0.6, filterExpansion: 18'
		);
		const routingDisabled = [];
		for (const [tableName, option] of [
			['HnswQuotedZeroRoutingOption', 'optimizeRouting: "0"'],
			['HnswUnquotedZeroRoutingOption', 'optimizeRouting: 0'],
			['HnswBooleanDisabledRoutingOption', 'optimizeRouting: false'],
			['HnswQuotedBooleanDisabledRoutingOption', 'optimizeRouting: "false"'],
		]) {
			routingDisabled.push(await loadTable(tableName, '', `type: "HNSW", ${option}`));
		}
		const quotedBooleanEnabled = await loadTable(
			'HnswQuotedBooleanEnabledRoutingOption',
			'',
			'type: "HNSW", optimizeRouting: "true"'
		);
		const nullDefault = await loadTable('HnswNullNumericOption', '', 'type: "HNSW", M: null');

		assert.equal(indexedOptions('HnswQuotedNumericOptions').M, 12);
		assert.equal(indexedOptions('HnswUnquotedNumericOptions').M, 12);
		for (const index of [quoted, unquoted]) {
			assert.equal(index.M, 12);
			assert.equal(index.efConstruction, 180);
			assert.equal(index.efConstructionSearch, 90);
			assert.equal(index.mL, 0.4);
			assert.equal(index.optimizeRouting, 0.6);
			assert.equal(index.filterExpansion, 18);
			for (const option of [
				'M',
				'efConstruction',
				'efConstructionSearch',
				'mL',
				'optimizeRouting',
				'filterExpansion',
			]) {
				assert.equal(typeof index[option], 'number', `${option} must be stored as a number`);
			}
		}
		for (const index of routingDisabled) {
			assert.equal(index.optimizeRouting, 0);
			assert.equal(typeof index.optimizeRouting, 'number');
		}
		assert.equal(quotedBooleanEnabled.optimizeRouting, 1);
		assert.equal(typeof quotedBooleanEnabled.optimizeRouting, 'number');
		assert.equal(nullDefault.M, 16);
		assert.equal(typeof nullDefault.M, 'number');

		resetDatabases();
		const reloaded = customIndex('HnswQuotedBooleanDisabledRoutingOption');
		assert.equal(reloaded.optimizeRouting, 0);
		assert.equal(typeof reloaded.optimizeRouting, 'number');
	});

	it('loads legacy numeric values with their original runtime semantics', async () => {
		const tableName = 'HnswLegacyNumericOptions';
		await loadTable(tableName, '', 'type: "HNSW", M: 12, optimizeRouting: 0.6');
		const descriptor = tables[tableName].dbisDB.getSync(`${tableName}/embedding`);
		descriptor.indexed.M = true;
		descriptor.indexed.optimizeRouting = '0';
		tables[tableName].dbisDB.putSync(`${tableName}/embedding`, descriptor);
		delete tables[tableName].indices.embedding;

		resetDatabases();
		const reloaded = customIndex(tableName);
		assert.equal(reloaded.M, true);
		assert.equal(reloaded.optimizeRouting, '0');
		assert.equal(Boolean(reloaded.optimizeRouting), true);

		const redeclared = await loadTable(tableName, '', 'type: "HNSW", M: 12, optimizeRouting: 0');
		assert.equal(redeclared.M, 12);
		assert.equal(redeclared.optimizeRouting, 0);
		assert.equal(indexedOptions(tableName).optimizeRouting, 0);
	});

	it('rejects options that are not finite numeric values', async () => {
		for (const [tableName, option] of [
			['HnswWordNumericOption', 'M: "sixteen"'],
			['HnswBlankNumericOption', 'M: ""'],
			['HnswBooleanNumericOption', 'M: true'],
		]) {
			await assert.rejects(
				loadTable(tableName, '', `type: "HNSW", ${option}`),
				(error) => error instanceof ClientError && error.message === 'M must be a finite number'
			);
		}
	});

	it('normalizes native-plane declaration booleans and rejects ambiguous values', async () => {
		for (const [tableName, tableArguments, option] of [
			['HnswBooleanNativeOptOut', '(audit: true)', 'nativePlane: false'],
			['HnswQuotedNativeOptOut', '', 'nativePlane: "false"'],
		]) {
			const index = await loadTable(tableName, tableArguments, `type: "HNSW", ${option}`);
			assert.equal(index.postCommit, undefined);
			assert.equal(indexedOptions(tableName).nativePlane, false);
		}

		for (const [tableName, option] of [
			['HnswNumericNativeOption', 'nativePlane: 1'],
			['HnswQuotedZeroNativeOption', 'nativePlane: "0"'],
		]) {
			await assert.rejects(
				loadTable(tableName, '(audit: true)', `type: "HNSW", ${option}`),
				(error) => error instanceof ClientError && error.message === 'nativePlane must be true or false'
			);
		}
	});

	it('preserves legacy native-plane descriptor meanings until an explicit change', async () => {
		const omittedTable = 'HnswLegacyOmittedNativePlane';
		await loadTable(omittedTable, '(audit: true)', 'type: "HNSW", nativePlane: false');
		let descriptor = tables[omittedTable].dbisDB.getSync(`${omittedTable}/embedding`);
		delete descriptor.indexed.nativePlane;
		tables[omittedTable].dbisDB.putSync(`${omittedTable}/embedding`, descriptor);
		resetDatabases();
		await loadTable(omittedTable, '(audit: true)', 'type: "HNSW"');
		descriptor = tables[omittedTable].dbisDB.getSync(`${omittedTable}/embedding`);
		assert.equal(customIndex(omittedTable).postCommit, undefined);
		assert.equal(Object.hasOwn(descriptor.indexed, 'nativePlane'), false);
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

		const stringTable = 'HnswLegacyStringFalseNativePlane';
		await loadTable(stringTable, '(audit: true)', 'type: "HNSW", nativePlane: true');
		descriptor = tables[stringTable].dbisDB.getSync(`${stringTable}/embedding`);
		descriptor.indexed.nativePlane = 'false';
		tables[stringTable].dbisDB.putSync(`${stringTable}/embedding`, descriptor);
		const legacyIndex = new HierarchicalNavigableSmallWorld(tables[stringTable].indices.embedding, descriptor.indexed);
		assert.equal(legacyIndex.postCommit, true, 'legacy string false was historically native');
		await closeDerivedRuntime(tables[stringTable]);
		await loadTable(stringTable, '(audit: true)', 'type: "HNSW", nativePlane: "false"');
		descriptor = tables[stringTable].dbisDB.getSync(`${stringTable}/embedding`);
		assert.equal(customIndex(stringTable).postCommit, undefined);
		assert.equal(descriptor.indexed.nativePlane, false);
	});

	it('does not default from an effective audit setting that is absent on disk', () => {
		const tableName = 'HnswEffectiveAuditOnly';
		let Table = table({
			table: tableName,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', type: 'Array' },
			],
		});
		createdTables.push(tableName);
		const primary = Table.dbisDB.getSync(`${tableName}/`);
		delete primary.audit;
		Table.dbisDB.putSync(`${tableName}/`, primary);
		resetDatabases();
		Table = tables[tableName];
		Table.audit = true;
		Table = table({
			table: tableName,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});
		assert.equal(Table.indices.embedding.customIndex.postCommit, undefined);
		assert.equal(Object.hasOwn(indexedOptions(tableName), 'nativePlane'), false);
	});

	it('does not default a same-call table creation from the global audit setting', async () => {
		const tableName = 'HnswGlobalAuditCreate';
		const index = await loadTable(tableName, '', 'type: "HNSW"');
		assert.equal(index.postCommit, undefined);
		assert.equal(Object.hasOwn(indexedOptions(tableName), 'nativePlane'), false);
	});

	it('falls back to the JS index for an ineligible replicated native declaration', () => {
		const tableName = 'HnswReplicatedNativeFallback';
		table({
			table: tableName,
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		createdTables.push(tableName);
		let Table = table({
			table: tableName,
			origin: 'cluster',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		assert.equal(Table.indices.embedding.customIndex.postCommit, undefined);
		assert.equal(indexedOptions(tableName).nativePlane, false);

		Table.attributes.splice(
			0,
			Table.attributes.length,
			...Table.attributes.filter((attribute) => attribute.name === 'id')
		);
		Table = table({
			table: tableName,
			origin: 'cluster',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		assert.equal(Table.indices.embedding.customIndex.postCommit, undefined);
		assert.equal(indexedOptions(tableName).nativePlane, false);
	});

	describe('native plane geometry', () => {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

		it('defaults only when the native binding is available and persists that decision', async () => {
			const tableName = 'HnswNativeDefaultEnabled';
			const index = await loadTable(tableName, '(audit: true)', 'type: "HNSW", distance: "cosine"');
			if (!getPlaneBinding()) {
				assert.equal(index.postCommit, undefined);
				assert.equal(Object.hasOwn(indexedOptions(tableName), 'nativePlane'), false);
				return;
			}
			assert.equal(index.postCommit, true);
			assert.equal(indexedOptions(tableName).nativePlane, true);

			await closeDerivedRuntime(tables[tableName]);
			resetDatabases();
			assert.equal(customIndex(tableName).postCommit, true);
			assert.equal(indexedOptions(tableName).nativePlane, true);
		});

		it('leaves incompatible and kill-switched new indexes in JS mode', async function () {
			const incompatible = await loadTable('HnswNativeDefaultIncompatible', '(audit: true)', 'type: "HNSW", M: 12');
			assert.equal(incompatible.postCommit, undefined);
			assert.equal(Object.hasOwn(indexedOptions('HnswNativeDefaultIncompatible'), 'nativePlane'), false);

			if (!getPlaneBinding()) return;
			const previous = process.env.HNSW_NO_NATIVE_DEFAULT;
			process.env.HNSW_NO_NATIVE_DEFAULT = 'true';
			try {
				const disabled = await loadTable('HnswNativeDefaultDisabled', '(audit: true)', 'type: "HNSW"');
				assert.equal(disabled.postCommit, undefined);
				assert.equal(Object.hasOwn(indexedOptions('HnswNativeDefaultDisabled'), 'nativePlane'), false);
			} finally {
				if (previous === undefined) delete process.env.HNSW_NO_NATIVE_DEFAULT;
				else process.env.HNSW_NO_NATIVE_DEFAULT = previous;
			}
		});

		it('accepts correct quoted or unquoted explicit values', async () => {
			const nativeML = 1 / Math.log(16);
			const cases = [
				{
					name: 'HnswNativeQuotedM',
					arguments: 'type: "HNSW", distance: "cosine", nativePlane: "true", M: "16", nativePlaneMaxNodes: "1000"',
				},
				{
					name: 'HnswNativeQuotedEfConstruction',
					arguments: 'type: "HNSW", distance: "cosine", nativePlane: true, efConstruction: "200"',
				},
				{
					name: 'HnswNativeQuotedML',
					arguments: `type: "HNSW", distance: "cosine", nativePlane: true, mL: "${nativeML}"`,
				},
				{
					name: 'HnswNativeQuotedOptimizeRouting',
					arguments: 'type: "HNSW", distance: "cosine", nativePlane: true, optimizeRouting: "0.5"',
				},
				{
					name: 'HnswNativeAllQuotedGeometry',
					arguments: `type: "HNSW", distance: "cosine", nativePlane: "true", M: "16", efConstruction: "200", mL: "${nativeML}", optimizeRouting: "0.5"`,
				},
				{
					name: 'HnswNativeUnquotedGeometry',
					arguments: `type: "HNSW", distance: "cosine", nativePlane: true, M: 16, efConstruction: 200, mL: ${nativeML}, optimizeRouting: 0.5`,
				},
			];

			for (const testCase of cases) {
				const index = await loadTable(testCase.name, '(audit: true)', testCase.arguments);
				assert.equal(index.M, 16);
				assert.equal(index.efConstruction, 200);
				assert.equal(index.mL, nativeML);
				assert.equal(index.optimizeRouting, 0.5);
				assert.equal(index.postCommit, true, `${testCase.name} must use derived native-plane delivery`);
				assert.equal(index.planeEligible, true, `${testCase.name} must enable the native plane`);
			}

			assert.equal(customIndex('HnswNativeQuotedM').nativePlaneMaxNodes, 1000);
			assert.equal(typeof customIndex('HnswNativeQuotedM').nativePlaneMaxNodes, 'number');
		});

		it('keeps an unchanged unsupported legacy native-plane spelling loadable', async () => {
			const tableName = 'HnswLegacyNumericNativePlane';
			await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: true');
			const attribute = tables[tableName].attributes.find(({ name }) => name === 'embedding');
			let descriptor = tables[tableName].dbisDB.getSync(`${tableName}/embedding`);
			attribute.indexed.nativePlane = descriptor.indexed.nativePlane = '1';
			tables[tableName].dbisDB.putSync(`${tableName}/embedding`, descriptor);

			const index = await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: 1');
			descriptor = tables[tableName].dbisDB.getSync(`${tableName}/embedding`);
			assert.equal(index.postCommit, true);
			assert.equal(descriptor.indexed.nativePlane, '1');
		});

		it('keeps omitted native geometry defaults and auto-scaling flags unchanged', async () => {
			const index = await loadTable(
				'HnswNativeDefaultGeometry',
				'(audit: true)',
				'type: "HNSW", distance: "cosine", nativePlane: true'
			);

			assert.equal(index.M, 16);
			assert.equal(index.efConstruction, 200);
			assert.equal(index.mL, 1 / Math.log(16));
			assert.equal(index.optimizeRouting, 0.5);
			assert.equal(index.efConstructionConfigured, false);
			assert.equal(index.efSearchConfigured, false);
		});

		it('retains the existing error for non-conforming native geometry', async () => {
			await assert.rejects(
				loadTable(
					'HnswNativeBadGeometry',
					'(audit: true)',
					'type: "HNSW", distance: "cosine", nativePlane: true, M: "32"'
				),
				(error) =>
					error instanceof ClientError &&
					error.message ===
						'nativePlane requires M=16, efConstruction=200, mL=1/ln(16), and optimizeRouting=0.5; set nativePlane: false to use the JS index'
			);
		});
	});

	after(async () => {
		for (const tableName of createdTables) await tables[tableName]?.dropTable();
	});
});
