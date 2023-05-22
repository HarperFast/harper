'use strict';

const schema_describe = require('../dataLayer/schemaDescribe');
const { hdb_errors } = require('../utility/errors/hdbError');
const { getDatabases } = require('../resources/tableLoader');

module.exports = {
	checkSchemaExists,
	checkSchemaTableExists,
	schema_describe,
};

/**
 * Checks the global hdb_schema for a schema and table
 * @param schema_name
 * @param table_name
 * @returns string returns a thrown message if schema and or table does not exist
 */
async function checkSchemaExists(schema_name) {
	let databases = getDatabases();
	if (!databases[schema_name]) {
		return hdb_errors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema_name);
	}
}

/**
 * Checks the global hdb_schema for a schema and table
 * @param schema_name
 * @param table_name
 * @returns string returns a thrown message if schema and or table does not exist
 */
async function checkSchemaTableExists(schema_name, table_name) {
	let invalid_schema = await checkSchemaExists(schema_name);
	if (invalid_schema) {
		return invalid_schema;
	}
	let databases = getDatabases();

	if (!databases[schema_name][table_name]) {
		return hdb_errors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema_name, table_name);
	}
}
