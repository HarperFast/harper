import insertUpdateValidate from '../../bridgeUtility/insertUpdateValidate.ts';
// eslint-disable-next-line no-unused-vars
import InsertObject from '../../../InsertObject.ts';
import * as hdbTerms from '../../../../utility/hdbTerms.ts';
import lmdbProcessRows from '../lmdbUtility/lmdbProcessRows.ts';
import { insertRecords as lmdbInsertRecords } from '../../../../utility/lmdb/writeUtility.ts';
import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.ts';
import logger from '../../../../utility/logging/harper_logger.ts';

import lmdbCheckNewAttributes from '../lmdbUtility/lmdbCheckForNewAttributes.ts';
import { getSchemaPath } from '../lmdbUtility/initializePaths.ts';
import writeTransaction from '../lmdbUtility/lmdbWriteTransaction.ts';

export default lmdbCreateRecords;

/**
 * Orchestrates the insertion of data into LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param {InsertObject} insertObj
 * @returns {Promise<{skipped_hashes: *, written_hashes: *, schema_table: *}>}
 */
async function lmdbCreateRecords(insertObj) {
	try {
		let { schema_table: schemaTable, attributes } = insertUpdateValidate(insertObj);

		lmdbProcessRows(insertObj, attributes, schemaTable.hash_attribute);

		if (insertObj.schema !== hdbTerms.SYSTEM_SCHEMA_NAME) {
			if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
				attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
			}

			if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
				attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
			}
		}

		let new_attributes = await lmdbCheckNewAttributes(insertObj.hdb_auth_header, schemaTable, attributes);
		let envBasePath = getSchemaPath(insertObj.schema, insertObj.table);
		let environment = await environmentUtility.openEnvironment(envBasePath, insertObj.table);
		let lmdbResponse = await lmdbInsertRecords(
			environment,
			schemaTable.hash_attribute,
			attributes,
			insertObj.records,
			insertObj.__origin?.timestamp
		);

		try {
			await writeTransaction(insertObj, lmdbResponse);
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return {
			written_hashes: lmdbResponse.written_hashes,
			skipped_hashes: lmdbResponse.skipped_hashes,
			schemaTable,
			new_attributes,
			txn_time: lmdbResponse.txn_time,
		};
	} catch (err) {
		throw err;
	}
}
