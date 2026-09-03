import { readKey, writeKey } from 'ordered-binary';
import { initSync, get as envGet } from '../utility/environment/environmentManager.ts';
import { AUDIT_STORE_NAME } from '../utility/lmdb/terms.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { convertToMS } from '../utility/common_utils.ts';
import { PREVIOUS_TIMESTAMP_PLACEHOLDER, LAST_TIMESTAMP_PLACEHOLDER } from './RecordEncoder.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import { getRecordAtTime } from './crdt.ts';
import { decodeFromDatabase } from './blob.ts';
import { onStorageReclamation } from '../server/storageReclamation.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { asBinary } from 'lmdb';
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
const FLOAT_TARGET = new Float64Array(1);
const FLOAT_BUFFER = new Uint8Array(FLOAT_TARGET.buffer);
/**
 * Key of this database's audit retention floor — the staleness horizon `getAuditFloor` reports.
 * Its *presence* is what marks the floor trustworthy, which is why it is not the `last-removed`
 * marker above: that one is written after its removals and by only one of the five prune paths, so a
 * value found there cannot be told apart from one carrying the write-ahead and monotonicity
 * guarantees `raiseAuditFloor` provides. The two coexist deliberately and answer different
 * questions.
 */
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');
/**
 * The floor's own eight bytes, deliberately NOT the FLOAT_TARGET/FLOAT_BUFFER pair the `last-removed`
 * marker uses: decoding a floor writes into its buffer on every read, including the pre-check on each
 * prune, while `updateLastRemoved` hands the shared buffer to an async `put` it has not yet consumed.
 * Sharing them would let a floor read rewrite a marker still in flight.
 */
