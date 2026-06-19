/**
 * This module provides the main table implementation of the Resource API, providing full access to Harper
 * tables through the interface defined by the Resource class. This module is responsible for handling these
 * table-level interactions, loading records, updating records, querying, and more.
 */

import { CONFIG_PARAMS, OPERATIONS_ENUM, SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME } from '../utility/hdbTerms.ts';
import { type Database } from 'lmdb';
import { Script } from 'node:vm';
import { getIndexedValues } from '../utility/lmdb/commonUtility.ts';
import { getThisNodeId, exportIdMapping } from './nodeIdMapping.ts';
import lodash from 'lodash';
import { ExtendedIterable, SKIP } from '@harperfast/extended-iterable';
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
import type { User } from '../security/user.ts';
import lmdbProcessRows from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbProcessRows.js';
import { Resource, transformForSelect } from './Resource.ts';
import { when, promiseNormalize } from '../utility/when.ts';
import { DatabaseTransaction, ImmediateTransaction, TRANSACTION_STATE } from './DatabaseTransaction.ts';
import * as envMngr from '../utility/environment/environmentManager.ts';
import { addSubscription } from './transactionBroadcast.ts';
import { handleHDBError, ClientError, ServerError, AccessViolation } from '../utility/errors/hdbError.ts';
import * as signalling from '../utility/signalling.ts';
import { SchemaEventMsg, UserEventMsg } from '../server/threads/itc.js';
import { databases, table } from './databases.ts';
import {
	searchByIndex,
	findAttribute,
	estimateCondition,
	flattenKey,
	COERCIBLE_OPERATORS,
	executeConditions,
	resolveComparator,
} from './search.ts';
import { logger } from '../utility/logging/logger.ts';
import { Addition, assignTrackedAccessors, updateAndFreeze, hasChanges, GenericTrackedObject } from './tracked.ts';
import { transaction, contextStorage } from './transaction.ts';
import { MAXIMUM_KEY, writeKey, compareKeys } from 'ordered-binary';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { HAS_BLOBS, auditRetention, removeAuditEntry } from './auditStore.ts';
import { buildEmbedBefore, createDefaultEmbedder, type EmbedAttribute, type Embedder } from './models/embedHook.ts';
import { autoCast, autoCastBooleanStrict } from '../utility/common_utils.ts';
import {
	recordUpdater,
	removeEntry,
	PENDING_LOCAL_TIME,
	type RecordObject,
	type Entry,
	entryMap,
} from './RecordEncoder.ts';
import { recordAction, recordActionBinary } from './analytics/write.ts';
import { rebuildUpdateBefore } from './crdt.ts';
import { appendHeader } from '../server/serverHelpers/Headers.ts';
import fs from 'node:fs';
import { Blob, deleteBlobsInObject, findBlobsInObject, startPreCommitBlobsForRecord } from './blob.ts';
import { onStorageReclamation } from '../server/storageReclamation.ts';
import { RequestTarget } from './RequestTarget.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { throttle } from '../server/throttle.ts';
import { RocksDatabase, Transaction as RocksTransaction } from '@harperfast/rocksdb-js';
import { LMDBTransaction, ImmediateTransaction as ImmediateLMDBTransaction } from './LMDBTransaction';
import { contentTypes } from '../server/serverHelpers/contentTypes';
import { type JsonSchemaFragment, projectAttributesToProperties } from './jsonSchemaTypes.ts';

const { sortBy } = lodash;
const { validateAttribute } = lmdbProcessRows;

export type Attribute = {
	name: string;
	type: 'ID' | 'Int' | 'Float' | 'Long' | 'String' | 'Boolean' | 'Date' | 'Bytes' | 'Any' | 'BigInt' | 'Blob' | string;
	description?: string;
	hidden?: boolean;
	assignCreatedTime?: boolean;
	assignUpdatedTime?: boolean;
	nullable?: boolean;
	expiresAt?: boolean;
	isPrimaryKey?: boolean;
	indexed?: any;
	relationship?: any;
	computed?: any;
	resolve?: any;
	computedFromExpression?: any;
	embed?: { source: string; model: string };
	version?: any;
	properties?: Array<Attribute>;
	elements?: Attribute;
	sealed?: boolean;

	definition?: any;
	set?: any;
	enumerable?: boolean;
	select?: any;
};

type MaybePromise<T> = T | Promise<T>;

const NULL_WITH_TIMESTAMP = new Uint8Array(9);
NULL_WITH_TIMESTAMP[8] = 0xc0; // null
const UNCACHEABLE_TIMESTAMP = Infinity; // we use this when dynamic content is accessed that we can't safely cache, and this prevents earlier timestamps from change the "last" modification
const RECORD_PRUNING_INTERVAL = 60000; // one minute
// RocksDB-only: number of eviction/tombstone removals coalesced into a single transaction commit.
// Each evict otherwise pays a full transaction commit, so batching amortizes that cost. LMDB already
// coalesces async writes per event turn (eventTurnBatching), so it keeps the per-record path.
const EVICTION_BATCH_SIZE = 100;
// Cap on eviction-batch commits in flight at once, so commit I/O overlaps scan/staging without
// letting an unbounded number of open transactions (and their snapshots) accumulate.
const MAX_INFLIGHT_EVICTION_BATCHES = 4;
const CACHEABLE_STATUS_CODES = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);
envMngr.initSync();
const LMDB_PREFETCH_WRITES = envMngr.get(CONFIG_PARAMS.STORAGE_PREFETCHWRITES);
const LOCK_TIMEOUT = 10000;
// Tolerate a redundant column family drop. Drops are broadcast to every worker
// thread and each holds its own handle to the same underlying family, so a
// concurrent worker may already have dropped it; the storage engine reports
// that as "Column family already dropped!". The family being gone is the
// intended outcome, so swallow that specific error and rethrow anything else.
function ignoreAlreadyDropped(error: any): void {
	if (error?.message?.includes('Column family already dropped')) return;
	throw error;
}
// A frozen record we may need to copy-on-mutate before stamping it (records are immutable — decoded
// records are frozen and 5.2 record caching relies on it). Only plain/record objects qualify: never
// a Buffer/typed-array (spreading would corrupt the binary into a {0:.., 1:..} object) or a primitive
// (which reports as frozen and would spread into character/index keys).
function isFrozenRecordObject(value: any): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!ArrayBuffer.isView(value) &&
		!(value instanceof ArrayBuffer) &&
		Object.isFrozen(value)
	);
}
export const INVALIDATED = 1;
export const EVICTED = 8; // note that 2 is reserved for timestamps
const TEST_WRITE_KEY_BUFFER = Buffer.allocUnsafeSlow(8192);
const MAX_KEY_BYTES = 1978;
const EVENT_HIGH_WATER_MARK = 100;
const REPLAY_YIELD_INTERVAL = 100; // yield to the event loop every N records during subscription replay
// Cap for the out-of-order write reconciliation audit-chain walk in commit(). A pathologically deep
// audit history (e.g. a replication full-copy of a large-history database) would otherwise walk and
// buffer the entire backward chain per record, synchronously, on every worker — pinning the JS heap
// until the worker OOMs (issue #1114). Beyond this depth we fall back to a bounded reconciliation.
const MAX_OUT_OF_ORDER_AUDIT_DEPTH = 1000;
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
	attributes: Attribute[];
	primaryKey: string;
	splitSegments?: boolean;
	replicate?: boolean;
	subscriptions: Map<any, Function[]>;
	expirationMS: number;
	indexingOperations?: Promise<void>;
	source?: new () => ResourceInterface;
	Transaction: ReturnType<typeof makeTable>;
	description?: string;
	properties?: Record<string, JsonSchemaFragment>;
	hidden?: boolean;
}
type ResidencyDefinition = number | string[] | void;

/**
 * This returns a Table class for the given table settings (determined from the metadata table)
 * Instances of the returned class are Resource instances, intended to provide a consistent view or transaction of the table
 * @param options
 */
