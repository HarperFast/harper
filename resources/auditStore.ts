import { readKey, writeKey } from 'ordered-binary';
import { initSync, get as envGet } from '../utility/environment/environmentManager.ts';
import { AUDIT_STORE_NAME } from '../utility/lmdb/terms.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { convertToMS } from '../utility/common_utils.ts';
import { LAST_TIMESTAMP_PLACEHOLDER, HAS_STRUCTURE_UPDATE } from './RecordEncoder.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import { getRecordAtTime } from './crdt.ts';
import { decodeFromDatabase } from './blob.ts';
import { onStorageReclamation } from '../server/storageReclamation.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { RocksTransactionLogStore } from './RocksTransactionLogStore.ts';
import { isReadOnlyMode } from './databases.ts';

/**
 * This module is responsible for the binary representation of audit records in an efficient form.
 * This includes a custom key encoder that specifically encodes arrays with the first element (timestamp) as a
 * 64-bit float, second (table id) as a 32-unsigned int, and third using standard ordered-binary encoding
 *
 * This also defines a binary representation for the audit records themselves which is:
 * 1 or 2 bytes: action, describes the action of this record and any flags for which other parts are included
 * tableId
 * recordId
 * origin version
 * previous local version
 * 1 or 2 bytes: position of end of the username section. 0 if there is no username
 * 2 or 4 bytes: node-id
 * 8 bytes (optional): last version timestamp (allows for backwards traversal through history of a record)
 * username
 * remaining bytes (optional, not included for deletes/invalidation): the record itself, using the same encoding as its primary store
 */
initSync();

export type AuditRecord = {
	version: number;
	recordVersion?: number; // the record's own version; on RocksDB reads `version` becomes the log key, so record identity uses this
	localTime: number; // log position: LMDB audit-store key; RocksDB transaction-log timestamp
	type: string;
	encodedRecord?: Buffer;
	extendedType?: number;
	residencyId?: number;
	previousResidencyId?: number;
	expiresAt: number | null;
	originatingOperation: string;
	tableId?: number;
	recordId?: number;
	previousVersion?: number;
	user?: string;
	nodeId?: number;
	previousNodeId: number;
	previousAdditionalAuditRefs?: Array<{ version?: number; nodeId: number }>;
	key?: any;
	encoded?: any;
	size: number;
	getValue?: any;
	getBinaryValue?: any;
	structureVersion?: number;
	endTxn?: boolean;
	getBinaryRecordId?: any;
};

const ENTRY_HEADER = Buffer.alloc(2816); // this is sized to be large enough for the maximum key size (1976) plus large usernames. We may want to consider some limits on usernames to ensure this all fits
export const ENTRY_DATAVIEW = new DataView(ENTRY_HEADER.buffer, ENTRY_HEADER.byteOffset, 2816);
export const transactionKeyEncoder = {
	writeKey(key, buffer, position) {
		if (key === LAST_TIMESTAMP_PLACEHOLDER) {
			buffer.set(LAST_TIMESTAMP_PLACEHOLDER, position);
			return position + 8;
		}
		if (typeof key === 'number') {
			const dataView =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			dataView.setFloat64(position, key);
			return position + 8;
		} else {
			return writeKey(key, buffer, position);
		}
	},
	readKey(buffer, start, end) {
		if (buffer[start] === 66) {
			const dataView =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			// Without this bounds check, a truncated key buffer escapes as RangeError up
			// through lmdb-js's iterator and lands as an uncaughtException on a later tick,
			// stalling outgoing replication for the affected (peer, db) pair.
			if (start + 8 > buffer.byteLength) {
				harperLogger.warn('Audit key buffer too short for float64 read; returning NaN sentinel', {
					start,
					byteLength: buffer.byteLength,
				});
				return NaN;
			}
			return dataView.getFloat64(start);
		} else {
			return readKey(buffer, start, end);
		}
	},
};
export const AUDIT_STORE_OPTIONS = {
	encoder: {
		needsStableBuffer: true,
		encode: (auditRecord: AuditRecord) =>
			auditRecord && (auditRecord instanceof Uint8Array ? auditRecord : createAuditEntry(auditRecord)),
		decode: (encoding: Buffer) => readAuditEntry(encoding),
	},
	keyEncoder: transactionKeyEncoder,
};

export let auditRetention = convertToMS(envGet(CONFIG_PARAMS.LOGGING_AUDITRETENTION)) || 86400 * 1000;
const MAX_DELETES_PER_CLEANUP = 1000;
// setTimeout silently falls back to 1ms for delays past this, which would turn the backoff into the
// hot loop it is meant to avoid — a `logging.auditRetention` over ~248 days reaches it via retention/10
const MAX_CLEANUP_DELAY = 2 ** 31 - 1;
// separate mint/read latches so a legacy-entry read warn can't mask the still-minting signal;
// mint latch keyed per (table, type) so one entry type can't silence another's producer stack
const warnedBodylessMints = new Set<string>();
const warnedBodylessTables = new Set<number>();
// legacy-format latches: one warn per process each, so a range scan over millions of pre-#2247
// entries cannot turn a recovered read into a log flood
let warnedRecoveredPrefix = false;
let warnedUndecodableHeader = false;
const FLOAT_TARGET = new Float64Array(1);
const FLOAT_BUFFER = new Uint8Array(FLOAT_TARGET.buffer);

