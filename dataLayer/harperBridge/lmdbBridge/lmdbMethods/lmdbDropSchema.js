'use strict';

const fs = require('fs-extra');
const SearchObject = require('../../../SearchObject.js');
const SearchByHashObject = require('../../../SearchByHashObject.js');
const DeleteObject = require('../../../DeleteObject.js');
const dropTable = require('./lmdbDropTable.js');
const deleteRecords = require('./lmdbDeleteRecords.js');
const getDataByHash = require('./lmdbGetDataByHash.js');
const searchDataByValue = require('./lmdbSearchByValue.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const { handleHDBError, hdbErrors } = require('../../../../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

module.exports = lmdbDropSchema;

/**
 * deletes all environment files under the schema folder, deletes all schema/table/attribute meta data from system
 * @param dropSchemaObj
 */
async function lmdbDropSchema(dropSchemaObj) {
	let deleteSchema;

	try {
		deleteSchema = await validateDropSchema(dropSchemaObj.schema);

		//We search in system > hdbTable for tables with the schema to ensure we are deleting all schema datastores
		const tableSearchObj = new SearchObject(
			hdbTerms.SYSTEM_SCHEMA_NAME,
			hdbTerms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
			hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
			deleteSchema,
			undefined,
			[hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]
		);

		let tables = Array.from(await searchDataByValue(tableSearchObj));

		for (let x = 0; x < tables.length; x++) {
			const deleteTableObj = {
				schema: deleteSchema,
				table: tables[x].name,
			};
			try {
				await dropTable(deleteTableObj);
			} catch (e) {
				//this message would get thrown for an environment that doesn't exist
				if (e.message !== 'invalid environment') {
					throw e;
				}
			}
		}

		//After all tables for schema are deleted, we can delete the schema
		const deleteSchemaObj = new DeleteObject(
			hdbTerms.SYSTEM_SCHEMA_NAME,
			hdbTerms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
			[deleteSchema]
		);

		// Delete the schema from the system > hdbSchema datastore
		await deleteRecords(deleteSchemaObj);
		let schemaPath = getSchemaPath(deleteSchema);
		await fs.remove(schemaPath);
	} catch (err) {
		throw err;
	}
}

async function validateDropSchema(dropSchema) {
	let searchObj = new SearchByHashObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
		[dropSchema],
		[hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]
	);

	let searchResult;
	let deleteSchema;

	try {
		searchResult = Array.from(await getDataByHash(searchObj));
	} catch (err) {
		throw err;
	}

	// Data found by the search function should match the dropSchema
	for (let [, schema] of searchResult) {
		if (schema.name === dropSchema) {
			deleteSchema = dropSchema;
		}
	}

	if (!deleteSchema) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(dropSchema),
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	return deleteSchema;
}
