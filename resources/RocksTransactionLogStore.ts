import { TransactionLog, RocksDatabase, shutdown, type TransactionEntry } from '@harperfast/rocksdb-js';
import { ExtendedIterable } from '@harperfast/extended-iterable';
import { getIdOfRemoteNode } from './nodeIdMapping.ts';
import { Decoder, readAuditEntry, ENTRY_DATAVIEW, AuditRecord, createAuditEntry } from './auditStore.ts';
import { endIteratorOnCorruptFrame } from './replayLogsGuards.ts';
import { isMainThread } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { asBinary } from 'lmdb';
import * as harperLogger from '../utility/logging/harper_logger.ts';

if (!process.env.HARPER_NO_FLUSH_ON_EXIT && isMainThread) {
	// we want to be able to test log replay
	process.on('exit', () => shutdown());
}

// reserving 0x80000000 for future use if we need a flag to indicate 64-bits of flag bits for more flags
const HAS_PREVIOUS_RESIDENCY_ID = 0x40000000;
const HAS_PREVIOUS_VERSION = 0x20000000;

type TransactionLogIterator = Iterator<TransactionEntry | number> & {
	addLog(logName: string);
	removeLog(logName: string);
};

// Logs (once per log) when a corrupt frame ends a query iterator early; see
// endIteratorOnCorruptFrame in replayLogsGuards.ts for why this is end-of-log, not a crash.
function warnCorruptFrame(logName: string) {
	return (error: RangeError) =>
		harperLogger.warn(`Stopping transaction log "${logName}" at a corrupt entry during replay`, error);
}

/**
 * Represents a transaction log store backed by RocksDB.
 * This class provides methods that conform to a standard store interface
 * to manage and interact with transaction logs, including querying logs,
 * adding entries, and loading logs for multiple nodes or purposes.
 */
export class RocksTransactionLogStore extends EventEmitter {
	log: TransactionLog;
	nodeLogs?: TransactionLog[]; // whatever the type of the read logger
	logByName: Map<string, TransactionLog> = new Map();
	updates = 0; // the number of updates to the list of logs that have occurred
	rootStore: RocksDatabase;
	reusableIterable = true; // flag indicating that iterable can be reused to resume iterating through audit log
	constructor(rootDatabase: RocksDatabase) {
		super();
		this.log = rootDatabase.useLog('local');
		this.rootStore = rootDatabase;
	}

	/**
	 * Translate a put to an addEntry
	 * @param suggestedKey - ignored, only used by LMDB
	 * @param auditRecord - Audit record to save
	 * @param options - Options for save
	 */
	put(suggestedKey: any, auditRecord: AuditRecord | Uint8Array, options: any) {
		if (options.transaction.isRetry) {
			// do not record transaction entries on retry
			return;
		}
		const log = this.logById(options.nodeId) ?? this.logById(options.viaNodeId) ?? this.log;
		let entryBinary: Uint8Array;
		if (auditRecord instanceof Uint8Array) entryBinary = auditRecord;
		else {
			const flagAndStructureVersion =
				(auditRecord.previousVersion ? HAS_PREVIOUS_VERSION : 0) |
				(auditRecord.previousResidencyId ? HAS_PREVIOUS_RESIDENCY_ID : 0) |
				auditRecord.structureVersion;
			ENTRY_DATAVIEW.setUint32(0, flagAndStructureVersion);
			let position = 4;
			if (auditRecord.previousResidencyId) {
				ENTRY_DATAVIEW.setUint32(4, auditRecord.previousResidencyId);
				position = 8;
			}
			if (auditRecord.previousNodeId) {
				ENTRY_DATAVIEW.setUint32(position, auditRecord.previousNodeId);
				position += 4;
			}
			entryBinary = createAuditEntry(auditRecord, position);
		}
		if (this.listenerCount('aftercommit')) {
			if (!options.transaction.logEntries) {
				options.transaction.logEntries = [];
				options.transaction.onCommit = () => {
					this.emit('aftercommit', options.transaction.logEntries);
				};
			}
			options.transaction.logEntries.push(auditRecord);
		}
		log.addEntry(entryBinary, options.transaction.id);
	}

	logById(nodeId: number) {
		return nodeId > -1 ? (this.nodeLogs?.[nodeId] ?? this.loadLogs()[nodeId]) : undefined;
	}

