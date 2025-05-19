/**
 * This module provides the main table implementation of the Resource API, providing full access to HarperDB
 * tables through the interface defined by the Resource class. This module is responsible for handling these
 * table-level interactions, loading records, updating records, querying, and more.
 */

import { CONFIG_PARAMS, OPERATIONS_ENUM, SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME } from '../utility/hdbTerms.ts';
import { SKIP, type Database } from 'lmdb';
import { getIndexedValues, getNextMonotonicTime } from '../utility/lmdb/commonUtility.js';
import lodash from 'lodash';
import type {
	ResourceInterface,
	SubscriptionRequest,
	Id,
	Context,
	Condition,
	Sort,
	SubSelect,
	RequestTargetOrId,
} from './ResourceInterface.ts';
import lmdbProcessRows from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbProcessRows.js';
import { Resource, contextStorage } from './Resource.ts';
import { DatabaseTransaction, ImmediateTransaction } from './DatabaseTransaction.ts';
import * as envMngr from '../utility/environment/environmentManager.js';
import { addSubscription } from './transactionBroadcast.ts';
import { handleHDBError, ClientError, ServerError } from '../utility/errors/hdbError.js';
import * as signalling from '../utility/signalling.js';
import { SchemaEventMsg, UserEventMsg } from '../server/threads/itc.js';
import { databases, table } from './databases.ts';
import {
	searchByIndex,
	findAttribute,
	estimateCondition,
	flattenKey,
	COERCIBLE_OPERATORS,
	executeConditions,
} from './search.ts';
import logger from '../utility/logging/logger.js';
import { Addition, assignTrackedAccessors, updateAndFreeze, hasChanges, GenericTrackedObject } from './tracked.ts';
import { transaction } from './transaction.ts';
import { MAXIMUM_KEY, writeKey, compareKeys } from 'ordered-binary';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { HAS_BLOBS, readAuditEntry, removeAuditEntry } from './auditStore.ts';
import { autoCast, convertToMS } from '../utility/common_utils.js';
import { recordUpdater, removeEntry, PENDING_LOCAL_TIME, Record, type Entry } from './RecordEncoder.ts';
import { recordAction, recordActionBinary } from './analytics/write.ts';
import { rebuildUpdateBefore } from './crdt.ts';
import { appendHeader } from '../server/serverHelpers/Headers.ts';
import fs from 'node:fs';
import { Blob, deleteBlobsInObject, findBlobsInObject } from './blob.ts';
import { onStorageReclamation } from '../server/storageReclamation.ts';
import { RequestTarget } from './RequestTarget.ts';

const { sortBy } = lodash;
const { validateAttribute } = lmdbProcessRows;

type Attribute = {
	name: string;
	type: string;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	expiresAt?: boolean;
	isPrimaryKey?: boolean;
};

const NULL_WITH_TIMESTAMP = new Uint8Array(9);
NULL_WITH_TIMESTAMP[8] = 0xc0; // null
let serverUtilities;
let node_name: string;
const RECORD_PRUNING_INTERVAL = 60000; // one minute
const DELETED_RECORD_EXPIRATION = 86400000; // one day for non-audit records that have been deleted
envMngr.initSync();
const LMDB_PREFETCH_WRITES = envMngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);
const LOCK_TIMEOUT = 10000;
const SAVING_FULL_UPDATE = 1;
const SAVING_CRDT_UPDATE = 2;
const NOTIFICATION = { isNotification: true, ensureLoaded: false };
export const INVALIDATED = 1;
export const EVICTED = 8; // note that 2 is reserved for timestamps
const TEST_WRITE_KEY_BUFFER = Buffer.allocUnsafeSlow(8192);
const MAX_KEY_BYTES = 1978;
const EVENT_HIGH_WATER_MARK = 100;
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
	splitSegments?: boolean;
	replicate?: boolean;
	subscriptions: Map<any, Function[]>;
	expirationMS: number;
	indexingOperations?: Promise<void>;
	sources: (new () => ResourceInterface)[];
	Transaction: ReturnType<typeof makeTable>;
}
type ResidencyDefinition = number | string[] | void;

// we default to the max age of the streams because this is the limit on the number of old transactions
// we might need to reconcile deleted entries against.
const DELETE_ENTRY_EXPIRATION =
	convertToMS(envMngr.get(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE)) || 86400000;
/**
 * This returns a Table class for the given table settings (determined from the metadata table)
 * Instances of the returned class are Resource instances, intended to provide a consistent view or transaction of the table
 * @param options
 */
