'use strict';
import LMDBBridge from './lmdbBridge/LMDBBridge';
import search_validator from '../../validation/searchValidator';
import { handleHDBError, ClientError, hdb_errors } from '../../utility/errors/hdbError';
import { table, getDatabases, database, dropDatabase } from '../../resources/databases';
import insertUpdateValidate from './bridgeUtility/insertUpdateValidate';
import SearchObject from '../SearchObject';
import {
	OPERATIONS_ENUM,
	VALUE_SEARCH_COMPARATORS,
	VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP,
	READ_AUDIT_LOG_SEARCH_TYPES_ENUM,
} from '../../utility/hdbTerms';
import * as signalling from '../../utility/signalling';
import { SchemaEventMsg } from '../../server/threads/itc';
import { async_set_timeout } from '../../utility/common_utils';
import { transaction } from '../../resources/transaction';
import { Id } from '../../resources/ResourceInterface';
import { collapseData } from '../../resources/tracked';

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
		if (search_object.select !== undefined) search_object.get_attributes = search_object.select;
		for (const condition of search_object.conditions || []) {
			if (condition?.attribute !== undefined) condition.search_attribute = condition.attribute;
			if (condition?.comparator !== undefined) condition.search_type = condition.comparator;
			if (condition?.value !== undefined) condition.search_value = condition.value;
		}
		const validation_error = search_validator(search_object, 'conditions');
		if (validation_error) {
			throw handleHDBError(validation_error, validation_error.message, 400, undefined, undefined, true);
		}
		const table = getTable(search_object);
		if (!table) {
			throw new ClientError(`Table ${search_object.table} not found`);
		}

		const conditions = search_object.conditions.map(mapCondition);
		function mapCondition(condition) {
			if (condition.conditions) {
				condition.conditions = condition.conditions.map(mapCondition);
				return condition;
			} else
				return {
					attribute: condition.search_attribute ?? condition.attribute,
					comparator: condition.search_type ?? condition.comparator,
					value: condition.search_value !== undefined ? condition.search_value : condition.value, // null is valid value
				};
		}

		return table.search(
			{
				conditions,
				//set the operator to always be lowercase for later evaluations
				operator: search_object.operator ? search_object.operator.toLowerCase() : undefined,
				limit: search_object.limit,
				offset: search_object.offset,
				reverse: search_object.reverse,
				select: getSelect(search_object, table),
				sort: search_object.sort,
				allowFullScan: true, // operations API can do full scans by default, but REST is more cautious about what it allows
			},
			{
				onlyIfCached: search_object.onlyIfCached,
				noCacheStore: search_object.noCacheStore,
				noCache: search_object.noCache,
				replicateFrom: search_object.replicateFrom,
			}
		);
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
		const primary_key_name = table_create_obj.primary_key || table_create_obj.hash_attribute;
		if (attributes) {
			// allow for attributes to be specified, but do some massaging to make sure they are in the right form
			for (const attribute of attributes) {
				if (attribute.is_primary_key) {
					attribute.isPrimaryKey = true;
					delete attribute.is_primary_key;
				} else if (attribute.name === primary_key_name && primary_key_name) attribute.isPrimaryKey = true;
			}
		} else {
			// legacy default schema for tables created through operations API without attributes
			if (!primary_key_name)
				throw new ClientError('A primary key must be specified with a `primary_key` property or with `attributes`');
			attributes = [
				{ name: primary_key_name, isPrimaryKey: true },
				{ name: '__createdtime__', indexed: true },
				{ name: '__updatedtime__', indexed: true },
			];
		}
		table({
			database: table_create_obj.database ?? table_create_obj.schema,
			table: table_create_obj.table,
			attributes,
			schemaDefined: schema_defined,
			expiration: table_create_obj.expiration,
			audit: table_create_obj.audit,
		});
	}
	async createAttribute(create_attribute_obj) {
		await getTable(create_attribute_obj).addAttributes([
			{
				name: create_attribute_obj.attribute,
				indexed: create_attribute_obj.indexed ?? true,
			},
		]);
		return `attribute ${create_attribute_obj.schema}.${create_attribute_obj.table}.${create_attribute_obj.attribute} successfully created.`;
	}
	async dropAttribute(drop_attribute_obj) {
		const Table = getTable(drop_attribute_obj);
		await Table.removeAttributes([drop_attribute_obj.attribute]);
		if (!Table.schemaDefined) {
			// legacy behavior of deleting all the property values
			const property = drop_attribute_obj.attribute;
			let resolution;
			const deleteRecord = (key, record, version): Promise<void> => {
				record = { ...record };
				delete record[property];
				return Table.primaryStore
					.ifVersion(key, version, () => Table.primaryStore.put(key, record, version))
					.then((success) => {
						if (!success) {
							// try again with the latest record
							const { value: record, version } = Table.primaryStore.getEntry(key);
							return deleteRecord(key, record, version);
						}
					});
			};
			for (const { key, value: record, version } of Table.primaryStore.getRange({ start: true, versions: true })) {
				resolution = deleteRecord(key, record, version);
				await new Promise((resolve) => setImmediate(resolve));
			}
			await resolution;
		}
		return `successfully deleted ${drop_attribute_obj.schema}.${drop_attribute_obj.table}.${drop_attribute_obj.attribute}`;
	}
	dropTable(drop_table_object) {
		getTable(drop_table_object).dropTable();
	}
	createSchema(create_schema_obj) {
		database({
			database: create_schema_obj.schema,
			table: null,
		});
		return signalling.signalSchemaChange(
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

		let new_attributes;
		const Table = getDatabases()[upsert_obj.schema][upsert_obj.table];
		const context = {
			user: upsert_obj.hdb_user,
			expiresAt: upsert_obj.expiresAt,
			originatingOperation: upsert_obj.operation,
		};
		if (upsert_obj.replicateTo) context.replicateTo = upsert_obj.replicateTo;
		if (upsert_obj.replicatedConfirmation) context.replicatedConfirmation = upsert_obj.replicatedConfirmation;
		return transaction(context, async (transaction) => {
			if (!Table.schemaDefined) {
				new_attributes = [];
				for (const attribute_name of attributes) {
					const existing_attribute = Table.attributes.find(
						(existing_attribute) => existing_attribute.name == attribute_name
					);
					if (!existing_attribute) {
						new_attributes.push(attribute_name);
					}
				}
				if (new_attributes.length > 0) {
					await Table.addAttributes(
						new_attributes.map((name) => ({
							name,
							indexed: true,
						}))
					);
				}
			}

			const keys = [];
			const skipped = [];
			for (const record of upsert_obj.records) {
				const id = record[Table.primaryKey];
				let existing_record = id != undefined && (await Table.get(id, context));
				if (
					(upsert_obj.requires_existing && !existing_record) ||
					(upsert_obj.requires_no_existing && existing_record)
				) {
					skipped.push(record[Table.primaryKey]);
					continue;
				}
				if (existing_record) existing_record = collapseData(existing_record);
				for (const key in record) {
					if (Object.prototype.hasOwnProperty.call(record, key)) {
						let value = record[key];
						if (typeof value === 'function') {
							try {
								const value_results = value([[existing_record]]);
								if (Array.isArray(value_results)) {
									value = value_results[0].func_val;
									record[key] = value;
								}
							} catch (error) {
								error.message += 'Trying to set key ' + key + ' on object' + JSON.stringify(record);
								throw error;
							}
						}
					}
				}
				if (existing_record) {
					for (const key in existing_record) {
						// if the record is missing any properties, fill them in from the existing record
						if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = existing_record[key];
					}
				}
				await (id == undefined ? Table.create(record, context) : Table.put(record, context));
				keys.push(record[Table.primaryKey]);
			}
			return {
				txn_time: transaction.timestamp,
				written_hashes: keys,
				new_attributes,
				skipped_hashes: skipped,
			};
		});
	}
	async deleteRecords(delete_obj) {
		const Table = getDatabases()[delete_obj.schema][delete_obj.table];
		const context = { user: delete_obj.hdb_user };
		if (delete_obj.replicateTo) context.replicateTo = delete_obj.replicateTo;
		if (delete_obj.replicatedConfirmation) context.replicatedConfirmation = delete_obj.replicatedConfirmation;
		return transaction(context, async (transaction) => {
			const ids: Id[] = delete_obj.hash_values || delete_obj.records.map((record) => record[Table.primaryKey]);
			const deleted = [];
			const skipped = [];
			for (const id of ids) {
				if (await Table.delete(id, context)) deleted.push(id);
				else skipped.push(id);
			}
			return createDeleteResponse(deleted, skipped, transaction.timestamp);
		});
	}

	/**
	 * Deletes all records in a schema.table that fall behind a passed date.
	 * @param delete_obj
	 * {
	 *     operation: 'delete_records_before' <string>,
	 *     date: ISO-8601 format YYYY-MM-DD <string>,
	 *     schema: Schema where table resides <string>,
	 *     table: Table to delete records from <string>,
	 * }
	 * @returns {undefined}
	 */
	async deleteRecordsBefore(delete_obj) {
		const Table = getDatabases()[delete_obj.schema][delete_obj.table];
		if (!Table.createdTimeProperty) {
			throw new ClientError(
				`Table must have a '__createdtime__' attribute or @createdTime timestamp defined to perform this operation`
			);
		}

		const records_to_delete = await Table.search({
			conditions: [
				{
					attribute: Table.createdTimeProperty.name,
					value: Date.parse(delete_obj.date),
					comparator: VALUE_SEARCH_COMPARATORS.LESS,
				},
			],
		});

		let delete_called = false;
		const deleted_ids = [];
		const skipped_ids = [];
		let i = 0;
		let ids = [];
		const chunkDelete = async () => {
			const delete_res = await this.deleteRecords({
				schema: delete_obj.schema,
				table: delete_obj.table,
				hash_values: ids,
			});
			deleted_ids.push(...delete_res.deleted_hashes);
			skipped_ids.push(...delete_res.skipped_hashes);
			await async_set_timeout(DELETE_PAUSE_MS);
			ids = [];
			delete_called = true;
		};

		for await (const records of records_to_delete) {
			ids.push(records[Table.primaryKey]);
			i++;
			if (i % DELETE_CHUNK === 0) {
				await chunkDelete();
			}
		}

		if (ids.length > 0) await chunkDelete();

		if (!delete_called) {
			return { message: 'No records found to delete' };
		}

		return createDeleteResponse(deleted_ids, skipped_ids, undefined);
	}

	/**
	 * fetches records by their hash values and returns an Array of the results
	 * @param {SearchByHashObject} search_object
	 */
	searchByHash(search_object) {
		if (search_object.select !== undefined) search_object.get_attributes = search_object.select;
		const validation_error = search_validator(search_object, 'hashes');
		if (validation_error) {
			throw validation_error;
		}
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
		if (comparator && VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
			throw new Error(`Value search comparator - ${comparator} - is not valid`);
		}
		if (search_object.select !== undefined) search_object.get_attributes = search_object.select;
		if (search_object.attribute !== undefined) search_object.search_attribute = condition.attribute;
		if (search_object.value !== undefined) search_object.search_value = condition.value;

		const validation_error = search_validator(search_object, 'value');
		if (validation_error) {
			throw validation_error;
		}

		const table = getTable(search_object);
		if (!table) {
			throw new ClientError(`Table ${search_object.table} not found`);
		}
		let value = search_object.search_value;
		if (value.includes?.('*')) {
			if (value.startsWith('*')) {
				if (value.endsWith('*')) {
					if (value !== '*') {
						comparator = 'contains';
						value = value.slice(1, -1);
					}
				} else {
					comparator = 'ends_with';
					value = value.slice(1);
				}
			} else if (value.endsWith('*')) {
				comparator = 'starts_with';
				value = value.slice(0, -1);
			}
		}
		if (comparator === VALUE_SEARCH_COMPARATORS.BETWEEN) value = [value, search_object.end_value];
		const conditions =
			value === '*'
				? []
				: [
						{
							attribute: search_object.search_attribute,
							value,
							comparator,
						},
					];

		return table.search(
			{
				conditions,
				allowFullScan: true,
				limit: search_object.limit,
				offset: search_object.offset,
				reverse: search_object.reverse,
				sort: search_object.sort,
				select: getSelect(search_object, table),
			},
			{
				onlyIfCached: search_object.onlyIfCached,
				noCacheStore: search_object.noCacheStore,
				noCache: search_object.noCache,
				replicateFrom: search_object.replicateFrom,
			}
		);
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
	async deleteAuditLogsBefore(delete_obj) {
		const table = getTable(delete_obj);
		return table.deleteHistory(delete_obj.timestamp, delete_obj.cleanup_deleted_records);
	}

	async readAuditLog(read_audit_log_obj) {
		const table = getTable(read_audit_log_obj);
		const histories = {};
		switch (read_audit_log_obj.search_type) {
			case READ_AUDIT_LOG_SEARCH_TYPES_ENUM.HASH_VALUE:
				// get the history of each record
				for (const id of read_audit_log_obj.search_values) {
					histories[id] = (await table.getHistoryOfRecord(id)).map((audit_record) => {
						let operation = audit_record.operation ?? audit_record.type;
						if (operation === 'put') operation = 'upsert';
						return {
							operation,
							timestamp: audit_record.version,
							user_name: audit_record.user,
							hash_values: [id],
							records: [audit_record.value],
						};
					});
				}
				return histories;
			case READ_AUDIT_LOG_SEARCH_TYPES_ENUM.USERNAME:
				const users = read_audit_log_obj.search_values;
				// do a full table scan of the history and find users
				for await (const entry of groupRecordsInHistory(table)) {
					if (users.includes(entry.user_name)) {
						const entries_for_user = histories[entry.user_name] || (histories[entry.user_name] = []);
						entries_for_user.push(entry);
					}
				}
				return histories;
			default:
				return groupRecordsInHistory(
					table,
					read_audit_log_obj.search_values?.[0],
					read_audit_log_obj.search_values?.[1],
					read_audit_log_obj.limit
				);
		}
	}
}

function getSelect({ get_attributes }, table) {
	if (get_attributes) {
		if (get_attributes[0] === '*') {
			if (table.schemaDefined) return;
			else get_attributes = table.attributes.map((attribute) => attribute.name);
		}
		get_attributes.forceNulls = true;
		return get_attributes;
	}
}
/**
 * Iterator for asynchronous getting ids from an array
 */
function getRecords(search_object, return_key_value?) {
	const table = getTable(search_object);
	const select = getSelect(search_object, table);
	if (!table) {
		throw new ClientError(`Table ${search_object.table} not found`);
	}
	let lazy;
	if (select && table.attributes.length - select.length > 2 && select.length < 5) lazy = true;
	// we need to get the transaction and ensure that the transaction spans the entire duration
	// of the iteration
	const context = {
		user: search_object.hdb_user,
		onlyIfCached: search_object.onlyIfCached,
		noCacheStore: search_object.noCacheStore,
		noCache: search_object.noCache,
		replicateFrom: search_object.replicateFrom,
	};
	let finished_iteration;
	transaction(context, () => new Promise((resolve) => (finished_iteration = resolve)));
	const ids = search_object.ids || search_object.hash_values;
	let i = 0;
	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					if (i < ids.length) {
						const id = ids[i++];
						let record;
						try {
							record = await table.get({ id, lazy, select }, context);
							record = record && collapseData(record);
						} catch (error) {
							record = {
								message: error.toString(),
							};
						}
						if (return_key_value)
							return {
								value: { key: id, value: record },
							};
						else return { value: record };
					} else {
						finished_iteration();
						return { done: true };
					}
				},
				return(value) {
					finished_iteration();
					return {
						value,
						done: true,
					};
				},
				throw(error) {
					finished_iteration();
					return {
						done: true,
					};
				},
			};
		},
	};
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

async function* groupRecordsInHistory(table, start?, end?, limit?) {
	let enqueued;
	let count = 0;
	for await (const entry of table.getHistory(start, end)) {
		let operation = entry.operation ?? entry.type;
		if (operation === 'put') operation = 'upsert';
		const { id, version: timestamp, value } = entry;
		if (enqueued?.timestamp === timestamp) {
			enqueued.hash_values.push(id);
			enqueued.records.push(value);
		} else {
			if (enqueued) {
				yield enqueued;
				count++;
				if (limit && limit <= count) {
					enqueued = undefined;
					break;
				}
			}
			enqueued = {
				operation,
				user_name: entry.user,
				timestamp,
				hash_values: [id],
				records: [value],
			};
		}
	}
	if (enqueued) yield enqueued;
}
