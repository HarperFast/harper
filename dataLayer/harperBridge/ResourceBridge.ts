import LMDBBridge from './lmdbBridge/LMDBBridge.js';
import searchValidator from '../../validation/searchValidator.js';
import { handleHDBError, ClientError, hdbErrors } from '../../utility/errors/hdbError.js';
import { table, getDatabases, database, dropDatabase } from '../../resources/databases.ts';
import insertUpdateValidate from './bridgeUtility/insertUpdateValidate.js';
import SearchObject from '../SearchObject.js';
import {
	OPERATIONS_ENUM,
	VALUE_SEARCH_COMPARATORS,
	VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP,
	READ_AUDIT_LOG_SEARCH_TYPES_ENUM,
} from '../../utility/hdbTerms.ts';
import * as signalling from '../../utility/signalling.js';
import { SchemaEventMsg } from '../../server/threads/itc.js';
import { asyncSetTimeout } from '../../utility/common_utils.js';
import { transaction } from '../../resources/transaction.ts';
import type { Condition, Query, Context, Select, Id, DirectCondition } from '../../resources/ResourceInterface.ts';
import { collapseData } from '../../resources/tracked.ts';
import { errorToString } from '../../utility/logging/harper_logger.js';

const { HDB_ERROR_MSGS } = hdbErrors;
const DEFAULT_DATABASE = 'data';
const DELETE_CHUNK = 10000;
const DELETE_PAUSE_MS = 10;

export type SearchByConditionsRequest = Query &
	Context & {
		schema?: string;
		database?: string;
		table: string;
		get_attributes: Select;
		reverse?: boolean;
	};

/**
 * Currently we are extending LMDBBridge so we can use the LMDB methods as a fallback until all our RAPI methods are
 * implemented
 */
export class ResourceBridge extends LMDBBridge {
	async searchByConditions(searchObject: SearchByConditionsRequest) {
		if (searchObject.select !== undefined) searchObject.get_attributes = searchObject.select;
		for (const condition of searchObject.conditions || []) {
			if (condition?.attribute !== undefined) condition.search_attribute = condition.attribute;
			if (condition?.comparator !== undefined) condition.search_type = condition.comparator;
			if (condition?.value !== undefined) condition.search_value = condition.value;
		}
		const validationError = searchValidator(searchObject, 'conditions');
		if (validationError) {
			throw handleHDBError(validationError, validationError.message, 400, undefined, undefined, true);
		}
		const table = getTable(searchObject);
		if (!table) {
			throw new ClientError(`Table ${searchObject.table} not found`);
		}

		const conditions = searchObject.conditions.map(mapCondition);
		function mapCondition(condition: Condition) {
			if ('conditions' in condition && condition.conditions) {
				condition.conditions = condition.conditions.map(mapCondition);
				return condition;
			} else {
				const c = condition as DirectCondition;
				return {
					attribute: c.search_attribute ?? c.attribute,
					comparator: c.search_type ?? c.comparator,
					value: c.search_value !== undefined ? c.search_value : c.value, // null is valid value
				};
			}
		}

		return table.search(
			{
				conditions,
				//set the operator to always be lowercase for later evaluations
				operator: searchObject.operator ? searchObject.operator.toLowerCase() : undefined,
				limit: searchObject.limit,
				offset: searchObject.offset,
				reverse: searchObject.reverse,
				select: getSelect(searchObject, table),
				sort: searchObject.sort,
				allowFullScan: true, // operations API can do full scans by default, but REST is more cautious about what it allows
			},
			{
				onlyIfCached: searchObject.onlyIfCached,
				noCacheStore: searchObject.noCacheStore,
				noCache: searchObject.noCache,
				replicateFrom: searchObject.replicateFrom,
			}
		);
	}

