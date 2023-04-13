'use strict';
import * as LMDBBridge from './lmdbBridge/LMDBBridge';
import * as search_validator from '../../validation/searchValidator';
import { handleHDBError, hdb_errors } from '../../utility/errors/hdbError';
import { Resource } from '../../resources/Resource';
import { table, getDatabases, database } from '../../resources/tableLoader';
import * as insertUpdateValidate from './bridgeUtility/insertUpdateValidate';
import * as lmdbProcessRows from './lmdbBridge/lmdbUtility/lmdbProcessRows';
import * as hdb_terms from '../../utility/hdbTerms';
import * as lmdb_check_new_attributes from './lmdbBridge/lmdbUtility/lmdbCheckForNewAttributes';
import * as write_transaction from './lmdbBridge/lmdbUtility/lmdbWriteTransaction';
import * as logger from '../../utility/logging/harper_logger';
import * as SearchObject from '../SearchObject';
const { HDB_ERROR_MSGS } = hdb_errors;
const DEFAULT_DATABASE = 'data';
/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all our RAPI methods are
 * implemented
 */
export class ResourceBridge extends LMDBBridge {
	async searchByConditions(search_object) {
		const validation_error = search_validator(search_object, 'conditions');
		if (validation_error) {
			throw handleHDBError(validation_error, validation_error.message, 400, undefined, undefined, true);
		}

		//set the operator to always be lowercase for later evaluations
		search_object.operator = search_object.operator ? search_object.operator.toLowerCase() : undefined;

		search_object.offset = Number.isInteger(search_object.offset) ? search_object.offset : 0;
		const resource_snapshot = new Resource();
		const records = resource_snapshot
			.useTable(search_object.table, search_object.schema)
			.get(search_object, search_object);
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
		const attributes = table_create_obj.attributes || [
			{ name: table_create_obj.hash_attribute, isPrimaryKey: true },
			// TODO: __createdtime__, __updatedtime__
		];
		for (const attribute of attributes) {
			if (attribute.name === table_create_obj.hash_attribute) attribute.isPrimaryKey = true;
		}
		return table({
			database: table_create_obj.schema,
			table: table_create_obj.table,
			attributes,
		});
	}
	async createSchema(create_schema_obj) {
		return database({
			database: create_schema_obj.schema,
			table: create_schema_obj.table,
		});
	}

	async createRecords(insert_obj) {
		const { schema_table, attributes } = insertUpdateValidate(insert_obj);

		lmdbProcessRows(insert_obj, attributes, schema_table.primaryKey);

		let new_attributes;
		if (insert_obj.auto_generate_indices)
			new_attributes = await lmdb_check_new_attributes(insert_obj.hdb_auth_header, schema_table, attributes);
		const Table = getDatabases()[insert_obj.schema][insert_obj.table];
		const txn = Table.startTransaction();
		const put_options = {
			timestamp: insert_obj.__origin?.timestamp,
		};
		const keys = [];
		for (const record of insert_obj.records) {
			txn.put(record[Table.primaryKey], record, put_options);
			keys.push(record[Table.primaryKey]);
		}
		const results = await txn.commit();
		return {
			txn_time: results.txnTime,
			written_hashes: keys,
			new_attributes,
			skipped_hashes: [],
		};
	}

	async updateRecords(update_obj) {
		update_obj.requires_existing = true;
		return this.upsertRecords(update_obj);
	}
	async insertRecords(update_obj) {
		update_obj.requires_no_existing = true;
		return this.upsertRecords(update_obj);
	}
	async upsertRecords(upsert_obj) {
		const { schema_table, attributes } = insertUpdateValidate(upsert_obj);

		lmdbProcessRows(upsert_obj, attributes, schema_table.primaryKey);

		let new_attributes;
		if (upsert_obj.auto_generate_indices)
			new_attributes = await lmdb_check_new_attributes(upsert_obj.hdb_auth_header, schema_table, attributes);
		const Table = getDatabases()[upsert_obj.schema][upsert_obj.table];
		const txn = Table.startTransaction();
		const put_options = {
			timestamp: upsert_obj.__origin?.timestamp,
		};
		const keys = [];
		const skipped = [];
		for (const record of upsert_obj.records) {
			if (
				(upsert_obj.requires_existing && !txn.get(record[Table.primaryKey])) ||
				(upsert_obj.requires_no_existing && txn.get(record[Table.primaryKey]))
			) {
				skipped.push(record[Table.primaryKey]);
				continue;
			}
			txn.put(record[Table.primaryKey], record, put_options);
			keys.push(record[Table.primaryKey]);
		}
		const results = await txn.commit();
		const response = {
			txn_time: results.txnTime,
			written_hashes: keys,
			new_attributes,
			skipped_hashes: skipped,
		};
		console.log('wrote records', upsert_obj.records, results);
		try {
			await write_transaction(upsert_obj, response);
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return response;
	}
	/**
	 * fetches records by their hash values and returns an Array of the results
	 * @param {SearchByHashObject} search_object
	 */
	async searchByHash(search_object) {
		const table_txn = getTable(search_object).startTransaction();
		let select = search_object.get_attributes;
		if (select[0] === '*') select = table_txn.attributes.map((attribute) => attribute.name);
		try {
			return (
				await Promise.all(
					search_object.hash_values.map(async (key) => {
						const record = await table_txn.get(key, { lazy: Boolean(select) });
						if (record) {
							const reduced_record = {};
							for (const property of select) {
								reduced_record[property] = record[property] ?? null;
							}
							return reduced_record;
						}
					})
				)
			).filter((record) => record);
		} finally {
			table_txn.commit();
		}
	}

	async searchByValue(search_object: SearchObject) {
		const table = getTable(search_object);
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
		return table.get({
			limit: search_object.limit,
			offset: search_object.offset,
			conditions,
		});
	}
	async getDataByValue(search_object: SearchObject) {
		const map = new Map();
		const table = getTable(search_object);
		for (const record of await this.searchByValue(search_object)) {
			map.set(record[table.primaryKey], record);
		}
		return map;
	}
	resetReadTxn(schema, table) {
		getTable({ schema, table }).primaryStore.resetReadTxn();
	}
}

function getTable(operation_object) {
	const database_name = operation_object.database || operation_object.schema || DEFAULT_DATABASE;
	const tables = getDatabases()[database_name];
	if (!tables) throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(database_name), 404);
	return tables[operation_object.table];
}
