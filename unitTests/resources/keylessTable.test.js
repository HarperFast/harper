// Tables with no primary key (harper#3225): a bare `<table>/` catalog row that lacks isPrimaryKey must
// still load as the table's primary store, and a schema that declares a key on a keyless table must
// leave it keyless instead of failing the schema.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, getDatabases, resetDatabases, table } = require('#src/resources/databases');
const { forComponent } = require('#src/utility/logging/harper_logger');

async function commitCatalog(Table) {
	if (Table.dbisDB.committed) await Table.dbisDB.committed;
}

async function withStorageErrors(callback) {
	const storageLogger = forComponent('storage');
	const originalError = storageLogger.error;
	const errorLines = [];
	storageLogger.error = (...args) => errorLines.push(args.map(String).join(' '));
	try {
		await callback();
	} finally {
		storageLogger.error = originalError;
	}
	return errorLines;
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

		const errorLines = await withStorageErrors(() => loadGQLSchema(declared));
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
});