/** Last resort on a detached path: a failing log sink must not itself become an unhandled rejection. */
function warnContained(message: string, error: unknown) {
	try {
		harperLogger.warn(message, error);
	} catch {}
}
let DEFAULT_AUDIT_CLEANUP_DELAY = 10000; // default delay of 10 seconds
let timestampErrored = false;
export function openAuditStore(rootStore) {
	let auditStore;
	if (rootStore instanceof RocksDatabase) {
		auditStore = new RocksTransactionLogStore(rootStore);
		auditStore.env = {};
	} else {
		auditStore = rootStore.openDB(AUDIT_STORE_NAME, {
			create: false,
			...AUDIT_STORE_OPTIONS,
		});
		if (!auditStore) {
			// this means we are creating a new audit store. Initialize with the last removed timestamp (we don't want to put this in legacy audit logs since we don't know if they have had deletions or not).
			auditStore = rootStore.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
			// this open path is synchronous, so nothing downstream can own the write's rejection
			updateLastRemoved(auditStore, 1)?.catch?.((error) =>
				warnContained('Error initializing the audit log last-removed marker', error)
			);
		}
		const superGetRange = auditStore.getRange.bind(auditStore);
		auditStore.getRange = function (options) {
			if (options.values === false) return superGetRange(options); // getKeys shouldn't be modified
			return superGetRange(options).map(({ key, value }) => {
				value.key = value.localTime = key;
				return value;
			});
		};
	}
	rootStore.auditStore = auditStore;
	auditStore.rootStore = rootStore;
	auditStore.tableStores = [];
	const deleteCallbacks = [];
	auditStore.addDeleteRemovalCallback = function (tableId, table, callback) {
		deleteCallbacks[tableId] = callback;
		auditStore.tableStores[tableId] = table;
		auditStore.deleteCallbacks = deleteCallbacks;
		return {
			remove() {
				delete deleteCallbacks[tableId];
				if (auditStore.tableStores[tableId] === table) delete auditStore.tableStores[tableId];
			},
		};
	};
	let pendingCleanup = null;
	// resolver of the scheduled-but-not-yet-started pass, so a schedule that supersedes it can hand
	// its callers over to the replacement instead of leaving them on a promise that never settles
	let pendingCleanupResolve: (() => void) | null = null;
	let lastCleanupResolution: Promise<void>;
	let cleanupPriority = 0;
	auditStore.auditCleanupDelay = DEFAULT_AUDIT_CLEANUP_DELAY;
	let cleanupStopped = false;
	// a last-removed marker whose write failed, retried on later passes: dropping it would leave
	// getLastRemoved() reporting a boundary the entries behind it have already been deleted past
	let pendingLastRemoved: number | undefined;
	const isRocksAuditStore = auditStore instanceof RocksTransactionLogStore;
	// A pass yields, so the store can be closed underneath it. Every touch of the environment after a
	// resume — cursor advance, cursor release, marker write, re-arm — has to re-check.
	const storeClosing = () => auditStore.rootStore.status === 'closed' || auditStore.rootStore.status === 'closing';
	onStorageReclamation(rootStore.path, (priority) => {
		cleanupPriority = priority; // update the priority
		if (priority) {
			// and if we have a priority, schedule cleanup soon
			return scheduleAuditCleanup(100);
		}
	});
	/**
	 * Schedules a pass of the audit cleanup loop. The returned promise fulfills once the pass that
	 * serves this call has finished, so callers (notably tests) can await completion instead of
	 * guessing a delay. Two things it does not promise: an LMDB pass removes at most
	 * MAX_DELETES_PER_CLEANUP entries before rescheduling itself, so fulfillment means "that pass
	 * finished", not "the audit log is fully pruned"; and a pass that failed logs and fulfills rather
	 * than rejecting, since this promise doubles as the loop's serialization barrier.
	 */
	function scheduleAuditCleanup(newCleanupDelay?: number): Promise<void> {
		// Skip audit cleanup/purge in read-only mode
		if (cleanupStopped || isReadOnlyMode()) return Promise.resolve();

		if (newCleanupDelay) auditStore.auditCleanupDelay = newCleanupDelay;
		// the pass we are about to cancel has not started, so its callers are handed over to this one
		const supersededResolve = pendingCleanupResolve;
		clearTimeout(pendingCleanup);
		const resolution = new Promise<void>((resolve) => {
			pendingCleanupResolve = resolve;
			const runCleanupPass = async () => {
				pendingCleanup = null;
				pendingCleanupResolve = null; // started, so a later schedule can no longer cancel this pass
				// claim the serialization slot before yielding: assigning it after the await lets every
				// pass released by the same resolution run concurrently over the same range
				const previousCleanup = lastCleanupResolution;
				lastCleanupResolution = resolution;
				await previousCleanup;
				// query for audit entries that are old
				if (cleanupStopped || storeClosing()) {
					// nothing to clean up and nothing to reschedule, but leaving `resolution` pending would
					// wedge the loop permanently: it is now the resolution every later pass awaits
					resolve();
					return;
				}
				const passCleanupPriority = cleanupPriority;
				let deleted = 0;
				let lastKey: any;
				try {
					if (isRocksAuditStore) {
						auditStore.rootStore.purgeLogs({
							before: Date.now() - auditRetention / (1 + passCleanupPriority * passCleanupPriority),
						});
					} else {
						// Driven explicitly rather than with for-of: this loop suspends on the awaits below, and a
						// close landing mid-pass closes the env under it. for-of calls next() before the body, so a
						// check inside the body advances the cursor first — the guard has to precede every next().
						const entries = auditStore
							.getRange({
								start: 1, // must not be zero or it will be interpreted as null and overlap with symbols in search
								snapshot: false,
								end: Date.now() - auditRetention / (1 + passCleanupPriority * passCleanupPriority), // remove up until the audit retention time, reducing audit retention time if cleanup is higher priority
							})
							[Symbol.iterator]();
						try {
							while (!cleanupStopped && !storeClosing()) {
								const entry = entries.next();
								if (entry.done) break;
								const auditRecord = entry.value;
								try {
									// awaited so a rejection (not just a synchronous throw) is caught here instead of
									// escaping as an unhandled rejection once a later iteration's promise replaces this one
									await removeAuditEntry(auditStore, auditRecord);
								} catch (error) {
									harperLogger.warn('Error removing audit entry', error);
								}
								lastKey = auditRecord.key;
								await new Promise(setImmediate);
								if (++deleted >= MAX_DELETES_PER_CLEANUP) {
									// limit the amount we cleanup per event turn so we don't use too much memory/CPU
									auditStore.auditCleanupDelay = 10; // and keep trying very soon
									break;
								}
							}
						} finally {
							// for-of released the underlying cursor on break; an explicit loop owes that itself.
							// Skipped only once the root is closing: releasing a cursor into a closed env reaches
							// native code, while a retirement that leaves the env open still owes the release.
							if (!storeClosing()) entries.return?.();
						}
					}
				} catch (error) {
					// a failed scan is a log line, not a retired loop: the bookkeeping and reschedule below
					// still run
					harperLogger.warn('Error during audit log cleanup', error);
				} finally {
					try {
						if (isRocksAuditStore) {
							// eligibility only changes on rotation/flush, so the LMDB backoff — keyed on a per-entry
							// delete count — would only rescan the same segments
							auditStore.auditCleanupDelay = Math.max(
								DEFAULT_AUDIT_CLEANUP_DELAY,
								Math.min(auditRetention / (1 + cleanupPriority * cleanupPriority) / 10, MAX_CLEANUP_DELAY)
							);
						} else {
							if (deleted === 0) {
								// if we didn't delete anything, we can increase the delay (double until we get to one tenth of
								// the retention time). Plain arithmetic, not `<<`/`>>`: those coerce to int32, so a
								// sub-millisecond retention collapsed the delay to 0 permanently (0 << 1 is 0), and a
								// retention over ~248 days grows it past 2^31 where halving it wraps negative.
								auditStore.auditCleanupDelay = Math.max(
									1,
									Math.min(auditStore.auditCleanupDelay * 2, auditRetention / 10, MAX_CLEANUP_DELAY)
								);
							} else {
								pendingLastRemoved = lastKey;
								// and do updates faster
								if (auditStore.auditCleanupDelay > 100) auditStore.auditCleanupDelay = auditStore.auditCleanupDelay / 2;
							}
							// skipped when the store was retired or closed mid-pass — this writes to the audit
							// store — and carried to the next pass instead, so a failed write is not lost
							if (pendingLastRemoved !== undefined && !cleanupStopped && !storeClosing()) {
								const marker = pendingLastRemoved;
								try {
									// awaited so the barrier below covers the write, and so a rejection is logged
									// here rather than escaping the detached timer callback
									await updateLastRemoved(auditStore, marker);
									if (pendingLastRemoved === marker) pendingLastRemoved = undefined;
								} catch (error) {
									harperLogger.warn('Error recording the last removed audit entry', error);
								}
							}
						}
					} finally {
						// settled and re-armed whatever the bookkeeping above threw: this promise is both the
						// serialization barrier every later pass awaits and the drain barrier
						// stopAuditCleanup() hands its callers, so never settling it wedges both
						resolve();
						// both conjuncts are backstops, not the ownership rule — see DESIGN.md: the arming
						// sites already restrict Rocks to the last worker
						if (
							!cleanupStopped &&
							!storeClosing() &&
							(!isRocksAuditStore || (getWorkerIndex() === getWorkerCount() - 1 && !pendingCleanupResolve))
						) {
							scheduleAuditCleanup();
						}
					}
				}
				// we can run this pretty frequently since there is very little overhead to these queries
			};
			pendingCleanup = setTimeout(() => {
				// nothing owns the timer callback's promise, so anything the pass lets escape — including a
				// throw from the logging inside its own containment — would land as an unhandled rejection
				runCleanupPass().catch((error) => {
					warnContained('Error during audit log cleanup', error);
					resolve();
				});
			}, auditStore.auditCleanupDelay).unref();
		});
		if (supersededResolve) resolution.then(supersededResolve);
		return resolution;
	}
	auditStore.scheduleAuditCleanup = scheduleAuditCleanup;
	/**
	 * Retires the cleanup loop for good, and returns a drain barrier: the promise settles once the pass
	 * that was already running has finished. Retirement alone only stops the loop admitting more work —
	 * a pass suspended inside `await removeAuditEntry()` still has a write queued whose DBI the native
	 * writer consumes later, so a caller that closes or unlinks stores must await this first. The
	 * synchronous teardown paths cannot; the in-pass status checks are what covers them.
	 */
	auditStore.stopAuditCleanup = function (): Promise<void> {
		cleanupStopped = true;
		clearTimeout(pendingCleanup);
		pendingCleanup = null;
		pendingCleanupResolve?.();
		pendingCleanupResolve = null;
		return lastCleanupResolution ?? Promise.resolve();
	};
	if (getWorkerIndex() === getWorkerCount() - 1) {
		scheduleAuditCleanup();
	}
	if (getWorkerIndex() === 0 && !timestampErrored) {
		// make sure the timestamp is valid
		for (const time of auditStore.getKeys({ reverse: true, limit: 1 })) {
			if (time > Date.now()) {
				timestampErrored = true;
				harperLogger.error(
					'The current time is before the last recorded entry in the audit log. Time reversal can undermine the integrity of data tracking and certificate validation and the time must be corrected.'
				);
			}
		}
	}
	return auditStore;
}