	/**
	 * Writes new table data to the system tables creates the environment file and creates two datastores to track created and updated
	 * timestamps for new table data.
	 * @param tableSystemData
	 * @param tableCreateObj
	 */
	async createTable(tableSystemData, tableCreateObj) {
		let attributes = tableCreateObj.attributes;
		const schemaDefined = Boolean(attributes);
		const primaryKeyName = tableCreateObj.primary_key || tableCreateObj.hash_attribute;
		if (attributes) {
			// allow for attributes to be specified, but do some massaging to make sure they are in the right form
			for (const attribute of attributes) {
				if (attribute.is_primary_key) {
					attribute.isPrimaryKey = true;
					delete attribute.is_primary_key;
				} else if (attribute.name === primaryKeyName && primaryKeyName) attribute.isPrimaryKey = true;
			}
		} else {
			// legacy default schema for tables created through operations API without attributes
			if (!primaryKeyName)
				throw new ClientError('A primary key must be specified with a `primary_key` property or with `attributes`');
			attributes = [
				{ name: primaryKeyName, isPrimaryKey: true },
				{ name: '__createdtime__', indexed: true },
				{ name: '__updatedtime__', indexed: true },
			];
		}
		table({
			database: tableCreateObj.database ?? tableCreateObj.schema,
			table: tableCreateObj.table,
			attributes,
			schemaDefined,
			expiration: tableCreateObj.expiration,
			audit: tableCreateObj.audit,
		});
	}

	async createAttribute(createAttributeObj) {
		await getTable(createAttributeObj).addAttributes([
			{
				name: createAttributeObj.attribute,
				indexed: createAttributeObj.indexed ?? true,
			},
		]);
		return `attribute ${createAttributeObj.schema}.${createAttributeObj.table}.${createAttributeObj.attribute} successfully created.`;
	}

