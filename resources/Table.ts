import { CONFIG_PARAMS, OPERATIONS_ENUM } from '../utility/hdbTerms';
import { open, Database, asBinary, SKIP } from 'lmdb';
import { getIndexedValues } from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { ResourceInterface } from './ResourceInterface';
import { workerData, threadId } from 'worker_threads';
import { messageTypeListener } from '../server/threads/manageThreads';
import {
	CONTEXT_PROPERTY,
	TRANSACTIONS_PROPERTY,
	ID_PROPERTY,
	LAST_MODIFICATION_PROPERTY,
	RECORD_PROPERTY,
	Resource,
	copyRecord,
	withoutCopying,
	NOT_COPIED_YET,
	EXPLICIT_CHANGES_PROPERTY,
	USER_PROPERTY,
} from './Resource';
import { COMPLETION, DatabaseTransaction, immediateTransaction } from './DatabaseTransaction';
import * as lmdb_terms from '../utility/lmdb/terms';
import * as env_mngr from '../utility/environment/environmentManager';
import { addSubscription, listenToCommits } from './transactionBroadcast';
import { handleHDBError, ClientError } from '../utility/errors/hdbError';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import * as signalling from '../utility/signalling';
import { SchemaEventMsg } from '../server/threads/itc';
import { databases, table } from './databases';
import { idsForCondition, filterByType } from './search';
import * as harper_logger from '../utility/logging/harper_logger';

let server_utilities;
const RANGE_ESTIMATE = 100000000;
env_mngr.initSync();
const b = Buffer.alloc(1);
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const DELETION_COUNT_KEY = Symbol.for('deletions');
const DB_TXN_PROPERTY = Symbol('db-txn');
const VERSION_PROPERTY = Symbol.for('version');
const INCREMENTAL_UPDATE = Symbol.for('incremental-update');
const SOURCE_PROPERTY = Symbol('source-resource');
const LAZY_PROPERTY_ACCESS = { lazy: true };