export function removeAuditEntry(auditStore: any, auditRecord: AuditRecord): Promise<void> {
	let tombstoneRemoval: Promise<void> | undefined;
	if (auditRecord.type === 'delete') {
		// if this is a delete, we remove the delete entry from the primary table
		// at the same time so the audit table the primary table are in sync, assuming the entry matches this audit record version
		const tableId = auditRecord.tableId;
		const primaryStore = auditStore.tableStores[auditRecord.tableId];
		if (primaryStore?.getEntry(auditRecord.recordId)?.version === auditRecord.version)
			// a failed tombstone removal doesn't mean the audit entry removal failed — only
			// auditStore.remove() below decides this function's outcome
			tombstoneRemoval = new Promise<void>((resolve) => {
				resolve(auditStore.deleteCallbacks?.[tableId]?.(auditRecord.recordId, auditRecord.version));
			}).catch((error) => {
				harperLogger.warn('Error removing deleted record while removing its audit entry', error);
			});
	}
	const auditRemoval = auditStore.remove(auditRecord.key);
	return tombstoneRemoval ? Promise.all([tombstoneRemoval, auditRemoval]).then(() => undefined) : auditRemoval;
}

function updateLastRemoved(auditStore, lastKey) {
	FLOAT_TARGET[0] = lastKey;
	return auditStore.put(Symbol.for('last-removed'), FLOAT_BUFFER);
}

