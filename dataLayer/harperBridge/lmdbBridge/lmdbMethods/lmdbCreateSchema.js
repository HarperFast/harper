'use strict';

const hdbTerms = require('../../../../utility/hdbTerms.ts');
const lmdbCreateRecords = require('./lmdbCreateRecords.js');
const InsertObject = require('../../../InsertObject.js');
const fs = require('fs-extra');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');

module.exports = lmdbCreateSchema;

/**
 * creates the meta data for the schema
 * @param createSchemaObj
 */
async function lmdbCreateSchema(createSchemaObj) {
	let records = [
		{
			name: createSchemaObj.schema,
			createddate: Date.now(),
		},
	];
	let insertObject = new InsertObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
		undefined,
		records
	);

	await lmdbCreateRecords(insertObject);
	await fs.mkdirp(getSchemaPath(createSchemaObj.schema));
}
