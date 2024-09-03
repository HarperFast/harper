/**
 * This module provides the main table implementation of the Resource API, providing full access to HarperDB
 * tables through the interface defined by the Resource class. This module is responsible for handling these
 * table-level interactions, loading records, updating records, querying, and more.
 */

import { CONFIG_PARAMS, OPERATIONS_ENUM, SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME } from '../utility/hdbTerms';
import { Database, SKIP } from 'lmdb';
import { getIndexedValues, getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { sortBy } from 'lodash';
import {
	Query,
	ResourceInterface,
	SubscriptionRequest,
	Id,
	Context,
	Condition,
	Sort,
	SubSelect,
} from './ResourceInterface';
import { CONTEXT, ID_PROPERTY, RECORD_PROPERTY, Resource, IS_COLLECTION } from './Resource';
import { DatabaseTransaction, ImmediateTransaction } from './DatabaseTransaction';
import * as env_mngr from '../utility/environment/environmentManager';
import { addSubscription } from './transactionBroadcast';
import { handleHDBError, ClientError, ServerError } from '../utility/errors/hdbError';
import * as signalling from '../utility/signalling';
import { SchemaEventMsg, UserEventMsg } from '../server/threads/itc';
import { databases, table } from './databases';
import {
	searchByIndex,
	findAttribute,
	estimateCondition,
	flattenKey,
	COERCIBLE_OPERATORS,
	executeConditions,
} from './search';
import logger from '../utility/logging/logger';
import { Addition, assignTrackedAccessors, deepFreeze, hasChanges, OWN_DATA } from './tracked';
import { transaction } from './transaction';
import { MAXIMUM_KEY, writeKey, compareKeys } from 'ordered-binary';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads';
import { readAuditEntry } from './auditStore';
import { autoCast, convertToMS } from '../utility/common_utils';
import { getUpdateRecord, PENDING_LOCAL_TIME } from './RecordEncoder';
import { recordAction, recordActionBinary } from './analytics';
import { rebuildUpdateBefore } from './crdt';
import { appendHeader } from '../server/serverHelpers/Headers';
type Attribute = {
	name: string;
	type: string;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	expiresAt?: boolean;
	isPrimaryKey?: boolean;
};
type Entry = {
	key: any;
	value: any;
	version: number;
	localTime: number;
	expiresAt: number;
	deref?: () => any;
};

const NULL_WITH_TIMESTAMP = new Uint8Array(9);
NULL_WITH_TIMESTAMP[8] = 0xc0; // null
let server_utilities;
let node_name: string;
const RECORD_PRUNING_INTERVAL = 60000; // one minute
const DELETED_RECORD_EXPIRATION = 86400000; // one day for non-audit records that have been deleted
env_mngr.initSync();
const LMDB_PREFETCH_WRITES = env_mngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);
const LOCK_TIMEOUT = 10000;
const VERSION_PROPERTY = Symbol.for('version');
const INCREMENTAL_UPDATE = Symbol.for('incremental-update');
const ENTRY_PROPERTY = Symbol('entry');
const SAVE_MODE = Symbol('is-saving');
const SAVING_FULL_UPDATE = 1;
const SAVING_CRDT_UPDATE = 2;
const LOADED_FROM_SOURCE = Symbol('loaded-from-source');
const NOTIFICATION = { isNotification: true, ensureLoaded: false };
const INVALIDATED = 1;
const EVICTED = 8; // note that 2 is reserved for timestamps
const TEST_WRITE_KEY_BUFFER = Buffer.allocUnsafeSlow(8192);
const MAX_KEY_BYTES = 1978;
const FULL_PERMISSIONS = {
	read: true,
	insert: true,
	update: true,
	delete: true,
	isSuperUser: true,
};
export interface Table {
	primaryStore: Database;
	auditStore: Database;
	indices: {};
	databasePath: string;
	tableName: string;
	databaseName: string;
	attributes: any[];
	primaryKey: string;
	replicate?: boolean;
	subscriptions: Map<any, Function[]>;
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
		sealed,
		replicate,
	} = options;
	let { expirationMS: expiration_ms, evictionMS: eviction_ms, audit, trackDeletes: track_deletes } = options;
	let { attributes } = options;
	if (!attributes) attributes = [];
	const updateRecord = getUpdateRecord(primary_store, table_id, audit_store);
	let source_load: any; // if a source has a load function (replicator), record it here
	let has_source_get: any;
	let primary_key_attribute: Attribute = {};
	let last_eviction_completion: Promise<void> = Promise.resolve();
	let created_time_property: Attribute, updated_time_property: Attribute, expires_at_property: Attribute;
	for (const attribute of attributes) {
		if (attribute.assignCreatedTime || attribute.name === '__createdtime__') created_time_property = attribute;
		if (attribute.assignUpdatedTime || attribute.name === '__updatedtime__') updated_time_property = attribute;
		if (attribute.expiresAt) expires_at_property = attribute;
		if (attribute.isPrimaryKey) primary_key_attribute = attribute;
	}
	let delete_callback_handle: { remove: () => void };
	let prefetch_ids = [];
	let prefetch_callbacks = [];
	let until_next_prefetch = 1;
	let non_prefetch_sequence = 2;
	let apply_to_sources = {};
	let apply_to_sources_intermediate = {};
	let cleanup_interval = 86400000;
	let last_cleanup_interval: NodeJS.Timeout;
	let cleanup_timer: NodeJS.Timeout;
	let property_resolvers: any;
	let has_relationships = false;
	let last_entry;
	let running_record_expiration: boolean;
	const residency_list_to_id = new Map();
	const residency_id_to_list = new Map();
	let id_incrementer: BigInt64Array;
	let replicate_to_count;
	const database_replications = env_mngr.get(CONFIG_PARAMS.REPLICATION_DATABASES);
	if (Array.isArray(database_replications)) {
		for (const db_replication of database_replications) {
			if (db_replication.name === database_name && db_replication.replicateTo >= 0) {
				replicate_to_count = db_replication.replicateTo;
				break;
			}
		}
	}
	const RangeIterable = primary_store.getRange({ start: false, end: false }).constructor;
	const MAX_PREFETCH_SEQUENCE = 10;
	const MAX_PREFETCH_BUNDLE = 6;
	if (audit) addDeleteRemoval();
	class TableResource extends Resource {
		static name = table_name; // for display/debugging purposes
		static primaryStore = primary_store;
		static auditStore = audit_store;
		static primaryKey = primary_key;
		static tableName = table_name;
		static tableId = table_id;
		static indices = indices;
		static audit = audit;
		static databasePath = database_path;
		static databaseName = database_name;
		static attributes = attributes;
		static replicate = replicate;
		static sealed = sealed;
		static createdTimeProperty = created_time_property;
		static updatedTimeProperty = updated_time_property;
		static propertyResolvers;
		static userResolvers = {};
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
				if (options.expiration || options.eviction || options.scanInterval) this.setTTLExpiration(options);
			}
			if (options?.intermediateSource) {
				source.intermediateSource = true;
				this.sources.unshift(source);
			} else {
				if (this.sources.some((source) => !source.intermediateSource))
					throw new Error('Can not have multiple canonical (non-intermediate) sources');
				this.sources.push(source);
			}
			has_source_get = has_source_get || (source.get && (!source.get.reliesOnPrototype || source.prototype.get));
			source_load = source_load || source.load;
			// These functions define how write operations are propagate to the sources.
			// We define the last source in the array as the "canonical" source, the one that can authoritatively
			// reject or accept a write. The other sources are "intermediate" sources that can also be
			// notified of writes and/or fulfill gets.
			const getApplyToIntermediateSource = (method) => {
				let sources = this.sources;
				sources = sources.filter(
					(source) =>
						source.intermediateSource &&
						source[method] &&
						(!source[method].reliesOnPrototype || source.prototype[method])
				);
				if (sources.length > 0) {
					if (sources.length === 1) {
						// the simple case, can directly call it
						const intermediate_source = sources[0];
						return (context, id, data) => {
							if (context?.source !== intermediate_source) return intermediate_source[method](id, data, context);
						};
					} else {
						return (context, id, data) => {
							// if multiple intermediate sources, call them in parallel
							const results = [];
							for (const source of sources) {
								if (context?.source === source) break;
								results.push(source[method](id, data, context));
							}
							return Promise.all(results);
						};
					}
				}
			};
			let canonical_source = this.sources[this.sources.length - 1];
			if (canonical_source.intermediateSource) canonical_source = {}; // don't treat intermediate sources as canonical
			const getApplyToCanonicalSource = (method) => {
				if (
					canonical_source[method] &&
					(!canonical_source[method].reliesOnPrototype || canonical_source.prototype[method])
				) {
					return (context, id, data) => {
						if (!context?.source) return canonical_source[method](id, data, context);
					};
				}
			};
			// define a set of methods for each operation so we can apply these in each write as part
			// of the commit
			apply_to_sources = {
				put: getApplyToCanonicalSource('put'),
				patch: getApplyToCanonicalSource('patch'),
				delete: getApplyToCanonicalSource('delete'),
				publish: getApplyToCanonicalSource('publish'),
				// note that invalidate event does not go to the canonical source, invalidate means that
				// caches are invalidated, which specifically excludes the canonical source from being affected.
			};
			apply_to_sources_intermediate = {
				put: getApplyToIntermediateSource('put'),
				patch: getApplyToIntermediateSource('patch'),
				delete: getApplyToIntermediateSource('delete'),
				publish: getApplyToIntermediateSource('publish'),
				invalidate: getApplyToIntermediateSource('invalidate'),
			};

			// External data source may provide a subscribe method, allowing for real-time proactive delivery
			// of data from the source to this caching table. This is generally greatly superior to expiration-based
			// caching since it much for accurately ensures freshness and maximizing caching time.
			// Here we subscribe the external data source if it is available, getting notification events
			// as they come in, and directly writing them to this table. We use the notification option to ensure
			// that we don't re-broadcast these as "requested" changes back to the source.
			(async () => {
				let user_role_update = false;
				let last_sequence_id;
				// perform the write of an individual write event
				const writeUpdate = async (event, context) => {
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
					const options = {
						residencyId: getResidencyId(event.residencyList),
						isNotification: true,
						ensureLoaded: false,
						nodeId: event.nodeId,
					};
					const resource: TableResource = await Table.getResource(event.id, context, options);
					switch (event.type) {
						case 'put':
							return resource._writeUpdate(value, true, options);
						case 'patch':
							return resource._writeUpdate(value, false, options);
						case 'delete':
							return resource._writeDelete(options);
						case 'publish':
							return resource._writePublish(value, options);
						case 'invalidate':
							return resource._writeInvalidate(options);
						case 'relocate':
							return resource._writeRelocate(options);
						default:
							logger.error?.('Unknown operation', event.type, event.id);
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
						let txn_in_progress;
						// we listen for events by iterating through the async iterator provided by the subscription
						for await (const event of subscription) {
							try {
								const first_write = event.type === 'transaction' ? event.writes[0] : event;
								if (!first_write) {
									logger.error?.('Bad subscription event', event);
									continue;
								}
								event.source = source;
								if (event.type === 'end_txn') {
									txn_in_progress?.resolve();
									if (event.localTime && last_sequence_id !== event.localTime) {
										if (event.remoteNodeIds?.length > 0) {
											// the key for tracking the sequence ids and txn times received from this node
											const seq_key = [Symbol.for('seq'), event.remoteNodeIds[0]];
											const existing_seq = dbis_db.get(seq_key);
											let node_states = existing_seq?.nodes;
											if (!node_states) {
												// if we don't have a list of nodes, we need to create one, with the main one using the existing seqId
												node_states = [];
											}
											// if we are not the only node in the list, we are getting proxied subscriptions, and we need
											// to track this separately
											// track the other nodes in the list
											for (const node_id of event.remoteNodeIds.slice(1)) {
												let node_state = node_states.find((existing_node) => existing_node.name === node_id);
												if (!node_state) {
													node_state = { id: node_id, seqId: 0 };
													node_states.push(node_state);
												}
												node_state.seqId = Math.max(existing_seq?.seqId ?? 1, event.localTime);
												if (node_id === event.nodeId) node_state.lastTxnTime = event.timestamp;
											}
											const seq_id = Math.max(existing_seq?.seqId ?? 1, event.localTime);
											dbis_db.put(seq_key, {
												seqId: seq_id,
												nodes: node_states,
											});
										}
										last_sequence_id = event.localTime;
									}
									if (event.onCommit) txn_in_progress?.committed.then(event.onCommit);
									continue;
								}
								if (txn_in_progress) {
									if (event.beginTxn) {
										// if we are starting a new transaction, finish the existing one
										txn_in_progress.resolve();
									} else {
										// write in the current transaction if one is in progress
										txn_in_progress.write_promises.push(writeUpdate(event, txn_in_progress));
										continue;
									}
								}
								const commit_resolution = transaction(event, () => {
									if (event.type === 'transaction') {
										// if it is a transaction, we need to individually iterate through each write event
										const promises = [];
										for (const write of event.writes) {
											try {
												promises.push(writeUpdate(write, event));
											} catch (error) {
												error.message += ' writing ' + JSON.stringify(write) + ' of event ' + JSON.stringify(event);
												throw error;
											}
										}
										return Promise.all(promises);
									} else if (event.type === 'define_schema') {
										// ensure table has the provided attributes
										const updated_attributes = this.attributes.slice(0);
										let has_changes: boolean;
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
									} else {
										if (event.beginTxn) {
											// if we are beginning a new transaction, we record the current
											// event/context as transaction in progress and then future events
											// are applied with that context until the next transaction begins/ends
											txn_in_progress = event;
											txn_in_progress.write_promises = [writeUpdate(event, event)];
											return new Promise((resolve) => {
												// callback for when this transaction is finished (will be called on next txn begin/end).
												txn_in_progress.resolve = () => resolve(Promise.all(txn_in_progress.write_promises)); // and make sure we wait for the write update to finish
											});
										}
										return writeUpdate(event, event);
									}
								});
								if (txn_in_progress) txn_in_progress.committed = commit_resolution;
								if (user_role_update && commit_resolution && !commit_resolution?.waitingForUserChange) {
									// if the user role changed, asynchronously signal the user change (but don't block this function)
									commit_resolution.then(() => signalling.signalUserChange(new UserEventMsg(process.pid)));
									commit_resolution.waitingForUserChange = true; // only need to send one signal per transaction
								}

								if (event.onCommit) {
									if (commit_resolution) commit_resolution.then(event.onCommit);
									else event.onCommit();
								}
							} catch (error) {
								logger.error?.('error in subscription handler', error);
							}
						}
					}
				} catch (error) {
					logger.error?.(error);
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
		static getResource(id: Id, request: Context, resource_options?: any): Promise<TableResource> | TableResource {
			const resource: TableResource = super.getResource(id, request, resource_options) as any;
			if (id != null) {
				checkValidId(id);
				try {
					if (resource.hasOwnProperty(RECORD_PROPERTY)) return resource; // already loaded, don't reload, current version may have modifications
					if (typeof id === 'object' && id && !Array.isArray(id)) {
						throw new Error(`Invalid id ${JSON.stringify(id)}`);
					}
					const sync = !resource_options?.async || primary_store.cache?.get(id);
					const txn = txnForContext(request);
					const read_txn = txn.getReadTxn();
					if (read_txn?.isDone) {
						throw new Error('You can not read from a transaction that has already been committed/aborted');
					}
					return loadLocalRecord(
						id,
						request,
						{ transaction: read_txn, ensureLoaded: resource_options?.ensureLoaded },
						sync,
						(entry) => {
							if (entry) {
								updateResource(resource, entry);
							} else resource[RECORD_PROPERTY] = null;
							if (request.onlyIfCached && request.noCacheStore) {
								// don't go into the loading from source condition, but HTTP spec says to
								// return 504 (rather than 404) if there is no content and the cache-control header
								// dictates not to go to source (and not store new value)
								if (!resource.doesExist()) throw new ServerError('Entry is not cached', 504);
							} else if (resource_options?.ensureLoaded) {
								const loading_from_source = ensureLoadedFromSource(id, entry, request, resource);
								if (loading_from_source) {
									txn?.disregardReadTxn(); // this could take some time, so don't keep the transaction open if possible
									resource[LOADED_FROM_SOURCE] = true;
									return when(loading_from_source, (entry) => {
										updateResource(resource, entry);
										return resource;
									});
								}
							}
							return resource;
						}
					);
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
		static getNewId(): any {
			const type = primary_key_attribute?.type;
			// the default Resource behavior is to return a GUID, but for a table we can return incrementing numeric keys if the type is (or can be) numeric
			if (type === 'String' || type === 'ID') return super.getNewId();
			if (!id_incrementer) {
				// if there is no id incrementer yet, we get or create one
				const id_allocation_entry = primary_store.getEntry(Symbol.for('id_allocation'));
				let id_allocation = id_allocation_entry?.value;
				let last_key;
				if (
					id_allocation &&
					id_allocation.nodeName === server.hostname &&
					(!hasOtherProcesses(primary_store) || id_allocation.pid === process.pid)
				) {
					// the database has an existing id allocation that we can continue from
					const starting_id = id_allocation.start;
					const ending_id = id_allocation.end;
					last_key = starting_id;
					// once it is loaded, we need to find the last key in the allocated range and start from there
					for (const key of primary_store.getKeys({ start: ending_id, end: starting_id, limit: 1, reverse: true })) {
						last_key = key;
					}
				} else {
					// we need to create a new id allocation
					id_allocation = createNewAllocation(id_allocation_entry?.version ?? null);
					last_key = id_allocation.start;
				}
				// all threads will use a shared buffer to atomically increment the id
				// first, we create our proposed incrementer buffer that will be used if we are the first thread to get here
				// and initialize it with the starting id
				id_incrementer = new BigInt64Array([BigInt(last_key) + 1n]);
				// now get the selected incrementer buffer, this is the shared buffer was first registered and that all threads will use
				id_incrementer = new BigInt64Array(primary_store.getUserSharedBuffer('id', id_incrementer.buffer));
				// and we set the maximum safe id to the end of the allocated range before we check for conflicting ids again
				id_incrementer.maxSafeId = id_allocation.end;
			}
			// this is where we actually do the atomic incrementation. All the threads should be pointing to the same
			// memory location of this incrementer, so we can be sure that the id is unique and sequential.
			const next_id = Number(Atomics.add(id_incrementer, 0, 1n));
			const async_id_expansion_threshold = type === 'Int' ? 0x200 : 0x100000;
			if (next_id + async_id_expansion_threshold >= id_incrementer.maxSafeId) {
				const updateEnd = (in_txn) => {
					// we update the end of the allocation range after verifying we don't have any conflicting ids in front of us
					id_incrementer.maxSafeId = next_id + (type === 'Int' ? 0x3ff : 0x3fffff);
					let id_after = (type === 'Int' ? Math.pow(2, 31) : Math.pow(2, 49)) - 1;
					const read_txn = in_txn ? undefined : primary_store.useReadTransaction();
					// get the latest id after the read transaction to make sure we aren't reading any new ids that we assigned from this node
					const newest_id = Number(id_incrementer[0]);
					for (const key of primary_store.getKeys({
						start: newest_id + 1,
						end: id_after,
						limit: 1,
						transaction: read_txn,
					})) {
						id_after = key;
					}
					read_txn?.done();
					const { value: updated_id_allocation, version } = primary_store.getEntry(Symbol.for('id_allocation'));
					if (id_incrementer.maxSafeId < id_after) {
						// note that this is just a noop/direct callback if we are inside the sync transaction
						// first check to see if it actually got updated by another thread
						if (updated_id_allocation.end > id_incrementer.maxSafeId - 100) {
							// the allocation was already updated by another thread
							return;
						}
						logger.info?.('New id allocation', next_id, id_incrementer.maxSafeId, version);
						primary_store.put(
							Symbol.for('id_allocation'),
							{
								start: updated_id_allocation.start,
								end: id_incrementer.maxSafeId,
								nodeName: server.hostname,
								pid: process.pid,
							},
							Date.now(),
							version
						);
					} else {
						// indicate that we have run out of ids in the allocated range, so we need to allocate a new range
						logger.warn?.(
							`Id conflict detected, starting new id allocation range, attempting to allocate to ${id_incrementer.maxSafeId}, but id of ${id_after} detected`
						);
						const id_allocation = createNewAllocation(version);
						// reassign the incrementer to the new range/starting point
						if (!id_allocation.alreadyUpdated) Atomics.store(id_incrementer, 0, BigInt(id_allocation.start + 1));
						// and we set the maximum safe id to the end of the allocated range before we check for conflicting ids again
						id_incrementer.maxSafeId = id_allocation.end;
					}
				};
				if (next_id + async_id_expansion_threshold === id_incrementer.maxSafeId) {
					setImmediate(updateEnd); // if we are getting kind of close to the end, we try to update it asynchronously
				} else if (next_id + 100 >= id_incrementer.maxSafeId) {
					logger.warn?.(
						`Synchronous id allocation required on table ${table_name}${
							type == 'Int'
								? ', it is highly recommended that you use Long or Float as the type for auto-incremented primary keys'
								: ''
						}`
					);
					// if we are very close to the end, synchronously update
					primary_store.transactionSync(() => updateEnd(true));
				}
				//TODO: Add a check to recordUpdate to check if a new id infringes on the allocated id range
			}
			return next_id;
			function createNewAllocation(expected_version) {
				// there is no id allocation (or it is for the wrong node name or used up), so we need to create one
				// start by determining the max id for the type
				const max_id = (type === 'Int' ? Math.pow(2, 31) : Math.pow(2, 49)) - 1;
				let safe_distance = max_id / 4; // we want to allocate ids in a range that is at least 1/4 of the total id space from ids in either direction
				let id_before: number, id_after: number;
				let complained = false;
				let last_key;
				let id_allocation;
				do {
					// we start with a random id and verify that there is a good gap in the ids to allocate a decent range
					last_key = Math.floor(Math.random() * max_id);
					id_allocation = {
						start: last_key,
						end: last_key + (type === 'Int' ? 0x400 : 0x400000),
						nodeName: server.hostname,
						pid: process.pid,
					};
					id_before = 0;
					// now find the next id before the last key
					for (const key of primary_store.getKeys({ start: last_key, limit: 1, reverse: true })) {
						id_before = key;
					}
					id_after = max_id;
					// and next key after
					for (const key of primary_store.getKeys({ start: last_key + 1, end: max_id, limit: 1 })) {
						id_after = key;
					}
					safe_distance *= 0.875; // if we fail, we try again with a smaller range, looking for a good gap without really knowing how packed the ids are
					if (safe_distance < 1000 && !complained) {
						complained = true;
						logger.error?.(
							`Id allocation in table ${table_name} is very dense, limited safe range of numbers to allocate ids in${
								type === 'Int'
									? ', it is highly recommended that you use Long or Float as the type for auto-incremented primary keys'
									: ''
							}`,
							last_key,
							id_before,
							id_after,
							safe_distance
						);
					}
					// see if we maintained an adequate distance from the surrounding ids
				} while (!(safe_distance < id_after - last_key && (safe_distance < last_key - id_before || id_before === 0)));
				// we have to ensure that the id allocation is atomic and multiple threads don't set different ids, so we use a sync transaction
				return primary_store.transactionSync(() => {
					// first check to see if it actually got set by another thread
					const updated_id_allocation = primary_store.getEntry(Symbol.for('id_allocation'));
					if ((updated_id_allocation?.version ?? null) == expected_version) {
						logger.info?.('Allocated new id range', id_allocation);
						primary_store.put(Symbol.for('id_allocation'), id_allocation, Date.now());
						return id_allocation;
					} else {
						logger.debug?.('Looks like ids were already allocated');
						return Object.assign({ alreadyUpdated: true }, updated_id_allocation.value);
					}
				});
			}
		}

		/**
		 * Set TTL expiration for records in this table. On retrieval, record timestamps are checked for expiration.
		 * This also informs the scheduling for record eviction.
		 * @param expiration_time Time in seconds until records expire (are stale)
		 * @param eviction_time Time in seconds until records are evicted (removed)
		 */
		static setTTLExpiration(expiration: number | { expiration: number; eviction?: number; scanInterval?: number }) {
			// we set up a timer to remove expired entries. we only want the timer/reaper to run in one thread,
			// so we use the first one
			if (typeof expiration === 'number') {
				expiration_ms = expiration * 1000;
				if (!eviction_ms) eviction_ms = 0; // by default, no extra time for eviction
			} else if (expiration && typeof expiration === 'object') {
				// an object with expiration times/options specified
				expiration_ms = expiration.expiration * 1000;
				eviction_ms = (expiration.eviction || 0) * 1000;
				cleanup_interval = expiration.scanInterval * 1000;
			} else throw new Error('Invalid expiration value type');
			if (expiration_ms < 0) throw new Error('Expiration can not be negative');
			// default to one quarter of the total eviction time, and make sure it fits into a 32-bit signed integer
			cleanup_interval = cleanup_interval || (expiration_ms + eviction_ms) / 4;
			scheduleCleanup();
		}

		static getResidencyRecord(id) {
			return dbis_db.get([Symbol.for('residency_by_id'), id]);
		}

		static setResidency(getResidency: (record: object, context: Context, previous_residency: string[]) => string[]) {
			TableResource.getResidency = getResidency;
		}
		static setResidencyById(getResidencyById: (id: Id) => string[]) {
			TableResource.getResidencyById = getResidencyById;
		}
		static getResidency(record: object, context: Context, previous_residency: string[]) {
			if (TableResource.getResidencyById) {
				return TableResource.getResidencyById(record[primary_key]);
			}
			let count = replicate_to_count;
			if (context.replicateTo != undefined) {
				// if the context specifies where we are replicating to, use that
				if (Array.isArray(context.replicateTo)) {
					return context.replicateTo.includes(server.hostname)
						? context.replicateTo
						: [server.hostname, ...context.replicateTo];
				}
				if (context.replicateTo >= 0) count = context.replicateTo;
			}
			if (count >= 0 && server.nodes) {
				// if we are given a count, choose nodes and return them
				const replicate_to = [server.hostname]; // start with ourselves, we should always be in the list
				if (previous_residency) {
					// if we have a previous residency, we should preserve it
					replicate_to.push(...previous_residency.slice(0, count));
				} else {
					// otherwise need to create a new list of nodes to replicate to, based on available nodes
					// randomize this to ensure distribution of data
					const starting_index = Math.floor(server.nodes.length * Math.random());
					replicate_to.push(...server.nodes.slice(starting_index, starting_index + count));
					const remaining_to_add = starting_index + count - server.nodes.length;
					if (remaining_to_add > 0) replicate_to.push(...server.nodes.slice(0, remaining_to_add));
				}
				return replicate_to;
			}
			return; // returning undefined will return the default residency of replicating everywhere
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
				for (const attribute of attributes) {
					dbis_db.remove(TableResource.tableName + '/' + attribute.name);
					const index = indices[attribute.name];
					index?.drop();
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

		/**
		 * This retrieves the data of this resource. By default, with no argument, just return `this`.
		 * @param query - If included, specifies a query to perform on the record
		 */
		get(query?: Query | string): Promise<object | void> | object | void {
			if (typeof query === 'string') return this.getProperty(query);
			if (this[IS_COLLECTION]) {
				return this.search(query);
			}
			if (this[ID_PROPERTY] === null) {
				if (query?.conditions) return this.search(query); // if there is a query, assume it was meant to be a root level query
				const record_count = TableResource.getRecordCount();
				return {
					// basically a describe call
					recordCount: record_count.recordCount,
					estimatedRecordRange: record_count.estimatedRange,
					records: './', // an href to the records themselves
					name: table_name,
					database: database_name,
					auditSize: audit_store?.getStats().entryCount,
					attributes,
				};
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
		allowRead(user, query) {
			const table_permission = getTablePermissions(user);
			if (table_permission?.read) {
				if (table_permission.isSuperUser) return true;
				const attribute_permissions = table_permission.attribute_permissions;
				const select = query?.select;
				if (attribute_permissions?.length > 0 || (has_relationships && select)) {
					// If attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					// or if there are relationships, we need to ensure that the user has permission to read from the related table
					// Note that if we do not have a select, we do not return any relationships by default.
					if (!query) query = {};
					if (select) {
						const attrs_for_type =
							attribute_permissions?.length > 0 && attributesAsObject(attribute_permissions, 'read');
						query.select = select
							.map((property) => {
								const property_name = property.name || property;
								if (!attrs_for_type || attrs_for_type[property_name]) {
									const related_table = property_resolvers[property_name]?.definition?.tableClass;
									if (related_table) {
										// if there is a related table, we need to ensure the user has permission to read from that table and that attributes are properly restricted
										if (!property.name) property = { name: property };
										if (!related_table.prototype.allowRead.call(null, user, property)) return false;
										if (!property.select) return property.name; // no select was applied, just return the name
									}
									return property;
								}
							})
							.filter(Boolean);
					} else {
						query.select = attribute_permissions
							.filter((attribute) => attribute.read && !property_resolvers[attribute.attribute_name])
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
		allowUpdate(user, updated_data: any) {
			const table_permission = getTablePermissions(user);
			if (table_permission?.update) {
				const attribute_permissions = table_permission.attribute_permissions;
				if (attribute_permissions?.length > 0) {
					// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					const attrs_for_type = attributesAsObject(attribute_permissions, 'update');
					for (const key in updated_data) {
						if (!attrs_for_type[key]) return false;
					}
					// if this is a full put operation that removes missing properties, we don't want to remove properties
					// that the user doesn't have permission to remove
					for (const permission of attribute_permissions) {
						const key = permission.attribute_name;
						if (!permission.update && !(key in updated_data)) {
							updated_data[key] = this.getProperty(key);
						}
					}
				}
				return checkContextPermissions(this[CONTEXT]);
			}
		}
		/**
		 * Determine if the user is allowed to create new data in the current resource
		 * @param user The current, authenticated user
		 * @param new_data
		 */
		allowCreate(user, new_data: {}) {
			if (this[IS_COLLECTION]) {
				const table_permission = getTablePermissions(user);
				if (table_permission?.insert) {
					const attribute_permissions = table_permission.attribute_permissions;
					if (attribute_permissions?.length > 0) {
						// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
						const attrs_for_type = attributesAsObject(attribute_permissions, 'insert');
						for (const key in new_data) {
							if (!attrs_for_type[key]) return false;
						}
						return checkContextPermissions(this[CONTEXT]);
					} else {
						return checkContextPermissions(this[CONTEXT]);
					}
				}
			} else {
				// creating *within* a record resource just means we are adding some data to a current record, which is
				// an update to the record, it is not an insert of a new record into the table, so not a table create operation
				// so does not use table insert permissions
				return this.allowUpdate(user, {});
			}
		}

		/**
		 * Determine if the user is allowed to delete from the current resource
		 * @param user The current, authenticated user
		 */
		allowDelete(user) {
			const table_permission = getTablePermissions(user);
			return table_permission?.delete && checkContextPermissions(this[CONTEXT]);
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
					if (Object.isFrozen(updates)) updates = Object.assign({}, updates);
					this[RECORD_PROPERTY] = {}; // clear out the existing record
					this[OWN_DATA] = updates;
				} else {
					own_data = this[OWN_DATA];
					if (own_data) updates = Object.assign(own_data, updates);
					this[OWN_DATA] = own_data = updates;
				}
			}
			this._writeUpdate(this[OWN_DATA], full_update);
			return this;
		}

		addTo(property, value) {
			if (typeof value === 'number' || typeof value === 'bigint') {
				if (this[SAVE_MODE] === SAVING_FULL_UPDATE) this.set(property, (+this.getProperty(property) || 0) + value);
				else {
					if (!this[SAVE_MODE]) this.update();
					this.set(property, new Addition(value));
				}
			} else {
				throw new Error('Can not add a non-numeric value');
			}
		}
		subtractFrom(property, value) {
			if (typeof value === 'number') {
				return this.addTo(property, -value);
			} else {
				throw new Error('Can not subtract a non-numeric value');
			}
		}
		getMetadata() {
			return this[ENTRY_PROPERTY];
		}

		invalidate() {
			this._writeInvalidate();
		}
		_writeInvalidate(options) {
			const context = this[CONTEXT];
			const id = this[ID_PROPERTY];
			checkValidId(id);
			const transaction = txnForContext(this[CONTEXT]);
			transaction.addWrite({
				key: id,
				store: primary_store,
				invalidated: true,
				entry: this[ENTRY_PROPERTY],
				before: apply_to_sources.invalidate?.bind(this, context, id),
				beforeIntermediate: apply_to_sources_intermediate.invalidate?.bind(this, context, id),
				commit: (txn_time, existing_entry) => {
					if (precedesExistingVersion(txn_time, existing_entry, options?.nodeId)) return;
					let partial_record = null;
					for (const name in indices) {
						if (!partial_record) partial_record = {};
						// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
						partial_record[name] = this.getProperty(name);
					}
					logger.trace?.(`Invalidating entry id: ${id}, timestamp: ${new Date(txn_time).toISOString()}`);

					updateRecord(
						id,
						partial_record,
						this[ENTRY_PROPERTY],
						txn_time,
						INVALIDATED,
						audit,
						{ user: context?.user, residencyId: options?.residencyId, nodeId: options?.nodeId },
						'invalidate'
					);
					// TODO: record_deletion?
				},
			});
		}
		_writeRelocate(options) {
			const context = this[CONTEXT];
			const id = this[ID_PROPERTY];
			checkValidId(id);
			const transaction = txnForContext(this[CONTEXT]);
			transaction.addWrite({
				key: id,
				store: primary_store,
				invalidated: true,
				entry: this[ENTRY_PROPERTY],
				before: apply_to_sources.relocate?.bind(this, context, id),
				beforeIntermediate: apply_to_sources_intermediate.relocate?.bind(this, context, id),
				commit: (txn_time, existing_entry) => {
					if (precedesExistingVersion(txn_time, existing_entry, options?.nodeId)) return;
					const residency = TableResource.getResidencyRecord(options.residencyId);
					let metadata = 0;
					let new_record = null;
					const existing_record = existing_entry?.value;
					if (residency && !residency.includes(server.hostname)) {
						for (const name in indices) {
							if (!new_record) new_record = {};
							// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
							new_record[name] = existing_record(name);
						}
						metadata = INVALIDATED;
					} else {
						new_record = existing_record;
					}

					logger.trace?.(`Relocating entry id: ${id}, timestamp: ${new Date(txn_time).toISOString()}`);

					updateRecord(
						id,
						new_record,
						this[ENTRY_PROPERTY],
						txn_time,
						metadata,
						audit,
						{
							user: context.user,
							residencyId: options.residencyId,
							nodeId: options.nodeId,
							expiresAt: options.expiresAt,
						},
						'relocate',
						false,
						null
					);
				},
			});
		}

		/**
		 * Record the relocation of an entry (when a record is moved to a different node)
		 * @param existing_entry
		 * @param entry
		 */
		static _recordRelocate(existing_entry, entry) {
			const context = {
				previousResidency: this.getResidencyRecord(existing_entry.residencyId),
				isRelocation: true,
			};
			const residency = this.getResidency(entry.value, context);
			let residency_id: number;
			if (residency) {
				if (!Array.isArray(residency)) {
					throw new Error('Residency must be an array, but was: ' + residency);
				}
				if (!residency.includes(server.hostname)) return; // if we aren't in the residency, we don't need to do anything, we are not responsible for storing this record
				residency_id = getResidencyId(residency);
			}
			const metadata = 0;
			const record = updateRecord(
				existing_entry.key,
				entry.value, // store the record we downloaded
				existing_entry,
				existing_entry.version, // version number should not change
				metadata,
				true,
				{ residencyId: residency_id, expiresAt: entry.expiresAt },
				'relocate',
				false,
				null // the audit record value should be empty since there are no changes to the actual data
			);
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
					return updateRecord(id, partial_record, entry, existing_version, EVICTED, null, null, null, true);
				}
			}
			primary_store.ifVersion(id, existing_version, () => {
				updateIndices(id, existing_record, null);
			});
			if (audit) {
				// update the record to null it out, maintaining the reference to the audit history
				return updateRecord(id, null, entry, existing_version, EVICTED, null, null, null, true);
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
		put(record): void {
			this.update(record, true);
		}
		patch(record_update: any): void {
			this.update(record_update, false);
		}
		// perform the actual write operation; this may come from a user request to write (put, post, etc.), or
		// a notification that a write has already occurred in the canonical data source, we need to update our
		// local copy
		_writeUpdate(record_update: any, full_update: boolean, options?: any) {
			const context = this[CONTEXT];
			const transaction = txnForContext(context);

			const id = this[ID_PROPERTY];
			checkValidId(id);
			const entry = this[ENTRY_PROPERTY];
			this[SAVE_MODE] = full_update ? SAVING_FULL_UPDATE : SAVING_CRDT_UPDATE; // mark that this resource is being saved so doesExist return true
			const write = {
				key: id,
				store: primary_store,
				entry,
				nodeName: context?.nodeName,
				validate: (txn_time) => {
					if (!record_update) record_update = this[OWN_DATA];
					if (full_update || (record_update && hasChanges(this[OWN_DATA] === record_update ? this : record_update))) {
						if (!context?.source) {
							transaction.checkOverloaded();
							this.validate(record_update, !full_update);
							if (updated_time_property) {
								record_update[updated_time_property.name] =
									updated_time_property.type === 'Date'
										? new Date(txn_time)
										: updated_time_property.type === 'String'
										? new Date(txn_time).toISOString()
										: txn_time;
							}
							if (full_update) {
								if (primary_key && record_update[primary_key] !== id) record_update[primary_key] = id;
								if (created_time_property) {
									if (entry?.value)
										record_update[created_time_property.name] = entry?.value[created_time_property.name];
									else
										record_update[created_time_property.name] =
											created_time_property.type === 'Date'
												? new Date(txn_time)
												: created_time_property.type === 'String'
												? new Date(txn_time).toISOString()
												: txn_time;
								}
								record_update = deepFreeze(record_update); // this flatten and freeze the record
							}
							// TODO: else freeze after we have applied the changes
						}
					} else {
						transaction.removeWrite(write);
					}
				},
				before: full_update
					? apply_to_sources.put // full update is a put, so we can use the put method if available
						? () => apply_to_sources.put(context, id, record_update)
						: null
					: apply_to_sources.patch // otherwise, we need to use the patch method if available
					? () => apply_to_sources.patch(context, id, record_update)
					: apply_to_sources.put // if this is incremental, but only have put, we can use that by generating the full record (at least the expected one)
					? () => apply_to_sources.put(context, id, deepFreeze(this))
					: null,
				beforeIntermediate: full_update
					? apply_to_sources_intermediate.put
						? () => apply_to_sources_intermediate.put(context, id, record_update)
						: null
					: apply_to_sources_intermediate.patch
					? () => apply_to_sources_intermediate.patch(context, id, record_update)
					: apply_to_sources_intermediate.put
					? () => apply_to_sources_intermediate.put(context, id, deepFreeze(this))
					: null,
				commit: (txn_time, existing_entry, retry) => {
					if (retry) {
						if (context && existing_entry?.version > (context.lastModified || 0))
							context.lastModified = existing_entry.version;
						this[ENTRY_PROPERTY] = existing_entry;
						if (existing_entry?.value?.[RECORD_PROPERTY])
							throw new Error('Can not assign a record to a record, check for circular references');
						if (!full_update) this[RECORD_PROPERTY] = existing_entry?.value ?? null;
					}
					this[OWN_DATA] = undefined; // once we are committing to write this update, we no longer should track the changes, and want to avoid double application (of any CRDTs)
					this[VERSION_PROPERTY] = txn_time;
					const existing_record = existing_entry?.value;
					let update_to_apply = record_update;

					this[SAVE_MODE] = 0;
					// we use optimistic locking to only commit if the existing record state still holds true.
					// this is superior to using an async transaction since it doesn't require JS execution
					//  during the write transaction.
					const precedes_existing_version = precedesExistingVersion(txn_time, existing_entry, options?.nodeId);
					if (precedes_existing_version) {
						// TODO: can the previous version be older, by a prior version be newer?
						if (audit) {
							// incremental CRDT updates are only available with audit logging on
							let local_time = existing_entry.localTime;
							let audited_version = existing_entry.version;
							while (update_to_apply && (local_time > txn_time || (audited_version >= txn_time && local_time > 0))) {
								const audit_entry = audit_store.get(local_time);
								if (!audit_entry) break;
								const audit_record = readAuditEntry(audit_entry);
								audited_version = audit_record.version;
								if (audited_version > txn_time) {
									if (audit_record.type === 'patch') {
										const newer_update = audit_record.getValue(primary_store);
										update_to_apply = rebuildUpdateBefore(update_to_apply, newer_update);
									} else if (audit_record.type === 'put' || audit_record.type === 'delete') {
										// There is newer full record update, so this incremental update is completely superseded
										// TODO: We should still store the audit record for historical purposes
										return;
									}
								} else if (audited_version === txn_time) {
									// if there is an exact match in txn time, we assume this a duplicate update, and we can ignore it
									// TODO: Once we have node ids, we can check if this is a duplicate update from the same node
									// (otherwise we can break ties by the node id)
									return;
								}
								local_time = audit_record.previousLocalTime;
							}
						} else if (full_update) {
							// if no audit, we can't accurately do incremental updates, so we just assume the last update
							// was the same type. Assuming a full update this record update loses and there are no changes
							// TODO: We should still store the audit record for historical purposes
							return;
						} else {
							// no audit, assume updates are overwritten except CRDT operations or properties that didn't exist
							update_to_apply = rebuildUpdateBefore(update_to_apply, existing_record);
						}
					}
					let record_to_store;
					if (full_update) record_to_store = update_to_apply;
					else {
						this[RECORD_PROPERTY] = existing_record;
						record_to_store = full_update ? update_to_apply : deepFreeze(this, update_to_apply);
					}
					this[RECORD_PROPERTY] = record_to_store;
					if (record_to_store?.[RECORD_PROPERTY])
						throw new Error('Can not assign a record to a record, check for circular references');
					let audit_record, residency_id;
					if (options?.residencyId != undefined) residency_id = options.residencyId;
					else {
						if (entry?.residencyId) context.previousResidency = TableResource.getResidencyRecord(entry.residencyId);
						const residency = TableResource.getResidency(record_to_store, context);
						if (residency) {
							if (!Array.isArray(residency)) {
								throw new Error('Residency must be an array, got: ' + residency);
							}
							if (!residency.includes(server.hostname)) {
								// if we aren't in the residency, add ourselves.
								// TODO: we probably want to allow this, but we need to write the partial record in the main table and the full record in the audit log
								residency.push(server.hostname);
							}
						}
						residency_id = getResidencyId(residency);
					}
					if (!full_update) {
						// that is a CRDT, we use our own data as the basis for the audit record, which will include information about the incremental updates
						audit_record = record_update;
					}
					const expires_at = context?.expiresAt ?? (expiration_ms ? expiration_ms + Date.now() : -1);
					logger.trace?.(
						`Saving record with id: ${id}, timestamp: ${new Date(txn_time).toISOString()}${
							expires_at ? ', expires at: ' + new Date(expires_at).toISOString() : ''
						}${
							existing_entry
								? ', replaces entry from: ' + new Date(existing_entry.version).toISOString()
								: ', new entry'
						}`
					);
					updateIndices(id, existing_record, record_to_store);
					const type = full_update ? 'put' : 'patch';

					updateRecord(
						id,
						record_to_store,
						existing_entry,
						txn_time,
						0,
						audit,
						{
							user: context?.user,
							residencyId: residency_id,
							expiresAt: expires_at,
							nodeId: options?.nodeId,
							originatingOperation: context?.originatingOperation,
						},
						type,
						false,
						audit_record
					);
					if (context.expiresAt) scheduleCleanup();
				},
			};
			transaction.addWrite(write);
		}

		async delete(request?: Query | string): Promise<boolean> {
			if (typeof request === 'string') return this.deleteProperty(request);
			// TODO: Handle deletion of a collection/query
			if (this[IS_COLLECTION]) {
				for await (const entry of this.search(request)) {
					const resource = await TableResource.getResource(entry[primary_key], this.getContext(), {
						ensureLoaded: false,
					});
					resource._writeDelete(request);
				}
				return;
			}
			if (!this[RECORD_PROPERTY]) return false;
			return this._writeDelete(request);
		}
		_writeDelete(options?: any) {
			const transaction = txnForContext(this[CONTEXT]);
			const id = this[ID_PROPERTY];
			checkValidId(id);
			const context = this[CONTEXT];
			transaction.addWrite({
				key: id,
				store: primary_store,
				resource: this,
				nodeName: context?.nodeName,
				before: apply_to_sources.delete?.bind(this, context, id),
				beforeIntermediate: apply_to_sources_intermediate.delete?.bind(this, context, id),
				commit: (txn_time, existing_entry, retry) => {
					const existing_record = existing_entry?.value;
					if (retry) {
						if (context && existing_entry?.version > (context.lastModified || 0))
							context.lastModified = existing_entry.version;
						updateResource(this, existing_entry);
					}
					if (precedesExistingVersion(txn_time, existing_entry, options?.nodeId)) return; // a newer record exists locally
					updateIndices(this[ID_PROPERTY], existing_record);
					logger.trace?.(`Deleting record with id: ${id}, txn timestamp: ${new Date(txn_time).toISOString()}`);
					if (audit || track_deletes) {
						updateRecord(
							id,
							null,
							this[ENTRY_PROPERTY],
							txn_time,
							0,
							audit,
							{ user: context?.user, nodeId: options?.nodeId },
							'delete'
						);
						if (!audit) scheduleCleanup();
					} else {
						primary_store.remove(this[ID_PROPERTY]);
					}
				},
			});
			return true;
		}

		search(request: Query): AsyncIterable<any> {
			const context = this[CONTEXT];
			const txn = txnForContext(context);
			if (!request) throw new Error('No query provided');
			let conditions = request.conditions;
			if (!conditions)
				conditions = Array.isArray(request) ? request : request[Symbol.iterator] ? Array.from(request) : [];
			else if (conditions.length === undefined) {
				conditions = conditions[Symbol.iterator] ? Array.from(conditions) : [conditions];
			}
			if (this[ID_PROPERTY]) {
				conditions = [{ attribute: null, comparator: 'prefix', value: this[ID_PROPERTY] }].concat(conditions);
			}
			let order_aligned_condition;
			const filtered = {};

			function prepareConditions(conditions: Condition[], operator: string) {
				// some validation:
				let is_intersection: boolean;
				switch (operator) {
					case 'and':
					case undefined:
						if (conditions.length < 1) throw new Error('An "and" operator requires at least one condition');
						is_intersection = true;
						break;
					case 'or':
						if (conditions.length < 2) throw new Error('An "or" operator requires at least two conditions');
						break;
					default:
						throw new Error('Invalid operator ' + operator);
				}
				const condition_by_name = is_intersection && {};
				let has_multiple_for_name: boolean;
				for (const condition of conditions) {
					if (condition.conditions) {
						condition.conditions = prepareConditions(condition.conditions, condition.operator);
						continue;
					}
					const attribute_name = condition[0] ?? condition.attribute;
					const attribute = attribute_name == null ? primary_key_attribute : findAttribute(attributes, attribute_name);
					if (!attribute) {
						if (attribute_name != null)
							throw handleHDBError(new Error(), `${attribute_name} is not a defined attribute`, 404);
					} else {
						if (is_intersection) {
							const key = flattenKey(attribute_name);
							const named_conditions = condition_by_name[key];
							if (named_conditions) {
								named_conditions.push(condition);
								has_multiple_for_name = true;
							} else condition_by_name[key] = [condition];
						}
						if (attribute.type || COERCIBLE_OPERATORS[condition.comparator]) {
							// Do auto-coercion or coercion as required by the attribute type
							if (condition[1] === undefined) condition.value = coerceTypedValues(condition.value, attribute);
							else condition[1] = coerceTypedValues(condition[1], attribute);
						}
					}
				}
				if (request.enforceExecutionOrder) return conditions; // don't rearrange conditions
				if (has_multiple_for_name) {
					for (const name in condition_by_name) {
						const conditions_for_name = condition_by_name[name];
						const l = conditions_for_name.length;
						if (l > 1) {
							// if there are multiple conditions for the same attribute, see if we can collapse them into a single condition
							for (let i = 0; i < l; i++) {
								const condition = conditions_for_name[i];
								if (condition.comparator === 'ge' || condition.comparator === 'greater_than_equal') {
									for (let j = 0; j < l; j++) {
										const other_condition = conditions_for_name[j];
										if (other_condition.comparator === 'le' || other_condition.comparator === 'less_than_equal') {
											condition.comparator = 'between';
											condition.value = [condition.value, other_condition.value];
											conditions.splice(conditions.indexOf(other_condition), 1);
										}
									}
								}
								if (condition.comparator === 'equals' || !condition.comparator) {
									// if there is an equals condition, we can remove all other conditions
									// and just use the equals condition
									for (let j = 0; j < l; j++) {
										if (j !== i) {
											const other_condition = conditions_for_name[j];
											conditions.splice(conditions.indexOf(other_condition), 1);
										}
									}
									break;
								}
							}
						}
					}
				}
				return conditions;
			}
			function orderConditions(conditions: Condition[], operator: string) {
				if (request.enforceExecutionOrder) return conditions; // don't rearrange conditions
				for (const condition of conditions) {
					if (condition.conditions) condition.conditions = orderConditions(condition.conditions, condition.operator);
				}
				// Sort the query by narrowest to broadest, so we can use the fastest index as possible with minimal filtering.
				// Note, that we do allow users to disable condition re-ordering, in case they have knowledge of a preferred
				// order for their query.
				if (conditions.length > 1 && operator !== 'or') return sortBy(conditions, estimateCondition(TableResource));
				else return conditions;
			}
			function coerceTypedValues(value: any, attribute: Attribute) {
				if (Array.isArray(value)) {
					return value.map((value) => coerceType(value, attribute));
				}
				return coerceType(value, attribute);
			}
			const operator = request.operator;
			if (conditions.length > 0 || operator) conditions = prepareConditions(conditions, operator);
			const sort = typeof request.sort === 'object' && request.sort;
			let post_ordering;
			if (sort) {
				// TODO: Support index-assisted sorts of unions, which will require potentially recursively adding/modifying an order aligned condition and be able to recursively undo it if necessary
				if (operator !== 'or') {
					const attribute_name = sort.attribute;
					order_aligned_condition = conditions.find(
						(condition) => flattenKey(condition.attribute) === flattenKey(attribute_name)
					);
					if (order_aligned_condition) {
						// if there is a condition on the same attribute as the first sort, we can use it to align the sort
						// and avoid a sort operation
					} else {
						const attribute = findAttribute(attributes, attribute_name);
						if (!attribute)
							throw handleHDBError(
								new Error(),
								`${
									Array.isArray(attribute_name) ? attribute_name.join('.') : attribute_name
								} is not a defined attribute`,
								404
							);
						if (attribute.indexed) {
							// if it is indexed, we add a pseudo-condition to align with the natural sort order of the index
							order_aligned_condition = { attribute: attribute_name, comparator: 'sort' };
							conditions.push(order_aligned_condition);
						} else if (conditions.length === 0 && !request.allowFullScan)
							throw handleHDBError(
								new Error(),
								`${
									Array.isArray(attribute_name) ? attribute_name.join('.') : attribute_name
								} is not indexed and not combined with any other conditions`,
								404
							);
					}
					if (order_aligned_condition) order_aligned_condition.descending = Boolean(sort.descending);
				}
			}
			conditions = orderConditions(conditions, operator);

			if (sort) {
				if (order_aligned_condition && conditions[0] === order_aligned_condition) {
					// The db index is providing the order for the first sort, may need post ordering next sort order
					if (sort.next) {
						post_ordering = {
							dbOrderedAttribute: sort.attribute,
							attribute: sort.next.attribute,
							descending: sort.next.descending,
							next: sort.next.next,
						};
					}
				} else {
					// if we had to add an aligned condition that isn't first, we remove it and do ordering later
					if (order_aligned_condition) conditions.splice(conditions.indexOf(order_aligned_condition), 1);
					post_ordering = sort;
				}
			}
			const select = request.select;
			if (conditions.length === 0) {
				conditions = [{ attribute: primary_key, comparator: 'greater_than', value: true }];
			}
			if (request.explain) {
				return {
					conditions,
					operator,
					postOrdering: post_ordering,
					selectApplied: Boolean(select),
				};
			}
			// we mark the read transaction as in use (necessary for a stable read
			// transaction, and we really don't care if the
			// counts are done in the same read transaction because they are just estimates) until the search
			// results have been iterated and finished.
			const read_txn = txn.useReadTxn();
			let entries = executeConditions(
				conditions,
				operator,
				TableResource,
				read_txn,
				request,
				context,
				(results: any[], filters: Function[]) => transformToEntries(results, select, context, read_txn, filters),
				filtered
			);
			const ensure_loaded = request.ensureLoaded !== false;
			if (!post_ordering) entries = applyOffset(entries); // if there is no post ordering, we can apply the offset now
			const transformToRecord = TableResource.transformEntryForSelect(
				select,
				context,
				read_txn,
				filtered,
				ensure_loaded,
				true
			);
			let results = TableResource.transformToOrderedSelect(
				entries,
				select,
				post_ordering,
				read_txn,
				context,
				transformToRecord
			);
			function applyOffset(entries: any[]) {
				if (request.offset || request.limit !== undefined)
					return entries.slice(
						request.offset,
						request.limit !== undefined ? (request.offset || 0) + request.limit : undefined
					);
				return entries;
			}
			if (post_ordering) results = applyOffset(results); // if there is post ordering, we have to apply the offset after sorting
			results.onDone = () => {
				results.onDone = null; // ensure that it isn't called twice
				txn.doneReadTxn();
			};
			results.selectApplied = true;
			results.getColumns = () => {
				if (select) {
					const columns = [];
					for (const column of select) {
						if (column === '*') columns.push(...attributes.map((attribute) => attribute.name));
						else columns.push(column.name || column);
					}
					return columns;
				}
				return attributes
					.filter((attribute) => !attribute.computed && !attribute.relationship)
					.map((attribute) => attribute.name);
			};
			return results;
		}
		/**
		 * This is responsible for ordering and select()ing the attributes/properties from returned entries
		 * @param select
		 * @param context
		 * @param filtered
		 * @param ensure_loaded
		 * @param can_skip
		 * @returns
		 */
		static transformToOrderedSelect(
			entries: any[],
			select: (string | SubSelect)[],
			sort: Sort,
			context: Context,
			read_txn: any,
			transformToRecord: Function
		) {
			let results = new RangeIterable();
			if (sort) {
				// there might be some situations where we don't need to transform to entries for sorting, not sure
				entries = transformToEntries(entries, select, context, read_txn, null);
				let ordered;
				// if we are doing post-ordering, we need to get records first, then sort them
				results.iterate = function () {
					let sorted_array_iterator: IterableIterator<any>;
					const db_iterator = entries[Symbol.asyncIterator]
						? entries[Symbol.asyncIterator]()
						: entries[Symbol.iterator]();
					let db_done: boolean;
					const db_ordered_attribute = sort.dbOrderedAttribute;
					let enqueued_entry_for_next_group: any;
					let last_grouping_value: any;
					let first_entry = true;
					function createComparator(order: Sort) {
						const next_comparator = order.next && createComparator(order.next);
						const descending = order.descending;
						return (entry_a, entry_b) => {
							const a = getAttributeValue(entry_a, order.attribute, context);
							const b = getAttributeValue(entry_b, order.attribute, context);
							const diff = descending ? compareKeys(b, a) : compareKeys(a, b);
							if (diff === 0) return next_comparator?.(entry_a, entry_b) || 0;
							return diff;
						};
					}
					const comparator = createComparator(sort);
					return {
						async next() {
							let iteration: IteratorResult<any>;
							if (sorted_array_iterator) {
								iteration = sorted_array_iterator.next();
								if (iteration.done) {
									if (db_done) {
										if (results.onDone) results.onDone();
										return iteration;
									}
								} else
									return {
										value: await transformToRecord.call(this, iteration.value),
									};
							}
							ordered = [];
							if (enqueued_entry_for_next_group) ordered.push(enqueued_entry_for_next_group);
							// need to load all the entries into ordered
							do {
								iteration = await db_iterator.next();
								if (iteration.done) {
									db_done = true;
									if (!ordered.length) {
										if (results.onDone) results.onDone();
										return iteration;
									} else break;
								} else {
									let entry = iteration.value;
									if (entry?.then) entry = await entry;
									// if the index has already provided the first order of sorting, we only need to sort
									// within each grouping
									if (db_ordered_attribute) {
										const grouping_value = getAttributeValue(entry, db_ordered_attribute, context);
										if (first_entry) {
											first_entry = false;
											last_grouping_value = grouping_value;
										} else if (grouping_value !== last_grouping_value) {
											last_grouping_value = grouping_value;
											enqueued_entry_for_next_group = entry;
											break;
										}
									}
									// we store the value we will sort on, for fast sorting, and the entry so the records can be GC'ed if necessary
									// before the sorting is completed
									ordered.push(entry);
								}
							} while (true);
							if (sort.isGrouped) {
								// TODO: Return grouped results
							}
							ordered.sort(comparator);
							sorted_array_iterator = ordered[Symbol.iterator]();
							iteration = sorted_array_iterator.next();
							if (!iteration.done)
								return {
									value: await transformToRecord.call(this, iteration.value),
								};
							if (results.onDone) results.onDone();
							return iteration;
						},
						return() {
							if (results.onDone) results.onDone();
							db_iterator.return();
						},
						throw() {
							if (results.onDone) results.onDone();
							db_iterator.throw();
						},
					};
				};
				const applySortingOnSelect = (sort) => {
					if (typeof select === 'object' && Array.isArray(sort.attribute)) {
						for (let i = 0; i < select.length; i++) {
							const column = select[i];
							let column_sort;
							if (column.name === sort.attribute[0]) {
								column_sort = column.sort || (column.sort = {});
								while (column_sort.next) column_sort = column_sort.next;
								column_sort.attribute = sort.attribute.slice(1);
								column_sort.descending = sort.descending;
							} else if (column === sort.attribute[0]) {
								select[i] = column_sort = {
									name: column,
									sort: {
										attribute: sort.attribute.slice(1),
										descending: sort.descending,
									},
								};
							}
						}
					}
					if (sort.next) applySortingOnSelect(sort.next);
				};
				applySortingOnSelect(sort);
			} else {
				results.iterate = (entries[Symbol.asyncIterator] || entries[Symbol.iterator]).bind(entries);
				results = results.map(transformToRecord);
			}
			return results;
		}
		/**
		 * This is responsible for select()ing the attributes/properties from returned entries
		 * @param select
		 * @param context
		 * @param filtered
		 * @param ensure_loaded
		 * @param can_skip
		 * @returns
		 */
		static transformEntryForSelect(select, context, read_txn, filtered, ensure_loaded?, can_skip?) {
			if (
				select &&
				(select === primary_key || (select?.length === 1 && select[0] === primary_key && Array.isArray(select)))
			) {
				// fast path if only the primary key is selected, so we don't have to load records
				const transform = (entry) => {
					if (context?.transaction?.stale) context.transaction.stale = false;
					return entry?.key ?? entry;
				};
				if (select === primary_key) return transform;
				else if (select.asArray) return (entry) => [transform(entry)];
				else return (entry) => ({ [primary_key]: transform(entry) });
			}
			let check_loaded;
			if (
				ensure_loaded &&
				has_source_get &&
				// determine if we need to fully loading the records ahead of time, this is why we would not need to load the full record:
				!(typeof select === 'string' ? [select] : select)?.every((attribute) => {
					let attribute_name;
					if (typeof attribute === 'object') {
						attribute_name = attribute.name;
					} else attribute_name = attribute;
					// TODO: Resolvers may not need a full record, either because they are not using the record, or because they are a redirected property
					return indices[attribute_name] || attribute_name === primary_key;
				})
			) {
				check_loaded = true;
			}
			let transform_cache;
			const transform = function (entry) {
				let record;
				if (context?.transaction?.stale) context.transaction.stale = false;
				if (entry != undefined) {
					// TODO: remove this:
					last_entry = entry;
					record = entry.value || entry.deref?.();
					if (!record && (entry.key === undefined || entry.deref)) {
						// if the record is not loaded, either due to the entry actually be a key, or the entry's value
						// being GC'ed, we need to load it now
						entry = loadLocalRecord(
							entry.key ?? entry,
							context,
							{
								transaction: read_txn,
								lazy: select?.length < 4,
							},
							this?.isSync,
							(entry: Entry) => entry
						);
						if (entry?.then) return entry.then(transform.bind(this));
						record = entry?.value;
					}
					if (
						(check_loaded && entry?.metadataFlags & (INVALIDATED | EVICTED)) || // invalidated or evicted should go to load from source
						(entry?.expiresAt != undefined && entry?.expiresAt < Date.now())
					) {
						// should expiration really apply?
						const loading_from_source = ensureLoadedFromSource(entry.key ?? entry, entry, context);
						if (loading_from_source?.then) {
							return loading_from_source.then(transform);
						}
					}
				}
				if (record == null) return can_skip ? SKIP : record;
				if (select && !(select[0] === '*' && select.length === 1)) {
					let promises: Promise<any>[];
					const selectAttribute = (attribute, callback) => {
						let attribute_name;
						if (typeof attribute === 'object') {
							attribute_name = attribute.name;
						} else attribute_name = attribute;
						const resolver = property_resolvers?.[attribute_name];
						let value;
						if (resolver) {
							const filter_map = filtered?.[attribute_name];
							if (filter_map) {
								if (filter_map.hasMappings) {
									const key = resolver.from ? record[resolver.from] : flattenKey(entry.key);
									value = filter_map.get(key);
									if (!value) value = [];
								} else {
									value = filter_map.fromRecord?.(record);
								}
							} else {
								value = resolver(record, context, entry);
							}
							const handleResolvedValue = (value: any) => {
								if (value && typeof value === 'object') {
									const target_table = resolver.definition?.tableClass || TableResource;
									if (!transform_cache) transform_cache = {};
									const transform =
										transform_cache[attribute_name] ||
										(transform_cache[attribute_name] = target_table.transformEntryForSelect(
											// if it is a simple string, there is no select for the next level,
											// otherwise pass along the nested selected
											attribute_name === attribute
												? null
												: attribute.select || (Array.isArray(attribute) ? attribute : null),
											context,
											read_txn,
											filter_map,
											ensure_loaded
										));
									if (Array.isArray(value)) {
										const results = [];
										const iterator = target_table
											.transformToOrderedSelect(
												value,
												attribute.select,
												typeof attribute.sort === 'object' && attribute.sort,
												context,
												read_txn,
												transform
											)
											[this.isSync ? Symbol.iterator : Symbol.asyncIterator]();
										const nextValue = (iteration: IteratorResult<any> & Promise<any>) => {
											while (!iteration.done) {
												if (iteration?.then) return iteration.then(nextValue);
												results.push(iteration.value);
												iteration = iterator.next();
											}
											callback(results, attribute_name);
										};
										const promised = nextValue(iterator.next());
										if (promised) {
											if (!promises) promises = [];
											promises.push(promised);
										}
										return;
									} else {
										value = transform.call(this, value);
										if (value?.then) {
											if (!promises) promises = [];
											promises.push(value.then((value: any) => callback(value, attribute_name)));
											return;
										}
									}
								}
								callback(value, attribute_name);
							};
							if (value?.then) {
								if (!promises) promises = [];
								promises.push(value.then(handleResolvedValue));
							} else handleResolvedValue(value);
							return;
						} else {
							value = record[attribute_name];
							if (value && typeof value === 'object' && attribute_name !== attribute) {
								value = TableResource.transformEntryForSelect(
									attribute.select || attribute,
									context,
									read_txn,
									null
								)({ value });
							}
						}
						callback(value, attribute_name);
					};
					let selected: any;
					if (typeof select === 'string') {
						selectAttribute(select, (value) => {
							selected = value;
						});
					} else if (Array.isArray(select)) {
						if (select.asArray) {
							selected = [];
							select.forEach((attribute, index) => {
								if (attribute === '*') select[index] = record;
								else selectAttribute(attribute, (value) => (selected[index] = value));
							});
						} else {
							selected = {};
							const force_nulls = select.forceNulls;
							for (const attribute of select) {
								if (attribute === '*')
									for (const key in record) {
										selected[key] = record[key];
									}
								else
									selectAttribute(attribute, (value, attribute_name) => {
										if (value === undefined && force_nulls) value = null;
										selected[attribute_name] = value;
									});
							}
						}
					} else throw new ClientError('Invalid select' + select);
					if (promises) {
						return Promise.all(promises).then(() => selected);
					}
					return selected;
				}
				return record;
			};
			return transform;
		}

		async subscribe(request: SubscriptionRequest) {
			if (!audit_store) throw new Error('Can not subscribe to a table without an audit log');
			if (!audit) {
				table({ table: table_name, database: database_name, schemaDefined: schema_defined, attributes, audit: true });
			}
			if (!request) request = {};
			const get_full_record = !request.rawEvents;
			const subscription = addSubscription(
				TableResource,
				this[ID_PROPERTY] ?? null, // treat undefined and null as the root
				function (id, audit_record, timestamp, begin_txn) {
					try {
						let value = audit_record.getValue?.(primary_store, get_full_record);
						let type = audit_record.type;
						if (!value && audit_record.type === 'patch' && get_full_record) {
							// we don't have the full record, need to get it
							const entry = primary_store.getEntry(id);
							// if the current record matches the timestamp, we can use that
							if (entry?.version === audit_record.version) {
								value = entry.value;
							} else {
								// otherwise try to go back in the audit log
								value = audit_record.getValue?.(primary_store, true, timestamp);
							}
							type = 'put';
						}
						this.send({
							id,
							timestamp,
							value,
							version: audit_record.version,
							type,
							beginTxn: begin_txn,
						});
					} catch (error) {
						logger.error?.(error);
					}
				},
				request.startTime || 0,
				request
			);
			if (this[IS_COLLECTION]) {
				subscription.includeDescendants = true;
				if (request.onlyChildren) subscription.onlyChildren = true;
			}
			if (request.supportsTransactions) subscription.supportsTransactions = true;
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
						const audit_record = readAuditEntry(audit_entry);
						if (audit_record.tableId !== table_id) continue;
						const id = audit_record.recordId;
						if (this_id == null || isDescendantId(this_id, id)) {
							const value = audit_record.getValue(primary_store, get_full_record, key);
							subscription.send({ id, timestamp: key, value, version: audit_record.version, type: audit_record.type });
						}
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
								const value = audit_record.getValue(primary_store, get_full_record, key);
								history.push({ id, timestamp: key, value, version: audit_record.version, type: audit_record.type });
								if (--count <= 0) break;
							}
						} catch (error) {
							logger.error?.('Error getting history entry', key, error);
						}
						// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
						//await rest(); // yield for fairness
					}
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					if (history[0]) subscription.startTime = history[0].timestamp; // update so don't double send
				} else if (!request.omitCurrent) {
					for (const { key: id, value, version, localTime } of primary_store.getRange({
						start: this_id ?? false,
						end: this_id == null ? undefined : [this_id, MAXIMUM_KEY],
						versions: true,
					})) {
						if (!value) continue;
						subscription.send({ id, timestamp: localTime, value, version, type: 'put' });
					}
				}
			} else {
				if (count && !start_time) start_time = 0;
				let local_time = this[ENTRY_PROPERTY]?.localTime;
				if (local_time === PENDING_LOCAL_TIME) {
					// we can't use the pending commit because it doesn't have the local audit time yet,
					// so try to retrieve the previous/committed record
					primary_store.cache?.delete(this_id);
					this[ENTRY_PROPERTY] = primary_store.getEntry(this_id);
					logger.trace?.('re-retrieved record', local_time, this[ENTRY_PROPERTY]?.localTime);
					local_time = this[ENTRY_PROPERTY]?.localTime;
				}
				logger.trace?.('Subscription from', start_time, 'from', this_id, local_time);
				if (start_time < local_time) {
					// start time specified, get the audit history for this record
					const history = [];
					let next_time = local_time;
					do {
						//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
						//await audit_store.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
						const audit_entry = audit_store.get(next_time);
						if (audit_entry) {
							request.omitCurrent = true; // we are sending the current version from history, so don't double send
							const audit_record = readAuditEntry(audit_entry);
							const value = audit_record.getValue(primary_store, get_full_record, next_time);
							if (get_full_record) audit_record.type = 'put';
							history.push({ id: this_id, value, timestamp: next_time, ...audit_record });
							next_time = audit_record.previousLocalTime;
						} else break;
						if (count) count--;
					} while (next_time > start_time && count !== 0);
					for (let i = history.length; i > 0; ) {
						subscription.send(history[--i]);
					}
					subscription.startTime = local_time; // make sure we don't re-broadcast the current version that we already sent
				}
				if (!request.omitCurrent && this.doesExist()) {
					// if retain and it exists, send the current value first
					subscription.send({
						id: this_id,
						timestamp: local_time,
						value: this[RECORD_PROPERTY],
						version: this[VERSION_PROPERTY],
						type: 'put',
					});
				}
			}
			if (request.listener) subscription.on('data', request.listener);
			return subscription;
		}
		doesExist() {
			return Boolean(this[RECORD_PROPERTY] || this[SAVE_MODE]);
		}

		/**
		 * Publishing a message to a record adds an (observable) entry in the audit log, but does not change
		 * the record at all. This entries should be replicated and trigger subscription listeners.
		 * @param id
		 * @param message
		 * @param options
		 */
		publish(message, options?) {
			this._writePublish(message, options);
		}
		_writePublish(message, options?: any) {
			const transaction = txnForContext(this[CONTEXT]);
			const id = this[ID_PROPERTY] || null;
			if (id != null) checkValidId(id); // note that we allow the null id for publishing so that you can publish to the root topic
			const context = this[CONTEXT];
			transaction.addWrite({
				key: id,
				store: primary_store,
				entry: this[ENTRY_PROPERTY],
				nodeName: context?.nodeName,
				validate: () => {
					if (!context?.source) {
						transaction.checkOverloaded();
						this.validate(message);
					}
				},
				before: apply_to_sources.publish?.bind(this, context, id, message),
				beforeIntermediate: apply_to_sources_intermediate.publish?.bind(this, context, id, message),
				commit: (txn_time, existing_entry, retries) => {
					// just need to update the version number of the record so it points to the latest audit record
					// but have to update the version number of the record
					// TODO: would be faster to use getBinaryFast here and not have the record loaded

					if (existing_entry === undefined && track_deletes && !audit) {
						scheduleCleanup();
					}
					logger.trace?.(`Publishing message to id: ${id}, timestamp: ${new Date(txn_time).toISOString()}`);
					// always audit this, but don't change existing version
					// TODO: Use direct writes in the future (copying binary data is hard because it invalidates the cache)
					updateRecord(
						id,
						existing_entry?.value ?? null,
						existing_entry,
						existing_entry?.version || txn_time,
						0,
						true,
						{
							user: context?.user,
							residencyId: options?.residencyId,
							expiresAt: context?.expiresAt,
							nodeId: options?.nodeId,
						},
						'message',
						false,
						message
					);
				},
			});
		}
		validate(record, patch?) {
			let validation_errors;
			const validateValue = (value, attribute, name) => {
				if (attribute.type && value != null) {
					if (patch && value.__op__) value = value.value;
					if (attribute.properties) {
						if (typeof value !== 'object') {
							(validation_errors || (validation_errors = [])).push(
								`Value ${stringify(value)} in property ${name} must be an object${
									attribute.type ? ' (' + attribute.type + ')' : ''
								}`
							);
						}
						const properties = attribute.properties;
						for (let i = 0, l = properties.length; i < l; i++) {
							const attribute = properties[i];
							const updated = validateValue(value[attribute.name], attribute, name + '.' + attribute.name);
							if (updated) value[attribute.name] = updated;
						}
						if (attribute.sealed && value != null && typeof value === 'object') {
							for (const key in value) {
								if (!properties.find((property) => property.name === key)) {
									(validation_errors || (validation_errors = [])).push(
										`Property ${key} is not allowed within object in property ${name}`
									);
								}
							}
						}
					} else {
						switch (attribute.type) {
							case 'Int':
								if (typeof value !== 'number' || value >> 0 !== value)
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be an integer (from -2147483648 to 2147483647)`
									);
								break;
							case 'Long':
								if (typeof value !== 'number' || !(Math.floor(value) === value && Math.abs(value) <= 9007199254740992))
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(
											value
										)} in property ${name} must be an integer (from -9007199254740992 to 9007199254740992)`
									);
								break;
							case 'Float':
								if (typeof value !== 'number')
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a number`
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
										`Value ${stringify(value)} in property ${name} must be a string, or an array of strings`
									);
								break;
							case 'String':
								if (typeof value !== 'string')
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a string`
									);
								break;
							case 'Boolean':
								if (typeof value !== 'boolean')
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a boolean`
									);
								break;
							case 'Date':
								if (!(value instanceof Date)) {
									if (typeof value === 'string' || typeof value === 'number') return new Date(value);
									else
										(validation_errors || (validation_errors = [])).push(
											`Value ${stringify(value)} in property ${name} must be a Date`
										);
								}
								break;
							case 'BigInt':
								if (typeof value !== 'bigint') {
									// do coercion because otherwise it is rather difficult to get numbers to consistently be bigints
									if (typeof value === 'string' || typeof value === 'number') return BigInt(value);
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a bigint`
									);
								}
								break;
							case 'Bytes':
								if (!(value instanceof Uint8Array))
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a Buffer or Uint8Array`
									);
								break;
							case 'array':
								if (Array.isArray(value)) {
									if (attribute.elements) {
										for (let i = 0, l = value.length; i < l; i++) {
											const element = value[i];
											const updated = validateValue(element, attribute.elements, name + '[*]');
											if (updated) value[i] = updated;
										}
									}
								} else
									(validation_errors || (validation_errors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a Buffer or Uint8Array`
									);

								break;
						}
					}
				}
				if (attribute.nullable === false && value == null) {
					(validation_errors || (validation_errors = [])).push(
						`Property ${name} is required (and not does not allow null values)`
					);
				}
			};
			for (let i = 0, l = attributes.length; i < l; i++) {
				const attribute = attributes[i];
				if (attribute.relationship || attribute.computed) continue;
				if (!patch || attribute.name in record) {
					const updated = validateValue(record[attribute.name], attribute, attribute.name);
					if (updated) record[attribute.name] = updated;
				}
			}
			if (sealed) {
				for (const key in record) {
					if (!attributes.find((attribute) => attribute.name === key)) {
						(validation_errors || (validation_errors = [])).push(`Property ${key} is not allowed`);
					}
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
		static getRecordCount(options) {
			// iterate through the metadata entries to exclude their count and exclude the deletion counts
			const entry_count = primary_store.getStats().entryCount;
			const MAX_EXACT_COUNT = 5000;
			const SAMPLE_END_SIZE = 1000;
			let limit;
			if (entry_count > MAX_EXACT_COUNT && !options?.exactCount) limit = SAMPLE_END_SIZE;
			let record_count = 0;
			for (const { value } of primary_store.getRange({ start: true, lazy: true, limit })) {
				if (value != null) record_count++;
			}
			if (limit) {
				// in this case we are going to make an estimate of the table count using the first thousand
				// entries and last thousand entries
				const first_record_count = record_count;
				record_count = 0;
				for (const { value } of primary_store.getRange({ start: '\uffff', reverse: true, lazy: true, limit })) {
					if (value != null) record_count++;
				}
				const sample_size = limit * 2;
				const record_rate = (record_count + first_record_count) / sample_size;
				const variance =
					Math.pow((record_count - first_record_count + 1) / limit / 2, 2) + // variance between samples
					(record_rate * (1 - record_rate)) / sample_size;
				const sd = Math.max(Math.sqrt(variance) * entry_count, 1);
				const estimated_record_count = Math.round(record_rate * entry_count);
				const lower_ci_limit = Math.max(estimated_record_count - 1.96 * sd, 0);
				const upper_ci_limit = Math.min(estimated_record_count + 1.96 * sd, entry_count);
				let significant_unit = Math.pow(10, Math.round(Math.log10(sd)));
				if (significant_unit > estimated_record_count) significant_unit = significant_unit / 10;
				record_count = Math.round(estimated_record_count / significant_unit) * significant_unit;
				return {
					recordCount: record_count,
					estimatedRange: [Math.round(lower_ci_limit), Math.round(upper_ci_limit)],
				};
			}
			return {
				recordCount: record_count,
			};
		}
		/**
		 * When attributes have been changed, we update the accessors that are assigned to this table
		 */
		static updatedAttributes() {
			property_resolvers = this.propertyResolvers = {
				$id: (object, context, entry) => ({ value: entry.key }),
				$updatedtime: (object, context, entry) => entry.version,
				$record: (object, context, entry) => (entry ? { value: object } : object),
			};
			for (const attribute of this.attributes) {
				attribute.resolve = null; // reset this
				const relationship = attribute.relationship;
				const computed = attribute.computed;
				if (relationship) {
					if (attribute.indexed) {
						console.error(
							`A relationship property can not be directly indexed, (but you may want to index the foreign key attribute)`
						);
					}
					if (computed) {
						console.error(
							`A relationship property is already computed and can not be combined with a computed function (the relationship will be given precedence)`
						);
					}
					has_relationships = true;
					if (relationship.to) {
						if (attribute.elements?.definition) {
							property_resolvers[attribute.name] = attribute.resolve = (object, context, direct_entry?) => {
								// TODO: Get raw record/entry?
								const id = object[relationship.from ? relationship.from : primary_key];
								const related_table = attribute.elements.definition.tableClass;
								if (direct_entry) {
									return searchByIndex(
										{ attribute: relationship.to, value: id },
										txnForContext(context).getReadTxn(),
										false,
										related_table,
										false
									).asArray;
								}
								return related_table.search([{ attribute: relationship.to, value: id }], context).asArray;
							};
							attribute.set = () => {
								throw new Error('Setting a one-to-many relationship property is not supported');
							};
							attribute.resolve.definition = attribute.elements.definition;
							if (relationship.from) attribute.resolve.from = relationship.from;
						} else
							console.error(
								`The one-to-many/many-to-many relationship property "${attribute.name}" in table "${table_name}" must have an array type referencing a table as the elements`
							);
					} else if (relationship.from) {
						const definition = attribute.definition || attribute.elements?.definition;
						if (definition) {
							property_resolvers[attribute.name] = attribute.resolve = (object, context, direct_entry?) => {
								const ids = object[relationship.from];
								if (ids === undefined) return undefined;
								if (attribute.elements) {
									let has_promises;
									const results = ids.map((id) => {
										const value = direct_entry
											? definition.tableClass.primaryStore.getEntry(id, {
													transaction: txnForContext(context).getReadTxn(),
											  })
											: definition.tableClass.get(id, context);
										if (value?.then) has_promises = true;
										return value;
									});
									return relationship.filterMissing
										? has_promises
											? Promise.all(results).then((results) => results.filter(exists))
											: results.filter(exists)
										: has_promises
										? Promise.all(results)
										: results;
								}
								return direct_entry
									? definition.tableClass.primaryStore.getEntry(ids, {
											transaction: txnForContext(context).getReadTxn(),
									  })
									: definition.tableClass.get(ids, context);
							};
							attribute.set = (object, related) => {
								if (Array.isArray(related)) {
									const target_ids = related.map(
										(related) => related[ID_PROPERTY] || related[definition.tableClass.primaryKey]
									);
									object[relationship.from] = target_ids;
								} else {
									const target_id = related[ID_PROPERTY] || related[definition.tableClass.primaryKey];
									object[relationship.from] = target_id;
								}
							};
							attribute.resolve.definition = attribute.definition || attribute.elements?.definition;
							attribute.resolve.from = relationship.from;
						} else {
							console.error(
								`The relationship property "${attribute.name}" in table "${table_name}" must be a type that references a table`
							);
						}
					} else {
						console.error(
							`The relationship directive on "${attribute.name}" in table "${table_name}" must use either "from" or "to" arguments`
						);
					}
				} else if (computed) {
					if (typeof computed.from === 'function') {
						this.setComputedAttribute(attribute.name, computed.from);
					}
					property_resolvers[attribute.name] = attribute.resolve = (object, context, entry) => {
						const value = typeof computed.from === 'string' ? object[computed.from] : object;
						const user_resolver = this.userResolvers[attribute.name];
						if (user_resolver) return user_resolver(value, context, entry);
						else {
							logger.warn(
								`Computed attribute "${attribute.name}" does not have a function assigned to it. Please use setComputedAttribute('${attribute.name}', resolver) to assign a resolver function.`
							);
							// silence future warnings but just returning undefined
							this.userResolvers[attribute.name] = () => {};
						}
					};
				}
			}
			assignTrackedAccessors(this, this);
		}
		static setComputedAttribute(attribute_name, resolver) {
			const attribute = findAttribute(attributes, attribute_name);
			if (!attribute) {
				console.error(`The attribute "${attribute_name}" does not exist in the table "${table_name}"`);
				return;
			}
			if (!attribute.computed) {
				console.error(`The attribute "${attribute_name}" is not defined as computed in the table "${table_name}"`);
				return;
			}
			this.userResolvers[attribute_name] = resolver;
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
					value: audit_record.getValue(primary_store, true, key),
					user: audit_record.user,
					operation: audit_record.originatingOperation,
				};
			}
		}
		static async getHistoryOfRecord(id) {
			const history = [];
			if (id == undefined) throw new Error('An id is required');
			const entry = primary_store.getEntry(id);
			if (!entry) return history;
			let next_local_time = entry.localTime;
			if (!next_local_time) throw new Error('The entry does not have a local audit time');
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
						value: audit_record.getValue(primary_store, true, next_local_time),
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
			const resolver = property_resolvers[key];
			const value = record && (resolver ? resolver(record) : record[key]);
			const existing_value = existing_record && (resolver ? resolver(existing_record) : existing_record[key]);
			if (value === existing_value && !is_indexing) {
				continue;
			}
			has_changes = true;
			const index_nulls = index.indexNulls;
			// determine what index values need to be removed and added
			let values_to_add = getIndexedValues(value, index_nulls);
			let values_to_remove = getIndexedValues(existing_value, index_nulls);
			if (values_to_remove?.length > 0) {
				// put this in a conditional so we can do a faster version for new records
				// determine the changes/diff from new values and old values
				const set_to_remove = new Set(values_to_remove);
				values_to_add = values_to_add
					? values_to_add.filter((value) => {
							if (set_to_remove.has(value)) {
								// if the value is retained, we don't need to remove or add it, so remove it from the set
								set_to_remove.delete(value);
							} else {
								// keep in the list of values to add to index
								return true;
							}
					  })
					: [];
				values_to_remove = Array.from(set_to_remove);
				if ((values_to_remove.length > 0 || values_to_add.length > 0) && LMDB_PREFETCH_WRITES) {
					// prefetch any values that have been removed or added
					const values_to_prefetch = values_to_remove.concat(values_to_add).map((v) => ({ key: v, value: id }));
					index.prefetch(values_to_prefetch, noop);
				}
				//if the update cleared out the attribute value we need to delete it from the index
				for (let i = 0, l = values_to_remove.length; i < l; i++) {
					index.remove(values_to_remove[i], id);
				}
			} else if (values_to_add?.length > 0 && LMDB_PREFETCH_WRITES) {
				// no old values, just new
				index.prefetch(
					values_to_add.map((v) => ({ key: v, value: id })),
					noop
				);
			}
			if (values_to_add) {
				for (let i = 0, l = values_to_add.length; i < l; i++) {
					index.put(values_to_add[i], id);
				}
			}
		}
		return has_changes;
	}
	function checkValidId(id) {
		switch (typeof id) {
			case 'number':
				return true;
			case 'string':
				if (id.length < 659) return true; // max number of characters that can't expand our key size limit
				if (id.length > MAX_KEY_BYTES) {
					// we can quickly determine this is too big
					throw new Error('Primary key size is too large: ' + id.length);
				}
				// TODO: We could potentially have a faster test here, Buffer.byteLength is close, but we have to handle characters < 4 that are escaped in ordered-binary
				break; // otherwise we have to test it, in this range, unicode characters could put it over the limit
			case 'object':
				if (id === null) {
					throw new Error('Invalid primary key of null');
				}
				break; // otherwise we have to test it
			case 'bigint':
				if (id < 2n ** 64n && id > -(2n ** 64n)) return true;
				break; // otherwise we have to test it
			default:
				throw new Error('Invalid primary key type: ' + typeof id);
		}
		// otherwise it is difficult to determine if the key size is too large
		// without actually attempting to serialize it
		const length = writeKey(id, TEST_WRITE_KEY_BUFFER, 0);
		if (length > MAX_KEY_BYTES) throw new Error('Primary key size is too large: ' + id.length);
		return true;
	}
	function loadLocalRecord(id, context, options, sync, with_entry) {
		if (TableResource.getResidencyById && options.ensureLoaded) {
			// this is a special case for when the residency can be determined from the id alone (hash-based sharding),
			// allow for a fast path to load the record from the correct node
			const residency = TableResource.getResidencyById(id);
			if (residency) {
				if (!residency.includes(server.hostname)) {
					// this record is not on this node, so we shouldn't load it here
					return source_load({ key: id, residency }).then(with_entry, (error) => {
						// TODO: This doesn't have a mechanism for returning errors yet
						logger.error?.('Unable to retrieve data', error);
					});
				}
			}
		}
		// TODO: determine if we use lazy access properties
		const whenPrefetched = () => {
			if (context?.transaction?.stale) context.transaction.stale = false;
			// if the transaction was closed, which can happen if we are iterating
			// through query results and the iterator ends (abruptly)
			if (options.transaction?.isDone) return with_entry(null, id);
			const entry = primary_store.getEntry(id, options);
			if (entry?.residencyId && entry.metadataFlags & INVALIDATED && source_load && options.ensureLoaded) {
				// load from other node
				return source_load(entry).then((entry) => with_entry(entry, id));
			}
			if (entry && context) {
				if (entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
				if (entry?.localTime && !context.lastRefreshed) context.lastRefreshed = entry.localTime;
			}
			return with_entry(entry, id);
		};
		// To prefetch or not to prefetch is one of the biggest questions HarperDB has to make.
		// Prefetching has important benefits as it allows any page fault to be executed asynchronously
		// in the work threads, and it provides event turn yielding, allowing other async functions
		// to execute. However, prefetching is expensive, and the cost of enqueuing a task with the
		// worker threads and enqueuing the callback on the JS thread and the downstream promise handling
		// is usually at least several times more expensive than skipping the prefetch and just directly
		// getting the entry.
		// Determining if we should prefetch is challenging. It is not possible to determine if a page
		// fault will happen, OSes intentionally hide that information. So here we use some heuristics
		// to evaluate if prefetching is a good idea.
		// First, the caller can tell us. If the record is in our local cache, we use that as indication
		// that we can get the value very quickly without a page fault.
		if (sync) return whenPrefetched();
		// Next, we allow for non-prefetch mode where we can execute some gets without prefetching,
		// but we will limit the number before we do another prefetch
		if (until_next_prefetch > 0) {
			until_next_prefetch--;
			return whenPrefetched();
		}
		// Now, we are going to prefetch before loading, so need a promise:
		return new Promise((resolve, reject) => {
			if (until_next_prefetch === 0) {
				// If we were in non-prefetch mode and used up our non-prefetch gets, we immediately trigger
				// a prefetch for the current id
				until_next_prefetch--;
				primary_store.prefetch([id], () => {
					prefetch();
					load();
				});
			} else {
				// If there is a prefetch in flight, we accumulate ids so we can attempt to batch prefetch
				// requests into a single or just a few async operations, reducing the cost of async queuing.
				prefetch_ids.push(id);
				prefetch_callbacks.push(load);
				if (prefetch_ids.length > MAX_PREFETCH_BUNDLE) {
					until_next_prefetch--;
					prefetch();
				}
			}
			function prefetch() {
				if (prefetch_ids.length > 0) {
					const callbacks = prefetch_callbacks;
					primary_store.prefetch(prefetch_ids, () => {
						if (until_next_prefetch === -1) {
							prefetch();
						} else {
							// if there is another prefetch callback pending, we don't need to trigger another prefetch
							until_next_prefetch++;
						}
						for (const callback of callbacks) callback();
					});
					prefetch_ids = [];
					prefetch_callbacks = [];
					// Here is the where the feedback mechanism informs future execution. If we were able
					// to enqueue multiple prefetch requests, this is an indication that we have concurrency
					// and/or page fault/slow data retrieval, and the prefetches are valuable to us, so
					// we stay in prefetch mode.
					// We also reduce the number of non-prefetches we allow in next non-prefetch sequence
					if (non_prefetch_sequence > 2) non_prefetch_sequence--;
				} else {
					// If we have not enqueued any prefetch requests, this is a hint that prefetching may
					// not have been that advantageous, so we let it go back to the non-prefetch mode,
					// for the next few requests. We also increment the number of non-prefetches that
					// we allow so there is a "memory" of how well prefetch vs non-prefetch is going.
					until_next_prefetch = non_prefetch_sequence;
					if (non_prefetch_sequence < MAX_PREFETCH_SEQUENCE) non_prefetch_sequence++;
				}
			}
			function load() {
				try {
					resolve(whenPrefetched());
				} catch (error) {
					reject(error);
				}
			}
		});
	}
	function getTablePermissions(user) {
		if (!user?.role) return;
		const permission = user.role.permission;
		if (permission.super_user) return FULL_PERMISSIONS;
		const db_permission = permission[database_name];
		let table,
			tables = db_permission?.tables;
		if (tables) {
			return tables[table_name];
		} else if (database_name === 'data' && (table = permission[table_name]) && !table.tables) {
			return table;
		}
	}

	function ensureLoadedFromSource(id, entry, context, resource?) {
		if (has_source_get) {
			let needs_source_data = false;
			if (context.noCache) needs_source_data = true;
			else {
				if (entry) {
					if (
						!entry.value ||
						entry.metadataFlags & (INVALIDATED | EVICTED) || // invalidated or evicted should go to load from source
						(entry.expiresAt != undefined && entry.expiresAt < Date.now())
					)
						needs_source_data = true;
				} else needs_source_data = true;
				recordActionBinary(!needs_source_data, 'cache-hit', table_name);
			}
			if (needs_source_data) {
				const loading_from_source = getFromSource(id, entry, context).then((entry) => {
					if (entry?.value?.[RECORD_PROPERTY]) logger.error?.('Can not assign a record with a record property');
					if (context) {
						if (entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
						context.lastRefreshed = Date.now(); // localTime is probably not available yet
					}
					return entry;
				});
				// if the resource defines a method for indicating if stale-while-revalidate is allowed for a record
				if (context?.onlyIfCached || (entry?.value && resource?.allowStaleWhileRevalidate?.(entry, id))) {
					// since we aren't waiting for it any errors won't propagate so we should at least log them
					loading_from_source.catch((error) => logger.warn?.(error));
					if (context?.onlyIfCached && !resource.doesExist()) throw new ServerError('Entry is not cached', 504);
					return; // go ahead and return and let the current stale value be used while we re-validate
				} else return loading_from_source; // return the promise for the resolved value
			}
		} else if (entry?.value) {
			// if we don't have a source, but we have an entry, we check the expiration
			if (entry.expiresAt != undefined && entry.expiresAt < Date.now()) {
				// if it has expired and there is no source, we evict it and then return null, using a fake promise to indicate that this is providing the response
				TableResource.evict(entry.key, entry.value, entry.version);
				entry.value = null;
				return {
					then(callback) {
						return callback(entry); // return undefined, no source to get data from
					},
				};
			}
		}
	}
	function txnForContext(context: Context) {
		let transaction = context?.transaction;
		if (transaction) {
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
	function getAttributeValue(entry, attribute_name, context) {
		if (!entry) {
			return;
		}
		last_entry = entry;
		const record = entry.value || entry.deref?.() || (last_entry = primary_store.getEntry(entry.key))?.value;
		if (typeof attribute_name === 'object') {
			// attribute_name is an array of attributes, pointing to nested attribute
			let resolvers = property_resolvers;
			let value = record;
			for (let i = 0, l = attribute_name.length; i < l; i++) {
				const attribute = attribute_name[i];
				const resolver = resolvers?.[attribute];
				value = resolver && value ? resolver(value, context, true)?.value : value?.[attribute];
				resolvers = resolver?.definition?.tableClass?.propertyResolvers;
			}
			return value;
		}
		const resolver = property_resolvers[attribute_name];
		return resolver ? resolver(record, context) : record[attribute_name];
	}
	function transformToEntries(ids, select, context, read_txn, filters?) {
		// TODO: Test and ensure that we break out of these loops when a connection is lost
		const filters_length = filters?.length;
		const load_options = {
			transaction: read_txn,
			lazy: filters_length > 0 || typeof select === 'string' || select?.length < 4,
			alwaysPrefetch: true,
		};
		let id_filters_applied;
		// for filter operations, we intentionally use async and yield the event turn so that scanning queries
		// do not hog resources and give more processing opportunity for more efficient index-driven queries.
		// this also gives an opportunity to prefetch and ensure any page faults happen in a different thread
		function processEntry(entry: Entry, id?) {
			const record = entry?.value;
			if (!record) return SKIP;
			// apply the record-level filters
			for (let i = 0; i < filters_length; i++) {
				if (id_filters_applied?.includes(i)) continue; // already applied
				if (!filters[i](record, entry)) return SKIP; // didn't match filters
			}
			if (id !== undefined) entry.key = id;
			return entry;
		}
		if (filters_length > 0 || !ids.hasEntries) {
			let results = ids.map((id_or_entry) => {
				id_filters_applied = null;
				if (typeof id_or_entry === 'object' && id_or_entry?.key !== undefined)
					return filters_length > 0 ? processEntry(id_or_entry) : id_or_entry; // already an entry
				if (id_or_entry == undefined) {
					return SKIP;
				}
				// it is an id, so we can try to use id any filters that are available (note that these can come into existence later, during the query)
				for (let i = 0; i < filters_length; i++) {
					const filter = filters[i];
					const idFilter = filter.idFilter;
					if (idFilter) {
						if (!idFilter(id_or_entry)) return SKIP; // didn't match filters
						if (!id_filters_applied) id_filters_applied = [];
						id_filters_applied.push(i);
					}
				}
				return loadLocalRecord(id_or_entry, context, load_options, false, processEntry);
			});
			if (Array.isArray(ids)) results = results.filter((entry) => entry !== SKIP);
			results.hasEntries = true;
			return results;
		}
		return ids;
	}

	function precedesExistingVersion(txn_time, existing_entry, node_id = server.replication?.getThisNodeId(audit_store)) {
		if (txn_time <= existing_entry?.version) {
			if (existing_entry?.version === txn_time && node_id !== undefined) {
				// if we have a timestamp tie, we break the tie by comparing the node name of the
				// existing entry to the node name of the update
				const node_name_to_id = server.replication?.exportIdMapping(audit_store);
				const local_time = existing_entry.localTime;
				const audit_entry = audit_store.get(local_time);
				if (audit_entry) {
					// existing node id comes from the audit log
					let updated_node_name, existing_node_name;
					const audit_record = readAuditEntry(audit_entry);
					for (const node_name in node_name_to_id) {
						if (node_name_to_id[node_name] === node_id) updated_node_name = node_name;
						if (node_name_to_id[node_name] === audit_record.nodeId) existing_node_name = node_name;
					}
					if (updated_node_name > existing_node_name)
						// if the updated node name is greater (alphabetically), it wins (it doesn't precede the existing version)
						return false;
				}
			}
			// transaction time is older than existing version, so we treat that as an update that loses to the existing record version
			return true;
		}
		return false;
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
		// we create a new context for the source, we want to determine the timestamp and don't want to
		// attribute this to the current user
		const source_context = {
			requestContext: context,
			// provide access to previous data
			replacingRecord: existing_record,
			replacingEntry: existing_entry,
			replacingVersion: existing_version,
			noCacheStore: false,
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
			when(
				transaction(source_context, async (txn) => {
					const start = performance.now();
					let updated_record;
					let has_changes, invalidated;
					try {
						// find the first data source that will fulfill our request for data
						for (const source of TableResource.sources) {
							if (source.get && (!source.get.reliesOnPrototype || source.prototype.get)) {
								if (source.available?.(existing_entry) === false) continue;
								source_context.source = source;
								updated_record = await source.get(id, source_context);
								if (updated_record) break;
							}
						}
						invalidated = metadata_flags & INVALIDATED;
						let version = source_context.lastModified || (invalidated && existing_version);
						has_changes = invalidated || version > existing_version || !existing_record;
						if (!version) version = getNextMonotonicTime();
						const resolve_duration = performance.now() - start;
						recordAction(resolve_duration, 'cache-resolution', table_name);
						if (response_headers)
							appendHeader(response_headers, 'Server-Timing', `cache-resolve;dur=${resolve_duration.toFixed(2)}`, true);
						txn.timestamp = version;
						if (expiration_ms && source_context.expiresAt == undefined)
							source_context.expiresAt = Date.now() + expiration_ms;
						if (updated_record) {
							if (typeof updated_record !== 'object')
								throw new Error('Only objects can be cached and stored in tables');
							if (updated_record.status > 0 && updated_record.headers) {
								// if the source has a status code and headers, treat it as a response
								if (updated_record.status >= 300) {
									if (updated_record.status === 304) {
										// revalidation of our current cached record
										updated_record = existing_record;
										version = existing_version;
									} else {
										// if the source has an error status, we need to throw an error
										throw new ServerError(updated_record.body || 'Error from source', updated_record.status);
									} // there are definitely more status codes to handle
								} else {
									updated_record = updated_record.body;
								}
							}
							if (typeof updated_record.toJSON === 'function') updated_record = updated_record.toJSON();
							if (primary_key && updated_record[primary_key] !== id) updated_record[primary_key] = id;
						}
						resolved = true;
						resolve({
							key: id,
							version,
							value: updated_record,
						});
					} catch (error) {
						error.message += ` while resolving record ${id} for ${table_name}`;
						if (
							existing_record &&
							(((error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED' || error.code === 'EAI_AGAIN') &&
								!context?.mustRevalidate) ||
								(context?.staleIfError &&
									(error.statusCode === 500 ||
										error.statusCode === 502 ||
										error.statusCode === 503 ||
										error.statusCode === 504)))
						) {
							// these are conditions under which we can use stale data after an error
							resolve({
								key: id,
								version: existing_version,
								value: existing_record,
							});
							logger.trace?.(error.message, '(returned stale record)');
						} else reject(error);
						source_context.transaction.abort();
						return;
					}
					if (context?.noCacheStore || source_context.noCacheStore) {
						// abort before we write any change
						source_context.transaction.abort();
						return;
					}
					const db_txn = txnForContext(source_context);
					db_txn.addWrite({
						key: id,
						store: primary_store,
						entry: existing_entry,
						nodeName: 'source',
						commit: (txn_time, existing_entry) => {
							if (existing_entry?.version !== existing_version) {
								// don't do anything if the version has changed
								return;
							}
							const has_index_changes = updateIndices(id, existing_record, updated_record);
							if (updated_record) {
								apply_to_sources_intermediate.put?.(source_context, id, updated_record);
								logger.trace?.(
									`Writing resolved record from source with id: ${id}, timestamp: ${new Date(txn_time).toISOString()}`
								);
								// TODO: We are doing a double check for ifVersion that should probably be cleaned out
								updateRecord(
									id,
									updated_record,
									existing_entry,
									txn_time,
									0,
									(audit && has_changes) || null,
									{ user: source_context?.user, expiresAt: source_context.expiresAt },
									'put',
									Boolean(invalidated)
								);
							} else if (existing_entry) {
								apply_to_sources_intermediate.delete?.(source_context, id);
								logger.trace?.(
									`Deleting resolved record from source with id: ${id}, timestamp: ${new Date(txn_time).toISOString()}`
								);
								if (audit || track_deletes) {
									updateRecord(
										id,
										null,
										existing_entry,
										txn_time,
										0,
										(audit && has_changes) || null,
										{ user: source_context?.user },
										'delete',
										Boolean(invalidated)
									);
								} else {
									primary_store.remove(id, existing_version);
								}
							}
						},
					});
				}),
				() => {
					primary_store.unlock(id, existing_version);
				},
				(error) => {
					primary_store.unlock(id, existing_version);
					if (resolved) logger.error?.('Error committing cache update', error);
					// else the error was already propagated as part of the promise that we returned
				}
			);
		});
	}

	/**
	 * Verify that the context does not have any replication parameters that are not allowed
	 * @param context
	 */
	function checkContextPermissions(context: Context) {
		if (!context) return true;
		if (context.user?.role?.permission?.super_user) return true;
		if (context.replicateTo)
			throw new ClientError('Can not specify replication parameters without super user permissions', 403);
		if (context.replicatedConfirmation)
			throw new ClientError('Can not specify replication confirmation without super user permissions', 403);
		return true;
	}
	function scheduleCleanup() {
		// Periodically evict expired records and deleted records searching for records who expiresAt timestamp is before now
		if (cleanup_interval === last_cleanup_interval) return;
		last_cleanup_interval = cleanup_interval;
		if (getWorkerIndex() === getWorkerCount() - 1) {
			// run on the last thread so we aren't overloading lower-numbered threads
			if (cleanup_timer) clearTimeout(cleanup_timer);
			if (!cleanup_interval) return;
			const start_of_year = new Date();
			start_of_year.setMonth(0);
			start_of_year.setDate(1);
			start_of_year.setHours(0);
			start_of_year.setMinutes(0);
			start_of_year.setSeconds(0);
			// find the next scheduled run based on regular cycles from the beginning of the year (if we restart, this enables a good continuation of scheduling)
			const next_scheduled =
				Math.ceil((Date.now() - start_of_year.getTime()) / cleanup_interval) * cleanup_interval +
				start_of_year.getTime();
			const startNextTimer = (next_scheduled) => {
				logger.trace?.(`Scheduled next cleanup scan at ${new Date(next_scheduled)}ms`);
				// noinspection JSVoidFunctionReturnValueUsed
				cleanup_timer = setTimeout(
					() =>
						(last_eviction_completion = last_eviction_completion.then(async () => {
							// schedule the next run for when the next cleanup interval should occur (or now if it is in the past)
							startNextTimer(Math.max(next_scheduled + cleanup_interval, Date.now()));
							if (primary_store.rootStore.status !== 'open') {
								clearTimeout(cleanup_timer);
								return;
							}
							const MAX_CLEANUP_CONCURRENCY = 50;
							const outstanding_cleanup_operations = new Array(MAX_CLEANUP_CONCURRENCY);
							let cleanup_index = 0;
							logger.info?.(`Starting cleanup scan for ${table_name}`);
							try {
								let count = 0;
								// iterate through all entries to find expired records and deleted records
								for (const { key, value: record, version, expiresAt } of primary_store.getRange({
									start: false,
									snapshot: false, // we don't want to keep read transaction snapshots open
									versions: true,
									lazy: true, // only want to access metadata most of the time
								})) {
									// if there is no auditing and we are tracking deletion, need to do cleanup of
									// these deletion entries (audit has its own scheduled job for this)
									let resolution;
									if (record === null && !audit && version + DELETED_RECORD_EXPIRATION < Date.now()) {
										// make sure it is still deleted when we do the removal
										resolution = primary_store.remove(key, version);
									} else if (expiresAt != undefined && expiresAt + eviction_ms < Date.now()) {
										// evict!
										resolution = TableResource.evict(key, record, version);
										count++;
									}
									if (resolution) {
										await outstanding_cleanup_operations[cleanup_index];
										outstanding_cleanup_operations[cleanup_index] = resolution.catch((error) => {
											logger.error?.('Cleanup error', error);
										});
										if (++cleanup_index >= MAX_CLEANUP_CONCURRENCY) cleanup_index = 0;
									}
									await rest();
								}
								logger.info?.(`Finished cleanup scan for ${table_name}, evicted ${count} entries`);
							} catch (error) {
								logger.warn?.(`Error in cleanup scan for ${table_name}:`, error);
							}
						})),
					Math.min(next_scheduled - Date.now(), 0x7fffffff) // make sure it can fit in 32-bit signed number
				).unref(); // don't let this prevent closing the thread
			};
			startNextTimer(next_scheduled);
		}
	}
	function addDeleteRemoval() {
		delete_callback_handle = audit_store?.addDeleteRemovalCallback(table_id, (id) => {
			const entry = primary_store.getEntry(id);
			// make sure it is still deleted when we do the removal
			if (entry?.value === null) {
				primary_store.remove(id, entry.version);
			}
		});
	}
	function runRecordExpirationEviction() {
		// Periodically evict expired records, searching for records who expiresAt timestamp is before now
		if (getWorkerIndex() === 0) {
			// we want to run the pruning of expired records on only one thread so we don't have conflicts in evicting
			setInterval(async () => {
				// go through each database and table and then search for expired entries
				// find any entries that are set to expire before now
				if (running_record_expiration) return;
				running_record_expiration = true;
				try {
					const expires_at_name = expires_at_property.name;
					const index = indices[expires_at_name];
					if (!index) throw new Error(`expiresAt attribute ${expires_at_property} must be indexed`);
					for (const key of index.getRange({
						start: true,
						values: false,
						end: Date.now(),
						snapshot: false,
					})) {
						for (const id of index.getValues(key)) {
							const record_entry = primary_store.getEntry(id);
							if (!record_entry?.value) {
								// cleanup the index if the record is gone
								primary_store.ifVersion(id, record_entry?.version, () => index.remove(key, id));
							} else if (record_entry.value[expires_at_name] < Date.now()) {
								// make sure the record hasn't changed and won't change while removing
								TableResource.evict(id, record_entry.value, record_entry.version);
							}
						}
						await rest();
					}
				} catch (error) {
					logger.error?.('Error in evicting old records', error);
				} finally {
					running_record_expiration = false;
				}
			}, RECORD_PRUNING_INTERVAL).unref();
		}
	}
	function getResidencyId(owner_node_names) {
		if (owner_node_names) {
			const set_key = owner_node_names.join(','); // TODO: Translate this to node ids to create key
			let residency_id = dbis_db.get([Symbol.for('residency_by_set'), set_key]);
			if (residency_id) return residency_id;
			dbis_db.put([Symbol.for('residency_by_set'), set_key], (residency_id = Math.floor(Math.random() * 0x7fffffff)));
			dbis_db.put([Symbol.for('residency_by_id'), residency_id], owner_node_names);
			return residency_id;
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
	} else if (value === '' && type && type !== 'String' && type !== 'Any') {
		return null;
	} else if (type === 'Int' || type === 'Long')
		// allow $ prefix as special syntax for more compact numeric representations and then use parseInt to force being an integer (might consider Math.floor, which is a little faster, but rounds in a different way with negative numbers).
		return value[0] === '$' ? parseInt(value.slice(1), 36) : value === 'null' ? null : parseInt(value);
	else if (type === 'Float') return value === 'null' ? null : +value;
	else if (type === 'BigInt') return value === 'null' ? null : BigInt(value);
	else if (type === 'Boolean') return value === 'true' ? true : value === 'false' ? false : value;
	else if (type === 'Date') {
		if (isNaN(value)) {
			if (value === 'null') return null;
			//if the value is not an integer (to handle epoch values) and does not end in a timezone we suffiz with 'Z' tom make sure the Date is GMT timezone
			if (!ENDS_WITH_TIMEZONE.test(value)) {
				value += 'Z';
			}
			return new Date(value);
		}
		return new Date(+value); // epoch ms number
	} else if (!type || type === 'Any') {
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
// for filtering
function exists(value) {
	return value != null;
}

function stringify(value) {
	try {
		return JSON.stringify(value);
	} catch (err) {
		return value;
	}
}
function hasOtherProcesses(store) {
	const pid = process.pid;
	return store.env
		.readerList()
		.slice(1)
		.some((line) => {
			// if the pid from the reader list is different than ours, must be another process accessing the database
			return +line.match(/\d+/)?.[0] != pid;
		});
}
