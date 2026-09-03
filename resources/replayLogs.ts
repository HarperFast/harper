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
	REPLAY_WALL_CLOCK_LIMIT_MS,
} from './replayLogsGuards.ts';
import { purgeAgedLogs } from './auditStore.ts';
import { get as envGet } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

let warnedReplayHappening = false;

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

/** The total wall-clock budget (ms) a replay may spend, as configured for this process. */
export function replayTimeBudgetMs(): number {
	const configuredReplayTimeout = Number(envGet(CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT));
	return configuredReplayTimeout > 0 ? configuredReplayTimeout : REPLAY_WALL_CLOCK_LIMIT_MS;
}

/**
 * `electedReplayer` marks a caller that has already won a cross-thread election for this store —
 * the branch claim (branchDatabase.ts) — and so may replay off the main thread. It also makes the
 * replay strict: the promise settles (never hangs), and a failure to apply the tail — a commit or
 * write error, a stall or wall-clock abort — rejects instead of quietly serving a rewound store.
 * Undecodable entries and a torn tail stay tolerated in both modes: a crash tears the last frame of
 * a log by construction, and end-of-log is the designed reading of it (see replayLogsGuards.ts). A
 * **mid-log** break is different — entries behind it were acknowledged and are now quarantined — so
 * an elected replay rejects on one rather than publish a branch as a trustworthy point-in-time copy
 * over known lost writes; boot replay still logs it and continues (harper#2016, harper#2063).
 */
