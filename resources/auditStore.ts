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
 * Key of this database's audit retention floor. Its *presence* is what marks the floor trustworthy,
 * which is why this is not the retired `last-removed` key: values stored there were written after the
 * removal, and by only one of the five prune paths, so a legacy value cannot be told apart from one
 * carrying the write-ahead and monotonicity guarantees `raiseAuditFloor` now provides.
 */
const AUDIT_FLOOR_KEY = Symbol.for('audit-floor');
/** No trustworthy floor: the highest possible floor, so every cursor compares as stale. */
const AUDIT_FLOOR_UNKNOWN = Infinity;
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
		if (!auditStore) auditStore = rootStore.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
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
			},
		};
	};
	let pendingCleanup = null;
	// resolver of the scheduled-but-not-yet-started pass, so a schedule that supersedes it can hand
	// its callers over to the replacement instead of leaving them on a promise that never settles
	let pendingCleanupResolve: (() => void) | null = null;
	let lastCleanupResolution: Promise<void>;
	let cleanupPriority = 0;
	let auditCleanupDelay = DEFAULT_AUDIT_CLEANUP_DELAY;
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
	 * guessing a delay. Two things it does not promise: a pass removes at most
	 * MAX_DELETES_PER_CLEANUP entries before rescheduling itself, so fulfillment means "that pass
	 * finished", not "the audit log is fully pruned"; and a pass that failed logs and fulfills rather
	 * than rejecting, since this promise doubles as the loop's serialization barrier.
	 */
	function scheduleAuditCleanup(newCleanupDelay?: number): Promise<void> {
		// Skip audit cleanup/purge in read-only mode
		if (isReadOnlyMode()) return Promise.resolve();
		if (auditStore instanceof RocksTransactionLogStore) {
			const before = Date.now() - auditRetention / (1 + cleanupPriority * cleanupPriority);
			try {
				raiseAuditFloor(auditStore, before);
				auditStore.rootStore.purgeLogs({ before });
			} catch (error) {
				// Reclamation calls this without awaiting and this branch has no timer loop to reschedule
				// it, so an escaping throw is an unhandled rejection with no log line. Warn as the LMDB
				// pass below does; a floor already advanced past a failed purge only over-reports.
				harperLogger.warn('Error during audit log purge', error);
			}
			return Promise.resolve();
		}

		if (newCleanupDelay) auditCleanupDelay = newCleanupDelay;
		// the pass we are about to cancel has not started, so its callers are handed over to this one
		const supersededResolve = pendingCleanupResolve;
		clearTimeout(pendingCleanup);
		const resolution = new Promise<void>((resolve) => {
			pendingCleanupResolve = resolve;
			pendingCleanup = setTimeout(async () => {
				pendingCleanupResolve = null; // started, so a later schedule can no longer cancel this pass
				// claim the serialization slot before yielding: assigning it after the await lets every
				// pass released by the same resolution run concurrently over the same range
				const previousCleanup = lastCleanupResolution;
				lastCleanupResolution = resolution;
				await previousCleanup;
				// query for audit entries that are old
				if (auditStore.rootStore.status === 'closed' || auditStore.rootStore.status === 'closing') {
					// nothing to clean up and nothing to reschedule, but leaving `resolution` pending would
					// wedge the loop permanently: it is now the resolution every later pass awaits
					resolve();
					return;
				}
				let deleted = 0;
				try {
					// remove up until the audit retention time, reducing audit retention time if cleanup is higher priority
					const end = Date.now() - auditRetention / (1 + cleanupPriority * cleanupPriority);
					// Probe before raising, so an idle database does not write a floor transaction on every
					// pass forever. `end` is fixed and audit keys only move forward, so an empty probe means
					// the loop below finds nothing either.
					let hasEligibleEntry = false;
					for (const _entry of auditStore.getRange({ start: 1, end, snapshot: false, limit: 1 }))
						hasEligibleEntry = true;
					if (hasEligibleEntry) raiseAuditFloor(auditStore, end);
					for (const auditRecord of auditStore.getRange({
						start: 1, // must not be zero or it will be interpreted as null and overlap with symbols in search
						snapshot: false,
						end,
					})) {
						try {
							// awaited so a rejection (not just a synchronous throw) is caught here instead of
							// escaping as an unhandled rejection once a later iteration's promise replaces this one
							await removeAuditEntry(auditStore, auditRecord);
						} catch (error) {
							harperLogger.warn('Error removing audit entry', error);
						}
						await new Promise(setImmediate);
						if (++deleted >= MAX_DELETES_PER_CLEANUP) {
							// limit the amount we cleanup per event turn so we don't use too much memory/CPU
							auditCleanupDelay = 10; // and keep trying very soon
							break;
						}
					}
				} catch (error) {
					// the timer callback is detached, so anything escaping here lands as an unhandled
					// rejection instead of a log line — and skips the reschedule below with it
					harperLogger.warn('Error during audit log cleanup', error);
				} finally {
					// resolve() first and unconditionally: a throw from the rest of this block must not
					// skip settling `resolution` — that's the serialization barrier every later pass
					// awaits, and never settling it wedges the cleanup loop for the life of the store.
					resolve();
					if (deleted === 0) {
						// if we didn't delete anything, we can increase the delay (double until we get to one tenth of
						// the retention time). Plain arithmetic, not `<<`/`>>`: those coerce to int32, so a
						// sub-millisecond retention collapsed the delay to 0 permanently (0 << 1 is 0), and a
						// retention over ~248 days grows it past 2^31 where halving it wraps negative.
						auditCleanupDelay = Math.max(1, Math.min(auditCleanupDelay * 2, auditRetention / 10, MAX_CLEANUP_DELAY));
					} else {
						// if we did delete something, do updates faster
						if (auditCleanupDelay > 100) auditCleanupDelay = auditCleanupDelay / 2;
					}
					scheduleAuditCleanup();
				}
				// we can run this pretty frequently since there is very little overhead to these queries
			}, auditCleanupDelay).unref();
		});
		if (supersededResolve) resolution.then(supersededResolve);
		return resolution;
	}
	auditStore.scheduleAuditCleanup = scheduleAuditCleanup;
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
	FLOAT_BUFFER.set(stored);
	const floor = FLOAT_TARGET[0];
	return Number.isFinite(floor) && floor >= 0 ? floor : AUDIT_FLOOR_UNKNOWN;
}

