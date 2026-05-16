import * as hdbTerms from '../../../../utility/hdbTerms.ts';
import lmdbCreateRecords from './lmdbCreateRecords.ts';
import InsertObject from '../../../InsertObject.ts';
import fs from 'fs-extra';
import { getSchemaPath } from '../lmdbUtility/initializePaths.ts';

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
