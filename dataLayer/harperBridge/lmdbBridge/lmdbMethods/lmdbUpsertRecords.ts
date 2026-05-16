// eslint-disable-next-line no-unused-vars
const UpsertObject =
	require('../../../dataObjects/UpsertObject.ts').default || require('../../../dataObjects/UpsertObject.ts');
import insertUpdateValidate from '../../bridgeUtility/insertUpdateValidate.ts';
import lmdbProcessRows from '../lmdbUtility/lmdbProcessRows.ts';
import lmdbCheckNewAttributes from '../lmdbUtility/lmdbCheckForNewAttributes.ts';
import * as hdbTerms from '../../../../utility/hdbTerms.ts';
import { upsertRecords as lmdb_upsert_records } from '../../../../utility/lmdb/writeUtility.ts';
import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.ts';
import { getSchemaPath } from '../lmdbUtility/initializePaths.ts';
import writeTransaction from '../lmdbUtility/lmdbWriteTransaction.ts';

import logger from '../../../../utility/logging/harper_logger.ts';
import { handleHDBError, hdbErrors } from '../../../../utility/errors/hdbError.ts';

export default lmdbUpsertRecords;

/**
 * Orchestrates the UPSERT of data in LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param {UpsertObject} upsertObj
 * @returns {{ skipped_hashes: *, written_hashes: *, schema_table: *, new_attributes: *, txn_time: * }}
 */
async function lmdbUpsertRecords(upsertObj) {
	let validationResult;
	try {
		validationResult = insertUpdateValidate(upsertObj);
	} catch (err) {
		throw handleHDBError(err, err.message, hdbErrors.HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	let { schemaTable, attributes } = validationResult;

	lmdbProcessRows(upsertObj, attributes, schemaTable.hash_attribute);

	if (upsertObj.schema !== hdbTerms.SYSTEM_SCHEMA_NAME) {
		if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
			attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
		}

		if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
			attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
		}
	}

	let new_attributes = await lmdbCheckNewAttributes(upsertObj.hdb_auth_header, schemaTable, attributes);
	let envBasePath = getSchemaPath(upsertObj.schema, upsertObj.table);
	let environment = await environmentUtility.openEnvironment(envBasePath, upsertObj.table);
	let lmdbResponse = await lmdb_upsert_records(
		environment,
		schemaTable.hash_attribute,
		attributes,
		upsertObj.records,
		upsertObj.__origin?.timestamp
	);

	try {
		await writeTransaction(upsertObj, lmdbResponse);
	} catch (e) {
		logger.error(`unable to write transaction due to ${e.message}`);
	}

	return {
		written_hashes: lmdbResponse.written_hashes,
		schemaTable,
		new_attributes,
		txn_time: lmdbResponse.txn_time,
	};
}