const FLOOR_TARGET = new Float64Array(1);
const FLOOR_BUFFER = new Uint8Array(FLOOR_TARGET.buffer);
/** No trustworthy floor: the highest possible floor, so every cursor compares as stale. */
const AUDIT_FLOOR_UNKNOWN = Infinity;

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
	establishAuditFloor(auditStore);
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
						const before = Date.now() - auditRetention / (1 + passCleanupPriority * passCleanupPriority);
						raiseAuditFloor(auditStore, before);
						auditStore.rootStore.purgeLogs({ before });
					} else {
						// Driven explicitly rather than with for-of: this loop suspends on the awaits below, and a
						// close landing mid-pass closes the env under it. for-of calls next() before the body, so a
						// check inside the body advances the cursor first — the guard has to precede every next().
						// remove up until the audit retention time, reducing audit retention time if cleanup is higher priority
						const end = Date.now() - auditRetention / (1 + passCleanupPriority * passCleanupPriority);
						// Probe before raising, so an idle database does not write a floor transaction on every
						// pass forever. `end` is fixed and audit keys only move forward, so an empty probe means
						// the loop below finds nothing either.
						const entries = auditStore
							.getRange({
								start: 1, // must not be zero or it will be interpreted as null and overlap with symbols in search
								snapshot: false,
								end,
							})
							[Symbol.iterator]();
						try {
							// Raised off the first eligible entry rather than a separate probe range: one cursor,
							// so a pass over an idle database writes no floor at all, and nothing else observing
							// this range sees an extra advance. Still strictly before any removal — see
							// raiseAuditFloor.
							let floorRaised = false;
							while (!cleanupStopped && !storeClosing()) {
								const entry = entries.next();
								if (entry.done) break;
								const auditRecord = entry.value;
								if (!floorRaised) {
									raiseAuditFloor(auditStore, end);
									floorRaised = true;
								}
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
/**
 * Read the recorded floor, normalizing anything we cannot trust to AUDIT_FLOOR_UNKNOWN. Reads bytes
 * rather than going through the store's value decoder, which would read these eight raw float bytes
 * as an audit entry (and as msgpack on RocksDB). Callers get a number in every case: a NaN or
 * negative floor read as a number would make one of `cursor >= floor` / `cursor < floor` report
 * safety, and which of the two a consumer writes must not decide whether corrupt metadata fails
 * closed.
 */
function decodeAuditFloor(stored: any): number {
	// RocksDB's getBinarySync is typed to also return a length; anything that is not exactly the
	// eight bytes we write is metadata written by something else.
	if (stored?.byteLength !== 8) return AUDIT_FLOOR_UNKNOWN;
	FLOOR_BUFFER.set(stored);
	const floor = FLOOR_TARGET[0];
	// `Object.is` for -0, which passes `>= 0` and would then read as a permissive zero — every cursor
	// safe — from bytes with the sign bit set that nothing here writes. raiseAuditFloor rejects the
	// same value as a cutoff; the read side has to agree or corrupt metadata fails open.
	if (!Number.isFinite(floor) || floor < 0 || Object.is(floor, -0)) return AUDIT_FLOOR_UNKNOWN;
	return floor;
}

/**
 * Did the floor write land? A record has to be PRESENT, not merely decode to the value we wrote:
 * `decodeAuditFloor(undefined)` is the unknown sentinel too, so on a floorless store — where the
 * resolver writes exactly that sentinel — comparing decoded values alone reported a commit for a
 * write that never happened, and the caller pruned with nothing persisted.
 */
function floorWriteLanded(stored: any, floor: number): boolean {
	return stored !== undefined && decodeAuditFloor(stored) === floor;
}

/** Own eight bytes per write: the store must never be handed a live view of the reused module buffer. */
function encodeAuditFloor(floor: number): Uint8Array {
	FLOOR_TARGET[0] = floor;
	return FLOOR_BUFFER.slice();
}

/**
 * Read-modify-write the floor under one store transaction. `resolve` receives the recorded floor
 * (AUDIT_FLOOR_UNKNOWN when there is none) and returns the value to store, or undefined to leave it
 * alone. The transaction is the point: pruning is not confined to one worker — the retention loop,
 * a boot purge, `deleteHistory` and `delete_transaction_logs_before` can all advance the floor — and
 * two unsynchronized read-then-writes can interleave so the lower cutoff lands last, leaving a floor
 * below history the higher one already removed. In read-only mode nothing is written, which is
 * consistent because nothing is pruned there either.
 */
function updateAuditFloor(auditStore: any, resolve: (current: number, recorded: boolean) => number | undefined): void {
	// A legacy `auditPath` layout is opened as its own standalone LMDB root (databases.ts) and has no
	// `.rootStore`, so it owns the transaction itself.
	const transactionOwner = auditStore?.rootStore ?? auditStore;
	if (!transactionOwner?.transactionSync)
		throw new Error('Cannot record the audit retention floor: this database has no audit store');
	// Both branches read their own write back and report `false` on mismatch, and the caller below
	// demands an explicit `true`. Neither half of that is belt-and-braces:
	//  - a RocksDB transactionSync swallows an aborted transaction and returns undefined rather than
	//    throwing (see RecordEncoder.saveStructures, which relies on the same contract), so a missing
	//    `=== true` reads an uncommitted write as success;
	//  - and a write that fails without throwing would otherwise be indistinguishable from one that
	//    landed, which is the fail-open this floor exists to close — a caller that prunes against a
	//    floor never recorded. The LMDB half provably needs it (its containment for a replaced `put`
	//    cannot tell a rejection from a failure); the RocksDB half is verified the same way rather
	//    than resting on the assumption that a native putSync always throws.
	// Reads inside a write transaction see that transaction's own writes on both engines (measured),
	// so the read-back observes what commit will make durable.
	const committed =
		auditStore instanceof RocksTransactionLogStore
			? transactionOwner.transactionSync(
					(txn) => {
						const stored = txn.getBinarySync(AUDIT_FLOOR_KEY);
						const floor = resolve(decodeAuditFloor(stored), stored !== undefined);
						if (floor !== undefined) {
							txn.putSync(AUDIT_FLOOR_KEY, asBinary(encodeAuditFloor(floor)));
							if (!floorWriteLanded(txn.getBinarySync(AUDIT_FLOOR_KEY), floor)) return false;
						}
						return true;
					},
					{ retryOnBusy: true }
				)
			: transactionOwner.transactionSync(() => {
					const stored = auditStore.getBinary(AUDIT_FLOOR_KEY);
					const floor = resolve(decodeAuditFloor(stored), stored !== undefined);
					// `put` rather than `putSync`, and inside the transaction: lmdb's putSync is itself
					// `put(...) === SYNC_PROMISE_SUCCESS`, so it drops whatever put returns — and a put that
					// hands back a real rejection (a replaced one, as the marker-failure fixtures install)
					// leaks it with no owner. Within a write transaction put writes synchronously and returns
					// an already-resolved sentinel, so the value is visible immediately either way and this
					// only takes ownership of the failure case.
					// asBinary: a legacy standalone audit root's encoder has no Uint8Array passthrough, so raw
					// bytes would reach createAuditEntry and throw. This bypasses both encoders.
					if (floor !== undefined) {
						auditStore
							.put(AUDIT_FLOOR_KEY, asBinary(encodeAuditFloor(floor)))
							?.catch?.((error) => warnContained('Error writing the audit retention floor', error));
						if (!floorWriteLanded(auditStore.getBinary(AUDIT_FLOOR_KEY), floor)) return false;
					}
					return true;
				});
	if (committed !== true) throw new Error('The audit retention floor transaction did not commit');
}

/**
 * Raise the floor to `cutoff`, the exclusive lower bound of the history a prune is about to make
 * unreachable.
 *
 * **Call this before removing anything.** A floor written after the removal is lost if the process
 * dies in between, and the surviving lower floor then certifies a cursor whose history is gone.
 * Ordering it first also means it covers a prune that removes less than `cutoff` spans — a RocksDB
 * purge that finds no whole droppable file, a retention pass that stops at MAX_DELETES_PER_CLEANUP
 * with a large backlog still eligible. Over-reporting costs a consumer one unnecessary resync;
 * under-reporting loses its data silently. The over-report is also bounded by the thing that already
 * bounds the promise: the retention paths pass `Date.now() - auditRetention`, so the floor never
 * climbs above the horizon `logging.auditRetention` already declines to retain past.
 *
 * Throws if the floor cannot be persisted, which is why it is called first — the throw is what stops
 * the prune from proceeding unrecorded. Never lowers the floor, so a narrower prune cannot undo a
 * wider one, and a store whose floor is unknown stays unknown rather than being talked down to a
 * cutoff that says nothing about the history it has already lost.
 */
export function raiseAuditFloor(auditStore: any, cutoff: number): void {
	// Throw rather than no-op on a bound we will not store. A NaN or negative cutoff is NOT harmless
	// here: transactionKeyEncoder writes keys as raw float64, so NaN (0x7FF8…) and negatives (sign bit
	// set) sort ABOVE every real timestamp, and `getRange({ start: 1, end: NaN })` therefore spans the
	// whole log. `delete_transaction_logs_before` reaches that via Number.parseInt on a non-numeric
	// timestamp, so silently declining the floor update would leave the prune deleting everything.
	// Infinity is different and IS stored: `deleteHistory(Infinity)` legitimately removes all history,
	// and Infinity decodes back to "unknown", leaving no cursor reading as safe.
	// `-0` and a non-number slip past a naive `< 0` check but are still ordered keys the range honors:
	// -0 sets the float64 sign bit and a non-number takes the ordered-binary branch of the key encoder,
	// so both sort outside the timestamp space the prune means to bound.
	if (typeof cutoff !== 'number' || Number.isNaN(cutoff) || cutoff < 0 || Object.is(cutoff, -0))
		throw new Error(`Invalid audit prune bound: ${String(cutoff)}`);
	// Read-only mode does not exempt a prune from recording its floor; it means the prune must not
	// happen. Only scheduleAuditCleanup and purgeAgedLogs check read-only themselves, so for
	// deleteHistory and the whole-database purge this throw is the guard.
	if (isReadOnlyMode()) throw new Error('Cannot record the audit retention floor: the database is read-only');
	// Lock-free pre-check, getBinary-guarded so this optimization never decides the error a store with
	// no audit store reports. Most calls cannot move the floor (a RocksDB reclamation pass on an idle
	// database, a cutoff below one a wider prune already set), and taking the env write lock to
	// discover that serializes every worker's boot and reclamation on it. The in-transaction guards
	// below stay authoritative.
	// Skips only the case it can prove is a no-op: a record that exists and already sits at or above
	// the cutoff. An absent record is NOT decided here — the presence question is settled inside the
	// transaction below, because another worker's establishAuditFloor can land between this read and
	// that write.
	if (auditStore?.getBinary) {
		const stored = auditStore.getBinary(AUDIT_FLOOR_KEY);
		if (stored !== undefined && !(cutoff > decodeAuditFloor(stored))) return;
	}
	updateAuditFloor(auditStore, (current, recorded) => {
		// Still no record, and we are about to prune: persist the unknown sentinel. Leaving no marker
		// lets the next open stamp a FINITE epoch, and a prune bound above that epoch (a future
		// `endTime`, or a rolled-back clock) then certifies cursors whose history this prune deleted.
		// Unknown is the honest value, because a store with no record may have been pruned before this
		// run too.
		if (!recorded) return AUDIT_FLOOR_UNKNOWN;
		// A record appeared while we were getting here, so this is an ordinary monotonic raise: pruning
		// to `cutoff` against a floor left below it is exactly the silent gap this function prevents.
		return cutoff > current ? cutoff : undefined;
	});
}

/**
 * Give a database a trustworthy floor if it has none: the current time, as a one-time resync epoch.
 *
 * The floor record's *presence* is the trust marker, so a store without one is a store whose
 * retention history we cannot account for. It may have been pruned by a version that recorded no
 * floor; it may be the empty audit store an LMDB→RocksDB migration deliberately leaves behind
 * (`bin/copyDb.ts` does not migrate it, so the records and their resumable cursors outlive their
 * history); or it may be a database restored from a table-scoped backup taken without
 * `include_audit`, which carries records but no audit DBI. Cursors from before this moment are
 * therefore reported stale — not because we know they are, but because we do not know they are not.
 *
 * There is no "brand new store, use a permissive baseline" case: creating the audit DBI proves only
 * that the DBI was absent, which the audit-less backup above also produces. Being conservative on a
 * genuinely new database costs nothing, since its entries are all written after this instant.
 *
 * In read-only mode nothing is written and the floor stays unknown — the fail-closed answer for a
 * process that cannot record what it does not know.
 */
export function establishAuditFloor(auditStore: any): void {
	if (isReadOnlyMode()) return;
	// Every read and write in here is inside the try: the contract is that a database open never fails
	// over this metadata, and a throwing getBinary/getKeys would escape to initStores just as a
	// throwing write would.
	try {
		// Absence of the record, not `getAuditFloor() === AUDIT_FLOOR_UNKNOWN`: a record that exists but
		// decodes to unknown — corrupt bytes, or the Infinity a prune-everything stored — is already the
		// fail-closed answer, and stamping over it would LOWER a floor that is never supposed to lower.
		// The check is repeated inside the transaction (the `recorded` argument), because between this
		// read and that write another worker's prune can store exactly such a value; this read only keeps
		// the common case — a floor already established, every worker, every database, every boot — off
		// the env write lock.
		if (auditStore.getBinary(AUDIT_FLOOR_KEY) !== undefined) return;
		// Not bare Date.now(): a clock that has rolled back would bootstrap a floor BELOW history this
		// database may already have pruned, certifying a stale cursor. The newest retained entry is a
		// lower bound the clock cannot argue with — everything at or above it is demonstrably still here —
		// so take whichever is later.
		//
		// It narrows that hole; it does not close it, because the bound covers what SURVIVES rather than
		// what existed. A legacy `deleteHistory` removes one table's entries below its endTime out of the
		// shared log, so a table whose entries were the newest and all fell below that bound leaves the
		// log's newest survivor being a sibling's OLDER entry — removed history above every surviving key.
		// A clock rolled back to between the two then stamps an epoch below entries that are gone, and a
		// cursor in that window resumes over the gap. Nothing in surviving state distinguishes that case,
		// which is why the alternative is `AUDIT_FLOOR_UNKNOWN` for every unmarked store rather than a
		// smarter bound (cb1kenobi on #2458). Also unclosed: RocksTransactionLogStore.getKeys() is
		// unimplemented, so on that engine this reduces to Date.now() outright.
		//
		// Both are accepted costs of stamping rather than leaving a floorless store permanently unknown,
		// which would make every upgraded deployment fail closed forever — a recorded ruling in #2458's
		// decision log, not an oversight.
		let epoch = Date.now();
		for (const newest of auditStore.getKeys({ reverse: true, limit: 1 })) {
			if (typeof newest === 'number' && newest > epoch) epoch = newest;
		}
		updateAuditFloor(auditStore, (_current, recorded) => (recorded ? undefined : epoch));
	} catch (error) {
		// An unrecorded floor already reads as unknown, which is the fail-closed answer; aborting startup
		// instead would turn a metadata failure into an outage. The next open retries.
		warnContained('Error initializing the audit retention floor', error);
	}
}

/**
 * The floor of this database's retained audit history: every audit entry at or after the returned
 * time is still retained, so a consumer whose last-processed cursor is `>=` it can resume
 * incrementally, and one below it has lost history it needs and must resync. Returns `Infinity` when
 * the floor is unknown, which fails closed — no cursor compares as safe.
 *
 * The time domain is the audit-log key: what `subscribe`'s events carry as `localTime` and what MQTT
 * durable sessions persist as `startTime`, so those compare against the floor directly.
 * **`getHistory` is not in that domain** — it reports each entry's origin `version` under the name
 * `localTime`, which a backdated or replicated write makes differ from the audit-log key. A cursor
 * saved from `getHistory` is not comparable to this floor.
 *
 * **Database-scoped**, and deliberately conservative: the audit store is per-database and its
 * entries carry a `tableId`, so a per-table floor would need a scan for the first entry matching
 * that table. `cursor >= floor` therefore means no entry of *any* table in the database was removed
 * below the cursor. `Table.deleteHistory` prunes one table out of that shared log and raises the
 * whole database's floor, which can overstate the floor for its siblings.
 *
 * **A moment-in-time observation.** Retention can advance between this call and whatever the caller
 * does with the answer, so a check-then-resume sequence has a window where the floor moves under it.
 * Closing that requires validating the cursor inside the resume itself (harper#2448); until then a
 * lost race degrades to the truncation that happens today, never to anything worse.
 *
 * **On RocksDB the floor tracks the configured horizon, not retained reality.** That branch purges at
 * whole-log-file granularity, so it cannot know before the fact which entries a purge will drop, and
 * the floor has to be written first — so every retention pass advances it to
 * `Date.now() - auditRetention / (1 + priority²)` whether or not a file was dropped. Entries below
 * that horizon are routinely still on disk, and a consumer holding a cursor among them is told to
 * resync. Conservative in the one safe direction, and the reason the LMDB branch (which can see a
 * single eligible entry) instead raises off the first one it finds.
 *
 * **Not covered: copying a database's state without its history.** `restore_backup` replaces a
 * database with the backup's, floor and all, and a RocksDB checkpoint (a branch database) copies the
 * floor record but no transaction logs — so in both cases a cursor from after the copy point sits
 * above a floor that is present, and therefore trusted, for history that is not there. Nothing here
 * can detect that on its own, and it is not the audit log's problem alone: the same copy rolls back
 * record versions and per-node replication sequence state, so making this one field honest while
 * those stay stale would not give a consumer a coherent answer. It needs a database-level epoch —
 * harper#2451.
 */
export function getAuditFloor(auditStore: any): number {
	return decodeAuditFloor(auditStore.getBinary(AUDIT_FLOOR_KEY));
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
	const before = Date.now() - auditRetention;
	// The audit store is reachable this early because initStores opens it before replayLogs runs this.
	raiseAuditFloor((rootStore as any).auditStore, before);
	return rootStore.purgeLogs({ before });
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
	let position = start + 1;
	if (previousVersion) {
		if (previousVersion > 1) ENTRY_DATAVIEW.setFloat64(start, previousVersion);
		else ENTRY_HEADER.set(PREVIOUS_TIMESTAMP_PLACEHOLDER, start);
		position = start + 9;
	}
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
	if (extendedType) ENTRY_DATAVIEW.setUint32(start + (previousVersion ? 8 : 0), action | extendedType | 0xc0000000);
	else ENTRY_HEADER[start + (previousVersion ? 8 : 0)] = action;
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
		if (buffer[decoder.position] == 66) {
			// 66 is the first byte in a date double.
			previousVersion = decoder.readFloat64();
		}
		const action = decoder.readInt();
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
				return start ? buffer.subarray(start, end) : buffer;
			},
			get size() {
				return start !== undefined && end !== undefined ? end - start : buffer.byteLength;
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
