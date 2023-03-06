'use strict';

const schema_describe = require('../dataLayer/schemaDescribe');
const { hdb_errors } = require('../utility/errors/hdbError');

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
	if (!global.hdb_schema[schema_name]) {
		try {
			let the_schema = await schema_describe.describeSchema({ schema: schema_name });
			global.hdb_schema[schema_name] = the_schema;
		} catch (e) {
			return hdb_errors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema_name);
		}
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

	if (!global.hdb_schema[schema_name][table_name]) {
		try {
			let the_table = await schema_describe.describeTable({ schema: schema_name, table: table_name });
			if (!the_table || Object.keys(the_table).length === 0) {
				return hdb_errors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema_name, table_name);
			}

			global.hdb_schema[schema_name][table_name] = the_table;
		} catch (e) {
			return hdb_errors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema_name, table_name);
		}
	}
}