export interface Table {
	primaryStore: Database;
	auditStore: Database;
	indices: Database[];
	databasePath: string;
	tableName: string;
	databaseName: string;
	attributes: any[];
	primaryKey: string;
	subscriptions: Map<any, Function[]>;
	expirationTimer: ReturnType<typeof setInterval>;
	expirationMS: number;
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
		expirationMS: expiration_ms,
		databasePath: database_path,
		databaseName: database_name,
		auditStore: audit_store,
		schemaDefined: schema_defined,
		dbisDB: dbis_db,
	} = options;
	let { attributes } = options;
	if (!attributes) attributes = [];
	if (audit_store) listenToCommits(audit_store);
	let deletion_count = 0;
	let pending_deletion_count_write;
	let primary_key_attribute = {};
	let created_time_property, updated_time_property;
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
		static schemaDefined = schema_defined;
		static dbTxn = immediateTransaction;
		static sourcedFrom(Resource) {
			// define a source for retrieving invalidated entries for caching purposes
			this.Source = Resource;
			(async () => {
				const writeUpdate = async (event, first_resource: TableResource, resource: TableResource) => {
					const value = event.value;
					if (event.table && !resource) {
						const Table = databases[database_name][event.table];
						const id = event.id === undefined ? value[Table.primaryKey] : event.id;
						if (id === undefined) throw new Error('Secondary resource found without an id ' + JSON.stringify(event));
						resource = await first_resource.use(Table).getResource(id, first_resource, null, true);
					}
					switch (event.operation) {
						case 'put':
							return resource.#writeUpdate(value, { isNotification: true });
						case 'delete':
							return resource.#writeDelete({ isNotification: true });
						case 'publish':
							return resource.#writePublish(value, { isNotification: true });
						default:
							console.error('Unknown operation', event);
					}
				};

				try {
					const subscription = await Resource.subscribe?.({
						// this is used to indicate that all threads are (presumably) making this subscription
						// and we do not need to propagate events across threads (more efficient)
						crossThreads: false,
						// this is used to indicate that we want, if possible, immediate notification of writes
						// within the process (not supported yet)
						inTransactionUpdates: true,
						// supports transaction operations
						supportsTransactions: true,
					});
					if (subscription) {
						for await (const event of subscription) {
							try {
								const first_write = event.operation === 'transaction' ? event.writes[0] : event;
								if (!first_write) {
									console.error('Bad subscription event');
									continue;
								}
								const id = first_write.id !== undefined ? first_write.id : first_write.value?.[primary_key];
								const first_resource = await this.getResource(
									id ?? null,
									{
										[CONTEXT_PROPERTY]: {
											user: {
												username: event.user,
											},
										},
									},
									null,
									true
								);
								const commit = first_resource.transact((first_resource) => {
									first_resource[TRANSACTIONS_PROPERTY].timestamp = event.timestamp;
									if (event.operation === 'transaction') {
										const promises = [];
										let resource = first_resource;
										for (const write of event.writes) {
											promises.push(writeUpdate(write, first_resource, resource));
											resource = null;
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
									} else writeUpdate(event, first_resource, first_resource);
								});
								if (event.onCommit) commit.then(event.onCommit);
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
		static getResource(id, resource_info, path, allow_invalidated): Promise<TableResource> {
			const resource: TableResource = super.getResource(id, resource_info, path) as any;
			if (id != null) {
				const completion = resource.loadRecord(allow_invalidated);
				if (completion?.then) return completion.then(() => resource);
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
			if (workerData?.workerIndex === 0) {
				if (!this.expirationTimer) {
					const expiration_ms = expiration_time * 1000;
					this.expirationTimer = setInterval(() => {
						// iterate through all entries to find expired ones
						for (const { key, value: record, version } of this.primaryStore.getRange({
							start: false,
							versions: true,
						})) {
							if (version < Date.now() - expiration_ms) {
								// make sure we only delete it if the version has not changed
								const resource = new this(key, this);
								resource.invalidate();
								this.primaryStore.ifVersion(key, version, () => this.primaryStore.remove(key));
							}
						}
					}, expiration_ms);
				}
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
				dbis_db.remove(TableResource.tableName + '/' + primary_key);
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

		[DB_TXN_PROPERTY]: DatabaseTransaction;
		static Source: typeof Resource;

		constructor(identifier, resource_info) {
			// coerce if we know this is supposed to be a number
			super(identifier, resource_info);
			if (this[TRANSACTIONS_PROPERTY]) assignDBTxn(this);
		}
		updateModificationTime(latest = Date.now()) {
			if (latest > this[LAST_MODIFICATION_PROPERTY]) {
				this[LAST_MODIFICATION_PROPERTY] = latest;
				if (this.parent?.updateModificationTime) this.parent.updateModificationTime(latest);
			}
		}
		// this primary exists to denote the difference between the Resource get, as a get that is implemented and returns something
		get(query) {
			return super.get(query);
		}
		loadRecord(allow_invalidated?: boolean) {
			// TODO: determine if we use lazy access properties
			if (this.hasOwnProperty(RECORD_PROPERTY)) return; // already loaded, don't reload, current version may have modifications
			const env_txn = this[DB_TXN_PROPERTY];
			const id = this[ID_PROPERTY];
			let entry = primary_store.getEntry(this[ID_PROPERTY], { transaction: env_txn?.getReadTxn() });
			let record;
			if (entry) {
				if (entry.version > this[LAST_MODIFICATION_PROPERTY]) this.updateModificationTime(entry.version);
				this[VERSION_PROPERTY] = entry.version;
				record = entry.value;
				if (this[VERSION_PROPERTY] < 0 || !record || record?.__invalidated__) entry = null;
			}
			if (!entry && !allow_invalidated) {
				const get = this.constructor.Source?.prototype.get;
				if (get && !get.doesNotLoad)
					return this.getFromSource(record, this[VERSION_PROPERTY]).then((record) => {
						copyRecord(record, this);
					});
			}
			copyRecord(record, this);
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
		 * @param partial_update
		 */
		allowUpdate(user, updated_data: {}, partial_update: boolean) {
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
					if (!partial_update) {
						// if this is a full put operation that removes missing properties, we don't want to remove properties
						// that the user doesn't have permission to remove
						for (const permission of attribute_permissions) {
							const key = permission.attribute_name;
							if (!permission.update && !(key in updated_data)) {
								updated_data[key] = this.get(key);
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
		 * @param updated_data
		 * @param partial_update
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
		 * @param arg This can be a record to update the current resource with.
		 */
		update(arg) {
			if (typeof arg === 'function') {
				return this.transact(() => {
					this.update();
					arg();
				});
			}
			const env_txn = this[DB_TXN_PROPERTY];
			if (!env_txn) throw new Error('Can not update a table resource outside of a transaction');
			// record in the list of updating records so it can be written to the database when we commit
			if (arg === false) {
				// TODO: Remove from transaction
				return this;
			}

			if (typeof arg === 'object' && arg) {
				arg[primary_key] = this[ID_PROPERTY]; // ensure that the id is in the record
				for (const key in this) {
					if (arg[key] === undefined) delete this[key];
				}
				for (const key in arg) {
					this[key] = arg[key];
				}
			}
			this.#writeUpdate(this);
			return this;
		}

		/**
		 * This will be used to record that a record is being resolved
		 */
		async getFromSource(existing_record, existing_version) {
			const invalidated_record = { __invalidated__: true };
			if (this[RECORD_PROPERTY]) Object.assign(invalidated_record, existing_record);
			// TODO: We want to eventually use a "direct write" method to directly write to the locations
			// of the record in place in the database, which requires a reserved space in the random access structures
			// it is important to remember that this is _NOT_ part of the current transaction; nothing is changing
			// with the canonical data, we are simply fulfilling our local copy of the canonical data, but still don't
			// want a timestamp later than the current transaction
			primary_store.put(this[ID_PROPERTY], invalidated_record, existing_version, existing_version);
			const source = await this.constructor.Source.getResource(this[ID_PROPERTY], this);
			const updated_record = await source.get();
			const version = existing_version || source[LAST_MODIFICATION_PROPERTY] || this[TRANSACTIONS_PROPERTY].timestamp;
			if (updated_record) {
				updated_record[primary_key] = this[ID_PROPERTY];
				// don't wait on this, we don't actually care if it fails, that just means there is even
				// a newer entry going in the cache in the future
				primary_store.put(this[ID_PROPERTY], updated_record, version, existing_version);
			} else primary_store.remove(this[ID_PROPERTY], existing_version);
			return updated_record;
		}
		invalidate() {
			let invalidated_record;
			for (const name in indices) {
				// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
				if (!invalidated_record) invalidated_record = { __invalidated__: true };
				invalidated_record[name] = this.getProperty(name);
			}
			if (invalidated_record) {
				this.#writeUpdate(invalidated_record, { isNotification: true });
			} else this.#writeDelete({ isNotification: true });
		}
		async operation(operation) {
			operation.hdb_user = this[USER_PROPERTY];
			operation.table ||= TableResource.tableName;
			operation.schema ||= TableResource.databaseName;
			const operation_function = server_utilities.chooseOperation(operation);
			return server_utilities.processLocalTransaction({ body: operation }, operation_function);
		}

		/**
		 * Store the provided record data into the current resource. This is not written
		 * until the corresponding transaction is committed. This will either immediately fail (synchronously) or always
		 * succeed. That doesn't necessarily mean it will "win", another concurrent put could come "after" (monotonically,
		 * even if not chronologically) this one.
		 * @param record
		 * @param options
		 */
		async put(record, options?): Promise<void> {
			// TODO: only do this if we are in a custom function, otherwise directly call #writeUpdate
			this.update(record);
		}
		#writeUpdate(record, options?) {
			const env_txn = this[DB_TXN_PROPERTY] || immediateTransaction;

			// use optimistic locking to only commit if the existing record state still holds true.
			// this is superior to using an async transaction since it doesn't require JS execution
			//  during the write transaction.
			const txn_time = this[TRANSACTIONS_PROPERTY]?.timestamp || immediateTransaction.timestamp;
			let existing_record = this[RECORD_PROPERTY];
			this[RECORD_PROPERTY] = record;
			let is_unchanged;
			let record_prepared;
			env_txn.addWrite({
				key: this[ID_PROPERTY],
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
						const existing_entry = primary_store.getEntry(this[ID_PROPERTY]);
						existing_record = existing_entry?.value;
						this.updateModificationTime(existing_entry?.version);
					}
					if (!record_prepared) {
						record_prepared = true;
						if (record[EXPLICIT_CHANGES_PROPERTY]) {
							record = Object.assign({}, record, record[EXPLICIT_CHANGES_PROPERTY]);
						}
						if (!options?.isNotification) {
							if (record[INCREMENTAL_UPDATE]) {
								is_unchanged = withoutCopying(() => isEqual(this, existing_record));
								if (is_unchanged) return;
							}
							if (TableResource.updatedTimeProperty) record[TableResource.updatedTimeProperty] = txn_time;
							if (TableResource.createdTimeProperty) {
								if (existing_record)
									record[TableResource.createdTimeProperty] = existing_record[TableResource.createdTimeProperty];
								else record[TableResource.createdTimeProperty] = txn_time;
							}
							if (this.constructor.Source?.prototype.put) {
								const source = this.constructor.Source.getResource(this[ID_PROPERTY], this);
								if (source?.then)
									completion = source.then((source) => {
										this[SOURCE_PROPERTY] = source;
										return source.put(record, options);
									});
								else {
									this[SOURCE_PROPERTY] = source;
									completion = source.put(record, options);
								}
							}
						}
					}
					harper_logger.trace(
						'update version check',
						this[VERSION_PROPERTY],
						txn_time,
						this[VERSION_PROPERTY] > txn_time
					);

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
					return {
						// return the audit record that should be recorded
						operation: 'put',
						value: record,
						[COMPLETION]: completion,
					};
				},
			});
		}

		async delete(options): Promise<boolean> {
			if (!this[RECORD_PROPERTY]) return false;
			/*if (this.constructor.Source?.prototype.delete) {
				const source = (this[SOURCE_PROPERTY] = await this.constructor.Source.getResource(this[ID_PROPERTY], this));
				await source.delete(options);
			}*/
			return this.#writeDelete();
		}
		#writeDelete(options) {
			const env_txn = this[DB_TXN_PROPERTY] || immediateTransaction;
			const txn_time = this[TRANSACTIONS_PROPERTY]?.timestamp || immediateTransaction.timestamp;
			let delete_prepared;
			const id = this[ID_PROPERTY];
			let completion;
			env_txn.addWrite({
				key: id,
				store: primary_store,
				txnTime: txn_time,
				lastVersion: this[VERSION_PROPERTY],
				commit: (retry) => {
					let existing_record = this[RECORD_PROPERTY];
					if (retry) {
						const existing_entry = primary_store.getEntry(id);
						existing_record = existing_entry?.value;
						this.updateModificationTime(existing_entry?.version);
					}
					if (!delete_prepared) {
						delete_prepared = true;
						if (!options?.isNotification) {
							if (this.constructor.Source?.prototype.delete) {
								const source = this.constructor.Source.getResource(id, this);
								harper_logger.trace(`Sending delete ${id} to source, is promise ${!!source?.then}`);
								if (source?.then)
									completion = source.then((source) => {
										this[SOURCE_PROPERTY] = source;
										return source.delete(options);
									});
								else {
									this[SOURCE_PROPERTY] = source;
									completion = source.delete(options);
								}
							}
						}
					}
					if (this[VERSION_PROPERTY] > txn_time)
						// a newer record exists locally
						return;
					updateIndices(this[ID_PROPERTY], existing_record);
					primary_store.put(this[ID_PROPERTY], null, txn_time);
					if (!retry) record_deletion();
					return {
						// return the audit record that should be recorded
						operation: 'delete',
						[COMPLETION]: completion,
					};
				},
			});
			return true;
		}
		static transact(callback, options?) {
			if (this[TRANSACTIONS_PROPERTY]) return callback(this);
			return super.transact((TableTxn) => {
				assignDBTxn(TableTxn);
				return callback(TableTxn);
			}, options);
		}
		transact(callback) {
			if (this[TRANSACTIONS_PROPERTY]) return callback(this);
			return super.transact(() => {
				assignDBTxn(this);
				return callback(this);
			});
		}

		search(query): AsyncIterable<any> {
			if (!this[TRANSACTIONS_PROPERTY]) return this.transact((txn_resource) => txn_resource.search(query));
			if (query == null) {
				query = []; // treat no query as a query for everything
			}
			const reverse = query.reverse === true;
			let conditions = query.length >= 0 ? query : Array.from(query);

			for (const condition of conditions) {
				const attribute_name = condition[0] ?? condition.attribute;
				const attribute = attributes.find((attribute) => attribute.name == attribute_name);
				if (!attribute) {
					throw handleHDBError(new Error(), `${attribute_name} is not a defined attribute`, 404);
				}
				if (attribute.type === 'Int' || attribute.type === 'Float') {
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
							// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
							const index = indices[condition[0] ?? condition.attribute];
							condition.estimated_count = index ? index.getValuesCount(condition[1] ?? condition.value) : Infinity;
						} else if (
							search_type === lmdb_terms.SEARCH_TYPES.CONTAINS ||
							search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH ||
							search_type === 'ne'
						)
							condition.estimated_count = Infinity;
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
			const read_txn = this[DB_TXN_PROPERTY].getReadTxn();
			read_txn.use();
			const select = query.select;
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
						return new Promise((resolve) => setImmediate(() => resolve(selectProperties(value))));
					});
			} else {
				// both AND and OR start by getting an iterator for the ids for first condition
				let ids = idsForCondition(first_search, read_txn, reverse, TableResource, query.allowFullScan);
				// and then things diverge...
				if (!query.operator || query.operator.toLowerCase() === 'and') {
					// get the intersection of condition searches by using the indexed query for the first condition
					// and then filtering by all subsequent conditions
					const filters = conditions.slice(1).map(filterByType);
					records = idsToRecords(ids, filters);
				} else {
					//get the union of ids from all condition searches
					for (let i = 1; i < conditions.length; i++) {
						const condition = conditions[i];
						// might want to lazily execute this after getting to this point in the iteration
						const next_ids = idsForCondition(condition, read_txn, reverse, TableResource, query.allowFullScan);
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
			if (query.offset || query.limit !== undefined)
				records = records.slice(
					query.offset,
					query.limit !== undefined ? (query.offset || 0) + query.limit : undefined
				);
			records.onDone = () => {
				read_txn.done();
			};
			function idsToRecords(ids, filters?) {
				// TODO: Test and ensure that we break out of these loops when a connection is lost
				const filters_length = filters?.length;
				const lazy = filters_length > 0 || select?.length < 4;
				return ids.map(
					// for filter operations, we intentionally use async and yield the event turn so that scanning queries
					// do not hog resources and give more processing opportunity for more efficient index-driven queries.
					// this also gives an opportunity to prefetch and ensure any page faults happen in a different thread
					(id) =>
						new Promise((resolve) =>
							primary_store.prefetch([id], () => {
								const record = primary_store.get(id, {
									transaction: read_txn,
									lazy,
								});
								if (!record) return resolve(SKIP);
								for (let i = 0; i < filters_length; i++) {
									if (!filters[i](record)) return resolve(SKIP); // didn't match filters
								}
								resolve(selectProperties(record));
							})
						)
				);
			}
			function selectProperties(record) {
				if (select) {
					const selected = {};
					const forceNulls = select.forceNulls;
					for (let i = 0, l = select.length; i < l; i++) {
						const key = select[i];
						if (record.hasOwnProperty(key)) selected[key] = record[key];
						else if (forceNulls) selected[key] = null;
					}
					return selected;
				}
				// get the full record, not the lazy record
				return record.toJSON ? record.toJSON() : record;
			}
			return records;
		}
		async subscribe(options) {
			if (!audit_store) throw new Error('Can not subscribe to a table without an audit log');
			const subscription = addSubscription(
				this.constructor,
				this[ID_PROPERTY],
				function (id, audit_record, timestamp) {
					//let result = await this.get(key);
					try {
						this.send({ id, timestamp, ...audit_record });
					} catch (error) {
						console.error(error);
					}
				},
				options.startTime
			);
			const id = this[ID_PROPERTY];
			let count = options.previousCount;
			if (count > 1000) count = 1000; // don't allow too many, we have to hold these in memory
			let start_time = options.startTime;
			if (id == null) {
				if (start_time) {
					if (count)
						throw new ClientError('startTime and previousCount can not be combined for a table level subscription');
					// start time specified, get the audit history for this time range
					for (const { key, value } of audit_store.getRange({ start: [start_time, Number.MAX_SAFE_INTEGER] })) {
						const [timestamp, audit_table_id, id] = key;
						if (audit_table_id !== table_id) continue;
						subscription.send({ id, timestamp, ...value });
						// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
						//await new Promise((resolve) => setImmediate(resolve)); // yield for fairness
						subscription.startTime = timestamp; // update so don't double send
					}
				} else if (count) {
					const history = [];
					// we are collecting the history in reverse order to get the right count, then reversing to send
					for (const { key, value } of audit_store.getRange({ start: 'z', end: false, reverse: true })) {
						try {
							const [timestamp, audit_table_id, id] = key;
							if (audit_table_id !== table_id) continue;
							history.push({ id, timestamp, ...value });
							if (--count <= 0) break;
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
				} else if (!options.noRetain) {
					for (const { key: id, value, version } of primary_store.getRange({ start: false, versions: true })) {
						if (!value) continue;
						subscription.send({ id, timestamp: version, value });
					}
				}
			} else {
				if (count && !start_time) start_time = 0;
				const version = this[VERSION_PROPERTY];
				if (start_time < version) {
					options.noRetain = true; // we are sending the current version from history, so don't double send
					// start time specified, get the audit history for this record
					const history = [];
					let next_version = version;
					do {
						const key = [next_version, table_id, id];
						//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
						//await audit_store.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
						const audit_entry = audit_store.get(key);
						if (audit_entry) {
							history.push({ id, timestamp: next_version, ...audit_entry });
							next_version = audit_entry.lastVersion;
						} else break;
						if (count) count--;
					} while (next_version > start_time && count !== 0);
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					subscription.startTime = version; // make sure we don't re-broadcast the current version that we already sent
				} else if (!options.noRetain) {
					// if retain and it exists, send the current value first
					if (this.doesExist()) subscription.send({ id, timestamp: this[VERSION_PROPERTY], value: this });
				}
			}
			if (options.listener) subscription.on('data', options.listener);
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
			this.#writePublish(message, options);
		}
		#writePublish(message, options?) {
			const txn_time = this[TRANSACTIONS_PROPERTY].timestamp;
			const id = this[ID_PROPERTY] || null;
			let completion;
			let publish_prepared;
			this[DB_TXN_PROPERTY].addWrite({
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
							if (this.constructor.Source?.prototype.publish) {
								const source = this.constructor.Source.getResource(id, this);
								if (source?.then)
									completion = source.then((source) => {
										this[SOURCE_PROPERTY] = source;
										return source.publish(message, options);
									});
								else {
									this[SOURCE_PROPERTY] = source;
									completion = source.publish(message, options);
								}
							}
						}
					}

					const existing_record = retries > 0 ? primary_store.get(id) : this[RECORD_PROPERTY];
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

		static async publish(message, options?) {
			const publishing_resource = new this(null, this);
			return publishing_resource.publish(message, options);
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
	}
	const prototype = TableResource.prototype;
	prototype[DB_TXN_PROPERTY] = immediateTransaction;
	prototype[INCREMENTAL_UPDATE] = true; // default behavior
	if (expiration_ms) TableResource.setTTLExpiration(expiration_ms);
	return TableResource;
	function assignDBTxn(resource) {
		let db_txn = resource[TRANSACTIONS_PROPERTY].find((txn) => txn.dbPath === database_path);
		if (!db_txn) {
			db_txn = new DatabaseTransaction(primary_store, resource[CONTEXT_PROPERTY]?.user, audit_store);
			db_txn.dbPath = database_path;
			resource[TRANSACTIONS_PROPERTY].push(db_txn);
		}
		return (resource[DB_TXN_PROPERTY] = db_txn);
	}
	function updateIndices(id, existing_record, record?) {
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
	}
	/*
	Here we write the deletion count for our thread id
	 */
	function record_deletion() {
		if (!deletion_count) deletion_count = primary_store.get([DELETION_COUNT_KEY, threadId]) || 0;
		deletion_count++;
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
function isEqual(a, b) {
	let count = 0;
	if ((a && typeof a) !== (b && typeof b)) return false;
	for (const key in a) {
		const valueA = a[key];
		if (valueA === NOT_COPIED_YET) continue; // if it was not copied yet, it can't be different
		const valueB = b[key];
		if (valueA && typeof valueA === 'object' && valueB && typeof valueB === 'object') {
			if (valueA instanceof Array) {
				if (!isEqualArray(valueA, valueB)) return false;
			} else {
				if (!isEqual(valueA, valueB)) return false;
			}
		} else if (valueA !== valueB) return false;
		count++;
	}
	return count === Object.keys(b).length;
}
function isEqualArray(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const valueA = a[i];
		const valueB = b[i];
		if (valueA && typeof valueA === 'object' && valueB && typeof valueB === 'object') {
			if (valueA instanceof Array) {
				if (!isEqualArray(valueA, valueB)) return false;
			} else {
				if (!isEqual(valueA, valueB)) return false;
			}
		} else if (valueA !== valueB) return false;
	}
	return true;
}
export function setServerUtilities(utilities) {
	server_utilities = utilities;
}
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
	return value;
}
