'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_create_records = require('./lmdbCreateRecords');
const InsertObject = require('../../../InsertObject');
const fs = require('fs-extra');
const { getSchemaPath } = require('../lmdbUtility/initializePaths');

module.exports = lmdbCreateSchema;

/**
 * creates the meta data for the schema
 * @param create_schema_obj
 */
async function lmdbCreateSchema(create_schema_obj) {
	let records = [
		{
			name: create_schema_obj.schema,
			createddate: Date.now(),
		},
	];
	let insert_object = new InsertObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
		undefined,
		records
	);

	await lmdb_create_records(insert_object);
	await fs.mkdirp(getSchemaPath(create_schema_obj.schema));
}
