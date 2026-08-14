import { RocksDatabase } from '@harperfast/rocksdb-js';
import { Resource } from './Resource.ts';
import type { Context } from './ResourceInterface.ts';
import * as logger from '../utility/logging/harper_logger.js';
import { DatabaseTransaction } from './DatabaseTransaction.ts';
import { RocksTransactionLogStore } from './RocksTransactionLogStore.ts';
import { isMainThread } from 'node:worker_threads';
import { RequestTarget } from './RequestTarget.ts';
import {
	classifyAuditEntryForReplay,
	isUndecodableValidatedWrite,
	shouldAbortStalledReplay,
	shouldAbortSlowReplay,
	shouldFlushReplayBatch,
	REPLAY_WALL_CLOCK_LIMIT_MS,
	REPLAY_WRITE_OVERHEAD_BYTES,
} from './replayLogsGuards.ts';
import { purgeAgedLogs } from './auditStore.ts';
import { get as envGet } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

let warnedReplayHappening = false;

// Records the source-transaction version that replay is committing in pieces, so the next boot knows
// which version it may have resumed into (harper#2161). Written before the batch it describes and
// cleared once that version has been applied in full, so the durable state errs toward "torn": a
// spurious marker only widens the tie handling in DatabaseTransaction.partiallyCommitted for one
// version, while a missing one would let a later same-key write be dropped as a duplicate.
const TORN_VERSION_KEY = Symbol.for('replay-torn-version');

function readTornVersion(rootStore: RocksDatabase): number | undefined {
	try {
		return (rootStore as any).getSync(TORN_VERSION_KEY) || undefined;
	} catch (error) {
		logger.warn('Could not read the replay torn-transaction marker', error);
	}
}

function recordTornVersion(rootStore: RocksDatabase, version: number): void {
	try {
		(rootStore as any).putSync(TORN_VERSION_KEY, version);
	} catch (error) {
		logger.warn('Could not record the replay torn-transaction marker', error);
	}
}

// True when `updated` would DROP shared structures relative to `existing` — for either the classic
// array form or the {named, typed} Map form, and for a form change between the two. Shared
// structures only ever grow (ids are stable and append-only), so a shorter replayed buffer is a
// stale/older entry. Used to refuse a downgrade of the durable structures dictionary during replay:
// since the composite key is the one RecordEncoder.getStructures reads, overwriting it with fewer
// structures would drop ids the decoder still needs and make existing records decode to null. This
// mirrors saveStructures' compatibility reject (RecordEncoder.ts). See harper-pro#362.
export function structuresWouldShrink(existing: any, updated: any): boolean {
	if (Array.isArray(existing)) {
		return !Array.isArray(updated) || updated.length < existing.length;
	}
	if (existing && typeof existing.get === 'function') {
		if (!updated || typeof updated.get !== 'function') return true;
		return (
			(updated.get('named')?.length ?? 0) < (existing.get('named')?.length ?? 0) ||
			(updated.get('typed')?.length ?? 0) < (existing.get('typed')?.length ?? 0)
		);
	}
	return false;
}

