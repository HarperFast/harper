/**
 * This module provides the main table implementation of the Resource API, providing full access to HarperDB
 * tables through the interface defined by the Resource class. This module is responsible for handling these
 * table-level interactions, loading records, updating records, querying, and more.
 */

import { CONFIG_PARAMS, OPERATIONS_ENUM, SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME } from '../utility/hdbTerms';
import { asBinary, Database, DIRECT_WRITE_PLACEHOLDER, SKIP } from 'lmdb';
import { getIndexedValues, getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { Query, ResourceInterface, Request, SubscriptionRequest, Id, Context } from './ResourceInterface';
import { workerData, threadId } from 'worker_threads';
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
import { getWorkerIndex } from '../server/threads/manageThreads';
import { readAuditEntry } from './auditStore';
import { autoCast, convertToMS } from '../utility/common_utils';
import { getUpdateRecord } from './RecordEncoder';
import { recordAction, recordActionBinary } from './analytics';

const NULL_WITH_TIMESTAMP = new Uint8Array(9);
NULL_WITH_TIMESTAMP[8] = 0xc0; // null
let server_utilities;
const RANGE_ESTIMATE = 100000000;
const STARTS_WITH_ESTIMATE = 10000000;
const RECORD_PRUNING_INTERVAL = 60000; // one minute
env_mngr.initSync();
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);
const LOCK_TIMEOUT = 10000;
const DELETION_COUNT_KEY = Symbol.for('deletions');
const VERSION_PROPERTY = Symbol.for('version');
const INCREMENTAL_UPDATE = Symbol.for('incremental-update');
const ENTRY_PROPERTY = Symbol('entry');
const IS_SAVING = Symbol('is-saving');
const LOADED_FROM_SOURCE = Symbol('loaded-from-source');
const NOTIFICATION = { isNotification: true, ensureLoaded: false };
const INVALIDATED = 1;
const EVICTED = 8; // note that 2 is reserved for timestamps
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
	sources: { new (): ResourceInterface }[];
	Transaction: ReturnType<typeof makeTable>;
}
// we default to the max age of the streams because this is the limit on the number of old transactions
// we might need to reconcile deleted entries against.
const DELETE_ENTRY_EXPIRATION =
	convertToMS(env_mngr.get(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE)) || 86400000;
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
		schemaDefined: schema_defined,
		dbisDB: dbis_db,
	} = options;
	let { expirationMS: expiration_ms, audit, trackDeletes: track_deletes } = options;
	let { attributes } = options;
	if (!attributes) attributes = [];
	listenToCommits(primary_store, audit_store);
	const updateRecord = getUpdateRecord(primary_store, table_id, audit_store);
	let deletion_count = 0;
	let deletion_cleanup;
	let has_source_get;
	let pending_deletion_count_write;
	let primary_key_attribute = {};
	let created_time_property, updated_time_property, expires_at_property;
	let commit_listeners: Set;
	for (const attribute of attributes) {
		if (attribute.assignCreatedTime || attribute.name === '__createdtime__') created_time_property = attribute;
		if (attribute.assignUpdatedTime || attribute.name === '__updatedtime__') updated_time_property = attribute;
		if (attribute.expiresAt) expires_at_property = attribute;
		if (attribute.isPrimaryKey) primary_key_attribute = attribute;
	}
	let delete_callback_handle;
	if (audit) addDeleteRemoval();
	class TableResource extends Resource {
		static name = table_name; // for display/debugging purposes
		static primaryStore = primary_store;
		static auditStore = audit_store;
		static primaryKey = primary_key;
		static tableName = table_name;
		static indices = indices;
		static audit = audit;
		static databasePath = database_path;
		static databaseName = database_name;
		static attributes = attributes;
		static expirationTimer;
		static createdTimeProperty = created_time_property;
		static updatedTimeProperty = updated_time_property;
		static sources = [];
		static get expirationMS() {
			return expiration_ms;
		}
		static dbisDB = dbis_db;
		static schemaDefined = schema_defined;
		/**
		 * This defines a source for a table. This effectively makes a table into a cache, where the canonical
		 * source of data (or source of truth) is provided here in the Resource argument. Additional options
		 * can be provided to indicate how the caching should be handled.
		 * @param source
		 * @param options
		 * @returns
		 */
		static sourcedFrom(source, options) {
			// define a source for retrieving invalidated entries for caching purposes
			if (options) {
				this.sourceOptions = options;
				if (options.expiration) this.setTTLExpiration(options.expiration);
			}
			this.sources[options?.runFirst ? 'unshift' : 'push'](source);
			has_source_get = source && source.get && (!source.get.reliesOnPrototype || source.prototype.get);

			// External data source may provide a subscribe method, allowing for real-time proactive delivery
			// of data from the source to this caching table. This is generally greatly superior to expiration-based
			// caching since it much for accurately ensures freshness and maximizing caching time.
			// Here we subscribe the external data source if it is available, getting notification events
			// as they come in, and directly writing them to this table. We use the notification option to ensure
			// that we don't re-broadcast these as "requested" changes back to the source.
			(async () => {
				let user_role_update = false;
				// perform the write of an individual write event
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
					event.source = source;
					const resource: TableResource = await Table.getResource(event.id, event, NOTIFICATION);
					switch (event.type) {
						case 'put':
							return resource._writeUpdate(value, NOTIFICATION);
						case 'delete':
							return resource._writeDelete(NOTIFICATION);
						case 'publish':
							return resource._writePublish(value, NOTIFICATION);
						case 'invalidate':
							return resource.invalidate(NOTIFICATION);
						default:
							harper_logger.error('Unknown operation', event.type, event.id);
					}
				};

				try {
					const has_subscribe = source.subscribe;
					// if subscriptions come in out-of-order, we need to track deletes to ensure consistency
					if (has_subscribe && track_deletes == undefined) track_deletes = true;
					const subscribe_on_this_thread = source.subscribeOnThisThread
						? source.subscribeOnThisThread(getWorkerIndex())
						: getWorkerIndex() === 0;
					const subscription =
						has_subscribe &&
						subscribe_on_this_thread &&
						(await source.subscribe?.({
							// this is used to indicate that all threads are (presumably) making this subscription
							// and we do not need to propagate events across threads (more efficient)
							crossThreads: false,
							// this is used to indicate that we want, if possible, immediate notification of writes
							// within the process (not supported yet)
							inTransactionUpdates: true,
							// supports transaction operations
							supportsTransactions: true,
							// don't need the current state, should be up-to-date
							omitCurrent: true,
						}));
					if (subscription) {
						// we listen for events by iterating through the async iterator provided by the subscription
						for await (const event of subscription) {
							try {
								const first_write = event.type === 'transaction' ? event.writes[0] : event;
								if (!first_write) {
									harper_logger.error('Bad subscription event', event);
									continue;
								}
								event.source = source;
								const commit_resolution = transaction(event, () => {
									if (event.type === 'transaction') {
										// if it is a transaction, we need to individually iterate through each write event
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
									} else if (event.type === 'define_schema') {
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
											table({
												table: table_name,
												database: database_name,
												attributes: updated_attributes,
												origin: 'cluster',
											});
											signalling.signalSchemaChange(
												new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_TABLE, database_name, table_name)
											);
										}
									} else return writeUpdate(event);
								});
								if (user_role_update) {
									await commit_resolution;
									signalling.signalUserChange(new UserEventMsg(process.pid));
								}

								if (event.onCommit) {
									if (commit_resolution?.then) commit_resolution.then(event.onCommit);
									else event.onCommit();
								}
							} catch (error) {
								harper_logger.error('error in subscription handler', error);
							}
						}
					}
				} catch (error) {
					harper_logger.error(error);
				}
			})();
			return this;
		}
		/**
		 * Gets a resource instance, as defined by the Resource class, adding the table-specific handling
		 * of also loading the stored record into the resource instance.
		 * @param id
		 * @param request
		 * @param options An important option is ensureLoaded, which can be used to indicate that it is necessary for a caching table to load data from the source if there is not a local copy of the data in the table (usually not necessary for a delete, for example).
		 * @returns
		 */
		static getResource(id: Id, request, resource_options?: any): Promise<TableResource> | TableResource {
			const resource: TableResource = super.getResource(id, request, resource_options) as any;
			if (id != null) {
				try {
					if (resource.hasOwnProperty(RECORD_PROPERTY)) return resource; // already loaded, don't reload, current version may have modifications
					if (typeof id === 'object' && id && !Array.isArray(id)) {
						throw new Error(`Invalid id ${JSON.stringify(id)}`);
					}
					const sync = !resource_options?.async || primary_store.cache?.get(id);
					return loadLocalRecord(id, request, null, resource, sync, resource_options?.ensureLoaded);
				} catch (error) {
					if (error.message.includes('Unable to serialize object')) error.message += ': ' + JSON.stringify(id);
					throw error;
				}
			}
			return resource;
		}
		/**
		 * This is a request to explicitly ensure that the record is loaded from source, rather than only using the local record.
		 * This will load from source if the current record is expired, missing, or invalidated.
		 * @returns
		 */
		ensureLoaded() {
			const loaded_from_source = ensureLoadedFromSource(this[ID_PROPERTY], this[ENTRY_PROPERTY], this[CONTEXT]);
			if (loaded_from_source) {
				this[LOADED_FROM_SOURCE] = true;
				return when(loaded_from_source, (entry) => {
					this[ENTRY_PROPERTY] = entry;
					this[RECORD_PROPERTY] = entry.value;
					this[VERSION_PROPERTY] = entry.version;
				});
			}
		}
		/**
		 * Set TTL expiration for records in this table. On retrieval, record timestamps are checked for expiration.
		 * This also informs the scheduling for record eviction.
		 * @param expiration_time Time in seconds
		 */
		static setTTLExpiration(expiration_time) {
			// we set up a timer to remove expired entries. we only want the timer/reaper to run in one thread,
			// so we use the first one
			expiration_ms = expiration_time * 1000;
			if (getWorkerIndex() === 0) {
				if (this.expirationTimer) clearInterval(this.expirationTimer);
				this.expirationTimer = setInterval(async () => {
					if (this.primaryStore.rootStore.status !== 'open') return clearInterval(this.expirationTimer);
					// iterate through all entries to find expired ones
					for (const { key, value: record, version, expiresAt, metadataFlags } of this.primaryStore.getRange({
						start: false,
						snapshot: false,
						versions: true,
						lazy: true,
					})) {
						if (expiresAt && expiresAt < Date.now()) {
							// evict!
							TableResource.evict(key, record, version);
						}
						await rest();
					}
				}, Math.min(expiration_ms, 0x7fffffff)).unref(); // don't let this prevent closing the thread and make sure it can fit in 32-bit signed number
			}
		}

		/**
		 * Turn on auditing at runtime
		 */
		static enableAuditing(audit_enabled = true) {
			audit = audit_enabled;
			if (audit_enabled) addDeleteRemoval();
			TableResource.audit = audit_enabled;
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

		static get(request, context) {
			if (request && typeof request === 'object' && !Array.isArray(request) && request.url === '')
				return {
					// basically a describe call
					recordCount: this.getRecordCount(),
					records: './', // an href to the records themselves
					name: table_name,
					database: database_name,
					attributes,
				};
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
			if (query?.property) return this.getProperty(query.property);
			if (this.doesExist() || query?.ensureLoaded === false || this[CONTEXT]?.returnNonexistent) {
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
			const env_txn = txnForContext(this[CONTEXT]);
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
			this._writeUpdate(this);
			return this;
		}

		invalidate(options) {
			const transaction = txnForContext(this[CONTEXT]);
			transaction.addWrite({
				key: this[ID_PROPERTY],
				store: primary_store,
				invalidated: true,
				entry: this[ENTRY_PROPERTY],
				nodeName: this[CONTEXT]?.nodeName,
				noRetry: true,
				commit: (txn_time) => {
					let partial_record = null;
					for (const name in indices) {
						if (!partial_record) partial_record = {};
						// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
						partial_record[name] = this.getProperty(name);
					}
					let completion;
					const id = this[ID_PROPERTY];
					for (const source of TableResource.sources) {
						if (this[CONTEXT]?.source === source || this[CONTEXT]?.source?.isEqual?.(source)) break;
						if (source.shouldReceiveInvalidations) {
							const next_completion = source.invalidate?.(id, this);
							completion = completion ? Promise.all([completion, next_completion]) : next_completion;
						}
					}
					updateRecord(
						id,
						partial_record,
						this[ENTRY_PROPERTY],
						txn_time,
						INVALIDATED,
						audit,
						this[CONTEXT],
						'invalidate'
					);
					// TODO: record_deletion?
					return completion;
				},
			});
		}
		/**
		 * Evicting a record will remove it from a caching table. This is not considered a canonical data change, and it is assumed that retrieving this record from the source will still yield the same record, this is only removing the local copy of the record.
		 */
		static evict(id, existing_record, existing_version) {
			const source = this.Source;
			let entry;
			if (has_source_get || audit) {
				if (!existing_record) return;
				entry = primary_store.getEntry(id);
				if (!entry || !existing_record) return;
				if (entry.version !== existing_version) return;
			}
			if (has_source_get) {
				// if there is a resolution in-progress, abandon the eviction
				if (primary_store.hasLock(id, entry.version)) return;
				// if there is a source, we are not "deleting" the record, just removing our local copy, but preserving what we need for indexing
				let partial_record;
				for (const name in indices) {
					// if there are any indices, we need to preserve a partial evicted record to ensure we can still do searches
					if (!partial_record) partial_record = {};
					partial_record[name] = existing_record[name];
				}
				// if we are evicting and not deleting, need to preserve the partial record
				if (partial_record) {
					// treat this as a record resolution (so previous version is checked) with no audit record
					updateRecord(id, partial_record, entry, existing_version, EVICTED, null, null, null, true);
					return;
				}
			}
			if (audit) {
				// update the record to null it out, maintaining the reference to the audit history
				updateRecord(id, null, entry, existing_version, EVICTED, null, null, null, true);
			}
			// if no timestamps for audit, just remove
			else {
				return primary_store.remove(id, existing_version);
			}
		}
		/**
		 * This is intended to acquire a lock on a record from the whole cluster.
		 */
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
		// perform the actual write operation; this may come from a user request to write (put, post, etc.), or
		// a notification that a write has already occurred in the canonical data source, we need to update our
		// local copy
		_writeUpdate(record, options?: any) {
			const context = this[CONTEXT];
			const transaction = txnForContext(context);

			if (this[ID_PROPERTY] === undefined) {
				throw new Error('Can not save record without an id');
			}
			let record_prepared;
			const id = this[ID_PROPERTY];
			this[IS_SAVING] = true; // mark that this resource is being saved so doesExist return true
			const write = {
				key: id,
				store: primary_store,
				entry: this[ENTRY_PROPERTY],
				nodeName: context?.nodeName,
				validate: () => {
					if (!record[INCREMENTAL_UPDATE] || hasChanges(record)) this.validate(record);
					else {
						transaction.removeWrite(write);
					}
				},
				commit: (txn_time, existing_entry, retry) => {
					let completion;
					if (retry) {
						if (context && existing_entry?.version > (context.lastModified || 0))
							context.lastModified = existing_entry.version;
						updateResource(this, existing_entry);
					}
					const existing_record = existing_entry?.value;
					if (!record_prepared) {
						record_prepared = true;
						if (!this[CONTEXT]?.source) {
							if (primary_key && record[primary_key] !== id) record[primary_key] = id;
							if (updated_time_property) {
								record[updated_time_property.name] =
									updated_time_property.type === 'Date'
										? new Date(txn_time)
										: updated_time_property.type === 'String'
										? new Date(txn_time).toISOString()
										: txn_time;
							}
							if (created_time_property) {
								if (existing_record) record[created_time_property.name] = existing_record[created_time_property.name];
								else
									record[created_time_property.name] =
										created_time_property.type === 'Date'
											? new Date(txn_time)
											: created_time_property.type === 'String'
											? new Date(txn_time).toISOString()
											: txn_time;
							}
							record = deepFreeze(record); // this flatten and freeze the record
						} else record = deepFreeze(record); // TODO: I don't know that we need to freeze notification objects, might eliminate this for reduced overhead
						if (record[RECORD_PROPERTY]) throw new Error('Can not assign a record with a record property');
						this[RECORD_PROPERTY] = record;
						// send this to the sources
						for (const source of TableResource.sources) {
							if (context?.source === source || context?.source?.isEqual?.(source)) break;
							if (source?.put && (!source.put.reliesOnPrototype || source.prototype.put)) {
								const next_completion = source.put(id, record, this);
								completion = completion ? Promise.all([completion, next_completion]) : next_completion;
							}
						}
					}

					this[IS_SAVING] = false;
					harper_logger.trace(
						`Checking timestamp for put`,
						id,
						existing_entry?.version > txn_time,
						existing_entry?.version,
						txn_time
					);
					// we use optimistic locking to only commit if the existing record state still holds true.
					// this is superior to using an async transaction since it doesn't require JS execution
					//  during the write transaction.
					if (existing_entry?.version > txn_time) {
						// This is not an error condition in our world of last-record-wins
						// replication. If the existing record is newer than it just means the provided record
						// is, well... older. And newer records are supposed to "win" over older records, and that
						// is normal, non-error behavior. So we still record an audit entry
						return completion; /*(
							audit && {
								// return the audit record that should be recorded
								type: 'put',
								value: primary_store.encoder.encode(record_entry),
							}
						);*/
					}
					updateIndices(id, existing_record, record);
					updateRecord(id, record, existing_entry, txn_time, 0, audit, context);
					if (existing_record === null && !retry) recordDeletion(-1);
					return completion;
				},
			};
			transaction.addWrite(write);
		}

		async delete(request: Request): Promise<boolean> {
			if (typeof request === 'string') return this.deleteProperty(request);
			if (!this[RECORD_PROPERTY]) return false;
			// TODO: Handle deletion of a collection/query
			return this._writeDelete(request);
		}
		_writeDelete(options?: any) {
			const transaction = txnForContext(this[CONTEXT]);
			let delete_prepared;
			const id = this[ID_PROPERTY];
			let completion;
			transaction.addWrite({
				key: id,
				store: primary_store,
				resource: this,
				nodeName: this[CONTEXT]?.nodeName,
				commit: (txn_time, existing_entry, retry) => {
					const existing_record = existing_entry?.value;
					if (retry) {
						const context = this[CONTEXT];
						if (context && existing_entry?.version > (context.lastModified || 0))
							context.lastModified = existing_entry.version;
						updateResource(this, existing_entry);
					}
					if (!delete_prepared) {
						delete_prepared = true;
						for (const source of TableResource.sources) {
							if (this[CONTEXT]?.source === source || this[CONTEXT]?.source?.isEqual?.(source)) break;
							if (source?.delete && (!source.delete.reliesOnPrototype || source.prototype.delete)) {
								const next_completion = source.delete(id, this);
								completion = completion ? Promise.all([completion, next_completion]) : next_completion;
							}
						}
					}
					if (existing_entry?.version > txn_time)
						// a newer record exists locally
						return;
					updateIndices(this[ID_PROPERTY], existing_record);
					harper_logger.trace(`Write delete entry`, audit || track_deletes, txn_time);
					if (audit || track_deletes) {
						updateRecord(id, null, this[ENTRY_PROPERTY], txn_time, 0, audit, this[CONTEXT], 'delete');
						if (!audit) enqueueDeletionCleanup();
						if (!retry) recordDeletion(1);
					} else {
						primary_store.remove(this[ID_PROPERTY]);
					}
					return completion;
				},
			});
			return true;
		}

		search(request: Query): AsyncIterable<any> {
			const txn = txnForContext(this[CONTEXT]);
			if (!request) throw new Error('No query provided');
			const reverse = request.reverse === true;
			let conditions = request.conditions;
			if (!conditions)
				conditions = Array.isArray(request) ? request : request[Symbol.iterator] ? Array.from(request) : [];
			else if (conditions.length === undefined) conditions = Array.from(conditions);
			if (this[ID_PROPERTY]) {
				conditions = [{ attribute: null, comparator: 'prefix', value: this[ID_PROPERTY] }].concat(conditions);
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
				} else if (attribute.type) {
					// convert to a number if that is expected
					if (condition[1] === undefined) condition.value = coerceTypedValues(condition.value, attribute);
					else condition[1] = coerceTypedValues(condition[1], attribute);
				}
			}
			function coerceTypedValues(value, attribute) {
				if (Array.isArray(value)) {
					return value.map((value) => coerceType(value, attribute));
				}
				return coerceType(value, attribute);
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
						when(loadLocalRecord(id, context, options, null, false, request.ensureLoaded ?? true), (entry) => {
							const record = entry?.value;
							if (!record) return SKIP;
							for (let i = 0; i < filters_length; i++) {
								if (!filters[i](record)) return SKIP; // didn't match filters
							}
							return record;
						})
				);
			}
			return records;
		}
		async subscribe(request: SubscriptionRequest) {
			if (!audit_store) throw new Error('Can not subscribe to a table without an audit log');
			if (!audit) {
				table({ table: table_name, database: database_name, schemaDefined: schema_defined, attributes, audit: true });
			}
			const subscription = addSubscription(
				TableResource,
				this[ID_PROPERTY] ?? null, // treat undefined and null as the root
				function (id, audit_record, timestamp) {
					try {
						const value = audit_record.getValue(primary_store);
						this.send({ id, timestamp, value, type: audit_record.type });
					} catch (error) {
						harper_logger.error(error);
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
					for (const { key, value: audit_entry } of audit_store.getRange({
						start: start_time,
						exclusiveStart: true,
					})) {
						const audit_record = readAuditEntry(audit_entry, primary_store);
						if (audit_record.tableId !== table_id) continue;
						const id = audit_record.recordId;
						if (this_id == null || isDescendantId(this_id, id))
							subscription.send({ id, timestamp: key, ...audit_record });
						// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
						//await rest(); // yield for fairness
						subscription.startTime = key; // update so don't double send
					}
				} else if (count) {
					const history = [];
					// we are collecting the history in reverse order to get the right count, then reversing to send
					for (const { key, value: audit_entry } of audit_store.getRange({ start: 'z', end: false, reverse: true })) {
						try {
							const audit_record = readAuditEntry(audit_entry);
							if (audit_record.tableId !== table_id) continue;
							const id = audit_record.recordId;
							if (this_id == null || isDescendantId(this_id, id)) {
								const value = audit_record.getValue(primary_store);
								history.push({ id, timestamp: key, value, type: audit_record.type });
								if (--count <= 0) break;
							}
						} catch (error) {
							harper_logger.error('Error getting history entry', key, error);
						}
						// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
						//await rest(); // yield for fairness
					}
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					if (history[0]) subscription.startTime = history[0].timestamp; // update so don't double send
				} else if (!request.omitCurrent) {
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
				const local_version = this[ENTRY_PROPERTY]?.localTime;
				if (start_time < local_version) {
					// start time specified, get the audit history for this record
					const history = [];
					let next_version = local_version;
					do {
						//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
						//await audit_store.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
						const audit_entry = audit_store.get(next_version);
						if (audit_entry) {
							request.omitCurrent = true; // we are sending the current version from history, so don't double send
							const audit_record = readAuditEntry(audit_entry);
							const value = audit_record.getValue(primary_store);
							history.push({ id: this_id, value, timestamp: next_version, ...audit_record });
							next_version = audit_record.previousLocalTime;
						} else break;
						if (count) count--;
					} while (next_version > start_time && count !== 0);
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					subscription.startTime = local_version; // make sure we don't re-broadcast the current version that we already sent
				}
				if (!request.omitCurrent && this.doesExist()) {
					// if retain and it exists, send the current value first
					subscription.send({ id: this_id, timestamp: this[ENTRY_PROPERTY]?.localTime, value: this });
				}
			}
			if (request.listener) subscription.on('data', request.listener);
			return subscription;
		}
		doesExist() {
			return Boolean(this[RECORD_PROPERTY] || this[IS_SAVING]);
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
			const transaction = txnForContext(this[CONTEXT]);
			const id = this[ID_PROPERTY] || null;
			let completion;
			let publish_prepared;
			transaction.addWrite({
				key: id,
				store: primary_store,
				entry: this[ENTRY_PROPERTY],
				nodeName: this[CONTEXT]?.nodeName,
				validate: () => {
					this.validate(message);
				},
				commit: (txn_time, existing_entry, retries) => {
					this.validate(message);
					// just need to update the version number of the record so it points to the latest audit record
					// but have to update the version number of the record
					// TODO: would be faster to use getBinaryFast here and not have the record loaded

					if (!publish_prepared) {
						publish_prepared = true;
						for (const source of TableResource.sources) {
							if (this[CONTEXT]?.source === source || this[CONTEXT]?.source?.isEqual?.(source)) break;
							if (source?.publish && (!source.publish.reliesOnPrototype || source.prototype.publish)) {
								const next_completion = source.publish(id, this);
								completion = completion ? Promise.all([completion, next_completion]) : next_completion;
							}
						}
					}

					if (existing_entry === undefined && !retries && (audit || track_deletes)) {
						if (!audit) enqueueDeletionCleanup();
						// TODO: There is a chance that that is wrong if we think the record doesn't exist and then on retry we discover it does exist
						recordDeletion(1);
					}
					// always audit this, but don't change existing version
					// TODO: Use direct writes in the future (copying binary data is hard because it invalidates the cache)
					updateRecord(
						id,
						existing_entry?.value ?? null,
						existing_entry,
						existing_entry?.version || txn_time,
						0,
						true,
						this[CONTEXT],
						'message',
						false,
						message
					);
				},
			});
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
										typeof value === 'string' ||
										(value?.length > 0 && value.every?.((value) => typeof value === 'string'))
									)
								)
									(validation_errors || (validation_errors = [])).push(
										`Property ${attribute.name} must be a string, or an array of strings`
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
		getUpdatedTime() {
			return this[VERSION_PROPERTY];
		}
		wasLoadedFromSource(): boolean | void {
			return has_source_get ? Boolean(this[LOADED_FROM_SOURCE]) : undefined;
		}
		static async addAttributes(attributes_to_add) {
			const new_attributes = attributes.slice(0);
			for (const attribute of attributes_to_add) {
				if (!attribute.name) throw new ClientError('Attribute name is required');
				if (attribute.name.match(/[`/]/))
					throw new ClientError('Attribute names cannot include backticks or forward slashes');

				new_attributes.push(attribute);
			}
			table({
				table: table_name,
				database: database_name,
				schemaDefined: schema_defined,
				attributes: new_attributes,
			});
			return TableResource.indexingOperation;
		}
		static async removeAttributes(names: string[]) {
			const new_attributes = attributes.filter((attribute) => !names.includes(attribute.name));
			table({
				table: table_name,
				database: database_name,
				schemaDefined: schema_defined,
				attributes: new_attributes,
			});
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
		static async deleteHistory(end_time = 0) {
			let completion;
			for (const { key, value: audit_entry } of audit_store.getRange({
				start: 0,
				end: end_time,
			})) {
				await rest(); // yield to other async operations
				if (readAuditEntry(audit_entry).tableId !== table_id) continue;
				completion = audit_store.remove(key);
				// TODO: Cleanup delete entry from main table
			}
			await completion;
		}
		static async *getHistory(start_time = 0, end_time = Infinity) {
			for (const { key, value: audit_entry } of audit_store.getRange({
				start: start_time,
				end: end_time,
			})) {
				await rest(); // yield to other async operations
				const audit_record = readAuditEntry(audit_entry);
				if (audit_record.tableId !== table_id) continue;
				yield {
					id: audit_record.recordId,
					localTime: key,
					version: audit_record.version,
					type: audit_record.type,
					value: audit_record.getValue(primary_store),
					user: audit_record.user,
				};
			}
		}
		static async getHistoryOfRecord(id) {
			const history = [];
			const entry = primary_store.getEntry(id);
			if (!entry) return history;
			let next_local_time = entry.localTime;
			const count = 0;
			do {
				await rest(); // yield to other async operations
				//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
				//await audit_store.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
				const audit_entry = audit_store.get(next_local_time);
				if (audit_entry) {
					const audit_record = readAuditEntry(audit_entry);
					history.push({
						id: audit_record.recordId,
						localTime: next_local_time,
						version: audit_record.version,
						type: audit_record.type,
						value: audit_record.getValue(primary_store),
						user: audit_record.user,
					});
					next_local_time = audit_record.previousLocalTime;
				} else break;
			} while (count < 1000 && next_local_time);
			return history.reverse();
		}
		static cleanup() {
			delete_callback_handle?.remove();
		}
	}
	TableResource.updatedAttributes(); // on creation, update accessors as well
	const prototype = TableResource.prototype;
	prototype[INCREMENTAL_UPDATE] = true; // default behavior
	if (expiration_ms) TableResource.setTTLExpiration(expiration_ms / 1000);
	if (expires_at_property) runRecordExpirationEviction();
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
	function loadLocalRecord(id, context, options, resource, sync, ensure_loaded) {
		// TODO: determine if we use lazy access properties
		const whenPrefetched = () => {
			if (!options) {
				const txn = txnForContext(context);
				const read_txn = txn.getReadTxn();
				options = { transaction: read_txn };
				// this is all for debugging, should be removed eventually
				if (read_txn?.isDone) {
					throw new Error('Invalid read transaction');
				}
			}
			let entry;
			try {
				entry = primary_store.getEntry(id, options);
			} catch (error) {
				harper_logger.error(error);
				harper_logger.error('reader list', primary_store.readerList());
				harper_logger.error('reader check', primary_store.readerCheck());
				harper_logger.error('reader list', primary_store.readerList());
				throw error;
			}
			if (entry && context && entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
			if (resource) {
				if (entry) {
					updateResource(resource, entry);
				} else resource[RECORD_PROPERTY] = null;
				if (ensure_loaded) {
					const loaded_from_source = ensureLoadedFromSource(id, entry, context);
					if (loaded_from_source) {
						resource[LOADED_FROM_SOURCE] = true;
						return when(loaded_from_source, (entry) => {
							updateResource(resource, entry);
							return resource;
						});
					}
				}
				return resource;
			} else if (ensure_loaded) {
				const loaded_from_source = ensureLoadedFromSource(id, entry, context);
				if (loaded_from_source) return loaded_from_source;
				return entry;
			}
		};
		// if it is cached, we use that as indication that we can get the value very quickly
		if (sync) return whenPrefetched();
		return new Promise((resolve, reject) =>
			primary_store.prefetch([id], () => {
				try {
					resolve(whenPrefetched());
				} catch (error) {
					reject(error);
				}
			})
		);
	}

	function ensureLoadedFromSource(id, entry, context) {
		if (has_source_get) {
			let needs_source_data;
			if (entry) {
				if (
					!entry.value ||
					entry.metadataFlags & (INVALIDATED | EVICTED) || // invalidated or evicted should go to load from source
					(entry.expiresAt && entry.expiresAt < Date.now())
				)
					needs_source_data = true;
			} else needs_source_data = true;
			recordActionBinary(!needs_source_data, 'cache-hit', table_name);
			if (needs_source_data) {
				return getFromSource(id, entry, context).then((entry) => {
					if (entry?.value?.[RECORD_PROPERTY]) harper_logger.error('Can not assign a record with a record property');
					if (context && entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
					return entry;
				});
			}
		}
	}
	function txnForContext(context: Context) {
		let transaction = context?.transaction;
		if (transaction) {
			if (!transaction.open) {
				throw new Error('Can not use a transaction that is not open');
			}
			if (!transaction.lmdbDb) {
				// this is an uninitialized DatabaseTransaction, we can claim it
				transaction.lmdbDb = primary_store;
				return transaction;
			}
			do {
				// See if this is a transaction for our database and if so, use it
				if (transaction.lmdbDb?.path === primary_store.path) return transaction;
				// try the next one:
				const next_txn = transaction.next;
				if (!next_txn) {
					// no next one, then add our database
					transaction = transaction.next = new DatabaseTransaction();
					transaction.lmdbDb = primary_store;
					return transaction;
				}
				transaction = next_txn;
			} while (true);
		} else {
			return new ImmediateTransaction();
		}
	}
	/**
	 * This is used to record that a retrieve a record from source
	 */
	async function getFromSource(id, existing_entry, context) {
		const metadata_flags = existing_entry?.metadataFlags;

		const existing_version = existing_entry?.version;
		let when_resolved, timer;
		// We start by locking the record so that there is only one resolution happening at once;
		// if there is already a resolution in process, we want to use the results of that resolution
		// attemptLock() will return true if we got the lock, and the callback won't be called.
		// If another thread has the lock it returns false and then the callback is called once
		// the other thread releases the lock.
		if (
			!primary_store.attemptLock(id, existing_version, () => {
				// This is called when another thread releases the lock on resolution. Hopefully
				// it should be resolved now and we can use the value it saved.
				clearTimeout(timer);
				const entry = primary_store.getEntry(id);
				if (!entry || !entry.value || entry.metadataFlags & (INVALIDATED | EVICTED))
					// try again
					when_resolved(getFromSource(id, primary_store.getEntry(id), context));
				else when_resolved(entry);
			})
		) {
			return new Promise((resolve) => {
				when_resolved = resolve;
				timer = setTimeout(() => {
					primary_store.unlock(id, existing_version);
				}, LOCK_TIMEOUT);
			});
		}

		const existing_record = existing_entry?.value;
		// it is important to remember that this is _NOT_ part of the current transaction; nothing is changing
		// with the canonical data, we are simply fulfilling our local copy of the canonical data, but still don't
		// want a timestamp later than the current transaction
		const updating_version = existing_entry?.version;
		// we create a new context for the source, we want to determine the timestamp and don't want to
		// attribute this to the current user
		const source_context = {
			requestContext: context,
			// provide access to previous data
			replacingRecord: existing_record,
			replacingVersion: existing_version,
			source: null,
			// use the same resource cache as a parent context so that if modifications are made to resources,
			// they are visible in the parent requesting context
			resourceCache: context?.resourceCache,
		};
		const response_headers = context?.responseHeaders;
		return new Promise((resolve, reject) => {
			// we don't want to wait for the transaction because we want to return as fast as possible
			// and let the transaction commit in the background
			let resolved;
			transaction(source_context, async (txn) => {
				const start = performance.now();
				let updated_record;
				try {
					// find the first data source that will fulfill our request for data
					for (const source of TableResource.sources) {
						if (source.get && (!source.get.reliesOnPrototype || source.prototype.get)) {
							source_context.source = source;
							updated_record = await source.get(id, source_context);
							if (updated_record) break;
						}
					}
				} catch (error) {
					reject(error);
					throw error;
				}
				resolved = true;
				const invalidated = metadata_flags & INVALIDATED;
				const version = source_context.lastModified || (invalidated && existing_version);
				const has_changes = invalidated || version > existing_version;
				const resolve_duration = performance.now() - start;
				recordAction(resolve_duration, 'cache-resolution', table_name);
				if (response_headers) {
					response_headers.append('Server-Timing', `cache-resolve;dur=${resolve_duration.toFixed(2)}`);
				}
				txn.timestamp = version;
				if (expiration_ms && !source_context.expiresAt) source_context.expiresAt = Date.now() + expiration_ms;
				if (updated_record) {
					if (typeof updated_record.toJSON === 'function') updated_record = updated_record.toJSON();
					if (primary_key && updated_record[primary_key] !== id) updated_record[primary_key] = id;
				}
				resolve({
					version,
					value: updated_record,
				});
				const db_txn = txnForContext(source_context);
				db_txn.addWrite({
					key: id,
					store: primary_store,
					entry: existing_entry,
					noRetry: true, // don't try to update on retry, just let the newer version win
					nodeName: 'source',
					commit: (txn_time) => {
						const has_index_changes = updateIndices(id, existing_record, updated_record);
						let completion;
						if (updated_record) {
							for (const source of TableResource.sources) {
								if (source_context.source === source) break;
								if (source.put && (!source.put.reliesOnPrototype || source.prototype.put)) {
									const next_completion = source.put(id, updated_record, source_context);
									completion = completion ? Promise.all([completion, next_completion]) : next_completion;
								}
							}
							// TODO: We are doing a double check for ifVersion that should probably be cleaned out
							updateRecord(
								id,
								updated_record,
								existing_entry,
								txn_time,
								0,
								(audit && has_changes) || null,
								source_context,
								'put',
								Boolean(invalidated)
							).then((success) => {
								primary_store.unlock(id, existing_version);
							});
						} else {
							for (const source of TableResource.sources) {
								if (source_context.source === source) break;
								if (source.delete && (!source.delete.reliesOnPrototype || source.prototype.delete)) {
									const next_completion = source.delete(id, source_context);
									completion = completion ? Promise.all([completion, next_completion]) : next_completion;
								}
							}

							if (audit || track_deletes) {
								updateRecord(
									id,
									null,
									existing_entry,
									txn_time,
									0,
									(audit && has_changes) || null,
									source_context,
									'delete',
									Boolean(invalidated)
								).then((success) => {
									primary_store.unlock(id, existing_version);
								});
							} else {
								primary_store.remove(id, updating_version).then((success) => {
									primary_store.unlock(id, existing_version);
								});
							}
						}
						return completion;
					},
				});
			}).catch((error) => {
				primary_store.unlock(id, existing_version);
				if (resolved) harper_logger.error('Error committing cache update', error);
				// else the error was already propagated as part of the promise that we returned
			});
		});
	}
	/*
	Here we write the deletion count for our thread id
	 */
	function recordDeletion(increment: number) {
		if (!deletion_count) deletion_count = primary_store.get([DELETION_COUNT_KEY, threadId]) || 0;
		deletion_count += increment;
		if (!pending_deletion_count_write) {
			pending_deletion_count_write = setTimeout(() => {
				pending_deletion_count_write = null;
				if (primary_store.rootStore.status === 'open')
					primary_store.put([DELETION_COUNT_KEY, threadId], deletion_count);
			}, 50);
		}
	}
	function enqueueDeletionCleanup() {
		if (!deletion_cleanup) {
			deletion_cleanup = setTimeout(() => {
				deletion_cleanup = null;
				if (primary_store.rootStore.status !== 'open') return;
				for (const { key, value } of primary_store.getRange({ start: true })) {
					if (value === null) {
						const entry = primary_store.getEntry(key);
						// make sure it is still deleted when we do the removal
						if (entry?.value === null) {
							primary_store.remove(key, entry.version);
						}
						recordDeletion(-1);
					}
				}
			}, TableResource.getRecordCount() * 100 + DELETE_ENTRY_EXPIRATION).unref(); // heuristic for how often to do cleanup, we want to do it less frequently as tables get bigger because it will take longer
		}
	}
	function addDeleteRemoval() {
		delete_callback_handle = audit_store?.addDeleteRemovalCallback(table_id, (id) => {
			const entry = primary_store.getEntry(id);
			// make sure it is still deleted when we do the removal
			if (entry?.value === null) {
				primary_store.remove(id, entry.version);
			}
			recordDeletion(-1);
		});
	}
	function runRecordExpirationEviction() {
		// Periodically evict expired records, searching for records who expiresAt timestamp is before now
		if (getWorkerIndex() === 0) {
			// we want to run the pruning of expired records on only one thread so we don't have conflicts in evicting
			setInterval(async () => {
				// go through each database and table and then search for expired entries
				// find any entries that are set to expire before now
				try {
					const expires_at_name = expires_at_property.name;
					const index = indices[expires_at_name];
					if (!index) throw new Error(`expiresAt attribute ${expires_at_property} must be indexed`);
					for (const { value: id } of index.getRange({
						start: true,
						end: Date.now(),
						versions: true,
						snapshot: false,
					})) {
						const record_entry = primary_store.getEntry(id);
						if (record_entry?.value?.[expires_at_name] < Date.now()) {
							// make sure the record hasn't changed and won't change while removing
							TableResource.evict(id, record_entry.value, record_entry.version);
						}
						await rest();
					}
				} catch (error) {
					harper_logger.error('Error in evicting old records', error);
				}
			}, RECORD_PRUNING_INTERVAL).unref();
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
const ENDS_WITH_TIMEZONE = /[+-][0-9]{2}:[0-9]{2}|[a-zA-Z]$/;
/**
 * Coerce a string to the type defined by the attribute
 * @param value
 * @param attribute
 * @returns
 */
export function coerceType(value, attribute) {
	const type = attribute?.type;
	//if a type is String is it safe to execute a .toString() on the value and return? Does not work for Array/Object so we would need to detect if is either of those first
	if (value === null) {
		return value;
	} else if (type === 'Int') return parseInt(value);
	else if (type === 'Float') return parseFloat(value);
	else if (type === 'Date') {
		//if the value is not an integer (to handle epoch values) and does not end in a timezone we suffiz with 'Z' tom make sure the Date is GMT timezone
		if (typeof value !== 'number' && !ENDS_WITH_TIMEZONE.test(value)) {
			value += 'Z';
		}
		return new Date(value);
	} else if (!type) {
		return autoCast(value);
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

// wait for an event turn (via a promise)
const rest = () => new Promise(setImmediate);

// wait for a promise or plain object to resolve
function when(value, callback, reject?) {
	if (value?.then) return value.then(callback, reject);
	return callback(value);
}
export function updateResource(resource, entry) {
	resource[ENTRY_PROPERTY] = entry;
	resource[RECORD_PROPERTY] = entry?.value ?? null;
	resource[VERSION_PROPERTY] = entry?.version;
}
