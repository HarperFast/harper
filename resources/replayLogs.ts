import { RocksDatabase, Transaction as RocksTransaction } from '@harperfast/rocksdb-js';
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
} from './replayLogsGuards.ts';
import { purgeAgedLogs } from './auditStore.ts';

let warnedReplayHappening = false;
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
		// Track forward progress so a skip-dominated backlog can't grind the boot thread forever
		// (harper#1266). `skipped` only counts undecodable/corrupt entries, so the delta since the
		// last write is the length of the current no-progress run; a successful write resets both.
		let skippedAtLastProgress = 0;
		let lastProgressTime = Date.now();
		const txnLog: RocksTransactionLogStore = (rootStore as any).auditStore;
		for (const auditRecord of txnLog.getRange({ startFromLastFlushed: true, readUncommitted: true }) as any) {
			const skipsSinceProgress = skipped - skippedAtLastProgress;
			if (skipsSinceProgress > 0 && shouldAbortStalledReplay(skipsSinceProgress, Date.now() - lastProgressTime)) {
				logger.fatal(
					`Aborting transaction-log replay in ${(rootStore as any).databaseName} database: ${skipsSinceProgress} consecutive audit entries skipped with no successful write (${writes} replayed, ${skipped} skipped so far). This backlog is making no forward progress and was blocking startup (harper#1266) — typically a peer transaction log whose values reference unresolvable shared structures (harper#1163). Continuing boot without replaying the remainder; shed or relocate the oversized/undecodable peer transaction log(s), or re-clone this node, to recover the unreplayed data.`
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
					continue;
				}
				const Table = tableById.get(tableId);
				if (!Table) continue;
				const context: Context = {
					nodeId,
					alreadyLogged: true,
					version,
					expiresAt,
					user: { username },
				} as any;
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
					continue;
				}
				if (
					classifyAuditEntryForReplay(extendedType, tableId, record !== undefined) === 'missing-record' ||
					isUndecodableValidatedWrite(type, record)
				) {
					skipped++;
					continue;
				}
				// Entry is replayable: instantiate the resource only now, so the skip paths above
				// never pay a Resource instantiation per skipped entry (harper#1266).
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
					lastTimestamp = version;
					try {
						// commit the last transaction since we are starting a new one
						transaction?.directCommitSync();
					} catch (error) {
						logger.error('Error committing replay transaction', error);
					}
					transaction = new DatabaseTransaction();
					transaction.db = primaryStore;
					transaction.timestamp = version;
					// we treat this as a retry, because it is (and we want to skip validation and writing to the transaction log)
					transaction.retries = 1;
				}
				context.transaction = transaction;
				const options = { context, residencyId, nodeId, originatingOperation };
				writes++;
				// Forward progress: reset the no-progress trackers so the stall bound only ever
				// fires on an uninterrupted run of skips (harper#1266).
				skippedAtLastProgress = skipped;
				lastProgressTime = Date.now();
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
						const rocksTransaction = new RocksTransaction(primaryStore.store);
						const structuresAsBinary = auditRecord.getBinaryValue(primaryStore);
						const updatedStructures = structuresAsBinary ? primaryStore.decoder.decode(structuresAsBinary) : undefined;
						const existingStructures = primaryStore.getSync(Symbol.for('structures'), {
							transaction: rocksTransaction,
						});
						if (existingStructures) {
							if (existingStructures instanceof Array) {
								if (updatedStructures.length < existingStructures.length) {
									logger.warn(
										`Found ${existingStructures.length} structures in audit store, but ${updatedStructures.length} in replay log. Using ${updatedStructures.length} structures.`
									);
								}
							} else {
								if (existingStructures.get('named').length > updatedStructures.get('named').length) {
									logger.warn(
										`Found named ${existingStructures.length} structures in audit store, but ${updatedStructures.length} in replay log. Using named ${updatedStructures.length} structures.`
									);
								}
								if (existingStructures.get('typed').length > updatedStructures.get('typed').length) {
									logger.warn(
										`Found named ${existingStructures.length} structures in audit store, but ${updatedStructures.length} in replay log. Using named ${updatedStructures.length} structures.`
									);
								}
							}
						}
						primaryStore.putSync(Symbol.for('structures'), asBinary(structuresAsBinary), {
							transaction: rocksTransaction,
						});
						rocksTransaction.commitSync();
						primaryStore.decoder.structure = updatedStructures;
					}
				}
			} catch (err) {
				logger.error(`Error writing from replay of log`, err, {
					version,
				});
			}
		}
		try {
			transaction?.directCommitSync();
		} catch (error) {
			logger.error('Error committing replay transaction', error);
		}
		if (writes > 0) logger.warn(`Replayed ${writes} records in ${(rootStore as any).databaseName} database`);
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