/** Own eight bytes per write: the store must never be handed a live view of the reused module buffer. */
function encodeAuditFloor(floor: number): Uint8Array {
	FLOAT_TARGET[0] = floor;
	return FLOAT_BUFFER.slice();
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
	// `=== true` because a RocksDB transactionSync swallows an aborted transaction and returns
	// undefined rather than throwing (see RecordEncoder.saveStructures, which relies on the same
	// contract). Treating that as success is the fail-open this floor exists to close: the caller
	// would go on to prune with no durable record that it did.
	const committed =
		auditStore instanceof RocksTransactionLogStore
			? transactionOwner.transactionSync(
					(txn) => {
						const stored = txn.getBinarySync(AUDIT_FLOOR_KEY);
						const floor = resolve(decodeAuditFloor(stored), stored !== undefined);
						if (floor !== undefined) txn.putSync(AUDIT_FLOOR_KEY, asBinary(encodeAuditFloor(floor)));
						return true;
					},
					{ retryOnBusy: true }
				)
			: transactionOwner.transactionSync(() => {
					const stored = auditStore.getBinary(AUDIT_FLOOR_KEY);
					const floor = resolve(decodeAuditFloor(stored), stored !== undefined);
					// asBinary: a legacy standalone audit root's encoder has no Uint8Array passthrough, so raw
					// bytes would reach createAuditEntry and throw. This bypasses both encoders.
					if (floor !== undefined) auditStore.putSync(AUDIT_FLOOR_KEY, asBinary(encodeAuditFloor(floor)));
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
	// Lock-free pre-check: most calls cannot move the floor (a RocksDB reclamation pass on an idle
	// database, a cutoff below one a wider prune already set), and taking the env write lock to
	// discover that serializes every worker's boot and reclamation on it. The in-transaction guard
	// below stays authoritative.
	// getBinary-guarded so this optimization never decides the error a store with no audit store
	// reports.
	if (auditStore?.getBinary && !(cutoff > getAuditFloor(auditStore))) return;
	updateAuditFloor(auditStore, (current) => (cutoff > current ? cutoff : undefined));
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
	// so take whichever is later. (openAuditStore separately error-logs the reversal itself.)
	let epoch = Date.now();
	for (const newest of auditStore.getKeys({ reverse: true, limit: 1 })) {
		if (typeof newest === 'number' && newest > epoch) epoch = newest;
	}
	try {
		updateAuditFloor(auditStore, (_current, recorded) => (recorded ? undefined : epoch));
	} catch (error) {
		// Never fail a database open over this. An unrecorded floor already reads as unknown, which is
		// the fail-closed answer; aborting startup instead would turn a metadata write failure into an
		// outage. The next open retries.
		harperLogger.warn('Could not establish the audit retention floor; it will read as unknown', error);
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
 * Under the storage-pressure retention shrink (`auditRetention / (1 + priority²)`) this reports
 * post-hoc reality rather than the configured window — that is the contract, not an approximation
 * of it.
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
