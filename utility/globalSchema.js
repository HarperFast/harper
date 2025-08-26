const systemSchema = require('../json/systemSchema.json');
const { promisify } = require('util');
const { getDatabases } = require('../resources/databases.ts');

module.exports = {
	setSchemaDataToGlobal,
	getTableSchema,
	getSystemSchema,
	setSchemaDataToGlobalAsync: promisify(setSchemaDataToGlobal),
};

function setSchemaDataToGlobal(callback) {
	global.hdb_schema = getDatabases();
	if (callback) callback();
}

function getTableSchema(schemaName, tableName, callback) {
	const database = getDatabases()[schemaName];
	if (!database) {
		return callback(`schema ${schemaName} does not exist`);
	}
	const table = database[tableName];
	if (!table) {
		return callback(`table ${schemaName}.${tableName} does not exist`);
	}
	return callback(null, {
		schema: schemaName,
		name: tableName,
		hash_attribute: table.primaryKey,
	});
}

function getSystemSchema() {
	return systemSchema;
}
