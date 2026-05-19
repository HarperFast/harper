'use strict';

export const schemaDescribe = require('../dataLayer/schemaDescribe');
import { hdbErrors } from '../utility/errors/hdbError.ts';
import { getDatabases } from '../resources/databases.ts';

/**
 * Checks the global hdbSchema for a schema and table
 * @param schemaName
 * @param tableName
 * @returns string returns a thrown message if schema and or table does not exist
 */
export async function checkSchemaExists(schemaName) {
	let databases = getDatabases();
	if (!databases[schemaName]) {
		return hdbErrors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schemaName);
	}
}

/**
 * Checks the global hdbSchema for a schema and table
 * @param schemaName
 * @param tableName
 * @returns string returns a thrown message if schema and or table does not exist
 */
export async function checkSchemaTableExists(schemaName, tableName) {
	let invalidSchema = await checkSchemaExists(schemaName);
	if (invalidSchema) {
		return invalidSchema;
	}
	let databases = getDatabases();

	if (!databases[schemaName][tableName]) {
		return hdbErrors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schemaName, tableName);
	}
}
