'use strict';

import * as schemaDescribe from '../dataLayer/schemaDescribe.js';
import { hdbErrors } from '../utility/errors/hdbError.js';
import { getDatabases } from '../resources/databases.js';

export {
	checkSchemaExists,
	checkSchemaTableExists,
	schemaDescribe,
};

/**
 * Checks the global hdbSchema for a schema and table
 * @param schemaName
 * @param tableName
 * @returns string returns a thrown message if schema and or table does not exist
 */
async function checkSchemaExists(schemaName: string): Promise<string | undefined> {
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
async function checkSchemaTableExists(schemaName: string, tableName: string): Promise<string | undefined> {
	let invalidSchema = await checkSchemaExists(schemaName);
	if (invalidSchema) {
		return invalidSchema;
	}
	let databases = getDatabases();

	if (!databases[schemaName][tableName]) {
		return hdbErrors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schemaName, tableName);
	}
}