	putSync(suggestedKey: any, value: any, options: any) {
		if (typeof suggestedKey === 'symbol') {
			this.rootStore.putSync(suggestedKey, asBinary(value), options);
		} else {
			this.put(suggestedKey, value, options);
		}
	}
	get(key: any, tableId: number, recordId: any, nodeId: number) {
		return this.getSync(key, tableId, recordId, nodeId);
	}
	getSync(key: any, tableId: number, recordId: any, nodeId: number) {
		if (typeof key === 'number') {
			if (typeof tableId !== 'number') throw new Error('tableId must be a number');
			if (recordId === undefined) {
				throw new Error('recordId must be provided');
			}
			// this a request for a transaction log entry by a timestamp
			for (const entry of this.getRange({ start: key, exactStart: true, log: nodeId })) {
				if (entry.recordId === recordId && entry.tableId === tableId) {
					return entry;
				}
				if (entry.version !== key) return; // no longer in this transaction
			}
		} else {
			// Harper puts some metadata in the database, we will just put this in the root store instead
			return this.rootStore.getSync(key);
		}
	}
	getBinary(key: any) {
		if (typeof key === 'number') {
			throw new Error('Unsupported binary access by number');
		}
		return this.rootStore.getBinarySync(key);
	}
	getEntry() {
		throw new Error('Not implemented');
	}
	addLogToMaps(logName: string, log: TransactionLog) {
		// 'local' is always the local node's log, which maps to nodeId 0
		const nodeId = (logName === 'local' ? 0 : getIdOfRemoteNode(logName, this)) as number;
		if (this.nodeLogs) {
			this.nodeLogs![nodeId] ??= log;
		}
		this.updates++;
		this.logByName.set(logName, log);
		return nodeId;
	}

	loadLogs() {
		if (this.nodeLogs) {
			// listLogs should only be called one time, and then listen for changes to update
			return this.nodeLogs;
		}
		this.nodeLogs = [];
		for (const logName of this.rootStore.listLogs()) {
			const log = this.rootStore.useLog(logName);
			this.addLogToMaps(logName, log);
		}
		this.rootStore.on('new-transaction-log', (logName) => {
			if (this.logByName.has(logName)) return; // already added
			// Add this to our logs
			const log = this.rootStore.useLog(logName);
			this.addLogToMaps(logName, log);
		});
		return this.nodeLogs;
	}

	ensureLogExists(logName: string) {
		if (this.logByName.has(logName)) return;
		const log = this.rootStore.useLog(logName);
		return this.addLogToMaps(logName, log);
	}