	async dropAttribute(dropAttributeObj) {
		const Table = getTable(dropAttributeObj);
		await Table.removeAttributes([dropAttributeObj.attribute]);
		if (!Table.schemaDefined) {
			// legacy behavior of deleting all the property values
			const property = dropAttributeObj.attribute;
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
		return `successfully deleted ${dropAttributeObj.schema}.${dropAttributeObj.table}.${dropAttributeObj.attribute}`;
	}

	dropTable(dropTableObject) {
		return getTable(dropTableObject).dropTable();
	}

	createSchema(createSchemaObj) {
		database({
			database: createSchemaObj.schema,
			table: null,
		});
		return signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_SCHEMA, createSchemaObj.schema)
		);
	}

	async dropSchema(dropSchemaObj) {
		await dropDatabase(dropSchemaObj.schema);
		signalling.signalSchemaChange(new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_SCHEMA, dropSchemaObj.schema));
	}

	async updateRecords(updateObj) {
		updateObj.requires_existing = true;
		return this.upsertRecords(updateObj);
	}

	async createRecords(updateObj) {
		updateObj.requires_no_existing = true;
		return this.upsertRecords(updateObj);
	}

	async upsertRecords(upsertObj) {
		const { schemaTable, attributes } = insertUpdateValidate(upsertObj);

		let new_attributes;
		const Table = getDatabases()[upsertObj.schema][upsertObj.table];
		const context: Context = {
			user: upsertObj.hdb_user,
			expiresAt: upsertObj.expiresAt,
			originatingOperation: upsertObj.operation,
		};
		if (upsertObj.replicateTo) context.replicateTo = upsertObj.replicateTo;
		if (upsertObj.replicatedConfirmation) context.replicatedConfirmation = upsertObj.replicatedConfirmation;
		return transaction(context, async (transaction) => {
			if (!Table.schemaDefined) {
				new_attributes = [];
				for (const attribute_name of attributes) {
					const existingAttribute = Table.attributes.find(
						(existingAttribute) => existingAttribute.name == attribute_name
					);
					if (!existingAttribute) {
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
			for (const record of upsertObj.records) {
				const id = record[Table.primaryKey];
				let existingRecord = id != undefined && (await Table.get(id, context));
				if ((upsertObj.requires_existing && !existingRecord) || (upsertObj.requires_no_existing && existingRecord)) {
					skipped.push(record[Table.primaryKey]);
					continue;
				}
				if (existingRecord) existingRecord = collapseData(existingRecord);
				for (const key in record) {
					if (Object.prototype.hasOwnProperty.call(record, key)) {
						let value = record[key];
						if (typeof value === 'function') {
							try {
								const valueResults = value([[existingRecord]]);
								if (Array.isArray(valueResults)) {
									value = valueResults[0].func_val;
									record[key] = value;
								}
							} catch (error) {
								error.message += 'Trying to set key ' + key + ' on object' + JSON.stringify(record);
								throw error;
							}
						}
					}
				}
				if (existingRecord) {
					for (const key in existingRecord) {
						// if the record is missing any properties, fill them in from the existing record
						if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = existingRecord[key];
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

	async deleteRecords(deleteObj) {
		const Table = getDatabases()[deleteObj.schema][deleteObj.table];
		const context: Context = { user: deleteObj.hdb_user };
		if (deleteObj.replicateTo) context.replicateTo = deleteObj.replicateTo;
		if (deleteObj.replicatedConfirmation) context.replicatedConfirmation = deleteObj.replicatedConfirmation;
		return transaction(context, async (transaction) => {
			const ids: Id[] = deleteObj.hash_values || deleteObj.records.map((record) => record[Table.primaryKey]);
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
	 * @param deleteObj
	 * {
	 *     operation: 'delete_records_before' <string>,
	 *     date: ISO-8601 format YYYY-MM-DD <string>,
	 *     schema: Schema where table resides <string>,
	 *     table: Table to delete records from <string>,
	 * }
	 * @returns {undefined}
	 */
	async deleteRecordsBefore(deleteObj) {
		const Table = getDatabases()[deleteObj.schema][deleteObj.table];
		if (!Table.createdTimeProperty) {
			throw new ClientError(
				`Table must have a '__createdtime__' attribute or @createdTime timestamp defined to perform this operation`
			);
		}

		const recordsToDelete = await Table.search({
			conditions: [
				{
					attribute: Table.createdTimeProperty.name,
					value: Date.parse(deleteObj.date),
					comparator: VALUE_SEARCH_COMPARATORS.LESS,
				},
			],
		});

		let deleteCalled = false;
		const deletedIds = [];
		const skippedIds = [];
		let i = 0;
		let ids = [];
		const chunkDelete = async () => {
			const deleteRes = await this.deleteRecords({
				schema: deleteObj.schema,
				table: deleteObj.table,
				hash_values: ids,
			});
			deletedIds.push(...deleteRes.deleted_hashes);
			skippedIds.push(...deleteRes.skipped_hashes);
			await asyncSetTimeout(DELETE_PAUSE_MS);
			ids = [];
			deleteCalled = true;
		};

		for await (const records of recordsToDelete) {
			ids.push(records[Table.primaryKey]);
			i++;
			if (i % DELETE_CHUNK === 0) {
				await chunkDelete();
			}
		}

		if (ids.length > 0) await chunkDelete();

		if (!deleteCalled) {
			return { message: 'No records found to delete' };
		}

		return createDeleteResponse(deletedIds, skippedIds, undefined);
	}

	/**
	 * fetches records by their hash values and returns an Array of the results
	 * @param {SearchByHashObject} searchObject
	 */
	searchByHash(searchObject) {
		if (searchObject.select !== undefined) searchObject.get_attributes = searchObject.select;
		const validationError = searchValidator(searchObject, 'hashes');
		if (validationError) {
			throw validationError;
		}
		return getRecords(searchObject);
	}

	/**
	 * Called by some SQL functions
	 * @param searchObject
	 */
	async getDataByHash(searchObject) {
		const map = new Map();
		searchObject._returnKeyValue = true;
		for await (const { key, value } of getRecords(searchObject, true)) {
			map.set(key, value);
		}
		return map;
	}

	searchByValue(searchObject: SearchObject, comparator?: string) {
		if (comparator && VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
			throw new Error(`Value search comparator - ${comparator} - is not valid`);
		}
		if (searchObject.select !== undefined) searchObject.get_attributes = searchObject.select;
		if (searchObject.attribute !== undefined) searchObject.search_attribute = searchObject.attribute;
		if (searchObject.value !== undefined) searchObject.search_value = searchObject.value;

		const validationError = searchValidator(searchObject, 'value');
		if (validationError) {
			throw validationError;
		}

		const table = getTable(searchObject);
		if (!table) {
			throw new ClientError(`Table ${searchObject.table} not found`);
		}
		let value = searchObject.search_value;
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
		if (comparator === VALUE_SEARCH_COMPARATORS.BETWEEN) value = [value, searchObject.end_value];
		const conditions =
			value === '*'
				? []
				: [
						{
							attribute: searchObject.search_attribute,
							value,
							comparator,
						},
					];

		return table.search(
			{
				conditions,
				allowFullScan: true,
				limit: searchObject.limit,
				offset: searchObject.offset,
				reverse: searchObject.reverse,
				sort: searchObject.sort,
				select: getSelect(searchObject, table),
			},
			{
				onlyIfCached: searchObject.onlyIfCached,
				noCacheStore: searchObject.noCacheStore,
				noCache: searchObject.noCache,
				replicateFrom: searchObject.replicateFrom,
			}
		);
	}

	async getDataByValue(searchObject: SearchObject, comparator) {
		const map = new Map();
		const table = getTable(searchObject);
		if (
			searchObject.get_attributes &&
			!searchObject.get_attributes.includes(table.primaryKey) &&
			searchObject.get_attributes[0] !== '*'
		)
			// ensure that we get the primary key so we can make a mapping
			searchObject.get_attributes.push(table.primaryKey);
		for await (const record of this.searchByValue(searchObject, comparator)) {
			map.set(record[table.primaryKey], record);
		}
		return map;
	}

	resetReadTxn(schema, table) {
		getTable({ schema, table })?.primaryStore.resetReadTxn();
	}

	async deleteAuditLogsBefore(deleteObj) {
		const table = getTable(deleteObj);
		return table.deleteHistory(deleteObj.timestamp, deleteObj.cleanup_deleted_records);
	}

	async readAuditLog(readAuditLogObj) {
		const table = getTable(readAuditLogObj);
		const histories = {};
		switch (readAuditLogObj.search_type) {
			case READ_AUDIT_LOG_SEARCH_TYPES_ENUM.HASH_VALUE:
				// get the history of each record
				for (const id of readAuditLogObj.search_values) {
					histories[id] = (await table.getHistoryOfRecord(id)).map((auditRecord) => {
						let operation = auditRecord.operation ?? auditRecord.type;
						if (operation === 'put') operation = 'upsert';
						return {
							operation,
							timestamp: auditRecord.version,
							user_name: auditRecord.user,
							hash_values: [id],
							records: [auditRecord.value],
						};
					});
				}
				return histories;
			case READ_AUDIT_LOG_SEARCH_TYPES_ENUM.USERNAME: {
				const users = readAuditLogObj.search_values;
				// do a full table scan of the history and find users
				for await (const entry of groupRecordsInHistory(table)) {
					if (users.includes(entry.user_name)) {
						const entriesForUser = histories[entry.user_name] || (histories[entry.user_name] = []);
						entriesForUser.push(entry);
					}
				}
				return histories;
			}
			default:
				return groupRecordsInHistory(
					table,
					readAuditLogObj.search_values?.[0],
					readAuditLogObj.search_values?.[1],
					readAuditLogObj.limit
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
function getRecords(searchObject, returnKeyValue?) {
	const table = getTable(searchObject);
	const select = getSelect(searchObject, table);
	if (!table) {
		throw new ClientError(`Table ${searchObject.table} not found`);
	}
	let lazy;
	if (select && table.attributes.length - select.length > 2 && select.length < 5) lazy = true;
	// we need to get the transaction and ensure that the transaction spans the entire duration
	// of the iteration
	const context = {
		user: searchObject.hdb_user,
		onlyIfCached: searchObject.onlyIfCached,
		noCacheStore: searchObject.noCacheStore,
		noCache: searchObject.noCache,
		replicateFrom: searchObject.replicateFrom,
	};
	let finishedIteration;
	transaction(context, () => new Promise((resolve) => (finishedIteration = resolve)));
	const ids = searchObject.ids || searchObject.hash_values;
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
								message: errorToString(error),
							};
						}
						if (returnKeyValue)
							return {
								value: { key: id, value: record },
							};
						else return { value: record };
					} else {
						finishedIteration();
						return { done: true };
					}
				},
				return(value) {
					finishedIteration();
					return {
						value,
						done: true,
					};
				},
				throw(error) {
					finishedIteration();
					return {
						done: true,
					};
				},
			};
		},
	};
}
function getTable(operationObject) {
	const databaseName = operationObject.database || operationObject.schema || DEFAULT_DATABASE;
	const tables = getDatabases()[databaseName];
	if (!tables) throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(databaseName), 404);
	return tables[operationObject.table];
}
/**
 * creates the response object for deletes based on the deleted & skipped hashes
 * @param {[]} deleted - list of hash values successfully deleted
 * @param {[]} skipped - list  of hash values which did not get deleted
 * @param {number} txnTime - the transaction timestamp
 * @returns {{skipped_hashes: [], deleted_hashes: [], message: string}}
 */
function createDeleteResponse(deleted, skipped, txnTime) {
	const total = deleted.length + skipped.length;
	const plural = total === 1 ? 'record' : 'records';

	return {
		message: `${deleted.length} of ${total} ${plural} successfully deleted`,
		deleted_hashes: deleted,
		skipped_hashes: skipped,
		txn_time: txnTime,
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
