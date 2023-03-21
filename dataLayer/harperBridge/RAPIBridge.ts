'use strict';
import * as LMDBBridge from './lmdbBridge/LMDBBridge';
import * as search_validator from '../../validation/searchValidator';
import { handleHDBError, hdb_errors } from '../../utility/errors/hdbError';
import { Resource } from '../../resources/Resource';
import { table, getDatabases } from '../../resources/tableLoader';
import * as insertUpdateValidate from './bridgeUtility/insertUpdateValidate';
import * as lmdbProcessRows from './lmdbBridge/lmdbUtility/lmdbProcessRows';
import * as hdb_terms from '../../utility/hdbTerms';
import * as lmdb_check_new_attributes from './lmdbBridge/lmdbUtility/lmdbCheckForNewAttributes';
import * as write_transaction from './lmdbBridge/lmdbUtility/lmdbWriteTransaction';
import * as logger from '../../utility/logging/harper_logger';
import * as SearchObject from '../SearchObject';
const { HTTP_STATUS_CODES } = hdb_errors;
/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all our RAPI methods are
 * implemented
 */
export class RAPIBridge extends LMDBBridge {
	async searchByConditions(search_object) {
		const validation_error = search_validator(search_object, 'conditions');
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
		const resource_snapshot = new Resource();
		const records = resource_snapshot
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
			attributes: table_create_obj.attributes,
		});
	}

	async createRecords(insert_obj) {
		const { schema_table, attributes } = insertUpdateValidate(insert_obj);

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
		const Table = getDatabases()[insert_obj.schema][insert_obj.table];
		const txn = new Table();
		const put_options = {
			timestamp: insert_obj.__origin?.timestamp,
		};
		const keys = [];
		for (const record of insert_obj.records) {
			txn.put(record[insert_obj.hash_attribute], record, put_options);
			keys.push(record[insert_obj.hash_attribute]);
		}
		const results = (await txn.commit())[0];
		const response = {
			txn_time: results.txnTime,
			written_hashes: keys,
			new_attributes,
			skipped_hashes: [],
		};
		try {
			await write_transaction(insert_obj, response);
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return response;
	}

	async upsertRecords(upsert_obj) {
		const { schema_table, attributes } = insertUpdateValidate(upsert_obj);

		lmdbProcessRows(upsert_obj, attributes, schema_table.primaryKey);

		if (upsert_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
			if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
				attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
			}

			if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
				attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
			}
		}
		let new_attributes;
		if (upsert_obj.auto_generate_indices)
			new_attributes = await lmdb_check_new_attributes(upsert_obj.hdb_auth_header, schema_table, attributes);
		const Table = getDatabases()[upsert_obj.schema][upsert_obj.table];
		const txn = new Table.Collection();
		const put_options = {
			timestamp: upsert_obj.__origin?.timestamp,
		};
		const keys = [];
		for (const record of upsert_obj.records) {
			txn.put(record[Table.primaryKey], record, put_options);
			keys.push(record[Table.primaryKey]);
		}
		const results = (await txn.commit())[0];
		const response = {
			txn_time: results.txnTime,
			written_hashes: keys,
			new_attributes,
			skipped_hashes: [],
		};
		try {
			await write_transaction(upsert_obj, response);
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return response;
	}

	async searchByValue(search_object: SearchObject) {
		const schema = getDatabases()[search_object.schema || 'data'];
		// TODO: fix validation/errors
		if (!schema) throw new Error('no schema');
		const table = schema[search_object.table];
		if (!table) throw new Error('no table');
		const table_txn = new table.Collection();
		const conditions =
			search_object.search_value == '*'
				? []
				: [
						{
							attribute: search_object.search_attribute,
							value: search_object.search_value,
							get_attributes: search_object.get_attributes,
						},
				  ];
		return table_txn.search({
			limit: search_object.limit,
			offset: search_object.offset,
			conditions,
		});
	}
}