	/**
	 * Get all entries matching the range, from all the transaction logs, sorted by timestamp
	 * @param options
	 */
	getRange(options: {
		start?: number;
		exactStart?: boolean;
		end?: number;
		log?: string | number;
		excludeLogs?: string[];
		onlyKeys?: boolean;
		startByLog?: Map<string, number>;
		startFromLastFlushed?: boolean;
		readUncommitted?: boolean;
	}): Iterable<AuditRecord> {
		let iterable = new ExtendedIterable<TransactionEntry>();
		let aggregateIterator: TransactionLogIterator;
		if (options.log !== undefined) {
			let log = typeof options.log === 'number' ? this.nodeLogs?.[options.log] : this.logByName.get(options.log);
			if (!log) {
				this.loadLogs();
				if (typeof options.log === 'number') {
					log = this.nodeLogs?.[options.log];
				} else {
					log = this.logByName.get(options.log);
				}
				if (!log) {
					log = this.rootStore.useLog(options.log);
				}
			}
			const queryIterator = endIteratorOnCorruptFrame(log.query(options), warnCorruptFrame(log.name));
			iterable.iterate = () => queryIterator;
		} else {
			const onlyKeys = options.onlyKeys;
			let logs: TransactionLog[] = [];
			// holds the queue of next entries from each iterator
			let nextEntries: any[];
			let latestUpdates: number;
			const iterators: IterableIterator<TransactionEntry>[] = [];
			// Iterators that have permanently failed (corrupt entry stuck at the same
			// position). Tracked by identity so the retry-poll path in next() and
			// updateIterators() never calls .next() on them again — otherwise every
			// subsequent drain cycle would re-throw the same RangeError, spamming logs
			// and burning CPU.
			const failedIterators = new WeakSet<IterableIterator<TransactionEntry>>();
			// Per-log advance that converts a thrown corrupt-entry error from rocksdb-js
			// into a clean `done: true` for that iterator. The reader's RangeError leaves
			// `position` at the bad entry; re-calling next() would re-throw indefinitely.
			// Terminating just this log lets the aggregate keep draining the other peers'
			// logs and prevents the throw from escaping into setImmediate-scheduled
			// consumers (notifyFromTransactionData) where it becomes an uncaughtException.
			const safeNext = (iterator: IterableIterator<TransactionEntry>, log?: TransactionLog) => {
				if (failedIterators.has(iterator)) return { value: undefined, done: true };
				try {
					return iterator.next();
				} catch (error) {
					failedIterators.add(iterator);
					harperLogger.error('Transaction log iterator failed; terminating this log', error, {
						log: log?.name,
					});
					return { value: undefined, done: true };
				}
			};
			const updateIterators = () => {
				if (latestUpdates !== this.updates) {
					const latestLogs = (this.nodeLogs || this.loadLogs()).filter(
						(log) => !options.excludeLogs?.includes(log.name)
					);
					for (let log of latestLogs) {
						if (!logs.includes(log)) {
							logs.push(log);
							let queryOptions = options;
							if (options.startByLog) {
								// if the startByLog is provided, we use that
								queryOptions = { ...options, start: options.startByLog.get(log.name) ?? 0 };
							} else if (latestUpdates >= 0) {
								// if this is not the first update, that means that this is a brand new log and if start wasn't specified
								// that means we are taking all future requests, so we need to start at zero so we don't introduce a race
								// condition of potentially missing an initial update
								queryOptions = { ...options, start: options.start ?? 0 };
							}
							iterators.push(endIteratorOnCorruptFrame(log.query(queryOptions), warnCorruptFrame(log.name)));
						}
					}
					latestUpdates = this.updates;
					if (logs.length > latestLogs.length) {
						for (let i = 0; i < logs.length; i++) {
							let log = logs[i];
							if (!latestLogs.includes(log)) {
								logs.splice(i, 1);
								iterators.splice(i--, 1);
							}
						}
					}
				}
				nextEntries = iterators.map((iterator, i) => safeNext(iterator, logs[i]));
			};
			updateIterators();

			aggregateIterator = {
				next() {
					// We get up to two passes: the normal find-earliest pass, plus one retry that
					// forces nextEntries.length = 0 to re-poll every per-log iterator (each picks
					// up new entries when its log file has grown since the last `.next()` returned
					// done) and to let updateIterators pick up any new logs added since the last
					// call (e.g. a peer's log created by replication). Without the retry, a
					// `{ done: true }` slot in nextEntries carried over from a previous call
					// persists across a burst of commits that all coalesce into a single
					// notifyFromTransactionData wake-up — the find-earliest loop keeps skipping
					// the stale done slot, never re-polls the underlying iterator, and the entire
					// burst is silently dropped (no further 'committed' arrives to unstick us).
					// This was the fingerprint of the cloneNode topology bug where peer rows
					// landed in hdb_nodes via system-DB replication but subscribeToNodeUpdates
					// never received the events, so onNodeUpdate never opened replication
					// connections to those peers.
					for (let attempt = 0; attempt < 2; attempt++) {
						if (nextEntries.length === 0) {
							// on the first iteration and any time we finished all the iterators,
							// we re-retrieve all the next entries (in case we are resuming after
							// being done)
							updateIterators();
						}
						let earliest: TransactionEntry;
						let earliestIndex = -1;
						for (let i = 0; i < nextEntries.length; i++) {
							const result = nextEntries[i];
							// skip any that are done
							if (result.done) {
								continue;
							}
							// find the earliest one that is not done
							const next = result.value;
							if (!earliest || earliest.timestamp > next.timestamp) {
								earliest = next;
								earliestIndex = i;
							}
						}
						if (earliestIndex >= 0) {
							// replace the entry with the next one from the iterator we pulled from
							nextEntries[earliestIndex] = safeNext(iterators[earliestIndex], logs[earliestIndex]);
							return {
								value: onlyKeys ? earliest.timestamp : earliest,
								done: false,
							};
						}
						// All current entries are done; force the retry pass to re-poll
						nextEntries.length = 0;
					}
					return { value: undefined, done: true };
				},
				addLog(logName: string) {
					let index = options.excludeLogs?.indexOf(logName);
					if (index >= 0) {
						options.excludeLogs.splice(index, 1);
					}
				},
				removeLog: (logName: string) => {
					const log = this.logByName.get(logName);
					if (!log) return; // not found

					const index = logs.findIndex((l) => l === log);
					if (index >= 0) {
						logs.splice(index, 1);
						iterators.splice(index, 1);
						nextEntries.splice(index, 1);
						options.excludeLogs.push(logName);
					}
				},
			};
			iterable.iterate = () => aggregateIterator;
		}
		const mappedAggregateIterable = iterable.map(({ timestamp, data, endTxn }: TransactionEntry) => {
			// Per-entry try/catch: a corrupt rocks prelude (first 4-16 bytes) would otherwise
			// throw a raw `RangeError: Offset is outside the bounds of the DataView` out
			// through `iterable.map`, escape the for-of consumer, and land as an
			// uncaughtException on a later tick — stalling outgoing replication at the
			// failing offset on every catch-up attempt. On error, yield a sentinel record
			// with the timestamp preserved so iteration advances past the bad entry;
			// downstream consumers already skip records with no `tableId`/`type`.
			try {
				const decoder = new Decoder(data.buffer, data.byteOffset, data.byteLength);
				(data as any).dataView = decoder;
				// This represents the data that shouldn't be transferred for replication
				let structureVersion = decoder.getUint32(0);
				let position = 4;
				let previousResidencyId: number;
				let previousVersion: number;
				if (structureVersion & HAS_PREVIOUS_RESIDENCY_ID) {
					previousResidencyId = decoder.getUint32(position);
					position += 4;
				}
				if (structureVersion & HAS_PREVIOUS_VERSION) {
					// does previous residency id and version actually require separate flags?
					previousVersion = decoder.getFloat64(position);
					position += 8;
				}
				const auditRecord = readAuditEntry(data, position, undefined);
				auditRecord.version = timestamp;
				auditRecord.endTxn = endTxn;
				auditRecord.previousResidencyId = previousResidencyId;
				auditRecord.previousVersion = previousVersion;
				auditRecord.structureVersion = structureVersion & 0x00ffffff;
				return auditRecord;
			} catch (error) {
				harperLogger.error('Failed to decode rocks transaction log entry; skipping', error, {
					timestamp,
					byteLength: data?.byteLength,
				});
				return {
					version: timestamp,
					endTxn,
					type: undefined,
					tableId: undefined,
					recordId: undefined,
					getValue: () => undefined,
					getBinaryValue: () => undefined,
					getBinaryRecordId: () => undefined,
				} as unknown as AuditRecord;
			}
		});
		// Add methods to the mapped iterable if we have an aggregate iterator
		if (aggregateIterator?.addLog) {
			mappedAggregateIterable.addLog = aggregateIterator.addLog;
			mappedAggregateIterable.removeLog = aggregateIterator.removeLog;
		}
		return mappedAggregateIterable;
	}
	getKeys(_options?: any) {
		return []; // TODO: implement this
		// options.onlyKeys = true;
		// return this.getRange(options);
	}
	getStats() {
		let totalSize = 0;
		const logs = [];
		for (const log of this.loadLogs()) {
			if (!log) continue;
			const size = log.getLogFileSize();
			totalSize += size;
			logs.push({ name: log.name, size });
		}
		return {
			logs,
			totalSize,
		};
	}

	getUserSharedBuffer(key: string | symbol, defaultBuffer: ArrayBuffer, options?: { callback?: () => void }) {
		return this.rootStore.getUserSharedBuffer(key, defaultBuffer, options);
	}
	on(eventName: string, listener: any): any {
		if (eventName === 'aftercommit') {
			return super.on('aftercommit', listener);
		} else {
			return this.rootStore.on(eventName, listener);
		}
	}
	tryLock(key: any, onUnlocked?: () => void): boolean {
		return this.rootStore.tryLock(key, onUnlocked);
	}
	unlock(key: any): void {
		this.rootStore.unlock(key);
	}
	get path() {
		return this.rootStore.path;
	}

	async remove() {
		// TODO: this function can likely be removed once the call to purgeLogs()
		// is added in `resources/Table.ts`
	}
}
