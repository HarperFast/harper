import type { Id } from './ResourceInterface.ts';
import type { AuditRecord } from './auditStore.ts';
import type { RocksTransactionLogStore, TransactionLogIterable } from './RocksTransactionLogStore.ts';
import { writeKeyId } from './DatabaseTransaction.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';

const logger = loggerWithTag('derived-index');

export const DERIVED_INDEX_ACCEPTED = 1;
export const DERIVED_INDEX_DEFERRED = 0;
export const DERIVED_INDEX_FAILED = -1;

export type DerivedIndexDeliveryResult =
	typeof DERIVED_INDEX_ACCEPTED | typeof DERIVED_INDEX_DEFERRED | typeof DERIVED_INDEX_FAILED;

export type DerivedIndexCursor = {
	format: 1;
	logs: Record<string, number>;
};

export type DerivedIndexState = { kind: 'record'; version: number; projection: unknown } | { kind: 'absent' };

export type DerivedIndexMutation = {
	tableId: number;
	recordId: Id;
	logVersion: number;
	state: DerivedIndexState;
};

export type DerivedIndexTransaction = {
	logName: string;
	timestamp: number;
	mutations: DerivedIndexMutation[];
};

export type DerivedIndexBatch = {
	ownerEpoch: bigint;
	transactions: DerivedIndexTransaction[];
	through: DerivedIndexCursor;
};

export interface DerivedIndexBackend {
	readonly id: string;
	getDurableCursor(): DerivedIndexCursor | undefined;
	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult;
	onStateChange(wake: (change?: DerivedIndexBackendStateChange) => void): () => void;
}

export type DerivedIndexBackendStateChange = 'changed' | 'accepted-work-lost' | 'failed';

export type DerivedIndexRegistration = {
	backend: DerivedIndexBackend;
	projections: ReadonlyMap<number, (record: unknown) => unknown>;
};

export type DerivedIndexRecord = { version: number; value: unknown } | undefined;

export type DerivedIndexRuntimeOptions = {
	maxTransactionsPerTurn?: number;
	maxBytesPerTurn?: number;
	maxMillisecondsPerTurn?: number;
	maxAcceptedBatchesAhead?: number;
	idleGraceMilliseconds?: number;
	now?: () => number;
};

export type DerivedIndexRunnerStatus =
	| { state: 'idle' | 'running' | 'deferred' | 'waiting-durable' | 'stopped'; ownerEpoch?: bigint }
	| { state: 'needs-rebuild'; reason: string; ownerEpoch?: bigint };

const ELIGIBLE_ACTIONS = new Set(['put', 'patch', 'delete', 'invalidate', 'relocate']);

export class DerivedIndexRuntime {
	#logStore: RocksTransactionLogStore;
	#resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord;
	#options: Required<DerivedIndexRuntimeOptions>;
	#runners = new Map<string, DerivedIndexRunner>();
	#onCommit = () => this.wake();
	#listening = false;
	#stopped = false;

