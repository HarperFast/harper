require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const schema = require('#src/dataLayer/schema');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const { setSchemaDataToGlobalAsync } = require('#src/utility/globalSchema');

const DATABASE = 'droppkdb';

describe('the primary key cannot be dropped', () => {
	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		await schema.createSchemaStructure({ operation: 'create_schema', schema: DATABASE });
	});

	async function createDynamicTable(name, primaryKey = 'id') {
		await schema.createTableStructure({
			operation: 'create_table',
			schema: DATABASE,
			table: name,
			primary_key: primaryKey,
		});
		await setSchemaDataToGlobalAsync();
		const Table = getDatabases()[DATABASE][name];
		await Table.addAttributes([{ name: 'name' }, { name: 'price' }]);
		await Table.put({ [primaryKey]: 'item-1', name: 'Widget', price: 10 });
		return Table;
	}

	function createSchemaDefinedTable(name, primaryKey) {
		return table({
			table: name,
			database: DATABASE,
			schemaDefined: true,
			attributes: [{ name: primaryKey, isPrimaryKey: true }, { name: 'name' }, { name: 'price' }],
		});
	}

	function dropAttribute(tableName, attribute) {
		return schema.dropAttribute({ operation: 'drop_attribute', schema: DATABASE, table: tableName, attribute });
	}

	function isPrimaryKeyRejection(error) {
		assert.strictEqual(error.statusCode, 400);
		assert.strictEqual(error.message, 'You cannot drop a hash attribute');
		return true;
	}

	async function assertTableIntact(Table, primaryKey) {
		assert.strictEqual(Table.primaryKey, primaryKey);
		assert.strictEqual(Table.attributes.find((attribute) => attribute.isPrimaryKey)?.name, primaryKey);
		assert.strictEqual(
			Table.attributes.some((attribute) => attribute.name === 'price'),
			true,
			'an ordinary attribute was removed by a rejected request'
		);
		const description = await describeTable({ schema: DATABASE, table: Table.tableName });
		assert.strictEqual(description.primary_key, primaryKey);
		assert.ok(
			description.attributes.some((attribute) => attribute.attribute === primaryKey),
			'describe_table lost the primary key attribute'
		);
		const stored = Table.primaryStore.getSync('item-1');
		assert.strictEqual(stored[primaryKey], 'item-1', 'the stored record lost its primary key property');
		assert.strictEqual(stored.price, 10, 'the stored record lost an ordinary property');
		assert.strictEqual((await Table.get('item-1'))[primaryKey], 'item-1');
	}

	describe('drop_attribute operation', () => {
		for (const primaryKey of ['id', 'sku']) {
			it(`rejects the primary key '${primaryKey}' of a dynamic table and leaves its records untouched`, async () => {
				const name = `DynamicDropKey_${primaryKey}`;
				const Table = await createDynamicTable(name, primaryKey);
				await assert.rejects(() => dropAttribute(name, primaryKey), isPrimaryKeyRejection);
				await assertTableIntact(Table, primaryKey);
			});
		}

		it('rejects the primary key before the bridge runs', async () => {
			await createDynamicTable('DynamicDropKeyEarly');
			let bridgeCalls = 0;
			harperBridge.dropAttribute = () => {
				bridgeCalls++;
			};
			try {
				await assert.rejects(() => dropAttribute('DynamicDropKeyEarly', 'id'), isPrimaryKeyRejection);
			} finally {
				delete harperBridge.dropAttribute;
			}
			assert.strictEqual(bridgeCalls, 0);
		});

		it('still drops an ordinary attribute and strips it from the stored records', async () => {
			const Table = await createDynamicTable('DynamicDropOrdinary');
			const result = await dropAttribute('DynamicDropOrdinary', 'price');
			assert.strictEqual(result, "successfully deleted attribute 'price'");
			assert.strictEqual(
				Table.attributes.some((attribute) => attribute.name === 'price'),
				false
			);
			assert.strictEqual(Object.hasOwn(Table.primaryStore.getSync('item-1'), 'price'), false);
			assert.strictEqual(Table.primaryStore.getSync('item-1').id, 'item-1');
			assert.strictEqual(Table.primaryKey, 'id');
		});
	});

	describe('the bridge', () => {
		it('does not rewrite records when the primary key is the dropped attribute', async () => {
			const Table = await createDynamicTable('BridgeDropKey');
			await assert.rejects(
				() => harperBridge.dropAttribute({ schema: DATABASE, table: 'BridgeDropKey', attribute: 'id' }),
				isPrimaryKeyRejection
			);
			await assertTableIntact(Table, 'id');
		});
	});

	describe('Table.removeAttributes', () => {
		for (const schemaDefined of [false, true]) {
			for (const primaryKey of ['id', 'sku']) {
				const kind = schemaDefined ? 'schema-defined' : 'dynamic';
				it(`rejects the primary key '${primaryKey}' of a ${kind} table`, async () => {
					const name = `Remove_${kind}_${primaryKey}`;
					const Table = schemaDefined
						? createSchemaDefinedTable(name, primaryKey)
						: await createDynamicTable(name, primaryKey);
					if (schemaDefined) await Table.put({ [primaryKey]: 'item-1', name: 'Widget', price: 10 });
					await assert.rejects(() => Table.removeAttributes([primaryKey]), isPrimaryKeyRejection);
					await assertTableIntact(Table, primaryKey);
				});

				it(`removes nothing when the ${kind} table's primary key '${primaryKey}' is named after an ordinary attribute`, async () => {
					const name = `RemoveMixed_${kind}_${primaryKey}`;
					const Table = schemaDefined
						? createSchemaDefinedTable(name, primaryKey)
						: await createDynamicTable(name, primaryKey);
					if (schemaDefined) await Table.put({ [primaryKey]: 'item-1', name: 'Widget', price: 10 });
					await assert.rejects(() => Table.removeAttributes(['price', primaryKey]), isPrimaryKeyRejection);
					await assertTableIntact(Table, primaryKey);
				});
			}
		}

		it('still removes ordinary attributes', async () => {
			const Table = createSchemaDefinedTable('RemoveOrdinary', 'id');
			await Table.removeAttributes(['price']);
			assert.deepStrictEqual(
				Table.attributes.map((attribute) => attribute.name),
				['id', 'name']
			);
		});
	});
});