export function getLastRemoved(auditStore) {
	const lastRemoved = auditStore.get(Symbol.for('last-removed'));
	if (lastRemoved) {
		FLOAT_BUFFER.set(lastRemoved);
		return FLOAT_TARGET[0];
	}
}
export function setAuditRetention(retentionTime, defaultDelay = DEFAULT_AUDIT_CLEANUP_DELAY) {
	auditRetention = retentionTime;
	DEFAULT_AUDIT_CLEANUP_DELAY = defaultDelay;
}

/**
 * One-shot purge of transaction-log files already older than the audit retention window,
 * intended to run during startup/recovery before transaction-log replay. The steady-state
 * cleanup loop (scheduleAuditCleanup) only starts once a worker reaches steady state, so a node
 * that crash-loops during recovery never purges and its aged backlog only grows, enlarging the
 * next replay/full-copy. Safe to run before replay: the native purge only deletes log files
 * entirely before the last-flushed-to-RocksDB position, so unflushed entries that replay still
 * needs are never removed. Returns the names of the purged files. See harper#1115.
 */
export function purgeAgedLogs(rootStore: RocksDatabase): string[] {
	// Mirror the read-only guard in scheduleAuditCleanup: never delete log files in read-only mode.
	if (isReadOnlyMode()) return [];
	return rootStore.purgeLogs({ before: Date.now() - auditRetention });
}

const HAS_RECORD = 16;
const HAS_PARTIAL_RECORD = 32; // will be used for CRDTs
const PUT = 1;
const DELETE = 2;
const MESSAGE = 3;
const INVALIDATE = 4;
const PATCH = 5;
const RELOCATE = 6;
const STRUCTURES = 7;
// Whole-table "reload" marker: a control entry (no record) signalling that a table was bulk-reloaded
// and subscribers should re-read it. Used after a copyApply base copy, whose per-row snapshot writes
// carry no audit entry (harper-pro#489). The entry type lives in the low nibble of the action byte
// (decoded via `action & 0xf`); 1–7 are the record actions above, 8 is reload, leaving 9–15 free for
// future actions. Markers are always written LOCAL_ONLY so an unknown type never reaches a peer.
const RELOAD = 8;
export const ACTION_32_BIT = 14;
export const ACTION_64_BIT = 15;
/** Used to indicate we have received a remote local time update */
export const REMOTE_SEQUENCE_UPDATE = 11;
export const HAS_CURRENT_RESIDENCY_ID = 512;
export const HAS_PREVIOUS_RESIDENCY_ID = 1024;
export const HAS_ORIGINATING_OPERATION = 2048;
export const HAS_EXPIRATION_EXTENDED_TYPE = 0x1000;
export const HAS_BLOBS = 0x2000;
export const HAS_ADDITIONAL_AUDIT_REFS = 0x4000;
/**
 * Marks a record (and its audit entry) as local-only: it is persisted on this node but must
 * never be forwarded to replication peers. The bit lives in the record metadata bitmap (and is
 * mirrored into the audit entry's extendedType) so the replication send path can skip it by a
 * bitmask test on the already-decoded metadataFlags/extendedType integer — without decoding the
 * record value (a critical send-path throughput optimization). Bit 15 (0x8000) was confirmed
 * unused across the record metadata bitmap and the audit extendedType space; it sits below the
 * lower-byte action region (which extendedType forbids) and within the always-32-bit metadata form.
 */
