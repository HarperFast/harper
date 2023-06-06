'use strict';
import LMDBBridge from './lmdbBridge/LMDBBridge';
import search_validator from '../../validation/searchValidator';
import { handleHDBError, ClientError, hdb_errors } from '../../utility/errors/hdbError';
import { CONTEXT_PROPERTY, Resource, USER_PROPERTY } from '../../resources/Resource';
import { table, getDatabases, database, dropDatabase } from '../../resources/databases';
import insertUpdateValidate from './bridgeUtility/insertUpdateValidate';
import lmdbProcessRows from './lmdbBridge/lmdbUtility/lmdbProcessRows';
import * as write_transaction from './lmdbBridge/lmdbUtility/lmdbWriteTransaction';
import * as logger from '../../utility/logging/harper_logger';
import SearchObject from '../SearchObject';
import { OPERATIONS_ENUM } from '../../utility/hdbTerms';
import { SEARCH_TYPES } from '../../utility/lmdb/terms';
import * as signalling from '../../utility/signalling';
import { SchemaEventMsg } from '../../server/threads/itc';
import { chunkDeletes } from './lmdbBridge/lmdbMethods/lmdbDeleteRecordsBefore';
import { async_set_timeout } from '../../utility/common_utils';

const { HDB_ERROR_MSGS } = hdb_errors;
const DEFAULT_DATABASE = 'data';
const DELETE_CHUNK = 10000;
const DELETE_PAUSE_MS = 10;
let bridge: ResourceBridge;
/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all our RAPI methods are
 * implemented
 */
