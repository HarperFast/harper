// Tables with no primary key (harper#3225): a bare `<table>/` catalog row that lacks isPrimaryKey must
// still load as the table's primary store, and a schema that declares a key on a keyless table must
// leave it keyless instead of failing the schema.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, getDatabases, isPrimaryCatalogRow, resetDatabases, table } = require('#src/resources/databases');
const { forComponent } = require('#src/utility/logging/harper_logger');

async function commitCatalog(Table) {
	if (Table.dbisDB.committed) await Table.dbisDB.committed;
}

async function withStorageLines(level, callback) {
	const storageLogger = forComponent('storage');
	const original = storageLogger[level];
	const lines = [];
	storageLogger[level] = (...args) => lines.push(args.map(String).join(' '));
	try {
		await callback();
	} finally {
		storageLogger[level] = original;
	}
	return lines;
}

function assertStaysKeyless(Table, tableName) {
	assert.strictEqual(Table.primaryKey, undefined, 'the table must stay keyless');
	assert(
		!Table.attributes.some((attribute) => attribute.isPrimaryKey),
		'no live attribute may claim to be the primary key'
	);
	assert(
		Table.attributes.some((attribute) => attribute.name === 'id'),
		'the declared key must load as an ordinary attribute'
	);
	assert.strictEqual(Table.dbisDB.getSync(`${tableName}/`)?.name, undefined, 'the bare row must not gain a key name');
	const idDescriptor = Table.dbisDB.getSync(`${tableName}/id`);
	assert(idDescriptor, 'the declared key must persist as an ordinary attribute descriptor');
	assert(!idDescriptor.isPrimaryKey, 'the persisted descriptor must not be a primary key');
	assert.strictEqual(typeof Table.getNewId(), 'number', 'generated ids must keep the keyless numeric type');
}