export const LOCAL_ONLY = 0x8000;
const EVENT_TYPES = {
	put: PUT | HAS_RECORD,
	[PUT]: 'put',
	delete: DELETE,
	[DELETE]: 'delete',
	message: MESSAGE | HAS_RECORD,
	[MESSAGE]: 'message',
	invalidate: INVALIDATE | HAS_PARTIAL_RECORD,
	[INVALIDATE]: 'invalidate',
	patch: PATCH | HAS_PARTIAL_RECORD,
	[PATCH]: 'patch',
	relocate: RELOCATE,
	[RELOCATE]: 'relocate',
	structures: STRUCTURES,
	[STRUCTURES]: 'structures',
	reload: RELOAD,
	[RELOAD]: 'reload',
	remoteSequenceUpdate: REMOTE_SEQUENCE_UPDATE,
	[REMOTE_SEQUENCE_UPDATE]: 'remoteSequenceUpdate',
};
/**
 * The LMDB audit entry states the presence of its leading 8-byte previousVersion field with that
 * field's own first byte. The same test is what harperdb 4.x's reader uses and what both versions'
 * replication senders use to strip the field before framing an entry for the wire, so it is a
 * cross-version contract, not a local convention: a field written with any other leading byte is
 * skipped by every reader and shifts action/nodeId/tableId/recordId/version by 8. See harper#2247.
 */
const PREVIOUS_VERSION_FIRST_BYTE = 66;
/**
 * Which first bytes can begin an action, and so cannot be a previousVersion field. The single-byte
 * form is an EVENT_TYPES value, optionally with HAS_RECORD cleared for a bodyless mint; the extended
 * form is written with setUint32 as `action | extendedType | 0xc0000000`. 0xff is excluded because
 * Decoder.readInt reads it as a five-byte form this writer never emits.
 */
const ACTION_FIRST_BYTE = new Uint8Array(256);
for (const type in EVENT_TYPES) {
	if (Number.isNaN(Number(type))) {
		const action = EVENT_TYPES[type];
		ACTION_FIRST_BYTE[action] = 1;
		ACTION_FIRST_BYTE[action & ~HAS_RECORD] = 1;
	}
}
for (let firstByte = 0xc0; firstByte < 0xff; firstByte++) ACTION_FIRST_BYTE[firstByte] = 1;
/**
 * Every bit this version can decode out of an action word. Used only to accept or reject a legacy
 * prefix recovery — never to validate a normally-framed entry, where an unknown future flag must
 * stay forwards-compatible rather than corrupt.
 */
const KNOWN_ACTION_FLAGS =
	0xf |
	HAS_RECORD |
	HAS_PARTIAL_RECORD |
	HAS_STRUCTURE_UPDATE |
	HAS_CURRENT_RESIDENCY_ID |
	HAS_PREVIOUS_RESIDENCY_ID |
	HAS_ORIGINATING_OPERATION |
	HAS_EXPIRATION_EXTENDED_TYPE |
	HAS_BLOBS |
	HAS_ADDITIONAL_AUDIT_REFS |
	LOCAL_ONLY;
const ORIGINATING_OPERATIONS = {
	insert: 1,
	update: 2,
	upsert: 3,
	// `put` must be persisted, not inferred: the physical write type is also `put` for an `upsert`
	// that happened to create a record, so the history readers cannot tell the two apart from the
	// type alone. Without an id here the originating operation decoded as undefined, the readers fell
	// back to the physical type, and replication catch-up replayed a `put` as an `upsert` — patching
	// the replica and RETAINING attributes the source had removed.
	put: 4,
	1: 'insert',
	2: 'update',
	3: 'upsert',
	4: 'put',
};

/**
 * Creates a binary audit entry
 * @param txnTime
 * @param tableId
 * @param recordId
 * @param previousVersion
 * @param nodeId
 * @param user
 * @param type
 * @param encodedRecord
 * @param extendedType
 * @param residencyId
 * @param previousResidencyId
 */