export function replayLogs(rootStore: RocksDatabase, tables: any): Promise<void> {
	if (!isMainThread) return; // ideally we don't do it like this, but for now this is predictable
	return new Promise((resolve) => {
		const acquired = rootStore.tryLock('replayLogs', async () => {
			resolve();
		});
		if (!acquired) return;
		// Shed transaction-log files already older than the audit retention window before
		// replaying. A node that crash-loops during recovery never reaches the steady-state
		// cleanup loop, so without this its aged backlog only grows and enlarges each subsequent
		// replay/full-copy. The native purge keeps any file holding unflushed entries, so this
		// never drops data the replay below still needs. See harper#1115.
		// Purging is a non-critical optimization, so a purge failure (filesystem/permission/native
		// error) must never block the critical replay path that follows — especially here, during
		// the recovery this fix is meant to harden.
		let purgedLogs: string[] = [];
		try {
			purgedLogs = purgeAgedLogs(rootStore);
		} catch (error) {
			logger.warn(
				`Failed to purge aged transaction logs before replay in ${(rootStore as any).databaseName} database`,
				error
			);
		}
		if (purgedLogs.length > 0) {
			logger.info(
				`Purged ${purgedLogs.length} aged transaction-log file(s) before replay in ${(rootStore as any).databaseName} database`
			);
		}
		const tableById = new Map<number, typeof Resource>();
		for (const tableName in tables) {
			const table = tables[tableName];
			tableById.set(table.tableId, table);
		}
		// replay all the logs
		let transaction: DatabaseTransaction;
		let lastTimestamp = 0;
		let writes = 0;
		let skipped = 0;
		// Staged since the last commit, so the batch can be committed before it exhausts heap
		// (harper#2161). The byte figure is an estimate: the audit entry's own size, the prior record
		// each staged write retains, and a fixed per-write overhead for the rest (write operation,
		// key, index staging).
		let stagedBytes = 0;
		let stagedWrites = 0;
		let midVersionFlushes = 0;
		// The version being replayed has already had part of itself committed by THIS run.
		let versionCommittedInPieces = false;
		// The version a previous replay left committed in pieces, if any (see recordTornVersion): a durable
		// fact rather than an assumption, so a replay that never tore anything keeps the identity-tie dedup
		// for every version it applies.
		const resumedTornVersion = readTornVersion(rootStore);
		// True when what is about to be committed, or has just been committed, is only part of its source
		// transaction — the state in which losing a batch, or dropping a later same-key write, tears it.
		const committingVersionIsTorn = () => versionCommittedInPieces || lastTimestamp === resumedTornVersion;
		// Track forward progress so a backlog of unwritable entries can't grind the boot thread
		// forever (harper#1266). `noProgressRun` counts every entry processed without a successful
		// write since the last one — undecodable/corrupt skips AND entries for a dropped table — and
		// is reset to 0 the moment a write succeeds, so the stall bound only fires on a genuinely
		// write-free run.
		let noProgressRun = 0;
		const replayStartTime = performance.now();
		let lastProgressTime = replayStartTime;
		// Total wall-clock budget (ms) for replay, configurable via `replication.replayTimeout`;
		// falls back to the 10-minute default (harper#1316).
		const configuredReplayTimeout = Number(envGet(CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT));
		const replayTimeoutMs = configuredReplayTimeout > 0 ? configuredReplayTimeout : REPLAY_WALL_CLOCK_LIMIT_MS;
		const txnLog: RocksTransactionLogStore = (rootStore as any).auditStore;
		for (const auditRecord of txnLog.getRange({ startFromLastFlushed: true, readUncommitted: true }) as any) {
			if (noProgressRun > 0 && shouldAbortStalledReplay(noProgressRun, performance.now() - lastProgressTime)) {
				logger.fatal(
					`Aborting transaction-log replay in ${(rootStore as any).databaseName} database: ${noProgressRun} consecutive audit entries with no successful write (${skipped} skipped as unrecoverable, ${writes} replayed so far). This backlog is making no forward progress and was blocking startup (harper#1266) — typically a peer transaction log whose values reference unresolvable shared structures (harper#1163), or a backlog for a dropped table. Continuing boot without replaying the remainder; shed or relocate the oversized/undecodable peer transaction log(s), or re-clone this node, to recover the unreplayed data.`
				);
				break;
			}
			const {
				type,
				tableId,
				nodeId,
				recordId,
				version,
				residencyId,
				expiresAt,
				originatingOperation,
				username,
				extendedType,
			} = auditRecord;
			try {
				if (classifyAuditEntryForReplay(extendedType, tableId, true) === 'corrupt-header') {
					skipped++;
					noProgressRun++;
					continue;
				}
				const Table = tableById.get(tableId);
				if (!Table) {
					// Entry for a table this node no longer has (dropped/foreign). Not an
					// unrecoverable skip, but still a no-progress entry — a large backlog of them
					// must trip the stall bound rather than grind the boot thread.
					noProgressRun++;
					continue;
				}
				const { primaryStore } = Table as any;
				let record: any;
				try {
					record = auditRecord.getValue(primaryStore);
				} catch {
					// msgpack/structure decode failed for this entry's value. Skip rather than
					// fall through to a guaranteed downstream crash, and intentionally drop the
					// error: every corrupt entry would otherwise log a stack trace per iteration
					// (millions of these were observed in prod). The total skip count is logged
					// once at the end of replay.
					skipped++;
					noProgressRun++;
					continue;
				}
				if (
					classifyAuditEntryForReplay(extendedType, tableId, record !== undefined) === 'missing-record' ||
					isUndecodableValidatedWrite(type, record)
				) {
					skipped++;
					noProgressRun++;
					continue;
				}
				// Entry is replayable: build the context and instantiate the resource only now, so
				// the skip paths above never pay those per-entry allocations (harper#1266).
				const context: Context = {
					nodeId,
					alreadyLogged: true,
					version,
					expiresAt,
					user: { username },
				} as any;
				const target = new RequestTarget();
				target.id = null;
				const tableInstance: any = Table.getResource(target, context, {});
				// TODO: If this throws an error due to being unable to access structures, we need to iterate through
				// other transaction logs to get the latest structure. Ultimately we may have to skip records
				if (!warnedReplayHappening) {
					warnedReplayHappening = true;
					console.warn('Harper was not properly shutdown, replaying transaction logs to synchronize database');
				}
				const newVersion = lastTimestamp !== version;
				// A version's writes all stage into one transaction, so a version carrying a very large
				// number of them has no memory bound at all (harper#2161). Committing mid-version is safe
				// for replay, and only for replay: what a crash leaves torn is re-applied on the next boot,
				// from the log's last-flushed position and in timestamp order. The decision includes this
				// entry, so the batch overshoots the bound by at most the one write that crosses it.
				const entryCost = (auditRecord.size ?? 0) + REPLAY_WRITE_OVERHEAD_BYTES;
				if (newVersion || shouldFlushReplayBatch(stagedBytes + entryCost, stagedWrites + 1)) {
					// Marked before the batch it describes is committed, so a crash between the two records a
					// tear that did not happen rather than missing one that did.
					if (!newVersion && !versionCommittedInPieces && version !== resumedTornVersion) {
						recordTornVersion(rootStore, version);
					}
					const wasTorn = committingVersionIsTorn();
					try {
						// commit what is staged; a new transaction is started below
						transaction?.directCommitSync();
					} catch (error) {
						// The condition is "the transaction being committed was already committed in part",
						// not "this is a mid-version commit": the batch that fails can equally be the last
						// batch of a version torn earlier — by this run or by the run before it — reached at
						// the version boundary. Continuing then boots the node with a hole punched through one
						// source transaction: this batch is lost, the iterator never revisits it (replay
						// restarts from the log's last-flushed position, which a failed commit does not
						// rewind), and later versions land on top of the gap.
						if (!newVersion || wasTorn) {
							logger.fatal(
								`Aborting transaction-log replay in ${(rootStore as any).databaseName} database: a batch of an oversized transaction failed to commit (${writes} written, ${skipped} skipped). Continuing would apply later writes over writes that were never committed. Re-clone this node from a healthy leader to recover the unreplayed data.`,
								error
							);
							transaction = undefined as any;
							break;
						}
						logger.error('Error committing replay transaction', error);
					}
					if (newVersion) {
						// The version that just committed is whole again, so clear its marker.
						if (wasTorn) recordTornVersion(rootStore, 0);
						versionCommittedInPieces = false;
					} else {
						midVersionFlushes++;
						versionCommittedInPieces = true;
					}
					lastTimestamp = version;
					stagedBytes = 0;
					stagedWrites = 0;
					// Abort if replay has exceeded the total wall-clock budget even while making progress
					// (harper#1316, facet a). shouldAbortStalledReplay resets its counters on every write,
					// so a slow-but-progressing replay (deep out-of-order audit chain walk per entry) can
					// peg the boot thread indefinitely without tripping it. Checked only at a version
					// boundary: the prior version's transaction was just committed in full and the new one
					// is not yet staged, so aborting never tears a same-version (same source-transaction)
					// write batch in half. Re-clone to recover the unreplayed remainder.
					if (newVersion && shouldAbortSlowReplay(performance.now() - replayStartTime, replayTimeoutMs)) {
						logger.fatal(
							`Aborting transaction-log replay in ${(rootStore as any).databaseName} database: replay has exceeded the wall-clock time limit (${writes} written, ${skipped} skipped). The transaction log contains a pathologically deep out-of-order write history that is too expensive to reconcile during boot (harper#1316). Re-clone this node from a healthy leader to recover the unreplayed data.`
						);
						transaction = undefined as any; // already committed above; nothing staged for the new version
						break;
					}
					transaction = new DatabaseTransaction();
					transaction.db = primaryStore;
					transaction.timestamp = version;
					// This version can already be durable in part two ways: this run committed an earlier batch
					// of it, or the run before it did — the log's last-flushed position is a commit boundary,
					// so with batching it can fall inside a source transaction, and replay then resumes there.
					// See DatabaseTransaction.partiallyCommitted.
					transaction.partiallyCommitted = versionCommittedInPieces || version === resumedTornVersion;
					// retries=1 routes operation.commit() through its retry path (no duplicate audit staging)
					transaction.retries = 1;
					// Explicit replay marker: skips schema validation (harper#1316) and makes save() stamp
					// the native transaction isRetry, so replayed writes are never re-appended to the
					// transaction log being iterated (re-appending would prevent replay convergence).
					transaction.isReplay = true;
				}
				context.transaction = transaction;
				const options = { context, residencyId, nodeId, originatingOperation };
				writes++;
				// Charged before the write, not after it: a write that throws part-way has still staged
				// whatever it got through, and that must count against the flush bound.
				stagedBytes += entryCost;
				stagedWrites++;
				const writesBefore = transaction.writes.length;
				switch (type) {
					case 'put':
						tableInstance._writeUpdate(recordId, record, true, options);
						tableInstance.save(); // requires an explicit save
						break;
					case 'patch':
						tableInstance._writeUpdate(recordId, record, false, options);
						tableInstance.save(); // requires an explicit save
						break;
					case 'message':
						tableInstance._writePublish(recordId, record, options);
						break;
					case 'relocate':
						tableInstance._writeRelocate(recordId, options);
						break;
					case 'delete':
						tableInstance._writeDelete(recordId, options);
						break;
					case 'invalidate':
						tableInstance._writeInvalidate(recordId, record, options);
						break;
					case 'structures': {
						const structuresAsBinary = auditRecord.getBinaryValue(primaryStore);
						const updatedStructures = structuresAsBinary ? primaryStore.decoder.decode(structuresAsBinary) : undefined;
						// Persist replayed structures where the decoder actually reads them: the RocksDB decode
						// path (RecordEncoder.getStructures) reads `rootStore` at the COMPOSITE key
						// [Symbol.for('structures'), name], and saveStructures writes there. This previously wrote
						// `primaryStore` at the PLAIN key Symbol.for('structures'), which getStructures never
						// consults — so a structure delivered only via replication stayed invisible to the decoder
						// (records referencing it decoded to null) until a full-copy resync rewrote the row through
						// saveStructures. See harper-pro#362 (and the #352 auth-path wedge). Because this is now the
						// authoritative key the decoder reads, it must carry saveStructures' guards: never poison the
						// dictionary with an undecodable value, and never downgrade it to fewer structures.
						const encoder = primaryStore.decoder;
						const sharedStructuresKey = [Symbol.for('structures'), encoder.name];
						encoder.rootStore.transactionSync(
							(txn) => {
								// A torn/corrupt/empty structures log value decodes to null/undefined; writing it to
								// the key the decoder reads would poison the whole table's structure dictionary.
								if (!updatedStructures) {
									logger.warn(
										`Skipping a structures replay entry that did not decode to a valid structures buffer (table ${encoder.name}).`
									);
									return;
								}
								const existingStructuresBuffer = txn.getBinarySync(sharedStructuresKey);
								const existingStructures = existingStructuresBuffer
									? encoder.decode(existingStructuresBuffer)
									: undefined;
								// Refuse to overwrite a longer/newer durable buffer with an older/shorter replayed
								// one — dropping ids the decoder still needs would make existing records decode to
								// null. saveStructures rejects incompatible writes the same way (RecordEncoder.ts).
								if (existingStructures && structuresWouldShrink(existingStructures, updatedStructures)) {
									logger.warn(
										`Replay log structures for table ${encoder.name} are fewer than the durable buffer; keeping the durable structures.`
									);
									return;
								}
								txn.putSync(sharedStructuresKey, asBinary(structuresAsBinary));
							},
							{ retryOnBusy: true }
						);
						// No in-memory assignment is needed: the remainder of the replay decodes through
						// getStructures/loadStructures, which re-reads this composite key (now correct) whenever a
						// record references a not-yet-loaded structure id. We deliberately do NOT route through
						// saveStructures, which would set structureUpdate and re-log the structure during replay.
					}
				}
				// The prior record each staged write read and holds for the life of the transaction
				// (DatabaseTransaction.save()) is invisible to the audit entry's own size, and for a
				// patch or delete of a wide record it is the dominant allocation — an update-shaped
				// oversized transaction would otherwise reach the write bound holding gigabytes.
				for (let i = writesBefore; i < transaction.writes.length; i++) {
					stagedBytes += transaction.writes[i]?.entry?.size ?? 0;
				}
				// Forward progress: a write was staged successfully, so reset the no-progress
				// trackers. Doing this AFTER the switch (not before) means a slow or throwing
				// write is neither counted as progress nor charged to the stall bound (harper#1266).
				noProgressRun = 0;
				lastProgressTime = performance.now();
			} catch (err) {
				// A write that threw made no forward progress either — count it toward the stall
				// bound so a continuous stream of throwing writes can't grind the boot thread
				// indefinitely (and the per-entry error log below can't spam unboundedly). harper#1266
				noProgressRun++;
				logger.error(`Error writing from replay of log`, err, {
					version,
				});
			}
		}
		const lastVersionWasTorn = committingVersionIsTorn();
		try {
			transaction?.directCommitSync();
			// Whatever was torn is whole again once its last batch commits.
			if (lastVersionWasTorn) recordTornVersion(rootStore, 0);
		} catch (error) {
			// The last batch of a torn transaction failing here leaves that transaction durable in part,
			// which the operator has to know about; a whole-transaction commit failing is the pre-existing
			// all-or-nothing loss.
			if (lastVersionWasTorn) {
				logger.fatal(
					`Transaction-log replay in ${(rootStore as any).databaseName} database left an oversized transaction partially applied: its final batch failed to commit (${writes} written, ${skipped} skipped). Re-clone this node from a healthy leader to recover the unreplayed data.`,
					error
				);
			} else {
				logger.error('Error committing replay transaction', error);
			}
		}
		if (writes > 0) logger.warn(`Replayed ${writes} records in ${(rootStore as any).databaseName} database`);
		if (midVersionFlushes > 0)
			logger.warn(
				`Replay committed ${midVersionFlushes} intra-transaction batch(es) in ${(rootStore as any).databaseName} database: the log contains transactions too large to stage in memory as a single batch (harper#2161)`
			);
		if (skipped > 0)
			logger.warn(
				`Skipped ${skipped} unrecoverable audit entries in ${(rootStore as any).databaseName} database during replay`
			);
		// we never actually release the lock because we only want to ever run one time
		// rootStore.unlock('replayLogs');
	});
}
function asBinary(buffer) {
	return { ['\x10binary-data\x02']: buffer };
}
