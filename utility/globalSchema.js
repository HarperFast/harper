const system_schema = require('../json/systemSchema.json');
const { promisify } = require('util');
const { getDatabases } = require('../resources/databases');

module.exports = {
	setSchemaDataToGlobal: setSchemaDataToGlobal,
	getTableSchema: getTableSchema,
	getSystemSchema: getSystemSchema,
	setSchemaDataToGlobalAsync: promisify(setSchemaDataToGlobal),
};

function setSchemaDataToGlobal(callback) {
	global.hdb_schema = getDatabases();
	if (callback) callback();
}

function getTableSchema(schema_name, table_name, callback) {
	const database = getDatabases()[schema_name];
	if (!database) {
		return callback(`schema ${schema_name} does not exist`);
	}
	const table = database[table_name];
	if (!table) {
		return callback(`table ${schema_name}.${table_name} does not exist`);
	}
	return callback(null, {
		schema: schema_name,
		name: table_name,
		hash_attribute: table.primaryKey,
	});
}

function getSystemSchema() {
	return system_schema;
}