export function createAuditEntry(auditRecord: AuditRecord, start = 0) {
	const {
		version,
		tableId,
		recordId,
		previousVersion,
		nodeId,
		user,
		type,
		encodedRecord,
		extendedType,
		residencyId,
		previousResidencyId,
		expiresAt,
		originatingOperation,
		previousAdditionalAuditRefs,
	} = auditRecord;
	let action = EVENT_TYPES[type];
	if (!action) {
		throw new Error(`Invalid audit entry type ${type}`);
	}
	if (action & (HAS_RECORD | HAS_PARTIAL_RECORD) && !encodedRecord?.length) {
		// Readers decode the remainder whenever HAS_RECORD is set, so an audit-only commit minted with
		// no body must not advertise one (#2153). HAS_PARTIAL_RECORD is kept: it also drives
		// record-history reconstruction, and the read path tolerates the empty body.
		if (!warnedBodylessMints.has(`${tableId}:${type}`)) {
			warnedBodylessMints.add(`${tableId}:${type}`);
			// the Error's stack identifies which write path delivered the missing value
			harperLogger.warn(
				`Audit entry (${type}) for record ${recordId} in table ${tableId} has no record body`,
				new Error('bodyless audit mint')
			);
		}
		action &= ~HAS_RECORD;
	}
	let hasPreviousVersion: boolean;
	if (start > 0) {
		// RocksTransactionLogStore states presence with its own prelude flag, derived from this same
		// truthiness, so this container's field stays unconditional and its value is unconstrained.
		hasPreviousVersion = !!previousVersion;
		if (hasPreviousVersion) ENTRY_DATAVIEW.setFloat64(start, previousVersion);
	} else if (previousVersion == null || previousVersion === 0) {
		// absence is stated, not inferred from truthiness: NaN is falsy and would otherwise be
		// silently dropped rather than rejected below
		hasPreviousVersion = false;
	} else {
		ENTRY_DATAVIEW.setFloat64(start, previousVersion);
		if (ENTRY_HEADER[start] !== PREVIOUS_VERSION_FIRST_BYTE) {
			throw new Error(
				`Audit entry previousVersion ${previousVersion} for record ${recordId} in table ${tableId} is not representable. ` +
					'The LMDB audit format signals this field with its own leading 0x42 byte, so only values in [2**33, 2**49) can be written; ' +
					'writing any other value produces an entry every reader parses 8 bytes off.'
			);
		}
		hasPreviousVersion = true;
	}
	let position = start + (hasPreviousVersion ? 9 : 1);
	if (extendedType) {
		if (extendedType & 0xff) {
			throw new Error('Illegal extended type');
		}
		position += 3;
	}

	writeInt(nodeId);
	writeInt(tableId);
	writeValue(recordId);
	// TODO: Once we support multiple format versions, we can conditionally write the version (and the previousResidencyId)
	//	if (formatVersion === 1) {
	ENTRY_DATAVIEW.setFloat64(position, version);
	position += 8;
	if (extendedType & HAS_CURRENT_RESIDENCY_ID) writeInt(residencyId);
	if (extendedType & HAS_PREVIOUS_RESIDENCY_ID) writeInt(previousResidencyId);
	if (extendedType & HAS_EXPIRATION_EXTENDED_TYPE) {
		ENTRY_DATAVIEW.setFloat64(position, expiresAt);
		position += 8;
	}
	if (extendedType & HAS_ORIGINATING_OPERATION) {
		writeInt(ORIGINATING_OPERATIONS[originatingOperation]);
	}
	if (extendedType & HAS_ADDITIONAL_AUDIT_REFS) {
		if (previousAdditionalAuditRefs && previousAdditionalAuditRefs.length > 0) {
			ENTRY_HEADER[position++] = previousAdditionalAuditRefs.length;
			for (const ref of previousAdditionalAuditRefs) {
				ENTRY_DATAVIEW.setFloat64(position, ref.version);
				position += 8;
				writeInt(ref.nodeId);
			}
		} else {
			ENTRY_HEADER[position++] = 0;
		}
	}

	if (user) writeValue(user);
	else ENTRY_HEADER[position++] = 0;
	const actionPosition = start + (hasPreviousVersion ? 8 : 0);
	if (extendedType) ENTRY_DATAVIEW.setUint32(actionPosition, action | extendedType | 0xc0000000);
	else ENTRY_HEADER[actionPosition] = action;
	const header = ENTRY_HEADER.subarray(0, position);
	if (encodedRecord) {
		return Buffer.concat([header, encodedRecord]);
	} else return header;
	function writeValue(value) {
		const valueLengthPosition = position;
		position += 1;
		position = writeKey(value, ENTRY_HEADER, position);
		const keyLength = position - valueLengthPosition - 1;
		if (keyLength > 0x7f) {
			if (keyLength > 0x3fff) {
				harperLogger.error('Key or username was too large for audit entry', value);
				position = valueLengthPosition + 1;
				ENTRY_HEADER[valueLengthPosition] = 0;
			} else {
				// requires two byte length header, need to move the value/key to make room for it
				ENTRY_HEADER.copyWithin(valueLengthPosition + 2, valueLengthPosition + 1, position);
				// now write a two-byte length header
				ENTRY_DATAVIEW.setUint16(valueLengthPosition, keyLength | 0x8000);
				// must adjust the position by one since we moved everything one position
				position++;
			}
		} else {
			// one byte length header, as expected
			ENTRY_HEADER[valueLengthPosition] = keyLength;
		}
	}
	function writeInt(number) {
		if (number < 128) {
			ENTRY_HEADER[position++] = number;
		} else if (number < 0x4000) {
			ENTRY_DATAVIEW.setUint16(position, number | 0x8000);
			position += 2;
		} else if (number < 0x3f000000) {
			ENTRY_DATAVIEW.setUint32(position, number | 0xc0000000);
			position += 4;
		} else {
			ENTRY_HEADER[position] = 0xff;
			ENTRY_DATAVIEW.setUint32(position + 1, number);
			position += 5;
		}
	}
}

/**
 * Reads a audit entry from binary data
 * @param buffer
 * @param start
 * @param end
 */
