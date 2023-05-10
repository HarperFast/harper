import { CONFIG_PARAMS, OPERATIONS_ENUM } from '../utility/hdbTerms';
import { open, Database, asBinary } from 'lmdb';
import { getIndexedValues } from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import { ResourceInterface } from './ResourceInterface';
import { workerData } from 'worker_threads';
import { Resource } from './Resource';
import { DatabaseTransaction, immediateTransaction } from './DatabaseTransaction';
import { compareKeys, readKey, MAXIMUM_KEY } from 'ordered-binary';
import * as lmdb_terms from '../utility/lmdb/terms';
import * as env_mngr from '../utility/environment/environmentManager';
import { addSubscription, listenToCommits } from './transactionBroadcast';
import { getWritableRecord } from './WritableRecord';
import { handleHDBError, ClientError } from '../utility/errors/hdbError';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import * as signalling from '../utility/signalling';
import { SchemaEventMsg } from '../server/threads/itc';
import { databases } from './tableLoader';

const RANGE_ESTIMATE = 100000000;
env_mngr.initSync();
const b = Buffer.alloc(1);
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const LAZY_PROPERTY_ACCESS = { lazy: true };
const TXN_KEY = Symbol('transaction');

const INVALIDATED = 16;

export interface Table {
	primaryStore: Database;
	auditStore: Database;
	indices: Database[];
	databasePath: string;
	tableName: string;
	schemaName: string;
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
	let primary_key_attribute = {};
	let created_time_property, updated_time_property;
	for (const attribute of attributes) {
		if (attribute.assignCreatedTime || attribute.name === '__createdtime__') created_time_property = attribute.name;
		if (attribute.assignUpdatedTime || attribute.name === '__updatedtime__') updated_time_property = attribute.name;
		if (attribute.isPrimaryKey) primary_key_attribute = attribute;
	}
	class TableResource extends Resource {
		static name = CamelCase(table_name); // just for display/debugging purposes
		static primaryStore = primary_store;
		static auditStore = audit_store;
		static primaryKey = primary_key;
		static tableName = table_name;
		static indices = indices;
		static databasePath = database_path;
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
				try {
					const subscription = await Resource.subscribe?.({
						// this is used to indicate that all threads are (presumably) making this subscription
						// and we do not need to propagate events across threads (more efficient)
						crossThreads: false,
						// this is used to indicate that we want, if possible, immediate notification of writes
						// within the process (not supported yet)
						inTransactionUpdates: true,
					});

					for await (const event of subscription) {
						const updated_resource = new this(event.id, event.source);

						if (event.operation === 'put') updated_resource.#writePut(event.value);
						else if (event.operation === 'delete') updated_resource.#writeDelete();
					}
				} catch (error) {
					console.error(error);
				}
			})();
			return this;
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
								this.primaryStore.ifVersion(key, version, () => this.primaryStore.remove(key));
							}
						}
					}, expiration_ms);
				}
			}
		}

		/**
		 * Make a subscription to a query, to get notified of any changes to the specified data
		 * @param identifier
		 * @param options
		 */
		static async subscribe(identifier, options?) {
			let key;
			if (typeof identifier === 'object') {
				if (options) key = identifier.conditions[0].attribute;
				else {
					options = identifier;
					key = null;
				}
			} else key = identifier;
			if (key === '' || key === '?')
				// TODO: Should this require special permission?
				key = null; // wildcard, get everything in table
			const subscription = addSubscription(
				this,
				key,
				function (id, audit_record) {
					//let result = await this.get(key);
					try {
						this.send({ id, ...audit_record });
					} catch (error) {
						console.error(error);
					}
				},
				options.startTime
			);
			if (options.listener) subscription.on('data', options.listener);
			return subscription;
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

		table: any;
		dbTxn: DatabaseTransaction;
		parent: Resource;
		lmdbTxn: any;
		record: any;
		changes: any;
		lastModificationTime = 0;
		static Source: typeof Resource;

		constructor(identifier, resource_info) {
			// coerce if we know this is supposed to be a number
			super(identifier, resource_info);
			if (this.transactions) assignDBTxn(this);
			if (primary_key_attribute.is_number && this.id != null) this.id = +this.id;
		}
		updateModificationTime(latest = Date.now()) {
			if (latest > this.lastModificationTime) {
				this.lastModificationTime = latest;
				if (this.parent?.updateModificationTime) this.parent.updateModificationTime(latest);
			}
		}

		async loadRecord() {
			// TODO: determine if we use lazy access properties
			const env_txn = this.dbTxn;
			let entry = primary_store.getEntry(this.id, { transaction: env_txn.getReadTxn() });
			if (entry) {
				if (entry.version > this.lastModificationTime) this.updateModificationTime(entry.version);
				this.version = entry.version;
				this.record = entry.value;
				if (this.version < 0 || this.record?.__invalidated__) entry = null;
			}
			if (!entry) {
				if (this.constructor.Source?.prototype.get) this.record = this.getFromSource(this.record, this.version);
				return this.record; // might be a promise
			}
			/*
			if (record) {
				record[TXN_KEY] = this;
				const availability = record.__availability__;
				if (availability?.cached & INVALIDATED) {
					// TODO: If cold storage/alternate storage is available, retrieve from there

					if (availability.residence) {
						// TODO: Implement retrieval from other nodes once we have horizontal caching
					}
					if (this.constructor.Source) return this.getFromSource(identifier, record);
				} else if (expiration_ms && expiration_ms < Date.now() - this.lastModificationTime) {
					// TTL/expiration has some open questions, is it tenable to do it with replication?
					// What if there is no source?
					if (this.constructor.Source) return this.getFromSource(identifier, record);
				}
				return record;
			}*/
		}

		/**
		 * This retrieves the record as a frozen object for this resource. Alternately, provide a property name to
		 * retrieve the data
		 * @param propertyOrQuery - If included, specifies a property to return or query to perform on the record
		 */
		get(propertyOrQuery?: string | object) {
			const record = this.record;
			if (typeof propertyOrQuery === 'string') {
				if (this.changes && propertyOrQuery in this.changes) return this.changes[propertyOrQuery];
				return record?.[propertyOrQuery];
			}
			// if there is no record, we want to return undefined, but if there are changes and a record, merge them
			if (this.changes && record) return Object.assign(record, this.changes);
			return record;
		}

		async set(property?: string, value: any) {
			if (!this.changes) this.changes = {};
			this.changes[property] = value;
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
		 * Start updating a record. The returned record will be "writable" record, which records changes which are written
		 * once the corresponding transaction is committed. These changes can (eventually) include CRDT type operations.
		 * @param record This can be a record returned from get or a record id.
		 */
		update(record) {
			const start_updating = (record_data) => {
				// maybe make this a map so if the record is already updating, return the same one
				const record = getWritableRecord(record_data);
				const env_txn = this.dbTxn;
				// record in the list of updating records so it can be written to the database when we commit
				if (!env_txn.updatingRecords) env_txn.updatingRecords = [];
				env_txn.updatingRecords.push({ resource: this, record });
				return record;
			};
			// handle the case of the argument being a record
			if (typeof record === 'object' && record) {
				return start_updating(record);
			} else {
				// handle the case of the argument being a key
				return this.get(record).then(start_updating);
			}
		}

		/**
		 * This will be used to record that a record is being resolved
		 */
		async getFromSource(existing_record, existing_version) {
			const invalidated_record = { __invalidated__: true };
			if (this.record) Object.assign(invalidated_record, existing_record);
			const source = new this.constructor.Source(this.id, this);
			// TODO: We want to eventually use a "direct write" method to directly write to the locations
			// of the record in place in the database, which requires a reserved space in the random access structures
			// it is important to remember that this is _NOT_ part of the current transaction; nothing is changing
			// with the canonical data, we are simply fulfilling our local copy of the canonical data, but still don't
			// want a timestamp later than the current transaction
			const version = existing_version || source.lastModificationTime || this.transactions.timestamp;
			primary_store.put(this.id, invalidated_record, version, existing_version);
			await source.loadRecord();
			const updated_record = await source.get();
			if (updated_record) {
				updated_record[primary_key] = this.id;
				// don't wait on this, we don't actually care if it fails, that just means there is even
				// a newer entry going in the cache in the future
				primary_store.put(this.id, updated_record, version, existing_version);
			} else primary_store.remove(this.id, existing_version);
			return updated_record;
		}
		invalidate(partial_record) {
			if (!partial_record && Object.keys(indices).length > 0) partial_record = {};
			if (partial_record) {
				partial_record.__invalidated__ = true;
				this.#writePut(partial_record);
			} else this.#writeDelete();
		}

		/**
		 * Store the provided record data into the current resource. This is not written
		 * until the corresponding transaction is committed. This will either immediately fail (synchronously) or always
		 * succeed. That doesn't necessarily mean it will "win", another concurrent put could come "after" (monotonically,
		 * even if not chronologically) this one.
		 * @param record
		 * @param options
		 */
		async put(record, options): void {
			record[primary_key] = this.id; // ensure that the id is in the record

			if (attributes && !options?.noValidation) {
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
									if (typeof value !== 'number' && typeof value !== 'string')
										(validation_errors || (validation_errors = [])).push(
											`Property ${attribute.name} must be a string or number`
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
			if (this.constructor.Source?.prototype.put) {
				const source = (this.source = this.constructor.Source.getResource(this.id, this));
				await source.loadRecord();
				await source.put(record, options);
			}
			this.#writePut(record);
		}
		#writePut(record) {
			const env_txn = this.dbTxn || immediateTransaction;

			// use optimistic locking to only commit if the existing record state still holds true.
			// this is superior to using an async transaction since it doesn't require JS execution
			//  during the write transaction.
			const txn_time = this.transactions?.timestamp || immediateTransaction.timestamp;
			if (TableResource.updatedTimeProperty) record[TableResource.updatedTimeProperty] = txn_time;
			if (TableResource.createdTimeProperty && !this.record) record[TableResource.createdTimeProperty] = txn_time;
			env_txn.addWrite({
				key: this.id,
				store: primary_store,
				txnTime: txn_time,
				lastVersion: this.version,
				commit: (retry) => {
					let existing_record = this.record;
					if (retry) {
						const existing_entry = primary_store.getEntry(this.id);
						existing_record = existing_entry?.value;
						this.updateModificationTime(existing_entry?.version);
					}
					const had_existing = existing_record;
					if (!existing_record) {
						existing_record = {};
					}

					if (this.lastModificationTime > txn_time) {
						// This is not an error condition in our world of last-record-wins
						// replication. If the existing record is newer than it just means the provided record
						// is, well... older. And newer records are supposed to "win" over older records, and that
						// is normal, non-error behavior. So we still record an audit entry
						return {
							// return the audit record that should be recorded
							operation: 'put',
							value: record,
							// TODO: What should this be?
							lastUpdate: this.lastModificationTime,
						};
					}

					primary_store.put(this.id, record, txn_time);
					updateIndices(this.id, existing_record, record);
					return {
						// return the audit record that should be recorded
						operation: 'put',
						value: record,
					};
				},
			});
		}

		async delete(options): boolean {
			if (!this.record) return false;
			if (this.constructor.Source?.prototype.delete) {
				const source = (this.source = this.constructor.Source.getResource(this.id, this));
				await source.loadRecord();
				await source.delete(options);
			}
			this.#writeDelete();
		}
		#writeDelete() {
			const env_txn = this.dbTxn;
			const txn_time = this.transactions.timestamp;
			env_txn.addWrite({
				key: this.id,
				store: primary_store,
				txnTime: txn_time,
				lastVersion: this.version,
				commit: (retry) => {
					let existing_record = this.record;
					if (retry) {
						const existing_entry = primary_store.getEntry(this.id);
						existing_record = existing_entry?.value;
						this.updateModificationTime(existing_entry?.version);
					}
					updateIndices(this.id, existing_record);
					primary_store.remove(this.id);
					return {
						// return the audit record that should be recorded
						operation: 'delete',
					};
				},
			});
			return true;
		}
		static transact(callback) {
			if (this.transactions) return callback(this);
			return super.transact((TableTxn) => {
				assignDBTxn(TableTxn);
				return callback(TableTxn);
			});
		}
		transact(callback) {
			if (this.transactions) return callback(this);
			return super.transact(() => {
				assignDBTxn(this);
				return callback(this);
			});
		}

		static search(query, options?): AsyncIterable<any> {
			if (!this.transactions) return this.transact((txn_resource) => txn_resource.search(query, options));
			if (query == null) {
				// TODO: May have different semantics for /Table vs /Table/
				query = []; // treat no query as a query for everything
			}
			const reverse = query.reverse;
			let conditions = query.conditions || query;
			for (const condition of conditions) {
				const attribute = attributes.find((attribute) => attribute.name == condition.attribute);
				if (!attribute) {
					throw handleHDBError(new Error(), `${condition.attribute} is not a defined attribute`, 404);
				}
				if (attribute.is_number)
					// convert to a number if that is expected
					condition.value = +condition.value;
			}
			// Sort the conditions by narrowest to broadest. Note that we want to do this both for intersection where
			// it allows us to do minimal filtering, and for union where we can return the fastest results first
			// in an iterator/stream.
			conditions = sortBy(conditions, (condition) => {
				if (condition.estimated_count === undefined) {
					// skip if it is cached
					const search_type = condition.comparator || condition.search_type;
					if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS) {
						// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
						const index = indices[condition.attribute];
						condition.estimated_count = index ? index.getValuesCount(condition.value) : Infinity;
					} else if (
						search_type === lmdb_terms.SEARCH_TYPES.CONTAINS ||
						search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH
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
			const read_txn = this.dbTxn.getReadTxn();
			read_txn.use();

			// both AND and OR start by getting an iterator for the ids for first condition
			const first_search = conditions[0];
			let records;
			if (!first_search) {
				records = primary_store
					.getRange(
						reverse ? { end: false, reverse: true, transaction: read_txn } : { start: false, transaction: read_txn }
					)
					.map(({ value }) => value);
			} else {
				let ids = idsForCondition(first_search, read_txn, reverse);
				// and then things diverge...
				if (!query.operator || query.operator.toLowerCase() === 'and') {
					// get the intersection of condition searches by using the indexed query for the first condition
					// and then filtering by all subsequent conditions
					const filters = conditions.slice(1).map(filterByType);
					const filters_length = filters.length;
					records = ids.map((id) => primary_store.get(id, { transaction: read_txn, lazy: true }));
					if (filters_length > 0)
						records = records.filter((record) => {
							for (let i = 0; i < filters_length; i++) {
								if (!filters[i](record)) return false; // didn't match filters
							}
							return true;
						});
				} else {
					//get the union of ids from all condition searches
					for (let i = 1; i < conditions.length; i++) {
						const condition = conditions[i];
						// might want to lazily execute this after getting to this point in the iteration
						const next_ids = idsForCondition(condition, read_txn, reverse);
						ids = ids.concat(next_ids);
					}
					const returned_ids = new Set();
					const offset = query.offset || 0;
					ids = ids.filter((id) => {
						if (returned_ids.has(id))
							// skip duplicates
							return false;
						returned_ids.add(id);
						return true;
					});
					records = ids.map((id) => primary_store.get(id, { transaction: read_txn, lazy: true }));
				}
			}
			if (query.offset || query.limit !== undefined)
				records = records.slice(
					query.offset,
					query.limit !== undefined ? (query.offset || 0) + query.limit : undefined
				);
			const select = query.select;
			if (select)
				records = records.map((record) => {
					const selected = {};
					for (let i = 0, l = select.length; i < l; i++) {
						const key = select[i];
						selected[key] = record[key];
					}
					return selected;
				});
			records.onDone = () => {
				read_txn.done();
			};
			return records;
		}
		subscribe(options) {
			const subscription = addSubscription(
				this.constructor,
				this.id,
				function (id, audit_record) {
					//let result = await this.get(key);
					try {
						console.log({ audit_record });
						this.send({ id, ...audit_record });
					} catch (error) {
						console.error(error);
					}
				},
				options.startTime
			);
			if (options.listener) subscription.on('data', options.listener);
			if (!options.noRetain && this.record) subscription.send({ value: this.record });
			return subscription;
		}

		/**
		 * Publishing a message to a record adds an (observable) entry in the audit log, but does not change
		 * the record at all. This entries should be replicated and trigger subscription listeners.
		 * @param id
		 * @param message
		 * @param options
		 */
		async publish(message, options) {
			const txn_time = this.transactions.timestamp;
			let source_completion;
			if (!this.source && this.constructor.Source?.prototype.publish) {
				this.source = await this.constructor.Source.getResource(this.id, this);
				source_completion = this.source.publish(message, { target: this });
			}

			this.dbTxn.addWrite({
				store: primary_store,
				key: this.id,
				txnTime: txn_time,
				lastVersion: this.version,
				commit: (retries) => {
					// just need to update the version number of the record so it points to the latest audit record
					// but have to update the version number of the record
					// TODO: would be faster to have a dedicated lmdb-js function for just updating the version number
					const existing_record = retries > 0 ? primary_store.get(this.id) : this.record;
					primary_store.put(this.id, existing_record ?? null, txn_time);
					// messages are recorded in the audit entry
					return {
						operation: 'message',
						value: message,
						completion: source_completion,
					};
				},
			});
		}
		static async addAttribute(attribute) {
			// TODO: validation
			this.attributes.push(attribute);
			await dbis_db.put(this.tableName + '/' + attribute.name, attribute);
			const dbi_name = table_name + '/' + attribute.name;
			const dbi_init = new OpenDBIObject(true, false);
			if (attribute.indexed) this.indices[attribute.name] = this.primaryStore.openDB(dbi_name, dbi_init);
			signalling.signalSchemaChange(
				new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_ATTRIBUTE, database_name, table_name, attribute.name)
			);
		}
		static async removeAttribute(name) {}
	}
	const prototype = TableResource.prototype;
	prototype.record = null;
	prototype.changes = null;
	prototype.dbTxn = immediateTransaction;
	for (const attribute of attributes) {
		const name = attribute.name;
		if (prototype[name] === undefined) {
			Object.defineProperty(prototype, name, {
				get() {
					// TODO: Make an eval version of this that is faster
					if (this.changes && this.changes[name] !== undefined) return this.changes[name];
					return this.record?.[name];
				},
				set(value) {
					if (!this.changes) this.changes = {};
					this.changes[name] = value;
				},
			});
		}
	}
	return TableResource;
	function idsForCondition(search_condition, transaction, reverse) {
		let start;
		let end, inclusiveEnd, exclusiveStart, filter;
		const comparator = search_condition.comparator;
		switch (ALTERNATE_COMPARATOR_NAMES[comparator] || comparator) {
			case 'lt':
				start = true;
				end = search_condition.value;
				break;
			case 'lte':
				start = true;
				end = search_condition.value;
				inclusiveEnd = true;
				break;
			case 'gt':
				start = search_condition.value;
				exclusiveStart = true;
				break;
			case 'gte':
				start = search_condition.value;
				break;
			case lmdb_terms.SEARCH_TYPES.EQUALS:
			case undefined:
				start = search_condition.value;
				end = search_condition.value;
				inclusiveEnd = true;
		}
		if (reverse) {
			let new_end = start;
			start = end;
			end = new_end;
			new_end = !exclusiveStart;
			exclusiveStart = !inclusiveEnd;
			inclusiveEnd = new_end;
		}
		const index = search_condition.attribute === primary_key ? primary_store : indices[search_condition.attribute];
		if (!index) {
			throw handleHDBError(
				new Error(),
				`${search_condition.attribute} is not indexed, can not search for this attribute`,
				404
			);
		}
		const isPrimaryKey = search_condition.attribute === primary_key;
		const range_options = { start, end, inclusiveEnd, exclusiveStart, values: !isPrimaryKey, transaction, reverse };
		if (isPrimaryKey) {
			return index.getRange(range_options);
		} else {
			return index.getRange(range_options).map(({ value }) => value);
		}
	}
	function assignDBTxn(resource) {
		let db_txn = resource.transactions.find((txn) => txn.dbPath === database_path);
		if (!db_txn) {
			db_txn = new DatabaseTransaction(primary_store, resource.request?.user, audit_store);
			db_txn.dbPath = database_path;
			resource.transactions.push(db_txn);
		}
		resource.dbTxn = db_txn;
	}
	function updateIndices(id, existing_record, record?) {
		// iterate the entries from the record
		// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it can be
		// inside a write transaction
		// TODO: Make an array version of indices that is faster
		for (const key in indices) {
			const index = indices[key];
			const value = record?.[key];
			const existing_value = existing_record?.[key];
			if (value === existing_value) {
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
}

/**
 *
 * @param {SearchObject} search_object
 * @returns {({}) => boolean}
 */
export function filterByType(search_object) {
	const search_type = search_object.comparator;
	const attribute = search_object.attribute;
	const value = search_object.value;

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			return (record) => record[attribute] === value;
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return (record) => typeof record[attribute] === 'string' && record[attribute].includes(value);
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].endsWith(value);
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].startsWith(value);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			return (record) => {
				const value = record[attribute];
				return compareKeys(value, value[0]) >= 0 && compareKeys(value, value[1]) <= 0;
			};
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			return (record) => compareKeys(record[attribute], value) > 0;
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], value) >= 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case 'lt':
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			return (record) => compareKeys(record[attribute], value) < 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], value) <= 0;
		default:
			return Object.create(null);
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
const ALTERNATE_COMPARATOR_NAMES = {
	'greater_than': 'gt',
	'greater_than_equal': 'gte',
	'less_than': 'lt',
	'less_than_equal': 'lte',
	'>': 'gt',
	'>=': 'gte',
	'<': 'lt',
	'<=': 'lte',
};

function noop() {
	// prefetch callback
}
export function snake_case(camelCase: string) {
	return (
		camelCase[0].toLowerCase() +
		camelCase
			.slice(1)
			.replace(/[a-z][A-Z][a-z]/g, (letters) => letters[0] + '_' + letters[1].toLowerCase() + letters.slice(2))
	);
}

export function CamelCase(snake_case) {
	return snake_case
		.split('_')
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join('');
}
export function lowerCamelCase(snake_case) {
	return snake_case
		.split('_')
		.map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
		.join('');
}