describe('tables with no primary key (harper#3225)', () => {
	before(function () {
		setupTestDBPath();
	});

	it('recognizes a primary catalog row by its flag, or as a nameless bare `<table>/` row', function () {
		assert.strictEqual(isPrimaryCatalogRow('T/', {}), true);
		assert.strictEqual(isPrimaryCatalogRow('T/id', { name: 'id', isPrimaryKey: true }), true);
		assert.strictEqual(isPrimaryCatalogRow('T/', { name: 'id' }), false, 'a named bare row needs its flag');
		assert.strictEqual(isPrimaryCatalogRow('T/name', { name: 'name' }), false);
		assert.strictEqual(isPrimaryCatalogRow('T/x/', {}), false, 'initStores reads this as attribute x of T');
		assert.strictEqual(isPrimaryCatalogRow('', {}), false);
		assert.strictEqual(isPrimaryCatalogRow('/', {}), false);
		assert.strictEqual(isPrimaryCatalogRow(Symbol.for('structures'), []), false);
		assert.strictEqual(isPrimaryCatalogRow('T/', undefined), false);
	});

	it('loads a table whose bare catalog row lacks isPrimaryKey, with its records readable and writable', async function () {
		const tableName = 'KeylessBareRow3225';
		const Keyless = table({
			table: tableName,
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'name', type: 'String' }],
		});
		const firstId = await Keyless.post({ name: 'first' });
		const bareKey = `${tableName}/`;
		const row = { ...Keyless.dbisDB.getSync(bareKey) };
		assert.strictEqual(row.name, undefined, 'a keyless table has a nameless bare row');
		assert(row.tableId, 'the copied row must carry the original descriptor');
		delete row.isPrimaryKey;
		delete row.is_hash_attribute;
		Keyless.dbisDB.putSync(bareKey, row);
		await commitCatalog(Keyless);
		assert.strictEqual(Keyless.dbisDB.getSync(bareKey).isPrimaryKey, undefined);

		delete databases.test[tableName];
		resetDatabases();
		const Reloaded = getDatabases().test[tableName];
		assert(Reloaded, 'the table must load from a bare row without isPrimaryKey');
		assert.strictEqual(Reloaded.primaryKey, undefined);
		assert.strictEqual((await Reloaded.get(firstId))?.name, 'first', 'records written before must stay readable');
		const secondId = await Reloaded.post({ name: 'second' });
		assert.strictEqual((await Reloaded.get(secondId))?.name, 'second', 'the reloaded table must accept writes');
	});

	it('keeps a populated keyless table keyless when the schema declares a primary key', async function () {
		const tableName = 'KeylessDeclared3225';
		await loadGQLSchema(`type ${tableName} @table { name: String }`);
		const existingId = await tables[tableName].post({ name: 'existing' });
		const declared = `type ${tableName} @table { id: ID @primaryKey name: String }`;

		const errorLines = await withStorageLines('error', () => loadGQLSchema(declared));
		const attributed = errorLines.filter((line) => line.includes(`'data.${tableName}'`));
		assert.strictEqual(
			attributed.length,
			1,
			`expected one error for ${tableName}; captured:\n${errorLines.join('\n')}`
		);
		assert(attributed[0].includes(`declared primary key 'id' is ignored`), attributed[0]);
		await commitCatalog(tables[tableName]);
		assertStaysKeyless(tables[tableName], tableName);
		assert.strictEqual((await tables[tableName].get(existingId))?.name, 'existing');

		// a second declaration in the same process must not trip the "remove the primary key" guard
		await loadGQLSchema(declared);
		await commitCatalog(tables[tableName]);
		assertStaysKeyless(tables[tableName], tableName);
	});

	it('keeps an empty keyless table keyless across a declaration, a write and a reload', async function () {
		const tableName = 'KeylessEmptyDeclared3225';
		await loadGQLSchema(`type ${tableName} @table { name: String }`);
		const declared = `type ${tableName} @table { id: ID @primaryKey name: String }`;
		await loadGQLSchema(declared);
		const createdId = await tables[tableName].post({ name: 'after the declaration' });
		assert.strictEqual(typeof createdId, 'number', 'a keyless table must keep generating numeric ids');

		await commitCatalog(tables[tableName]);
		delete databases.data[tableName];
		resetDatabases();
		await loadGQLSchema(declared);
		await commitCatalog(tables[tableName]);
		assertStaysKeyless(tables[tableName], tableName);
		assert.strictEqual((await tables[tableName].get(createdId))?.name, 'after the declaration');
	});

	it('ignores every key declared on a populated keyless table', async function () {
		const tableName = 'KeylessTwoKeys3225';
		const Keyless = table({ table: tableName, database: 'test', schemaDefined: true, attributes: [{ name: 'name' }] });
		const existingId = await Keyless.post({ name: 'existing' });
		table({
			table: tableName,
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'code', type: 'String', isPrimaryKey: true },
				{ name: 'name' },
			],
		});
		await commitCatalog(Keyless);
		assertStaysKeyless(databases.test[tableName], tableName);
		assert(!databases.test[tableName].dbisDB.getSync(`${tableName}/code`)?.isPrimaryKey);
		assert.strictEqual((await databases.test[tableName].get(existingId))?.name, 'existing');
	});

	it('ignores a key declared by a caller that does not author the schema, without logging', async function () {
		const tableName = 'KeylessUnauthored3225';
		const Keyless = table({ table: tableName, database: 'test', attributes: [{ name: 'name' }] });
		const errorLines = await withStorageLines('error', () =>
			table({
				table: tableName,
				database: 'test',
				attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }, { name: 'name' }],
			})
		);
		assert.deepStrictEqual(
			errorLines.filter((line) => line.includes(tableName)),
			[],
			'only a schema-authored declaration is reported'
		);
		const createdId = await Keyless.post({ name: 'after the declaration' });
		assert.strictEqual(typeof createdId, 'number', 'a keyless table must keep generating numeric ids');
		await commitCatalog(Keyless);
		assertStaysKeyless(databases.test[tableName], tableName);

		delete databases.test[tableName];
		resetDatabases();
		const Reloaded = getDatabases().test[tableName];
		assert.strictEqual(Reloaded.primaryKey, undefined);
		assert(!Reloaded.attributes.some((attribute) => attribute.isPrimaryKey));
		assert.strictEqual((await Reloaded.get(createdId))?.name, 'after the declaration');
	});

	it('reports a peer definition that declares a key on a keyless table, and ignores the key', async function () {
		const tableName = 'KeylessPeerDeclared3225';
		const Keyless = table({ table: tableName, database: 'test', schemaDefined: true, attributes: [{ name: 'name' }] });
		await Keyless.post({ name: 'existing' });
		const warnings = await withStorageLines('warn', () =>
			table({
				table: tableName,
				database: 'test',
				origin: 'cluster',
				attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }, { name: 'name' }],
			})
		);
		const attributed = warnings.filter((line) => line.includes(`test.${tableName}.id`));
		assert.strictEqual(
			attributed.length,
			1,
			`expected one warning for ${tableName}; captured:\n${warnings.join('\n')}`
		);
		assert(attributed[0].includes('Ignoring peer redefinition'), attributed[0]);
		assert.strictEqual(databases.test[tableName].primaryKey, undefined);
		assert(!databases.test[tableName].attributes.some((attribute) => attribute.isPrimaryKey));
		assert.strictEqual(typeof databases.test[tableName].getNewId(), 'number');
	});

	it('completes an interrupted drop of a table whose bare row lacks isPrimaryKey', async function () {
		const tableName = 'KeylessInterruptedDrop3225';
		const Keyless = table({ table: tableName, database: 'test', schemaDefined: true, attributes: [{ name: 'name' }] });
		await Keyless.post({ name: 'dropped' });
		const catalog = Keyless.dbisDB;
		const bareKey = `${tableName}/`;
		const tombstone = { ...catalog.getSync(bareKey), dropping: true };
		delete tombstone.isPrimaryKey;
		delete tombstone.is_hash_attribute;
		catalog.putSync(bareKey, tombstone);
		await commitCatalog(Keyless);

		delete databases.test[tableName];
		resetDatabases();
		assert.strictEqual(getDatabases().test[tableName], undefined, 'a dropping table must not load');
		assert.strictEqual(catalog.getSync(bareKey), undefined, 'the interrupted drop must remove the bare row');
		assert.strictEqual(catalog.getSync(`${tableName}/name`), undefined, 'the interrupted drop must remove every row');

		const Recreated = table({
			table: tableName,
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'name' }],
		});
		const records = [];
		for (const entry of Recreated.primaryStore.getRange({ start: true })) records.push(entry);
		assert.deepStrictEqual(records, [], 'the recreated table must not inherit the dropped records');
	});
});