export class ResourceBridge extends LMDBBridge {
	constructor(props) {
		super(props);
		bridge = this;
	}

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
		table({
			database: table_create_obj.schema,
			table: table_create_obj.table,
			attributes,
			schemaDefined: schema_defined,
		});
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_TABLE, table_create_obj.schema, table_create_obj.table)
		);
	}
	async createAttribute(create_attribute_obj) {
		await getTable(create_attribute_obj).addAttribute({
			name: create_attribute_obj.attribute,
			indexed: create_attribute_obj.indexed ?? true,
		});
		return `attribute ${create_attribute_obj.schema}.${create_attribute_obj.table}.${create_attribute_obj.attribute} successfully created.`;
	}
	async dropAttribute(drop_attribute_obj) {
		await getTable(drop_attribute_obj).removeAttribute(drop_attribute_obj.attribute);
		return `successfully deleted ${drop_attribute_obj.schema}.${drop_attribute_obj.table}.${drop_attribute_obj.attribute}`;
	}
	dropTable(drop_table_object) {
		getTable(drop_table_object).dropTable();
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_TABLE, drop_table_object.schema, drop_table_object.table)
		);
	}
	createSchema(create_schema_obj) {
		database({
			database: create_schema_obj.schema,
			table: null,
		});
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_SCHEMA, create_schema_obj.schema)
		);
	}
	async dropSchema(drop_schema_obj) {
		await dropDatabase(drop_schema_obj.schema);
		signalling.signalSchemaChange(new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_SCHEMA, drop_schema_obj.schema));
	}
	async updateRecords(update_obj) {
		update_obj.requires_existing = true;
		return this.upsertRecords(update_obj);
	}
	async createRecords(update_obj) {
		update_obj.requires_no_existing = true;
		return bridge.upsertRecords(update_obj);
	}
	async upsertRecords(upsert_obj) {
		const { schema_table, attributes } = insertUpdateValidate(upsert_obj);

		lmdbProcessRows(upsert_obj, attributes, schema_table.primaryKey);

		let new_attributes;
		const Table = getDatabases()[upsert_obj.schema][upsert_obj.table];
		return Table.transact(async (txn_table) => {
			txn_table[CONTEXT_PROPERTY] = upsert_obj.request;
			txn_table[USER_PROPERTY] = upsert_obj.hdb_user;
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
				for (const key in record) {
					let value = record[key];
					if (typeof value === 'function') {
						const value_results = value([[existing_record]]);
						if (Array.isArray(value_results)) {
							value = value_results[0].func_val;
							record[key] = value;
						}
					}
				}
				if (existing_record) {
					for (const key in existing_record) {
						// if the record is missing any properties, fill them in from the existing record
						if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = existing_record[key];
					}
				}
				await txn_table.put(record[Table.primaryKey], record);
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

	async deleteRecordsBefore(delete_obj) {
		const Table = getDatabases()[delete_obj.schema][delete_obj.table];
		const created_time_prop = Table.createdTimeProperty;
		if (!created_time_prop) {
			throw new ClientError(
				`Table must have a '__createdtime__' attribute or @creationDate timestamp defined to perform this operation`
			);
		}

		let records_to_delete = await Table.search([
			{ attribute: created_time_prop, value: delete_obj.date, comparator: SEARCH_TYPES.GREATER_THAN },
		]);

		const deleted_ids = [];
		const skipped_ids = [];
		records_to_delete = Array.from(records_to_delete);

		let i = 0;
		const records_length = records_to_delete.length;
		for (const record of records_to_delete) {
			const chunk = records_to_delete.slice(i, i + DELETE_CHUNK);
			if (i % DELETE_CHUNK === 0 || records_length === i) {
				const ids = [];
				for (let x = 0, chunk_length = chunk.length; x < chunk_length; x++) {
					ids.push(chunk[x][Table.primaryKey]);
				}

				const delete_res = await this.deleteRecords({
					schema: delete_obj.schema,
					table: delete_obj.table,
					hash_values: ids,
				});
				deleted_ids.push(...delete_res.deleted_hashes);
				skipped_ids.push(...delete_res.skipped_hashes);
				await async_set_timeout(DELETE_PAUSE_MS);
			}
			i++;
		}

		// for (let i = 0, length = records_to_delete.length; i < length; i += DELETE_CHUNK) {
		// 	const chunk = records_to_delete.slice(i, i + DELETE_CHUNK);
		// 	const ids = [];
		// 	for (let x = 0, chunk_length = chunk.length; x < chunk_length; x++) {
		// 		ids.push(chunk[x][Table.primaryKey]);
		// 	}
		//
		// 	const delete_res = await this.deleteRecords({
		// 		schema: delete_obj.schema,
		// 		table: delete_obj.table,
		// 		hash_values: ids,
		// 	});
		// 	deleted_ids.push(...delete_res.deleted_hashes);
		// 	skipped_ids.push(...delete_res.skipped_hashes);
		// 	await async_set_timeout(DELETE_PAUSE_MS);
		// }

		return createDeleteResponse(deleted_ids, skipped_ids, undefined);
	}

	/**
	 * fetches records by their hash values and returns an Array of the results
	 * @param {SearchByHashObject} search_object
	 */
	searchByHash(search_object) {
		return getRecords(search_object);
	}

	/**
	 * Called by some SQL functions
	 * @param search_object
	 */
	async getDataByHash(search_object) {
		const map = new Map();
		search_object._returnKeyValue = true;
		for await (const { key, value } of getRecords(search_object, true)) {
			map.set(key, value);
		}
		return map;
	}

	searchByValue(search_object: SearchObject, comparator?) {
		const table = getTable(search_object);
		if (!table) {
			throw new ClientError(`Table ${search_object.table} not found`);
		}
		const conditions =
			search_object.search_value == '*'
				? []
				: [
						{
							attribute: search_object.search_attribute,
							value: search_object.search_value,
							comparator,
						},
				  ];
		conditions.limit = search_object.limit;
		conditions.offset = search_object.offset;
		if (search_object.get_attributes && search_object.get_attributes[0] !== '*')
			conditions.select = search_object.get_attributes;
		conditions.reverse = search_object.reverse;

		return table.search(conditions);
	}
	async getDataByValue(search_object: SearchObject, comparator) {
		const map = new Map();
		const table = getTable(search_object);
		if (
			search_object.get_attributes &&
			!search_object.get_attributes.includes(table.primaryKey) &&
			search_object.get_attributes[0] !== '*'
		)
			// ensure that we get the primary key so we can make a mapping
			search_object.get_attributes.push(table.primaryKey);
		for await (const record of this.searchByValue(search_object, comparator)) {
			map.set(record[table.primaryKey], record);
		}
		return map;
	}
	resetReadTxn(schema, table) {
		getTable({ schema, table })?.primaryStore.resetReadTxn();
	}
}

/**
 * Iterator for asynchronous getting ids from an array
 */
async function* getRecords(search_object, return_key_value?) {
	let select = search_object.get_attributes;
	const table = getTable(search_object);
	let lazy;
	if (select[0] === '*') select = table.attributes.map((attribute) => attribute.name);
	else if (select.length < 3) lazy = true;
	let txn_table;
	let resolve_txn;
	// we need to get the transaction and ensure that the transaction spans the entire duration
	// of the iteration
	table.transact(
		(txn) =>
			new Promise((resolve) => {
				txn_table = txn;
				resolve_txn = resolve;
			})
	);
	try {
		for (const id of search_object.hash_values) {
			const record = await txn_table.get(id, { lazy });
			if (record) {
				const reduced_record = {};
				for (const property of select) {
					reduced_record[property] = record[property] ?? null;
				}
				if (return_key_value) yield { key: id, value: reduced_record };
				else yield reduced_record;
			}
		}
	} finally {
		resolve_txn();
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