export function readAuditEntry(buffer: Uint8Array, start = 0, end = undefined): AuditRecord {
	try {
		const decoder =
			(buffer as any).decoder ||
			((buffer as any).decoder = new Decoder(buffer.buffer, buffer.byteOffset, buffer.byteLength));
		decoder.position = start;
		let previousVersion;
		let entryStart = start;
		const firstByte = buffer[start];
		if (firstByte === PREVIOUS_VERSION_FIRST_BYTE) {
			previousVersion = decoder.readFloat64();
		} else if (ACTION_FIRST_BYTE[firstByte] !== 1) {
			// Written before the writer enforced the leading-0x42 contract (harper#2247): the field is
			// physically here but does not announce itself, so the action sits 8 bytes further on.
			// Recover only when the bytes cannot be anything else, and never for the RocksDB container,
			// whose prelude flag already consumed its previousVersion before this offset.
			if (start !== 0 || start + 9 > buffer.byteLength || ACTION_FIRST_BYTE[buffer[start + 8]] !== 1) {
				return corruptEntry(buffer, start, end, firstByte);
			}
			const candidate = decoder.getFloat64(start);
			// > 1 is exactly what the superseded writer's own guard could emit, which is the tightest
			// bound available on "these bytes really are an old previousVersion".
			if (!(candidate > 1)) return corruptEntry(buffer, start, end, firstByte);
			entryStart = decoder.position = start + 8;
			previousVersion = candidate;
		}
		const action = decoder.readInt();
		if (entryStart !== start) {
			if (EVENT_TYPES[action & 0xf] === undefined || action & ~KNOWN_ACTION_FLAGS) {
				return corruptEntry(buffer, start, end, firstByte);
			}
			// 2.0 is what lmdb-js's instructed-write substitution leaves in the slot when no previous
			// time was recorded, so it is a "no previous version" sentinel rather than a log position.
			// Any other recovered value is kept: it may be a real back-edge, and dropping it would
			// truncate the record's history chain.
			if (previousVersion === 2) previousVersion = undefined;
			if (!warnedRecoveredPrefix) {
				warnedRecoveredPrefix = true;
				warnContained('Audit entry carries an unannounced previousVersion field; recovering its field offsets', {
					previousVersion,
					firstByte,
					entry: Buffer.from(buffer.subarray(start, start + 24)).toString('hex'),
				});
			}
		}
		const nodeId = decoder.readInt();
		const tableId = decoder.readInt();
		let length = decoder.readInt();
		// A corrupt length field (e.g., a 0xff-prefixed uint32) would otherwise push
		// decoder.position hundreds of megabytes past the buffer; the next readFloat64
		// then throws with the bogus position in the message. Failing fast here keeps
		// the throw inside this try/catch so we surface a sentinel instead.
		if (length < 0 || decoder.position + length > buffer.byteLength) {
			throw new RangeError(
				`Audit entry recordId length ${length} exceeds remaining buffer (position ${decoder.position}, byteLength ${buffer.byteLength})`
			);
		}
		const recordIdStart = decoder.position;
		const recordIdEnd = (decoder.position += length);
		// TODO: Once we support multiple format versions, we can conditionally read the version (and the previousResidencyId)
		const version = decoder.readFloat64();
		let residencyId, previousResidencyId, expiresAt, originatingOperation, previousAdditionalAuditRefs;
		if (action & HAS_CURRENT_RESIDENCY_ID) {
			residencyId = decoder.readInt();
		}
		if (action & HAS_PREVIOUS_RESIDENCY_ID) {
			previousResidencyId = decoder.readInt();
		}
		if (action & HAS_EXPIRATION_EXTENDED_TYPE) {
			expiresAt = decoder.readFloat64();
		}
		if (action & HAS_ORIGINATING_OPERATION) {
			const operationId = decoder.readInt();
			originatingOperation = ORIGINATING_OPERATIONS[operationId];
		}
		if (action & HAS_ADDITIONAL_AUDIT_REFS) {
			const count = buffer[decoder.position++];
			if (count > 0) {
				previousAdditionalAuditRefs = [];
				for (let i = 0; i < count; i++) {
					const refVersion = decoder.readFloat64();
					const refNodeId = decoder.readInt();
					previousAdditionalAuditRefs.push({ version: refVersion, nodeId: refNodeId });
				}
			}
		}
		length = decoder.readInt();
		if (length < 0 || decoder.position + length > buffer.byteLength) {
			throw new RangeError(
				`Audit entry username length ${length} exceeds remaining buffer (position ${decoder.position}, byteLength ${buffer.byteLength})`
			);
		}
		const usernameStart = decoder.position;
		const usernameEnd = (decoder.position += length);
		let value: any;
		return {
			// The entry type is the low nibble of the action byte (1–7 record actions, 8 reload, 9–15
			// reserved); the flag bits (HAS_RECORD, HAS_PARTIAL_RECORD, …) sit above it. `& 0xf` is
			// identical to the historical `& 7` for every pre-reload entry (bit 3 was always clear).
			type: EVENT_TYPES[action & 0xf],
			tableId,
			nodeId,
			get recordId() {
				// The recordId is decoded lazily and lives outside readAuditEntry's try/catch,
				// so a corrupt recordId region would otherwise escape as an uncaught RangeError
				// on property access. Catch and return undefined; callers already treat missing
				// recordId as a skip-eligible entry.
				try {
					// use a subarray to protect against the underlying buffer being modified
					return readKey(buffer.subarray(0, recordIdEnd), recordIdStart, recordIdEnd);
				} catch (error) {
					harperLogger.warn('Failed to decode audit recordId; treating as corrupt', error);
					return undefined;
				}
			},
			getBinaryRecordId() {
				return buffer.subarray(recordIdStart, recordIdEnd);
			},
			version,
			recordVersion: version,
			previousVersion,
			get user() {
				try {
					return usernameEnd > usernameStart
						? readKey(buffer.subarray(0, usernameEnd), usernameStart, usernameEnd)
						: undefined;
				} catch (error) {
					harperLogger.warn('Failed to decode audit username; treating as corrupt', error);
					return undefined;
				}
			},
			get encoded() {
				// On a recovered entry this drops the unannounced prefix, so a replication sender —
				// which strips by the same leading-0x42 test and frames by encoded.length — forwards a
				// clean entry instead of passing the same misparse to the next hop.
				return entryStart ? buffer.subarray(entryStart, end) : buffer;
			},
			get size() {
				// only the recovered prefix is discounted; every other case keeps its existing basis
				return (end !== undefined ? end - start : buffer.byteLength) - (entryStart - start);
			},
			getValue(store, fullRecord?, auditTime?) {
				if (action & HAS_RECORD || (action & HAS_PARTIAL_RECORD && !fullRecord)) {
					if (decoder.position >= (end ?? buffer.byteLength)) {
						// Entry advertises a record but has no body (minted before #2153): nothing to decode, and
						// return undefined rather than falling through — this branch means the caller asked for the
						// entry's own content (full-record consumers with an auditTime never enter it for partials
						// and still reconstruct below). Warn latched per table: this getter runs inside range scans.
						if (!warnedBodylessTables.has(tableId)) {
							warnedBodylessTables.add(tableId);
							harperLogger.warn(
								`Audit entry (${EVENT_TYPES[action & 0xf]}) for table ${tableId} advertises a record but has no body; treating as having no record`
							);
						}
						return;
					}
					if (!value) {
						value = decodeFromDatabase(
							// the audit value has no on-disk timestamp/metadata prefix (the audit entry carries
							// its own time), so skip the prefix heuristic — otherwise a classic record whose
							// structure-id byte is 66 (0x42) is misread as a rocksdb timestamp. See RecordEncoder.decode.
							() => store.decoder.decode(buffer.subarray(decoder.position, end), { noMetadata: true }),
							store.rootStore
						);
					}
					return value;
				}
				if (action & HAS_PARTIAL_RECORD && auditTime) {
					const recordId = this.recordId;
					return getRecordAtTime(store.getEntry(recordId), auditTime, store, tableId, recordId);
				} // TODO: If we store a partial and full record, may need to read both sequentially
			},
			getBinaryValue() {
				return buffer.subarray(decoder.position, end);
			},
			extendedType: action,
			residencyId,
			previousResidencyId,
			expiresAt,
			originatingOperation,
			previousAdditionalAuditRefs,
		} as any;
	} catch (error) {
		harperLogger.error('Reading audit entry error', error, buffer);
		return createCorruptAuditSentinel(buffer, start, end);
	}
}

