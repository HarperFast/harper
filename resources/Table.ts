import { CONFIG_PARAMS, OPERATIONS_ENUM, SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME } from '../utility/hdbTerms';
import { Database, asBinary, SKIP } from 'lmdb';
import { getIndexedValues } from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { Query, ResourceInterface, Request, SubscriptionRequest, Id } from './ResourceInterface';
import { workerData, threadId } from 'worker_threads';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { CONTEXT, ID_PROPERTY, RECORD_PROPERTY, Resource, IS_COLLECTION } from './Resource';
import { COMPLETION, DatabaseTransaction, ImmediateTransaction } from './DatabaseTransaction';
import * as lmdb_terms from '../utility/lmdb/terms';
import * as env_mngr from '../utility/environment/environmentManager';
import { addSubscription, listenToCommits } from './transactionBroadcast';
import { handleHDBError, ClientError } from '../utility/errors/hdbError';
import * as signalling from '../utility/signalling';
import { SchemaEventMsg, UserEventMsg } from '../server/threads/itc';
import { databases, table } from './databases';
import { idsForCondition, filterByType } from './search';
import * as harper_logger from '../utility/logging/harper_logger';
import { assignTrackedAccessors, deepFreeze, hasChanges, OWN_DATA } from './tracked';
import { transaction } from './transaction';
import { MAXIMUM_KEY } from 'ordered-binary';
import { getWorkerIndex, onMessageByType } from '../server/threads/manageThreads';

let server_utilities;
const RANGE_ESTIMATE = 100000000;
const STARTS_WITH_ESTIMATE = 10000000;
env_mngr.initSync();
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const DELETION_COUNT_KEY = Symbol.for('deletions');
const VERSION_PROPERTY = Symbol.for('version');
const INCREMENTAL_UPDATE = Symbol.for('incremental-update');
const SOURCE_PROPERTY = Symbol('source-resource');
const LAZY_PROPERTY_ACCESS = { lazy: true };
const NOTIFICATION = { isNotification: true, allowInvalidated: true };

export interface Table {
	primaryStore: Database;
	auditStore: Database;
	indices: {};
	databasePath: string;
	tableName: string;
	databaseName: string;
	attributes: any[];
	primaryKey: string;
	subscriptions: Map<any, Function[]>;
	expirationTimer: ReturnType<typeof setInterval>;
	expirationMS: number;
	indexingOperations?: Promise<void>;
	Source: { new (): ResourceInterface };
	Transaction: ReturnType<typeof makeTable>;
}
/**
 * This returns a Table class for the given table settings (determined from the metadata table)
 * Instances of the returned class are Resource instances, intended to provide a consistent view or transaction of the table
 * @param options
 */