	constructor(
		logStore: RocksTransactionLogStore,
		resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord,
		options: DerivedIndexRuntimeOptions = {}
	) {
		this.#logStore = logStore;
		this.#resolveRecord = resolveRecord;
		this.#options = {
			maxTransactionsPerTurn: options.maxTransactionsPerTurn ?? 256,
			maxBytesPerTurn: options.maxBytesPerTurn ?? 4 * 1024 * 1024,
			maxMillisecondsPerTurn: options.maxMillisecondsPerTurn ?? 5,
			maxAcceptedBatchesAhead: Math.max(1, options.maxAcceptedBatchesAhead ?? 64),
			idleGraceMilliseconds: options.idleGraceMilliseconds ?? 30_000,
			now: options.now ?? Date.now,
		};
	}

	register(registration: DerivedIndexRegistration): () => void {
		if (this.#stopped) throw new Error('Derived index runtime is stopped');
		if (!registration.backend.id) throw new Error('Derived index backend id is required');
		if (this.#runners.has(registration.backend.id))
			throw new Error(`Derived index backend '${registration.backend.id}' is already registered`);
		const runner = new DerivedIndexRunner(this.#logStore, this.#resolveRecord, registration, this.#options);
		this.#runners.set(registration.backend.id, runner);
		if (!this.#listening) {
			this.#logStore.rootStore.on('committed', this.#onCommit);
			this.#listening = true;
		}
		runner.wake(true);
		return () => {
			if (this.#runners.get(registration.backend.id) !== runner) return;
			this.#runners.delete(registration.backend.id);
			runner.stop();
			this.#stopListeningIfIdle();
		};
	}

	wake() {
		if (this.#stopped) return;
		for (const runner of this.#runners.values()) runner.wake();
	}

	getStatus(backendId: string): DerivedIndexRunnerStatus | undefined {
		return this.#runners.get(backendId)?.status;
	}

	stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const runner of this.#runners.values()) runner.stop();
		this.#runners.clear();
		this.#stopListening();
	}

	#stopListeningIfIdle() {
		if (this.#runners.size === 0) this.#stopListening();
	}

	#stopListening() {
		if (!this.#listening) return;
		this.#logStore.rootStore.off?.('committed', this.#onCommit);
		this.#listening = false;
	}
}

class DerivedIndexRunner {
	#logStore: RocksTransactionLogStore;
	#resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord;
	#registration: DerivedIndexRegistration;
	#options: Required<DerivedIndexRuntimeOptions>;
	#lockKey: string;
	#iterator?: Iterator<AuditRecord>;
	#iterable?: TransactionLogIterable;
	#knownLogs = new Set<string>();
	#pendingTimestamps = new Map<string, number[]>();
	#seenTimestamps = new Map<string, Set<number>>();
	#offeredCursors: DerivedIndexCursor[] = [];
	#offered?: DerivedIndexCursor;
	#pendingBatch?: DerivedIndexBatch;
	#scheduled = false;
	#waitingForLock = false;
	#owned = false;
	#stopped = false;
	#idleTimer?: NodeJS.Timeout;
	#unsubscribeBackend: () => void;
	#ownerEpoch?: bigint;
	status: DerivedIndexRunnerStatus = { state: 'idle' };

	constructor(
		logStore: RocksTransactionLogStore,
		resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord,
		registration: DerivedIndexRegistration,
		options: Required<DerivedIndexRuntimeOptions>
	) {
		this.#logStore = logStore;
		this.#resolveRecord = resolveRecord;
		this.#registration = registration;
		this.#options = options;
		this.#lockKey = `derived-index:${registration.backend.id}:runner`;
		this.#unsubscribeBackend = registration.backend.onStateChange((change = 'changed') =>
			this.#backendStateChanged(change)
		);
	}

	wake(fromBackend = false) {
		if (this.#stopped || this.status.state === 'needs-rebuild') return;
		if (!fromBackend && (this.status.state === 'deferred' || this.status.state === 'waiting-durable')) return;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		if (this.#scheduled) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			if (this.#stopped) return;
			if (this.#owned) this.#drain();
			else this.#acquire();
		});
	}

	stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		this.status = { state: 'stopped', ownerEpoch: this.#ownerEpoch };
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#unsubscribeBackend?.();
		this.#release();
	}

	#acquire() {
		if (this.#waitingForLock) return;
		this.#waitingForLock = true;
		const retry = () => {
			this.#waitingForLock = false;
			try {
				this.wake(true);
			} catch (error) {
				this.#fail('unlock notification failed', error);
			}
		};
		try {
			if (!this.#logStore.tryLock(this.#lockKey, retry)) return;
			this.#waitingForLock = false;
			this.#owned = true;
			this.#ownerEpoch = this.#nextOwnerEpoch();
			this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			this.#resetFromDurableCursor();
			if (this.#owned) this.#drain();
		} catch (error) {
			this.#waitingForLock = false;
			this.#fail('failed to acquire or initialize the runner', error);
		}
	}

	#nextOwnerEpoch(): bigint {
		const buffer = this.#logStore.getUserSharedBuffer(
			`derived-index:${this.#registration.backend.id}:owner-epoch`,
			new ArrayBuffer(8)
		);
		return Atomics.add(new BigInt64Array(buffer), 0, 1n) + 1n;
	}

	#resetFromDurableCursor() {
		const durable = this.#registration.backend.getDurableCursor();
		if (!isValidCursor(durable)) {
			this.#needsRebuild(durable ? 'backend returned an invalid durable cursor' : 'backend has no durable cursor');
			return;
		}
		this.#validateLogSet(durable);
		if (this.status.state === 'needs-rebuild') return;
		this.#offered = cloneCursor(durable);
		this.#offeredCursors = [cloneCursor(durable)];
		this.#pendingTimestamps.clear();
		this.#seenTimestamps.clear();
		for (const [logName, timestamp] of Object.entries(durable.logs)) {
			this.#pendingTimestamps.set(logName, [timestamp]);
			this.#seenTimestamps.set(logName, new Set([timestamp]));
		}
		this.#iterable = this.#logStore.getRange({
			startByLog: new Map(Object.entries(durable.logs)),
			exactStart: true,
			exclusiveStart: true,
			resumeAfterExactStart: true,
			includeLogName: true,
		});
		this.#iterator = this.#iterable[Symbol.iterator]();
		this.#checkRangeHealth();
	}

	#validateLogSet(cursor: DerivedIndexCursor) {
		const currentLogs = this.#logStore.rootStore.listLogs();
		const current = new Set(currentLogs);
		for (const logName of Object.keys(cursor.logs)) {
			if (!current.has(logName)) {
				this.#needsRebuild(`saved transaction log '${logName}' is missing`);
				return;
			}
		}
		this.#knownLogs = current;
		for (const logName of currentLogs) {
			if (cursor.logs[logName] !== undefined) continue;
			const oldestSequenceNumber = this.#logStore.rootStore.useLog(logName).getStats().oldestSequenceNumber;
			if (oldestSequenceNumber !== 1) {
				this.#needsRebuild(`new transaction log '${logName}' no longer retains its beginning`);
				return;
			}
		}
	}

	#drain() {
		if (!this.#owned || this.#stopped || this.status.state === 'needs-rebuild') return;
		try {
			if (!this.#checkNewLogs() || !this.#checkRangeHealth()) return;
			if (this.status.state === 'waiting-durable') {
				if (!this.#reconcileDurableCursor()) return;
				if (this.#offeredCursors.length - 1 >= this.#options.maxAcceptedBatchesAhead) return;
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			}
			const batch = this.#pendingBatch ?? this.#collectBatch();
			if (!this.#owned) return;
			if (!batch) {
				this.#finishIdlePass();
				return;
			}
			let result: DerivedIndexDeliveryResult;
			const deliveryIterator = this.#iterator;
			try {
				result = this.#registration.backend.deliver(batch);
			} catch (error) {
				this.#fail('backend delivery threw', error);
				return;
			}
			if (!this.#owned || this.#iterator !== deliveryIterator) return;
			if (result === DERIVED_INDEX_DEFERRED) {
				this.#pendingBatch = batch;
				this.status = { state: 'deferred', ownerEpoch: this.#ownerEpoch };
				return;
			}
			if (result !== DERIVED_INDEX_ACCEPTED) {
				this.#needsRebuild(
					result === DERIVED_INDEX_FAILED ? 'backend rejected a delivery batch' : 'backend returned an invalid result'
				);
				return;
			}
			this.#pendingBatch = undefined;
			this.#offered = cloneCursor(batch.through);
			this.#offeredCursors.push(cloneCursor(batch.through));
			if (!this.#reconcileDurableCursor()) return;
			if (this.#offeredCursors.length - 1 >= this.#options.maxAcceptedBatchesAhead) {
				this.status = { state: 'waiting-durable', ownerEpoch: this.#ownerEpoch };
				return;
			}
			this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			this.wake();
		} catch (error) {
			this.#fail('runner drain failed', error);
		}
	}

	#collectBatch(): DerivedIndexBatch | undefined {
		const started = this.#options.now();
		let transactions = 0;
		let bytes = 0;
		let progressed = false;
		const through = cloneCursor(this.#offered!);
		const pending: Array<{
			logName: string;
			timestamp: number;
			records: Map<number, Map<unknown, { recordId: Id; logVersion: number }>>;
		}> = [];
		while (true) {
			const first = this.#iterator!.next();
			if (first.done) break;
			const firstRecord = first.value;
			let records: Map<number, Map<unknown, { recordId: Id; logVersion: number }>> | undefined;
			let current = firstRecord;
			this.#assertRecord(current);
			const logName = current.logName!;
			const timestamp = current.txnLogKey;
			let seen = this.#seenTimestamps.get(logName);
			if (!seen) this.#seenTimestamps.set(logName, (seen = new Set()));
			if (seen.has(timestamp))
				throw new Error(`transaction log '${logName}' repeated completed timestamp ${timestamp}`);
			while (true) {
				if (current.logName !== logName || current.txnLogKey !== timestamp)
					throw new Error(`transaction ${timestamp} from '${logName}' ended without an endTxn boundary`);
				bytes += current.size ?? 0;
				const projection = this.#registration.projections.get(current.tableId);
				if (projection) {
					if (current.type === 'reload') throw new Error(`table ${current.tableId} requires a derived-index rebuild`);
					if (ELIGIBLE_ACTIONS.has(current.type)) {
						records ??= new Map();
						let byRecord = records.get(current.tableId);
						if (!byRecord) records.set(current.tableId, (byRecord = new Map()));
						byRecord.set(writeKeyId(current.recordId), {
							recordId: current.recordId,
							logVersion: current.version,
						});
					}
				}
				if (current.endTxn) break;
				const next = this.#iterator!.next();
				if (next.done) throw new Error(`transaction ${timestamp} from '${logName}' is incomplete`);
				current = next.value;
				this.#assertRecord(current);
			}
			seen.add(timestamp);
			let pendingTimestamps = this.#pendingTimestamps.get(logName);
			if (!pendingTimestamps) this.#pendingTimestamps.set(logName, (pendingTimestamps = []));
			pendingTimestamps.push(timestamp);
			through.logs[logName] = timestamp;
			progressed = true;
			transactions++;
			if (records) pending.push({ logName, timestamp, records });
			if (
				transactions >= this.#options.maxTransactionsPerTurn ||
				bytes >= this.#options.maxBytesPerTurn ||
				this.#options.now() - started >= this.#options.maxMillisecondsPerTurn
			)
				break;
		}
		if (!this.#checkRangeHealth()) return;
		if (!progressed) return;
		return { ownerEpoch: this.#ownerEpoch!, transactions: this.#resolveTransactions(pending), through };
	}

	#resolveTransactions(
		pending: Array<{
			logName: string;
			timestamp: number;
			records: Map<number, Map<unknown, { recordId: Id; logVersion: number }>>;
		}>
	): DerivedIndexTransaction[] {
		const resolved = new Map<number, Map<unknown, DerivedIndexState>>();
		for (const transaction of pending) {
			for (const [tableId, records] of transaction.records) {
				let byRecord = resolved.get(tableId);
				if (!byRecord) resolved.set(tableId, (byRecord = new Map()));
				for (const [key, record] of records) {
					if (byRecord.has(key)) continue;
					const current = this.#resolveRecord(tableId, record.recordId);
					const state: DerivedIndexState = current
						? {
								kind: 'record',
								version: current.version,
								projection: this.#registration.projections.get(tableId)!(current.value),
							}
						: { kind: 'absent' };
					byRecord.set(key, state);
				}
			}
		}
		return pending.map(({ logName, timestamp, records }) => {
			const mutations: DerivedIndexMutation[] = [];
			for (const [tableId, byRecord] of records) {
				for (const key of byRecord.keys()) {
					const record = byRecord.get(key)!;
					mutations.push({ tableId, ...record, state: resolved.get(tableId)!.get(key)! });
				}
			}
			return { logName, timestamp, mutations };
		});
	}

	#assertRecord(record: AuditRecord) {
		if (!record || record.logName === undefined || record.tableId === undefined || record.type === undefined)
			throw new Error('transaction log yielded an undecodable audit entry');
	}

	#checkNewLogs(): boolean {
		const current = this.#logStore.rootStore.listLogs();
		const currentSet = new Set(current);
		for (const logName of this.#knownLogs) {
			if (!currentSet.has(logName)) {
				this.#needsRebuild(`transaction log '${logName}' was removed`);
				return false;
			}
		}
		for (const logName of current) {
			if (this.#knownLogs.has(logName)) continue;
			const oldest = this.#logStore.rootStore.useLog(logName).getStats().oldestSequenceNumber;
			if (oldest !== 1) {
				this.#needsRebuild(`new transaction log '${logName}' no longer retains its beginning`);
				return false;
			}
			this.#knownLogs.add(logName);
		}
		return true;
	}

	#checkRangeHealth(): boolean {
		if (!this.#iterable) return true;
		if (this.#iterable.corruptFrameStop.breaks > 0) {
			this.#needsRebuild('transaction log contains a corrupt frame');
			return false;
		}
		if (this.#iterable.failedLogs.size > 0) {
			this.#needsRebuild(`transaction log iterator failed for '${this.#iterable.failedLogs.values().next().value}'`);
			return false;
		}
		if (this.#iterable.exactStartFailures.size > 0) {
			const [logName, failure] = this.#iterable.exactStartFailures.entries().next().value;
			this.#needsRebuild(`transaction log '${logName}' has a ${failure} durable cursor boundary`);
			return false;
		}
		return true;
	}

	#finishIdlePass() {
		const durable = this.#registration.backend.getDurableCursor();
		if (!isValidCursor(durable)) {
			this.#needsRebuild('backend lost its durable cursor');
			return;
		}
		if (!this.#reconcileDurableCursor(durable)) return;
		if (!sameCursor(durable, this.#offered!)) return;
		if (this.#idleTimer) return;
		this.status = { state: 'idle', ownerEpoch: this.#ownerEpoch };
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (!this.#stopped && sameCursor(this.#registration.backend.getDurableCursor(), this.#offered!)) this.#release();
		}, this.#options.idleGraceMilliseconds);
	}

	#reconcileDurableCursor(cursor = this.#registration.backend.getDurableCursor()): boolean {
		if (!isValidCursor(cursor)) {
			this.#needsRebuild('backend returned an invalid durable cursor');
			return false;
		}
		const offeredIndex = this.#offeredCursors.findIndex((offered) => sameCursor(cursor, offered));
		if (offeredIndex < 0) {
			this.#needsRebuild('backend advanced to an unoffered cursor vector');
			return false;
		}
		for (const [logName, timestamp] of Object.entries(cursor.logs)) {
			const pending = this.#pendingTimestamps.get(logName);
			if (!pending) {
				this.#needsRebuild(`backend advanced unknown transaction log '${logName}'`);
				return false;
			}
			const index = pending.indexOf(timestamp);
			if (index < 0) {
				this.#needsRebuild(`backend advanced '${logName}' to an unoffered cursor`);
				return false;
			}
			if (index > 0) {
				const retained = pending.slice(index);
				this.#pendingTimestamps.set(logName, retained);
				this.#seenTimestamps.set(logName, new Set(retained));
			}
		}
		if (offeredIndex > 0) this.#offeredCursors.splice(0, offeredIndex);
		return true;
	}

	#backendStateChanged(change: DerivedIndexBackendStateChange) {
		if (this.#stopped || this.status.state === 'needs-rebuild') return;
		if (change === 'failed') {
			this.#needsRebuild('backend reported a permanent failure');
			return;
		}
		if (change === 'accepted-work-lost' && this.#owned) {
			this.#pendingBatch = undefined;
			try {
				this.#resetFromDurableCursor();
			} catch (error) {
				this.#fail('failed to reset lost accepted work', error);
				return;
			}
		}
		this.wake(true);
	}

	#fail(reason: string, error: unknown) {
		const detail = error instanceof Error && error.message ? `${reason}: ${error.message}` : reason;
		this.#needsRebuild(detail, error);
	}

	#needsRebuild(reason: string, error?: unknown) {
		if (this.status.state !== 'needs-rebuild')
			logger.error(`Derived index '${this.#registration.backend.id}' needs rebuild: ${reason}`, error);
		this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
		this.#pendingBatch = undefined;
		this.#iterator = undefined;
		this.#iterable = undefined;
		this.#release();
	}

	#release() {
		if (!this.#owned) return;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		this.#owned = false;
		try {
			this.#logStore.unlock(this.#lockKey);
		} catch (error) {
			logger.error(`Failed to release derived index runner '${this.#registration.backend.id}'`, error);
		}
		this.#iterator = undefined;
		this.#iterable = undefined;
	}
}

function isValidCursor(cursor: DerivedIndexCursor | undefined): cursor is DerivedIndexCursor {
	if (
		!cursor ||
		typeof cursor !== 'object' ||
		cursor.format !== 1 ||
		!cursor.logs ||
		typeof cursor.logs !== 'object' ||
		Array.isArray(cursor.logs)
	)
		return false;
	for (const timestamp of Object.values(cursor.logs)) {
		if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
	}
	return true;
}

function cloneCursor(cursor: DerivedIndexCursor): DerivedIndexCursor {
	return { format: 1, logs: { ...cursor.logs } };
}

function sameCursor(left: DerivedIndexCursor | undefined, right: DerivedIndexCursor): boolean {
	if (!isValidCursor(left)) return false;
	const leftNames = Object.keys(left.logs);
	const rightNames = Object.keys(right.logs);
	if (leftNames.length !== rightNames.length) return false;
	for (const name of leftNames) if (left.logs[name] !== right.logs[name]) return false;
	return true;
}
