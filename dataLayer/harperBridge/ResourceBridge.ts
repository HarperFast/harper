'use strict';
import * as LMDBBridge from './lmdbBridge/LMDBBridge';
import * as search_validator from '../../validation/searchValidator';
import { handleHDBError, hdb_errors } from '../../utility/errors/hdbError';
import { Resource } from '../../resources/Resource';
import { table, getDatabases, database, dropDatabase } from '../../resources/tableLoader';
import * as insertUpdateValidate from './bridgeUtility/insertUpdateValidate';
import * as lmdbProcessRows from './lmdbBridge/lmdbUtility/lmdbProcessRows';
import * as write_transaction from './lmdbBridge/lmdbUtility/lmdbWriteTransaction';
import * as logger from '../../utility/logging/harper_logger';
import * as SearchObject from '../SearchObject';
import { OPERATIONS_ENUM } from '../../utility/hdbTerms';
import * as signalling from '../../utility/signalling';
import { SchemaEventMsg } from '../../server/threads/itc';

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
		let attributes = table_create_obj.attributes;
		const schema_defined = Boolean(attributes);
		if (!attributes) {
			// legacy default schema for tables created through operations API
			attributes = [
				{ name: table_create_obj.hash_attribute, isPrimaryKey: true },
				{ name: '__createdtime__', indexed: true },
				{ name: '__updatedtime__', indexed: true },
			];
		}
		for (const attribute of attributes) {
			if (attribute.name === table_create_obj.hash_attribute) attribute.isPrimaryKey = true;
		}
		return table({
			database: table_create_obj.schema,
			table: table_create_obj.table,
			attributes,
			schemaDefined: schema_defined,
		});
	}
	dropTable(drop_table_object) {
		return getTable(drop_table_object).dropTable();
	}
	async createSchema(create_schema_obj) {
		return database({
			database: create_schema_obj.schema,
			table: null,
		});
	}
	async dropSchema(drop_schema_obj) {
		await dropDatabase(drop_schema_obj.schema);
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_TABLE, drop_schema_obj.schema);
		);
	}
	async updateRecords(update_obj) {
		update_obj.requires_existing = true;
		return this.upsertRecords(update_obj);
	}
	async createRecords(update_obj) {
		update_obj.requires_no_existing = true;
		return this.upsertRecords(update_obj);
	}
	async upsertRecords(upsert_obj) {
		const { schema_table, attributes } = insertUpdateValidate(upsert_obj);

		lmdbProcessRows(upsert_obj, attributes, schema_table.primaryKey);

		let new_attributes;
		const Table = getDatabases()[upsert_obj.schema][upsert_obj.table];
		return Table.transact(async (txn_table) => {
			if (!txn_table.schemaDefined) {
				new_attributes = [];
				for (const attribute of attributes) {
					const existing_attribute = Table.attributes.find(
						(existing_attribute) => existing_attribute.name == attribute
					);
					if (!existing_attribute) {
						await txn_table.addAttribute({
							name: attribute,
							indexed: true,
						});
						new_attributes.push(attribute);
					}
				}
			}
			const put_options = {
				timestamp: upsert_obj.__origin?.timestamp,
			};
			const keys = [];
			const skipped = [];
			for (const record of upsert_obj.records) {
				const existing_record = await txn_table.get(record[Table.primaryKey]);
				if (
					(upsert_obj.requires_existing && !existing_record) ||
					(upsert_obj.requires_no_existing && existing_record)
				) {
					skipped.push(record[Table.primaryKey]);
					continue;
				}
				for (const key in existing_record) {
					// if the record is missing any properties, fill them in from the existing record
					if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = existing_record[key];
				}
				await txn_table.put(record[Table.primaryKey], record, put_options);
				keys.push(record[Table.primaryKey]);
			}
			return {
				txn_time: txn_table.txnTime,
				written_hashes: keys,
				new_attributes,
				skipped_hashes: skipped,
			};
		});
	}
	async deleteRecords(delete_obj) {
		const Table = getDatabases()[delete_obj.schema][delete_obj.table];
		return Table.transact(async (txn_table) => {
			const ids = delete_obj.hash_values || delete_obj.records.map((record) => record[Table.primaryKey]);
			const deleted = [];
			const skipped = [];
			for (const id of ids) {
				if (await txn_table.delete(id)) deleted.push(id);
				else skipped.push(id);
			}
			return createDeleteResponse(deleted, skipped, txn_table.txnTime);
		});
	}
	/**
	 * fetches records by their hash values and returns an Array of the results
	 * @param {SearchByHashObject} search_object
	 */
	searchByHash(search_object) {
		return getTable(search_object).transactSync((txn_table) => {
			let select = search_object.get_attributes;
			if (select[0] === '*') select = txn_table.attributes.map((attribute) => attribute.name);
			return search_object.hash_values
				.map(async (key) => {
					const record = await txn_table.get(key, { lazy: Boolean(select) });
					if (record) {
						const reduced_record = {};
						for (const property of select) {
							reduced_record[property] = record[property] ?? null;
						}
						return reduced_record;
					}
				})
				.filter((record) => record);
		});
	}

	/**
	 * Called by some SQL functions
	 * @param search_object
	 */
	async getDataByHash(search_object) {
		const map = new Map();
		const table = getTable(search_object);
		for await (const record of this.searchByHash(search_object)) {
			map.set(record[table.primaryKey], record);
		}
		return map;
	}

	searchByValue(search_object: SearchObject) {
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
		return table.search({
			limit: search_object.limit,
			offset: search_object.offset,
			conditions,
		});
	}
	async getDataByValue(search_object: SearchObject) {
		const map = new Map();
		const table = getTable(search_object);
		for await (const record of this.searchByValue(search_object)) {
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
/**
 * creates the response object for deletes based on the deleted & skipped hashes
 * @param {[]} deleted - list of hash values successfully deleted
 * @param {[]} skipped - list  of hash values which did not get deleted
 * @param {number} txn_time - the transaction timestamp
 * @returns {{skipped_hashes: [], deleted_hashes: [], message: string}}
 */
function createDeleteResponse(deleted, skipped, txn_time) {
	const total = deleted.length + skipped.length;
	const plural = total === 1 ? 'record' : 'records';

	return {
		message: `${deleted.length} of ${total} ${plural} successfully deleted`,
		deleted_hashes: deleted,
		skipped_hashes: skipped,
		txn_time: txn_time,
	};
}
