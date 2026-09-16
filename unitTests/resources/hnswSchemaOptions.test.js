const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { resetDatabases, tables } = require('#src/resources/databases');
const { ClientError } = require('#src/utility/errors/hdbError');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const createdTables = [];

function customIndex(tableName) {
	return tables[tableName].indices.embedding.customIndex;
}

function indexedOptions(tableName) {
	return tables[tableName].attributes.find((attribute) => attribute.name === 'embedding').indexed;
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

		assert.equal(indexedOptions('HnswQuotedNumericOptions').M, '12');
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

	describe('native plane geometry', () => {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

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
					error.message === 'nativePlane requires M=16, efConstruction=200, mL=1/ln(16), and optimizeRouting=0.5'
			);
		});
	});

	after(async () => {
		for (const tableName of createdTables) await tables[tableName]?.dropTable();
	});
});
