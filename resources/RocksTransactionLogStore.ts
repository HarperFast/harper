import { TransactionLog, RocksDatabase, shutdown, type TransactionEntry } from '@harperfast/rocksdb-js';
import { ExtendedIterable } from '@harperfast/extended-iterable';
import { Decoder, readAuditEntry, ENTRY_DATAVIEW, AuditRecord, createAuditEntry } from './auditStore.ts';
import { isMainThread } from 'node:worker_threads';

if (!process.env.HARPER_NO_FLUSH_ON_EXIT && isMainThread) {
	// we want to be able to test log replay
	// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
	process.on('exit', () => shutdown());
}

// reserving 0x80000000 for future use if we need a flag to indicate 64-bits of flag bits for more flags
const HAS_PREVIOUS_RESIDENCY_ID = 0x40000000;
const HAS_PREVIOUS_VERSION = 0x20000000;

/**
 * Represents a transaction log store backed by RocksDB.
 * This class provides methods that conform to a standard store interface
 * to manage and interact with transaction logs, including querying logs,
 * adding entries, and loading logs for multiple nodes or purposes.
 */
export class RocksTransactionLogStore {
	log: TransactionLog;
	nodeLogs?: TransactionLog[]; // whatever the type of the read logger
	logByName: Map<string, TransactionLog> = new Map();
	rootStore: RocksDatabase;
	reusableIterable = true; // flag indicating that iterable can be reused to resume iterating through audit log
	constructor(rootDatabase: RocksDatabase) {
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
		const nodeId = options.nodeId;
		const log = nodeId ? (this.nodeLogs?.[nodeId] ?? this.loadLogs()[nodeId]) : this.log;
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
		log.addEntry(entryBinary, options.transaction.id);
	}

	putSync(suggestedKey: any, value: any, options: any) {
		if (typeof suggestedKey === 'symbol') {
			this.rootStore.putSync(suggestedKey, value, options);
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
	getEntry() {
		throw new Error('Not implemented');
	}
	addLogToMaps(logName: string, log: TransactionLog) {
		const nodeId = ((globalThis as any).server?.replication?.exportIdMapping?.(this)?.[logName] ?? 0) as number;
		this.nodeLogs![nodeId] ??= log;
		this.logByName.set(logName, log);
	}

	loadLogs() {
		this.nodeLogs ??= [];
		for (const logName of this.rootStore.listLogs()) {
			const log = this.rootStore.useLog(logName);
			this.addLogToMaps(logName, log);
		}
		return this.nodeLogs;
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
		startFromLastFlushed?: boolean;
		readUncommitted?: boolean;
	}): Iterable<AuditRecord> {
		let iterable = new ExtendedIterable<TransactionEntry>();
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
			const queryIterator = log.query(options);
			iterable.iterate = () => queryIterator;
		} else {
			const onlyKeys = options.onlyKeys;
			const logs = (this.nodeLogs || this.loadLogs()).filter((log) => !options.excludeLogs?.includes(log.name));
			const iterators = logs.map((log) => log.query(options)[Symbol.iterator]());
			// holds the queue of next entries from each iterator
			let nextEntries = [];

			// Listen for new transaction logs and add them to the iterator
			const onNewLog = (logName: string) => {
				if (options.excludeLogs?.includes(logName)) {
					return;
				}
				// Check if we already have this log
				const existingLog = this.logByName.get(logName);
				if (existingLog && iterators.some((_, i) => logs[i] === existingLog)) {
					return;
				}
				// Add the new log
				const newLog = this.rootStore.useLog(logName);
				this.addLogToMaps(logName, newLog);

				logs.push(newLog);
				const newIterator = newLog.query(options)[Symbol.iterator]();
				iterators.push(newIterator);
				// Add the first entry from the new iterator to nextEntries if we're actively iterating
				if (nextEntries.length > 0) {
					nextEntries.push(newIterator.next());
				}
			};
			this.rootStore.on('new-transaction-log', onNewLog);

			const aggregateIterator = {
				next() {
					try {
						if (nextEntries.length === 0) {
							// on the first iteration and any time we finished all the iterators, we re-retrieve all
							// the next entries (in case we are resuming after being done)
							nextEntries = iterators.map((iterator) => iterator.next());
						}
						let earliest: TransactionEntry;
						let earliestIndex = -1;
						for (let i = 0; i < nextEntries.length; i++) {
							const result = nextEntries[i];
							// skip any that are done
							if (result.done) {
								// remove the entry from the list, so we don't keep hitting it
								nextEntries.splice(i--, 1);
								continue;
							}
							// find the earliest one that is not done
							const next = result.value;
							if (!earliest || earliest.timestamp < next.timestamp) {
								earliest = next;
								earliestIndex = i;
							}
						}
						if (earliestIndex >= 0) {
							// replace the entry with the next one from the iterator we pulled from
							nextEntries[earliestIndex] = iterators[earliestIndex].next();
							return {
								value: onlyKeys ? earliest.timestamp : earliest,
								done: false,
							};
						} // else we are done
						this.rootStore.off('new-transaction-log', onNewLog);
						return { value: undefined, done: true };
					} catch (error) {
						this.rootStore.off('new-transaction-log', onNewLog);
						throw error;
					}
				},
				return(value?: any) {
					this.rootStore.off('new-transaction-log', onNewLog);
					return { value, done: true };
				},
				throw(error?: any) {
					this.rootStore.off('new-transaction-log', onNewLog);
					throw error;
				},
			};
			iterable.iterate = () => aggregateIterator;
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return iterable.map(({ timestamp, data, endTxn }: TransactionEntry) => {
			const decoder = new Decoder(data.buffer, data.byteOffset, data.byteLength);
			data.dataView = decoder;
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
			const auditRecord = readAuditEntry(data, position, undefined, true);
			auditRecord.version = timestamp;
			auditRecord.endTxn = endTxn;
			auditRecord.previousResidencyId = previousResidencyId;
			auditRecord.previousVersion = previousVersion;
			auditRecord.structureVersion = structureVersion & 0x00ffffff;
			return auditRecord;
		});
	}
	getKeys(options: any) {
		return []; // TODO: implement this
		options.onlyKeys = true;
		return this.getRange(options);
	}
	getStats() {
		let totalSize = 0;
		const logs = [];
		for (const log of this.loadLogs()) {
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
	on(eventName: string, listener: any) {
		return this.rootStore.on(eventName, listener);
	}
	tryLock(key: any, onUnlocked?: () => void): boolean {
		return this.rootStore.tryLock(key, onUnlocked);
	}
	unlock(key: any): void {
		this.rootStore.unlock(key);
	}

	async remove() {
		// TODO: this function can likely be removed once the call to purgeLogs()
		// is added in `resources/Table.ts`
	}
}
