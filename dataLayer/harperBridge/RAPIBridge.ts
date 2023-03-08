'use strict';
import * as LMDBBridge from './lmdbBridge/LMDBBridge';
import * as search_validator from '../../validation/searchValidator';
import { handleHDBError, hdb_errors } from '../../utility/errors/hdbError';
import { Resource } from '../../resources/Resource';
import { table } from '../../resources/database';
import * as insertUpdateValidate from './bridgeUtility/insertUpdateValidate';
import * as lmdbProcessRows from './lmdbBridge/lmdbUtility/lmdbProcessRows';
import * as hdb_terms from '../../utility/hdbTerms';
import * as lmdb_check_new_attributes from './lmdbBridge/lmdbUtility/lmdbCheckForNewAttributes';
import * as write_transaction from './lmdbBridge/lmdbUtility/lmdbWriteTransaction';
import * as logger from '../../utility/logging/harper_logger';
const { HTTP_STATUS_CODES } = hdb_errors;
/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all our RAPI methods are
 * implemented
 */
export class RAPIBridge extends LMDBBridge {
	async searchByConditions(search_object) {
		let validation_error = search_validator(search_object, 'conditions');
		if (validation_error) {
			throw handleHDBError(
				validation_error,
				validation_error.message,
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}

		//set the operator to always be lowercase for later evaluations
		search_object.operator = search_object.operator ? search_object.operator.toLowerCase() : undefined;

		search_object.offset = Number.isInteger(search_object.offset) ? search_object.offset : 0;
		let resource_snapshot = new Resource();
		let records = resource_snapshot
			.useTable(search_object.table, search_object.schema)
			.search(search_object, search_object);
		records.onDone = () => resource_snapshot.doneReading();
		return records;
	}
	/**
	 * Writes new table data to the system tables creates the environment file and creates two datastores to track created and updated
	 * timestamps for new table data.
	 * @param table_system_data
	 * @param table_create_obj
	 */
	async createTable(table_system_data, table_create_obj) {
		return table({
			database: table_create_obj.schema,
			table: table_create_obj.table,
			attributes: [
				{
					name: table_create_obj.hash_attribute,
					is_primary_key: true,
				},
			],
		});
	}

	async createRecords(insert_obj) {
		let {schema_table, attributes} = insertUpdateValidate(insert_obj);

		lmdbProcessRows(insert_obj, attributes, schema_table.primaryKey);

		if (insert_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
			if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
				attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
			}

			if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
				attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
			}
		}
		let new_attributes;
		if (insert_obj.auto_generate_indices)
			new_attributes = await lmdb_check_new_attributes(insert_obj.hdb_auth_header, schema_table, attributes);
		let Table = await table({database: insert_obj.schema, table: insert_obj.table});
		let txn = new Table();
		let put_options = {
			timestamp: insert_obj.__origin?.timestamp
		}
		let keys = [];
		for (let record of insert_obj.records) {
			txn.put(record[schema_table.hash_attribute], record, put_options);
			keys.push(record[schema_table.hash_attribute]);
		}
		let results = (await txn.commit())[0];
		let response = {
			txn_time: results.txnTime,
			written_hashes: keys,
			new_attributes,
			skipped_hashes: [],
		}
		try {
			await write_transaction(insert_obj, response);
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return response;
	}
}