// #section: setup-and-factory
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
		description,
		hidden,
	} = options;
	let { expirationMS: expirationMs, evictionMS: evictionMs, audit, trackDeletes } = options;
	evictionMs ??= 0;
	// Eviction without explicit expiration means expiration:0. Apply at construction so
	// describe_all sees it on every worker, not just ones that ran setTTLExpiration.
	if (evictionMs > 0 && expirationMs === undefined) expirationMs = 0;
	let { attributes, properties }: { attributes: Attribute[]; properties?: Record<string, JsonSchemaFragment> } =
		options;
	if (!attributes) attributes = [];
	if (!properties) properties = projectAttributesToProperties(attributes);
	const updateRecord = recordUpdater(primaryStore, tableId, auditStore);
	let sourceLoad: any; // if a source has a load function (replicator), record it here
	let hasSourceGet: any;
	let primaryKeyAttribute: Attribute | undefined;
	let lastEvictionCompletion: Promise<void> = Promise.resolve();
	let createdTimeProperty: Attribute | undefined,
		updatedTimeProperty: Attribute | undefined,
		expiresAtProperty: Attribute | undefined;
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
	let cleanupInterval = 86400000;
	let cleanupPriority = 0;
	let lastCleanupInterval: number;
	let cleanupTimer: NodeJS.Timeout;
	// true once a table-level expiration/eviction/scanInterval has armed the periodic cleanup scan at setup
	let expirationScanScheduled = false;
	// set on the first expiring write so the unscheduled-expiration warning is evaluated at most once per table
	let expirationWarningChecked = false;
	let propertyResolvers: any;
	let hasRelationships = false;
	let runningRecordExpiration: boolean;
	const isRocksDB = primaryStore instanceof RocksDatabase;
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
	const MAX_PREFETCH_SEQUENCE = 10;
	const MAX_PREFETCH_BUNDLE = 6;
	if (audit) addDeleteRemoval();
	onStorageReclamation(primaryStore.path, (priority: number) => {
		if (hasSourceGet) return scheduleCleanup(priority);
	});

	class Updatable extends GenericTrackedObject implements RecordObject {
		declare set: (property: string, value: any) => void;
		declare getProperty: (property: string) => any;
		getUpdatedTime(): number {
			return entryMap.get(this.getRecord())?.version;
		}
		getExpiresAt(): number {
			return entryMap.get(this.getRecord())?.expiresAt;
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
	class TableResource<Record extends object = any> extends Resource<Record> {
		#record: any; // the stored/frozen record from the database and stored in the cache (should not be modified directly)
		#changes: any; // the changes to the record that have been made (should not be modified directly)
		#version?: number; // version of the record
		#entry?: Entry; // the entry from the database
		#savingOperation?: any; // operation for the record is currently being saved

		declare getProperty: (name: string) => any;
		// #section: static-config
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
		static description = description;
		static properties = properties;
		static hidden = hidden;
		static outputSchemas: { [verb: string]: JsonSchemaFragment } | undefined;
		static mcp: { annotations?: { [verb: string]: any } } | undefined;
		static replicate = replicate;
		static sealed = sealed;
		static splitSegments = splitSegments ?? true;
		static createdTimeProperty = createdTimeProperty;
		static updatedTimeProperty = updatedTimeProperty;
		static propertyResolvers;
		static userResolvers = {};
		// `@embed` hook registry. `userSetEmbedders` records names set explicitly via
		// `setEmbedAttribute` so a schema reload refreshes defaults without clobbering them.
		static userEmbedders: { [name: string]: Embedder } = {};
		static userSetEmbedders: Set<string> = new Set();
		static embedAttributes: EmbedAttribute[] = (attributes as any[]).filter((a) => a?.embed);
		static source?: typeof TableResource;
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
		// #section: resource-registry
		static sourcedFrom(source, options) {
			// define a source for retrieving invalidated entries for caching purposes
			if (options) {
				this.sourceOptions = options;
				if (options.expiration || options.eviction || options.scanInterval) this.setTTLExpiration(options);
			}
			if (options?.intermediateSource) {
				source.intermediateSource = true;
				// intermediateSource should register sourceLoad and setup subscription but not assign to this.source
			} else {
				if (this.source) {
					if (this.source.name === source.name) {
						// if we are adding a source that is already set, we don't add it again
						return;
					}
					throw new Error('Can not have multiple sources');
				}
				this.source = source;
			}
			hasSourceGet = hasSourceGet || (source.get && (!source.get.reliesOnPrototype || source.prototype.get));
			sourceLoad = sourceLoad || source.load;
			// Revalidation down-converts incoming put/patch events to invalidate so a cache re-fetches
			// from its source on next read. It must apply ONLY to events from the canonical caching
			// source — never to authoritative writes arriving from a replication peer, which registers
			// as an intermediateSource (harper-pro replication/replicator.ts). This closure is created
			// per sourcedFrom() call, but the flag was read from this.source (the canonical caching
			// source) regardless of which source the subscription is actually for; on a cache-sourced
			// AND replicated table that leaked the caching source's revalidate flag onto the replication
			// subscription, turning replicated writes into invalidates and deleting file-backed blobs no
			// peer re-supplied. See HarperFast/harper#1302. Gate it off the intermediate source.
			const shouldRevalidateEvents = !options?.intermediateSource && this.source?.shouldRevalidateEvents;

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
						viaNodeId: event.viaNodeId,
						// use per-event expiresAt: batched txn context only holds the first event's expiration
						expiresAt: event.expiresAt,
						async: true,
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
								if (!event || typeof event !== 'object') {
									logger.error?.('Bad subscription event', event);
									continue;
								}
								const firstWrite = event.type === 'transaction' ? event.writes[0] : event;
								if (!firstWrite) {
									logger.error?.('Bad subscription event', event);
									continue;
								}
								event.source = source;
								// Writes applied here come from the canonical source of truth (a replication peer or an
								// external caching source), so a transient write conflict must never drop the write —
								// there is no re-subscribe / sequence-id-resume path to recover it. Mark the context so the
								// commit retries such conflicts without a cap (see DatabaseTransaction commit).
								event.sourceApply = true;
								if (event.type === 'end_txn') {
									// Capture the in-progress transaction in a stable local: the loop variable is reset
									// once this transaction completes (below), but the seq-id closure and the commit await
									// still need to reference it afterward.
									const committingTxn = txnInProgress;
									committingTxn?.resolve();
									let updateRecordedSequenceId: () => void;
									if (event.localTime && lastSequenceId !== event.localTime) {
										if (event.remoteNodeIds?.length > 0) {
											updateRecordedSequenceId = () => {
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
													if (nodeId === committingTxn?.nodeId) {
														nodeState.lastTxnTime = event.timestamp;
													}
												}
												const seqId = Math.max(existingSeq?.seqId ?? 1, event.localTime);
												logger.trace?.(
													'Received txn',
													databaseName,
													seqId,
													new Date(seqId),
													event.localTime,
													new Date(event.localTime),
													event.remoteNodeIds
												);
												dbisDb.put(seqKey, {
													seqId,
													nodes: nodeStates,
												});
											};
											lastSequenceId = event.localTime;
										}
									}
									// Backpressure: wait for the transaction's commit to land before recording the sequence
									// id or pulling the next event. This serializes the apply loop so bulk ingest can't
									// outrun the commit/conflict-check window, and guarantees the sequence id never
									// advances past an uncommitted write (which would diverge this node from its peers).
									let committed;
									try {
										committed = committingTxn ? await committingTxn.committed : undefined;
										if (event.onCommit) {
											// the onCommit callback can be async and carry associated work (e.g. blob
											// transfer); wait for it too before recording the sequence id. Pass the commit
											// resolution through, as callbacks may use the committed txn time.
											await event.onCommit(committed);
										}
									} finally {
										// Always clear the completed transaction so a later standalone write isn't appended
										// to it (and lost), and a failed commit's rejected promise isn't re-awaited on the
										// next beginTxn (which would brick the apply loop).
										txnInProgress = undefined;
									}
									// Only reached when the commit succeeded; a failure propagates to the handler's catch
									// and the sequence id is intentionally not advanced past the unapplied write.
									if (updateRecordedSequenceId) updateRecordedSequenceId();
									continue;
								}
								if (txnInProgress) {
									if (event.beginTxn) {
										// Starting a new transaction closes the existing one. When transactions are
										// delimited by consecutive beginTxn events (end_txn only arrives after the final
										// one), this is the backpressure point for all but the last transaction: wait for
										// the prior commit to land before applying the next so the sequence id can't
										// advance past an uncommitted write.
										txnInProgress.resolve();
										try {
											await txnInProgress.committed;
										} catch (error) {
											// Transient conflicts retry without limit and never reach here, so this is a
											// non-retryable commit failure on the prior transaction. Log and continue (rather
											// than rethrow) so the current beginTxn still starts a fresh transaction with
											// correct boundaries instead of having its writes applied as standalone ones.
											logger.error?.('source-applied transaction commit failed during apply', error);
										} finally {
											// Clear it regardless of outcome so a rejected commit isn't re-awaited on the
											// next beginTxn (which would brick the apply loop).
											txnInProgress = undefined;
										}
									} else {
										// write in the current transaction if one is in progress
										txnInProgress.writePromises.push(writeUpdate(event, txnInProgress));
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
											txnInProgress.writePromises = [writeUpdate(event, event)];
											return new Promise((resolve) => {
												// callback for when this transaction is finished (will be called on next txn begin/end).
												txnInProgress.resolve = () => resolve(Promise.all(txnInProgress.writePromises)); // and make sure we wait for the write update to finish
											});
										}
										return writeUpdate(event, event);
									}
								});
								if (txnInProgress) txnInProgress.committed = commitResolution;
								if (userRoleUpdate && commitResolution && !(commitResolution as any).waitingForUserChange) {
									// if the user role changed, asynchronously signal the user change (but don't block this function)
									commitResolution.then(() => signalling.signalUserChange(new UserEventMsg(process.pid)));
									(commitResolution as any).waitingForUserChange = true; // only need to send one signal per transaction
								}

								if (event.onCommit) {
									if (txnInProgress) {
										// begin_txn: commitResolution stays pending until the matching end_txn, so it
										// can't be awaited here; onCommit is awaited at end_txn once the commit lands.
										if (commitResolution) commitResolution.then(event.onCommit);
										else event.onCommit();
									} else {
										// standalone write: backpressure on the commit before pulling the next event,
										// and pass the commit resolution through to the callback.
										const committed = commitResolution ? await commitResolution : undefined;
										await event.onCommit(committed);
									}
								} else if (commitResolution && !txnInProgress) {
									// standalone write with no onCommit: still backpressure on the commit.
									await commitResolution;
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
		 * @param target
		 * @param request
		 * @param resourceOptions An important option is ensureLoaded, which can be used to indicate that it is necessary for a caching table to load data from the source if there is not a local copy of the data in the table (usually not necessary for a delete, for example).
		 * @returns
		 */
		static getResource<Record extends object = any>(
			target: RequestTarget,
			request: Context,
			resourceOptions?: any
		): Promise<TableResource<Record>> | TableResource<Record> {
			const resource: TableResource = super.getResource(target, request, resourceOptions) as any;
			if (this.loadAsInstance !== false) {
				return resource._loadRecord(target, request, resourceOptions);
			}
			return resource;
		}
		_loadRecord(target: RequestTarget, request: Context, resourceOptions?: any): MaybePromise<TableResource<Record>> {
			const id = target && typeof target === 'object' ? target.id : target;
			if (id == null) return this;
			checkValidId(id);
			try {
				if (this.getRecord?.()) return this; // already loaded, don't reload, current version may have modifications
				if (typeof id === 'object' && id && !Array.isArray(id)) {
					throw new Error(`Invalid id ${JSON.stringify(id)}`);
				}
				const sync = target?.sync || primaryStore.cache?.get?.(id);
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
							TableResource._updateResource(this, entry);
						} else this.#record = null;
						if (request.onlyIfCached) {
							// don't go into the loading from source condition, but HTTP spec says to
							// return 504 (rather than 404) if there is no content and the cache-control header
							// dictates not to go to source
							if (!this.doesExist()) throw new ServerError('Entry is not cached', 504);
							if (hasSourceGet && target) target.loadedFromSource = false; // mark it as cached
						} else if (resourceOptions?.ensureLoaded) {
							const loadingFromSource = ensureLoadedFromSource(
								(this.constructor as any).source,
								id,
								entry,
								request,
								this,
								target
							);
							if (loadingFromSource) {
								txn?.disregardReadTxn(); // this could take some time, so don't keep the transaction open if possible
								return when(loadingFromSource as Promise<Entry>, (entry) => {
									TableResource._updateResource(this, entry);
									return this;
								});
							} else if (hasSourceGet) target.loadedFromSource = false; // mark it as cached
						}
						return this;
					}
				);
			} catch (error) {
				if (error.message.includes('Unable to serialize object')) error.message += ': ' + JSON.stringify(id);
				throw error;
			}
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
			const loadedFromSource = ensureLoadedFromSource(
				(this.constructor as any).source,
				this.getId(),
				this.#entry,
				this.getContext()
			);
			if (loadedFromSource) {
				return when(loadedFromSource as Promise<Entry>, (entry) => {
					this.#entry = entry;
					this.#record = entry.value;
					this.#version = entry.version;
				});
			}
		}
		// #section: lifecycle-admin
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
					const readTxn = inTxn ? undefined : primaryStore.useReadTransaction?.();
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
					for (const key of primaryStore.getKeys({ start: lastKey, end: true, limit: 1, reverse: true })) {
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
		 * @param opts Time in seconds until records expire, or an options object with `expiration`, `eviction`,
		 * and `scanInterval` (all in seconds, all optional). Number form preserves any previously configured
		 * eviction/scanInterval; object form replaces all three.
		 */
		static setTTLExpiration(opts: number | { expiration?: number; eviction?: number; scanInterval?: number }) {
			if (opts == null || (typeof opts !== 'number' && typeof opts !== 'object'))
				throw new Error('Invalid expiration value type');
			if (typeof opts === 'number') {
				expirationMs = opts * 1000;
			} else {
				// `??` so an explicit 0 is treated as the user's chosen value, not as "missing"
				expirationMs = (opts.expiration ?? 0) * 1000;
				evictionMs = (opts.eviction ?? 0) * 1000;
				cleanupInterval = (opts.scanInterval ?? 0) * 1000;
			}
			if (expirationMs < 0) throw new Error('Expiration can not be negative');
			// default to one quarter of the total expiration+eviction window
			cleanupInterval = cleanupInterval || (expirationMs + evictionMs) / 4;
			expirationScanScheduled = true;
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
		static enableAuditing() {
			if (audit) return; // already enabled
			audit = true;
			addDeleteRemoval();
			TableResource.audit = true;
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
			if (databaseName === databasePath) {
				// Persist a drop tombstone on the primary catalog entry BEFORE any
				// destructive work. If the process dies or a column family drop fails
				// partway through, the tombstone survives with the catalog rows, and
				// the next startup (or a same-name create) completes the drop via
				// completeInterruptedDrop in databases.ts instead of resurrecting
				// the table.
				const primaryCatalogKey = TableResource.tableName + '/';
				const primaryMeta = (dbisDb as any).getSync(primaryCatalogKey);
				if (primaryMeta && !primaryMeta.dropping) {
					primaryMeta.dropping = true;
					// put is rebound to putSync on RocksDB stores; on LMDB it returns
					// a promise, so await it to make the tombstone durable before the
					// destructive work below
					const tombstoneWrite = (dbisDb as any).put(primaryCatalogKey, primaryMeta);
					if (tombstoneWrite?.then) await tombstoneWrite;
				}
			}
			// Remove the table from the in-memory schema immediately so concurrent
			// requests get "table does not exist" instead of racing the column
			// family drops below. If a drop fails past this point the table stays
			// invisible, and the tombstone guarantees the drop completes on the
			// next startup (or on a same-name create).
			delete databases[databaseName][tableName];
			for (const entry of primaryStore.getRange({ versions: true, snapshot: false, lazy: true })) {
				if (entry.metadataFlags & HAS_BLOBS && entry.value) {
					deleteBlobsInObject(entry.value);
				}
			}
			if (databaseName === databasePath) {
				// part of a database.
				// Drop the column families, then remove the catalog metadata - never
				// the reverse: a removed-then-failed drop orphans a "ghost" column
				// family that poisons same-name recreates, so a genuine drop failure
				// must surface and leave the tombstoned catalog rows for the reconcile.
				//
				// A drop is broadcast to every worker thread, and each holds its own
				// handle to the same underlying column family, so a concurrent worker
				// (or completeInterruptedDrop) may already have dropped it - surfaced
				// as "Column family already dropped!". That is the intended end state,
				// not a failure, so tolerate it. The catalog rows are removed only if
				// this drop's tombstone is still the live primary row: a concurrent
				// same-name create completes the interrupted drop and writes fresh
				// catalog rows, and clobbering those would orphan the new table.
				const removeTombstonedCatalog = () => {
					const currentPrimary = (dbisDb as any).getSync(TableResource.tableName + '/');
					if (!currentPrimary?.dropping) return false;
					for (const attribute of attributes) {
						dbisDb.remove(TableResource.tableName + '/' + attribute.name);
					}
					dbisDb.remove(TableResource.tableName + '/');
					return true;
				};
				const rootStore = primaryStore.rootStore;
				if (rootStore instanceof RocksDatabase) {
					// Serialize the drops + catalog removal against a concurrent
					// same-name create (and completeInterruptedDrop) under the database's
					// 'update-attributes' exclusive lock - the same lock the create path
					// holds. It is a synchronous spin lock that blocks the event loop, so
					// the locked section MUST stay synchronous: drop with dropSync (as
					// completeInterruptedDrop does), never an awaited drop(), or a
					// concurrent create's spin would deadlock waiting on a drop that the
					// blocked event loop can never resolve.
					while (!rootStore.tryLock('update-attributes')) {}
					let removed = false;
					try {
						for (const attribute of attributes) {
							const index = indices[attribute.name];
							if (index)
								try {
									index.dropSync();
								} catch (error) {
									ignoreAlreadyDropped(error);
								}
						}
						try {
							primaryStore.dropSync();
						} catch (error) {
							ignoreAlreadyDropped(error);
						}
						removed = removeTombstonedCatalog();
					} finally {
						rootStore.unlock('update-attributes');
					}
					if (removed) await dbisDb.committed;
				} else {
					// LMDB: no shared column-family double-drop, and its engine lock is
					// transactional rather than this spin lock, so keep the awaited drop
					// plus the same tombstone-guarded catalog removal.
					const drops = [];
					for (const attribute of attributes) {
						const index = indices[attribute.name];
						if (index) drops.push(index.drop().catch(ignoreAlreadyDropped));
					}
					drops.push(primaryStore.drop().catch(ignoreAlreadyDropped));
					await Promise.all(drops);
					if (removeTombstonedCatalog()) await dbisDb.committed;
				}
			} else {
				// legacy table per database
				await primaryStore.close();
				fs.unlinkSync(primaryStore.path);
			}
			signalling.signalSchemaChange(
				new SchemaEventMsg(process.pid, OPERATIONS_ENUM.DROP_TABLE, databaseName, tableName)
			);
		}
		// #section: read-path
		/**
		 * This retrieves the data of this resource.
		 * @param target - If included, is an identifier/query that specifies the requested target to retrieve and query
		 */
		get(target?: any): any {
			const constructor: any = this.constructor;
			if (typeof target === 'string' && constructor.loadAsInstance !== false) return this.getProperty(target);
			if (isSearchTarget(target)) {
				// go back to the static search method so it gets a chance to override
				return constructor.search(target, this.getContext());
			}
			if (target && target.id === undefined && !target.toString()) {
				const description = {
					// basically a describe call
					records: './', // an href to the records themselves
					name: tableName,
					database: databaseName,
					auditSize:
						auditStore instanceof RocksDatabase ? auditStore.getKeysCount() : auditStore?.getStats().entryCount,
					attributes,
					recordCount: undefined,
					estimatedRecordRange: undefined,
				};
				if ((this.getContext() as any)?.includeExpensiveRecordCountEstimates) {
					return TableResource.getRecordCount().then((recordCount) => {
						description.recordCount = recordCount.recordCount;
						description.estimatedRecordRange = recordCount.estimatedRange;
						return description;
					});
				}
				return description;
			}
			if (target !== undefined && constructor.loadAsInstance === false) {
				const context: any = this.getContext();
				const txn = txnForContext(context);
				const readTxn = txn.getReadTxn();
				if (readTxn?.isDone) {
					throw new Error('You can not read from a transaction that has already been committed/aborted');
				}
				const id = requestTargetToId(target);
				checkValidId(id);
				let allowed = true;
				if ((target as any)?.checkPermission) {
					// requesting authorization verification
					allowed = this.allowRead(context.user, target, context);
				}
				return promiseNormalize(
					when(
						when(allowed, (allowed: boolean) => {
							if (!allowed) {
								throw new AccessViolation(context.user);
							}
							const ensureLoaded = true;
							return loadLocalRecord(id, context, { transaction: readTxn, ensureLoaded }, false, (entry) => {
								if (context.onlyIfCached) {
									// don't go into the loading from source condition, but HTTP spec says to
									// return 504 (rather than 404) if there is no content and the cache-control header
									// dictates not to go to source
									if (!entry?.value) throw new ServerError('Entry is not cached', 504);
								} else if (ensureLoaded) {
									const loadingFromSource = ensureLoadedFromSource(
										constructor.source,
										id,
										entry,
										context,
										this,
										target
									);
									if (loadingFromSource) {
										txn?.disregardReadTxn(); // this could take some time, so don't keep the transaction open if possible
										return loadingFromSource.then((entry) => entry?.value);
									}
								}
								return entry?.value;
							});
						}),
						(record) => {
							const select = target?.select;
							if (select && record != null) {
								const transform = transformForSelect(select, this.constructor);
								return transform(record);
							}
							if (target?.property) {
								return record[target?.property];
							}
							return record;
						}
					),
					target
				);
			}
			if (target?.property) return this.getProperty(target.property);
			if (!constructor.getReturnMutable) {
				// if we are not explicitly using getReturnMutable, return the frozen record
				const record = this.#record;
				const select = target?.select;
				if (select && record != null) {
					const transform = transformForSelect(select, this.constructor);
					return promiseNormalize(transform(record), target);
				}
				return promiseNormalize(record, target);
			}
			if (this.doesExist() || target?.ensureLoaded === false || (this.getContext() as any)?.returnNonexistent) {
				return this;
			}
			return undefined;
		}
		// #section: authz-hooks
		/**
		 * Determine if the user is allowed to get/read data from the current resource
		 */
		allowRead(user: User, target: RequestTarget, context: Context): boolean {
			const tablePermission = getTablePermissions(user, target);
			if (tablePermission?.read) {
				if (tablePermission.isSuperUser) return true;
				const attribute_permissions = tablePermission.attribute_permissions;
				const select = target?.select;
				if (attribute_permissions?.length > 0 || (hasRelationships && select)) {
					// If attribute permissions are defined, we need to ensure there is a select that only returns the attributes the user has permission to
					// or if there are relationships, we need to ensure that the user has permission to read from the related table
					// Note that if we do not have a select, we do not return any relationships by default.
					if (!target) target = {} as any;
					if (select) {
						const selectArray = Array.isArray(select) ? select : [select];
						const attrsForType = attribute_permissions?.length > 0 && attributesAsObject(attribute_permissions, 'read');
						(target as any).select = selectArray
							.map((property: any) => {
								const propertyName = property.name || property;
								if (!attrsForType || attrsForType[propertyName]) {
									const relatedTable = propertyResolvers[propertyName]?.definition?.tableClass;
									if (relatedTable) {
										// if there is a related table, we need to ensure the user has permission to read from that table and that attributes are properly restricted
										if (!property.name) property = { name: property };
										if (!property.checkPermission && (target as any).checkPermission)
											property.checkPermission = (target as any).checkPermission;
										if (!relatedTable.prototype.allowRead.call(null, user, property, context)) return false;
										if (!property.select) return property.name; // no select was applied, just return the name
									}
									return property;
								}
							})
							.filter(Boolean);
					} else {
						target.select = attribute_permissions
							.filter((attribute) => attribute.read && !propertyResolvers[attribute.attribute_name])
							.map((attribute) => attribute.attribute_name);
					}
					return true;
				} else {
					return true;
				}
			}
		}

		/**
		 * Determine if the user is allowed to update data from the current resource
		 */
		// @ts-expect-error Tables only allow synchronous allowUpdate checks.
		// eslint-disable-next-line no-unused-vars
		allowUpdate(user: User, updatedData: Record, context: Context): boolean {
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
		 */
		// @ts-expect-error Tables only allow synchronous allowCreate checks.
		allowCreate(user: User, newData: Record, context: Context): boolean {
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
				return this.allowUpdate(user, newData, context);
			}
		}

		/**
		 * Determine if the user is allowed to delete from the current resource
		 */
		allowDelete(user: User, target: RequestTarget, context: Context): boolean {
			const tablePermission = getTablePermissions(user, target);
			return !!tablePermission?.delete && checkContextPermissions(context);
		}

		// #section: write-path-public
		/**
		 * Start updating a record. The returned resource will record changes which are written
		 * once the corresponding transaction is committed. These changes can (eventually) include CRDT type operations.
		 */
		update(updates: Record & RecordObject, fullUpdate: true);
		update(updates: Partial<Record & RecordObject>, target?: RequestTarget);
		update(target: RequestTarget, updates?: any);
		update(target: any, updates?: any) {
			let id: Id;
			// determine if it is a legacy call
			const directInstance =
				typeof updates === 'boolean' ||
				(updates === undefined &&
					(target == undefined || (typeof target === 'object' && !(target instanceof URLSearchParams))));
			let fullUpdate: boolean = false;
			if (directInstance) {
				// legacy, shift the arguments
				fullUpdate = updates;
				updates = target;
				id = this.getId();
			} else {
				id = requestTargetToId(target);
			}

			const context = this.getContext();
			const envTxn = txnForContext(context);
			if (!envTxn) throw new Error('Can not update a table resource outside of a transaction');
			// record in the list of updating records so it can be written to the database when we commit
			if (updates === false) {
				// TODO: Remove from transaction
				return this;
			}
			if (typeof updates === 'object' && updates) {
				if (fullUpdate) {
					// legacy full update where we need to update the entire record, but the instance needs to continue
					// track any further changes
					if (Object.isFrozen(updates)) updates = { ...updates };
					this.#record = {}; // clear out the existing record
					this.#changes = updates;
				} else if (directInstance) {
					// incremental update with legacy arguments
					const ownData = this.#changes;
					if (ownData) updates = Object.assign(ownData, updates);
					this.#changes = updates;
				} else {
					// standard path, where we retrieve the references record and return an instance, initialized with any
					// updates that were passed into this method
					let allowed = true;
					if (target == undefined) throw new TypeError('Can not put a record without a target');
					if ((target as any)?.checkPermission) {
						// requesting authorization verification
						allowed = this.allowUpdate((context as any).user, updates, context);
					}
					return when(allowed, (allowed) => {
						if (!allowed) {
							throw new AccessViolation((context as any).user);
						}
						let loading: Promise<any>;
						if (!this.#entry && (this.constructor as any).loadAsInstance === false) {
							// load the record if it hasn't been done yet
							loading = this._loadRecord(target, context, { ensureLoaded: true, async: true }) as Promise<any>;
						}
						return when(loading, () => {
							this.#changes = updates;
							// `when` awaits the embed hook (when `@embed` is active) before resolving,
							// so the caller's `save()` doesn't run before the write is staged.
							return when(this._writeUpdate(id, this.#changes, false), () => this);
						});
					});
				}
			}
			return when(this._writeUpdate(id, this.#changes, fullUpdate), () => this);
		}

		/**
		 * Save any changes into this instance to the current transaction
		 */
		save() {
			if (this.#savingOperation) {
				try {
					return this.#saveOperation(this.#savingOperation);
				} finally {
					this.#savingOperation = null;
				}
			}
		}
		#saveOperation(operation: any) {
			const transaction = txnForContext(this.getContext());
			if (transaction.save) return transaction.save(operation) || operation.promise || operation.result;
		}

		addTo(property: any, value: any) {
			if (typeof value === 'number' || typeof value === 'bigint') {
				if (this.#savingOperation?.fullUpdate)
					(this as any).set(property, (+this.getProperty(property) || 0) + (value as any));
				else {
					if (!this.#savingOperation) (this as any).update();
					(this as any).set(property, new Addition(value));
				}
			} else {
				throw new Error('Can not add a non-numeric value');
			}
		}
		subtractFrom(property: any, value: any) {
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
			let allowed = true;
			const context = this.getContext();
			if ((target as RequestTarget)?.checkPermission) {
				// requesting authorization verification
				allowed = this.allowDelete((context as any).user, target as any, context);
			}
			return when(allowed, (allowed: boolean) => {
				if (!allowed) {
					throw new AccessViolation((context as any).user);
				}
				this._writeInvalidate(target ? requestTargetToId(target) : this.getId());
			});
		}
		_writeInvalidate(id: Id, partialRecord?: any, options?: any) {
			const context = this.getContext();
			checkValidId(id);
			const transaction = txnForContext(this.getContext());
			const write: any = {
				key: id,
				store: primaryStore,
				invalidated: true,
				entry: this.#entry,
				commit: (txnTime, existingEntry, _retry, transaction: any) => {
					write.skipped = false; // reset on each retry; cleanup happens after commit if still true
					if (precedesExistingVersion(txnTime, existingEntry, options?.nodeId) <= 0) {
						write.skipped = true;
						return;
					}
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
						{
							user: (context as any)?.user,
							residencyId: options?.residencyId,
							nodeId: options?.nodeId,
							viaNodeId: options?.viaNodeId,
							transaction,
							tableToTrack: tableName,
						},
						'invalidate'
					);
					// TODO: recordDeletion?
				},
			};
			write.beforeIntermediate = preCommitBlobsForRecordBefore(write, partialRecord);
			transaction.addWrite(write);
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
				before:
					(this.constructor as any).source?.relocate && !(context as any)?.source
						? (this.constructor as any).source.relocate.bind((this.constructor as any).source, id, undefined, context)
						: undefined,
				commit: (txnTime, existingEntry, _retry, transaction: any) => {
					if (precedesExistingVersion(txnTime, existingEntry, options?.nodeId) <= 0) return;
					const residency = TableResource.getResidencyRecord(options.residencyId);
					let metadata = 0;
					let newRecord = null;
					const existingRecord = existingEntry?.value;
					if (residency && !residency.includes(server.hostname)) {
						for (const name in indices) {
							if (!newRecord) newRecord = {};
							// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
							newRecord[name] = existingRecord[name];
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
							user: (context as any)?.user,
							residencyId: options.residencyId,
							nodeId: options.nodeId,
							viaNodeId: options?.viaNodeId,
							expiresAt: options.expiresAt,
							transaction,
						},
						'relocate',
						false,
						null
					);
				},
			});
		}

		/**
		 * Record the relocation of an entry (when a record is moved to a different node), return true if it is now located locally
		 * @param existingEntry
		 * @param entry
		 */
		static _recordRelocate(existingEntry, entry): boolean {
			if (this.getResidencyById) return false; // we don't want to relocate entries that are located by id
			const context = {
				previousResidency: this.getResidencyRecord(existingEntry.residencyId),
				isRelocation: true,
			};
			const residency = residencyFromFunction(this.getResidency(entry.value, context));
			let residencyId: number;
			if (residency) {
				if (!residency.includes(server.hostname)) return false; // if we aren't in the residency, we don't need to do anything, we are not responsible for storing this record
				residencyId = getResidencyId(residency);
			}
			const metadata = 0;
			logger.debug?.('Performing a relocate of an entry', existingEntry.key, entry.value, residency);
			updateRecord(
				existingEntry.key,
				entry.value, // store the record we downloaded
				existingEntry,
				existingEntry.version, // version number should not change
				metadata,
				true,
				{ residencyId, expiresAt: entry.expiresAt, transaction: txnForContext(context).transaction },
				'relocate',
				false,
				null // the audit record value should be empty since there are no changes to the actual data
			);
			return true;
		}
		/**
		 * Evicting a record will remove it from a caching table. This is not considered a canonical data change, and it is assumed that retrieving this record from the source will still yield the same record, this is only removing the local copy of the record.
		 */
		static evict(id, existingRecord, existingVersion) {
			let entry;
			const lmdbTransaction = txnForContext({ transaction: new DatabaseTransaction() });
			let transaction = lmdbTransaction.getReadTxn();
			let options = { transaction };
			let committed = false;
			try {
				if (hasSourceGet || audit) {
					if (!existingRecord) return;
					entry = primaryStore.getEntry(id, options);
					if (!entry || !existingRecord) return;
					if (entry.version !== existingVersion) return;
				}
				if (hasSourceGet) {
					// if there is a resolution in-progress, abandon the eviction
					if (primaryStore.hasLock(id, entry.version)) return;
				}
				// evictions never go in the audit log, so we can not record a deletion entry for the eviction
				// as there is no corresponding audit entry and it would never get cleaned up. So we must simply
				// removed the entry entirely, but first cleanup indices
				let lmdbCompletion: MaybePromise<unknown>;
				if (primaryStore.ifVersion) {
					// lmdb: the index cleanup and the record removal are both version-guarded optimistic writes.
					// Capture both promises so a real write failure on either resolves through evict()'s catch
					// below rather than escaping as an unhandled rejection from the fire-and-forget callers.
					const indexCleanup = primaryStore.ifVersion(id, existingVersion, () => {
						updateIndices(id, existingRecord, null);
					});
					const removal = removeEntry(primaryStore, entry ?? primaryStore.getEntry(id), existingVersion);
					lmdbCompletion = Promise.all([indexCleanup, removal]);
				} else {
					updateIndices(id, existingRecord, null, options);
					removeEntry(primaryStore, entry ?? primaryStore.getEntry(id), options);
				}
				committed = true;
				// Eviction is best-effort cleanup, run fire-and-forget from the record-expiration sweep and the
				// read path as well as the concurrency-limited cleanup scan. A concurrent write to the same record
				// makes the commit conflict — that is expected, not a failure: lazy-expiry-on-read keeps queries
				// correct and the active writer resets the record's expiry/version. So evict() must (a) always
				// return a thenable (the cleanup scan awaits it for backpressure) and (b) never reject, so a
				// conflict can't escape as an unhandledRejection from the fire-and-forget callers.
				if (primaryStore.ifVersion) {
					// LMDB: committing the wrapper calls doneReadTxn(), removing it from trackedTxns. It has no
					// tracked writes (the writes went straight to the store via optimistic ifVersion), so it returns
					// a plain resolution object rather than a promise — return the store's write promises instead, so
					// the caller gets a real thenable that resolves once the removal is durable.
					(lmdbTransaction as any).commit();
					return Promise.resolve(lmdbCompletion).catch((error) => {
						logger.warn?.('Error evicting record', id, error);
					});
				}
				// RocksDB: eviction writes went directly into the raw transaction via options; commit it directly,
				// as DatabaseTransaction.commit() would abort it (no tracked writes). The raw commit bypasses
				// DatabaseTransaction's ERR_BUSY retry, so a concurrent-write conflict rejects here — swallow it
				// (abandon the eviction) and log anything unexpected, rather than letting it crash the process.
				return (transaction as any).commit().catch((error) => {
					// The commit failed, so the read-snapshot/transaction handle is still open — release it, as the
					// batched-eviction path does on its own commit failures. committed===true skips the finally abort.
					try {
						(transaction as any).abort();
					} catch {}
					if (error?.code === 'ERR_BUSY') logger.trace?.('Abandoned eviction of busy record', id);
					else logger.warn?.('Error evicting record', id, error);
				});
			} finally {
				if (!committed) {
					// Skip path or thrown error: abort instead of committing so we don't apply
					// partial work and the txn handle is released.
					if (primaryStore.ifVersion) {
						(lmdbTransaction as any).abort?.();
					} else {
						(transaction as any)?.abort?.();
					}
				}
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
			return (global as any).operation(operation, context);
		}

		/**
		 * Store the provided record data into the current resource. This is not written
		 * until the corresponding transaction is committed.
		 */
		// @ts-expect-error The implementation intentionally uses a different argument order for back-compat
		put(
			target: RequestTarget,
			record: Record & RecordObject
		): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)> {
			if (record === undefined || record instanceof URLSearchParams) {
				// legacy argument position, shift the arguments and go through the update method for back-compat.
				// `when` settles the embed hook before `save()` so the write is staged first.
				return when((this as any).update(target, true), () => this.save() as any) as any;
			} else {
				let allowed = true;
				if (target == undefined) throw new TypeError('Can not put a record without a target');
				const context = this.getContext();
				if ((target as any).checkPermission) {
					// requesting authorization verification
					allowed = this.allowUpdate((context as any).user, record, context);
				}
				return when(allowed, (allowed) => {
					if (!allowed) {
						throw new AccessViolation((context as any).user);
					}
					// standard path, handle arrays as multiple updates, and otherwise do a direct update
					if (Array.isArray(record)) {
						// Capture each element's operation synchronously (before any async `@embed`
						// hook resolves): `#savingOperation` is a single field that parallel writes
						// would otherwise clobber, so a deferred `save()` would commit the wrong op
						// — e.g. one element's save running before a later element's vector is written.
						const writes = record.map((element) => {
							const id = element[primaryKey];
							const writePromise = this._writeUpdate(id, element, true);
							const operation = this.#savingOperation;
							return when(writePromise, () => this.#saveOperation(operation));
						});
						this.#savingOperation = null;
						return Promise.all(writes) as any;
					} else {
						const id = requestTargetToId(target as any);
						return when(this._writeUpdate(id, record, true), () => this.save() as any);
					}
				}) as any;
			}
			// always return undefined
		}

		create(
			target: RequestTargetOrId,
			record: Partial<Record & RecordObject>
		): void | (Record & Partial<RecordObject>) | Promise<Record & Partial<RecordObject>> {
			let allowed = true;
			const context = this.getContext();
			if (!record && !(target instanceof URLSearchParams)) {
				// single argument, shift arguments
				record = target as any;
				target = undefined;
			}
			if (!record || typeof record !== 'object' || Array.isArray(record)) {
				throw new TypeError('Can not create a record without an object');
			}
			if ((target as any)?.checkPermission) {
				// requesting authorization verification
				allowed = this.allowCreate((context as any).user, record as any, context);
			}
			return when(allowed, (allowed) => {
				if (!allowed) {
					throw new AccessViolation((context as any).user);
				}
				let id = requestTargetToId(target as any) ?? record[primaryKey];
				if (id === undefined) {
					id = (this.constructor as any).getNewId();
					record[primaryKey] = id; // make this immediately available
				} else {
					const existing = primaryStore.getSync(id);
					if (existing) {
						throw new ClientError('Record already exists', 409);
					}
				}
				// `_writeUpdate` may return a promise when an `@embed` directive
				// requires running an embedder before the per-write `commit(...)`
				// closure. `when()` passes through synchronous returns.
				return when(this._writeUpdate(id, record, true), () => record);
			}) as any;
		}

		// @ts-expect-error The implementation handles the possibility of target and recordUpdate being swapped
		patch(
			target: RequestTarget,
			recordUpdate: Partial<Record & RecordObject>
		): void | (Record & Partial<RecordObject>) | Promise<void | (Record & Partial<RecordObject>)> {
			if (recordUpdate === undefined || recordUpdate instanceof URLSearchParams) {
				// legacy argument position, shift the arguments and go through the update method for back-compat.
				// `when` settles the embed hook before `save()` so the write is staged first.
				return when(this.update(target, false), () => this.save() as any) as any;
			} else {
				// standard path, ensure there is no return object
				return when(this.update(target, recordUpdate), () => {
					return when(this.save() as any, () => undefined); // wait for the update and save, but return undefined
				}) as any;
			}
		}
		// #section: write-path-internals
		// perform the actual write operation; this may come from a user request to write (put, post, etc.), or
		// a notification that a write has already occurred in the canonical data source, we need to update our
		// local copy
		_writeUpdate(id: Id, recordUpdate: any, fullUpdate: boolean, options?: any) {
			const context = this.getContext();
			const transaction = txnForContext(context);
			checkValidId(id);
			const entry = this.#entry ?? primaryStore.getEntry(id, { transaction: transaction.getReadTxn() });
			const writeToSource = () => {
				if (!(this.constructor as any).source || (context as any)?.source) return;
				if (fullUpdate) {
					// full update is a put
					if ((this.constructor as any).source.put) {
						return () => (this.constructor as any).source.put(id, recordUpdate, context);
					}
				} else {
					// incremental update
					if ((this.constructor as any).source.patch) {
						return () => (this.constructor as any).source.patch(id, recordUpdate, context);
					} else if ((this.constructor as any).source.put) {
						// if this is incremental, but only have put, we can use that by generating the full record (at least the expected one)
						return () => (this.constructor as any).source.put(id, updateAndFreeze(this), context);
					}
				}
			};

			const write: any = {
				key: id,
				store: primaryStore,
				entry,
				nodeName: (context as any)?.nodeName,
				fullUpdate,
				deferSave: true,
				validate: (txnTime) => {
					if (!recordUpdate) recordUpdate = this.#changes;
					if (fullUpdate || (recordUpdate && hasChanges(this.#changes === recordUpdate ? this : recordUpdate))) {
						if (!(context as any)?.source) {
							transaction.checkOverloaded();
							// Records are intentionally immutable: decoded records are frozen (and 5.2 record
							// caching relies on it), so mutating in place would corrupt cached/shared state.
							// validate() coerces values and we stamp created/updated times + the primary key
							// below, so copy-on-mutate when recordUpdate is frozen (e.g. a record decoded during
							// log replay) instead of writing through the frozen object.
							if (isFrozenRecordObject(recordUpdate)) recordUpdate = { ...recordUpdate };
							// Skip schema validation during crash-recovery replay (transaction.isReplay is set
							// by replayLogs). Records were valid when originally written; post-crash schema
							// evolution (e.g. newly required fields) must not prevent replaying them
							// (harper#1316, facet b).
							if (!transaction.isReplay) this.validate(recordUpdate, !fullUpdate);
							if (updatedTimeProperty) {
								recordUpdate[updatedTimeProperty.name] =
									updatedTimeProperty.type === 'Date'
										? new Date(txnTime)
										: updatedTimeProperty.type === 'String'
											? new Date(txnTime).toISOString()
											: txnTime;
							}
							if (createdTimeProperty) {
								if (entry?.value) {
									if (fullUpdate || recordUpdate[createdTimeProperty.name]) {
										// make sure to retain original created time
										recordUpdate[createdTimeProperty.name] = entry?.value[createdTimeProperty.name];
									}
								} else {
									// new entry, set created time
									recordUpdate[createdTimeProperty.name] =
										createdTimeProperty.type === 'Date'
											? new Date(txnTime)
											: createdTimeProperty.type === 'String'
												? new Date(txnTime).toISOString()
												: txnTime;
								}
							}
							if (primaryKey && recordUpdate[primaryKey] !== id && (fullUpdate || primaryKey in recordUpdate)) {
								// ensure that the primary key is correct, if there is supposed to be one
								recordUpdate[primaryKey] = id;
							}
							if (fullUpdate) {
								recordUpdate = updateAndFreeze(recordUpdate); // this flatten and freeze the record
							}
							// TODO: else freeze after we have applied the changes
						}
					} else {
						(transaction as any).removeWrite?.(write);
						return false;
					}
				},
				before: writeToSource(),
				commit: (txnTime: number, existingEntry: Entry, retry: boolean, transaction: any) => {
					write.skipped = false; // reset on each retry; cleanup happens after commit if still true
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
					let incrementalUpdateToApply: boolean;

					this.#savingOperation = null;
					let omitLocalRecord = false;
					// we use optimistic locking to only commit if the existing record state still holds true.
					// this is superior to using an async transaction since it doesn't require JS execution
					//  during the write transaction.
					let precedesExisting = precedesExistingVersion(txnTime, existingEntry, options?.nodeId);
					let auditRecordToStore: any; // what to store in the audit record. For a full update, this can be left undefined in which case it is the same as full record update and optimized to use a binary copy
					const type = fullUpdate ? 'put' : 'patch';
					let residencyId: number | undefined;
					if (options?.residencyId != undefined) residencyId = options.residencyId;
					const expiresAt: number =
						options?.expiresAt ?? context?.expiresAt ?? (expirationMs ? expirationMs + Date.now() : -1);
					const additionalAuditRefs: Array<{ version: number; nodeId: number }> = []; // track additional audit refs to store

					if (precedesExisting <= 0) {
						// This block is to handle the case of saving an update where the transaction timestamp is older than the
						// existing timestamp, which means that we received updates out of order, and must resequence the application
						// of the updates to the record to ensure consistency across the cluster
						// TODO: can the previous version be older, but even more previous version be newer?
						if (audit) {
							// A re-delivered out-of-order write (full-copy audit-replay re-delivers writes) must not have
							// its commutative ops re-folded. additionalAuditRefs is the record's own list of folded
							// out-of-order versions, read with read-your-writes consistency, so this skips the duplicate up
							// front — before the audit-log walk below, which can miss it: the walk stops at the depth cap, or
							// breaks early on a not-yet-visible audit entry, before reaching txnTime, and the keyed
							// transaction-log lookup it would otherwise use can lag a back-to-back re-delivery (that lag
							// silently double-applied the increment — #1137). This covers the re-delivery while the ref is
							// still on the record; a later in-order write rewrites the record and drops the ref (it survives
							// only as previousAdditionalAuditRefs on the audit log), so that case falls back to the
							// best-effort keyed lookup in the capped block below — see #1148. precedesExistingVersion(...)
							// === 0 is the identity tie: same version AND same node (the local node is id 0, so an undefined
							// options?.nodeId resolves to the same 0 the ref stored).
							if (
								existingEntry.additionalAuditRefs?.some(
									(ref) =>
										ref.version === txnTime &&
										precedesExistingVersion(
											txnTime,
											{ version: txnTime, localTime: txnTime, key: id, nodeId: ref.nodeId },
											options?.nodeId
										) === 0
								)
							) {
								write.skipped = true;
								return; // out-of-order write already folded into this record
							}
							// Up-front keyed dedup (RocksDB): a re-delivered out-of-order write whose exact
							// (version, nodeId) is already in the audit log is a duplicate that was already applied — skip
							// it here instead of paying the O(depth) resequencing walk below only to discard it in the
							// depth-cap block. This is the same keyed lookup that block performs, hoisted ahead of the walk.
							// It is what catches transitive/proxied re-deliveries: they arrive buried below the record head
							// (so replication's head-tie fast-skip can't see them) yet are exact duplicates. Keyed by nodeId,
							// so it is correct across multiple source nodes. RocksDB-only: LMDB audit entries are keyed by
							// local audit time, not version, so this version-keyed lookup doesn't apply there (LMDB keeps the
							// exact unbounded walk). A miss (the keyed lookup can lag a back-to-back re-delivery — #1137)
							// simply falls through to the walk, so this never changes correctness; the additionalAuditRefs
							// check above remains the read-your-writes guard.
							if (isRocksDB) {
								const priorAudit = auditStore.get(txnTime, tableId, id, options?.nodeId);
								if (
									priorAudit &&
									priorAudit.version === txnTime &&
									precedesExistingVersion(
										txnTime,
										{ version: txnTime, localTime: txnTime, key: id, nodeId: priorAudit.nodeId },
										options?.nodeId
									) === 0
								) {
									write.skipped = true;
									return; // duplicate already applied; avoid the resequencing walk
								}
							}
							// incremental CRDT updates are only available with audit logging on
							let localTime = existingEntry.localTime;
							let auditedVersion = existingEntry.version;
							logger.debug?.(
								'Applying CRDT update to record with id: ',
								id,
								'txn time',
								new Date(txnTime),
								'applying later update from:',
								new Date(auditedVersion),
								'local recorded time',
								new Date(localTime)
							);

							let nodeId = existingEntry.nodeId;
							const succeedingUpdates = []; // record the "future" updates, as we need to apply the updates in reverse order
							const auditRefsToVisit: Array<{ localTime: number; nodeId: number }> = existingEntry.additionalAuditRefs
								? existingEntry.additionalAuditRefs.map((ref) => ({ localTime: ref.version, nodeId: ref.nodeId }))
								: [];

							// Collect any existing audit refs that should be preserved (those older than current transaction)
							if (existingEntry.additionalAuditRefs) {
								for (const ref of existingEntry.additionalAuditRefs) {
									if (ref.version <= txnTime) {
										additionalAuditRefs.push(ref);
									}
								}
							}
							let addedAuditRef = false;
							let nextRef: { localTime: number; nodeId: number };
							let walkSteps = 0;
							let auditWalkCapped = false;
							// Early-out residual: as we walk the chain newest-first, fold each succeeding patch into a
							// throwaway copy of this write purely to detect when every field has been overwritten by
							// newer writes. When it empties — and there is no alternate audit branch — the write is
							// fully superseded and the rest of the O(depth) walk can be skipped; this is equivalent to
							// walking to the end and taking the `writeCommit(false)` escape after the fold below
							// (#1114/#1316). It is NOT used as the applied value: the sorted fold still computes that for
							// the non-empty (legit merge) case, so merge correctness is unchanged.
							let earlyOutResidual: any;
							let fullySuperseded = false;
							// A re-delivered write whose exact (version, nodeId) is already in the audit log was already
							// applied; drop it rather than re-applying it (double-applying commutative ops) or writing a
							// duplicate audit-only record. Used by the early-out and the depth-cap block below.
							const isReDeliveredDuplicate = () => {
								const duplicate = auditStore.get(txnTime, tableId, id, options?.nodeId);
								return (
									duplicate &&
									duplicate.version === txnTime &&
									precedesExistingVersion(
										txnTime,
										{ version: txnTime, localTime: txnTime, key: id, nodeId: duplicate.nodeId },
										options?.nodeId
									) === 0
								);
							};
							do {
								while (localTime > txnTime || (auditedVersion >= txnTime && localTime > 0)) {
									// Bound the walk only for RocksDB, where the OOM was observed (issue #1114): each step
									// is a transaction-log range scan + msgpackr decode, and the per-node logs can be huge.
									// LMDB audit entries are keyed by local audit time (not version), so the duplicate
									// shortcut below would not apply — keep its exact, unbounded reconciliation.
									if (isRocksDB && ++walkSteps > MAX_OUT_OF_ORDER_AUDIT_DEPTH) {
										auditWalkCapped = true;
										break;
									}
									const auditRecord = auditStore.get(localTime, tableId, id, nodeId);
									if (!auditRecord) break;
									auditedVersion = auditRecord.version;
									if (auditedVersion >= txnTime) {
										if (auditedVersion === txnTime) {
											precedesExisting = precedesExistingVersion(
												txnTime,
												{ version: auditedVersion, localTime: localTime, key: id, nodeId: auditRecord.nodeId },
												options?.nodeId
											);
											if (precedesExisting === 0) {
												logger.debug?.(
													'The transaction time is equal to the existing version, treating as duplicate',
													id
												);
												write.skipped = true;
												return; // treat a tie as a duplicate and drop it
											}
											if (precedesExisting > 0) {
												// if the existing version is older, we can skip this update
												localTime = auditRecord.previousVersion;
												nodeId = auditRecord.previousNodeId;
												continue;
											}
										}
										if (auditRecord.type === 'patch') {
											logger.debug?.('out of order patch will be applied', id, auditRecord);
											// Materialize the patch value now and keep only { version, value } rather than the
											// audit record itself, so its backing transaction-log buffer and decoders can be
											// reclaimed immediately. Only these two fields are needed for the ordered fold below;
											// retaining the full records is what pins the heap on a deep chain (issue #1114).
											const newerPatch = auditRecord.getValue(primaryStore);
											succeedingUpdates.push({ version: auditedVersion, value: newerPatch });
											auditRecordToStore = recordUpdate; // use the original update for the audit record
											// rebuildUpdateBefore only ever DROPS plain fields the newer patch overwrites and
											// KEEPS commutative ops (and, for a full update, every field) — so whether the residual
											// empties is order-independent, and a commutative op never triggers the early-out.
											// Supersession is monotonic, so once empty stop folding (an unscanned branch may still
											// be deferring the early-out below). RocksDB only — see the early-out below. Guard on
											// newerPatch: a corrupt/undecodable audit value can be undefined, and folding it would
											// throw in rebuildUpdateBefore's `in` check; it supersedes nothing, so skip it (the
											// pre-existing fold below already tolerates this case by returning earlier).
											if (isRocksDB && !fullySuperseded && newerPatch) {
												earlyOutResidual = rebuildUpdateBefore(
													earlyOutResidual ?? recordUpdate,
													newerPatch,
													fullUpdate
												);
												if (!earlyOutResidual) fullySuperseded = true;
											}
										} else if (auditRecord.type === 'put' || auditRecord.type === 'delete') {
											// There is newer full record update, so this incremental update is completely superseded
											write.skipped = true;
											return;
										}
									}
									if (!addedAuditRef && isRocksDB) {
										addedAuditRef = true;
										// Add a reference to this older audit record if we had out-of-order writes
										additionalAuditRefs.push({ version: txnTime, nodeId: options?.nodeId });
										logger.debug?.('Adding additional audit ref for out-of-order write', {
											version: txnTime,
											nodeId: options?.nodeId,
										});
									}
									// Collect any additional audit refs from this audit record to traverse other branches
									if (auditRecord.previousAdditionalAuditRefs) {
										for (const ref of auditRecord.previousAdditionalAuditRefs) {
											auditRefsToVisit.push({ localTime: ref.version, nodeId: ref.nodeId });
											logger.debug?.('Adding audit ref from audit record to visit queue', {
												version: ref.version,
												nodeId: ref.nodeId,
											});
										}
									}

									// Every field of this write is overwritten by newer writes, and there is no alternate
									// audit branch left to scan, so it is fully superseded — the same outcome as walking to
									// the end and taking the `writeCommit(false)` escape below, reached without paying the rest
									// of the deep walk (#1114/#1316). additionalAuditRefs is already final here (the out-of-order
									// ref is pushed once, above), so the audit record written is identical. RocksDB only: LMDB has
									// no up-front keyed dedup, so it must keep walking until inline duplicate detection reaches the
									// matching entry. A re-delivered duplicate is dropped via the keyed lookup (as the depth-cap
									// block does) rather than written as a duplicate audit-only record; a genuine first delivery
									// writes the audit record. (A newer full put/delete on this single chain is caught above before
									// the residual could empty, so it cannot be reached here.)
									if (isRocksDB && fullySuperseded && auditRefsToVisit.length === 0) {
										if (isReDeliveredDuplicate()) {
											write.skipped = true;
											return; // re-delivered duplicate already applied
										}
										return writeCommit(false);
									}

									localTime = auditRecord.previousVersion;
									nodeId = auditRecord.previousNodeId;
								}
								// Check if we need to scan additional audit refs from this record
								if (auditWalkCapped) break;
								nextRef = auditRefsToVisit.shift();
								if (nextRef) {
									localTime = auditedVersion = nextRef.localTime;
									nodeId = nextRef.nodeId;
									logger.debug?.('Following additional audit ref to continue scanning', { localTime, nodeId });
								}
							} while (nextRef);
							if (!localTime && !auditWalkCapped) {
								// if we reached the end of the audit trail, we can just apply the update
								logger.debug?.(
									'No further audit history, applying incremental updates based on available history',
									id,
									'existing version preserved',
									existingEntry
								);
							}
							if (auditWalkCapped) {
								// The out-of-order audit chain exceeded MAX_OUT_OF_ORDER_AUDIT_DEPTH (a pathologically deep
								// history, seen during a replication full-copy of a large-history database — issue #1114).
								// Walking and buffering the whole chain per record OOMs the worker, so we stopped at the cap
								// and reconcile against only the most recent MAX_OUT_OF_ORDER_AUDIT_DEPTH updates (the fold
								// below). That is an approximation for histories deeper than the cap — updates older than the
								// retained window are not layered in — but the authoritative full-copy record restores exact
								// convergence. Because we stopped before reaching txnTime, the inline duplicate detection in
								// the walk never ran; full-copy audit-replay re-delivers writes, and re-applying one would
								// double-apply its commutative ops. A re-delivered out-of-order write is already ruled out by
								// the additionalAuditRefs check at the top of this block; this keyed lookup is the best-effort
								// guard for the remaining case — a re-delivered write that was originally in-order (so it left
								// no ref) and is now deeper than the cap. It is best-effort because the transaction-log lookup
								// can intermittently miss an entry under load (tracked separately); the authoritative full-copy
								// record still restores exact convergence.
								logger.warn?.(
									'Out-of-order audit reconciliation exceeded depth cap; reconciling against most recent updates only',
									{
										table: tableName,
										id,
										depth: walkSteps,
									}
								);
								if (isReDeliveredDuplicate()) {
									write.skipped = true;
									return; // duplicate write already applied
								}
							}
							// Fold the retained succeeding updates (the full chain, or — when capped — the most recent
							// window) onto this older write so newer fields win; for a capped walk this layers in only
							// what we collected before the cap.
							succeedingUpdates.sort((a, b) => a.version - b.version); // order the patches
							for (const { version: patchVersion, value: newerUpdate } of succeedingUpdates) {
								logger.debug?.('Rebuilding update with future patch:', new Date(patchVersion), newerUpdate);
								incrementalUpdateToApply = rebuildUpdateBefore(
									incrementalUpdateToApply ?? recordUpdate,
									newerUpdate,
									fullUpdate
								);
								if (!incrementalUpdateToApply) return writeCommit(false); // if all changes are overwritten, nothing left to do
							}
							if (fullUpdate && !incrementalUpdateToApply && precedesExisting < 0) {
								// Out-of-order full update whose audit walk found no succeeding updates to
								// resequence around: the existing record is strictly newer (precedesExisting < 0),
								// so this older full update is superseded. Falling through to the shared commit
								// below would set recordToStore = recordUpdate and revert the newer record. Bare
								// return (no writeCommit) matches the superseded-by-newer-put branch above so no
								// audit record is written referencing this losing update's pre-saved blobs.
								// Gated on precedesExisting < 0 (not <= 0) so a same-transaction put-after-delete —
								// which arrives as a tie (precedesExisting === 0) with no committed audit yet —
								// still falls through and applies. (harperdb/harper#1170)
								write.skipped = true;
								return;
							}
						} else if (fullUpdate) {
							// if no audit, we can't accurately do incremental updates, so we just assume the last update
							// was the same type. Assuming a full update this record update loses and there are no changes —
							// without audit no record references the pre-saved blobs, so they have to be cleaned up.
							write.skipped = true;
							return writeCommit(false);
						} else {
							// no audit, assume updates are overwritten except CRDT operations or properties that didn't exist
							incrementalUpdateToApply = rebuildUpdateBefore(
								incrementalUpdateToApply ?? recordUpdate,
								existingRecord,
								fullUpdate
							);
							logger.debug?.('Rebuilding update without audit:', incrementalUpdateToApply);
						}
						logger.trace?.('Rebuilt record to save:', incrementalUpdateToApply, ' is full update:', fullUpdate);
					}
					let recordToStore: any;
					if (fullUpdate && !incrementalUpdateToApply) recordToStore = recordUpdate;
					else {
						if ((this.constructor as any).loadAsInstance === false)
							recordToStore = updateAndFreeze(existingRecord, incrementalUpdateToApply ?? recordUpdate);
						else {
							this.#record = existingRecord;
							recordToStore = updateAndFreeze(this, incrementalUpdateToApply ?? recordUpdate);
						}
					}
					this.#record = recordToStore;
					if (recordToStore && recordToStore.getRecord)
						throw new Error('Can not assign a record to a record, check for circular references');
					if (residencyId == undefined) {
						if (entry?.residencyId)
							(context as any).previousResidency = TableResource.getResidencyRecord(entry.residencyId);
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
									if (createdTimeProperty && auditRecordToStore[createdTimeProperty.name] != null) {
										// preserve the created timestamp in the partial record so it isn't lost when we don't have residency
										if (!recordToStore) recordToStore = {};
										recordToStore[createdTimeProperty.name] = auditRecordToStore[createdTimeProperty.name];
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
					logger.trace?.(
						`Saving record with id: ${id}, timestamp: ${new Date(txnTime).toISOString()}${
							expiresAt > 0 ? ', expires at: ' + new Date(expiresAt).toISOString() : ''
						}${
							existingEntry?.version
								? ', replaces entry from: ' + new Date(existingEntry.version).toISOString()
								: ', new entry'
						}`,
						(() => {
							try {
								return JSON.stringify(recordToStore).slice(0, 100);
							} catch {
								return '';
							}
						})()
					);
					updateIndices(id, existingRecord, recordToStore, transaction && { transaction });

					writeCommit(true);
					if (expiresAt >= 0) {
						scheduleCleanup(); // arm for replicated writes too, not just local-context writes
						// A runtime per-record expiresAt on a table with no table-level expiration/eviction, no expiresAt
						// attribute, and no source has no setup-time arming of the cleanup scan: the scan is only armed
						// best-effort from this write path, on whichever worker happened to handle the write, and is not
						// re-armed after a restart with no further writes. Warn once per table so the misconfiguration is
						// visible and the operator can configure reliable, setup-armed eviction. See issue #1339.
						// Evaluate at most once per table (on the first expiring write); later writes short-circuit on one check.
						if (!expirationWarningChecked) {
							expirationWarningChecked = true;
							if (!expirationMs && !evictionMs && !expirationScanScheduled && !expiresAtProperty && !hasSourceGet) {
								logger.warn?.(
									`A per-record expiresAt was set on table "${tableName}" which has no table-level expiration/eviction, no expiresAt attribute, and no source; expiration will not be reliably enforced (the eviction scan is only armed best-effort on write and does not survive a restart with no writes). Configure a table-level expiration/eviction or an indexed expiresAt attribute for reliable eviction.`
								);
							}
						}
					}
					function writeCommit(storeRecord: boolean) {
						// we need to write the commit. if storeRecord then we need to store the record, otherwise we just need to store the audit record
						updateRecord(
							id,
							storeRecord ? recordToStore : undefined,
							storeRecord ? existingEntry : { ...existingEntry, value: undefined },
							isRocksDB
								? Math.max(txnTime, existingEntry?.version ?? 0) // RocksDB uses a singular version/local time, so it must be most recent
								: txnTime,
							omitLocalRecord ? INVALIDATED : 0,
							audit,
							{
								omitLocalRecord,
								user: (context as any)?.user,
								residencyId,
								expiresAt,
								nodeId: options?.nodeId,
								viaNodeId: options?.viaNodeId,
								originatingOperation: (context as any)?.originatingOperation,
								transaction,
								tableToTrack: databaseName === 'system' ? null : options?.replay ? null : tableName, // don't track analytics on system tables
								additionalAuditRefs: additionalAuditRefs.length > 0 ? additionalAuditRefs : undefined,
								// local-only marks the record so the replication send path skips it (see LOCAL_ONLY)
								localOnly: options?.localOnly,
							},
							type,
							false,
							storeRecord ? auditRecordToStore : (auditRecordToStore ?? recordUpdate)
						);
					}
				},
			};
			this.#savingOperation = write;
			// `@embed` hook must run before `addWrite` so the embedder's vector is on the
			// record when `commit` runs. (The txn `before` slot runs after commit, which
			// suits blob writes but not embedding, where the vector must be present at commit.)
			// Known limitation of this write-time placement (a validate-time alternative was
			// tried and reverted as a Harper-foreign pattern): the embedder sees this write's
			// payload, before table validation — so a write that later fails validation still
			// calls the backend, and a tracked-instance mutation (update(id,{}); row.source=…;
			// save()) that sets the source via accessors after update() won't re-embed. A
			// resource-layer re-embed is the proper fix; tracked as a follow-up.
			const embedBefore = buildEmbedBefore(
				recordUpdate,
				context,
				options,
				TableResource.embedAttributes,
				TableResource.userEmbedders
			);
			const proceed = (): any => {
				// On a source/replication apply (`isNotification`), the record's already-saved blobs were
				// received out-of-band for THIS write, so track them for skip/abort cleanup (harper-pro#406).
				write.beforeIntermediate = preCommitBlobsForRecordBefore(
					write,
					recordUpdate,
					undefined,
					undefined,
					options?.isNotification
				);
				return transaction.addWrite(write as any);
			};
			return embedBefore ? embedBefore().then(proceed) : proceed();
		}

		async delete(target: RequestTargetOrId): Promise<boolean> {
			if (isSearchTarget(target)) {
				target.select = ['$id']; // just get the primary key of each record so we can delete them
				for await (const entry of this.search(target)) {
					this._writeDelete((entry as any).$id);
				}
				return true;
			}
			if (target) {
				let allowed = true;
				const context = this.getContext();
				if ((target as any)?.checkPermission) {
					// requesting authorization verification
					allowed = this.allowDelete((context as any).user, target as any, context);
				}
				return when(allowed, (allowed: boolean) => {
					if (!allowed) {
						throw new AccessViolation((context as any).user);
					}
					const id = requestTargetToId(target as any);
					this._writeDelete(id);
					return true;
				}) as any;
			}
			this._writeDelete(this.getId());
			return Boolean(this.#record);
		}
		_writeDelete(id: Id, options?: any) {
			const context = this.getContext();
			const transaction = txnForContext(context);
			checkValidId(id);
			const entry = this.#entry ?? primaryStore.getEntry(id, { transaction: transaction.getReadTxn() });

			transaction.addWrite({
				key: id,
				store: primaryStore,
				entry,
				nodeName: (context as any)?.nodeName,
				before:
					(this.constructor as any).source?.delete && !(context as any)?.source
						? (this.constructor as any).source.delete.bind((this.constructor as any).source, id, undefined, context)
						: undefined,
				commit: (txnTime, existingEntry, retry, transaction: any) => {
					const existingRecord = existingEntry?.value;
					if (retry) {
						if (context && existingEntry?.version > (context.lastModified || 0))
							context.lastModified = existingEntry.version;
						TableResource._updateResource(this, existingEntry);
					}
					if (precedesExistingVersion(txnTime, existingEntry, options?.nodeId) < 0) {
						return;
					} // a newer record exists locally
					updateIndices(id, existingRecord, null, transaction && { transaction });
					if (audit || trackDeletes) {
						updateRecord(
							id,
							null,
							existingEntry,
							txnTime,
							0,
							audit,
							{
								user: (context as any)?.user,
								nodeId: options?.nodeId,
								viaNodeId: options?.viaNodeId,
								transaction,
								tableToTrack: tableName,
							},
							'delete'
						);
						if (!audit || isRocksDB) scheduleCleanup();
					} else {
						removeEntry(primaryStore, existingEntry);
					}
				},
			} as any);
			return true;
		}

		// #section: search-query
		search(target: RequestTarget): AsyncIterable<Record & Partial<RecordObject>> {
			const context = this.getContext();
			const txn = txnForContext(context);
			if (!target) throw new Error('No query provided');
			if (target.parseError) throw target.parseError; // if there was a parse error, we can throw it now
			if (target.checkPermission) {
				// requesting authorization verification
				const allowed = this.allowRead((context as any).user, target, context);
				if (!allowed) {
					throw new AccessViolation((context as any).user);
				}
			}
			if (context) context.lastModified = UNCACHEABLE_TIMESTAMP;

			let conditions: any = target.conditions;
			if (!conditions) conditions = Array.isArray(target) ? target : target[Symbol.iterator] ? Array.from(target) : [];
			else if (conditions.length === undefined) {
				conditions = conditions[Symbol.iterator] ? Array.from(conditions) : [conditions];
			}
			const id = target.id ?? this.getId();
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

			function prepareConditions(conditions: any[], operator: string) {
				// some validation:
				switch (operator) {
					case 'and':
					case undefined:
						if (conditions.length < 1) throw new Error('An "and" operator requires at least one condition');
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
					// Normalize `not_X` comparator forms passed in via structured queries.
					// The REST parser already does this, but programmatic callers may
					// pass `not_in`, `not_starts_with`, etc. directly.
					if (condition.comparator) {
						const resolved = resolveComparator(condition.comparator);
						if (resolved.negated) {
							condition.comparator = resolved.comparator;
							condition.negated = true;
						}
					}
					const attribute_name = condition[0] ?? condition.attribute;
					let attribute = attribute_name == null ? primaryKeyAttribute : findAttribute(attributes, attribute_name);
					if (!attribute && Array.isArray(attribute_name) && attribute_name.length > 1) {
						// Plain JSON nested path: the leaf may not be declared in the
						// schema. Fall back to the root attribute so we can validate
						// existence without requiring the inner structure to be typed.
						attribute = findAttribute(attributes, attribute_name[0]);
					}
					if (!attribute) {
						if (attribute_name != null && !target.allowConditionsOnDynamicAttributes)
							throw handleHDBError(new Error(), `${attribute_name} is not a defined attribute`, 404);
					} else if (attribute.type || COERCIBLE_OPERATORS[condition.comparator]) {
						// Do auto-coercion or coercion as required by the attribute type.
						// Skipped for nested paths into plain JSON — the root attribute's
						// type is not the leaf type, so coercion would be wrong.
						const isNestedPathRoot =
							Array.isArray(attribute_name) && attribute_name.length > 1 && !attribute.relationship;
						if (!isNestedPathRoot) {
							if (condition[1] === undefined) condition.value = coerceTypedValues(condition.value, attribute);
							else condition[1] = coerceTypedValues(condition[1], attribute);
						}
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
							condition.comparator = ((isGe ? 'ge' : 'gt') + (isLe ? 'le' : 'lt')) as any;
							condition.value = [lower.value, upper.value];
						} else throw new Error('Multiple chained conditions are not currently supported');
					}
				}
				return conditions;
			}
			function orderConditions(conditions: Condition[], operator: string) {
				if (target.enforceExecutionOrder) return conditions; // don't rearrange conditions
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
			const operator = target.operator;
			if (conditions.length > 0 || operator) conditions = prepareConditions(conditions, operator);
			const sort = typeof target.sort === 'object' && target.sort;
			let postOrdering;
			if (sort) {
				// TODO: Support index-assisted sorts of unions, which will require potentially recursively adding/modifying an order aligned condition and be able to recursively undo it if necessary
				if ((operator as any) !== 'or') {
					const attribute_name = sort.attribute;
					if (attribute_name == undefined) throw new ClientError('Sort requires an attribute');
					orderAlignedCondition = conditions.find(
						(condition) => flattenKey(condition.attribute as any) === flattenKey(attribute_name as any)
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
									Array.isArray(attribute_name) ? (attribute_name as any).join('.') : attribute_name
								} is not a defined attribute`,
								404
							);
						if (attribute.indexed) {
							// if it is indexed, we add a pseudo-condition to align with the natural sort order of the index
							orderAlignedCondition = { ...sort, comparator: 'sort' };
							conditions.push(orderAlignedCondition);
						} else if (conditions.length === 0 && !target.allowFullScan)
							throw handleHDBError(
								new Error(),
								`${
									Array.isArray(attribute_name) ? (attribute_name as any).join('.') : attribute_name
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
			const select = target.select;
			if (conditions.length === 0) {
				conditions = [{ attribute: primaryKey, comparator: 'greater_than', value: true }];
			}
			if (target.explain) {
				return {
					conditions,
					operator,
					postOrdering,
					selectApplied: Boolean(select),
				} as any;
			}
			// we mark the read transaction as in use (necessary for a stable read
			// transaction, and we really don't care if the
			// counts are done in the same read transaction because they are just estimates) until the search
			// results have been iterated and finished.
			const readTxn = txn.useReadTxn();
			const entries = executeConditions(
				conditions,
				operator,
				TableResource,
				readTxn,
				target,
				context,
				(results: any[], filters: Function[]) => transformToEntries(results, select, context, readTxn, filters),
				filtered
			);
			const ensure_loaded = (target as any).ensureLoaded !== false;
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
				context,
				readTxn,
				transformToRecord
			);
			// apply any offset/limit after all the sorting and filtering
			if (target.offset || target.limit !== undefined)
				results = results.slice(
					target.offset,
					target.limit !== undefined ? (target.offset || 0) + target.limit : undefined
				);
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
						else columns.push((column as any).name || column);
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
			let results = new ExtendedIterable();
			if (sort) {
				// there might be some situations where we don't need to transform to entries for sorting, not sure
				entries = transformToEntries(entries, select, context, readTxn, null);
				let ordered;
				// if we are doing post-ordering, we need to get records first, then sort them
				results.iterate = function (options: { async: boolean }) {
					let sortedArrayIterator: IterableIterator<any>;
					const dbIterator =
						options?.async && entries[Symbol.asyncIterator]
							? entries[Symbol.asyncIterator]()
							: entries[Symbol.iterator]();
					let dbDone: boolean;
					const dbOrderedAttribute = (sort as any).dbOrderedAttribute;
					let enqueuedEntryForNextGroup: any;
					let lastGroupingValue: any;
					let firstEntry = true;
					function createComparator(order: Sort) {
						const nextComparator = order.next && createComparator(order.next);
						const descending = order.descending;
						(context as any).sort = order; // make sure this is set to the current sort order
						return (entryA, entryB) => {
							const a = getAttributeValue(entryA, order.attribute, context);
							const b = getAttributeValue(entryB, order.attribute, context);
							const diff = descending
								? compareKeys(convertToComparableKeys(b), convertToComparableKeys(a))
								: compareKeys(convertToComparableKeys(a), convertToComparableKeys(b));
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
							if ((sort as any).isGrouped) {
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
							return dbIterator.return();
						},
						throw() {
							if (results.onDone) results.onDone();
							return dbIterator.throw();
						},
					};
				};
				const applySortingOnSelect = (sort) => {
					if (typeof select === 'object' && Array.isArray(sort.attribute)) {
						for (let i = 0; i < select.length; i++) {
							const column = select[i];
							let columnSort;
							if ((column as any).name === sort.attribute[0]) {
								columnSort = (column as any).sort || ((column as any).sort = {});
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
								} as any;
							}
						}
					}
					if (sort.next) applySortingOnSelect(sort.next);
				};
				applySortingOnSelect(sort);
			} else {
				results.iterate = (options: { async: boolean }) => {
					if (options?.async && entries[Symbol.asyncIterator]) return entries[Symbol.asyncIterator]();
					else return entries[Symbol.iterator]();
				};
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
			const source = this.source;
			// Transform an entry to a record. Note that *this* instance is intended to be the iterator.
			const transform = function (entry: Entry) {
				let record;
				if (context?.transaction?.stale) context.transaction.stale = false;
				if (entry != undefined) {
					record = entry.deref ? entry.deref() : entry.value;
					if (entry.metadataFlags & INVALIDATED && context.replicateFrom === false && canSkip && entry.residencyId) {
						return SKIP;
					}
					if (!record && (entry.key === undefined || entry.deref)) {
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
						if ((entry as any)?.then) return (entry as any).then(transform.bind(this));
						record = entry?.value;
					}
					if (
						(checkLoaded && entry?.metadataFlags & (INVALIDATED | EVICTED)) || // invalidated or evicted should go to load from source
						(entry?.expiresAt != undefined && entry?.expiresAt < Date.now())
					) {
						// should expiration really apply?
						if (context.onlyIfCached) {
							return {
								[primaryKey]: entry.key,
								message: 'This entry has expired',
							};
						}
						const loadingFromSource = ensureLoadedFromSource(source, entry.key ?? entry, entry, context);
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
								value = resolver(record, context, entry, true);
							}
							const handleResolvedValue = (value: any) => {
								if (resolver.directReturn) return callback(value, attribute_name);
								if (value && typeof value === 'object') {
									const targetTable = resolver.definition?.tableClass || TableResource;
									if (!transformCache) transformCache = {};
									// Use the target table's own read transaction; each table's readTxn is
									// scoped to its RocksDB column family and cannot read another table's store.
									const targetReadTxn =
										targetTable === TableResource ? readTxn : targetTable._readTxnForContext(context);
									const transform =
										transformCache[attribute_name] ||
										(transformCache[attribute_name] = targetTable.transformEntryForSelect(
											// if it is a simple string, there is no select for the next level,
											// otherwise pass along the nested selected
											attribute_name === attribute
												? null
												: attribute.select || (Array.isArray(attribute) ? attribute : null),
											context,
											targetReadTxn,
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
												targetReadTxn,
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
								const subTransform = TableResource.transformEntryForSelect(
									attribute.select || attribute,
									context,
									readTxn,
									null
								);
								// Plain JSON nested values: arrays project per-element so that
								// `select: [{ name: 'addresses', select: ['city'] }]` returns
								// `addresses: [{ city }, { city }]` rather than a single object.
								if (Array.isArray(value)) {
									value = value.map((item) =>
										item && typeof item === 'object' ? subTransform({ value: item } as any) : item
									);
								} else if (!(value instanceof Date)) {
									value = subTransform({ value } as any);
								}
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
						if ((select as any).asArray) {
							selected = [];
							select.forEach((attribute, index) => {
								if (attribute === '*') select[index] = record;
								else selectAttribute(attribute, (value) => (selected[index] = value));
							});
						} else {
							selected = {};
							const forceNulls = (select as any).forceNulls;
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

		// #section: pub-sub
		async subscribe(request: SubscriptionRequest): Promise<AsyncIterable<Record>> {
			if (!auditStore) throw new Error('Can not subscribe to a table without an audit log');
			if (!audit) {
				table({ table: tableName, database: databaseName, schemaDefined, attributes, audit: true });
			}
			if (!request) request = {} as any;
			const getFullRecord = !request.rawEvents;
			// While the count, !omitCurrent, and non-collection branches replay older messages, real-time
			// messages from the listener accumulate here and are drained at the end of the IIFE so they
			// arrive after the replayed history, in order. The startTime branch sets this to null and
			// uses dropDuringReplay instead — its snapshot:false cursor picks up the live tail directly.
			let pendingRealTimeQueue: any[] | null = [];
			// Set during the startTime audit-log replay. The cursor iterates the audit log forward with
			// snapshot:false, which catches any commits that land during yield points; dropping in the
			// listener avoids duplicate delivery.
			let dropDuringReplay = false;
			const thisId = requestTargetToId(request) ?? null; // treat undefined and null as the root
			const subscription = addSubscription(
				TableResource,
				thisId,
				function (id: Id, auditRecord?: any, localTime?: any, beginTxn?: any) {
					if (dropDuringReplay) return;
					try {
						let type = auditRecord.type;
						let value;
						if (type === 'message' || request.rawEvents) {
							// we only send the full message, this are individual messages that can be sent out of order
							// TODO: Do we want to have a limit to how far out-of-order we are willing to send?
							value = auditRecord.getValue?.(primaryStore, getFullRecord);
						} else if (type !== 'end_txn') {
							// these are events that indicate that the primary record has changed. I believe we always want to simply
							// send the latest value. Note that it is fine to synchronously access these records, they should have just
							// been written, so are fresh in memory.
							const entry: Entry = primaryStore.getEntry(id);
							if (entry) {
								if (entry.version !== auditRecord.version) return; // out of order event, with old update, don't send anything
								value = entry.value;
								type = entry.metadataFlags & INVALIDATED ? 'invalidate' : value ? 'put' : 'delete';
							} else {
								type = 'delete';
							}
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
						else {
							if (databaseName !== 'system') {
								recordAction(auditRecord.size ?? 1, 'db-message', tableName, null);
							}
							this.send(event);
						}
					} catch (error) {
						logger.error?.(error);
					}
				},
				request.startTime || 0,
				request
			);
			// Attach the request.listener BEFORE invoking the IIFE so that sync sends from the
			// IIFE's prologue go directly to the listener via emit('data') instead of accumulating
			// in subscription.queue. Without this, the IIFE can fill the queue past
			// EVENT_HIGH_WATER_MARK and hit waitForDrain before the consumer's listener exists.
			if (request.listener) subscription!.on('data', request.listener);
			const result = (async () => {
				const isCollection = request.isCollection ?? thisId == null;
				if (isCollection) {
					subscription.includeDescendants = true;
					if (request.onlyChildren) subscription.onlyChildren = true;
				}
				if (request.supportsTransactions) subscription.supportsTransactions = true;
				let count = request.previousCount;
				if (count > 1000) count = 1000; // don't allow too many, we have to hold these in memory
				let startTime = request.startTime;
				let recordsSinceYield = 0;

				if (isCollection) {
					// a collection should retrieve all descendant ids
					if (startTime) {
						if (count)
							throw new ClientError('startTime and previousCount can not be combined for a table level subscription');
						// start time specified, get the audit history for this time range. We drop real-time
						// messages during this loop because the snapshot:false cursor will pick them up itself.
						pendingRealTimeQueue = null;
						dropDuringReplay = true;

						try {
							for (const auditRecord of auditStore.getRange({
								start: startTime,
								exclusiveStart: true,
								snapshot: false, // no need for a snapshot, audits don't change
							})) {
								if (++recordsSinceYield >= REPLAY_YIELD_INTERVAL) {
									recordsSinceYield = 0;
									await rest();
								}
								if (auditRecord.tableId !== tableId) continue;
								const id = auditRecord.recordId;
								if (thisId == null || isDescendantId(thisId, id)) {
									const value = auditRecord.getValue(primaryStore, getFullRecord, auditRecord.localTime);
									send({
										id,
										localTime: auditRecord.localTime,
										value,
										version: auditRecord.version,
										type: auditRecord.type,
										size: auditRecord.size,
									});
									if (subscription.queue?.length > EVENT_HIGH_WATER_MARK) {
										// if we have too many messages, we need to pause and let the client catch up
										if ((await subscription.waitForDrain()) === false) return;
									}
								}
								subscription!.startTime = auditRecord.localTime ?? auditRecord.version; // update so we don't double send
							}
						} finally {
							// replay is done, we can start sending real-time messages again
							dropDuringReplay = false;
						}
					} else if (count) {
						const history = [];
						// we are collecting the history in reverse order to get the right count, then reversing to send
						for (const auditRecord of auditStore.getRange({ start: 'z', end: false, reverse: true })) {
							if (++recordsSinceYield >= REPLAY_YIELD_INTERVAL) {
								recordsSinceYield = 0;
								await rest();
							}
							try {
								if (auditRecord.tableId !== tableId) continue;
								const id = auditRecord.recordId;
								if (thisId == null || isDescendantId(thisId, id)) {
									const value = auditRecord.getValue(primaryStore, getFullRecord, auditRecord.localTime);
									history.push({
										id,
										localTime: auditRecord.localTime,
										value,
										version: auditRecord.version,
										type: auditRecord.type,
									});
									if (--count <= 0) break;
								}
							} catch (error) {
								logger.error?.('Error getting history entry', auditRecord.localTime, error);
							}
						}
						for (let i = history.length; i > 0; ) {
							send(history[--i]);
						}
						// Use the latest record cursor saw (history[0] = most recent due to reverse
						// iteration) as the gate. This is in the audit log's own time domain (works for
						// both lmdb's localTime and rocksdb's transaction-derived version) — a JS-side
						// `getNextMonotonicTime()` would not be comparable to rocksdb's native
						// transaction timestamps.
						const cursorMaxTime = history[0]?.localTime ?? history[0]?.version ?? 0;
						if (cursorMaxTime) subscription!.startTime = cursorMaxTime;
						// In-flight pre-subscribe 'committed' callbacks may have queued duplicates of
						// records the cursor saw while subscription.startTime was still 0. Filter them.
						if (pendingRealTimeQueue && cursorMaxTime) {
							pendingRealTimeQueue = pendingRealTimeQueue.filter(
								(event) => (event.localTime ?? event.version) > cursorMaxTime
							);
						}
					} else if (!request.omitCurrent) {
						// Track the latest record-time the cursor saw — including deletion tombstones
						// (entries with null value). Used after iteration to gate out any pre-subscribe
						// 'committed' callbacks that fired during cursor yields (e.g., late
						// notifications for deletes/updates done before subscribing). This is in the
						// audit log's time domain — works on both backends, where a JS-side
						// `getNextMonotonicTime()` would not be comparable to rocksdb's native
						// transaction timestamps.
						let cursorMaxTime = 0;
						// Retained-message semantics: subscriber may legitimately receive a record twice
						// if a post-subscribe write hits a key the cursor also visits. This is
						// idempotent for "current state then live updates" — both deliveries land at
						// the same final state. We don't dedupe.
						for (const { key: id, value, version, localTime, size } of primaryStore.getRange({
							start: thisId ?? false,
							end: thisId == null ? undefined : [thisId, MAXIMUM_KEY],
							versions: true,
							snapshot: false, // no need for a snapshot, just want the latest data
						})) {
							if (++recordsSinceYield >= REPLAY_YIELD_INTERVAL) {
								recordsSinceYield = 0;
								await rest();
							}
							// Update cursorMaxTime BEFORE the !value check so deletion tombstones
							// (which have null value but a real localTime/version) still raise the gate.
							const t = localTime ?? version;
							if (t > cursorMaxTime) cursorMaxTime = t;
							if (!value) continue;
							send({ id, localTime, value, version, type: 'put', size });
							if (subscription.queue?.length > EVENT_HIGH_WATER_MARK) {
								// if we have too many messages, we need to pause and let the client catch up
								if ((await subscription.waitForDrain()) === false) return;
							}
						}
						if (cursorMaxTime) subscription!.startTime = cursorMaxTime;
						// Filter the queue to drop in-flight pre-subscribe events the listener queued
						// while subscription.startTime was still 0. Anything strictly newer than what
						// the cursor saw is a real post-subscribe commit and is kept.
						if (pendingRealTimeQueue && cursorMaxTime) {
							pendingRealTimeQueue = pendingRealTimeQueue.filter(
								(event) => (event.localTime ?? event.version) > cursorMaxTime
							);
						}
					}
				} else {
					if (count && !startTime) startTime = 0;
					let entry = this.#entry;
					let localTime = entry?.localTime;
					if (!entry) {
						entry = primaryStore.getEntry(thisId);
						localTime = entry?.localTime;
					} else if (localTime === PENDING_LOCAL_TIME) {
						// we can't use the pending commit because it doesn't have the local audit time yet,
						// so try to retrieve the previous/committed record
						primaryStore.cache?.delete(thisId);
						entry = primaryStore.getEntry(thisId);
						logger.trace?.('re-retrieved record', localTime, this.#entry?.localTime);
						localTime = entry?.localTime;
					}
					logger.trace?.('Subscription from', startTime, 'from', thisId, localTime);
					if (startTime < localTime) {
						// start time specified, get the audit history for this record. Set startTime up
						// front so the listener gate skips any in-flight 'committed' for this version
						// during the yields below — otherwise that event would be queued and drained as a
						// duplicate of the entry send.
						subscription!.startTime = localTime ?? entry?.version;
						const history = [];
						let nextTime = localTime;
						let nodeId = entry?.nodeId;
						do {
							if (++recordsSinceYield >= REPLAY_YIELD_INTERVAL) {
								recordsSinceYield = 0;
								await rest();
							}
							const auditRecord = auditStore.getSync(nextTime, tableId, thisId, nodeId);
							if (auditRecord) {
								if (startTime < nextTime) {
									request.omitCurrent = true; // we are sending the current version from history, so don't double send
									const value = auditRecord.getValue(primaryStore, getFullRecord, nextTime);
									if (getFullRecord) auditRecord.type = 'put';
									history.push({
										id: thisId,
										value,
										localTime: nextTime,
										...auditRecord,
									});
								}
								nextTime = auditRecord.previousVersion;
								nodeId = auditRecord.previousNodeId;
							} else break;
							if (count) count--;
						} while (nextTime > startTime && count !== 0);
						for (let i = history.length; i > 0; ) {
							send(history[--i]);
						}
					}
					if (!request.omitCurrent && entry?.value) {
						// if retain and it exists, send the current value first
						send({
							id: thisId,
							...entry,
							type: 'put',
						});
					}
				}
				// now send any queued messages
				if (pendingRealTimeQueue) {
					for (const event of pendingRealTimeQueue) {
						send(event);
					}
					pendingRealTimeQueue = null;
				}
			})();
			result.catch((error) => {
				harperLogger.error?.('Error in real-time subscription:', error);
				subscription.send(error);
			});
			function send(event: any) {
				if (databaseName !== 'system') {
					recordAction(event.size ?? 1, 'db-message', tableName, null);
				}
				subscription.send(event);
			}
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
			return Boolean(this.#record || this.#savingOperation);
		}

		/**
		 * Publishing a message to a record adds an (observable) entry in the audit log, but does not change
		 * the record at all. This entries should be replicated and trigger subscription listeners.
		 * @param id
		 * @param message
		 * @param options
		 */
		publish(target: RequestTarget, message: Record, options?: any) {
			if (message === undefined || message instanceof URLSearchParams) {
				// legacy arg format, shift the args
				this._writePublish(this.getId(), target, message);
			} else {
				let allowed = true;
				const context = this.getContext();
				if ((target as any)?.checkPermission) {
					// requesting authorization verification
					allowed = this.allowDelete((context as any).user, target as any, context);
				}
				return when(allowed, (allowed: boolean) => {
					if (!allowed) {
						throw new AccessViolation((context as any).user);
					}
					const id = requestTargetToId(target);
					this._writePublish(id, message, options);
				});
			}
		}
		_writePublish(id: Id, message, options?: any) {
			const transaction = txnForContext(this.getContext());
			id ??= null;
			if (id !== null) checkValidId(id); // note that we allow the null id for publishing so that you can publish to the root topic
			const context = this.getContext();
			const write: any = {
				key: id,
				store: primaryStore,
				entry: this.#entry,
				nodeName: (context as any)?.nodeName,
				validate: () => {
					if (!(context as any)?.source) {
						transaction.checkOverloaded();
						// Skip schema validation during crash-recovery replay (see _writeUpdate; harper#1316).
						if (!transaction.isReplay) this.validate(message);
					}
				},
				before:
					(this.constructor as any).source?.publish && !(context as any)?.source
						? (this.constructor as any).source.publish.bind((this.constructor as any).source, id, message, context)
						: undefined,
				commit: (txnTime, existingEntry, _retry, transaction: any) => {
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
						txnTime,
						0,
						true,
						{
							user: (context as any)?.user,
							residencyId: options?.residencyId,
							expiresAt: context?.expiresAt,
							nodeId: options?.nodeId,
							viaNodeId: options?.viaNodeId,
							transaction,
							tableToTrack: tableName,
						},
						'message',
						false,
						message
					);
				},
			};
			// because transaction log entries can be deleted at any point, we must save the blobs in the record, there is no cleanup of them
			write.beforeIntermediate = preCommitBlobsForRecordBefore(write, message, undefined, true);
			transaction.addWrite(write);
		}
		// #section: validation
		validate(record: any, patch?: boolean) {
			let validationErrors;
			const validateValue = (value, attribute: Attribute, name) => {
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
							if (attribute.relationship || attribute.computed) {
								if (record.hasOwnProperty(attribute.name)) {
									(validationErrors || (validationErrors = [])).push(
										`Computed property ${name}.${attribute.name} may not be directly assigned a value`
									);
								}
								continue;
							}
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
				if (attribute.relationship || attribute.computed) {
					if (Object.hasOwn(record, attribute.name)) {
						(validationErrors || (validationErrors = [])).push(
							`Computed property ${attribute.name} may not be directly assigned a value`
						);
					}
					continue;
				}
				if (!patch || attribute.name in record) {
					const updated = validateValue(record[attribute.name], attribute, attribute.name);
					if (updated !== undefined) record[attribute.name] = updated;
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
		// #section: stats-admin
		getUpdatedTime() {
			return this.#version;
		}
		static async addAttributes(attributesToAdd: Attribute[]) {
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
			return (TableResource as any).indexingOperation;
		}
		static async removeAttributes(names: string[]) {
			const new_attributes = attributes.filter((attribute) => !names.includes(attribute.name));
			table({
				table: tableName,
				database: databaseName,
				schemaDefined,
				attributes: new_attributes,
			});
			return (TableResource as any).indexingOperation;
		}
		/**
		 * Get the size of the table in bytes (based on amount of pages stored in the database)
		 * @param options
		 */
		static getSize() {
			if (isRocksDB) {
				return primaryStore.getDBIntProperty('rocksdb.estimate-live-data-size') ?? 0;
			}
			const stats = primaryStore.getStats();
			return (stats.treeBranchPageCount + stats.treeLeafPageCount + stats.overflowPages) * stats.pageSize;
		}
		static getAuditSize(): number {
			const stats = auditStore?.getStats();
			return (
				stats &&
				(stats.totalSize ??
					(stats.treeBranchPageCount + stats.treeLeafPageCount + stats.overflowPages) * stats.pageSize)
			);
		}
		static getStorageStats() {
			const stats = fs.statfsSync(primaryStore.path);
			return {
				available: stats.bavail * stats.bsize,
				free: stats.bfree * stats.bsize,
				size: stats.blocks * stats.bsize,
			};
		}
		static async getRecordCount(options?: any) {
			// iterate through the metadata entries to exclude their count and exclude the deletion counts
			const exactCount = options?.exactCount;
			const TIME_LIMIT = options?.timeLimit ?? 1000 / 2; // one second time limit, enforced by seeing if we are halfway through at 500ms
			const start = performance.now();
			// `entryCount` (the exact key count) is only needed once the scan blows the time budget --
			// to decide whether to estimate and as the extrapolation base. On RocksDB it is a full
			// key-only scan, so we defer it: tables that finish within budget (the common case) and
			// `exact_count` requests never pay for it. `halfway`/`entryCount` stay 0 until first computed.
			let entryCount = 0;
			let halfway = 0;
			let counted = false;
			let completeForExact = false;
			let recordCount = 0;
			let entriesScanned = 0;
			let limit: number;
			for (const { value } of primaryStore.getRange({ start: true, lazy: true, snapshot: false })) {
				if (value != null) recordCount++;
				entriesScanned++;
				await rest();
				if (!exactCount && !completeForExact && performance.now() - start > TIME_LIMIT) {
					if (!counted) {
						counted = true;
						entryCount = isRocksDB
							? primaryStore.getKeysCount({ start: undefined })
							: primaryStore.getStats().entryCount;
						halfway = Math.floor(entryCount / 2);
					}
					if (entriesScanned < halfway) {
						// it is taking too long, so we will just take this sample and a sample from the end to estimate
						limit = entriesScanned;
						break;
					}
					// Past the halfway point already: finishing the scan for an exact count is cheaper
					// than estimating. Set the flag so we stop re-evaluating the budget on each remaining iteration.
					completeForExact = true;
				}
			}
			if (limit) {
				// in this case we are going to make an estimate of the table count using the first thousand
				// entries and last thousand entries
				const firstRecordCount = recordCount;
				recordCount = 0;
				// Bound the reverse scan explicitly. The getRange `limit` option is honored by lmdb-js but
				// ignored by rocksdb-js; without this break the scan reads the whole table, so `recordRate`
				// blows up to ~entryCount/(2*limit) and the estimate scales with entryCount^2 -- the source
				// of the wildly inflated `record_count` (e.g. 20,000,000 for ~105k rows) on large RocksDB
				// tables. The early-exit above guarantees limit < entryCount/2, so the two samples stay disjoint.
				let reverseScanned = 0;
				for (const { value } of primaryStore.getRange({
					start: '\uffff',
					reverse: true,
					lazy: true,
					limit,
					snapshot: false,
				})) {
					if (value != null) recordCount++;
					reverseScanned++;
					await rest();
					if (reverseScanned >= limit) break;
				}
				// Use the actual entries sampled, not limit*2: the reverse scan can yield fewer than `limit`
				// (concurrent deletions under snapshot:false, or an overestimated entryCount), and counting
				// those un-scanned slots would inflate the denominator and underestimate the rate.
				const sampleSize = limit + reverseScanned;
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
			// Refresh on every call: schema reload mutates `attributes` in place, so the
			// class-construction snapshot would otherwise go stale.
			this.embedAttributes = (this.attributes as any[]).filter((a) => a?.embed);
			// Drop registry entries for attributes that are no longer `@embed`, so a dropped
			// directive doesn't leave a stale embedder or block a default refresh on re-add.
			const embedNames = new Set(this.embedAttributes.map((a) => a.name));
			for (const name of Object.keys(this.userEmbedders)) if (!embedNames.has(name)) delete this.userEmbedders[name];
			for (const name of this.userSetEmbedders) if (!embedNames.has(name)) this.userSetEmbedders.delete(name);
			propertyResolvers = this.propertyResolvers = {
				$id: (object, context, entry) => ({ value: entry.key }),
				$updatedtime: (object, context, entry) => entry.version,
				$updatedTime: (object, context, entry) => entry.version,
				$expiresAt: (object, context, entry) => entry.expiresAt,
				$record: (object, context, entry) => (entry ? { value: object } : object),
				$distance: (object, context, entry) => {
					return entry && (entry.distance ?? context?.vectorDistances?.get(entry));
				},
			};
			for (const attribute of this.attributes) {
				if (attribute.isPrimaryKey) primaryKeyAttribute = attribute;
				attribute.resolve = null; // reset this
				const relationship = attribute.relationship;
				const computed = attribute.computed;
				// Register the default embedder unless an author override is set. Sits outside
				// the resolver chain below so `@embed` fields still flow through auto-HNSW indexing.
				if (attribute.embed && !TableResource.userSetEmbedders.has(attribute.name)) {
					this.userEmbedders[attribute.name] = createDefaultEmbedder(attribute.embed);
				}
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
							propertyResolvers[attribute.name] = attribute.resolve = (object, context, entry, returnEntry?) => {
								// TODO: Get raw record/entry?
								const id = object[relationship.from ? relationship.from : primaryKey];
								const relatedTable = attribute.elements.definition.tableClass;
								if (returnEntry) {
									return (
										searchByIndex(
											{ attribute: relationship.to, value: id },
											txnForContext(context).getReadTxn(),
											false,
											relatedTable,
											false
										) as any
									).map((entry) => {
										if (entry && entry.key !== undefined) return entry;
										return relatedTable.primaryStore.getEntry(entry, {
											transaction: txnForContext(context).getReadTxn(),
										});
									}).asArray;
								}
								return relatedTable.search([{ attribute: relationship.to, value: id }], context).asArray;
							};
							attribute.set = () => {
								// ideally we want to throw an error here, but if the user had (accidently?) set a property into storage
								// conflicts with this attribute, we don't want to prevent loading
								// throw new Error('Setting a one-to-many relationship property is not supported');
							};
							attribute.resolve.definition = attribute.elements.definition;
							// preserve relationship information for searching
							attribute.resolve.to = relationship.to;
							if (relationship.from) attribute.resolve.from = relationship.from;
						} else
							console.error(
								`The one-to-many/many-to-many relationship property "${attribute.name}" in table "${tableName}" must have an array type referencing a table as the elements`
							);
					} else if (relationship.from) {
						const definition = attribute.definition || attribute.elements?.definition;
						if (definition) {
							propertyResolvers[attribute.name] = attribute.resolve = (object, context, entry, returnEntry?) => {
								const ids = object[relationship.from];
								if (ids === undefined) return undefined;
								if (attribute.elements) {
									let hasPromises;
									const results = ids?.map((id) => {
										const value = definition.tableClass.primaryStore[returnEntry ? 'getEntry' : 'get'](id, {
											transaction: txnForContext(context).getReadTxn(),
										});
										if (value?.then) hasPromises = true;
										// for now, we shouldn't be getting promises until rocksdb
										if (TableResource.loadAsInstance === false) Object.freeze(returnEntry ? value?.value : value);
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
								const value = definition.tableClass.primaryStore[returnEntry ? 'getEntry' : 'getSync'](ids, {
									transaction: txnForContext(context).getReadTxn(),
								});
								// for now, we shouldn't be getting promises until rocksdb
								if (TableResource.loadAsInstance === false) Object.freeze(returnEntry ? value?.value : value);
								return value;
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
					} else if (attribute.computedFromExpression) {
						// build a fallback scope object with all attribute names set to undefined,
						// matching the behavior in graphql.ts to prevent ReferenceErrors
						const attributesFallback: { [key: string]: undefined } = {};
						for (const attr of this.attributes) attributesFallback[attr.name] = undefined;
						this.setComputedAttribute(
							attribute.name,
							createComputedFrom(attribute.computedFromExpression, attributesFallback)
						);
					}
					propertyResolvers[attribute.name] = attribute.resolve = (object, context, entry) => {
						const value = typeof computed.from === 'string' ? object[computed.from] : object;
						const userResolver = this.userResolvers[attribute.name];
						if (userResolver) return userResolver(value, context, entry);
						else {
							logger.warn?.(
								`Computed attribute "${attribute.name}" does not have a function assigned to it. Please use setComputedAttribute('${attribute.name}', resolver) to assign a resolver function.`
							);
							// silence future warnings but just returning undefined
							this.userResolvers[attribute.name] = () => {};
						}
					};
					attribute.resolve.directReturn = true;
				} else if (indices[attribute.name]?.customIndex?.propertyResolver) {
					const customIndex = indices[attribute.name].customIndex;
					propertyResolvers[attribute.name] = (object, context, entry) => {
						const value = object[attribute.name];
						return customIndex.propertyResolver(value, context, entry);
					};
					propertyResolvers[attribute.name].directReturn = true;
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
						enumerable: attribute.enumerable,
					});
					if (attribute.enumerable && !primaryStore.encoder.structPrototype.toJSON) {
						Object.defineProperty(primaryStore.encoder.structPrototype, 'toJSON', {
							configurable: true,
							value() {
								const json = {};
								for (const key in this) {
									// copy all enumerable properties, including from prototype
									json[key] = this[key];
								}
								return json;
							},
						});
					}
				}
			}
		}
		// #section: computed-history
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
		/**
		 * Override the default embedder for an `@embed` attribute. Return the vector to
		 * store at `attribute_name`. The embedder receives the write payload (the fields
		 * present in the PUT/PATCH body), not the post-merge record, so multi-field
		 * concatenation only works when all source fields are in the same write.
		 */
		static setEmbedAttribute(attribute_name: string, embedder: Embedder): void {
			const attribute = findAttribute(attributes, attribute_name);
			if (!attribute) {
				console.error(`The attribute "${attribute_name}" does not exist in the table "${tableName}"`);
				return;
			}
			if (!attribute.embed) {
				console.error(`The attribute "${attribute_name}" is not declared with @embed in the table "${tableName}"`);
				return;
			}
			this.userEmbedders[attribute_name] = embedder;
			this.userSetEmbedders.add(attribute_name);
		}
		static async deleteHistory(endTime = 0, cleanupDeletedRecords = false) {
			let completion: Promise<void>;
			for (const auditRecord of auditStore.getRange({
				start: 0,
				end: endTime,
			})) {
				await rest(); // yield to other async operations
				if (auditRecord.tableId !== tableId) continue;
				completion = removeAuditEntry(auditStore, auditRecord);
			}
			if (cleanupDeletedRecords) {
				// this is separate procedure we can do if the records are not being cleaned up by the audit log. This shouldn't
				// ever happen, but if there are cleanup failures for some reason, we can run this to clean up the records
				for (const entry of primaryStore.getRange({ start: 0, versions: true })) {
					const { value, localTime } = entry;
					await rest(); // yield to other async operations
					if (value === null && localTime < endTime) {
						completion = removeEntry(primaryStore, entry);
					}
				}
			}
			await completion;
		}
		static async *getHistory(startTime = 0, endTime = Infinity) {
			for (const auditRecord of auditStore.getRange({
				start: startTime || 1, // if startTime is 0, we actually want to shift to 1 because 0 is encoded as all zeros with audit store's special encoder, and will include symbols
				end: endTime,
			})) {
				await rest(); // yield to other async operations
				if (auditRecord.tableId !== tableId) continue;
				yield {
					id: auditRecord.recordId,
					localTime: auditRecord.version,
					version: auditRecord.version,
					type: auditRecord.type,
					value: auditRecord.getValue(primaryStore, true, auditRecord.version),
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
			let nextVersion = entry.localTime;
			if (!nextVersion) throw new Error('The entry does not have a local audit time');
			const count = 0;
			const auditWindow = 100;
			do {
				await rest(); // yield to other async operations
				let insertionPoint = history.length;
				let highestPreviousVersion = 0;
				const start = nextVersion - auditWindow;
				for (const auditRecord of auditStore.getRange({ start, end: nextVersion + 0.001 })) {
					if (auditRecord.tableId === tableId && compareKeys(auditRecord.recordId, id) === 0) {
						history.splice(insertionPoint, 0, {
							id: auditRecord.recordId,
							localTime: nextVersion,
							version: auditRecord.version,
							type: auditRecord.type,
							value: auditRecord.getValue(primaryStore, true, nextVersion),
							user: auditRecord.user,
							operation: auditRecord.originatingOperation,
						});
						if (auditRecord.previousVersion > highestPreviousVersion && auditRecord.previousVersion < start) {
							highestPreviousVersion = auditRecord.previousVersion;
						}
					}
				}
				nextVersion = highestPreviousVersion;
			} while (count < 1000 && nextVersion);
			return history.reverse();
		}
		static clear() {
			return primaryStore.clear();
		}
		static cleanup() {
			deleteCallbackHandle?.remove();
		}
		static _readTxnForContext(context) {
			return txnForContext(context).getReadTxn();
		}
	}
	const throttledCallToSource = throttle(
		async (source, id, sourceContext, existingEntry) => {
			// call the data source if it exists and will fulfill our request for data
			if (source && source.get && (!source.get.reliesOnPrototype || source.prototype.get)) {
				if (source.available?.(existingEntry) !== false) {
					sourceContext.source = source;
					const resolvedData = await source.get(id, sourceContext);
					if (resolvedData) return resolvedData;
				}
			}
		},
		() => {
			throw new ServerError('Service unavailable, exceeded request queue limit for resolving cache record', 503);
		}
	);

	TableResource.updatedAttributes(); // on creation, update accessors as well
	if (expirationMs) TableResource.setTTLExpiration(expirationMs / 1000);
	if (expiresAtProperty) runRecordExpirationEviction();
	return TableResource;
	function updateIndices(id: any, existingRecord: any, record: any, options?: any) {
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
			if (index.customIndex) {
				index.customIndex.index(id, value, existingValue, options);
				continue;
			}
			hasChanges = true;
			const indexNulls = index.indexNulls;
			// determine what index values need to be removed and added
			let valuesToAdd = getIndexedValues(value, indexNulls) as any[];
			let valuesToRemove = getIndexedValues(existingValue, indexNulls) as any[];
			let isLMDB = !!index.prefetch;
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
				if (isLMDB && (valuesToRemove.length > 0 || valuesToAdd.length > 0) && LMDB_PREFETCH_WRITES) {
					// prefetch any values that have been removed or added
					const valuesToPrefetch = valuesToRemove.concat(valuesToAdd).map((v) => ({ key: v, value: id }));
					index.prefetch(valuesToPrefetch, noop);
				}
				//if the update cleared out the attribute value we need to delete it from the index
				for (let i = 0, l = valuesToRemove.length; i < l; i++) {
					index.remove(valuesToRemove[i], id, options);
				}
			} else if (isLMDB && valuesToAdd?.length > 0 && LMDB_PREFETCH_WRITES) {
				// no old values, just new
				index.prefetch(
					valuesToAdd.map((v) => ({ key: v, value: id })),
					noop
				);
			}
			if (valuesToAdd) {
				for (let i = 0, l = valuesToAdd.length; i < l; i++) {
					index.put(valuesToAdd[i], id, options);
				}
			}
		}
		return hasChanges;
	}
	function checkValidId(id) {
		switch (typeof id) {
			case 'number':
				if (isNaN(id)) throw new ClientError('Invalid primary key of NaN', 400);
				return true;
			case 'string':
				if (id.length < 659) return true; // max number of characters that can't expand our key size limit
				if (id.length > MAX_KEY_BYTES) {
					// we can quickly determine this is too big
					throw new ClientError('Primary key size is too large: ' + id.length, 400);
				}
				// TODO: We could potentially have a faster test here, Buffer.byteLength is close, but we have to handle characters < 4 that are escaped in ordered-binary
				break; // otherwise we have to test it, in this range, unicode characters could put it over the limit
			case 'object':
				if (id === null) {
					throw new ClientError('Invalid primary key of null', 400);
				}
				break; // otherwise we have to test it
			case 'bigint':
				if (id < 2n ** 64n && id > -(2n ** 64n)) return true;
				break; // otherwise we have to test it
			default:
				throw new ClientError('Invalid primary key type: ' + typeof id, 400);
		}
		// otherwise it is difficult to determine if the key size is too large
		// without actually attempting to serialize it
		const length = writeKey(id, TEST_WRITE_KEY_BUFFER, 0);
		if (length > MAX_KEY_BYTES) throw new ClientError('Primary key size is too large: ' + id.length, 400);
		return true;
	}
	function requestTargetToId(target: RequestTargetOrId): Id {
		return typeof target === 'object' && target ? (target as any).id : (target as Id);
	}
	function isSearchTarget(target: RequestTargetOrId): target is RequestTarget {
		return typeof target === 'object' && target && (target as RequestTarget).isCollection;
	}
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
			if (!sync && options) {
				options.async = true;
				return when(primaryStore.getEntry(id, options), withLocalEntry);
			} else {
				return withLocalEntry(primaryStore.getEntry(id, options));
			}
		};
		function withLocalEntry(entry) {
			// skip recording reads for most system tables except hdb_analytics
			// we want to track analytics reads in licensing, etc.
			if (databaseName !== 'system' && (options.type === 'read' || !options.type)) {
				harperLogger.trace?.('Recording db-read action for', `${databaseName}.${tableName}`);
				recordAction(entry?.size ?? 1, 'db-read', tableName, null);
			}

			// we need to freeze entry records to ensure the integrity of the cache;
			// but we only do this when users have opted into loadAsInstance/freezeRecords to avoid back-compat
			// issues
			Object.freeze(entry?.value);
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
		}
		// To prefetch or not to prefetch is one of the biggest questions Harper has to make.
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
		if (sync || isRocksDB) return whenPrefetched();
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
	function getTablePermissions(user: User, target?: RequestTarget) {
		let permission = target?.checkPermission; // first check to see the request target specifically provides the permissions to authorize
		if (typeof permission !== 'object') {
			if (!user?.role) return;
			permission = user.role.permission;
		}
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

	function ensureLoadedFromSource(source: typeof TableResource, id, entry, context, resource?, target?) {
		if (context?.onlyIfCached) {
			if (!entry?.value) throw new ServerError('Entry is not cached', 504);
			return;
		}
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
				const loadingFromSource = getFromSource(source, id, entry, context, target).then((entry) => {
					if (entry?.value && entry?.value.getRecord?.())
						logger.error?.('Can not assign a record that is already a resource');
					if (context) {
						if (entry?.version > (context.lastModified || 0)) context.lastModified = entry.version;
						context.lastRefreshed = Date.now(); // localTime is probably not available yet
					}
					return entry;
				});
				// if the resource defines a method for indicating if stale-while-revalidate is allowed for a record
				if (entry?.value && resource?.allowStaleWhileRevalidate?.(entry, id)) {
					// since we aren't waiting for it any errors won't propagate so we should at least log them
					loadingFromSource.catch((error) => logger.warn?.(error));
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
			if (!transaction.db && isRocksDB) {
				// this is an uninitialized DatabaseTransaction, we can claim it
				transaction.db = primaryStore as any;
				if (context?.timestamp) transaction.timestamp = context.timestamp;
				return transaction;
			}
			do {
				// See if this is a transaction for our database and if so, use it
				if (transaction.db?.path === primaryStore.path) return transaction;
				// try the next one:
				const nextTxn = transaction.next;
				if (!nextTxn) {
					// no next one, then add our database
					transaction.next = isRocksDB ? new DatabaseTransaction() : new LMDBTransaction();
					// Inherit never-drop-on-conflict so a source-applied multi-store transaction doesn't
					// drop the canonical write when a secondary store hits a transient conflict.
					transaction.next.sourceApply = transaction.sourceApply;
					// Inherit the replay marker so a multi-table replay transaction skips validation on
					// every store, not just the first (harper#1316).
					transaction.next.isReplay = transaction.isReplay;
					if (transaction.open === TRANSACTION_STATE.CLOSED) {
						// if the current transaction is already closed, we need to retain that state on new databases we work with
						transaction.next.open = TRANSACTION_STATE.CLOSED;
					}
					transaction = transaction.next;
					transaction.db = primaryStore;
					return transaction;
				}
				transaction = nextTxn;
			} while (true);
		} else {
			transaction = (
				isRocksDB ? new ImmediateTransaction(primaryStore as any) : new ImmediateLMDBTransaction(primaryStore as any)
			) as any;
			if (context) {
				context.transaction = transaction;
				if (context.timestamp) transaction.timestamp = context.timestamp;
			}
			return transaction;
		}
	}
	function getAttributeValue(entry, attribute_name, context) {
		if (!entry) {
			return;
		}
		const record = (entry.deref ? entry.deref() : entry.value) ?? primaryStore.getEntry(entry.key)?.value;
		if (typeof attribute_name === 'object') {
			// attribute_name is an array of attributes, pointing to nested attribute
			let resolvers = propertyResolvers;
			let value = record;
			for (let i = 0, l = attribute_name.length; i < l; i++) {
				const attribute = attribute_name[i];
				const resolver = resolvers?.[attribute];
				value = resolver && value ? resolver(value, context, entry) : value?.[attribute];
				entry = null; // can't use this in the nested object
				resolvers = resolver?.definition?.tableClass?.propertyResolvers;
			}
			return value;
		}
		const resolver = propertyResolvers[attribute_name];
		return resolver ? resolver(record, context, entry) : record[attribute_name];
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

	function precedesExistingVersion(txnTime: number, existingEntry: Partial<Entry>, nodeId?: number): number {
		if (nodeId === undefined) {
			nodeId = getThisNodeId(auditStore);
		}

		if (txnTime <= existingEntry?.version) {
			if (existingEntry?.version === txnTime && nodeId !== undefined) {
				// if we have a timestamp tie, we break the tie by comparing the node name of the
				// existing entry to the node name of the update
				const nodeNameToId = exportIdMapping(auditStore);
				let existingNodeId = existingEntry.nodeId ?? 0;
				if (nodeId === existingNodeId) {
					return 0; // early match for a tie
				}
				let updatedNodeName, existingNodeName;
				for (const node_name in nodeNameToId) {
					if (nodeNameToId[node_name] === nodeId) updatedNodeName = node_name;
					if (nodeNameToId[node_name] === existingNodeId) existingNodeName = node_name;
				}
				if (updatedNodeName > existingNodeName)
					// if the updated node name is greater (alphabetically), it wins (it doesn't precede the existing version)
					return 1;
				if (updatedNodeName === existingNodeName) return 0; // a tie
			}
			// transaction time is older than existing version, so we treat that as an update that loses to the existing record version
			return -1;
		}
		return 1;
	}

	/**
	 * This is used to record that a retrieve a record from source
	 */
	async function getFromSource(
		source: typeof TableResource,
		id: Id,
		existingEntry: Entry,
		context: Context,
		target?
	): Promise<Entry> {
		const metadataFlags = existingEntry?.metadataFlags;

		const existingVersion = existingEntry?.version;
		let whenResolved, timer;
		// We start by locking the record so that there is only one resolution happening at once;
		// if there is already a resolution in process, we want to use the results of that resolution
		// tryLock() will return true if we got the lock, and the callback won't be called.
		// If another thread has the lock it returns false and then the callback is called once
		// the other thread releases the lock.
		const callback = () => {
			// This is called when another thread releases the lock on resolution. Hopefully
			// it should be resolved now and we can use the value it saved.
			clearTimeout(timer);
			const entry = primaryStore.getEntry(id);
			if (
				!entry ||
				!entry.value ||
				entry.metadataFlags & (INVALIDATED | EVICTED) ||
				(entry.expiresAt != undefined && entry.expiresAt < Date.now())
			)
				// try again — entry still not valid, need to actually fetch from source
				whenResolved(getFromSource(source, id, primaryStore.getEntry(id), context, target));
			else {
				// served from cache after waiting for another request to resolve
				if (target) target.loadedFromSource = false;
				whenResolved(entry);
			}
		};
		const lockAcquired = primaryStore.tryLock(id, callback);

		if (!lockAcquired) {
			return new Promise((resolve) => {
				whenResolved = resolve;
				timer = setTimeout(() => {
					primaryStore.unlock(id);
				}, LOCK_TIMEOUT);
			});
		}
		// lock acquired — this request will actually load from source
		if (target) target.loadedFromSource = true;

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
		const responseHeaders = (context as any)?.responseHeaders;
		return new Promise((resolve, reject) => {
			// we don't want to wait for the transaction because we want to return as fast as possible
			// and let the transaction commit in the background
			let resolved;
			when(
				transaction(sourceContext, async (_txn) => {
					const start = performance.now();
					let updatedRecord;
					let hasChanges, invalidated;
					try {
						updatedRecord = await throttledCallToSource(source, id, sourceContext, existingEntry);
						invalidated = metadataFlags & INVALIDATED;
						let version = sourceContext.lastModified || (invalidated && existingVersion);
						hasChanges = invalidated || version > existingVersion || !existingRecord;
						const resolveDuration = performance.now() - start;
						recordAction(resolveDuration, 'cache-resolution', tableName, null, 'success');
						if (responseHeaders)
							appendHeader(responseHeaders, 'Server-Timing', `cache-resolve;dur=${resolveDuration.toFixed(2)}`, true);
						if (expirationMs && sourceContext.expiresAt == undefined)
							sourceContext.expiresAt = Date.now() + expirationMs;
						if (updatedRecord) {
							if (typeof updatedRecord !== 'object') throw new Error('Only objects can be cached and stored in tables');
							if (updatedRecord.status > 0 && updatedRecord.headers) {
								// if the source has a status code and headers, treat it as a response
								const status = updatedRecord.status;
								if (status === 304) {
									// revalidation of our current cached record
									updatedRecord = existingRecord;
									version = existingVersion;
								} else if (!CACHEABLE_STATUS_CODES.has(status)) {
									// non-cacheable status - propagate to client without caching
									throw new ServerError(updatedRecord.body || 'Error from source', status);
								} else {
									let headers: any;
									const sourceHeaders = updatedRecord.headers;
									if (sourceHeaders[Symbol.iterator]) {
										headers = {};
										for (let [name, value] of sourceHeaders) {
											headers[name.toLowerCase()] = value;
										}
									} else {
										headers = sourceHeaders; // just a plain object
									}
									const contentType = sourceHeaders.get?.('Content-Type');
									let data: any;
									if (contentType === 'application/json' && updatedRecord.json) {
										// use native .json() if possible
										data = await updatedRecord.json();
									} else {
										const contentTypeHandler = contentType && contentTypes.get(contentType);
										if (contentTypeHandler?.deserialize) {
											data = contentTypeHandler.deserialize(
												await (contentType.startsWith('text/') ? updatedRecord.text() : updatedRecord.bytes())
											);
										}
									}
									if (data !== undefined) {
										// we have structured data that we have parsed
										delete headers['content-type']; // don't store the content type if we have already parsed it
										updatedRecord = { headers, data };
									} else {
										updatedRecord = { headers, body: createBlob(updatedRecord.body) };
									}
									if (status !== 200) updatedRecord.status = status;
								}
							}
							if (typeof updatedRecord.toJSON === 'function') updatedRecord = updatedRecord.toJSON();
							// updatedRecord may still be a frozen record (e.g. a reused existingRecord); copy-on-mutate
							// before stamping the primary key and created/updated times below (records are immutable —
							// 5.2 record caching relies on it — so we must not write through the frozen object).
							if (isFrozenRecordObject(updatedRecord)) updatedRecord = { ...updatedRecord };
							if (primaryKey && updatedRecord[primaryKey] !== id) updatedRecord[primaryKey] = id;
						}
						resolved = true;
						const resolvedEntry: Entry = {
							key: id,
							version,
							value: updatedRecord,
							expiresAt: sourceContext.expiresAt,
							metadataFlags: 0,
							size: 0,
							localTime: 0,
							nodeId: 0,
							residencyId: 0,
						} as any;
						// Give the plain object the RecordObject prototype so getExpiresAt/getUpdatedTime
						// are available on the immediately-resolved entry. We mutate the prototype
						// in-place rather than copying so that the commit callback (which adds
						// createdAt/updatedAt to updatedRecord) is still reflected in the entry value.
						if (updatedRecord && updatedRecord.constructor === Object) {
							Object.setPrototypeOf(updatedRecord, primaryStore.encoder.structPrototype);
							entryMap.set(updatedRecord, resolvedEntry);
						}
						resolve(resolvedEntry);
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
							} as any);
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
					const sourceWrite: any = {
						key: id,
						store: primaryStore,
						entry: existingEntry,
						nodeName: 'source',
						commit: (txnTime, existingEntry, _retry, transaction: any) => {
							sourceWrite.skipped = false; // reset on each retry; cleanup happens after commit if still true
							if (existingEntry?.version !== existingVersion) {
								// don't do anything if the version has changed
								sourceWrite.skipped = true;
								return;
							}
							updateIndices(id, existingRecord, updatedRecord, transaction && { transaction });
							if (updatedRecord) {
								if (existingEntry) {
									context.previousResidency = TableResource.getResidencyRecord(existingEntry.residencyId);
								}
								let auditRecord: any;
								let omitLocalRecord = false;
								let residencyId: number;
								if (updatedTimeProperty) {
									updatedRecord[updatedTimeProperty.name] =
										updatedTimeProperty.type === 'Date'
											? new Date(txnTime)
											: updatedTimeProperty.type === 'String'
												? new Date(txnTime).toISOString()
												: txnTime;
								}
								if (createdTimeProperty && updatedRecord[createdTimeProperty.name] == null) {
									const existingCreatedTime = existingEntry?.value?.[createdTimeProperty.name];
									if (existingCreatedTime != null) {
										updatedRecord[createdTimeProperty.name] = existingCreatedTime;
									} else {
										updatedRecord[createdTimeProperty.name] =
											createdTimeProperty.type === 'Date'
												? new Date(txnTime)
												: createdTimeProperty.type === 'String'
													? new Date(txnTime).toISOString()
													: txnTime;
									}
								}
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
											if (createdTimeProperty && auditRecord[createdTimeProperty.name] != null) {
												// preserve the created timestamp in the partial record so it isn't lost when we don't have residency
												if (!updatedRecord) updatedRecord = {};
												updatedRecord[createdTimeProperty.name] = auditRecord[createdTimeProperty.name];
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
									{
										user: (sourceContext as any)?.user,
										expiresAt: sourceContext.expiresAt,
										residencyId,
										transaction,
										tableToTrack: tableName,
									},
									'put',
									Boolean(invalidated),
									auditRecord
								);
								// arm the eviction scanner, mirroring the .put() path
								if (sourceContext.expiresAt) scheduleCleanup();
							} else if (existingEntry) {
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
										{ user: (sourceContext as any)?.user, transaction, tableToTrack: tableName },
										'delete',
										Boolean(invalidated)
									);
								} else {
									removeEntry(primaryStore, existingEntry, existingVersion);
								}
							}
						},
					};
					// The cache-from-source write bypasses `_writeUpdate`, so wire the embed hook here
					// too (always the originating node). It runs after the client GET has resolved with
					// fresh source data, so it's a background commit: an embedder failure aborts the cache
					// write via the outer error handler (row re-embeds next read) and never reaches the
					// caller. Source-resolution errors are handled earlier, with the stale-data fallback.
					const embedBefore = buildEmbedBefore(
						updatedRecord,
						sourceContext,
						undefined,
						TableResource.embedAttributes,
						TableResource.userEmbedders
					);
					if (embedBefore) await embedBefore();
					sourceWrite.before = preCommitBlobsForRecordBefore(sourceWrite, updatedRecord);
					dbTxn.addWrite(sourceWrite);
				}),
				() => {
					primaryStore.unlock(id);
				},
				(error) => {
					primaryStore.unlock(id);
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
	function checkContextPermissions(context: Context): boolean {
		if (!context) return true;
		if (context.user?.role?.permission?.super_user) return true;
		if (context.replicateTo)
			throw new ClientError('Can not specify replication parameters without super user permissions', 403);
		if (context.replicatedConfirmation)
			throw new ClientError('Can not specify replication confirmation without super user permissions', 403);
		return true;
	}
	// RocksDB-only: coalesces eviction/tombstone removals into shared transactions so the cleanup
	// scan pays one commit per batch instead of one per record. Descriptors hold only the decoded
	// primary key and the version seen during the scan (both stable primitives — the scanned record
	// value lives in a reused iterator buffer, so it is re-read fresh at commit time). Each record is
	// version-guarded inside the commit transaction, and RocksDB's optimistic conflict detection
	// catches anything modified between staging and commit: on conflict (ERR_BUSY) we re-stage once
	// into a fresh transaction (dropping the now-changed record) and otherwise skip the batch, leaving
	// those records for the next cleanup cycle.
	function createEvictionBatcher() {
		type EvictItem = { type: 'evict' | 'tombstone'; key: any; version: number };
		let pending: EvictItem[] = [];
		const inFlight = new Set<Promise<void>>();

		// Apply a batch's removals to the given transaction, re-reading each record fresh and skipping
		// any that changed since the scan. Returns the number of removals actually staged.
		function stageInto(transaction: RocksTransaction, items: EvictItem[]): number {
			const options = { transaction };
			let staged = 0;
			for (const item of items) {
				const entry = primaryStore.getEntry(item.key, options);
				if (!entry || entry.version !== item.version) continue; // gone or changed since the scan; leave for next cycle
				if (item.type === 'tombstone') {
					if (entry.value != null) continue; // resurrected since the scan
				} else {
					if (entry.value == null) continue; // already removed
					if (hasSourceGet && primaryStore.hasLock(item.key, entry.version)) continue; // resolution in progress
					updateIndices(item.key, entry.value, null, options);
				}
				removeEntry(primaryStore, entry, options);
				staged++;
			}
			return staged;
		}

		async function commitItems(items: EvictItem[]) {
			for (let attempt = 0; attempt < 2; attempt++) {
				// Create the transaction inside the try: if the store is closing mid-scan, the constructor
				// can throw, and this promise is not always awaited (in-flight under the cap), so an
				// uncaught throw here would surface as an unhandled rejection.
				let transaction: RocksTransaction | undefined;
				let staged: number;
				try {
					transaction = new RocksTransaction(primaryStore.store);
					staged = stageInto(transaction, items);
				} catch (error) {
					try {
						transaction?.abort();
					} catch {}
					logger.warn?.(`Eviction batch staging error for ${tableName}:`, error);
					return;
				}
				if (staged === 0) {
					try {
						transaction.abort();
					} catch {}
					return;
				}
				try {
					await transaction.commit();
					return;
				} catch (error: any) {
					try {
						transaction.abort();
					} catch {}
					if (attempt === 0 && error?.code === 'ERR_BUSY') {
						logger.debug?.(`Eviction batch conflict for ${tableName}, retrying once`);
						continue; // re-stage into a fresh transaction; version guards drop the conflicting record(s)
					}
					logger.warn?.(`Eviction batch commit error for ${tableName}:`, error);
					return;
				}
			}
		}

		// Track an in-flight commit and, once the cap is reached, return a promise the caller can await
		// for backpressure (resolves as soon as any in-flight commit finishes).
		function track(commit: Promise<void>): Promise<void> | void {
			const tracked = commit.finally(() => inFlight.delete(tracked));
			inFlight.add(tracked);
			if (inFlight.size >= MAX_INFLIGHT_EVICTION_BATCHES) return Promise.race(inFlight);
		}

		return {
			add(type: 'evict' | 'tombstone', key: any, version: number): Promise<void> | void {
				pending.push({ type, key, version });
				if (pending.length >= EVICTION_BATCH_SIZE) {
					const items = pending;
					pending = [];
					return track(commitItems(items));
				}
			},
			async drain(): Promise<void> {
				if (pending.length > 0) {
					const items = pending;
					pending = [];
					track(commitItems(items));
				}
				await Promise.all(inFlight);
			},
		};
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
								const rootStore = primaryStore.rootStore;
								if (rootStore.status !== 'open') {
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
								logger.debug?.(
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
									let removeDeletedRecords = !audit || isRocksDB;
									// RocksDB coalesces eviction/tombstone removals into shared transactions to amortize
									// the per-record commit cost; LMDB keeps the per-record path (eventTurnBatching already
									// coalesces async writes per event turn).
									const batcher = isRocksDB ? createEvictionBatcher() : undefined;
									// iterate through all entries to find expired records and deleted records
									for (const entry of primaryStore.getRange({
										start: false,
										snapshot: false, // we don't want to keep read transaction snapshots open
										versions: true,
										lazy: true, // only want to access metadata most of the time
									})) {
										const { key, value: record, version, expiresAt, metadataFlags } = entry;
										// if there is no auditing cleanup and we are tracking deletion, need to do cleanup of
										// these deletion entries (LMDB audit cleanup has its own scheduled job for this)
										let action: 'tombstone' | 'evict' | undefined;
										if (record === null && removeDeletedRecords && version + auditRetention < Date.now()) {
											action = 'tombstone';
										} else if (expiresAt != undefined && shouldEvict(expiresAt, version, metadataFlags, record)) {
											action = 'evict';
											count++;
										}
										if (action) {
											// Blob-bearing records delete their blob files as a non-transactional side effect, so
											// they stay on the per-record evict() path that preserves the existing blob/commit ordering.
											if (batcher && !(action === 'evict' && metadataFlags & HAS_BLOBS)) {
												await batcher.add(action, key, version);
											} else {
												const resolution =
													action === 'tombstone'
														? removeEntry(primaryStore, entry, version)
														: TableResource.evict(key, record, version);
												if (resolution) {
													await outstandingCleanupOperations[cleanupIndex];
													outstandingCleanupOperations[cleanupIndex] = resolution.catch((error) => {
														logger.error?.('Cleanup error', error);
													});
													if (++cleanupIndex >= MAX_CLEANUP_CONCURRENCY) cleanupIndex = 0;
												}
											}
										}
										await rest();
									}
									if (batcher) await batcher.drain();
									logger.debug?.(`Finished cleanup scan for ${tableName}, evicted ${count} entries`);
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
				logger.trace?.(
					`Shard ${shardOrResidencyList} mapped to ${residencyList.map((node) => (node as any).name).join(', ')}`
				);
				return residencyList.map((node) => (node as any).name);
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
	function preCommitBlobsForRecordBefore(
		write: any,
		record: any,
		before?: () => Promise<void> | void,
		saveInRecord?: boolean,
		trackPersistedBlobs?: boolean
	): any {
		const preCommit = startPreCommitBlobsForRecord(record, primaryStore.rootStore, saveInRecord, trackPersistedBlobs);
		if (preCommit) {
			// track the blobs on the write so abort/skip paths can clean up the files if the commit doesn't reference them
			write.savedBlobs = preCommit.blobs;
			// if there are blobs that we have started saving, they need to be saved and completed before we commit, so we need to wait for
			// them to finish and we return a new callback for the before phase of the commit
			const callSources = before;
			return callSources
				? async (): Promise<any> => {
						// if we are calling the sources first and waiting for blobs, do those in order
						const result = callSources();
						if (result && (result as any).then) await result;
						await preCommit.complete();
					}
				: () => preCommit.complete();
		}
		return before as any;
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

/**
 * Recreate a computed "from" function from a stored expression string. This is used when a table
 * is loaded from metadata on a thread that hasn't loaded the GraphQL schema, so the computed
 * function needs to be reconstructed from the persisted expression.
 */
function createComputedFrom(computedFromExpression: string, attributesFallback?: any) {
	const script = new Script(
		attributesFallback
			? `function computed(attributes) { return function(record) { with(attributes) { with (record) { return ${computedFromExpression}; } } } } computed;`
			: `function computed() { return function(record) { with (record) { return ${computedFromExpression}; } } } computed;`
	);
	return script.runInThisContext()(attributesFallback);
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
				return autoCastBooleanStrict(value);
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

// for filtering
function exists(value) {
	return value != null;
}

function stringify(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return value;
	}
}
function hasOtherProcesses(store) {
	const pid = process.pid;
	return store.env
		.readerList?.()
		.slice(1)
		.some((line) => {
			// if the pid from the reader list is different than ours, must be another process accessing the database
			return +line.match(/\d+/)?.[0] != pid;
		});
}
function convertToComparableKeys(a) {
	if (a instanceof Date) {
		return a.getTime();
	}
	if (Array.isArray(a)) {
		return a.map(convertToComparableKeys);
	}
	return a;
}
