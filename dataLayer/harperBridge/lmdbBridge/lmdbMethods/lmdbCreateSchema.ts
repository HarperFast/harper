'use strict';;
import * as hdbTerms from '../../../../utility/hdbTerms.js';
import * as lmdbCreateRecords from './lmdbCreateRecords.js';
import * as InsertObject from '../../../InsertObject.js';
import fs from 'fs-extra';
import { getSchemaPath } from '../lmdbUtility/initializePaths.js';
export default lmdbCreateSchema;

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