export function replayLogs(rootStore: RocksDatabase, tables: any, electedReplayer?: boolean): Promise<void> {
	if (!isMainThread && !electedReplayer) return Promise.resolve(); // ideally we don't do it like this, but for now this is predictable
	return new Promise((resolve, reject) => {
		const acquired = rootStore.tryLock('replayLogs', async () => {
			resolve();
		});
		if (!acquired) {
			// An elected replayer is the store's sole opener, so a held lock is a protocol violation;
			// hanging its awaited promise would wedge the branch claim in CREATING. The boot-scan
			// caller keeps the settle-on-unlock semantics (nothing awaits it).
			if (electedReplayer) reject(new Error(`The replay lock for ${(rootStore as any).databaseName} is already held`));
			return;
		}
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
		let transaction: DatabaseTransaction | undefined;
		let lastTimestamp = 0;
		let writes = 0;
		// Writes staged on the currently-open transaction, so a discard can be taken back out of `writes`.
		let stagedWrites = 0;
		// Records dropped because a corrupt frame truncated the transaction they belong to.
		let discardedWrites = 0;
		let skipped = 0;
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
		const replayTimeoutMs = replayTimeBudgetMs();
		// Set on the first unrecoverable failure in elected mode; rejects below instead of publishing
		// a store the replay knows is incomplete.
		let strictFailure: Error | undefined;
		const strictAbort = (error: Error, staged: DatabaseTransaction | undefined): void => {
			try {
				staged?.abort();
			} catch (abortError) {
				logger.warn('Error aborting a strict replay transaction', abortError);
			}
			strictFailure = error;
		};
		const txnLog: RocksTransactionLogStore = (rootStore as any).auditStore;
		const entries = txnLog.getRange({
			startFromLastFlushed: true,
			readUncommitted: true,
			trackCorruptTransactions: true,
		});
		for (const auditRecord of entries as any) {
			if (noProgressRun > 0 && shouldAbortStalledReplay(noProgressRun, performance.now() - lastProgressTime)) {
				const stallDiagnostic = `Aborting transaction-log replay in ${(rootStore as any).databaseName} database: ${noProgressRun} consecutive audit entries with no successful write (${skipped} skipped as unrecoverable, ${writes} replayed so far). This backlog is making no forward progress and was blocking startup (harper#1266) — typically a peer transaction log whose values reference unresolvable shared structures (harper#1163), or a backlog for a dropped table.`;
				if (electedReplayer) {
					strictAbort(new Error(stallDiagnostic), transaction);
					break;
				}
				logger.fatal(
					`${stallDiagnostic} Continuing boot without replaying the remainder; shed or relocate the oversized/undecodable peer transaction log(s), or re-clone this node, to recover the unreplayed data.`
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
				if (lastTimestamp !== version) {
					const torn = entries.corruptFrameStop.truncatedVersions.has(lastTimestamp);
					lastTimestamp = version;
					try {
						// commit the last transaction since we are starting a new one, unless a corrupt
						// frame swallowed the rest of it — half of a source transaction must never become
						// durable, so it is dropped whole and stays in the log for a repaired retry
						if (torn) {
							writes -= stagedWrites;
							discardedWrites += stagedWrites;
							transaction?.abort();
						} else transaction?.directCommitSync();
					} catch (error) {
						// directCommitSync aborts and detaches its transaction on failure; no cleanup here.
						// The torn branch already backed stagedWrites out of writes before this try, so
						// only a failed COMMIT (never applied) needs it backed out here too — otherwise a
						// commit failure left `writes` counting records that never actually landed.
						if (!torn) writes -= stagedWrites;
						if (electedReplayer) {
							strictFailure = error;
							break;
						}
						logger.error(`Error ${torn ? 'discarding a torn' : 'committing'} replay transaction`, error);
					}
					stagedWrites = 0;
					// Abort if replay has exceeded the total wall-clock budget even while making progress
					// (harper#1316, facet a). shouldAbortStalledReplay resets its counters on every write,
					// so a slow-but-progressing replay (deep out-of-order audit chain walk per entry) can
					// peg the boot thread indefinitely without tripping it. Checked only here, at a version
					// boundary: the prior version's transaction was just committed in full and the new one
					// is not yet staged, so aborting never tears a same-version (same source-transaction)
					// write batch in half. Re-clone to recover the unreplayed remainder.
					if (shouldAbortSlowReplay(performance.now() - replayStartTime, replayTimeoutMs)) {
						const slowMessage = `Aborting transaction-log replay in ${(rootStore as any).databaseName} database: replay has exceeded the wall-clock time limit (${writes} written, ${skipped} skipped). The transaction log contains a pathologically deep out-of-order write history that is too expensive to reconcile during boot (harper#1316). Re-clone this node from a healthy leader to recover the unreplayed data.`;
						transaction = undefined; // already committed above; nothing staged for the new version
						if (electedReplayer) {
							strictFailure = new Error(slowMessage);
							break;
						}
						logger.fatal(slowMessage);
						break;
					}
					transaction = new DatabaseTransaction();
					transaction.db = primaryStore;
					transaction.timestamp = version;
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
				stagedWrites++;
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
				// Forward progress: a write was staged successfully, so reset the no-progress
				// trackers. Doing this AFTER the switch (not before) means a slow or throwing
				// write is neither counted as progress nor charged to the stall bound (harper#1266).
				noProgressRun = 0;
				lastProgressTime = performance.now();
			} catch (err) {
				if (electedReplayer) {
					strictAbort(err, transaction);
					break;
				}
				// A write that threw made no forward progress either — count it toward the stall
				// bound so a continuous stream of throwing writes can't grind the boot thread
				// indefinitely (and the per-entry error log below can't spam unboundedly). harper#1266
				noProgressRun++;
				logger.error(`Error writing from replay of log`, err, {
					version,
				});
			}
		}
		const finalTorn = entries.corruptFrameStop.truncatedVersions.has(lastTimestamp);
		if (!strictFailure) {
			try {
				if (finalTorn) {
					writes -= stagedWrites;
					discardedWrites += stagedWrites;
					transaction?.abort();
				} else transaction?.directCommitSync();
			} catch (error) {
				// directCommitSync aborts and detaches its transaction on failure; no cleanup here.
				// Mirrors the interior version-boundary catch above: a failed commit never applied, so
				// it must not stay counted in `writes`.
				if (!finalTorn) writes -= stagedWrites;
				if (electedReplayer) strictFailure = error;
				logger.error(`Error ${finalTorn ? 'discarding a torn' : 'committing'} replay transaction`, error);
			}
		}
		// `breaks` also counts a torn tail — the designed, benign reading of a crash's last frame, and
		// the reporter already logged it at `warn`. Only a mid-log break lost entries, so it alone earns
		// this quarantine/repair summary; duplicating it for a torn tail would tell an operator to
		// repair or re-clone the node on every ordinary unclean shutdown.
		if (entries.corruptFrameStop.midLogBreak) {
			logger.error(
				`Transaction-log replay in ${(rootStore as any).databaseName} database stopped at a corrupt entry after replaying ${writes} records. Every entry after the break is quarantined — neither replayed nor replicated — and ${discardedWrites} record(s) of the transaction the break truncated were discarded rather than applied in part. Repair the transaction log or re-clone this node to recover them.`
			);
			// electedReplayer must not resolve past known loss — see the doc comment above. Only set
			// strictFailure if nothing has already failed the replay for an unrelated reason, so this
			// diagnostic never shadows a more specific commit/write error.
			if (electedReplayer && !strictFailure) {
				strictFailure = new Error(
					`Elected replay in ${(rootStore as any).databaseName} database stopped at a mid-log corrupt transaction-log frame; entries behind the break were acknowledged and are now quarantined. Refusing to publish a branch over known lost writes — repair the transaction log or re-clone this node.`
				);
			}
		}
		if (writes > 0) logger.warn(`Replayed ${writes} records in ${(rootStore as any).databaseName} database`);
		if (skipped > 0)
			logger.warn(
				`Skipped ${skipped} unrecoverable audit entries in ${(rootStore as any).databaseName} database during replay`
			);
		if (strictFailure) {
			// A failed strict replay must be re-runnable: the branch claim resets for a retry, so the
			// lock must not be what survives to wedge it. Only a COMPLETED replay keeps the lock
			// forever (the once-per-boot guarantee). Reject BEFORE unlocking: unlock wakes tryLock
			// callbacks — including this holder's own resolve() — and the first settle must be the
			// rejection, or a failed replay reads as success.
			reject(strictFailure);
			try {
				rootStore.unlock('replayLogs');
			} catch (unlockError) {
				logger.warn('Error releasing the replay lock after a failed replay', unlockError);
			}
		} else {
			// we never actually release the lock because we only want to ever run one time
			// rootStore.unlock('replayLogs');
			resolve();
		}
	});
}
function asBinary(buffer) {
	return { ['\x10binary-data\x02']: buffer };
}