export function makeTable(options) {
	const {
		primaryKey: primary_key,
		indices,
		tableId: table_id,
		tableName: table_name,
		primaryStore: primary_store,
		databasePath: database_path,
		databaseName: database_name,
		auditStore: audit_store,
		trackDeletes: track_deletes,
		schemaDefined: schema_defined,
		dbisDB: dbis_db,
	} = options;
	let { expirationMS: expiration_ms } = options;
	let { attributes } = options;
	if (!attributes) attributes = [];
	listenToCommits(primary_store, audit_store);
	let deletion_count = 0;
	let pending_deletion_count_write;
	let primary_key_attribute = {};
	let created_time_property, updated_time_property;
	let commit_listeners: Set;
	for (const attribute of attributes) {
		if (attribute.assignCreatedTime || attribute.name === '__createdtime__') created_time_property = attribute.name;
		if (attribute.assignUpdatedTime || attribute.name === '__updatedtime__') updated_time_property = attribute.name;
		if (attribute.isPrimaryKey) primary_key_attribute = attribute;
	}
	class TableResource extends Resource {
		static name = table_name; // for display/debugging purposes
		static primaryStore = primary_store;
		static auditStore = audit_store;
		static primaryKey = primary_key;
		static tableName = table_name;
		static indices = indices;
		static databasePath = database_path;
		static databaseName = database_name;
		static attributes = attributes;
		static expirationTimer;
		static createdTimeProperty = created_time_property;
		static updatedTimeProperty = updated_time_property;
		static dbisDB = dbis_db;
		static schemaDefined = schema_defined;
		static sourcedFrom(Resource, options) {
			// define a source for retrieving invalidated entries for caching purposes
			if (options) this.sourceOptions = options;
			if (this.Source) {
				if (this.Source.mergeSource) this.Source = this.Source.mergeSource(Resource, this.sourceOptions);
				else if (Resource.mergeSource) {
					this.Source = Resource.mergeSource(this.Source, this.sourceOptions);
				} else
					throw new Error(
						'Can not assign multiple sources to a table with no source providing a (static) mergeSource method'
					);
			} else this.Source = Resource;
			(async () => {
				let user_role_update = false;
				const writeUpdate = async (event) => {
					const value = event.value;
					const Table = event.table ? databases[database_name][event.table] : TableResource;
					if (
						database_name === SYSTEM_SCHEMA_NAME &&
						(event.table === SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME || event.table === SYSTEM_TABLE_NAMES.USER_TABLE_NAME)
					) {
						user_role_update = true;
					}
					if (event.id === undefined) {
						event.id = value[Table.primaryKey];
						if (event.id === undefined) throw new Error('Replication message without an id ' + JSON.stringify(event));
					}
					const resource: TableResource = await Table.getResource(event.id, event, NOTIFICATION);
					switch (event.operation) {
						case 'put':
							return resource._writeUpdate(value, NOTIFICATION);
						case 'delete':
							return resource._writeDelete(NOTIFICATION);
						case 'publish':
							return resource._writePublish(value, NOTIFICATION);
						case 'invalidate':
							return resource.invalidate(NOTIFICATION);
						default:
							console.error('Unknown operation', event);
					}
				};

				try {
					const has_subscribe =
						Resource.subscribe && (!Resource.subscribe.reliesOnPrototype || Resource.prototype.subscribe);
					const subscription =
						has_subscribe &&
						(await Resource.subscribe?.({
							// this is used to indicate that all threads are (presumably) making this subscription
							// and we do not need to propagate events across threads (more efficient)
							crossThreads: false,
							// this is used to indicate that we want, if possible, immediate notification of writes
							// within the process (not supported yet)
							inTransactionUpdates: true,
							// supports transaction operations
							supportsTransactions: true,
						}));
					if (subscription) {
						for await (const event of subscription) {
							try {
								const first_write = event.operation === 'transaction' ? event.writes[0] : event;
								if (!first_write) {
									console.error('Bad subscription event');
									continue;
								}
								const commit_resolution = transaction(event, () => {
									if (event.operation === 'transaction') {
										const promises = [];
										for (const write of event.writes) {
											write[CONTEXT] = event;
											try {
												promises.push(writeUpdate(write));
											} catch (error) {
												error.message += ' writing ' + JSON.stringify(write) + ' of event ' + JSON.stringify(event);
												throw error;
											}
										}
										return Promise.all(promises);
									} else if (event.operation === 'define_schema') {
										// ensure table has the provided attributes
										const updated_attributes = this.attributes.slice(0);
										let has_changes;
										for (const attribute of event.attributes) {
											if (!updated_attributes.find((existing) => existing.name === attribute.name)) {
												updated_attributes.push(attribute);
												has_changes = true;
											}
										}
										if (has_changes) {
											table({ table: table_name, database: database_name, attributes: updated_attributes });
											signalling.signalSchemaChange(
												new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_TABLE, database_name, table_name)
											);
										}
									} else return writeUpdate(event);
								});
								if (event.onCommit) {
									if (commit_resolution?.then && user_role_update) {
										signalling.signalUserChange(new UserEventMsg(process.pid));
									}

									if (commit_resolution?.then) commit_resolution.then(event.onCommit);
									else event.onCommit();
								}
							} catch (error) {
								console.error('error in subscription handler', error);
							}
						}
					}
				} catch (error) {
					console.error(error);
				}
			})();
			return this;
		}
		static getResource(id: Id, request, options?: any): Promise<TableResource> | TableResource {
			const resource: TableResource = super.getResource(id, request) as any;
			if (id != null) {
				try {
					if (resource.hasOwnProperty(RECORD_PROPERTY)) return resource; // already loaded, don't reload, current version may have modifications
					const env_txn = resource._txnForRequest();
					if (typeof id === 'object' && id && !Array.isArray(id)) {
						throw new Error(`Invalid id ${JSON.stringify(id)}`);
					}
					let resolve_load, reject_load;
					const read_txn = env_txn?.getReadTxn();
					if (options) options.transaction = read_txn;
					else options = { transaction: read_txn };
					let finished;
					loadRecord(id, request, options, (entry, error) => {
						if (error) reject_load(error);
						else {
							resource[RECORD_PROPERTY] = entry?.value;
							resource[VERSION_PROPERTY] = entry?.version;
							finished = true;
							resolve_load?.(resource);
						}
					});
					if (finished) return resource;
					else
						return new Promise((resolve, reject) => {
							resolve_load = resolve;
							reject_load = reject;
						});
				} catch (error) {
					if (error.message.includes('Unable to serialize object')) error.message += ': ' + JSON.stringify(id);
					throw error;
				}
			}
			return resource;
		}
		/**
		 * Set TTL expiration for records in this table
		 * @param expiration_time Time in seconds
		 */
		static setTTLExpiration(expiration_time) {
			// we set up a timer to remove expired entries. we only want the timer/reaper to run in one thread,
			// so we use the first one
			if (getWorkerIndex() === 0) {
				expiration_ms = expiration_time * 1000;
				if (this.expirationTimer) clearInterval(this.expirationTimer);
				this.expirationTimer = setInterval(() => {
					if (this.primaryStore.rootStore.status === 'closed') return clearInterval(this.expirationTimer);
					// iterate through all entries to find expired ones
					for (const { key, value: record, version } of this.primaryStore.getRange({
						start: false,
						versions: true,
					})) {
						if (version < Date.now() - expiration_ms && version > 0) {
							// evict!
							TableResource.evict(key, record, version);
						}
					}
				}, expiration_ms).unref();
			}
		}
		/**
		 * Coerce the id as a string to the correct type for the primary key
		 * @param id
		 * @returns
		 */
		static coerceId(id: string): number | string {
			if (id === '') return null;
			return coerceType(id, primary_key_attribute);
		}

		static async dropTable() {
			delete databases[database_name][table_name];
			if (database_name === database_path) {
				// part of a database
				for (const attribute in indices) {
					dbis_db.remove(TableResource.tableName + '/' + attribute);
					const index = indices[attribute];
					index.drop();
				}
				dbis_db.remove(TableResource.tableName + '/');
				primary_store.drop();
				await dbis_db.committed;
			} else {
				// legacy table per database
				console.log('legacy dropTable');
				await primary_store.close();
				await fs.remove(data_path);
				await fs.remove(
					data_path === standard_path
						? data_path + MDB_LOCK_FILE_SUFFIX
						: path.join(path.dirname(data_path), MDB_LEGACY_LOCK_FILE_NAME)
				); // I suspect we may have problems with this on Windows
			}
			signalling.signalSchemaChange(
				new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_TABLE, database_name, table_name)
			);
		}

		static Source: typeof Resource;

		static get(request, context) {
			if (request && typeof request === 'object' && !Array.isArray(request) && request.id === undefined)
				return this.describe();
			return super.get(request, context);
		}
		/**
		 * This retrieves the data of this resource. By default, with no argument, just return `this`.
		 * @param query - If included, specifies a query to perform on the record
		 */
		get(query?: Query | string): Promise<object | void> | object | void {
			if (typeof query === 'string') return this.getProperty(query);
			if (this[IS_COLLECTION]) {
				return this.search(query);
			}
			if (this.doesExist() || (this[CONTEXT]?.hasOwnProperty('returnNonexistent') && this[CONTEXT].returnNonexistent)) {
				return this;
			}
		}
		/**
		 * Determine if the user is allowed to get/read data from the current resource
		 * @param user The current, authenticated user
		 * @param query The parsed query from the search part of the URL
		 */
		static allowRead(user, query) {
			if (!user) return false;
			const permission = user.role.permission;
			if (permission.super_user) return true;
			if (permission[table_name]?.read) {
				const attribute_permissions = permission[table_name].attribute_permissions;
				if (attribute_permissions) {
					// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					if (!query) query = {};
					const select = query.select;
					if (select) {
						const attrs_for_type = attributesAsObject(attribute_permissions, 'read');
						query.select = select.filter((property) => attrs_for_type[property]);
					} else {
						query.select = attribute_permissions
							.filter((attribute) => attribute.read)
							.map((attribute) => attribute.attribute_name);
					}
					return query;
				} else {
					return true;
				}
			}
		}

		/**
		 * Determine if the user is allowed to update data from the current resource
		 * @param user The current, authenticated user
		 * @param updated_data
		 * @param full_update
		 */
		allowUpdate(user, updated_data: any, full_update: boolean) {
			if (!user) return false;
			const permission = user.role.permission;
			if (permission.super_user) return true;
			if (permission[table_name]?.update) {
				const attribute_permissions = permission[table_name].attribute_permissions;
				if (attribute_permissions) {
					// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					const attrs_for_type = attributesAsObject(attribute_permissions, 'update');
					for (const key in updated_data) {
						if (!attrs_for_type[key]) return false;
					}
					if (full_update) {
						// if this is a full put operation that removes missing properties, we don't want to remove properties
						// that the user doesn't have permission to remove
						for (const permission of attribute_permissions) {
							const key = permission.attribute_name;
							if (!permission.update && !(key in updated_data)) {
								updated_data[key] = this.getProperty(key);
							}
						}
					}
				} else {
					return true;
				}
			}
		}
		/**
		 * Determine if the user is allowed to create new data in the current resource
		 * @param user The current, authenticated user
		 * @param updated_data
		 */
		allowCreate(user, updated_data: {}) {
			// creating *within* a record resource just means we are adding some data to a current record, which is
			// an update to the record, it is not an insert of a new record into the table, so not a table create operation
			// so does not use table insert permissions
			return this.allowUpdate(user, {});
		}
		/**
		 * Determine if the user is allowed to create new data in the current resource
		 * @param user The current, authenticated user
		 * @param new_data
		 */
		static allowCreate(user, new_data: {}) {
			if (!user) return false;
			const permission = user.role.permission;
			if (permission.super_user) return true;
			if (permission[table_name]?.insert) {
				const attribute_permissions = permission[table_name].attribute_permissions;
				if (attribute_permissions) {
					// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					const attrs_for_type = attributesAsObject(attribute_permissions, 'insert');
					for (const key in new_data) {
						if (!attrs_for_type[key]) return false;
					}
				} else {
					return true;
				}
			}
		}

		/**
		 * Determine if the user is allowed to delete from the current resource
		 * @param user The current, authenticated user
		 */
		static allowDelete(user) {
			if (!user) return false;
			const permission = user.role.permission;
			if (permission.super_user) return true;
			if (permission[table_name]?.delete) {
				return true;
			}
		}

		/**
		 * Start updating a record. The returned resource will record changes which are written
		 * once the corresponding transaction is committed. These changes can (eventually) include CRDT type operations.
		 * @param updates This can be a record to update the current resource with.
		 * @param full_update The provided data in updates is the full intended record; any properties in the existing record that are not in the updates, should be removed
		 */
		update(updates?: any, full_update?: boolean) {
			const env_txn = this._txnForRequest();
			if (!env_txn) throw new Error('Can not update a table resource outside of a transaction');
			// record in the list of updating records so it can be written to the database when we commit
			if (updates === false) {
				// TODO: Remove from transaction
				return this;
			}
			let own_data;
			if (typeof updates === 'object' && updates) {
				if (full_update) {
					for (const key in this[RECORD_PROPERTY]) {
						if (updates[key] === undefined) updates[key] = undefined;
					}
				}
				own_data = this[OWN_DATA];
				if (own_data) updates = Object.assign(own_data, updates);
				this[OWN_DATA] = own_data = updates;
			}
			if (!this[RECORD_PROPERTY] && primary_key && !(own_data || (own_data = this[OWN_DATA]))?.[primary_key]) {
				// if no primary key in the data, we assign it
				if (!own_data) own_data = this[OWN_DATA] = Object.create(null);
				own_data[primary_key] = this[ID_PROPERTY];
			}
			this._writeUpdate(this);
			return this;
		}

		invalidate(options) {
			const partial_record = { __invalidated__: true };
			for (const name in indices) {
				// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
				partial_record[name] = this.getProperty(name);
			}
			const transaction = this._txnForRequest();
			const txn_time = transaction.timestamp;
			transaction.addWrite({
				key: this[ID_PROPERTY],
				store: primary_store,
				txnTime: txn_time,
				invalidated: true,
				lastVersion: this[VERSION_PROPERTY],
				commit: (retry) => {
					if (retry) return;
					const source = TableResource.Source;
					let completion;
					const id = this[ID_PROPERTY];
					if (!options?.isNotification) {
						if (source?.invalidate && (!source.invalidate.reliesOnPrototype || source.prototype.invalidate)) {
							completion = source.invalidate(id, this);
						}
					}
					primary_store.put(this[ID_PROPERTY], partial_record, txn_time);
					// TODO: record_deletion?
					return {
						// return the audit record that should be recorded
						operation: 'invalidate',
						[COMPLETION]: completion,
					};
				},
			});
		}
		static evict(id, existing_record, existing_version) {
			let partial_record;
			if (!existing_record) {
				const entry = primary_store.getEntry(id);
				if (!entry) return;
				existing_record = entry.value;
				existing_version = entry.version;
			}
			if (existing_record) {
				for (const name in indices) {
					// if there are any indices, we need to preserve a partial evicted record to ensure we can still do searches
					if (!partial_record) partial_record = { __invalidated__: false };
					partial_record[name] = existing_record[name];
				}
			}
			//
			if (partial_record) {
				return primary_store.put(id, partial_record, existing_version, existing_version);
			} else return primary_store.remove(id, existing_version);
		}
		lock() {
			throw new Error('Not yet implemented');
		}
		static operation(operation, context) {
			operation.table ||= table_name;
			operation.schema ||= database_name;
			return server_utilities.operation(operation, context);
		}

		/**
		 * Store the provided record data into the current resource. This is not written
		 * until the corresponding transaction is committed. This will either immediately fail (synchronously) or always
		 * succeed. That doesn't necessarily mean it will "win", another concurrent put could come "after" (monotonically,
		 * even if not chronologically) this one.
		 * @param record
		 * @param options
		 */
		async put(record): Promise<void> {
			this.update(record, true);
		}
		_writeUpdate(record, options?: any) {
			const transaction = this._txnForRequest();

			// use optimistic locking to only commit if the existing record state still holds true.
			// this is superior to using an async transaction since it doesn't require JS execution
			//  during the write transaction.
			if (this[ID_PROPERTY] === undefined) {
				throw new Error('Can not save record without an id');
			}
			const txn_time = transaction.timestamp;
			let existing_record = this[RECORD_PROPERTY];
			let is_unchanged;
			let record_prepared;
			const id = this[ID_PROPERTY];
			if (!existing_record) this[RECORD_PROPERTY] = {}; // mark that this resource is being saved so isSaveRecord return true
			transaction.addWrite({
				key: id,
				store: primary_store,
				txnTime: txn_time,
				lastVersion: this[VERSION_PROPERTY],
				validate: () => {
					this.validate(record);
				},
				commit: (retry) => {
					let completion;
					if (retry) {
						if (is_unchanged) return;
						const existing_entry = primary_store.getEntry(id);
						existing_record = existing_entry?.value;
						const responseMetadata = this[CONTEXT]?.responseMetadata;
						if (responseMetadata && existing_entry?.version > (responseMetadata.lastModified || 0))
							responseMetadata.lastModified = existing_entry.version;
					}
					if (!record_prepared) {
						record_prepared = true;
						if (!options?.isNotification) {
							if (record[INCREMENTAL_UPDATE]) {
								is_unchanged = !hasChanges(record);
								if (is_unchanged) return;
							}
							if (primary_key && record[primary_key] !== id) record[primary_key] = id;
							if (TableResource.updatedTimeProperty) record[TableResource.updatedTimeProperty] = txn_time;
							if (TableResource.createdTimeProperty) {
								if (existing_record)
									record[TableResource.createdTimeProperty] = existing_record[TableResource.createdTimeProperty];
								else record[TableResource.createdTimeProperty] = txn_time;
							}
							record = deepFreeze(record); // this flatten and freeze the record
							const source = TableResource.Source;
							if (source?.put && (!source.put.reliesOnPrototype || source.prototype.put)) {
								completion = source.put(id, record, this);
							}
						} else record = deepFreeze(record); // TODO: I don't know that we need to freeze notification objects, might eliminate this for reduced overhead
						if (record[RECORD_PROPERTY]) throw new Error('Can not assign a record with a record property');
						this[RECORD_PROPERTY] = record;
					}
					harper_logger.trace(`Checking timestamp for put`, id, this[VERSION_PROPERTY], txn_time);
					if (this[VERSION_PROPERTY] > txn_time) {
						// This is not an error condition in our world of last-record-wins
						// replication. If the existing record is newer than it just means the provided record
						// is, well... older. And newer records are supposed to "win" over older records, and that
						// is normal, non-error behavior. So we still record an audit entry
						return; /*{
							// return the audit record that should be recorded
							operation: 'put',
							value: record,
							// TODO: What should this be?
							lastUpdate: this[LAST_MODIFICATION_PROPERTY],
						};*/
					}
					primary_store.put(this[ID_PROPERTY], record, txn_time);
					updateIndices(this[ID_PROPERTY], existing_record, record);
					if (existing_record === null && !retry) record_deletion(-1);
					return {
						// return the audit record that should be recorded
						operation: 'put',
						value: record,
						[COMPLETION]: completion,
					};
				},
			});
		}

		async delete(request: Request): Promise<boolean> {
			if (!this[RECORD_PROPERTY]) return false;
			// TODO: Handle deletion of a collection/query
			return this._writeDelete(request);
		}
		_writeDelete(options?: any) {
			const transaction = this._txnForRequest();
			const txn_time = transaction.timestamp;
			let delete_prepared;
			const id = this[ID_PROPERTY];
			let completion;
			transaction.addWrite({
				key: id,
				store: primary_store,
				txnTime: txn_time,
				lastVersion: this[VERSION_PROPERTY],
				commit: (retry) => {
					let existing_record = this[RECORD_PROPERTY];
					if (retry) {
						const existing_entry = primary_store.getEntry(id);
						existing_record = existing_entry?.value;
						const responseMetadata = this[CONTEXT]?.responseMetadata;
						if (responseMetadata && existing_entry?.version > (responseMetadata.lastModified || 0))
							responseMetadata.lastModified = existing_entry.version;
					}
					if (!delete_prepared) {
						delete_prepared = true;
						if (!options?.isNotification) {
							const source = TableResource.Source;
							if (source?.delete && (!source.delete.reliesOnPrototype || source.prototype.delete))
								completion = source.delete(id, this);
						}
					}
					if (this[VERSION_PROPERTY] > txn_time)
						// a newer record exists locally
						return;
					updateIndices(this[ID_PROPERTY], existing_record);
					if (audit_store || track_deletes) {
						primary_store.put(this[ID_PROPERTY], null, txn_time);
						if (!retry) record_deletion(1);
					} else primary_store.remove(this[ID_PROPERTY]);
					return {
						// return the audit record that should be recorded
						operation: 'delete',
						[COMPLETION]: completion,
					};
				},
			});
			return true;
		}

		search(request: Request): AsyncIterable<any> {
			const txn = this._txnForRequest();
			const reverse = request.reverse === true;
			let conditions = request.conditions;
			if (!conditions) conditions = Array.isArray(request) ? request : [];
			else if (conditions.length === undefined) conditions = Array.from(conditions);
			if (request.id && request.hasOwnProperty('id')) {
				conditions = [{ attribute: null, comparator: 'prefix', value: request.id }].concat(conditions);
			}
			for (const condition of conditions) {
				const attribute_name = condition[0] ?? condition.attribute;
				const attribute =
					attribute_name == null
						? primary_key_attribute
						: attributes.find((attribute) => attribute.name == attribute_name);
				if (!attribute) {
					if (attribute_name != null)
						throw handleHDBError(new Error(), `${attribute_name} is not a defined attribute`, 404);
				} else if (attribute.type === 'Int' || attribute.type === 'Float') {
					// convert to a number if that is expected
					if (condition[1] === undefined) condition.value = coerceType(condition.value, attribute);
					else condition[1] = coerceType(condition[1], attribute);
				}
			}
			// Sort the query by narrowest to broadest. Note that we want to do this both for intersection where
			// it allows us to do minimal filtering, and for union where we can return the fastest results first
			// in an iterator/stream.

			if (conditions.length > 1)
				conditions = sortBy(conditions, (condition) => {
					if (condition.estimated_count === undefined) {
						// skip if it is cached
						const search_type = condition.comparator || condition.search_type;
						if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS) {
							const attribute_name = condition[0] ?? condition.attribute;
							if (attribute_name == null || attribute_name === primary_key) condition.estimated_count = 1;
							else {
								// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
								const index = indices[attribute_name];
								condition.estimated_count = index ? index.getValuesCount(condition[1] ?? condition.value) : Infinity;
							}
						} else if (
							search_type === lmdb_terms.SEARCH_TYPES.CONTAINS ||
							search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH ||
							search_type === 'ne'
						)
							condition.estimated_count = Infinity;
						else if (search_type === lmdb_terms.SEARCH_TYPES.STARTS_WITH || search_type === 'prefix')
							condition.estimated_count = STARTS_WITH_ESTIMATE;
						// this search types can't/doesn't use indices, so try do them last
						// for range queries (betweens, starts-with, greater, etc.), just arbitrarily guess
						else condition.estimated_count = RANGE_ESTIMATE;
					}
					return condition.estimated_count; // use cached count
				});
			// we mark the read transaction as in use (necessary for a stable read
			// transaction, and we really don't care if the
			// counts are done in the same read transaction because they are just estimates) until the search
			// results have been iterated and finished.
			const read_txn = txn.getReadTxn();
			read_txn.use();
			const select = request.select;
			const first_search = conditions[0];
			let records;
			if (!first_search) {
				// if not conditions at all, just return entire table, iteratively
				records = primary_store
					.getRange(
						reverse
							? { end: false, reverse: true, transaction: read_txn, lazy: select?.length < 4 }
							: { start: false, transaction: read_txn, lazy: select?.length < 4 }
					)
					.map(({ value }) => {
						if (!value) return SKIP;
						return new Promise((resolve) => setImmediate(() => resolve(value)));
					});
			} else {
				// both AND and OR start by getting an iterator for the ids for first condition
				let ids = idsForCondition(first_search, read_txn, reverse, TableResource, request.allowFullScan);
				// and then things diverge...
				if (!request.operator || request.operator.toLowerCase() === 'and') {
					// get the intersection of condition searches by using the indexed query for the first condition
					// and then filtering by all subsequent conditions
					const filters = conditions.slice(1).map(filterByType);
					records = idsToRecords(ids, filters);
				} else {
					//get the union of ids from all condition searches
					for (let i = 1; i < conditions.length; i++) {
						const condition = conditions[i];
						// might want to lazily execute this after getting to this point in the iteration
						const next_ids = idsForCondition(condition, read_txn, reverse, TableResource, request.allowFullScan);
						ids = ids.concat(next_ids);
					}
					const returned_ids = new Set();
					ids = ids.filter((id) => {
						if (returned_ids.has(id))
							// skip duplicates
							return false;
						returned_ids.add(id);
						return true;
					});
					records = idsToRecords(ids);
				}
			}
			if (request.offset || request.limit !== undefined)
				records = records.slice(
					request.offset,
					request.limit !== undefined ? (request.offset || 0) + request.limit : undefined
				);
			records.onDone = () => {
				read_txn.done();
			};
			const context = this[CONTEXT];
			function idsToRecords(ids, filters?) {
				// TODO: Test and ensure that we break out of these loops when a connection is lost
				const filters_length = filters?.length;
				const options = {
					transaction: read_txn,
					lazy: filters_length > 0 || select?.length < 4,
					alwaysPrefetch: true,
				};
				return ids.map(
					// for filter operations, we intentionally use async and yield the event turn so that scanning queries
					// do not hog resources and give more processing opportunity for more efficient index-driven queries.
					// this also gives an opportunity to prefetch and ensure any page faults happen in a different thread
					(id) =>
						new Promise((resolve) =>
							loadRecord(id, context, options, (entry) => {
								const record = entry?.value;
								if (!record) return resolve(SKIP);
								for (let i = 0; i < filters_length; i++) {
									if (!filters[i](record)) return resolve(SKIP); // didn't match filters
								}
								resolve(record);
							})
						)
				);
			}
			return records;
		}
		async subscribe(request: SubscriptionRequest) {
			if (!audit_store) throw new Error('Can not subscribe to a table without an audit log');
			const subscription = addSubscription(
				TableResource,
				this[ID_PROPERTY] ?? null, // treat undefined and null as the root
				function (id, audit_record, timestamp) {
					try {
						this.send({ id, timestamp, ...audit_record });
					} catch (error) {
						console.error(error);
					}
				},
				request.startTime,
				this[IS_COLLECTION]
			);
			const this_id = this[ID_PROPERTY];
			let count = request.previousCount;
			if (count > 1000) count = 1000; // don't allow too many, we have to hold these in memory
			let start_time = request.startTime;
			if (this[IS_COLLECTION]) {
				// a collection should retrieve all descendant ids
				if (start_time) {
					if (count)
						throw new ClientError('startTime and previousCount can not be combined for a table level subscription');
					// start time specified, get the audit history for this time range
					for (const { key, value } of audit_store.getRange({ start: [start_time, Number.MAX_SAFE_INTEGER] })) {
						let [timestamp, audit_table_id, id] = key;
						if (key.length > 3) id = key.slice(2);
						if (audit_table_id !== table_id) continue;
						if (this_id == null || isDescendantId(this_id, id)) subscription.send({ id, timestamp, ...value });
						// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
						//await new Promise((resolve) => setImmediate(resolve)); // yield for fairness
						subscription.startTime = timestamp; // update so don't double send
					}
				} else if (count) {
					const history = [];
					// we are collecting the history in reverse order to get the right count, then reversing to send
					for (const { key, value } of audit_store.getRange({ start: 'z', end: false, reverse: true })) {
						try {
							let [timestamp, audit_table_id, id] = key;
							if (key.length > 3) id = key.slice(2);
							if (audit_table_id !== table_id) continue;
							if (this_id == null || isDescendantId(this_id, id)) {
								history.push({ id, timestamp, ...value });
								if (--count <= 0) break;
							}
						} catch (error) {
							harper_logger.error('Error getting history entry', key, error);
						}
						// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
						//await new Promise((resolve) => setImmediate(resolve)); // yield for fairness
					}
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					if (history[0]) subscription.startTime = history[0].timestamp; // update so don't double send
				} else if (!request.noRetain) {
					for (const { key: id, value, version } of primary_store.getRange({
						start: this_id ?? false,
						end: this_id == null ? undefined : [this_id, MAXIMUM_KEY],
						versions: true,
					})) {
						if (!value) continue;
						subscription.send({ id, timestamp: version, value });
					}
				}
			} else {
				if (count && !start_time) start_time = 0;
				const version = this[VERSION_PROPERTY];
				if (start_time < version) {
					request.noRetain = true; // we are sending the current version from history, so don't double send
					// start time specified, get the audit history for this record
					const history = [];
					let next_version = version;
					do {
						const key = [next_version, table_id, this_id];
						//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
						//await audit_store.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
						const audit_entry = audit_store.get(key);
						if (audit_entry) {
							history.push({ id: this_id, timestamp: next_version, ...audit_entry });
							next_version = audit_entry.lastVersion;
						} else break;
						if (count) count--;
					} while (next_version > start_time && count !== 0);
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					subscription.startTime = version; // make sure we don't re-broadcast the current version that we already sent
				} else if (!request.noRetain) {
					// if retain and it exists, send the current value first
					if (this.doesExist()) subscription.send({ id: this_id, timestamp: this[VERSION_PROPERTY], value: this });
				}
			}
			if (request.listener) subscription.on('data', request.listener);
			return subscription;
		}
		doesExist() {
			return Boolean(this[RECORD_PROPERTY]);
		}

		/**
		 * Publishing a message to a record adds an (observable) entry in the audit log, but does not change
		 * the record at all. This entries should be replicated and trigger subscription listeners.
		 * @param id
		 * @param message
		 * @param options
		 */
		async publish(message, options?) {
			this._writePublish(message, options);
		}
		_writePublish(message, options?: any) {
			const transaction = this._txnForRequest();
			const txn_time = transaction.timestamp;
			const id = this[ID_PROPERTY] || null;
			let completion;
			let publish_prepared;
			transaction.addWrite({
				store: primary_store,
				key: id,
				txnTime: txn_time,
				lastVersion: this[VERSION_PROPERTY],
				validate: () => {
					this.validate(message);
				},
				commit: (retries) => {
					this.validate(message);
					// just need to update the version number of the record so it points to the latest audit record
					// but have to update the version number of the record
					// TODO: would be faster to use getBinaryFast here and not have the record loaded

					if (!publish_prepared) {
						publish_prepared = true;
						if (!options?.isNotification) {
							const source = TableResource.Source;
							if (source?.publish && (!source.publish.reliesOnPrototype || source.prototype.publish)) {
								completion = source.publish(id, message, this);
							}
						}
					}

					const existing_record = retries > 0 ? primary_store.get(id) : this[RECORD_PROPERTY];
					if (existing_record === undefined && !retries && (audit_store || track_deletes)) record_deletion(1);
					primary_store.put(id, existing_record ?? null, txn_time);
					// messages are recorded in the audit entry
					return {
						operation: 'message',
						value: message,
						[COMPLETION]: completion,
					};
				},
			});
		}
		_txnForRequest() {
			const context = this[CONTEXT];
			const transaction_set = context?.transaction;
			if (transaction_set) {
				let transaction;
				if ((transaction = transaction_set?.find((txn) => txn.lmdbDb?.path === primary_store.path))) return transaction;
				transaction_set.push((transaction = new DatabaseTransaction(primary_store, context.user, audit_store)));
				transaction.timestamp = transaction_set.timestamp;
				return transaction;
			} else {
				return new ImmediateTransaction(primary_store, context.user, audit_store);
			}
		}
		validate(record) {
			let validation_errors;
			for (let i = 0, l = attributes.length; i < l; i++) {
				const attribute = attributes[i];
				if (attribute.type) {
					const value = record[attribute.name];
					if (value != null) {
						switch (attribute.type) {
							case 'Int':
							case 'Float':
								if (typeof value !== 'number' || (attribute.type === 'Int' && value !== Math.floor(value)))
									(validation_errors || (validation_errors = [])).push(
										`Property ${attribute.name} must be an ${attribute.type === 'Int' ? 'integer' : 'number'}`
									);
								break;
							case 'ID':
								if (
									!(
										typeof value === 'number' ||
										typeof value === 'string' ||
										(value?.length > 0 &&
											value.every?.((value) => typeof value === 'number' || typeof value === 'string'))
									)
								)
									(validation_errors || (validation_errors = [])).push(
										`Property ${attribute.name} must be a string, number, or an array (of strings and numbers)`
									);
								break;
							case 'String':
								if (typeof value !== 'string')
									(validation_errors || (validation_errors = [])).push(`Property ${attribute.name} must be a string`);
						}
					}
				}
				if (attribute.required && record[attribute.name] == null) {
					(validation_errors || (validation_errors = [])).push(`Property ${attribute.name} is required`);
				}
			}
			if (validation_errors) {
				throw new ClientError(validation_errors.join('. '));
			}
		}

		static async addAttributes(attributes_to_add) {
			const new_attributes = attributes.slice(0);
			for (const attribute of attributes_to_add) {
				if (!attribute.name) throw new ClientError('Attribute name is required');
				if (attribute.name.match(/[`/]/))
					throw new ClientError('Attribute names cannot include backticks or forward slashes');

				new_attributes.push(attribute);
			}
			table({ table: table_name, database: database_name, schemaDefined: schema_defined, attributes: new_attributes });
			this.Source?.defineSchema?.(this);
			return TableResource.indexingOperation;
		}
		static async removeAttributes(names: string[]) {
			const new_attributes = attributes.filter((attribute) => !names.includes(attribute.name));
			table({ table: table_name, database: database_name, schemaDefined: schema_defined, attributes: new_attributes });
			return TableResource.indexingOperation;
		}
		static getRecordCount() {
			// iterate through the metadata entries to exclude their count and exclude the deletion counts
			let excluded_count = 0;
			for (const { key, value } of primary_store.getRange({ end: false })) {
				excluded_count++;
				if (key[0]?.description === 'deletions') excluded_count += value || 0;
			}
			return primary_store.getStats().entryCount - excluded_count;
		}
		/**
		 * When attributes have been changed, we update the accessors that are assigned to this table
		 */
		static updatedAttributes() {
			assignTrackedAccessors(this, this);
		}
	}
	TableResource.updatedAttributes(); // on creation, update accessors as well
	const prototype = TableResource.prototype;
	prototype[INCREMENTAL_UPDATE] = true; // default behavior
	if (expiration_ms) TableResource.setTTLExpiration(expiration_ms / 1000);
	return TableResource;
	function updateIndices(id, existing_record, record?) {
		let has_changes;
		// iterate the entries from the record
		// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it can be
		// inside a write transaction
		// TODO: Make an array version of indices that is faster
		for (const key in indices) {
			const index = indices[key];
			const is_indexing = index.isIndexing;
			const value = record?.[key];
			const existing_value = existing_record?.[key];
			if (value === existing_value && !is_indexing) {
				continue;
			}
			has_changes = true;
			//if the update cleared out the attribute value we need to delete it from the index
			let values = getIndexedValues(existing_value);
			if (values) {
				if (LMDB_PREFETCH_WRITES)
					index.prefetch(
						values.map((v) => ({ key: v, value: id })),
						noop
					);
				for (let i = 0, l = values.length; i < l; i++) {
					index.remove(values[i], id);
				}
			}
			values = getIndexedValues(value);
			if (values) {
				if (LMDB_PREFETCH_WRITES)
					index.prefetch(
						values.map((v) => ({ key: v, value: id })),
						noop
					);
				for (let i = 0, l = values.length; i < l; i++) {
					index.put(values[i], id);
				}
			}
		}
		return has_changes;
	}
	function loadRecord(id, context, options, callback) {
		// TODO: determine if we use lazy access properties
		const whenPrefetched = () => {
			// this is all for debugging, should be removed eventually
			const read_txn = options.transaction;
			if (read_txn?.isDone) {
				throw new Error('Invalid read transaction');
			}
			let first_load_record;
			if (read_txn && !read_txn.hasRunLoadRecord) {
				first_load_record = true;
				read_txn.hasRunLoadRecord = true;
			}
			let entry;
			try {
				entry = primary_store.getEntry(id, options);
			} catch (error) {
				error.message += '. The read txn is ' + JSON.stringify(read_txn) + ' first loadRecord: ' + first_load_record;
				console.error(error);
				console.error('reader list', primary_store.readerList());
				console.error('reader check', primary_store.readerCheck());
				console.error('reader list', primary_store.readerList());
				throw error;
			}
			let record, version;
			let load_from_source;
			if (entry) {
				const responseMetadata = context?.responseMetadata;
				if (responseMetadata && entry.version > (responseMetadata.lastModified || 0))
					responseMetadata.lastModified = entry.version;
				version = entry.version;
				record = entry.value;
				if (
					version < 0 ||
					!record ||
					typeof record.__invalidated__ === 'boolean' ||
					(expiration_ms && version < Date.now() - expiration_ms)
				)
					load_from_source = true;
			} else load_from_source = true;
			if (load_from_source && !options?.allowInvalidated) {
				const source = TableResource.Source;
				const has_get = source && source.get && (!source.get.reliesOnPrototype || source.prototype.get);
				if (has_get) {
					return getFromSource(id, record, version, context).then(
						(entry) => {
							if (entry?.value?.[RECORD_PROPERTY]) throw new Error('Can not assign a record with a record property');
							callback(entry);
						},
						(error) => {
							callback(null, error);
						}
					);
				}
			}
			if (entry?.value?.[RECORD_PROPERTY]) throw new Error('Can not assign a record with a record property');
			callback(entry);
		};
		// if it is cached, we use that as indication that we can get the value very quickly
		if (!options.alwaysPrefetch && (id == null || primary_store.cache?.get(id))) return whenPrefetched();
		primary_store.prefetch([id], whenPrefetched);
	}
	function setupCommitListeners() {
		// setup a new set of listeners for commits
		commit_listeners = new Set();
		// listen for commits from other threads
		onMessageByType('transaction', onCommit);
		// listen for commits from our own thread
		primary_store.on('aftercommit', onCommit);
		function onCommit() {
			for (const listener of commit_listeners) {
				listener();
			}
		}
	}
	/**
	 * This is used to record that a retrieve a record from source
	 */
	async function getFromSource(id, existing_record = null, existing_version, context) {
		if (existing_version < 0) {
			// this signals that there is another thread that is getting this record, need to wait for it
			let entry;
			if (!commit_listeners) {
				setupCommitListeners();
			}
			return await new Promise((resolve) => {
				// we wait for a commit to see if the entry has updated
				let timer;
				const listener = () => {
					entry = primary_store.getEntry(id);
					if (!entry || entry.version > 0) {
						clearTimeout(timer);
						commit_listeners.delete(listener);
						if (typeof entry?.value?.__invalidated__ === 'boolean')
							return resolve(getFromSource(id, entry.value, entry.version, context));
						resolve(entry);
					}
				};
				commit_listeners.add(listener);
				timer = setTimeout(() => {
					commit_listeners.delete(listener);
					resolve(getFromSource(id, entry?.value, undefined, context));
				}, 10000).unref();
			});
		}
		let has_changes = existing_record?.__invalidated__;
		//			const invalidated_record = { __invalidated__: true };
		//			if (this[RECORD_PROPERTY]) Object.assign(invalidated_record, existing_record);
		// TODO: We want to eventually use a "direct write" method to directly write to the locations
		// of the record in place in the database, which requires a reserved space in the random access structures
		// it is important to remember that this is _NOT_ part of the current transaction; nothing is changing
		// with the canonical data, we are simply fulfilling our local copy of the canonical data, but still don't
		// want a timestamp later than the current transaction
		const updating_version = -(existing_version || 1);
		primary_store.put(id, existing_record, updating_version, existing_version);
		// we create a new context for the source, we want to determine the timestamp and don't want to
		// attribute this to the current user (but we do want to use the current transaction)
		const source_context = {
			responseMetadata: {},
			transaction: context?.transaction,
		};
		try {
			let updated_record = await TableResource.Source.get(id, source_context);
			let version = source_context.responseMetadata.lastModified || existing_version;
			// If we are using expiration and the version will already expire, need to incrment it
			if (!version || (expiration_ms && version < Date.now() - expiration_ms)) version = getNextMonotonicTime();
			has_changes = updateIndices(id, existing_record, updated_record) || has_changes;
			if (updated_record) {
				if (primary_key) updated_record[primary_key] = id;
				if (typeof updated_record.toJSON === 'function') updated_record = updated_record.toJSON();
				// don't wait on this, we don't actually care if it fails, that just means there is even
				// a newer entry going in the cache in the future
				primary_store.put(id, updated_record, version, updating_version);
			} else
				primary_store.remove(id, updating_version).then((success) => {
					if (!success) {
						console.log('Cached value was not removed', primary_store.getEntry(id));
					}
				});

			if (has_changes) {
				audit_store.put([version, table_id, id], {
					operation: updated_record ? 'put' : 'delete',
					value: updated_record,
					lastVersion: existing_version,
				});
			}
			return {
				version,
				value: updated_record,
			};
		} catch (error) {
			// revert the record state
			primary_store.put(id, existing_record, existing_version, updating_version);
			throw error;
		}
	}
	/*
	Here we write the deletion count for our thread id
	 */
	function record_deletion(increment: number) {
		if (!deletion_count) deletion_count = primary_store.get([DELETION_COUNT_KEY, threadId]) || 0;
		deletion_count += increment;
		if (!pending_deletion_count_write) {
			pending_deletion_count_write = setTimeout(() => {
				pending_deletion_count_write = null;
				primary_store.put([DELETION_COUNT_KEY, threadId], deletion_count);
			}, 50);
		}
	}
}

function attributesAsObject(attribute_permissions, type) {
	const attr_object = attribute_permissions.attr_object || (attribute_permissions.attr_object = {});
	let attrs_for_type = attr_object[type];
	if (attrs_for_type) return attrs_for_type;
	attrs_for_type = attr_object[type] = Object.create(null);
	for (const permission of attribute_permissions) {
		attrs_for_type[permission.attribute_name] = permission[type];
	}
	return attrs_for_type;
}
function noop() {
	// prefetch callback
}
export function setServerUtilities(utilities) {
	server_utilities = utilities;
}
const STRING_CAN_BE_INTEGER = /^\d+$/;
/**
 * Coerce a string to the type defined by the attribute
 * @param value
 * @param attribute
 * @returns
 */
function coerceType(value, attribute) {
	const type = attribute?.type;
	if (value === null) {
		return value;
	} else if (type === 'Int') return parseInt(value);
	else if (type === 'Float') return parseFloat(value);
	else if (!type || type === 'ID') {
		return STRING_CAN_BE_INTEGER.test(value) ? parseInt(value) : value;
	}
	return value;
}
function isDescendantId(ancestor_id, descendant_id): boolean {
	if (ancestor_id == null) return true; // ancestor of all ids
	if (!Array.isArray(descendant_id)) return ancestor_id === descendant_id;
	if (Array.isArray(ancestor_id)) {
		let al = ancestor_id.length;
		if (ancestor_id[al - 1] === null) al--;
		if (descendant_id.length >= al) {
			for (let i = 0; i < al; i++) {
				if (descendant_id[i] !== ancestor_id[i]) return false;
			}
			return true;
		}
		return false;
	} else if (descendant_id[0] === ancestor_id) return true;
}
