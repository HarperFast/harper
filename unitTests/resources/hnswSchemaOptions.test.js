const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, resetDatabases, table, tables } = require('#src/resources/databases');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');
const { derivedIndexReadiness } = require('#src/resources/indexes/hnswDerivedIndex');
const { READINESS_BYTES } = require('#src/resources/derivedIndexRuntime');
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
		assert.strictEqual(redeclared.optimizeRouting, '0');
		assert.strictEqual(indexedOptions(tableName).optimizeRouting, '0');

		for (const [suffix, declaration] of [
			['Boolean', 'false'],
			['QuotedBoolean', '"false"'],
		]) {
			const booleanOverrideTable = `HnswLegacy${suffix}RoutingOverride`;
			await loadTable(booleanOverrideTable, '', 'type: "HNSW", optimizeRouting: 0.6');
			const booleanOverrideDescriptor = tables[booleanOverrideTable].dbisDB.getSync(
				`${booleanOverrideTable}/embedding`
			);
			booleanOverrideDescriptor.indexed.optimizeRouting = '0';
			tables[booleanOverrideTable].dbisDB.putSync(`${booleanOverrideTable}/embedding`, booleanOverrideDescriptor);
			await loadTable(booleanOverrideTable, '', `type: "HNSW", optimizeRouting: ${declaration}`);
			assert.strictEqual(indexedOptions(booleanOverrideTable).optimizeRouting, 0);
		}

		const nullTableName = 'HnswLegacyNullRouting';
		await loadTable(nullTableName, '', 'type: "HNSW", optimizeRouting: 0.6');
		const nullDescriptor = tables[nullTableName].dbisDB.getSync(`${nullTableName}/embedding`);
		nullDescriptor.indexed.optimizeRouting = null;
		tables[nullTableName].dbisDB.putSync(`${nullTableName}/embedding`, nullDescriptor);
		assert.equal(tables[nullTableName].dbisDB.getSync(`${nullTableName}/embedding`).indexed.optimizeRouting, null);
		delete tables[nullTableName].indices.embedding;
		resetDatabases();
		assert.equal(indexedOptions(nullTableName).optimizeRouting, null);
		assert.equal(customIndex(nullTableName).optimizeRouting, null);

		const exactTableName = 'HnswLegacyExactNumericDeclaration';
		await loadTable(exactTableName, '', 'type: "HNSW", optimizeRouting: 0.6');
		const exactDescriptor = tables[exactTableName].dbisDB.getSync(`${exactTableName}/embedding`);
		exactDescriptor.indexed.optimizeRouting = '0.0';
		tables[exactTableName].dbisDB.putSync(`${exactTableName}/embedding`, exactDescriptor);
		delete tables[exactTableName].indices.embedding;
		resetDatabases();
		assert.equal(customIndex(exactTableName).optimizeRouting, '0.0');
		const unchanged = await loadTable(exactTableName, '', 'type: "HNSW", optimizeRouting: "0.0"');
		assert.equal(unchanged.optimizeRouting, '0.0');
		assert.equal(indexedOptions(exactTableName).optimizeRouting, '0.0');
		const equivalentUnquoted = await loadTable(exactTableName, '', 'type: "HNSW", optimizeRouting: 0');
		assert.strictEqual(equivalentUnquoted.optimizeRouting, '0.0');
		assert.strictEqual(indexedOptions(exactTableName).optimizeRouting, '0.0');
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
		assert.equal(customIndex(stringTable).postCommit, true);
		assert.equal(descriptor.indexed.nativePlane, 'false');
		await closeDerivedRuntime(tables[stringTable]);
		await loadTable(stringTable, '(audit: true)', 'type: "HNSW", nativePlane: false');
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
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlaneMaxNodes: 0 }, type: 'Array' },
			],
		});
		assert.equal(Table.indices.embedding.customIndex.postCommit, undefined);
		assert.equal(Object.hasOwn(indexedOptions(tableName), 'nativePlane'), false);
	});

	it('refreshes a loaded table class when audit is durably enabled elsewhere', () => {
		const tableName = 'HnswDurableAuditRefresh';
		const Table = table({
			table: tableName,
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		createdTables.push(tableName);
		const primary = Table.dbisDB.getSync(`${tableName}/`);
		primary.audit = true;
		Table.dbisDB.putSync(`${tableName}/`, primary);
		assert.equal(Table.audit, false);

		resetDatabases();
		assert.equal(tables[tableName].audit, true);
	});

	it('refreshes durable audit on a peer declaration without an HNSW index', () => {
		const tableName = 'HnswPeerAuditRefresh';
		let Table = table({
			table: tableName,
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', type: 'String' },
			],
		});
		createdTables.push(tableName);
		const primary = Table.dbisDB.getSync(`${tableName}/`);
		primary.audit = true;
		Table.dbisDB.putSync(`${tableName}/`, primary);
		assert.equal(Table.audit, false);

		Table = table({
			table: tableName,
			origin: 'cluster',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', type: 'String' },
			],
		});
		assert.equal(Table.audit, true);
	});

	it('refreshes durable audit before opening native mode on a stale class', function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const tableName = 'HnswDurableAuditNativeOpen';
		let Table = table({
			table: tableName,
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', type: 'Array' },
			],
		});
		createdTables.push(tableName);
		const primary = Table.dbisDB.getSync(`${tableName}/`);
		primary.audit = true;
		Table.dbisDB.putSync(`${tableName}/`, primary);
		assert.equal(Table.audit, false);

		Table = table({
			table: tableName,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		assert.equal(Table.audit, true);
		assert.equal(Table.indices.embedding.customIndex.postCommit, true);
	});

	it('pins effective audit before persisting explicit native mode', function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const tableName = 'HnswExplicitNativePinsAudit';
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

		Table = table({
			table: tableName,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		assert.equal(Table.dbisDB.getSync(`${tableName}/`).audit, true);
		assert.equal(Table.dbisDB.getSync(`${tableName}/embedding`).indexed.nativePlane, true);
	});

	it('does not default a same-call table creation from the global audit setting', async () => {
		const tableName = 'HnswGlobalAuditCreate';
		const index = await loadTable(tableName, '', 'type: "HNSW"');
		assert.equal(index.postCommit, undefined);
		assert.equal(Object.hasOwn(indexedOptions(tableName), 'nativePlane'), false);
	});

	it('validates native-only capacity only after base native eligibility', async () => {
		const previous = process.env.HNSW_NO_NATIVE_DEFAULT;
		delete process.env.HNSW_NO_NATIVE_DEFAULT;
		try {
			const incompatible = await loadTable(
				'HnswIneligibleNativeCapacityIgnored',
				'(audit: true)',
				'type: "HNSW", M: 12, nativePlaneMaxNodes: 0'
			);
			assert.equal(incompatible.postCommit, undefined);
			const tableName = 'HnswIneligibleNativeCapacity';
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) {
				const index = await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlaneMaxNodes: 0');
				assert.equal(index.postCommit, undefined);
				assert.equal(Object.hasOwn(indexedOptions(tableName), 'nativePlane'), false);
				return;
			}
			await assert.rejects(
				loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlaneMaxNodes: 0'),
				(error) =>
					error instanceof ClientError &&
					error.message === 'nativePlaneMaxNodes must be a positive integer below 2^32-1'
			);
			const atomicTableName = 'HnswNativeCapacityAtomic';
			const AtomicTable = table({
				table: atomicTableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'kept', type: 'String' },
				],
			});
			createdTables.push(atomicTableName);
			assert.deepStrictEqual(
				AtomicTable.attributes.map(({ name }) => name),
				['id', 'kept']
			);
			assert.throws(
				() =>
					HierarchicalNavigableSmallWorld.canDefaultToNativePlane(AtomicTable.primaryStore.rootStore, {
						type: 'HNSW',
						nativePlaneMaxNodes: 0,
					}),
				/nativePlaneMaxNodes must be a positive integer/
			);
			assert.throws(
				() =>
					table({
						table: atomicTableName,
						audit: true,
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{
								name: 'embedding',
								type: 'Array',
								indexed: { type: 'HNSW', nativePlaneMaxNodes: 0 },
							},
						],
					}),
				/nativePlaneMaxNodes must be a positive integer/
			);
			assert.deepStrictEqual(
				AtomicTable.attributes.map(({ name }) => name),
				['id', 'kept']
			);
			assert.strictEqual(AtomicTable.dbisDB.getSync(`${atomicTableName}/embedding`), undefined);
			assert.throws(
				() =>
					table({
						table: atomicTableName,
						audit: true,
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{
								name: 'embedding',
								type: 'Array',
								indexed: { type: 'HNSW', nativePlane: true, M: 32 },
							},
						],
					}),
				/nativePlane requires M=16/
			);
			assert.deepStrictEqual(
				AtomicTable.attributes.map(({ name }) => name),
				['id', 'kept']
			);
			assert.strictEqual(AtomicTable.dbisDB.getSync(`${atomicTableName}/embedding`), undefined);

			const legacyAtomicTableName = 'HnswNativeCapacityLegacyAtomic';
			const LegacyAtomicTable = table({
				table: legacyAtomicTableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'kept', type: 'String' },
				],
			});
			createdTables.push(legacyAtomicTableName);
			const legacyPrimary = LegacyAtomicTable.dbisDB.getSync(`${legacyAtomicTableName}/`);
			LegacyAtomicTable.dbisDB.putSync(`${legacyAtomicTableName}/id`, {
				...legacyPrimary,
				name: 'id',
				attribute: 'id',
				isPrimaryKey: true,
				audit: true,
			});
			LegacyAtomicTable.dbisDB.putSync(`${legacyAtomicTableName}/`, {
				tableId: legacyPrimary.tableId,
				audit: false,
			});
			assert.throws(
				() =>
					table({
						table: legacyAtomicTableName,
						attributes: [
							{
								name: 'embedding',
								type: 'Array',
								indexed: { type: 'HNSW', nativePlaneMaxNodes: 0 },
							},
						],
					}),
				/nativePlaneMaxNodes must be a positive integer/
			);
			assert.deepStrictEqual(
				LegacyAtomicTable.attributes.map(({ name }) => name),
				['id', 'kept']
			);
			assert.strictEqual(LegacyAtomicTable.dbisDB.getSync(`${legacyAtomicTableName}/embedding`), undefined);

			const failedCreateName = 'HnswExplicitNativeGeometryAtomic';
			assert.throws(
				() =>
					table({
						table: failedCreateName,
						audit: true,
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{
								name: 'embedding',
								type: 'Array',
								indexed: { type: 'HNSW', nativePlane: true, M: 32 },
							},
						],
					}),
				/nativePlane requires M=16/
			);
			assert.strictEqual(tables[failedCreateName], undefined);
			assert.strictEqual(AtomicTable.dbisDB.getSync(`${failedCreateName}/`), undefined);
			assert.strictEqual(AtomicTable.dbisDB.getSync(`${failedCreateName}/embedding`), undefined);
		} finally {
			if (previous === undefined) delete process.env.HNSW_NO_NATIVE_DEFAULT;
			else process.env.HNSW_NO_NATIVE_DEFAULT = previous;
		}
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

		const forgedAuditTableName = 'HnswReplicatedNativeForgedAudit';
		table({
			table: forgedAuditTableName,
			audit: false,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		createdTables.push(forgedAuditTableName);
		Table = table({
			table: forgedAuditTableName,
			origin: 'cluster',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
			],
		});
		assert.equal(Table.indices.embedding.customIndex.postCommit, undefined);
		assert.equal(indexedOptions(forgedAuditTableName).nativePlane, false);
		assert.equal(Table.dbisDB.getSync(`${forgedAuditTableName}/`).audit, false);

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

		const legacyTableName = 'HnswReplicatedLegacyStringNative';
		table({
			table: legacyTableName,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		createdTables.push(legacyTableName);
		Table = table({
			table: legacyTableName,
			origin: 'cluster',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: 'false' }, type: 'Array' },
			],
		});
		const canRunLegacyNative = process.env.HARPER_STORAGE_ENGINE !== 'lmdb' && getPlaneBinding();
		assert.equal(Table.indices.embedding.customIndex.postCommit, canRunLegacyNative ? true : undefined);
		assert.equal(indexedOptions(legacyTableName).nativePlane, canRunLegacyNative ? 'false' : false);

		const nullTableName = 'HnswReplicatedNullGeometry';
		table({
			table: nullTableName,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		createdTables.push(nullTableName);
		Table = table({
			table: nullTableName,
			origin: 'cluster',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{
					name: 'embedding',
					indexed: { type: 'HNSW', nativePlane: true, optimizeRouting: null },
					type: 'Array',
				},
			],
		});
		assert.equal(Table.indices.embedding.customIndex.postCommit, undefined);
		assert.equal(indexedOptions(nullTableName).nativePlane, false);
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

			for (const createdTableName of createdTables) await closeDerivedRuntime(tables[createdTableName]);
			resetDatabases();
			assert.equal(customIndex(tableName).postCommit, true);
			assert.equal(indexedOptions(tableName).nativePlane, true);
		});

		it('defaults an index added after the global audit default is durable', async () => {
			const tableName = 'HnswDurableGlobalAuditDefault';
			let Table = table({
				table: tableName,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', type: 'Array' },
				],
			});
			createdTables.push(tableName);
			assert.equal(Table.dbisDB.getSync(`${tableName}/`).audit, true);

			Table = table({
				table: tableName,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW' }, type: 'Array' },
				],
			});
			const nativeDefaultAvailable = Boolean(getPlaneBinding());
			assert.equal(Table.indices.embedding.customIndex.postCommit, nativeDefaultAvailable ? true : undefined);
			assert.equal(
				Object.hasOwn(indexedOptions(tableName), 'nativePlane'),
				nativeDefaultAvailable,
				'the persisted audit descriptor controls the later index declaration'
			);
		});

		it('rejects invalid native geometry before persisting an audit upgrade', () => {
			const tableName = 'HnswAuditUpgradeOrdering';
			table({
				table: tableName,
				audit: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', type: 'Array' },
				],
			});
			createdTables.push(tableName);

			assert.throws(
				() =>
					table({
						table: tableName,
						audit: true,
						attributes: [
							{
								name: 'embedding',
								indexed: { type: 'HNSW', nativePlane: true, M: 32 },
								type: 'Array',
							},
							{ name: 'id', isPrimaryKey: true },
						],
					}),
				(error) => error instanceof ClientError && error.message.startsWith('nativePlane requires M=16')
			);
			assert.equal(tables[tableName].dbisDB.getSync(`${tableName}/`).audit, false);
			assert.equal(tables[tableName].dbisDB.getSync(`${tableName}/embedding`).indexed, undefined);
		});

		it('persists an audit upgrade when a native index declaration omits the primary key', function () {
			if (!getPlaneBinding()) this.skip();
			const tableName = 'HnswAuditUpgradeWithoutPrimary';
			let Table = table({
				table: tableName,
				audit: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', type: 'Array' },
				],
			});
			createdTables.push(tableName);
			Table = table({
				table: tableName,
				audit: true,
				attributes: [{ name: 'embedding', indexed: { type: 'HNSW' }, type: 'Array' }],
			});

			assert.equal(Table.audit, true);
			assert.equal(Table.dbisDB.getSync(`${tableName}/`).audit, true);
			assert.equal(Table.indices.embedding.customIndex.postCommit, true);
			assert.ok(Table.attributes.some(({ name, isPrimaryKey }) => name === 'id' && isPrimaryKey));
		});

		it('persists an audit upgrade for a table without a primary key', function () {
			if (!getPlaneBinding()) this.skip();
			const tableName = 'HnswAuditUpgradeNoPrimary';
			let Table = table({
				table: tableName,
				audit: false,
				attributes: [
					{ name: 'name', type: 'String' },
					{ name: 'embedding', type: 'Array' },
				],
			});
			createdTables.push(tableName);

			Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'name', type: 'String' },
					{ name: 'embedding', indexed: { type: 'HNSW' }, type: 'Array' },
				],
			});
			assert.equal(Table.audit, true);
			assert.equal(Table.dbisDB.getSync(`${tableName}/`).audit, true);
			assert.equal(Table.indices.embedding.customIndex.postCommit, true);

			resetDatabases();
			Table = databases.data[tableName];
			assert.equal(Table.audit, true);
			assert.equal(Table.indices.embedding.customIndex.postCommit, true);
		});

		it('rejects removing the primary-key designation from the primary attribute', () => {
			const tableName = 'HnswPrimaryKeyDesignation';
			table({
				table: tableName,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', type: 'Array' },
				],
			});
			createdTables.push(tableName);

			assert.throws(
				() => table({ table: tableName, attributes: [{ name: 'id', type: 'String' }] }),
				/Cannot remove the primary key designation/
			);
		});

		it('persists removal or opt-out before disabling audit', async function () {
			if (!getPlaneBinding()) this.skip();
			const tableName = 'HnswAuditDisableOrdering';
			let Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			createdTables.push(tableName);
			const catalogPrototype = Object.getPrototypeOf(Table.dbisDB);
			const writes = [];
			const patched = [];
			for (const method of ['put', 'putSync']) {
				const original = catalogPrototype[method];
				if (typeof original !== 'function') continue;
				catalogPrototype[method] = function (key, ...rest) {
					if (key === `${tableName}/` || key === `${tableName}/embedding`) writes.push(key);
					return original.call(this, key, ...rest);
				};
				patched.push([method, original]);
			}
			try {
				Table = table({
					table: tableName,
					audit: false,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: false }, type: 'Array' },
					],
				});
			} finally {
				for (const [method, original] of patched) catalogPrototype[method] = original;
			}
			assert(
				writes.lastIndexOf(`${tableName}/embedding`) < writes.lastIndexOf(`${tableName}/`),
				`the index opt-out must be durable before audit is disabled: ${writes}`
			);
			assert.equal(Table.dbisDB.getSync(`${tableName}/embedding`).indexed.nativePlane, false);
			assert.equal(Table.dbisDB.getSync(`${tableName}/`).audit, false);
			assert.throws(
				() =>
					table({
						table: tableName,
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
						],
					}),
				(error) => error instanceof ClientError && error.message.includes('must enable audit logging')
			);
			assert.equal(Table.dbisDB.getSync(`${tableName}/embedding`).indexed.nativePlane, false);
			assert.equal(Table.dbisDB.getSync(`${tableName}/`).audit, false);
			assert.equal(
				Table.attributes.find(({ name }) => name === 'embedding').indexed.nativePlane,
				false,
				'a rejected native re-enable must not pollute the live attribute list'
			);
			await Table.addAttributes([{ name: 'label', type: 'String' }]);
			assert.equal(Table.dbisDB.getSync(`${tableName}/label`).name, 'label');

			const removedTableName = 'HnswAuditDisableWithIndexRemoval';
			const Removed = table({
				table: removedTableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			createdTables.push(removedTableName);
			const removalWrites = [];
			const removalPrototype = Object.getPrototypeOf(Removed.dbisDB);
			const removalPatched = [];
			for (const method of ['put', 'putSync']) {
				const original = removalPrototype[method];
				if (typeof original !== 'function') continue;
				removalPrototype[method] = function (key, ...rest) {
					if (key === `${removedTableName}/` || key === `${removedTableName}/embedding`) removalWrites.push(key);
					return original.call(this, key, ...rest);
				};
				removalPatched.push([method, original]);
			}
			try {
				table({
					table: removedTableName,
					audit: false,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'embedding', type: 'Array' },
					],
				});
			} finally {
				for (const [method, original] of removalPatched) removalPrototype[method] = original;
			}
			assert(
				removalWrites.lastIndexOf(`${removedTableName}/embedding`) < removalWrites.lastIndexOf(`${removedTableName}/`),
				`the index removal must be durable before audit is disabled: ${removalWrites}`
			);
			assert.equal(Removed.dbisDB.getSync(`${removedTableName}/embedding`).indexed, undefined);
			assert.equal(Removed.dbisDB.getSync(`${removedTableName}/`).audit, false);
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

		it('accepts compatible legacy numeric spellings when native mode is enabled', async () => {
			const tableName = 'HnswNativeLegacyGeometry';
			await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: false, M: 16, optimizeRouting: 0.5');
			const descriptor = tables[tableName].dbisDB.getSync(`${tableName}/embedding`);
			descriptor.indexed.M = '16';
			descriptor.indexed.optimizeRouting = '0.5';
			tables[tableName].dbisDB.putSync(`${tableName}/embedding`, descriptor);

			const index = await loadTable(
				tableName,
				'(audit: true)',
				'type: "HNSW", nativePlane: true, M: "16", optimizeRouting: "0.5"'
			);
			assert.equal(index.M, 16);
			assert.equal(index.optimizeRouting, 0.5);
			assert.equal(index.postCommit, true);
			assert.equal(indexedOptions(tableName).M, '16');
			assert.equal(indexedOptions(tableName).optimizeRouting, '0.5');
		});

		it('hands a shared physical runner to a recreated table generation', async function () {
			if (!getPlaneBinding()) this.skip();
			const tableName = 'HnswNativeAliasRecreate';
			let Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			createdTables.push(tableName);
			resetDatabases();
			Table = databases.data[tableName];
			const alias = databases.dev[tableName];
			assert.ok(alias?.derivedIndexRuntime, 'the configured database alias must share the physical table');

			await Table.dropTable();
			Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			await alias.dropTable();
			assert.strictEqual(databases.data[tableName], Table, 'a stale alias must not drop the recreated generation');
			await Table.put('recreated', { embedding: [1, 0] });
			await waitFor(
				async () => {
					if (derivedIndexReadiness(Table.auditStore, Table.indices.embedding.name).state !== 'ready') return false;
					const results = await Table.indices.embedding.customIndex.search(
						{ target: [1, 0], comparator: 'sort', distance: 'cosine', ef: 20 },
						{ transaction: undefined },
						{ filter: undefined }
					);
					return results.some(({ key }) => key === 'recreated');
				},
				{ timeout: 15_000, message: 'the recreated table generation did not receive derived-index writes' }
			);
		});

		it('rebuilds an unavailable native index when it is re-enabled on the same table generation', async function () {
			if (!getPlaneBinding()) this.skip();
			const tableName = 'HnswNativeSameGenerationReenable';
			let Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			createdTables.push(tableName);
			await waitFor(() => derivedIndexReadiness(Table.auditStore, Table.indices.embedding.name).state === 'ready', {
				timeout: 15_000,
			});

			const backendId = `hnsw:${Table.indices.embedding.name}`;
			const readiness = Table.auditStore.getUserSharedBuffer(
				`derived-index:${backendId}:readiness`,
				new ArrayBuffer(READINESS_BYTES)
			);
			const readinessWords = new Int32Array(readiness, 0, 6);
			Atomics.store(readinessWords, 0, 4);
			Atomics.store(readinessWords, 3, 0);
			assert.equal(derivedIndexReadiness(Table.auditStore, Table.indices.embedding.name).state, 'unavailable');

			Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			assert.equal(Atomics.load(readinessWords, 3), 0, 'routine re-registration must not reset the failure budget');

			const unavailableRuntime = Table.derivedIndexRuntime;
			Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: false }, type: 'Array' },
				],
			});
			await unavailableRuntime.close();

			Table = table({
				table: tableName,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'embedding', indexed: { type: 'HNSW', nativePlane: true }, type: 'Array' },
				],
			});
			await waitFor(() => derivedIndexReadiness(Table.auditStore, Table.indices.embedding.name).state === 'ready', {
				timeout: 15_000,
			});
		});

		it('keeps an unchanged unsupported legacy native-plane spelling loadable', async () => {
			const tableName = 'HnswLegacyNumericNativePlane';
			await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: true');
			const attribute = tables[tableName].attributes.find(({ name }) => name === 'embedding');
			let descriptor = tables[tableName].dbisDB.getSync(`${tableName}/embedding`);
			attribute.indexed.nativePlane = descriptor.indexed.nativePlane = '1';
			tables[tableName].dbisDB.putSync(`${tableName}/embedding`, descriptor);

			const index = await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: "1"');
			descriptor = tables[tableName].dbisDB.getSync(`${tableName}/embedding`);
			assert.equal(index.postCommit, true);
			assert.strictEqual(descriptor.indexed.nativePlane, '1');
			const unquotedReload = await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: 1');
			assert.equal(unquotedReload.postCommit, true);
			assert.strictEqual(indexedOptions(tableName).nativePlane, '1');
			await assert.rejects(loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: 2'), (error) => {
				return error instanceof ClientError && error.message === 'nativePlane must be true or false';
			});
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

			const tableName = 'HnswInheritedNativeBadGeometry';
			await loadTable(tableName, '(audit: true)', 'type: "HNSW", nativePlane: true');
			await assert.rejects(loadTable(tableName, '(audit: true)', 'type: "HNSW", M: 32'), /nativePlane requires M=16/);
			assert.strictEqual(indexedOptions(tableName).nativePlane, true);
			assert.strictEqual(Object.hasOwn(indexedOptions(tableName), 'M'), false);
		});
	});

	after(async () => {
		for (const tableName of createdTables) await tables[tableName]?.dropTable();
	});
});