export function makeTable(options) {
	const {
		primaryKey,
		indices,
		tableId,
		tableName,
		primaryStore,
		databasePath,
		databaseName,
		auditStore,
		schemaDefined,
		dbisDB: dbisDb,
		sealed,
		splitSegments,
		replicate,
	} = options;
	let { expirationMS: expirationMs, evictionMS: evictionMs, audit, trackDeletes: trackDeletes } = options;
	evictionMs ??= 0;
	let { attributes } = options;
	if (!attributes) attributes = [];
	const updateRecord = recordUpdater(primaryStore, tableId, auditStore);
	let sourceLoad: any; // if a source has a load function (replicator), record it here
	let hasSourceGet: any;
	let primaryKeyAttribute: Attribute = {};
	let lastEvictionCompletion: Promise<void> = Promise.resolve();
	let createdTimeProperty: Attribute, updatedTimeProperty: Attribute, expiresAtProperty: Attribute;
	for (const attribute of attributes) {
		if (attribute.assignCreatedTime || attribute.name === '__createdtime__') createdTimeProperty = attribute;
		if (attribute.assignUpdatedTime || attribute.name === '__updatedtime__') updatedTimeProperty = attribute;
		if (attribute.expiresAt) expiresAtProperty = attribute;
		if (attribute.isPrimaryKey) primaryKeyAttribute = attribute;
	}
	let deleteCallbackHandle: { remove: () => void };
	let prefetchIds = [];
	let prefetchCallbacks = [];
	let untilNextPrefetch = 1;
	let nonPrefetchSequence = 2;
	let applyToSources: any = {};
	let applyToSourcesIntermediate: any = {};
	let cleanupInterval = 86400000;
	let cleanupPriority = 0;
	let lastCleanupInterval: number;
	let cleanupTimer: NodeJS.Timeout;
	let propertyResolvers: any;
	let hasRelationships = false;
	let runningRecordExpiration: boolean;
	type BigInt64ArrayAndMaxSafeId = BigInt64Array & { maxSafeId: number };
	let idIncrementer: BigInt64ArrayAndMaxSafeId;
	let replicateToCount;
	const databaseReplications = envMngr.get(CONFIG_PARAMS.REPLICATION_DATABASES);
	if (Array.isArray(databaseReplications)) {
		for (const dbReplication of databaseReplications) {
			if (dbReplication.name === databaseName && dbReplication.replicateTo >= 0) {
				replicateToCount = dbReplication.replicateTo;
				break;
			}
		}
	}
	const RangeIterable = primaryStore.getRange({ start: false, end: false }).constructor;
	const MAX_PREFETCH_SEQUENCE = 10;
	const MAX_PREFETCH_BUNDLE = 6;
	if (audit) addDeleteRemoval();
	onStorageReclamation(primaryStore.env.path, (priority: number) => {
		if (hasSourceGet) return scheduleCleanup(priority);
	});

	class Updatable extends GenericTrackedObject implements Record {
		declare set: (property: string, value: any) => void;
		declare getProperty: (property: string) => any;
		getUpdatedTime(): number {
			return this[VERSION];
		}
		getExpiresAt(): number {
			return this[EXPIRES_AT];
		}
		addTo(property: string, value: number | bigint) {
			if (typeof value === 'number' || typeof value === 'bigint') {
				this.set(property, new Addition(value));
			} else {
				throw new Error('Can not add or subtract a non-numeric value');
			}
		}
		subtractFrom(property: string, value: number | bigint) {
			return this.addTo(property, -value);
		}
	}
	class TableResource extends Resource {
		#record: any; // the stored/frozen record from the database and stored in the cache (should not be modified directly)
		#changes: any; // the changes to the record that have been made (should not be modified directly)
		#version?: number; // version of the record
		#entry?: Entry; // the entry from the database
		#saveMode?: boolean; // indicates that the record is currently being saved
		#loadedFromSource?: boolean; // indicates that the record was loaded from the source
		declare getProperty: (name: string) => any;
		static name = tableName; // for display/debugging purposes
		static primaryStore = primaryStore;
		static auditStore = auditStore;
		static primaryKey = primaryKey;
		static tableName = tableName;
		static tableId = tableId;
		static indices = indices;
		static audit = audit;
		static databasePath = databasePath;
		static databaseName = databaseName;
		static attributes = attributes;
		static replicate = replicate;
		static sealed = sealed;
		static splitSegments = splitSegments ?? true;
		static createdTimeProperty = createdTimeProperty;
		static updatedTimeProperty = updatedTimeProperty;
		static propertyResolvers;
		static userResolvers = {};
		static sources: (typeof TableResource)[] = [];
		declare static sourceOptions: any;
		declare static intermediateSource: boolean;
		static getResidencyById: (id: Id) => number | void;
		static get expirationMS() {
			return expirationMs;
		}
		static dbisDB = dbisDb;
		static schemaDefined = schemaDefined;
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
				if (this.sources.some((source) => !source.intermediateSource)) {
					if (this.sources.some((existingSource) => existingSource.name === source.name)) {
						// if we are adding a source that is already in the list, we don't add it again
						return;
					}
					throw new Error('Can not have multiple canonical (non-intermediate) sources');
				}
				this.sources.push(source);
			}
			hasSourceGet = hasSourceGet || (source.get && (!source.get.reliesOnPrototype || source.prototype.get));
			sourceLoad = sourceLoad || source.load;
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
						const intermediateSource = sources[0];
						return (context, id, data) => {
							if (context?.source !== intermediateSource) return intermediateSource[method](id, data, context);
						};
					} else {
						return (context, id, data) => {
							// if multiple intermediate sources, call them in parallel
							const results: Promise<any>[] = [];
							for (const source of sources) {
								if (context?.source === source) break;
								results.push(source[method](id, data, context));
							}
							return Promise.all(results);
						};
					}
				}
			};
			let canonicalSource = this.sources[this.sources.length - 1];
			if (canonicalSource.intermediateSource) canonicalSource = {} as typeof TableResource; // don't treat intermediate sources as canonical
			const getApplyToCanonicalSource = (method) => {
				if (
					canonicalSource[method] &&
					(!canonicalSource[method].reliesOnPrototype || canonicalSource.prototype[method])
				) {
					return (context, id, data) => {
						if (!context?.source) return canonicalSource[method](id, data, context);
					};
				}
			};
			// define a set of methods for each operation so we can apply these in each write as part
			// of the commit
			applyToSources = {
				put: getApplyToCanonicalSource('put'),
				patch: getApplyToCanonicalSource('patch'),
				delete: getApplyToCanonicalSource('delete'),
				publish: getApplyToCanonicalSource('publish'),
				// note that invalidate event does not go to the canonical source, invalidate means that
				// caches are invalidated, which specifically excludes the canonical source from being affected.
			};
			applyToSourcesIntermediate = {
				put: getApplyToIntermediateSource('put'),
				patch: getApplyToIntermediateSource('patch'),
				delete: getApplyToIntermediateSource('delete'),
				publish: getApplyToIntermediateSource('publish'),
				invalidate: getApplyToIntermediateSource('invalidate'),
			};
			const shouldRevalidateEvents = canonicalSource.shouldRevalidateEvents;

			// External data source may provide a subscribe method, allowing for real-time proactive delivery
			// of data from the source to this caching table. This is generally greatly superior to expiration-based
			// caching since it much for accurately ensures freshness and maximizing caching time.
			// Here we subscribe the external data source if it is available, getting notification events
			// as they come in, and directly writing them to this table. We use the notification option to ensure
			// that we don't re-broadcast these as "requested" changes back to the source.
			(async () => {
				let userRoleUpdate = false;
				let lastSequenceId;
				// perform the write of an individual write event
				const writeUpdate = async (event, context) => {
					const value = event.value;
					const Table = event.table ? databases[databaseName][event.table] : TableResource;
					if (
						databaseName === SYSTEM_SCHEMA_NAME &&
						(event.table === SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME || event.table === SYSTEM_TABLE_NAMES.USER_TABLE_NAME)
					) {
						userRoleUpdate = true;
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
					const id = event.id;
					const resource: TableResource = await Table.getResource(id, context, options);
					if (event.finished) await event.finished;
					switch (event.type) {
						case 'put':
							return shouldRevalidateEvents
								? resource._writeInvalidate(id, value, options)
								: resource._writeUpdate(id, value, true, options);
						case 'patch':
							return shouldRevalidateEvents
								? resource._writeInvalidate(id, value, options)
								: resource._writeUpdate(id, value, false, options);
						case 'delete':
							return resource._writeDelete(id, options);
						case 'publish':
						case 'message':
							return resource._writePublish(id, value, options);
						case 'invalidate':
							return resource._writeInvalidate(id, value, options);
						case 'relocate':
							return resource._writeRelocate(id, options);
						default:
							logger.error?.('Unknown operation', event.type, event.id);
					}
				};

				try {
					const hasSubscribe = source.subscribe;
					// if subscriptions come in out-of-order, we need to track deletes to ensure consistency
					if (hasSubscribe && trackDeletes == undefined) trackDeletes = true;
					const subscriptionOptions = {
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
					};
					const subscribeOnThisThread = source.subscribeOnThisThread
						? source.subscribeOnThisThread(getWorkerIndex(), subscriptionOptions)
						: getWorkerIndex() === 0;
					const subscription = hasSubscribe && subscribeOnThisThread && (await source.subscribe?.(subscriptionOptions));
					if (subscription) {
						let txnInProgress;
						// we listen for events by iterating through the async iterator provided by the subscription
						for await (const event of subscription) {
							try {
								const firstWrite = event.type === 'transaction' ? event.writes[0] : event;
								if (!firstWrite) {
									logger.error?.('Bad subscription event', event);
									continue;
								}
								event.source = source;
								if (event.type === 'end_txn') {
									txnInProgress?.resolve();
									if (event.localTime && lastSequenceId !== event.localTime) {
										if (event.remoteNodeIds?.length > 0) {
											// the key for tracking the sequence ids and txn times received from this node
											const seqKey = [Symbol.for('seq'), event.remoteNodeIds[0]];
											const existingSeq = dbisDb.get(seqKey);
											let nodeStates = existingSeq?.nodes;
											if (!nodeStates) {
												// if we don't have a list of nodes, we need to create one, with the main one using the existing seqId
												nodeStates = [];
											}
											// if we are not the only node in the list, we are getting proxied subscriptions, and we need
											// to track this separately
											// track the other nodes in the list
											for (const nodeId of event.remoteNodeIds.slice(1)) {
												let nodeState = nodeStates.find((existingNode) => existingNode.id === nodeId);
												// remove any duplicates
												nodeStates = nodeStates.filter(
													(existingNode) => existingNode.id !== nodeId || existingNode === nodeState
												);
												if (!nodeState) {
													nodeState = { id: nodeId, seqId: 0 };
													nodeStates.push(nodeState);
												}
												nodeState.seqId = Math.max(existingSeq?.seqId ?? 1, event.localTime);
												if (nodeId === txnInProgress?.nodeId) {
													nodeState.lastTxnTime = event.timestamp;
												}
											}
											const seqId = Math.max(existingSeq?.seqId ?? 1, event.localTime);
											logger.trace?.(
												'Received txn',
												databaseName,
												new Date(seqId),
												new Date(event.localTime),
												event.remoteNodeIds
											);
											dbisDb.put(seqKey, {
												seqId,
												nodes: nodeStates,
											});
										}
										lastSequenceId = event.localTime;
									}
									if (event.onCommit) txnInProgress?.committed.then(event.onCommit);
									continue;
								}
								if (txnInProgress) {
									if (event.beginTxn) {
										// if we are starting a new transaction, finish the existing one
										txnInProgress.resolve();
									} else {
										// write in the current transaction if one is in progress
										txnInProgress.write_promises.push(writeUpdate(event, txnInProgress));
										continue;
									}
								}
								// use the version as the transaction timestamp
								if (!event.timestamp && event.version) event.timestamp = event.version;
								const commitResolution = transaction(event, () => {
									if (event.type === 'transaction') {
										// if it is a transaction, we need to individually iterate through each write event
										const promises: Promise<any>[] = [];
										for (const write of event.writes) {
											try {
												promises.push(writeUpdate(write, event));
											} catch (error) {
												(error as Error).message +=
													' writing ' + JSON.stringify(write) + ' of event ' + JSON.stringify(event);
												throw error;
											}
										}
										return Promise.all(promises);
									} else if (event.type === 'define_schema') {
										// ensure table has the provided attributes
										const updatedAttributes = this.attributes.slice(0);
										let hasChanges = false;
										for (const attribute of event.attributes) {
											if (!updatedAttributes.find((existing) => existing.name === attribute.name)) {
												updatedAttributes.push(attribute);
												hasChanges = true;
											}
										}
										if (hasChanges) {
											table({
												table: tableName,
												database: databaseName,
												attributes: updatedAttributes,
												origin: 'cluster',
											});
											signalling.signalSchemaChange(
												new SchemaEventMsg(process.pid, OPERATIONS_ENUM.CREATE_TABLE, databaseName, tableName)
											);
										}
									} else {
										if (event.beginTxn) {
											// if we are beginning a new transaction, we record the current
											// event/context as transaction in progress and then future events
											// are applied with that context until the next transaction begins/ends
											txnInProgress = event;
											txnInProgress.write_promises = [writeUpdate(event, event)];
											return new Promise((resolve) => {
												// callback for when this transaction is finished (will be called on next txn begin/end).
												txnInProgress.resolve = () => resolve(Promise.all(txnInProgress.write_promises)); // and make sure we wait for the write update to finish
											});
										}
										return writeUpdate(event, event);
									}
								});
								if (txnInProgress) txnInProgress.committed = commitResolution;
								if (userRoleUpdate && commitResolution && !commitResolution?.waitingForUserChange) {
									// if the user role changed, asynchronously signal the user change (but don't block this function)
									commitResolution.then(() => signalling.signalUserChange(new UserEventMsg(process.pid)));
									commitResolution.waitingForUserChange = true; // only need to send one signal per transaction
								}

								if (event.onCommit) {
									if (commitResolution) commitResolution.then(event.onCommit);
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
		// define a caching table as one that has a origin source with a get
		static get isCaching() {
			return hasSourceGet;
		}

		/** Indicates if the events should be revalidated when they are received. By default we do this if the get
		 * method is overriden */
		static get shouldRevalidateEvents() {
			return this.prototype.get !== TableResource.prototype.get;
		}

		/**
		 * Gets a resource instance, as defined by the Resource class, adding the table-specific handling
		 * of also loading the stored record into the resource instance.
		 * @param id
		 * @param request
		 * @param options An important option is ensureLoaded, which can be used to indicate that it is necessary for a caching table to load data from the source if there is not a local copy of the data in the table (usually not necessary for a delete, for example).
		 * @returns
		 */
		static getResource(id: Id, request: Context, resourceOptions?: any): Promise<TableResource> | TableResource {
			const resource: TableResource = super.getResource(id, request, resourceOptions) as any;
			if (id != null && this.loadAsInstance !== false) {
				checkValidId(id);
				try {
					if (resource.getRecord?.()) return resource; // already loaded, don't reload, current version may have modifications
					if (typeof id === 'object' && id && !Array.isArray(id)) {
						throw new Error(`Invalid id ${JSON.stringify(id)}`);
					}
					const sync = !resourceOptions?.async || primaryStore.cache?.get?.(id);
					const txn = txnForContext(request);
					const readTxn = txn.getReadTxn();
					if (readTxn?.isDone) {
						throw new Error('You can not read from a transaction that has already been committed/aborted');
					}
					return loadLocalRecord(
						id,
						request,
						{ transaction: readTxn, ensureLoaded: resourceOptions?.ensureLoaded },
						sync,
						(entry) => {
							if (entry) {
								TableResource._updateResource(resource, entry);
							} else resource.#record = null;
							if (request.onlyIfCached && request.noCacheStore) {
								// don't go into the loading from source condition, but HTTP spec says to
								// return 504 (rather than 404) if there is no content and the cache-control header
								// dictates not to go to source (and not store new value)
								if (!resource.doesExist()) throw new ServerError('Entry is not cached', 504);
							} else if (resourceOptions?.ensureLoaded) {
								const loadingFromSource = ensureLoadedFromSource(id, entry, request, resource);
								if (loadingFromSource) {
									txn?.disregardReadTxn(); // this could take some time, so don't keep the transaction open if possible
									resource.#loadedFromSource = true;
									request.loadedFromSource = true;
									return when(loadingFromSource, (entry) => {
										TableResource._updateResource(resource, entry);
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
		static _updateResource(resource, entry) {
			resource.#entry = entry;
			resource.#record = entry?.value ?? null;
			resource.#version = entry?.version;
		}
		/**
		 * This is a request to explicitly ensure that the record is loaded from source, rather than only using the local record.
		 * This will load from source if the current record is expired, missing, or invalidated.
		 * @returns
		 */
		ensureLoaded() {
			const loadedFromSource = ensureLoadedFromSource(this.getId(), this.#entry, this.getContext());
			if (loadedFromSource) {
				this.#loadedFromSource = true;
				this.getContext().loadedFromSource = true;
				return when(loadedFromSource, (entry) => {
					this.#entry = entry;
					this.#record = entry.value;
					this.#version = entry.version;
				});
			}
		}
		static getNewId(): any {
			const type = primaryKeyAttribute?.type;
			// the default Resource behavior is to return a GUID, but for a table we can return incrementing numeric keys if the type is (or can be) numeric
			if (type === 'String' || type === 'ID') return super.getNewId();
			if (!idIncrementer) {
				// if there is no id incrementer yet, we get or create one
				const idAllocationEntry = primaryStore.getEntry(Symbol.for('id_allocation'));
				let idAllocation = idAllocationEntry?.value;
				let lastKey;
				if (
					idAllocation &&
					idAllocation.nodeName === server.hostname &&
					(!hasOtherProcesses(primaryStore) || idAllocation.pid === process.pid)
				) {
					// the database has an existing id allocation that we can continue from
					const startingId = idAllocation.start;
					const endingId = idAllocation.end;
					lastKey = startingId;
					// once it is loaded, we need to find the last key in the allocated range and start from there
					for (const key of primaryStore.getKeys({ start: endingId, end: startingId, limit: 1, reverse: true })) {
						lastKey = key;
					}
				} else {
					// we need to create a new id allocation
					idAllocation = createNewAllocation(idAllocationEntry?.version ?? null);
					lastKey = idAllocation.start;
				}
				// all threads will use a shared buffer to atomically increment the id
				// first, we create our proposed incrementer buffer that will be used if we are the first thread to get here
				// and initialize it with the starting id
				idIncrementer = new BigInt64Array([BigInt(lastKey) + 1n]) as BigInt64ArrayAndMaxSafeId;
				// now get the selected incrementer buffer, this is the shared buffer was first registered and that all threads will use
				idIncrementer = new BigInt64Array(
					primaryStore.getUserSharedBuffer('id', idIncrementer.buffer)
				) as BigInt64ArrayAndMaxSafeId;
				// and we set the maximum safe id to the end of the allocated range before we check for conflicting ids again
				idIncrementer.maxSafeId = idAllocation.end;
			}
			// this is where we actually do the atomic incrementation. All the threads should be pointing to the same
			// memory location of this incrementer, so we can be sure that the id is unique and sequential.
			const nextId = Number(Atomics.add(idIncrementer, 0, 1n));
			const asyncIdExpansionThreshold = type === 'Int' ? 0x200 : 0x100000;
			if (nextId + asyncIdExpansionThreshold >= idIncrementer.maxSafeId) {
				const updateEnd = (inTxn) => {
					// we update the end of the allocation range after verifying we don't have any conflicting ids in front of us
					idIncrementer.maxSafeId = nextId + (type === 'Int' ? 0x3ff : 0x3fffff);
					let idAfter = (type === 'Int' ? Math.pow(2, 31) : Math.pow(2, 49)) - 1;
					const readTxn = inTxn ? undefined : primaryStore.useReadTransaction();
					// get the latest id after the read transaction to make sure we aren't reading any new ids that we assigned from this node
					const newestId = Number(idIncrementer[0]);
					for (const key of primaryStore.getKeys({
						start: newestId + 1,
						end: idAfter,
						limit: 1,
						transaction: readTxn,
					})) {
						idAfter = key;
					}
					readTxn?.done();
					const { value: updatedIdAllocation, version } = primaryStore.getEntry(Symbol.for('id_allocation'));
					if (idIncrementer.maxSafeId < idAfter) {
						// note that this is just a noop/direct callback if we are inside the sync transaction
						// first check to see if it actually got updated by another thread
						if (updatedIdAllocation.end > idIncrementer.maxSafeId - 100) {
							// the allocation was already updated by another thread
							return;
						}
						logger.info?.('New id allocation', nextId, idIncrementer.maxSafeId, version);
						primaryStore.put(
							Symbol.for('id_allocation'),
							{
								start: updatedIdAllocation.start,
								end: idIncrementer.maxSafeId,
								nodeName: server.hostname,
								pid: process.pid,
							},
							Date.now(),
							version
						);
					} else {
						// indicate that we have run out of ids in the allocated range, so we need to allocate a new range
						logger.warn?.(
							`Id conflict detected, starting new id allocation range, attempting to allocate to ${idIncrementer.maxSafeId}, but id of ${idAfter} detected`
						);
						const idAllocation = createNewAllocation(version);
						// reassign the incrementer to the new range/starting point
						if (!idAllocation.alreadyUpdated) Atomics.store(idIncrementer, 0, BigInt(idAllocation.start + 1));
						// and we set the maximum safe id to the end of the allocated range before we check for conflicting ids again
						idIncrementer.maxSafeId = idAllocation.end;
					}
				};
				if (nextId + asyncIdExpansionThreshold === idIncrementer.maxSafeId) {
					setImmediate(updateEnd); // if we are getting kind of close to the end, we try to update it asynchronously
				} else if (nextId + 100 >= idIncrementer.maxSafeId) {
					logger.warn?.(
						`Synchronous id allocation required on table ${tableName}${
							type == 'Int'
								? ', it is highly recommended that you use Long or Float as the type for auto-incremented primary keys'
								: ''
						}`
					);
					// if we are very close to the end, synchronously update
					primaryStore.transactionSync(() => updateEnd(true));
				}
				//TODO: Add a check to recordUpdate to check if a new id infringes on the allocated id range
			}
			return nextId;
			function createNewAllocation(expectedVersion) {
				// there is no id allocation (or it is for the wrong node name or used up), so we need to create one
				// start by determining the max id for the type
				const maxId = (type === 'Int' ? Math.pow(2, 31) : Math.pow(2, 49)) - 1;
				let safeDistance = maxId / 4; // we want to allocate ids in a range that is at least 1/4 of the total id space from ids in either direction
				let idBefore: number, idAfter: number;
				let complained = false;
				let lastKey;
				let idAllocation;
				do {
					// we start with a random id and verify that there is a good gap in the ids to allocate a decent range
					lastKey = Math.floor(Math.random() * maxId);
					idAllocation = {
						start: lastKey,
						end: lastKey + (type === 'Int' ? 0x400 : 0x400000),
						nodeName: server.hostname,
						pid: process.pid,
					};
					idBefore = 0;
					// now find the next id before the last key
					for (const key of primaryStore.getKeys({ start: lastKey, limit: 1, reverse: true })) {
						idBefore = key;
					}
					idAfter = maxId;
					// and next key after
					for (const key of primaryStore.getKeys({ start: lastKey + 1, end: maxId, limit: 1 })) {
						idAfter = key;
					}
					safeDistance *= 0.875; // if we fail, we try again with a smaller range, looking for a good gap without really knowing how packed the ids are
					if (safeDistance < 1000 && !complained) {
						complained = true;
						logger.error?.(
							`Id allocation in table ${tableName} is very dense, limited safe range of numbers to allocate ids in${
								type === 'Int'
									? ', it is highly recommended that you use Long or Float as the type for auto-incremented primary keys'
									: ''
							}`,
							lastKey,
							idBefore,
							idAfter,
							safeDistance
						);
					}
					// see if we maintained an adequate distance from the surrounding ids
				} while (!(safeDistance < idAfter - lastKey && (safeDistance < lastKey - idBefore || idBefore === 0)));
				// we have to ensure that the id allocation is atomic and multiple threads don't set different ids, so we use a sync transaction
				return primaryStore.transactionSync(() => {
					// first check to see if it actually got set by another thread
					const updatedIdAllocation = primaryStore.getEntry(Symbol.for('id_allocation'));
					if ((updatedIdAllocation?.version ?? null) == expectedVersion) {
						logger.info?.('Allocated new id range', idAllocation);
						primaryStore.put(Symbol.for('id_allocation'), idAllocation, Date.now());
						return idAllocation;
					} else {
						logger.debug?.('Looks like ids were already allocated');
						return { alreadyUpdated: true, ...updatedIdAllocation.value };
					}
				});
			}
		}

		/**
		 * Set TTL expiration for records in this table. On retrieval, record timestamps are checked for expiration.
		 * This also informs the scheduling for record eviction.
		 * @param expirationTime Time in seconds until records expire (are stale)
		 * @param evictionTime Time in seconds until records are evicted (removed)
		 */
		static setTTLExpiration(expiration: number | { expiration: number; eviction?: number; scanInterval?: number }) {
			// we set up a timer to remove expired entries. we only want the timer/reaper to run in one thread,
			// so we use the first one
			if (typeof expiration === 'number') {
				expirationMs = expiration * 1000;
				if (!evictionMs) evictionMs = 0; // by default, no extra time for eviction
			} else if (expiration && typeof expiration === 'object') {
				// an object with expiration times/options specified
				expirationMs = expiration.expiration * 1000;
				evictionMs = (expiration.eviction || 0) * 1000;
				cleanupInterval = expiration.scanInterval * 1000;
			} else throw new Error('Invalid expiration value type');
			if (expirationMs < 0) throw new Error('Expiration can not be negative');
			// default to one quarter of the total eviction time, and make sure it fits into a 32-bit signed integer
			cleanupInterval = cleanupInterval || (expirationMs + evictionMs) / 4;
			scheduleCleanup();
		}

		static getResidencyRecord(id: Id) {
			return dbisDb.get([Symbol.for('residency_by_id'), id]);
		}

		static setResidency(getResidency?: (record: object, context: Context) => ResidencyDefinition) {
			TableResource.getResidency =
				getResidency &&
				((record: object, context: Context) => {
					try {
						return getResidency(record, context);
					} catch (error: unknown) {
						(error as Error).message += ` in residency function for table ${tableName}`;
						throw error;
					}
				});
		}
		static setResidencyById(getResidencyById?: (id: Id) => number | void) {
			TableResource.getResidencyById =
				getResidencyById &&
				((id: Id) => {
					try {
						return getResidencyById(id);
					} catch (error: unknown) {
						(error as Error).message += ` in residency function for table ${tableName}`;
						throw error;
					}
				});
		}
		static getResidency(record: object, context: Context) {
			if (TableResource.getResidencyById) {
				return TableResource.getResidencyById(record[primaryKey]);
			}
			let count = replicateToCount;
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
				const replicateTo = [server.hostname]; // start with ourselves, we should always be in the list
				if (context.previousResidency) {
					// if we have a previous residency, we should preserve it
					replicateTo.push(...context.previousResidency.slice(0, count));
				} else {
					// otherwise need to create a new list of nodes to replicate to, based on available nodes
					// randomize this to ensure distribution of data
					const nodes = server.nodes.map((node) => node.name);
					const startingIndex = Math.floor(nodes.length * Math.random());
					replicateTo.push(...nodes.slice(startingIndex, startingIndex + count));
					const remainingToAdd = startingIndex + count - nodes.length;
					if (remainingToAdd > 0) replicateTo.push(...nodes.slice(0, remainingToAdd));
				}
				return replicateTo;
			}
			return; // returning undefined will return the default residency of replicating everywhere
		}

		/**
		 * Turn on auditing at runtime
		 */
		static enableAuditing(auditEnabled = true) {
			audit = auditEnabled;
			if (auditEnabled) addDeleteRemoval();
			TableResource.audit = auditEnabled;
		}
		/**
		 * Coerce the id as a string to the correct type for the primary key
		 * @param id
		 * @returns
		 */
		static coerceId(id: string): number | string {
			if (id === '') return null;
			return coerceType(id, primaryKeyAttribute);
		}

		static async dropTable() {
			delete databases[databaseName][tableName];
			for (const entry of primaryStore.getRange({ versions: true, snapshot: false, lazy: true })) {
				if (entry.metadataFlags & HAS_BLOBS && entry.value) {
					deleteBlobsInObject(entry.value);
				}
			}
			if (databaseName === databasePath) {
				// part of a database
				for (const attribute of attributes) {
					dbisDb.remove(TableResource.tableName + '/' + attribute.name);
					const index = indices[attribute.name];
					index?.drop();
				}
				dbisDb.remove(TableResource.tableName + '/');
				primaryStore.drop();
				await dbisDb.committed;
			} else {
				// legacy table per database
				console.log('legacy dropTable');
				await primaryStore.close();
				fs.unlinkSync(primaryStore.env.path);
			}
			signalling.signalSchemaChange(
				new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_TABLE, databaseName, tableName)
			);
		}
		/**
		 * This retrieves the data of this resource. By default, with no argument, just return `this`.
		 * @param target - If included, is an identifier/query that specifies the requested target to retrieve and query
		 */
		get(target?: RequestTarget): Promise<object | void> | object | void {
			const constructor: Resource = this.constructor;
			if (typeof target === 'string' && constructor.loadAsInstance !== false) return this.getProperty(target);
			if (isSearchTarget(target)) return this.search(target);
			if (target?.target === '') {
				const description = {
					// basically a describe call
					records: './', // an href to the records themselves
					name: tableName,
					database: databaseName,
					auditSize: auditStore?.getStats().entryCount,
					attributes,
					recordCount: undefined,
					estimatedRecordRange: undefined,
				};
				if (this.getContext()?.includeExpensiveRecordCountEstimates) {
					return TableResource.getRecordCount().then((recordCount) => {
						description.recordCount = recordCount.recordCount;
						description.estimatedRecordRange = recordCount.estimatedRange;
						return description;
					});
				}
				return description;
			}
			if (target !== undefined && constructor.loadAsInstance === false) {
				const context = this.getContext();
				const txn = txnForContext(context);
				const readTxn = txn.getReadTxn();
				if (readTxn?.isDone) {
					throw new Error('You can not read from a transaction that has already been committed/aborted');
				}
				const ensureLoaded = true;
				const id = requestTargetToId(target);
				return loadLocalRecord(id, context, { transaction: readTxn, ensureLoaded }, false, (entry) => {
					if (context.onlyIfCached && context.noCacheStore) {
						// don't go into the loading from source condition, but HTTP spec says to
						// return 504 (rather than 404) if there is no content and the cache-control header
						// dictates not to go to source (and not store new value)
						if (!entry?.value) throw new ServerError('Entry is not cached', 504);
					} else if (ensureLoaded) {
						const loadingFromSource = ensureLoadedFromSource(id, entry, context);
						if (loadingFromSource) {
							txn?.disregardReadTxn(); // this could take some time, so don't keep the transaction open if possible
							context.loadedFromSource = true;
							return loadingFromSource.then((entry) => entry?.value);
						}
					}
					return entry?.value;
				});
			}
			if (target?.property) return this.getProperty(target.property);
			if (this.doesExist() || target?.ensureLoaded === false || this.getContext()?.returnNonexistent) {
				return this;
			}
		}
		/**
		 * Determine if the user is allowed to get/read data from the current resource
		 * @param user The current, authenticated user
		 * @param query The parsed query from the search part of the URL
		 */
		allowRead(user, query) {
			const tablePermission = getTablePermissions(user);
			if (tablePermission?.read) {
				if (tablePermission.isSuperUser) return true;
				const attribute_permissions = tablePermission.attribute_permissions;
				const select = query?.select;
				if (attribute_permissions?.length > 0 || (hasRelationships && select)) {
					// If attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					// or if there are relationships, we need to ensure that the user has permission to read from the related table
					// Note that if we do not have a select, we do not return any relationships by default.
					if (!query) query = {};
					if (select) {
						const attrsForType = attribute_permissions?.length > 0 && attributesAsObject(attribute_permissions, 'read');
						query.select = select
							.map((property) => {
								const propertyName = property.name || property;
								if (!attrsForType || attrsForType[propertyName]) {
									const relatedTable = propertyResolvers[propertyName]?.definition?.tableClass;
									if (relatedTable) {
										// if there is a related table, we need to ensure the user has permission to read from that table and that attributes are properly restricted
										if (!property.name) property = { name: property };
										if (!relatedTable.prototype.allowRead.call(null, user, property)) return false;
										if (!property.select) return property.name; // no select was applied, just return the name
									}
									return property;
								}
							})
							.filter(Boolean);
					} else {
						query.select = attribute_permissions
							.filter((attribute) => attribute.read && !propertyResolvers[attribute.attribute_name])
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
		 * @param updatedData
		 * @param fullUpdate
		 */
		allowUpdate(user, updatedData: any) {
			const tablePermission = getTablePermissions(user);
			if (tablePermission?.update) {
				const attribute_permissions = tablePermission.attribute_permissions;
				if (attribute_permissions?.length > 0) {
					// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					const attrsForType = attributesAsObject(attribute_permissions, 'update');
					for (const key in updatedData) {
						if (!attrsForType[key]) return false;
					}
					// if this is a full put operation that removes missing properties, we don't want to remove properties
					// that the user doesn't have permission to remove
					for (const permission of attribute_permissions) {
						const key = permission.attribute_name;
						if (!permission.update && !(key in updatedData)) {
							updatedData[key] = this.getProperty(key);
						}
					}
				}
				return checkContextPermissions(this.getContext());
			}
		}
		/**
		 * Determine if the user is allowed to create new data in the current resource
		 * @param user The current, authenticated user
		 * @param newData
		 */
		allowCreate(user, newData: {}) {
			if (this.isCollection) {
				const tablePermission = getTablePermissions(user);
				if (tablePermission?.insert) {
					const attribute_permissions = tablePermission.attribute_permissions;
					if (attribute_permissions?.length > 0) {
						// if attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
						const attrsForType = attributesAsObject(attribute_permissions, 'insert');
						for (const key in newData) {
							if (!attrsForType[key]) return false;
						}
						return checkContextPermissions(this.getContext());
					} else {
						return checkContextPermissions(this.getContext());
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
			const tablePermission = getTablePermissions(user);
			return tablePermission?.delete && checkContextPermissions(this.getContext());
		}

		/**
		 * Start updating a record. The returned resource will record changes which are written
		 * once the corresponding transaction is committed. These changes can (eventually) include CRDT type operations.
		 * @param updates This can be a record to update the current resource with.
		 * @param fullUpdate The provided data in updates is the full intended record; any properties in the existing record that are not in the updates, should be removed
		 */
		update(target: RequestTarget, updates?: any, fullUpdate?: boolean) {
			let id: Id;
			// determine if it is a legacy call
			const directInstance =
				typeof updates === 'boolean' ||
				(updates === undefined &&
					(target == undefined || (typeof target === 'object' && !(target instanceof URLSearchParams))));
			if (directInstance) {
				// legacy, shift the arguments
				fullUpdate = updates;
				updates = target;
				id = this.getId();
			} else {
				id = requestTargetToId(target);
			}

			const envTxn = txnForContext(this.getContext());
			if (!envTxn) throw new Error('Can not update a table resource outside of a transaction');
			// record in the list of updating records so it can be written to the database when we commit
			if (updates === false) {
				// TODO: Remove from transaction
				return this;
			}
			let ownData, updatable;
			if (typeof updates === 'object' && updates) {
				if (fullUpdate) {
					if (!directInstance) {
						updatable = new Updatable({});
						updatable._setChanges(updates);
					} else {
						if (Object.isFrozen(updates)) updates = { ...updates };
						this.#record = {}; // clear out the existing record
						this.#changes = updates;
					}
				} else {
					if (!directInstance) {
						return when(this.get(target), (record) => {
							updatable = new Updatable(record);
							if (record) {
								updatable[VERSION] = record[VERSION];
								if (record[EXPIRES_AT]) updatable[EXPIRES_AT] = record[EXPIRES_AT];
							}
							updatable._setChanges(updates);
							this._writeUpdate(id, updatable.getChanges(), false);
							return updatable;
						});
					} else {
						ownData = this.#changes;
						if (ownData) updates = Object.assign(ownData, updates);
						this.#changes = updates;
					}
				}
			}
			this._writeUpdate(id, updatable ? updatable.getChanges() : this.#changes, fullUpdate);
			return updatable ?? this;
		}

		addTo(property, value) {
			if (typeof value === 'number' || typeof value === 'bigint') {
				if (this.#saveMode === SAVING_FULL_UPDATE) this.set(property, (+this.getProperty(property) || 0) + value);
				else {
					if (!this.#saveMode) this.update();
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
			return this.#entry;
		}
		getRecord() {
			return this.#record;
		}
		getChanges() {
			return this.#changes;
		}
		_setChanges(changes) {
			this.#changes = changes;
		}
		setRecord(record) {
			this.#record = record;
		}

		invalidate(target: RequestTargetOrId) {
			this._writeInvalidate(target ? requestTargetToId(target) : this.getId());
		}
		_writeInvalidate(id: Id, partialRecord?: any, options?: any) {
			const context = this.getContext();
			checkValidId(id);
			const transaction = txnForContext(this.getContext());
			transaction.addWrite({
				key: id,
				store: primaryStore,
				invalidated: true,
				entry: this.#entry,
				before: applyToSources.invalidate?.bind(this, context, id),
				beforeIntermediate: applyToSourcesIntermediate.invalidate?.bind(this, context, id),
				commit: (txnTime, existingEntry) => {
					if (precedesExistingVersion(txnTime, existingEntry, options?.nodeId) <= 0) return;
					partialRecord ??= null;
					for (const name in indices) {
						if (!partialRecord) partialRecord = {};
						// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
						if (partialRecord[name] === undefined) {
							partialRecord[name] = this.getProperty(name);
						}
					}
					logger.trace?.(`Invalidating entry in ${tableName} id: ${id}, timestamp: ${new Date(txnTime).toISOString()}`);

					updateRecord(
						id,
						partialRecord,
						existingEntry,
						txnTime,
						INVALIDATED,
						audit,
						{ user: context?.user, residencyId: options?.residencyId, nodeId: options?.nodeId },
						'invalidate'
					);
					// TODO: recordDeletion?
				},
			});
		}
		_writeRelocate(id: Id, options: any) {
			const context = this.getContext();
			checkValidId(id);
			const transaction = txnForContext(this.getContext());
			transaction.addWrite({
				key: id,
				store: primaryStore,
				invalidated: true,
				entry: this.#entry,
				before: applyToSources.relocate?.bind(this, context, id),
				beforeIntermediate: applyToSourcesIntermediate.relocate?.bind(this, context, id),
				commit: (txnTime, existingEntry) => {
					if (precedesExistingVersion(txnTime, existingEntry, options?.nodeId) <= 0) return;
					const residency = TableResource.getResidencyRecord(options.residencyId);
					let metadata = 0;
					let newRecord = null;
					const existingRecord = existingEntry?.value;
					if (residency && !residency.includes(server.hostname)) {
						for (const name in indices) {
							if (!newRecord) newRecord = {};
							// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
							newRecord[name] = existingRecord(name);
						}
						metadata = INVALIDATED;
					} else {
						newRecord = existingRecord;
					}

					logger.trace?.(`Relocating entry id: ${id}, timestamp: ${new Date(txnTime).toISOString()}`);

					updateRecord(
						id,
						newRecord,
						existingEntry,
						txnTime,
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
		 * @param existingEntry
		 * @param entry
		 */
		static _recordRelocate(existingEntry, entry) {
			const context = {
				previousResidency: this.getResidencyRecord(existingEntry.residencyId),
				isRelocation: true,
			};
			const residency = residencyFromFunction(this.getResidency(entry.value, context));
			let residencyId: number;
			if (residency) {
				if (!residency.includes(server.hostname)) return; // if we aren't in the residency, we don't need to do anything, we are not responsible for storing this record
				residencyId = getResidencyId(residency);
			}
			const metadata = 0;
			const record = updateRecord(
				existingEntry.key,
				entry.value, // store the record we downloaded
				existingEntry,
				existingEntry.version, // version number should not change
				metadata,
				true,
				{ residencyId, expiresAt: entry.expiresAt },
				'relocate',
				false,
				null // the audit record value should be empty since there are no changes to the actual data
			);
		}
		/**
		 * Evicting a record will remove it from a caching table. This is not considered a canonical data change, and it is assumed that retrieving this record from the source will still yield the same record, this is only removing the local copy of the record.
		 */
		static evict(id, existingRecord, existingVersion) {
			const source = this.Source;
			let entry;
			if (hasSourceGet || audit) {
				if (!existingRecord) return;
				entry = primaryStore.getEntry(id);
				if (!entry || !existingRecord) return;
				if (entry.version !== existingVersion) return;
			}
			if (hasSourceGet) {
				// if there is a resolution in-progress, abandon the eviction
				if (primaryStore.hasLock(id, entry.version)) return;
				// if there is a source, we are not "deleting" the record, just removing our local copy, but preserving what we need for indexing
				let partialRecord;
				for (const name in indices) {
					// if there are any indices, we need to preserve a partial evicted record to ensure we can still do searches
					if (!partialRecord) partialRecord = {};
					partialRecord[name] = existingRecord[name];
				}
				// if we are evicting and not deleting, need to preserve the partial record
				if (partialRecord) {
					// treat this as a record resolution (so previous version is checked) with no audit record
					return updateRecord(id, partialRecord, entry, existingVersion, EVICTED, null, null, null, true);
				}
			}
			primaryStore.ifVersion(id, existingVersion, () => {
				updateIndices(id, existingRecord, null);
			});
			if (audit) {
				// update the record to null it out, maintaining the reference to the audit history
				return updateRecord(id, null, entry, existingVersion, EVICTED, null, null, null, true);
			}
			// if no timestamps for audit, just remove
			else {
				removeEntry(primaryStore, entry ?? primaryStore.getEntry(id), existingVersion);
			}
		}
		/**
		 * This is intended to acquire a lock on a record from the whole cluster.
		 */
		lock() {
			throw new Error('Not yet implemented');
		}
		static operation(operation, context) {
			operation.table ||= tableName;
			operation.schema ||= databaseName;
			return serverUtilities.operation(operation, context);
		}

		/**
		 * Store the provided record data into the current resource. This is not written
		 * until the corresponding transaction is committed. This will either immediately fail (synchronously) or always
		 * succeed. That doesn't necessarily mean it will "win", another concurrent put could come "after" (monotonically,
		 * even if not chronologically) this one.
		 * @param record
		 * @param options
		 */
		put(target: RequestTarget, record: any): void {
			if (record === undefined || record instanceof URLSearchParams) {
				// legacy, shift the arguments
				this.update(target, true);
			} else {
				let result;
				if (Array.isArray(record)) {
					const results = [];
					for (const element of record) {
						const id = element[primaryKey];
						result = this.update(id, element, true);
						results.push(result);
					}
					result = Promise.all(results);
				} else {
					result = this.update(target, record, true);
				}
				if (result?.then) return result.then(() => undefined); // wait for the update, but return undefined
			}
		}
		patch(target: RequestTarget, recordUpdate: any): void {
			if (recordUpdate === undefined || recordUpdate instanceof URLSearchParams) this.update(target, false);
			else {
				const result = this.update(target, recordUpdate, false);
				if (result?.then) return result.then(() => undefined); // wait for the update, but return undefined
			}
		}
		// perform the actual write operation; this may come from a user request to write (put, post, etc.), or
		// a notification that a write has already occurred in the canonical data source, we need to update our
		// local copy
		_writeUpdate(id: Id, recordUpdate: any, fullUpdate: boolean, options?: any) {
			const context = this.getContext();
			const transaction = txnForContext(context);

			checkValidId(id);
			const entry = this.#entry ?? primaryStore.getEntry(id);
			this.#saveMode = fullUpdate ? SAVING_FULL_UPDATE : SAVING_CRDT_UPDATE; // mark that this resource is being saved so doesExist return true
			const write = {
				key: id,
				store: primaryStore,
				entry,
				nodeName: context?.nodeName,
				validate: (txnTime) => {
					if (!recordUpdate) recordUpdate = this.#changes;
					if (fullUpdate || (recordUpdate && hasChanges(this.#changes === recordUpdate ? this : recordUpdate))) {
						if (!context?.source) {
							transaction.checkOverloaded();
							this.validate(recordUpdate, !fullUpdate);
							if (updatedTimeProperty) {
								recordUpdate[updatedTimeProperty.name] =
									updatedTimeProperty.type === 'Date'
										? new Date(txnTime)
										: updatedTimeProperty.type === 'String'
											? new Date(txnTime).toISOString()
											: txnTime;
							}
							if (fullUpdate) {
								if (primaryKey && recordUpdate[primaryKey] !== id) recordUpdate[primaryKey] = id;
								if (createdTimeProperty) {
									if (entry?.value) recordUpdate[createdTimeProperty.name] = entry?.value[createdTimeProperty.name];
									else
										recordUpdate[createdTimeProperty.name] =
											createdTimeProperty.type === 'Date'
												? new Date(txnTime)
												: createdTimeProperty.type === 'String'
													? new Date(txnTime).toISOString()
													: txnTime;
								}
								recordUpdate = updateAndFreeze(recordUpdate); // this flatten and freeze the record
							}
							// TODO: else freeze after we have applied the changes
						}
					} else {
						transaction.removeWrite(write);
					}
				},
				before: fullUpdate
					? applyToSources.put // full update is a put, so we can use the put method if available
						? () => applyToSources.put(context, id, recordUpdate)
						: null
					: applyToSources.patch // otherwise, we need to use the patch method if available
						? () => applyToSources.patch(context, id, recordUpdate)
						: applyToSources.put // if this is incremental, but only have put, we can use that by generating the full record (at least the expected one)
							? () => applyToSources.put(context, id, updateAndFreeze(this))
							: null,
				beforeIntermediate: fullUpdate
					? applyToSourcesIntermediate.put
						? () => applyToSourcesIntermediate.put(context, id, recordUpdate)
						: null
					: applyToSourcesIntermediate.patch
						? () => applyToSourcesIntermediate.patch(context, id, recordUpdate)
						: applyToSourcesIntermediate.put
							? () => applyToSourcesIntermediate.put(context, id, updateAndFreeze(this))
							: null,
				commit: (txnTime, existingEntry, retry) => {
					if (retry) {
						if (context && existingEntry?.version > (context.lastModified || 0))
							context.lastModified = existingEntry.version;
						this.#entry = existingEntry;
						if (existingEntry?.value && existingEntry.value.getRecord)
							throw new Error('Can not assign a record to a record, check for circular references');
						if (!fullUpdate) this.#record = existingEntry?.value ?? null;
					}
					this.#changes = undefined; // once we are committing to write this update, we no longer should track the changes, and want to avoid double application (of any CRDTs)
					this.#version = txnTime;
					const existingRecord = existingEntry?.value;
					let updateToApply = recordUpdate;

					this.#saveMode = 0;
					let omitLocalRecord = false;
					// we use optimistic locking to only commit if the existing record state still holds true.
					// this is superior to using an async transaction since it doesn't require JS execution
					//  during the write transaction.
					let precedes_existing_version = precedesExistingVersion(txnTime, existingEntry, options?.nodeId);
					let auditRecordToStore: any; // what to store in the audit record. For a full update, this can be left undefined in which case it is the same as full record update and optimized to use a binary copy
					if (precedes_existing_version <= 0) {
						// This block is to handle the case of saving an update where the transaction timestamp is older than the
						// existing timestamp, which means that we received updates out of order, and must resequence the application
						// of the updates to the record to ensure consistency across the cluster
						// TODO: can the previous version be older, but even more previous version be newer?
						if (audit) {
							// incremental CRDT updates are only available with audit logging on
							let localTime = existingEntry.localTime;
							let auditedVersion = existingEntry.version;
							logger.trace?.('Applying CRDT update to record with id: ', id, 'applying later update:', auditedVersion);
							const succeedingUpdates = []; // record the "future" updates, as we need to apply the updates in reverse order
							while (localTime > txnTime || (auditedVersion >= txnTime && localTime > 0)) {
								const auditEntry = auditStore.get(localTime);
								if (!auditEntry) break;
								const auditRecord = readAuditEntry(auditEntry);
								auditedVersion = auditRecord.version;
								if (auditedVersion >= txnTime) {
									if (auditedVersion === txnTime) {
										precedes_existing_version = precedesExistingVersion(
											txnTime,
											{ version: auditedVersion, localTime: localTime },
											options?.nodeId
										);
										if (precedes_existing_version === 0) {
											return; // treat a tie as a duplicate and drop it
										}
										if (precedes_existing_version > 0) continue; // if the existing version is older, we can skip this update
									}
									if (auditRecord.type === 'patch') {
										// record patches so we can reply in order
										succeedingUpdates.push(auditRecord);
										auditRecordToStore = recordUpdate; // use the original update for the audit record
									} else if (auditRecord.type === 'put' || auditRecord.type === 'delete') {
										// There is newer full record update, so this incremental update is completely superseded
										// TODO: We should still store the audit record for historical purposes
										return;
									}
								}
								localTime = auditRecord.previousLocalTime;
							}
							succeedingUpdates.sort((a, b) => a.version - b.version); // order the patches
							for (const auditRecord of succeedingUpdates) {
								const newerUpdate = auditRecord.getValue(primaryStore);
								updateToApply = rebuildUpdateBefore(updateToApply, newerUpdate, fullUpdate);
								logger.debug?.('Rebuilding update with future patch:', updateToApply);
								if (!updateToApply) return; // if all changes are overwritten, nothing left to do
							}
						} else if (fullUpdate) {
							// if no audit, we can't accurately do incremental updates, so we just assume the last update
							// was the same type. Assuming a full update this record update loses and there are no changes
							// TODO: We should still store the audit record for historical purposes
							return;
						} else {
							// no audit, assume updates are overwritten except CRDT operations or properties that didn't exist
							updateToApply = rebuildUpdateBefore(updateToApply, existingRecord, fullUpdate);
							logger.debug?.('Rebuilding update without audit:', updateToApply);
						}
					}
					let recordToStore: any;
					if (fullUpdate) recordToStore = updateToApply;
					else {
						this.#record = existingRecord;
						recordToStore = updateAndFreeze(this, updateToApply);
					}
					this.#record = recordToStore;
					if (recordToStore && recordToStore.getRecord)
						throw new Error('Can not assign a record to a record, check for circular references');
					let residencyId: number;
					if (options?.residencyId != undefined) residencyId = options.residencyId;
					else {
						if (entry?.residencyId) context.previousResidency = TableResource.getResidencyRecord(entry.residencyId);
						const residency = residencyFromFunction(TableResource.getResidency(recordToStore, context));
						if (residency) {
							if (!residency.includes(server.hostname)) {
								// if we aren't in the residency list, specify that our local record should be omitted or be partial
								auditRecordToStore ??= recordToStore;
								omitLocalRecord = true;
								if (TableResource.getResidencyById) {
									// complete omission of the record that doesn't belong here
									recordToStore = undefined;
								} else {
									// store the partial record
									recordToStore = null;
									for (const name in indices) {
										if (!recordToStore) {
											recordToStore = {};
										}
										// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
										recordToStore[name] = auditRecordToStore[name];
									}
								}
							}
						}
						residencyId = getResidencyId(residency);
					}
					if (!fullUpdate) {
						// we use our own data as the basis for the audit record, which will include information about the incremental updates, even if it was overwritten by CRDT resolution
						auditRecordToStore = recordUpdate;
					}
					const expiresAt = context?.expiresAt ?? (expirationMs ? expirationMs + Date.now() : -1);
					logger.trace?.(
						`Saving record with id: ${id}, timestamp: ${new Date(txnTime).toISOString()}${
							expiresAt ? ', expires at: ' + new Date(expiresAt).toISOString() : ''
						}${
							existingEntry ? ', replaces entry from: ' + new Date(existingEntry.version).toISOString() : ', new entry'
						}`,
						(() => {
							try {
								return JSON.stringify(recordToStore).slice(0, 100);
							} catch (e) {
								return '';
							}
						})()
					);
					updateIndices(id, existingRecord, recordToStore);
					const type = fullUpdate ? 'put' : 'patch';

					updateRecord(
						id,
						recordToStore,
						existingEntry,
						txnTime,
						omitLocalRecord ? INVALIDATED : 0,
						audit,
						{
							omitLocalRecord,
							user: context?.user,
							residencyId,
							expiresAt,
							nodeId: options?.nodeId,
							originatingOperation: context?.originatingOperation,
						},
						type,
						false,
						auditRecordToStore
					);
					if (context.expiresAt) scheduleCleanup();
				},
			};
			transaction.addWrite(write);
		}

		async delete(target: RequestTarget): Promise<boolean> {
			if (isSearchTarget(target)) {
				target.select = ['$id']; // just get the primary key of each record so we can delete them
				for await (const entry of this.search(target)) {
					this._writeDelete(entry.$id);
				}
				return true;
			}

			const id = requestTargetToId(target);
			this._writeDelete(id);
			return this.constructor.loadAsInstance === false ? true : Boolean(this.#record);
		}
		_writeDelete(id: Id, options?: any) {
			const transaction = txnForContext(this.getContext());
			checkValidId(id);
			const context = this.getContext();
			transaction.addWrite({
				key: id,
				store: primaryStore,
				entry: this.#entry,
				nodeName: context?.nodeName,
				before: applyToSources.delete?.bind(this, context, id),
				beforeIntermediate: applyToSourcesIntermediate.delete?.bind(this, context, id),
				commit: (txnTime, existingEntry, retry) => {
					const existingRecord = existingEntry?.value;
					if (retry) {
						if (context && existingEntry?.version > (context.lastModified || 0))
							context.lastModified = existingEntry.version;
						TableResource._updateResource(this, existingEntry);
					}
					if (precedesExistingVersion(txnTime, existingEntry, options?.nodeId) <= 0) return; // a newer record exists locally
					updateIndices(this.getId(), existingRecord);
					logger.trace?.(`Deleting record with id: ${id}, txn timestamp: ${new Date(txnTime).toISOString()}`);
					if (audit || trackDeletes) {
						updateRecord(
							id,
							null,
							existingEntry,
							txnTime,
							0,
							audit,
							{ user: context?.user, nodeId: options?.nodeId },
							'delete'
						);
						if (!audit) scheduleCleanup();
					} else {
						removeEntry(primaryStore, existingEntry);
					}
				},
			});
			return true;
		}

		search(request: RequestTarget): AsyncIterable<any> {
			const context = this.getContext();
			const txn = txnForContext(context);
			if (!request) throw new Error('No query provided');
			let conditions = request.conditions;
			if (!conditions)
				conditions = Array.isArray(request) ? request : request[Symbol.iterator] ? Array.from(request) : [];
			else if (conditions.length === undefined) {
				conditions = conditions[Symbol.iterator] ? Array.from(conditions) : [conditions];
			}
			const id = request.id ?? this.getId();
			if (id) {
				conditions = [
					{
						attribute: null,
						comparator: Array.isArray(id) ? 'prefix' : 'starts_with',
						value: id,
					},
				].concat(conditions);
			}
			let orderAlignedCondition;
			const filtered = {};

			function prepareConditions(conditions: Condition[], operator: string) {
				// some validation:
				let isIntersection: boolean;
				switch (operator) {
					case 'and':
					case undefined:
						if (conditions.length < 1) throw new Error('An "and" operator requires at least one condition');
						isIntersection = true;
						break;
					case 'or':
						if (conditions.length < 2) throw new Error('An "or" operator requires at least two conditions');
						break;
					default:
						throw new Error('Invalid operator ' + operator);
				}
				for (const condition of conditions) {
					if (condition.conditions) {
						condition.conditions = prepareConditions(condition.conditions, condition.operator);
						continue;
					}
					const attribute_name = condition[0] ?? condition.attribute;
					const attribute = attribute_name == null ? primaryKeyAttribute : findAttribute(attributes, attribute_name);
					if (!attribute) {
						if (attribute_name != null)
							throw handleHDBError(new Error(), `${attribute_name} is not a defined attribute`, 404);
					} else if (attribute.type || COERCIBLE_OPERATORS[condition.comparator]) {
						// Do auto-coercion or coercion as required by the attribute type
						if (condition[1] === undefined) condition.value = coerceTypedValues(condition.value, attribute);
						else condition[1] = coerceTypedValues(condition[1], attribute);
					}
					if (condition.chainedConditions) {
						if (condition.chainedConditions.length === 1 && (!condition.operator || condition.operator == 'and')) {
							const chained = condition.chainedConditions[0];
							let upper: any, lower: any;
							if (
								chained.comparator === 'gt' ||
								chained.comparator === 'greater_than' ||
								chained.comparator === 'ge' ||
								chained.comparator === 'greater_than_equal'
							) {
								upper = condition;
								lower = chained;
							} else {
								upper = chained;
								lower = condition;
							}
							if (
								upper.comparator !== 'lt' &&
								upper.comparator !== 'less_than' &&
								upper.comparator !== 'le' &&
								upper.comparator !== 'less_than_equal'
							) {
								throw new Error(
									'Invalid chained condition, only less than and greater than conditions can be chained together'
								);
							}
							const isGe = lower.comparator === 'ge' || lower.comparator === 'greater_than_equal';
							const isLe = upper.comparator === 'le' || upper.comparator === 'less_than_equal';
							condition.comparator = (isGe ? 'ge' : 'gt') + (isLe ? 'le' : 'lt');
							condition.value = [lower.value, upper.value];
						} else throw new Error('Multiple chained conditions are not currently supported');
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
			let postOrdering;
			if (sort) {
				// TODO: Support index-assisted sorts of unions, which will require potentially recursively adding/modifying an order aligned condition and be able to recursively undo it if necessary
				if (operator !== 'or') {
					const attribute_name = sort.attribute;
					if (attribute_name == undefined) throw new ClientError('Sort requires an attribute');
					orderAlignedCondition = conditions.find(
						(condition) => flattenKey(condition.attribute) === flattenKey(attribute_name)
					);
					if (orderAlignedCondition) {
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
							orderAlignedCondition = { attribute: attribute_name, comparator: 'sort' };
							conditions.push(orderAlignedCondition);
						} else if (conditions.length === 0 && !request.allowFullScan)
							throw handleHDBError(
								new Error(),
								`${
									Array.isArray(attribute_name) ? attribute_name.join('.') : attribute_name
								} is not indexed and not combined with any other conditions`,
								404
							);
					}
					if (orderAlignedCondition) orderAlignedCondition.descending = Boolean(sort.descending);
				}
			}
			conditions = orderConditions(conditions, operator);

			if (sort) {
				if (orderAlignedCondition && conditions[0] === orderAlignedCondition) {
					// The db index is providing the order for the first sort, may need post ordering next sort order
					if (sort.next) {
						postOrdering = {
							dbOrderedAttribute: sort.attribute,
							attribute: sort.next.attribute,
							descending: sort.next.descending,
							next: sort.next.next,
						};
					}
				} else {
					// if we had to add an aligned condition that isn't first, we remove it and do ordering later
					if (orderAlignedCondition) conditions.splice(conditions.indexOf(orderAlignedCondition), 1);
					postOrdering = sort;
				}
			}
			const select = request.select;
			if (conditions.length === 0) {
				conditions = [{ attribute: primaryKey, comparator: 'greater_than', value: true }];
			}
			if (request.explain) {
				return {
					conditions,
					operator,
					postOrdering,
					selectApplied: Boolean(select),
				};
			}
			// we mark the read transaction as in use (necessary for a stable read
			// transaction, and we really don't care if the
			// counts are done in the same read transaction because they are just estimates) until the search
			// results have been iterated and finished.
			const readTxn = txn.useReadTxn();
			let entries = executeConditions(
				conditions,
				operator,
				TableResource,
				readTxn,
				request,
				context,
				(results: any[], filters: Function[]) => transformToEntries(results, select, context, readTxn, filters),
				filtered
			);
			const ensure_loaded = request.ensureLoaded !== false;
			if (!postOrdering) entries = applyOffset(entries); // if there is no post ordering, we can apply the offset now
			const transformToRecord = TableResource.transformEntryForSelect(
				select,
				context,
				readTxn,
				filtered,
				ensure_loaded,
				true
			);
			let results = TableResource.transformToOrderedSelect(
				entries,
				select,
				postOrdering,
				readTxn,
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
			if (postOrdering) results = applyOffset(results); // if there is post ordering, we have to apply the offset after sorting
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
		 * @param canSkip
		 * @returns
		 */
		static transformToOrderedSelect(
			entries: any[],
			select: (string | SubSelect)[],
			sort: Sort,
			context: Context,
			readTxn: any,
			transformToRecord: Function
		) {
			let results = new RangeIterable();
			if (sort) {
				// there might be some situations where we don't need to transform to entries for sorting, not sure
				entries = transformToEntries(entries, select, context, readTxn, null);
				let ordered;
				// if we are doing post-ordering, we need to get records first, then sort them
				results.iterate = function () {
					let sortedArrayIterator: IterableIterator<any>;
					const dbIterator = entries[Symbol.asyncIterator]
						? entries[Symbol.asyncIterator]()
						: entries[Symbol.iterator]();
					let dbDone: boolean;
					const dbOrderedAttribute = sort.dbOrderedAttribute;
					let enqueuedEntryForNextGroup: any;
					let lastGroupingValue: any;
					let firstEntry = true;
					function createComparator(order: Sort) {
						const nextComparator = order.next && createComparator(order.next);
						const descending = order.descending;
						return (entryA, entryB) => {
							const a = getAttributeValue(entryA, order.attribute, context);
							const b = getAttributeValue(entryB, order.attribute, context);
							const diff = descending ? compareKeys(b, a) : compareKeys(a, b);
							if (diff === 0) return nextComparator?.(entryA, entryB) || 0;
							return diff;
						};
					}
					const comparator = createComparator(sort);
					return {
						async next() {
							let iteration: IteratorResult<any>;
							if (sortedArrayIterator) {
								iteration = sortedArrayIterator.next();
								if (iteration.done) {
									if (dbDone) {
										if (results.onDone) results.onDone();
										return iteration;
									}
								} else
									return {
										value: await transformToRecord.call(this, iteration.value),
									};
							}
							ordered = [];
							if (enqueuedEntryForNextGroup) ordered.push(enqueuedEntryForNextGroup);
							// need to load all the entries into ordered
							do {
								iteration = await dbIterator.next();
								if (iteration.done) {
									dbDone = true;
									if (!ordered.length) {
										if (results.onDone) results.onDone();
										return iteration;
									} else break;
								} else {
									let entry = iteration.value;
									if (entry?.then) entry = await entry;
									// if the index has already provided the first order of sorting, we only need to sort
									// within each grouping
									if (dbOrderedAttribute) {
										const groupingValue = getAttributeValue(entry, dbOrderedAttribute, context);
										if (firstEntry) {
											firstEntry = false;
											lastGroupingValue = groupingValue;
										} else if (groupingValue !== lastGroupingValue) {
											lastGroupingValue = groupingValue;
											enqueuedEntryForNextGroup = entry;
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
							sortedArrayIterator = ordered[Symbol.iterator]();
							iteration = sortedArrayIterator.next();
							if (!iteration.done)
								return {
									value: await transformToRecord.call(this, iteration.value),
								};
							if (results.onDone) results.onDone();
							return iteration;
						},
						return() {
							if (results.onDone) results.onDone();
							dbIterator.return();
						},
						throw() {
							if (results.onDone) results.onDone();
							dbIterator.throw();
						},
					};
				};
				const applySortingOnSelect = (sort) => {
					if (typeof select === 'object' && Array.isArray(sort.attribute)) {
						for (let i = 0; i < select.length; i++) {
							const column = select[i];
							let columnSort;
							if (column.name === sort.attribute[0]) {
								columnSort = column.sort || (column.sort = {});
								while (columnSort.next) columnSort = columnSort.next;
								columnSort.attribute = sort.attribute.slice(1);
								columnSort.descending = sort.descending;
							} else if (column === sort.attribute[0]) {
								select[i] = columnSort = {
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
				results = results.map(function (entry) {
					try {
						// because this is a part of a stream of results, we will often be continuing to iterate over the results when there are errors,
						// but to improve the legibility of the error, we attach the primary key to the error
						const result = transformToRecord.call(this, entry);
						// if it is a catchable thenable (promise)
						if (typeof result?.catch === 'function')
							return result.catch((error) => {
								error.partialObject = { [primaryKey]: entry.key };
								throw error;
							});
						return result;
					} catch (error) {
						error.partialObject = { [primaryKey]: entry.key };
						throw error;
					}
				});
			}
			return results;
		}
		/**
		 * This is responsible for select()ing the attributes/properties from returned entries
		 * @param select
		 * @param context
		 * @param filtered
		 * @param ensure_loaded
		 * @param canSkip
		 * @returns
		 */
		static transformEntryForSelect(select, context, readTxn, filtered, ensure_loaded?, canSkip?) {
			if (
				select &&
				(select === primaryKey || (select?.length === 1 && select[0] === primaryKey && Array.isArray(select)))
			) {
				// fast path if only the primary key is selected, so we don't have to load records
				const transform = (entry) => {
					if (context?.transaction?.stale) context.transaction.stale = false;
					return entry?.key ?? entry;
				};
				if (select === primaryKey) return transform;
				else if (select.asArray) return (entry) => [transform(entry)];
				else return (entry) => ({ [primaryKey]: transform(entry) });
			}
			let checkLoaded;
			if (
				ensure_loaded &&
				hasSourceGet &&
				// determine if we need to fully loading the records ahead of time, this is why we would not need to load the full record:
				!(typeof select === 'string' ? [select] : select)?.every((attribute) => {
					let attribute_name;
					if (typeof attribute === 'object') {
						attribute_name = attribute.name;
					} else attribute_name = attribute;
					// TODO: Resolvers may not need a full record, either because they are not using the record, or because they are a redirected property
					return indices[attribute_name] || attribute_name === primaryKey;
				})
			) {
				checkLoaded = true;
			}
			let transformCache;
			const transform = function (entry: Entry) {
				let record;
				if (context?.transaction?.stale) context.transaction.stale = false;
				if (entry != undefined) {
					record = entry.value || entry.deref?.()?.value;
					if ((!record && (entry.key === undefined || entry.deref)) || entry.metadataFlags & INVALIDATED) {
						if (entry.metadataFlags & INVALIDATED && context.replicateFrom === false && canSkip && entry.residencyId) {
							return SKIP;
						}
						// if the record is not loaded, either due to the entry actually be a key, or the entry's value
						// being GC'ed, we need to load it now
						entry = loadLocalRecord(
							entry.key ?? entry,
							context,
							{
								transaction: readTxn,
								lazy: select?.length < 4,
								ensureLoaded: ensure_loaded,
							},
							this?.isSync,
							(entry: Entry) => entry
						);
						if (entry?.then) return entry.then(transform.bind(this));
						record = entry?.value;
					}
					if (
						(checkLoaded && entry?.metadataFlags & (INVALIDATED | EVICTED)) || // invalidated or evicted should go to load from source
						(entry?.expiresAt != undefined && entry?.expiresAt < Date.now())
					) {
						// should expiration really apply?
						if (context.onlyIfCached && context.noCacheStore) {
							return {
								[primaryKey]: entry.key,
								message: 'This entry has expired',
							};
						}
						const loadingFromSource = ensureLoadedFromSource(entry.key ?? entry, entry, context);
						if (loadingFromSource?.then) {
							return loadingFromSource.then(transform);
						}
					}
				}
				if (record == null) return canSkip ? SKIP : record;
				if (select && !(select[0] === '*' && select.length === 1)) {
					let promises: Promise<any>[];
					const selectAttribute = (attribute, callback) => {
						let attribute_name;
						if (typeof attribute === 'object') {
							attribute_name = attribute.name;
						} else attribute_name = attribute;
						const resolver = propertyResolvers?.[attribute_name];
						let value;
						if (resolver) {
							const filterMap = filtered?.[attribute_name];
							if (filterMap) {
								if (filterMap.hasMappings) {
									const key = resolver.from ? record[resolver.from] : flattenKey(entry.key);
									value = filterMap.get(key);
									if (!value) value = [];
								} else {
									value = filterMap.fromRecord?.(record);
								}
							} else {
								value = resolver(record, context, entry);
							}
							const handleResolvedValue = (value: any) => {
								if (value && typeof value === 'object') {
									const targetTable = resolver.definition?.tableClass || TableResource;
									if (!transformCache) transformCache = {};
									const transform =
										transformCache[attribute_name] ||
										(transformCache[attribute_name] = targetTable.transformEntryForSelect(
											// if it is a simple string, there is no select for the next level,
											// otherwise pass along the nested selected
											attribute_name === attribute
												? null
												: attribute.select || (Array.isArray(attribute) ? attribute : null),
											context,
											readTxn,
											filterMap,
											ensure_loaded
										));
									if (Array.isArray(value)) {
										const results = [];
										const iterator = targetTable
											.transformToOrderedSelect(
												value,
												attribute.select,
												typeof attribute.sort === 'object' && attribute.sort,
												context,
												readTxn,
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
									readTxn,
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
							const forceNulls = select.forceNulls;
							for (const attribute of select) {
								if (attribute === '*')
									for (const key in record) {
										selected[key] = record[key];
									}
								else
									selectAttribute(attribute, (value, attribute_name) => {
										if (value === undefined && forceNulls) value = null;
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
			if (!auditStore) throw new Error('Can not subscribe to a table without an audit log');
			if (!audit) {
				table({ table: tableName, database: databaseName, schemaDefined, attributes, audit: true });
			}
			if (!request) request = {};
			const getFullRecord = !request.rawEvents;
			let pendingRealTimeQueue = []; // while we are servicing a loop for older messages, we have to queue up real-time messages and deliver them in order
			const tableReference = this;
			const subscription = addSubscription(
				TableResource,
				this.getId() ?? null, // treat undefined and null as the root
				function (id: Id, auditRecord: any, localTime: number, beginTxn: boolean) {
					try {
						let value = auditRecord.getValue?.(primaryStore, getFullRecord);
						let type = auditRecord.type;
						if (!value && type === 'patch' && getFullRecord) {
							// we don't have the full record, need to get it
							const entry = primaryStore.getEntry(id);
							// if the current record matches the timestamp, we can use that
							if (entry?.version === auditRecord.version) {
								value = entry.value;
							} else {
								// otherwise try to go back in the audit log
								value = auditRecord.getValue?.(primaryStore, true, localTime);
							}
							type = 'put';
						}
						const event = {
							id,
							localTime,
							value,
							version: auditRecord.version,
							type,
							beginTxn,
						};
						if (pendingRealTimeQueue) pendingRealTimeQueue.push(event);
						else this.send(event);
					} catch (error) {
						logger.error?.(error);
					}
				},
				request.startTime || 0,
				request
			);
			const result = (async () => {
				if (this.isCollection) {
					subscription.includeDescendants = true;
					if (request.onlyChildren) subscription.onlyChildren = true;
				}
				if (request.supportsTransactions) subscription.supportsTransactions = true;
				const thisId = this.getId();
				let count = request.previousCount;
				if (count > 1000) count = 1000; // don't allow too many, we have to hold these in memory
				let startTime = request.startTime;
				if (this.isCollection) {
					// a collection should retrieve all descendant ids
					if (startTime) {
						if (count)
							throw new ClientError('startTime and previousCount can not be combined for a table level subscription');
						// start time specified, get the audit history for this time range
						for (const { key, value: auditEntry } of auditStore.getRange({
							start: startTime,
							exclusiveStart: true,
							snapshot: false, // no need for a snapshot, audits don't change
						})) {
							const auditRecord = readAuditEntry(auditEntry);
							if (auditRecord.tableId !== tableId) continue;
							const id = auditRecord.recordId;
							if (thisId == null || isDescendantId(thisId, id)) {
								const value = auditRecord.getValue(primaryStore, getFullRecord, key);
								subscription.send({
									id,
									localTime: key,
									value,
									version: auditRecord.version,
									type: auditRecord.type,
								});
								if (subscription.queue?.length > EVENT_HIGH_WATER_MARK) {
									// if we have too many messages, we need to pause and let the client catch up
									if ((await subscription.waitForDrain()) === false) return;
								}
							}
							// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
							//await rest(); // yield for fairness
							subscription.startTime = key; // update so don't double send
						}
					} else if (count) {
						const history = [];
						// we are collecting the history in reverse order to get the right count, then reversing to send
						for (const { key, value: auditEntry } of auditStore.getRange({ start: 'z', end: false, reverse: true })) {
							try {
								const auditRecord = readAuditEntry(auditEntry);
								if (auditRecord.tableId !== tableId) continue;
								const id = auditRecord.recordId;
								if (thisId == null || isDescendantId(thisId, id)) {
									const value = auditRecord.getValue(primaryStore, getFullRecord, key);
									history.push({ id, localTime: key, value, version: auditRecord.version, type: auditRecord.type });
									if (--count <= 0) break;
								}
							} catch (error) {
								logger.error('Error getting history entry', key, error);
							}
							// TODO: Would like to do this asynchronously, but would need to catch up on anything published during iteration
							//await rest(); // yield for fairness
						}
						for (let i = history.length; i > 0; ) {
							subscription.send(history[--i]);
						}
						if (history[0]) subscription.startTime = history[0].localTime; // update so don't double send
					} else if (!request.omitCurrent) {
						for (const { key: id, value, version, localTime } of primaryStore.getRange({
							start: thisId ?? false,
							end: thisId == null ? undefined : [thisId, MAXIMUM_KEY],
							versions: true,
							snapshot: false, // no need for a snapshot, just want the latest data
						})) {
							if (!value) continue;
							subscription.send({ id, localTime, value, version, type: 'put' });
							if (subscription.queue?.length > EVENT_HIGH_WATER_MARK) {
								// if we have too many messages, we need to pause and let the client catch up
								if ((await subscription.waitForDrain()) === false) return;
							}
						}
					}
				} else {
					if (count && !startTime) startTime = 0;
					let localTime = this.#entry?.localTime;
					if (localTime === PENDING_LOCAL_TIME) {
						// we can't use the pending commit because it doesn't have the local audit time yet,
						// so try to retrieve the previous/committed record
						primaryStore.cache?.delete(thisId);
						this.#entry = primaryStore.getEntry(thisId);
						logger.trace?.('re-retrieved record', localTime, this.#entry?.localTime);
						localTime = this.#entry?.localTime;
					}
					logger.trace?.('Subscription from', startTime, 'from', thisId, localTime);
					if (startTime < localTime) {
						// start time specified, get the audit history for this record
						const history = [];
						let nextTime = localTime;
						do {
							//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
							//await auditStore.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
							const auditEntry = auditStore.get(nextTime);
							if (auditEntry) {
								request.omitCurrent = true; // we are sending the current version from history, so don't double send
								const auditRecord = readAuditEntry(auditEntry);
								const value = auditRecord.getValue(primaryStore, getFullRecord, nextTime);
								if (getFullRecord) auditRecord.type = 'put';
								history.push({ id: thisId, value, localTime: nextTime, ...auditRecord });
								nextTime = auditRecord.previousLocalTime;
							} else break;
							if (count) count--;
						} while (nextTime > startTime && count !== 0);
						for (let i = history.length; i > 0; ) {
							subscription.send(history[--i]);
						}
						subscription.startTime = localTime; // make sure we don't re-broadcast the current version that we already sent
					}
					if (!request.omitCurrent && this.doesExist()) {
						// if retain and it exists, send the current value first
						subscription.send({
							id: thisId,
							localTime,
							value: this.#record,
							version: this.#version,
							type: 'put',
						});
					}
				}
				// now send any queued messages
				for (const event of pendingRealTimeQueue) {
					subscription.send(event);
				}
				pendingRealTimeQueue = null;
			})();
			if (request.listener) subscription.on('data', request.listener);
			return subscription;
		}

		/**
		 * Subscribe on one thread unless this is a per-thread subscription
		 * @param workerIndex
		 * @param options
		 */
		static subscribeOnThisThread(workerIndex, options) {
			return workerIndex === 0 || options?.crossThreads === false;
		}
		doesExist() {
			return Boolean(this.#record || this.#saveMode);
		}

		/**
		 * Publishing a message to a record adds an (observable) entry in the audit log, but does not change
		 * the record at all. This entries should be replicated and trigger subscription listeners.
		 * @param id
		 * @param message
		 * @param options
		 */
		publish(target: RequestTarget, message: any, options?: any) {
			if (message === undefined || message instanceof URLSearchParams) {
				// legacy arg format, shift the args
				this._writePublish(this.getId(), target, message);
			} else {
				const id = requestTargetToId(target);
				this._writePublish(id, message, options);
			}
		}
		_writePublish(id: Id, message, options?: any) {
			const transaction = txnForContext(this.getContext());
			id ??= null;
			if (id !== null) checkValidId(id); // note that we allow the null id for publishing so that you can publish to the root topic
			const context = this.getContext();
			transaction.addWrite({
				key: id,
				store: primaryStore,
				entry: this.#entry,
				nodeName: context?.nodeName,
				validate: () => {
					if (!context?.source) {
						transaction.checkOverloaded();
						this.validate(message);
					}
				},
				before: applyToSources.publish?.bind(this, context, id, message),
				beforeIntermediate: applyToSourcesIntermediate.publish?.bind(this, context, id, message),
				commit: (txnTime, existingEntry, retries) => {
					// just need to update the version number of the record so it points to the latest audit record
					// but have to update the version number of the record
					// TODO: would be faster to use getBinaryFast here and not have the record loaded

					if (existingEntry === undefined && trackDeletes && !audit) {
						scheduleCleanup();
					}
					logger.trace?.(`Publishing message to id: ${id}, timestamp: ${new Date(txnTime).toISOString()}`);
					// always audit this, but don't change existing version
					// TODO: Use direct writes in the future (copying binary data is hard because it invalidates the cache)
					updateRecord(
						id,
						existingEntry?.value ?? null,
						existingEntry,
						existingEntry?.version || txnTime,
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
			let validationErrors;
			const validateValue = (value, attribute, name) => {
				if (attribute.type && value != null) {
					if (patch && value.__op__) value = value.value;
					if (attribute.properties) {
						if (typeof value !== 'object') {
							(validationErrors || (validationErrors = [])).push(
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
									(validationErrors || (validationErrors = [])).push(
										`Property ${key} is not allowed within object in property ${name}`
									);
								}
							}
						}
					} else {
						switch (attribute.type) {
							case 'Int':
								if (typeof value !== 'number' || value >> 0 !== value)
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be an integer (from -2147483648 to 2147483647)`
									);
								break;
							case 'Long':
								if (typeof value !== 'number' || !(Math.floor(value) === value && Math.abs(value) <= 9007199254740992))
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(
											value
										)} in property ${name} must be an integer (from -9007199254740992 to 9007199254740992)`
									);
								break;
							case 'Float':
								if (typeof value !== 'number')
									(validationErrors || (validationErrors = [])).push(
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
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a string, or an array of strings`
									);
								break;
							case 'String':
								if (typeof value !== 'string')
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a string`
									);
								break;
							case 'Boolean':
								if (typeof value !== 'boolean')
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a boolean`
									);
								break;
							case 'Date':
								if (!(value instanceof Date)) {
									if (typeof value === 'string' || typeof value === 'number') return new Date(value);
									else
										(validationErrors || (validationErrors = [])).push(
											`Value ${stringify(value)} in property ${name} must be a Date`
										);
								}
								break;
							case 'BigInt':
								if (typeof value !== 'bigint') {
									// do coercion because otherwise it is rather difficult to get numbers to consistently be bigints
									if (typeof value === 'string' || typeof value === 'number') return BigInt(value);
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a bigint`
									);
								}
								break;
							case 'Bytes':
								if (!(value instanceof Uint8Array)) {
									if (typeof value === 'string') return Buffer.from(value);
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a Buffer or Uint8Array`
									);
								}
								break;
							case 'Blob':
								if (!(value instanceof Blob)) {
									if (typeof value === 'string') value = Buffer.from(value);
									if (value instanceof Buffer) {
										return createBlob(value, { type: 'text/plain' });
									}
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be a Blob`
									);
								}
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
									(validationErrors || (validationErrors = [])).push(
										`Value ${stringify(value)} in property ${name} must be an Array`
									);

								break;
						}
					}
				}
				if (attribute.nullable === false && value == null) {
					(validationErrors || (validationErrors = [])).push(
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
						(validationErrors || (validationErrors = [])).push(`Property ${key} is not allowed`);
					}
				}
			}

			if (validationErrors) {
				throw new ClientError(validationErrors.join('. '));
			}
		}
		getUpdatedTime() {
			return this.#version;
		}
		wasLoadedFromSource(): boolean | void {
			return hasSourceGet ? Boolean(this.#loadedFromSource) : undefined;
		}
		static async addAttributes(attributesToAdd) {
			const new_attributes = attributes.slice(0);
			for (const attribute of attributesToAdd) {
				if (!attribute.name) throw new ClientError('Attribute name is required');
				if (attribute.name.match(/[`/]/))
					throw new ClientError('Attribute names cannot include backticks or forward slashes');
				validateAttribute(attribute.name);
				new_attributes.push(attribute);
			}
			table({
				table: tableName,
				database: databaseName,
				schemaDefined,
				attributes: new_attributes,
			});
			return TableResource.indexingOperation;
		}
		static async removeAttributes(names: string[]) {
			const new_attributes = attributes.filter((attribute) => !names.includes(attribute.name));
			table({
				table: tableName,
				database: databaseName,
				schemaDefined,
				attributes: new_attributes,
			});
			return TableResource.indexingOperation;
		}
		/**
		 * Get the size of the table in bytes (based on amount of pages stored in the database)
		 * @param options
		 */
		static getSize() {
			const stats = primaryStore.getStats();
			return (stats.treeBranchPageCount + stats.treeLeafPageCount + stats.overflowPages) * stats.pageSize;
		}
		static getAuditSize() {
			const stats = auditStore?.getStats();
			return stats && (stats.treeBranchPageCount + stats.treeLeafPageCount + stats.overflowPages) * stats.pageSize;
		}
		static getStorageStats() {
			const storePath = primaryStore.env.path;
			const stats: any = fs.statfsSync?.(storePath) ?? {};
			return {
				available: stats.bavail * stats.bsize,
				free: stats.bfree * stats.bsize,
				size: stats.blocks * stats.bsize,
			};
		}
		static async getRecordCount(options?: any) {
			// iterate through the metadata entries to exclude their count and exclude the deletion counts
			const entryCount = primaryStore.getStats().entryCount;
			const TIME_LIMIT = 1000 / 2; // one second time limit, enforced by seeing if we are halfway through at 500ms
			const start = performance.now();
			const halfway = Math.floor(entryCount / 2);
			const exactCount = options?.exactCount;
			let recordCount = 0;
			let entriesScanned = 0;
			let limit: number;
			for (const { value } of primaryStore.getRange({ start: true, lazy: true, snapshot: false })) {
				if (value != null) recordCount++;
				entriesScanned++;
				await rest();
				if (!exactCount && entriesScanned < halfway && performance.now() - start > TIME_LIMIT) {
					// it is taking too long, so we will just take this sample and a sample from the end to estimate
					limit = entriesScanned;
					break;
				}
			}
			if (limit) {
				// in this case we are going to make an estimate of the table count using the first thousand
				// entries and last thousand entries
				const firstRecordCount = recordCount;
				recordCount = 0;
				for (const { value } of primaryStore.getRange({
					start: '\uffff',
					reverse: true,
					lazy: true,
					limit,
					snapshot: false,
				})) {
					if (value != null) recordCount++;
					await rest();
				}
				const sampleSize = limit * 2;
				const recordRate = (recordCount + firstRecordCount) / sampleSize;
				const variance =
					Math.pow((recordCount - firstRecordCount + 1) / limit / 2, 2) + // variance between samples
					(recordRate * (1 - recordRate)) / sampleSize;
				const sd = Math.max(Math.sqrt(variance) * entryCount, 1);
				const estimatedRecordCount = Math.round(recordRate * entryCount);
				// TODO: This uses a normal/Wald interval, but a binomial confidence interval is probably better calculated using
				// Wilson score interval or Agresti-Coull interval (I think the latter is a little easier to calculate/implement).
				const lowerCiLimit = Math.max(estimatedRecordCount - 1.96 * sd, recordCount + firstRecordCount);
				const upperCiLimit = Math.min(estimatedRecordCount + 1.96 * sd, entryCount);
				let significantUnit = Math.pow(10, Math.round(Math.log10(sd)));
				if (significantUnit > estimatedRecordCount) significantUnit = significantUnit / 10;
				recordCount = Math.round(estimatedRecordCount / significantUnit) * significantUnit;
				return {
					recordCount,
					estimatedRange: [Math.round(lowerCiLimit), Math.round(upperCiLimit)],
				};
			}
			return {
				recordCount,
			};
		}
		/**
		 * When attributes have been changed, we update the accessors that are assigned to this table
		 */
		static updatedAttributes() {
			propertyResolvers = this.propertyResolvers = {
				$id: (object, context, entry) => ({ value: entry.key }),
				$updatedtime: (object, context, entry) => entry.version,
				$updatedTime: (object, context, entry) => entry.version,
				$expiresAt: (object, context, entry) => entry.expiresAt,
				$record: (object, context, entry) => (entry ? { value: object } : object),
			};
			for (const attribute of this.attributes) {
				if (attribute.isPrimaryKey) primaryKeyAttribute = attribute;
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
					hasRelationships = true;
					if (relationship.to) {
						if (attribute.elements?.definition) {
							propertyResolvers[attribute.name] = attribute.resolve = (object, context, directEntry?) => {
								// TODO: Get raw record/entry?
								const id = object[relationship.from ? relationship.from : primaryKey];
								const relatedTable = attribute.elements.definition.tableClass;
								if (directEntry) {
									return searchByIndex(
										{ attribute: relationship.to, value: id },
										txnForContext(context).getReadTxn(),
										false,
										relatedTable,
										false
									).asArray;
								}
								return relatedTable.search([{ attribute: relationship.to, value: id }], context).asArray;
							};
							attribute.set = () => {
								throw new Error('Setting a one-to-many relationship property is not supported');
							};
							attribute.resolve.definition = attribute.elements.definition;
							if (relationship.from) attribute.resolve.from = relationship.from;
						} else
							console.error(
								`The one-to-many/many-to-many relationship property "${attribute.name}" in table "${tableName}" must have an array type referencing a table as the elements`
							);
					} else if (relationship.from) {
						const definition = attribute.definition || attribute.elements?.definition;
						if (definition) {
							propertyResolvers[attribute.name] = attribute.resolve = (object, context, directEntry?) => {
								const ids = object[relationship.from];
								if (ids === undefined) return undefined;
								if (attribute.elements) {
									let hasPromises;
									const results = ids?.map((id) => {
										const value = directEntry
											? definition.tableClass.primaryStore.getEntry(id, {
													transaction: txnForContext(context).getReadTxn(),
												})
											: definition.tableClass.get(id, context);
										if (value?.then) hasPromises = true;
										return value;
									});
									return relationship.filterMissing
										? hasPromises
											? Promise.all(results).then((results) => results.filter(exists))
											: results.filter(exists)
										: hasPromises
											? Promise.all(results)
											: results;
								}
								return directEntry
									? definition.tableClass.primaryStore.getEntry(ids, {
											transaction: txnForContext(context).getReadTxn(),
										})
									: definition.tableClass.get(ids, context);
							};
							attribute.set = (object, related) => {
								if (Array.isArray(related)) {
									const targetIds = related.map(
										(related) => related.getId?.() || related[definition.tableClass.primaryKey]
									);
									object[relationship.from] = targetIds;
								} else {
									const targetId = related.getId?.() || related[definition.tableClass.primaryKey];
									object[relationship.from] = targetId;
								}
							};
							attribute.resolve.definition = attribute.definition || attribute.elements?.definition;
							attribute.resolve.from = relationship.from;
						} else {
							console.error(
								`The relationship property "${attribute.name}" in table "${tableName}" must be a type that references a table`
							);
						}
					} else {
						console.error(
							`The relationship directive on "${attribute.name}" in table "${tableName}" must use either "from" or "to" arguments`
						);
					}
				} else if (computed) {
					if (typeof computed.from === 'function') {
						this.setComputedAttribute(attribute.name, computed.from);
					}
					propertyResolvers[attribute.name] = attribute.resolve = (object, context, entry) => {
						const value = typeof computed.from === 'string' ? object[computed.from] : object;
						const userResolver = this.userResolvers[attribute.name];
						if (userResolver) return userResolver(value, context, entry);
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
			assignTrackedAccessors(Updatable, this, true);
			for (const attribute of attributes) {
				const name = attribute.name;
				if (attribute.resolve) {
					Object.defineProperty(primaryStore.encoder.structPrototype, name, {
						get() {
							return attribute.resolve(this, contextStorage.getStore()); // it is only possible to get the context from ALS, we don't have a direct reference to the current context
						},
						set(related) {
							return attribute.set(this, related);
						},
						configurable: true,
					});
				}
			}
		}
		static setComputedAttribute(attribute_name, resolver) {
			const attribute = findAttribute(attributes, attribute_name);
			if (!attribute) {
				console.error(`The attribute "${attribute_name}" does not exist in the table "${tableName}"`);
				return;
			}
			if (!attribute.computed) {
				console.error(`The attribute "${attribute_name}" is not defined as computed in the table "${tableName}"`);
				return;
			}
			this.userResolvers[attribute_name] = resolver;
		}
		static async deleteHistory(endTime = 0, cleanupDeletedRecords = false) {
			let completion: Promise<void>;
			for (const { key, value: auditEntry } of auditStore.getRange({
				start: 0,
				end: endTime,
			})) {
				await rest(); // yield to other async operations
				if (readAuditEntry(auditEntry).tableId !== tableId) continue;
				completion = removeAuditEntry(auditStore, key, auditEntry);
			}
			if (cleanupDeletedRecords) {
				// this is separate procedure we can do if the records are not being cleaned up by the audit log. This shouldn't
				// ever happen, but if there are cleanup failures for some reason, we can run this to clean up the records
				for (const entry of primaryStore.getRange({ start: 0, versions: true })) {
					const { key, value, localTime } = entry;
					await rest(); // yield to other async operations
					if (value === null && localTime < endTime) {
						completion = removeEntry(primaryStore, entry);
					}
				}
			}
			await completion;
		}
		static async *getHistory(startTime = 0, endTime = Infinity) {
			for (const { key, value: auditEntry } of auditStore.getRange({
				start: startTime || 1, // if startTime is 0, we actually want to shift to 1 because 0 is encoded as all zeros with audit store's special encoder, and will include symbols
				end: endTime,
			})) {
				await rest(); // yield to other async operations
				const auditRecord = readAuditEntry(auditEntry);
				if (auditRecord.tableId !== tableId) continue;
				yield {
					id: auditRecord.recordId,
					localTime: key,
					version: auditRecord.version,
					type: auditRecord.type,
					value: auditRecord.getValue(primaryStore, true, key),
					user: auditRecord.user,
					operation: auditRecord.originatingOperation,
				};
			}
		}
		static async getHistoryOfRecord(id) {
			const history = [];
			if (id == undefined) throw new Error('An id is required');
			const entry = primaryStore.getEntry(id);
			if (!entry) return history;
			let nextLocalTime = entry.localTime;
			if (!nextLocalTime) throw new Error('The entry does not have a local audit time');
			const count = 0;
			do {
				await rest(); // yield to other async operations
				//TODO: Would like to do this asynchronously, but we will need to run catch after this to ensure we didn't miss anything
				//await auditStore.prefetch([key]); // do it asynchronously for better fairness/concurrency and avoid page faults
				const auditEntry = auditStore.get(nextLocalTime);
				if (auditEntry) {
					const auditRecord = readAuditEntry(auditEntry);
					history.push({
						id: auditRecord.recordId,
						localTime: nextLocalTime,
						version: auditRecord.version,
						type: auditRecord.type,
						value: auditRecord.getValue(primaryStore, true, nextLocalTime),
						user: auditRecord.user,
					});
					nextLocalTime = auditRecord.previousLocalTime;
				} else break;
			} while (count < 1000 && nextLocalTime);
			return history.reverse();
		}
		static cleanup() {
			deleteCallbackHandle?.remove();
		}
	}
	TableResource.updatedAttributes(); // on creation, update accessors as well
	const prototype = TableResource.prototype;
	if (expirationMs) TableResource.setTTLExpiration(expirationMs / 1000);
	if (expiresAtProperty) runRecordExpirationEviction();
	return TableResource;
	function updateIndices(id, existingRecord, record?) {
		let hasChanges;
		// iterate the entries from the record
		// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it can be
		// inside a write transaction
		// TODO: Make an array version of indices that is faster
		for (const key in indices) {
			const index = indices[key];
			const isIndexing = index.isIndexing;
			const resolver = propertyResolvers[key];
			const value = record && (resolver ? resolver(record) : record[key]);
			const existingValue = existingRecord && (resolver ? resolver(existingRecord) : existingRecord[key]);
			if (value === existingValue && !isIndexing) {
				continue;
			}
			hasChanges = true;
			const indexNulls = index.indexNulls;
			// determine what index values need to be removed and added
			let valuesToAdd = getIndexedValues(value, indexNulls);
			let valuesToRemove = getIndexedValues(existingValue, indexNulls);
			if (valuesToRemove?.length > 0) {
				// put this in a conditional so we can do a faster version for new records
				// determine the changes/diff from new values and old values
				const setToRemove = new Set(valuesToRemove);
				valuesToAdd = valuesToAdd
					? valuesToAdd.filter((value) => {
							if (setToRemove.has(value)) {
								// if the value is retained, we don't need to remove or add it, so remove it from the set
								setToRemove.delete(value);
							} else {
								// keep in the list of values to add to index
								return true;
							}
						})
					: [];
				valuesToRemove = Array.from(setToRemove);
				if ((valuesToRemove.length > 0 || valuesToAdd.length > 0) && LMDB_PREFETCH_WRITES) {
					// prefetch any values that have been removed or added
					const valuesToPrefetch = valuesToRemove.concat(valuesToAdd).map((v) => ({ key: v, value: id }));
					index.prefetch(valuesToPrefetch, noop);
				}
				//if the update cleared out the attribute value we need to delete it from the index
				for (let i = 0, l = valuesToRemove.length; i < l; i++) {
					index.remove(valuesToRemove[i], id);
				}
			} else if (valuesToAdd?.length > 0 && LMDB_PREFETCH_WRITES) {
				// no old values, just new
				index.prefetch(
					valuesToAdd.map((v) => ({ key: v, value: id })),
					noop
				);
			}
			if (valuesToAdd) {
				for (let i = 0, l = valuesToAdd.length; i < l; i++) {
					index.put(valuesToAdd[i], id);
				}
			}
		}
		return hasChanges;
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
	function requestTargetToId(target: RequestTargetOrId): Id {
		return typeof target === 'object' && target ? target.id : (target as Id);
	}
	function isSearchTarget(target: RequestTarget) {
		return typeof target === 'object' && target && target.isCollection;
	}
	function isRequestTarget(target: unknown): target is RequestTarget {}
	function loadLocalRecord(id, context, options, sync, withEntry) {
		if (TableResource.getResidencyById && options.ensureLoaded && context?.replicateFrom !== false) {
			// this is a special case for when the residency can be determined from the id alone (hash-based sharding),
			// allow for a fast path to load the record from the correct node
			const residency = residencyFromFunction(TableResource.getResidencyById(id));
			if (residency) {
				if (!residency.includes(server.hostname) && sourceLoad) {
					// this record is not on this node, so we shouldn't load it here
					return sourceLoad({ key: id, residency }).then(withEntry);
				}
			}
		}
		// TODO: determine if we use lazy access properties
		const whenPrefetched = () => {
			if (context?.transaction?.stale) context.transaction.stale = false;
			// if the transaction was closed, which can happen if we are iterating
			// through query results and the iterator ends (abruptly)
			if (options.transaction?.isDone) return withEntry(null, id);
			const entry = primaryStore.getEntry(id, options);
			if (
				entry?.residencyId &&
				entry.metadataFlags & INVALIDATED &&
				sourceLoad &&
				options.ensureLoaded &&
				context?.replicateFrom !== false
			) {
				// load from other node
				return sourceLoad(entry).then(
					(entry) => withEntry(entry, id),
					(error) => {
						logger.error?.('Error loading remote record', id, entry, options, error);
						return withEntry(null, id);
					}
				);
			}
			if (entry && context) {
				if (entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
				if (entry?.localTime && !context.lastRefreshed) context.lastRefreshed = entry.localTime;
			}
			return withEntry(entry, id);
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
		if (untilNextPrefetch > 0) {
			untilNextPrefetch--;
			return whenPrefetched();
		}
		// Now, we are going to prefetch before loading, so need a promise:
		return new Promise((resolve, reject) => {
			if (untilNextPrefetch === 0) {
				// If we were in non-prefetch mode and used up our non-prefetch gets, we immediately trigger
				// a prefetch for the current id
				untilNextPrefetch--;
				primaryStore.prefetch([id], () => {
					prefetch();
					load();
				});
			} else {
				// If there is a prefetch in flight, we accumulate ids so we can attempt to batch prefetch
				// requests into a single or just a few async operations, reducing the cost of async queuing.
				prefetchIds.push(id);
				prefetchCallbacks.push(load);
				if (prefetchIds.length > MAX_PREFETCH_BUNDLE) {
					untilNextPrefetch--;
					prefetch();
				}
			}
			function prefetch() {
				if (prefetchIds.length > 0) {
					const callbacks = prefetchCallbacks;
					primaryStore.prefetch(prefetchIds, () => {
						if (untilNextPrefetch === -1) {
							prefetch();
						} else {
							// if there is another prefetch callback pending, we don't need to trigger another prefetch
							untilNextPrefetch++;
						}
						for (const callback of callbacks) callback();
					});
					prefetchIds = [];
					prefetchCallbacks = [];
					// Here is the where the feedback mechanism informs future execution. If we were able
					// to enqueue multiple prefetch requests, this is an indication that we have concurrency
					// and/or page fault/slow data retrieval, and the prefetches are valuable to us, so
					// we stay in prefetch mode.
					// We also reduce the number of non-prefetches we allow in next non-prefetch sequence
					if (nonPrefetchSequence > 2) nonPrefetchSequence--;
				} else {
					// If we have not enqueued any prefetch requests, this is a hint that prefetching may
					// not have been that advantageous, so we let it go back to the non-prefetch mode,
					// for the next few requests. We also increment the number of non-prefetches that
					// we allow so there is a "memory" of how well prefetch vs non-prefetch is going.
					untilNextPrefetch = nonPrefetchSequence;
					if (nonPrefetchSequence < MAX_PREFETCH_SEQUENCE) nonPrefetchSequence++;
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
		const dbPermission = permission[databaseName];
		let table: any;
		const tables = dbPermission?.tables;
		if (tables) {
			return tables[tableName];
		} else if (databaseName === 'data' && (table = permission[tableName]) && !table.tables) {
			return table;
		}
	}

	function ensureLoadedFromSource(id, entry, context, resource?) {
		if (hasSourceGet) {
			let needsSourceData = false;
			if (context.noCache) needsSourceData = true;
			else {
				if (entry) {
					if (
						!entry.value ||
						entry.metadataFlags & (INVALIDATED | EVICTED) || // invalidated or evicted should go to load from source
						(entry.expiresAt != undefined && entry.expiresAt < Date.now())
					)
						needsSourceData = true;
					// else needsSourceData is left falsy
					// TODO: Allow getEntryByVariation to find a sub-variation of this record and determine if
					// it still needs to be loaded from source
				} else needsSourceData = true;
				recordActionBinary(!needsSourceData, 'cache-hit', tableName);
			}
			if (needsSourceData) {
				const loadingFromSource = getFromSource(id, entry, context).then((entry) => {
					if (entry?.value && entry?.value.getRecord?.())
						logger.error?.('Can not assign a record that is already a resource');
					if (context) {
						if (entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
						context.lastRefreshed = Date.now(); // localTime is probably not available yet
					}
					return entry;
				});
				// if the resource defines a method for indicating if stale-while-revalidate is allowed for a record
				if (context?.onlyIfCached || (entry?.value && resource?.allowStaleWhileRevalidate?.(entry, id))) {
					// since we aren't waiting for it any errors won't propagate so we should at least log them
					loadingFromSource.catch((error) => logger.warn?.(error));
					if (context?.onlyIfCached && !resource.doesExist()) throw new ServerError('Entry is not cached', 504);
					return; // go ahead and return and let the current stale value be used while we re-validate
				} else return loadingFromSource; // return the promise for the resolved value
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
				transaction.lmdbDb = primaryStore;
				return transaction;
			}
			do {
				// See if this is a transaction for our database and if so, use it
				if (transaction.lmdbDb?.path === primaryStore.path) return transaction;
				// try the next one:
				const nextTxn = transaction.next;
				if (!nextTxn) {
					// no next one, then add our database
					transaction = transaction.next = new DatabaseTransaction();
					transaction.lmdbDb = primaryStore;
					return transaction;
				}
				transaction = nextTxn;
			} while (true);
		} else {
			return new ImmediateTransaction();
		}
	}
	function getAttributeValue(entry, attribute_name, context) {
		if (!entry) {
			return;
		}
		const record = entry.value || primaryStore.getEntry(entry.key)?.value;
		if (typeof attribute_name === 'object') {
			// attribute_name is an array of attributes, pointing to nested attribute
			let resolvers = propertyResolvers;
			let value = record;
			for (let i = 0, l = attribute_name.length; i < l; i++) {
				const attribute = attribute_name[i];
				const resolver = resolvers?.[attribute];
				value = resolver && value ? resolver(value, context, true)?.value : value?.[attribute];
				resolvers = resolver?.definition?.tableClass?.propertyResolvers;
			}
			return value;
		}
		const resolver = propertyResolvers[attribute_name];
		return resolver ? resolver(record, context) : record[attribute_name];
	}
	function transformToEntries(ids, select, context, readTxn, filters?) {
		// TODO: Test and ensure that we break out of these loops when a connection is lost
		const filtersLength = filters?.length;
		const loadOptions = {
			transaction: readTxn,
			lazy: filtersLength > 0 || typeof select === 'string' || select?.length < 4,
			alwaysPrefetch: true,
		};
		let idFiltersApplied;
		// for filter operations, we intentionally use async and yield the event turn so that scanning queries
		// do not hog resources and give more processing opportunity for more efficient index-driven queries.
		// this also gives an opportunity to prefetch and ensure any page faults happen in a different thread
		function processEntry(entry: Entry, id?) {
			const record = entry?.value;
			if (!record) return SKIP;
			// apply the record-level filters
			for (let i = 0; i < filtersLength; i++) {
				if (idFiltersApplied?.includes(i)) continue; // already applied
				if (!filters[i](record, entry)) return SKIP; // didn't match filters
			}
			if (id !== undefined) entry.key = id;
			return entry;
		}
		if (filtersLength > 0 || !ids.hasEntries) {
			let results = ids.map((idOrEntry) => {
				idFiltersApplied = null;
				if (typeof idOrEntry === 'object' && idOrEntry?.key !== undefined)
					return filtersLength > 0 ? processEntry(idOrEntry) : idOrEntry; // already an entry
				if (idOrEntry == undefined) {
					return SKIP;
				}
				// it is an id, so we can try to use id any filters that are available (note that these can come into existence later, during the query)
				for (let i = 0; i < filtersLength; i++) {
					const filter = filters[i];
					const idFilter = filter.idFilter;
					if (idFilter) {
						if (!idFilter(idOrEntry)) return SKIP; // didn't match filters
						if (!idFiltersApplied) idFiltersApplied = [];
						idFiltersApplied.push(i);
					}
				}
				return loadLocalRecord(idOrEntry, context, loadOptions, false, processEntry);
			});
			if (Array.isArray(ids)) results = results.filter((entry) => entry !== SKIP);
			results.hasEntries = true;
			return results;
		}
		return ids;
	}

	function precedesExistingVersion(
		txnTime: number,
		existingEntry: Entry,
		nodeId: number = server.replication?.getThisNodeId(auditStore)
	): number {
		if (txnTime <= existingEntry?.version) {
			if (existingEntry?.version === txnTime && nodeId !== undefined) {
				// if we have a timestamp tie, we break the tie by comparing the node name of the
				// existing entry to the node name of the update
				const nodeNameToId = server.replication?.exportIdMapping(auditStore);
				const localTime = existingEntry.localTime;
				const auditEntry = localTime && auditStore.get(localTime);
				if (auditEntry) {
					// existing node id comes from the audit log
					let updatedNodeName, existingNodeName;
					const auditRecord = readAuditEntry(auditEntry);
					for (const node_name in nodeNameToId) {
						if (nodeNameToId[node_name] === nodeId) updatedNodeName = node_name;
						if (nodeNameToId[node_name] === auditRecord.nodeId) existingNodeName = node_name;
					}
					if (updatedNodeName > existingNodeName)
						// if the updated node name is greater (alphabetically), it wins (it doesn't precede the existing version)
						return 1;
					if (updatedNodeName === existingNodeName) return 0; // a tie
				}
			}
			// transaction time is older than existing version, so we treat that as an update that loses to the existing record version
			return -1;
		}
		return 1;
	}

	/**
	 * This is used to record that a retrieve a record from source
	 */
	async function getFromSource(id: Id, existingEntry: Entry, context: Context): Promise<Entry> {
		const metadataFlags = existingEntry?.metadataFlags;

		const existingVersion = existingEntry?.version;
		let whenResolved, timer;
		// We start by locking the record so that there is only one resolution happening at once;
		// if there is already a resolution in process, we want to use the results of that resolution
		// attemptLock() will return true if we got the lock, and the callback won't be called.
		// If another thread has the lock it returns false and then the callback is called once
		// the other thread releases the lock.
		if (
			!primaryStore.attemptLock(id, existingVersion, () => {
				// This is called when another thread releases the lock on resolution. Hopefully
				// it should be resolved now and we can use the value it saved.
				clearTimeout(timer);
				const entry = primaryStore.getEntry(id);
				if (!entry || !entry.value || entry.metadataFlags & (INVALIDATED | EVICTED))
					// try again
					whenResolved(getFromSource(id, primaryStore.getEntry(id), context));
				else whenResolved(entry);
			})
		) {
			return new Promise((resolve) => {
				whenResolved = resolve;
				timer = setTimeout(() => {
					primaryStore.unlock(id, existingVersion);
				}, LOCK_TIMEOUT);
			});
		}

		const existingRecord = existingEntry?.value;
		// it is important to remember that this is _NOT_ part of the current transaction; nothing is changing
		// with the canonical data, we are simply fulfilling our local copy of the canonical data, but still don't
		// want a timestamp later than the current transaction
		// we create a new context for the source, we want to determine the timestamp and don't want to
		// attribute this to the current user
		const sourceContext = {
			requestContext: context,
			// provide access to previous data
			replacingRecord: existingRecord,
			replacingEntry: existingEntry,
			replacingVersion: existingVersion,
			noCacheStore: false,
			source: null,
			// use the same resource cache as a parent context so that if modifications are made to resources,
			// they are visible in the parent requesting context
			resourceCache: context?.resourceCache,
			transaction: undefined,
			expiresAt: undefined,
			lastModified: undefined,
		};
		const responseHeaders = context?.responseHeaders;
		return new Promise((resolve, reject) => {
			// we don't want to wait for the transaction because we want to return as fast as possible
			// and let the transaction commit in the background
			let resolved;
			when(
				transaction(sourceContext, async (txn) => {
					const start = performance.now();
					let updatedRecord;
					let hasChanges, invalidated;
					try {
						// find the first data source that will fulfill our request for data
						for (const source of TableResource.sources) {
							if (source.get && (!source.get.reliesOnPrototype || source.prototype.get)) {
								if (source.available?.(existingEntry) === false) continue;
								sourceContext.source = source;
								updatedRecord = await source.get(id, sourceContext);
								if (updatedRecord) break;
							}
						}
						invalidated = metadataFlags & INVALIDATED;
						let version = sourceContext.lastModified || (invalidated && existingVersion);
						hasChanges = invalidated || version > existingVersion || !existingRecord;
						if (!version) version = getNextMonotonicTime();
						const resolveDuration = performance.now() - start;
						recordAction(resolveDuration, 'cache-resolution', tableName, null, 'success');
						if (responseHeaders)
							appendHeader(responseHeaders, 'Server-Timing', `cache-resolve;dur=${resolveDuration.toFixed(2)}`, true);
						txn.timestamp = version;
						if (expirationMs && sourceContext.expiresAt == undefined)
							sourceContext.expiresAt = Date.now() + expirationMs;
						if (updatedRecord) {
							if (typeof updatedRecord !== 'object') throw new Error('Only objects can be cached and stored in tables');
							if (updatedRecord.status > 0 && updatedRecord.headers) {
								// if the source has a status code and headers, treat it as a response
								if (updatedRecord.status >= 300) {
									if (updatedRecord.status === 304) {
										// revalidation of our current cached record
										updatedRecord = existingRecord;
										version = existingVersion;
									} else {
										// if the source has an error status, we need to throw an error
										throw new ServerError(updatedRecord.body || 'Error from source', updatedRecord.status);
									} // there are definitely more status codes to handle
								} else {
									updatedRecord = updatedRecord.body;
								}
							}
							if (typeof updatedRecord.toJSON === 'function') updatedRecord = updatedRecord.toJSON();
							if (primaryKey && updatedRecord[primaryKey] !== id) updatedRecord[primaryKey] = id;
						}
						resolved = true;
						resolve({
							key: id,
							version,
							value: updatedRecord,
						});
					} catch (error) {
						error.message += ` while resolving record ${id} for ${tableName}`;
						if (
							existingRecord &&
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
								version: existingVersion,
								value: existingRecord,
							});
							logger.trace?.(error.message, '(returned stale record)');
						} else reject(error);
						const resolveDuration = performance.now() - start;
						recordAction(resolveDuration, 'cache-resolution', tableName, null, 'fail');
						if (responseHeaders)
							appendHeader(responseHeaders, 'Server-Timing', `cache-resolve;dur=${resolveDuration.toFixed(2)}`, true);
						sourceContext.transaction.abort();
						return;
					}
					if (context?.noCacheStore || sourceContext.noCacheStore) {
						// abort before we write any change
						sourceContext.transaction.abort();
						return;
					}
					const dbTxn = txnForContext(sourceContext);
					dbTxn.addWrite({
						key: id,
						store: primaryStore,
						entry: existingEntry,
						nodeName: 'source',
						commit: (txnTime, existingEntry) => {
							if (existingEntry?.version !== existingVersion) {
								// don't do anything if the version has changed
								return;
							}
							const hasIndexChanges = updateIndices(id, existingRecord, updatedRecord);
							if (updatedRecord) {
								applyToSourcesIntermediate.put?.(sourceContext, id, updatedRecord);
								if (existingEntry) {
									context.previousResidency = TableResource.getResidencyRecord(existingEntry.residencyId);
								}
								let auditRecord: any;
								let omitLocalRecord = false;
								let residencyId: number;
								const residency = residencyFromFunction(TableResource.getResidency(updatedRecord, context));
								if (residency) {
									if (!residency.includes(server.hostname)) {
										// if we aren't in the residency list, specify that our local record should be omitted or be partial
										auditRecord = updatedRecord;
										omitLocalRecord = true;
										if (TableResource.getResidencyById) {
											// complete omission of the record that doesn't belong here
											updatedRecord = undefined;
										} else {
											// store the partial record
											updatedRecord = null;
											for (const name in indices) {
												if (!updatedRecord) {
													updatedRecord = {};
												}
												// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
												updatedRecord[name] = auditRecord[name];
											}
										}
									}
									residencyId = getResidencyId(residency);
								}
								logger.trace?.(
									`Writing resolved record from source with id: ${id}, timestamp: ${new Date(txnTime).toISOString()}`
								);
								// TODO: We are doing a double check for ifVersion that should probably be cleaned out
								updateRecord(
									id,
									updatedRecord,
									existingEntry,
									txnTime,
									omitLocalRecord ? INVALIDATED : 0,
									(audit && (hasChanges || omitLocalRecord)) || null,
									{ user: sourceContext?.user, expiresAt: sourceContext.expiresAt, residencyId },
									'put',
									Boolean(invalidated),
									auditRecord
								);
							} else if (existingEntry) {
								applyToSourcesIntermediate.delete?.(sourceContext, id);
								logger.trace?.(
									`Deleting resolved record from source with id: ${id}, timestamp: ${new Date(txnTime).toISOString()}`
								);
								if (audit || trackDeletes) {
									updateRecord(
										id,
										null,
										existingEntry,
										txnTime,
										0,
										(audit && hasChanges) || null,
										{ user: sourceContext?.user },
										'delete',
										Boolean(invalidated)
									);
								} else {
									removeEntry(primaryStore, existingEntry, existingVersion);
								}
							}
						},
					});
				}),
				() => {
					primaryStore.unlock(id, existingVersion);
				},
				(error) => {
					primaryStore.unlock(id, existingVersion);
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
	function scheduleCleanup(priority?: number): Promise<void> | void {
		let runImmediately = false;
		if (priority) {
			// run immediately if there is a big increase in priority
			if (priority - cleanupPriority > 1) runImmediately = true;
			cleanupPriority = priority;
		}
		// Periodically evict expired records and deleted records searching for records who expiresAt timestamp is before now
		if (cleanupInterval === lastCleanupInterval && !runImmediately) return;
		lastCleanupInterval = cleanupInterval;
		if (getWorkerIndex() === getWorkerCount() - 1) {
			// run on the last thread so we aren't overloading lower-numbered threads
			if (cleanupTimer) clearTimeout(cleanupTimer);
			if (!cleanupInterval) return;
			return new Promise((resolve) => {
				const startOfYear = new Date();
				startOfYear.setMonth(0);
				startOfYear.setDate(1);
				startOfYear.setHours(0);
				startOfYear.setMinutes(0);
				startOfYear.setSeconds(0);
				const nextInterval = cleanupInterval / (1 + cleanupPriority);
				// find the next scheduled run based on regular cycles from the beginning of the year (if we restart, this enables a good continuation of scheduling)
				const nextScheduled = runImmediately
					? Date.now()
					: Math.ceil((Date.now() - startOfYear.getTime()) / nextInterval) * nextInterval + startOfYear.getTime();
				const startNextTimer = (nextScheduled) => {
					logger.trace?.(`Scheduled next cleanup scan at ${new Date(nextScheduled)}`);
					// noinspection JSVoidFunctionReturnValueUsed
					cleanupTimer = setTimeout(
						() =>
							(lastEvictionCompletion = lastEvictionCompletion.then(async () => {
								// schedule the next run for when the next cleanup interval should occur (or now if it is in the past)
								startNextTimer(Math.max(nextScheduled + cleanupInterval, Date.now()));
								if (primaryStore.rootStore.status !== 'open') {
									clearTimeout(cleanupTimer);
									return;
								}
								const MAX_CLEANUP_CONCURRENCY = 50;
								const outstandingCleanupOperations = new Array(MAX_CLEANUP_CONCURRENCY);
								let cleanupIndex = 0;
								const evictThreshold =
									Math.pow(cleanupPriority, 8) *
									(envMngr.get(CONFIG_PARAMS.STORAGE_RECLAMATION_EVICTIONFACTOR) ?? 100000);
								const adjustedEviction = evictionMs / Math.pow(Math.max(cleanupPriority, 1), 4);
								logger.info?.(
									`Starting cleanup scan for ${tableName}, evict threshold ${evictThreshold}, adjusted eviction ${adjustedEviction}ms`
								);
								function shouldEvict(expiresAt: number, version: number, metadataFlags: number, record: any) {
									const evictWhen = expiresAt + adjustedEviction - Date.now();
									if (evictWhen < 0) return true;
									else if (cleanupPriority) {
										let size = primaryStore.lastSize;
										if (metadataFlags & HAS_BLOBS) {
											findBlobsInObject(record, (blob) => {
												if (blob.size) size += blob.size;
											});
										}
										logger.trace?.(
											`shouldEvict adjusted ${evictWhen} ${size}, ${(evictWhen * (expiresAt - version)) / size} < ${evictThreshold}`
										);
										// heuristic to determine if we should perform early eviction based on priority
										return (evictWhen * (expiresAt - version)) / size < evictThreshold;
									}
									return false;
								}

								try {
									let count = 0;
									// iterate through all entries to find expired records and deleted records
									for (const entry of primaryStore.getRange({
										start: false,
										snapshot: false, // we don't want to keep read transaction snapshots open
										versions: true,
										lazy: true, // only want to access metadata most of the time
									})) {
										const { key, value: record, version, expiresAt, metadataFlags } = entry;
										// if there is no auditing and we are tracking deletion, need to do cleanup of
										// these deletion entries (audit has its own scheduled job for this)
										let resolution: Promise<void>;
										if (record === null && !audit && version + DELETED_RECORD_EXPIRATION < Date.now()) {
											// make sure it is still deleted when we do the removal
											resolution = removeEntry(primaryStore, entry, version);
										} else if (expiresAt != undefined && shouldEvict(expiresAt, version, metadataFlags, record)) {
											// evict!
											resolution = TableResource.evict(key, record, version);
											count++;
										}
										if (resolution) {
											await outstandingCleanupOperations[cleanupIndex];
											outstandingCleanupOperations[cleanupIndex] = resolution.catch((error) => {
												logger.error?.('Cleanup error', error);
											});
											if (++cleanupIndex >= MAX_CLEANUP_CONCURRENCY) cleanupIndex = 0;
										}
										await rest();
									}
									logger.info?.(`Finished cleanup scan for ${tableName}, evicted ${count} entries`);
								} catch (error) {
									logger.warn?.(`Error in cleanup scan for ${tableName}:`, error);
								}
								resolve(undefined);
								cleanupPriority = 0; // reset the priority
							})),
						Math.min(nextScheduled - Date.now(), 0x7fffffff) // make sure it can fit in 32-bit signed number
					).unref(); // don't let this prevent closing the thread
				};
				startNextTimer(nextScheduled);
			});
		}
	}
	function addDeleteRemoval() {
		deleteCallbackHandle = auditStore?.addDeleteRemovalCallback(tableId, primaryStore, (id: Id, version: number) => {
			primaryStore.remove(id, version);
		});
	}
	function runRecordExpirationEviction() {
		// Periodically evict expired records, searching for records who expiresAt timestamp is before now
		if (getWorkerIndex() === 0) {
			// we want to run the pruning of expired records on only one thread so we don't have conflicts in evicting
			setInterval(async () => {
				// go through each database and table and then search for expired entries
				// find any entries that are set to expire before now
				if (runningRecordExpiration) return;
				runningRecordExpiration = true;
				try {
					const expiresAtName = expiresAtProperty.name;
					const index = indices[expiresAtName];
					if (!index) throw new Error(`expiresAt attribute ${expiresAtProperty} must be indexed`);
					for (const key of index.getRange({
						start: true,
						values: false,
						end: Date.now(),
						snapshot: false,
					})) {
						for (const id of index.getValues(key)) {
							const recordEntry = primaryStore.getEntry(id);
							if (!recordEntry?.value) {
								// cleanup the index if the record is gone
								primaryStore.ifVersion(id, recordEntry?.version, () => index.remove(key, id));
							} else if (recordEntry.value[expiresAtName] < Date.now()) {
								// make sure the record hasn't changed and won't change while removing
								TableResource.evict(id, recordEntry.value, recordEntry.version);
							}
						}
						await rest();
					}
				} catch (error) {
					logger.error?.('Error in evicting old records', error);
				} finally {
					runningRecordExpiration = false;
				}
			}, RECORD_PRUNING_INTERVAL).unref();
		}
	}
	function residencyFromFunction(shardOrResidencyList: ResidencyDefinition): string[] | void {
		if (shardOrResidencyList == undefined) return;
		if (Array.isArray(shardOrResidencyList)) return shardOrResidencyList;
		if (typeof shardOrResidencyList === 'number') {
			if (shardOrResidencyList >= 65536) throw new Error(`Shard id ${shardOrResidencyList} must be below 65536`);
			const residencyList = server.shards?.get?.(shardOrResidencyList);
			if (residencyList) {
				logger.trace?.(`Shard ${shardOrResidencyList} mapped to ${residencyList.map((node) => node.name).join(', ')}`);
				return residencyList.map((node) => node.name);
			}
			throw new Error(`Shard ${shardOrResidencyList} is not defined`);
		}
		throw new Error(
			`Shard or residency list ${shardOrResidencyList} is not a valid type, must be a shard number or residency list of node hostnames`
		);
	}
	function getResidencyId(ownerNodeNames) {
		if (ownerNodeNames) {
			const setKey = ownerNodeNames.join(',');
			let residencyId = dbisDb.get([Symbol.for('residency_by_set'), setKey]);
			if (residencyId) return residencyId;
			dbisDb.put(
				[Symbol.for('residency_by_set'), setKey],
				(residencyId = Math.floor(Math.random() * 0x7fff0000) + 0xffff)
			);
			dbisDb.put([Symbol.for('residency_by_id'), residencyId], ownerNodeNames);
			return residencyId;
		}
	}
}

function attributesAsObject(attribute_permissions, type) {
	const attrObject = attribute_permissions.attr_object || (attribute_permissions.attr_object = {});
	let attrsForType = attrObject[type];
	if (attrsForType) return attrsForType;
	attrsForType = attrObject[type] = Object.create(null);
	for (const permission of attribute_permissions) {
		attrsForType[permission.attribute_name] = permission[type];
	}
	return attrsForType;
}
function noop() {
	// prefetch callback
}
export function setServerUtilities(utilities) {
	serverUtilities = utilities;
}
const ENDS_WITH_TIMEZONE = /[+-][0-9]{2}:[0-9]{2}|[a-zA-Z]$/;
/**
 * Coerce a string to the type defined by the attribute
 * @param value
 * @param attribute
 * @returns
 */
export function coerceType(value: any, attribute: any): any {
	const type = attribute?.type;
	//if a type is String is it safe to execute a .toString() on the value and return? Does not work for Array/Object so we would need to detect if is either of those first
	if (value === null) {
		return value;
	} else if (value === '' && type && type !== 'String' && type !== 'Any') {
		return null;
	}
	try {
		switch (type) {
			case 'Int':
			case 'Long':
				// allow $ prefix as special syntax for more compact numeric representations and then use parseInt to force being an integer (might consider Math.floor, which is a little faster, but rounds in a different way with negative numbers).
				if (value[0] === '$') return rejectNaN(parseInt(value.slice(1), 36));
				if (value === 'null') return null;
				// strict check to make sure it is really an integer (there is also a sensible conversion from dates)
				if (!/^-?[0-9]+$/.test(value) && !(value instanceof Date)) throw new SyntaxError();
				return rejectNaN(+value); // numeric conversion is stricter than parseInt
			case 'Float':
				return value === 'null' ? null : rejectNaN(+value); // numeric conversion is stricter than parseFloat
			case 'BigInt':
				return value === 'null' ? null : BigInt(value);
			case 'Boolean':
				return value === 'true' ? true : value === 'false' ? false : value;
			case 'Date':
				if (isNaN(value)) {
					if (value === 'null') return null;
					//if the value is not an integer (to handle epoch values) and does not end in a timezone we suffiz with 'Z' tom make sure the Date is GMT timezone
					if (!ENDS_WITH_TIMEZONE.test(value)) {
						value += 'Z';
					}
					const date = new Date(value);
					rejectNaN(date.getTime());
					return date;
				}
				return new Date(+value); // epoch ms number
			case undefined:
			case 'Any':
				return autoCast(value);
			default:
				return value;
		}
	} catch (error) {
		error.message = `Invalid value for attribute ${attribute.name}: "${value}", expecting ${type}`;
		error.statusCode = 400;
		throw error;
	}
}
// This is a simple function to throw on NaNs that can come out of parseInt, parseFloat, etc.
function rejectNaN(value: number) {
	if (isNaN(value)) throw new SyntaxError(); // will set the message in the catch block with more context
	return value;
}
function isDescendantId(ancestorId, descendantId): boolean {
	if (ancestorId == null) return true; // ancestor of all ids
	if (!Array.isArray(descendantId)) return ancestorId === descendantId || descendantId.startsWith?.(ancestorId);
	if (Array.isArray(ancestorId)) {
		let al = ancestorId.length;
		if (ancestorId[al - 1] === null) al--;
		if (descendantId.length >= al) {
			for (let i = 0; i < al; i++) {
				if (descendantId[i] !== ancestorId[i]) return false;
			}
			return true;
		}
		return false;
	} else if (descendantId[0] === ancestorId) return true;
}

// wait for an event turn (via a promise)
const rest = () => new Promise(setImmediate);

// wait for a promise or plain object to resolve
function when(value, callback, reject?) {
	if (value?.then) return value.then(callback, reject);
	return callback(value);
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
export { clearStatus as clear, getStatus as get, setStatus as set };