/**
 * Reject a header whose first byte can be neither an action nor a previousVersion field. Returns the
 * sentinel directly rather than throwing into readAuditEntry's catch, whose error log is not
 * contained: a throwing log sink there would escape the decoder and stall the iteration it runs in.
 */
function corruptEntry(buffer: Uint8Array, start: number, end: number | undefined, firstByte: number): AuditRecord {
	if (!warnedUndecodableHeader) {
		warnedUndecodableHeader = true;
		warnContained('Audit entry header begins with neither an action nor a previousVersion; treating as corrupt', {
			firstByte,
			entry: Buffer.from(buffer.subarray(start, Math.min(start + 24, buffer.byteLength))).toString('hex'),
		});
	}
	return createCorruptAuditSentinel(buffer, start, end);
}

/**
 * Build a structurally complete audit record for an entry that failed to decode. The fields
 * mirror the happy-path shape so downstream consumers that access (e.g.) `getValue` or the
 * `recordId` getter don't blow up with a `TypeError: not a function` / `undefined.is(...)`
 * after the header decode already failed. Consumers identify these by the undefined
 * `tableId`/`type` (the same signal lmdb has produced from this catch since before this
 * change) and skip them — `classifyAuditEntryForReplay` calls them out as `corrupt-header`,
 * and the dispatch loops in Table.ts / transactionBroadcast.ts filter via tableId guards.
 */
function createCorruptAuditSentinel(buffer: Uint8Array, start: number, end: number | undefined): AuditRecord {
	return {
		type: undefined,
		tableId: undefined,
		nodeId: undefined,
		recordId: undefined,
		version: undefined,
		previousVersion: undefined,
		user: undefined,
		extendedType: undefined,
		residencyId: undefined,
		previousResidencyId: undefined,
		expiresAt: undefined,
		originatingOperation: undefined,
		previousAdditionalAuditRefs: undefined,
		get encoded() {
			return start ? buffer.subarray(start, end) : buffer;
		},
		get size() {
			return start !== undefined && end !== undefined ? end - start : buffer.byteLength;
		},
		getBinaryRecordId() {
			return undefined;
		},
		getValue() {
			return undefined;
		},
		getBinaryValue() {
			return undefined;
		},
	} as any;
}

export class Decoder extends DataView<ArrayBufferLike> {
	position = 0;
	readInt() {
		let number;
		number = this.getUint8(this.position++);
		if (number >= 0x80) {
			if (number >= 0xc0) {
				if (number === 0xff) {
					number = this.getUint32(this.position);
					this.position += 4;
					return number;
				}
				number = this.getUint32(this.position - 1) & 0x3fffffff;
				this.position += 3;
				return number;
			}
			number = this.getUint16(this.position - 1) & 0x7fff;
			this.position++;
			return number;
		}
		return number;
	}
	readFloat64() {
		try {
			const value = this.getFloat64(this.position);
			this.position += 8;
			return value;
		} catch (error) {
			error.message = `Error reading float64: ${error.message} at position ${this.position}`;
			throw error;
		}
	}
}
