import type { Id } from './ResourceInterface.ts';
import type { AuditRecord } from './auditStore.ts';
import type { RocksTransactionLogStore, TransactionLogIterable } from './RocksTransactionLogStore.ts';
import { writeKeyId } from './DatabaseTransaction.ts';
import { registerDerivedIndexTables } from './derivedIndexRegistry.ts';
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

export type DerivedIndexState =
	| { kind: 'record'; version: number; projection: unknown }
	| { kind: 'absent' }
	/** The projection rejected the record (a 4xx-classified error); the backend removes any entry and counts it. */
	| { kind: 'unindexable'; version: number; reason: string };

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
	/** Present on a chunk of an oversized transaction that does not include its `endTxn` entry. */
	partial?: true;
};

export type DerivedIndexBatch = {
	ownerEpoch: bigint;
	transactions: DerivedIndexTransaction[];
	/**
	 * Last-write-wins view over the distinct `(tableId, writeKeyId(recordId))` keys of the batch, in
	 * first-occurrence order, each carrying the last `logVersion` and the same resolved `state`
	 * object as its occurrences in `transactions`.
	 */
	records: DerivedIndexMutation[];
	/**
	 * Cursor vector this batch completes. Absent on a rebuild scan chunk: such a batch advances no
	 * cursor and the backend's durable cursor must stay `undefined` until a batch carrying `through`
	 * has been made durable.
	 */
	through?: DerivedIndexCursor;
	/** Estimated payload bytes of `records`; see `DerivedIndexRecord.size`. */
	bytes: number;
	/** Present on batches produced by the rebuild scan. */
	rebuild?: true;
};

export type DerivedIndexFlushReason = 'age' | 'threshold' | 'shutdown';

export type DerivedIndexReadinessState = 'unknown' | 'ready' | 'rebuilding' | 'needs-rebuild' | 'unavailable';

export type DerivedIndexReadiness = {
	state: DerivedIndexReadinessState;
	reason?: string;
	/** Epoch of the owner that published this state; compare with `isOwnerEpoch` to detect a stale publication. */
	ownerEpoch: bigint;
	rebuildAttempts: number;
};

export interface DerivedIndexBackendHost {
	/** True while `epoch` is the most recently minted owner epoch for this backend. */
	isOwnerEpoch(epoch: bigint): boolean;
	getReadiness(): DerivedIndexReadiness;
}

export interface DerivedIndexBackend {
	readonly id: string;
	getDurableCursor(): DerivedIndexCursor | undefined;
	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult;
	onStateChange(wake: (change?: DerivedIndexBackendStateChange) => void): () => void;
	/** Receives the epoch fence and readiness reader before any delivery. */
	attach?(host: DerivedIndexBackendHost): void;
	/** Request a durability barrier; the backend runs it asynchronously and wakes through `onStateChange`. */
	flush?(reason: DerivedIndexFlushReason): void;
	/** Destroy index state and the durable cursor; `getDurableCursor()` must return `undefined` afterwards. */
	reset?(ownerEpoch: bigint): void;
	/**
	 * Stop accepting work for `ownerEpoch`, settle or discard what is queued, and resolve once nothing
	 * further will be applied or published for it. A rejection keeps the runner lock held.
	 */
	shutdown?(ownerEpoch: bigint): void | Promise<void>;
}

export type DerivedIndexBackendStateChange = 'changed' | 'accepted-work-lost' | 'failed';

export type DerivedIndexRunnerOptions = {
	maxTransactionsPerTurn?: number;
	maxBytesPerTurn?: number;
	maxMillisecondsPerTurn?: number;
	/** Hard bound on distinct records resolved per chunk; an oversized transaction is cut here. */
	maxChunkRecords?: number;
	/** Estimated payload bytes after which a chunk stops adding complete transactions. */
	maxChunkBytes?: number;
	maxAcceptedBatchesAhead?: number;
	maxFlushAgeMilliseconds?: number;
	flushAfterMutations?: number;
	flushAfterBytes?: number;
	rebuildBackoffMilliseconds?: number;
	maxRebuildBackoffMilliseconds?: number;
	maxRebuildAttempts?: number;
};

export type DerivedIndexRegistration = {
	backend: DerivedIndexBackend;
	projections: ReadonlyMap<number, (record: unknown) => unknown>;
	options?: DerivedIndexRunnerOptions;
};

/** `size` is the stored byte size of the record when known; it bounds the projection's size without serializing it. */
export type DerivedIndexRecord = { version: number; value: unknown; size?: number } | undefined;

export type DerivedIndexScanRecord = { recordId: Id; version: number; value: unknown; size?: number };

export type DerivedIndexRuntimeOptions = DerivedIndexRunnerOptions & {
	idleGraceMilliseconds?: number;
	now?: () => number;
	/** Iterates every current record of a table for the rebuild scan; without it a rebuild cannot run. */
	scanRecords?: (tableId: number) => Iterable<DerivedIndexScanRecord>;
};

export type DerivedIndexRunnerStatus =
	| {
			state: 'idle' | 'running' | 'deferred' | 'waiting-durable' | 'stopped' | 'rebuilding';
			ownerEpoch?: bigint;
	  }
	| { state: 'needs-rebuild' | 'unavailable'; reason: string; ownerEpoch?: bigint };

export type DerivedIndexRunnerMetrics = {
	readiness: DerivedIndexReadiness;
	acceptedBatches: number;
	acceptedBytes: number;
	acceptedMutations: number;
	deferredBytes: number;
	oldestAcceptedAgeMilliseconds: number;
	cursorLagMilliseconds: number;
	unindexableRecords: number;
	rebuildAttempts: number;
	rebuiltRecords: number;
};

type ResolvedRunnerOptions = Required<DerivedIndexRunnerOptions> & {
	idleGraceMilliseconds: number;
	now: () => number;
};

const ELIGIBLE_ACTIONS = new Set(['put', 'patch', 'delete', 'invalidate', 'relocate', 'evict']);

const READINESS_STATES: DerivedIndexReadinessState[] = [
	'unknown',
	'ready',
	'rebuilding',
	'needs-rebuild',
	'unavailable',
];
const READINESS_BYTES = 512;
const READINESS_REASON_OFFSET = 24;
const READINESS_SEQUENCE = 0;
const READINESS_STATE = 1;
const READINESS_REASON_LENGTH = 2;
const READINESS_ATTEMPTS = 3;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class DerivedIndexRuntime {
	#logStore: RocksTransactionLogStore;
	#resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord;
	#scanRecords?: (tableId: number) => Iterable<DerivedIndexScanRecord>;
	#options: ResolvedRunnerOptions;
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
		this.#scanRecords = options.scanRecords;
		this.#options = {
			...resolveRunnerOptions(options),
			idleGraceMilliseconds: options.idleGraceMilliseconds ?? 30_000,
			now: options.now ?? Date.now,
		};
	}

	/** Returns an unregister function that resolves once the runner's backend shutdown has settled. */
	register(registration: DerivedIndexRegistration): () => Promise<void> {
		if (this.#stopped) throw new Error('Derived index runtime is stopped');
		if (!registration.backend.id) throw new Error('Derived index backend id is required');
		if (this.#runners.has(registration.backend.id))
			throw new Error(`Derived index backend '${registration.backend.id}' is already registered`);
		const runner = new DerivedIndexRunner(this.#logStore, this.#resolveRecord, this.#scanRecords, registration, {
			...resolveRunnerOptions(registration.options, this.#options),
			idleGraceMilliseconds: this.#options.idleGraceMilliseconds,
			now: this.#options.now,
		});
		this.#runners.set(registration.backend.id, runner);
		if (!this.#listening) {
			this.#logStore.rootStore.on('committed', this.#onCommit);
			this.#listening = true;
		}
		runner.wake(true);
		return () => {
			if (this.#runners.get(registration.backend.id) !== runner) return Promise.resolve();
			this.#runners.delete(registration.backend.id);
			const stopped = runner.stop();
			this.#stopListeningIfIdle();
			return stopped;
		};
	}

	wake() {
		if (this.#stopped) return;
		for (const runner of this.#runners.values()) runner.wake();
	}

	getStatus(backendId: string): DerivedIndexRunnerStatus | undefined {
		return this.#runners.get(backendId)?.status;
	}

	/** Shared readiness published by whichever worker owns the index; readable on every worker. */
	getReadiness(backendId: string): DerivedIndexReadiness {
		return this.#runners.get(backendId)?.getReadiness() ?? readDerivedIndexReadiness(this.#logStore, backendId);
	}

	getMetrics(backendId: string): DerivedIndexRunnerMetrics | undefined {
		return this.#runners.get(backendId)?.getMetrics();
	}

	/** Force a rebuild (or retry one that became `unavailable`). Returns false when the backend cannot be rebuilt by the runtime. */
	requestRebuild(backendId: string): boolean {
		return this.#runners.get(backendId)?.requestRebuild() ?? false;
	}

	/** Resolves once every runner has released ownership and its backend shutdown has settled. */
	stop(): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		this.#stopped = true;
		const stopped = [...this.#runners.values()].map((runner) => runner.stop());
		this.#runners.clear();
		this.#stopListening();
		return Promise.all(stopped).then(() => undefined);
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

function resolveRunnerOptions(
	options: DerivedIndexRunnerOptions | undefined,
	defaults?: Required<DerivedIndexRunnerOptions>
): Required<DerivedIndexRunnerOptions> {
	const base: Required<DerivedIndexRunnerOptions> = defaults ?? {
		maxTransactionsPerTurn: 256,
		maxBytesPerTurn: 4 * 1024 * 1024,
		maxMillisecondsPerTurn: 5,
		maxChunkRecords: 4096,
		maxChunkBytes: 4 * 1024 * 1024,
		maxAcceptedBatchesAhead: 64,
		maxFlushAgeMilliseconds: 1000,
		flushAfterMutations: 4096,
		flushAfterBytes: 8 * 1024 * 1024,
		rebuildBackoffMilliseconds: 1000,
		maxRebuildBackoffMilliseconds: 300_000,
		maxRebuildAttempts: 8,
	};
	if (!options) return base;
	return {
		maxTransactionsPerTurn: options.maxTransactionsPerTurn ?? base.maxTransactionsPerTurn,
		maxBytesPerTurn: options.maxBytesPerTurn ?? base.maxBytesPerTurn,
		maxMillisecondsPerTurn: options.maxMillisecondsPerTurn ?? base.maxMillisecondsPerTurn,
		maxChunkRecords: Math.max(1, options.maxChunkRecords ?? base.maxChunkRecords),
		maxChunkBytes: options.maxChunkBytes ?? base.maxChunkBytes,
		maxAcceptedBatchesAhead: Math.max(1, options.maxAcceptedBatchesAhead ?? base.maxAcceptedBatchesAhead),
		maxFlushAgeMilliseconds: options.maxFlushAgeMilliseconds ?? base.maxFlushAgeMilliseconds,
		flushAfterMutations: options.flushAfterMutations ?? base.flushAfterMutations,
		flushAfterBytes: options.flushAfterBytes ?? base.flushAfterBytes,
		rebuildBackoffMilliseconds: options.rebuildBackoffMilliseconds ?? base.rebuildBackoffMilliseconds,
		maxRebuildBackoffMilliseconds: options.maxRebuildBackoffMilliseconds ?? base.maxRebuildBackoffMilliseconds,
		maxRebuildAttempts: options.maxRebuildAttempts ?? base.maxRebuildAttempts,
	};
}

type OfferedProgress = { cursor: DerivedIndexCursor; bytes: number; mutations: number; acceptedAt: number };

type CollectedKey = { recordId: Id; logVersion: number; sizeHint: number | undefined };

/** Identities read from the log for one transaction, resolved only after every occurrence in its chunk was read. */
type CollectedTransaction = {
	logName: string;
	timestamp: number;
	keys: Map<number, Map<unknown, CollectedKey>>;
	keyCount: number;
	complete: boolean;
};

type Chunk = {
	batch: DerivedIndexBatch;
	resolved: Map<number, Map<unknown, DerivedIndexMutation>>;
	started: number;
};

/** Signals a turn that read part of an oversized transaction but has nothing to deliver yet. */
const CONTINUE = null;

class DerivedIndexRunner {
	#logStore: RocksTransactionLogStore;
	#resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord;
	#scanRecords?: (tableId: number) => Iterable<DerivedIndexScanRecord>;
	#registration: DerivedIndexRegistration;
	#options: ResolvedRunnerOptions;
	#lockKey: string;
	#iterator?: Iterator<AuditRecord>;
	#iterable?: TransactionLogIterable;
	#knownLogs = new Set<string>();
	#pendingTimestamps = new Map<string, number[]>();
	#seenTimestamps = new Map<string, Set<number>>();
	#offered?: DerivedIndexCursor;
	#offeredCursors: OfferedProgress[] = [];
	#unanchoredBytes = 0;
	#unanchoredMutations = 0;
	#unanchoredAcceptedAt = 0;
	#pendingBatch?: DerivedIndexBatch;
	/** Collected but unresolved transactions; the last one may still be open (incomplete). */
	#carried: CollectedTransaction[] = [];
	#latestSeen = new Map<string, number>();
	#reloadsHandledThrough = new Map<string, number>();
	#scheduled = false;
	#waitingForLock = false;
	#owned = false;
	#stopped = false;
	#generation = 0;
	#idleTimer?: NodeJS.Timeout;
	#flushTimer?: NodeJS.Timeout;
	#rebuildTimer?: NodeJS.Timeout;
	#unflushedBytes = 0;
	#unflushedMutations = 0;
	#releasing?: Promise<void>;
	#rebuilding = false;
	#rebuildRequested = false;
	#boundaryPending = false;
	#rebuildAttempts = 0;
	#rebuiltRecords = 0;
	#unindexableRecords = 0;
	#rebuildWaiter?: () => void;
	#rebuildWakePending = false;
	#unsubscribeBackend: () => void;
	#unregisterTables: () => void;
	#ownerEpoch?: bigint;
	#epochCounter: BigInt64Array;
	#readinessWords: Int32Array;
	#readinessBytes: Uint8Array;
	#readinessEpoch: BigInt64Array;
	status: DerivedIndexRunnerStatus = { state: 'idle' };

	constructor(
		logStore: RocksTransactionLogStore,
		resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord,
		scanRecords: ((tableId: number) => Iterable<DerivedIndexScanRecord>) | undefined,
		registration: DerivedIndexRegistration,
		options: ResolvedRunnerOptions
	) {
		this.#logStore = logStore;
		this.#resolveRecord = resolveRecord;
		this.#scanRecords = scanRecords;
		this.#registration = registration;
		this.#options = options;
		this.#lockKey = `derived-index:${registration.backend.id}:runner`;
		this.#epochCounter = new BigInt64Array(
			logStore.getUserSharedBuffer(`derived-index:${registration.backend.id}:owner-epoch`, new ArrayBuffer(8))
		);
		const readiness = readinessBuffer(logStore, registration.backend.id);
		this.#readinessWords = new Int32Array(readiness, 0, 4);
		this.#readinessEpoch = new BigInt64Array(readiness, 16, 1);
		this.#readinessBytes = new Uint8Array(readiness, READINESS_REASON_OFFSET);
		registration.backend.attach?.({
			isOwnerEpoch: (epoch) => Atomics.load(this.#epochCounter, 0) === epoch,
			getReadiness: () => this.getReadiness(),
		});
		this.#unsubscribeBackend = registration.backend.onStateChange((change = 'changed') =>
			this.#backendStateChanged(change)
		);
		this.#unregisterTables = registerDerivedIndexTables(logStore, registration.projections.keys());
	}

	wake(fromBackend = false) {
		if (this.#stopped || this.#rebuilding) return;
		if (this.status.state === 'unavailable') return;
		if (this.status.state === 'needs-rebuild' && (this.#rebuildTimer || !this.#rebuildRequested)) return;
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

	stop(): Promise<void> {
		if (this.#stopped) return this.#releasing ?? Promise.resolve();
		this.#stopped = true;
		this.status = { state: 'stopped', ownerEpoch: this.#ownerEpoch };
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		if (this.#rebuildTimer) clearTimeout(this.#rebuildTimer);
		this.#rebuildTimer = undefined;
		this.#unsubscribeBackend?.();
		this.#unregisterTables();
		this.#release();
		return this.#releasing ?? Promise.resolve();
	}

	getReadiness(): DerivedIndexReadiness {
		return readReadiness(this.#readinessWords, this.#readinessEpoch, this.#readinessBytes);
	}

	getMetrics(): DerivedIndexRunnerMetrics {
		const now = this.#options.now();
		let acceptedBytes = this.#unanchoredBytes;
		let acceptedMutations = this.#unanchoredMutations;
		let oldestAcceptedAt = this.#offeredCursors.length > 1 ? this.#offeredCursors[1].acceptedAt : undefined;
		for (let i = 1; i < this.#offeredCursors.length; i++) {
			acceptedBytes += this.#offeredCursors[i].bytes;
			acceptedMutations += this.#offeredCursors[i].mutations;
		}
		if (oldestAcceptedAt === undefined && this.#unanchoredMutations > 0) oldestAcceptedAt = this.#unanchoredAcceptedAt;
		let cursorLag = 0;
		const durable = this.#offeredCursors[0]?.cursor;
		if (durable) {
			for (const [logName, latest] of this.#latestSeen) {
				const position = durable.logs[logName];
				if (position !== undefined && latest > position) cursorLag = Math.max(cursorLag, latest - position);
			}
		}
		return {
			readiness: this.getReadiness(),
			acceptedBatches: Math.max(0, this.#offeredCursors.length - 1),
			acceptedBytes,
			acceptedMutations,
			deferredBytes: this.#pendingBatch?.bytes ?? 0,
			oldestAcceptedAgeMilliseconds: oldestAcceptedAt === undefined ? 0 : Math.max(0, now - oldestAcceptedAt),
			cursorLagMilliseconds: cursorLag,
			unindexableRecords: this.#unindexableRecords,
			rebuildAttempts: this.#rebuildAttempts,
			rebuiltRecords: this.#rebuiltRecords,
		};
	}

	requestRebuild(): boolean {
		if (this.#stopped || !this.#canRebuild()) return false;
		this.#rebuildAttempts = 0;
		this.#rebuildRequested = true;
		if (this.#rebuildTimer) {
			clearTimeout(this.#rebuildTimer);
			this.#rebuildTimer = undefined;
		}
		if (this.status.state === 'unavailable' || this.getReadiness().state === 'unavailable') {
			const reason = this.status.state === 'unavailable' ? this.status.reason : 'rebuild requested';
			this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
			this.#publishReadiness('needs-rebuild', reason);
		}
		if (this.#owned) {
			if (!this.#rebuilding) this.#startRebuild();
		} else this.wake(true);
		return true;
	}

	#canRebuild(): boolean {
		return typeof this.#registration.backend.reset === 'function' && this.#scanRecords !== undefined;
	}

	#acquire() {
		if (this.#waitingForLock) return;
		if (this.#releasing) {
			this.#releasing.then(() => this.wake(true));
			return;
		}
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
			this.#generation++;
			this.#ownerEpoch = this.#mintEpoch();
			this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			const shared = this.getReadiness();
			if (!this.#rebuildRequested) this.#rebuildAttempts = shared.rebuildAttempts;
			if (this.#rebuildRequested) {
				this.#startRebuild();
				return;
			}
			if (shared.state === 'unavailable') {
				this.status = {
					state: 'unavailable',
					reason: shared.reason ?? 'index unavailable',
					ownerEpoch: this.#ownerEpoch,
				};
				this.#release();
				return;
			}
			this.#resetFromDurableCursor();
			if (this.#owned && !this.#rebuilding) this.#drain();
		} catch (error) {
			this.#waitingForLock = false;
			this.#fail('failed to acquire or initialize the runner', error);
		}
	}

	#mintEpoch(): bigint {
		return Atomics.add(this.#epochCounter, 0, 1n) + 1n;
	}

	#resetFromDurableCursor() {
		const durable = this.#registration.backend.getDurableCursor();
		if (!isValidCursor(durable)) {
			this.#needsRebuild(durable ? 'backend returned an invalid durable cursor' : 'backend has no durable cursor');
			return;
		}
		if (!this.#installCursor(durable)) return;
		this.#publishReadiness('ready');
	}

	/** Point offered progress and the log iterator at `cursor`; false when the log set cannot prove it. */
	#installCursor(cursor: DerivedIndexCursor): boolean {
		this.#validateLogSet(cursor);
		if (this.status.state === 'needs-rebuild') return false;
		this.#offered = cloneCursor(cursor);
		this.#offeredCursors = [{ cursor: cloneCursor(cursor), bytes: 0, mutations: 0, acceptedAt: this.#options.now() }];
		this.#unanchoredBytes = 0;
		this.#unanchoredMutations = 0;
		this.#pendingBatch = undefined;
		this.#carried = [];
		this.#pendingTimestamps.clear();
		this.#seenTimestamps.clear();
		for (const [logName, timestamp] of Object.entries(cursor.logs)) {
			this.#pendingTimestamps.set(logName, [timestamp]);
			this.#seenTimestamps.set(logName, new Set([timestamp]));
		}
		this.#iterable = this.#logStore.getRange({
			startByLog: new Map(Object.entries(cursor.logs)),
			exactStart: true,
			exclusiveStart: true,
			resumeAfterExactStart: true,
			includeLogName: true,
		});
		this.#iterator = this.#iterable[Symbol.iterator]();
		return this.#checkRangeHealth();
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
		if (!this.#owned || this.#stopped || this.#rebuilding) return;
		if (this.status.state === 'needs-rebuild' || this.status.state === 'unavailable') return;
		try {
			if (!this.#checkNewLogs() || !this.#checkRangeHealth()) return;
			if (this.status.state === 'waiting-durable') {
				if (!this.#reconcileDurableCursor()) return;
				if (this.#offeredCursors.length - 1 >= this.#options.maxAcceptedBatchesAhead) return;
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			}
			const batch = this.#pendingBatch ?? this.#collectChunk();
			if (!this.#owned) return;
			if (batch === CONTINUE) {
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
				this.wake();
				return;
			}
			if (!batch) {
				this.#finishIdlePass();
				return;
			}
			const generation = this.#generation;
			const result = this.#deliver(batch);
			if (result === undefined) return;
			if (result === DERIVED_INDEX_DEFERRED) {
				this.#pendingBatch = batch;
				this.status = { state: 'deferred', ownerEpoch: this.#ownerEpoch };
				return;
			}
			this.#pendingBatch = undefined;
			this.#noteAccepted(batch);
			if (!this.#live(generation)) return;
			if (!this.#reconcileDurableCursor()) return;
			if (!lastOpen(this.#carried) && this.#offeredCursors.length - 1 >= this.#options.maxAcceptedBatchesAhead) {
				this.status = { state: 'waiting-durable', ownerEpoch: this.#ownerEpoch };
				return;
			}
			this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			this.wake();
		} catch (error) {
			this.#fail('runner drain failed', error);
		}
	}

	/** Hand a batch to the backend; `undefined` means the runner lost ownership or failed during the call. */
	#deliver(batch: DerivedIndexBatch): typeof DERIVED_INDEX_ACCEPTED | typeof DERIVED_INDEX_DEFERRED | undefined {
		const generation = this.#generation;
		let result: DerivedIndexDeliveryResult;
		try {
			result = this.#registration.backend.deliver(batch);
		} catch (error) {
			this.#fail('backend delivery threw', error);
			return;
		}
		if (!this.#live(generation)) return;
		if (result === DERIVED_INDEX_DEFERRED || result === DERIVED_INDEX_ACCEPTED) return result;
		this.#needsRebuild(
			result === DERIVED_INDEX_FAILED ? 'backend rejected a delivery batch' : 'backend returned an invalid result'
		);
	}

	#noteAccepted(batch: DerivedIndexBatch) {
		const now = this.#options.now();
		if (batch.through && !sameCursor(batch.through, this.#offered)) {
			this.#offered = cloneCursor(batch.through);
			this.#offeredCursors.push({
				cursor: cloneCursor(batch.through),
				bytes: this.#unanchoredBytes + batch.bytes,
				mutations: this.#unanchoredMutations + batch.records.length,
				acceptedAt: this.#unanchoredMutations > 0 ? this.#unanchoredAcceptedAt : now,
			});
			this.#unanchoredBytes = 0;
			this.#unanchoredMutations = 0;
		} else {
			if (this.#unanchoredMutations === 0) this.#unanchoredAcceptedAt = now;
			this.#unanchoredBytes += batch.bytes;
			this.#unanchoredMutations += batch.records.length;
		}
		this.#unflushedBytes += batch.bytes;
		this.#unflushedMutations += batch.records.length;
		if (
			this.#unflushedMutations >= this.#options.flushAfterMutations ||
			this.#unflushedBytes >= this.#options.flushAfterBytes
		) {
			this.#requestFlush('threshold');
		} else if (!this.#flushTimer) {
			this.#flushTimer = setTimeout(() => {
				this.#flushTimer = undefined;
				if (this.#owned) this.#requestFlush('age');
			}, this.#options.maxFlushAgeMilliseconds);
			this.#flushTimer.unref?.();
		}
	}

	#requestFlush(reason: DerivedIndexFlushReason) {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		this.#unflushedBytes = 0;
		this.#unflushedMutations = 0;
		const flush = this.#registration.backend.flush;
		if (!flush) return;
		try {
			flush.call(this.#registration.backend, reason);
		} catch (error) {
			this.#fail('backend flush request threw', error);
		}
	}

	/**
	 * One drain turn: read transaction identities within the turn budget, then resolve each distinct
	 * key once, after its last collected occurrence, so the delivered state is never older than a log
	 * entry the batch's cursor certifies.
	 */
	#collectChunk(): DerivedIndexBatch | typeof CONTINUE | undefined {
		const chunk = this.#newChunk(false);
		const collected = this.#collectIdentities(chunk.started);
		if (!this.#checkRangeHealth()) return;
		if (collected.length === 0) return;
		return this.#resolveCollected(chunk, collected);
	}

	#collectIdentities(started: number): CollectedTransaction[] {
		const options = this.#options;
		const iterator = this.#iterator!;
		const projections = this.#registration.projections;
		const collected = this.#carried;
		this.#carried = [];
		let keyCount = 0;
		for (const transaction of collected) keyCount += transaction.keyCount;
		let current = lastOpen(collected);
		let transactions = 0;
		let readBytes = 0;
		while (keyCount < options.maxChunkRecords) {
			const next = iterator.next();
			if (next.done) {
				if (current) throw new Error(`transaction ${current.timestamp} from '${current.logName}' is incomplete`);
				break;
			}
			const entry = next.value;
			this.#assertRecord(entry);
			if (!current) {
				const logName = entry.logName!;
				const timestamp = entry.txnLogKey;
				let seen = this.#seenTimestamps.get(logName);
				if (!seen) this.#seenTimestamps.set(logName, (seen = new Set()));
				if (seen.has(timestamp))
					throw new Error(`transaction log '${logName}' repeated completed timestamp ${timestamp}`);
				current = { logName, timestamp, keys: new Map(), keyCount: 0, complete: false };
				collected.push(current);
			} else if (entry.logName !== current.logName || entry.txnLogKey !== current.timestamp) {
				throw new Error(`transaction ${current.timestamp} from '${current.logName}' ended without an endTxn boundary`);
			}
			readBytes += entry.size ?? 0;
			const projection = projections.get(entry.tableId);
			if (projection) {
				if (entry.type === 'reload') {
					// A rebuild's replay meets the marker that triggered it again; the scan already covered it.
					const handled = this.#reloadsHandledThrough.get(current.logName);
					if (handled === undefined || handled < current.timestamp) {
						this.#reloadsHandledThrough.set(current.logName, current.timestamp);
						throw new Error(`table ${entry.tableId} requires a derived-index rebuild`);
					}
				} else if (ELIGIBLE_ACTIONS.has(entry.type)) {
					let byRecord = current.keys.get(entry.tableId);
					if (!byRecord) current.keys.set(entry.tableId, (byRecord = new Map()));
					const key = writeKeyId(entry.recordId);
					const known = byRecord.get(key);
					if (known) known.logVersion = entry.version;
					else {
						byRecord.set(key, { recordId: entry.recordId, logVersion: entry.version, sizeHint: entry.size });
						current.keyCount++;
						keyCount++;
					}
				}
			}
			if (entry.endTxn) {
				current.complete = true;
				this.#seenTimestamps.get(current.logName)!.add(current.timestamp);
				let pendingTimestamps = this.#pendingTimestamps.get(current.logName);
				if (!pendingTimestamps) this.#pendingTimestamps.set(current.logName, (pendingTimestamps = []));
				pendingTimestamps.push(current.timestamp);
				current = undefined;
				transactions++;
				if (
					transactions >= options.maxTransactionsPerTurn ||
					readBytes >= options.maxBytesPerTurn ||
					options.now() - started >= options.maxMillisecondsPerTurn
				)
					break;
			} else if (options.now() - started >= options.maxMillisecondsPerTurn) break;
		}
		return collected;
	}

	#resolveCollected(chunk: Chunk, collected: CollectedTransaction[]): DerivedIndexBatch | typeof CONTINUE {
		const through = cloneCursor(this.#offered!);
		let completed = 0;
		for (let i = 0; i < collected.length; i++) {
			const transaction = collected[i];
			if (i > 0 && chunk.batch.bytes >= this.#options.maxChunkBytes) {
				this.#carried = collected.slice(i);
				break;
			}
			const mutations: DerivedIndexMutation[] = [];
			for (const [tableId, byRecord] of transaction.keys) {
				for (const [key, collectedKey] of byRecord) {
					const record = this.#addMutation(chunk, tableId, key, collectedKey);
					mutations.push({
						tableId,
						recordId: collectedKey.recordId,
						logVersion: collectedKey.logVersion,
						state: record.state,
					});
				}
			}
			if (transaction.complete) {
				through.logs[transaction.logName] = transaction.timestamp;
				this.#latestSeen.set(transaction.logName, transaction.timestamp);
				completed++;
				if (mutations.length)
					chunk.batch.transactions.push({ logName: transaction.logName, timestamp: transaction.timestamp, mutations });
			} else {
				if (mutations.length)
					chunk.batch.transactions.push({
						logName: transaction.logName,
						timestamp: transaction.timestamp,
						mutations,
						partial: true,
					});
				// The rest of this transaction is still unread; later turns continue it from an empty identity set.
				this.#carried = [
					{
						logName: transaction.logName,
						timestamp: transaction.timestamp,
						keys: new Map(),
						keyCount: 0,
						complete: false,
					},
				];
			}
		}
		if (completed === 0 && chunk.batch.records.length === 0) return CONTINUE;
		chunk.batch.through = through;
		return chunk.batch;
	}

	#newChunk(rebuild: boolean): Chunk {
		const batch = { ownerEpoch: this.#ownerEpoch!, transactions: [] } as unknown as DerivedIndexBatch;
		// Non-enumerable so the enumerable shape stays the Stage 1 `{ ownerEpoch, transactions, through }` contract.
		Object.defineProperties(batch, {
			records: { value: [], writable: true, configurable: true },
			bytes: { value: 0, writable: true, configurable: true },
		});
		if (rebuild) batch.rebuild = true;
		return { batch, resolved: new Map(), started: this.#options.now() };
	}

	#addMutation(chunk: Chunk, tableId: number, key: unknown, collectedKey: CollectedKey): DerivedIndexMutation {
		let byRecord = chunk.resolved.get(tableId);
		if (!byRecord) chunk.resolved.set(tableId, (byRecord = new Map()));
		let record = byRecord.get(key);
		if (record) {
			record.logVersion = collectedKey.logVersion;
			return record;
		}
		const current = this.#resolveRecord(tableId, collectedKey.recordId);
		const state: DerivedIndexState = current
			? this.#project(chunk, tableId, current.value, current.version, current.size ?? collectedKey.sizeHint)
			: { kind: 'absent' };
		record = { tableId, recordId: collectedKey.recordId, logVersion: collectedKey.logVersion, state };
		byRecord.set(key, record);
		chunk.batch.records.push(record);
		return record;
	}

	#project(
		chunk: Chunk,
		tableId: number,
		value: unknown,
		version: number,
		size: number | undefined
	): DerivedIndexState {
		chunk.batch.bytes += size ?? 0;
		try {
			return { kind: 'record', version, projection: this.#registration.projections.get(tableId)!(value) };
		} catch (error) {
			const statusCode = (error as { statusCode?: unknown })?.statusCode;
			if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) throw error;
			const reason = error instanceof Error && error.message ? error.message : String(error);
			if (this.#unindexableRecords++ === 0)
				logger.warn?.(`Derived index '${this.#registration.backend.id}' skipped a record it cannot project`, error);
			return { kind: 'unindexable', version, reason };
		}
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

	#checkRangeHealth(iterable = this.#iterable): boolean {
		if (!iterable) return true;
		if (iterable.corruptFrameStop.breaks > 0) {
			this.#needsRebuild('transaction log contains a corrupt frame');
			return false;
		}
		if (iterable.failedLogs.size > 0) {
			this.#needsRebuild(`transaction log iterator failed for '${iterable.failedLogs.values().next().value}'`);
			return false;
		}
		if (iterable.exactStartFailures.size > 0) {
			const [logName, failure] = iterable.exactStartFailures.entries().next().value;
			this.#needsRebuild(`transaction log '${logName}' has a ${failure} durable cursor boundary`);
			return false;
		}
		return true;
	}

	#finishIdlePass() {
		const durable = this.#registration.backend.getDurableCursor();
		if (durable === undefined && this.#boundaryPending) return;
		if (!isValidCursor(durable)) {
			this.#needsRebuild('backend lost its durable cursor');
			return;
		}
		if (!this.#reconcileDurableCursor(durable)) return;
		if (!sameCursor(durable, this.#offered!)) return;
		if (this.getReadiness().state !== 'ready') this.#publishReadiness('ready');
		this.#rebuildAttempts = 0;
		if (this.#idleTimer) return;
		this.status = { state: 'idle', ownerEpoch: this.#ownerEpoch };
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (!this.#stopped && sameCursor(this.#registration.backend.getDurableCursor(), this.#offered!)) this.#release();
		}, this.#options.idleGraceMilliseconds);
	}

	#reconcileDurableCursor(cursor = this.#registration.backend.getDurableCursor()): boolean {
		if (cursor === undefined && this.#boundaryPending) return true;
		if (!isValidCursor(cursor)) {
			this.#needsRebuild('backend returned an invalid durable cursor');
			return false;
		}
		const offeredIndex = this.#offeredCursors.findIndex((offered) => sameCursor(cursor, offered.cursor));
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
		this.#boundaryPending = false;
		if (offeredIndex > 0) this.#offeredCursors.splice(0, offeredIndex);
		return true;
	}

	#backendStateChanged(change: DerivedIndexBackendStateChange) {
		if (this.#stopped || this.status.state === 'unavailable') return;
		if (change === 'failed') {
			this.#needsRebuild('backend reported a permanent failure');
			return;
		}
		if (this.#rebuilding) {
			if (change === 'accepted-work-lost') {
				this.#rebuildFailed('backend lost accepted rebuild work');
				return;
			}
			if (this.#rebuildWaiter) this.#rebuildWaiter();
			else this.#rebuildWakePending = true;
			return;
		}
		if (this.status.state === 'needs-rebuild') return;
		if (change === 'accepted-work-lost' && this.#owned) {
			this.#discardProgress();
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
		if (this.#rebuilding) {
			this.#rebuildFailed(reason, error);
			return;
		}
		if (this.status.state !== 'needs-rebuild')
			logger.error(`Derived index '${this.#registration.backend.id}' needs rebuild: ${reason}`, error);
		this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
		this.#discardProgress();
		if (!this.#owned) return;
		if (this.#canRebuild()) {
			// A failure after a rebuild but before `ready` is that rebuild failing late; it counts against the cap.
			if (this.#rebuildAttempts >= this.#options.maxRebuildAttempts) {
				this.#becomeUnavailable(reason, error);
				return;
			}
			this.#publishReadiness('needs-rebuild', reason);
			this.#rebuildRequested = true;
			this.#scheduleRebuild();
			return;
		}
		this.#publishReadiness('needs-rebuild', reason);
		this.#release();
	}

	#becomeUnavailable(reason: string, error?: unknown) {
		logger.error(
			`Derived index '${this.#registration.backend.id}' is unavailable after ${this.#rebuildAttempts} rebuild attempts: ${reason}`,
			error
		);
		this.status = { state: 'unavailable', reason, ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('unavailable', reason);
		this.#release();
	}

	#discardProgress() {
		this.#generation++;
		this.#pendingBatch = undefined;
		this.#carried = [];
		this.#iterator = undefined;
		this.#iterable = undefined;
		this.#boundaryPending = false;
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
	}

	#scheduleRebuild() {
		if (this.#rebuildTimer || this.#stopped) return;
		const attempt = this.#rebuildAttempts;
		if (attempt === 0) {
			this.#startRebuild();
			return;
		}
		const delay = Math.min(
			this.#options.rebuildBackoffMilliseconds * 2 ** (attempt - 1),
			this.#options.maxRebuildBackoffMilliseconds
		);
		this.#rebuildTimer = setTimeout(() => {
			this.#rebuildTimer = undefined;
			if (this.#stopped) return;
			if (this.#owned) this.#startRebuild();
			else this.wake(true);
		}, delay);
		this.#rebuildTimer.unref?.();
	}

	#startRebuild() {
		if (!this.#owned || this.#rebuilding || this.#stopped) return;
		this.#rebuildRequested = false;
		this.#rebuilding = true;
		this.#rebuildWakePending = false;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		this.#discardProgress();
		const generation = this.#generation;
		this.status = { state: 'rebuilding', ownerEpoch: this.#ownerEpoch };
		this.#rebuildAttempts++;
		this.#publishReadiness('rebuilding');
		this.#runRebuild(generation).then(
			() => {
				if (!this.#live(generation)) return;
				this.#rebuilding = false;
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
				this.#drain();
			},
			(error) => {
				if (!this.#live(generation)) return;
				this.#rebuildFailed(error instanceof Error && error.message ? error.message : String(error), error);
			}
		);
	}

	#live(generation: number): boolean {
		return this.#owned && !this.#stopped && this.#generation === generation;
	}

	async #runRebuild(generation: number) {
		const backend = this.#registration.backend;
		// Work accepted under the previous epoch must be quiescent before anything destructive; a new
		// epoch then fences any completion that still arrives for it.
		await backend.shutdown?.(this.#ownerEpoch!);
		if (!this.#live(generation)) return;
		this.#ownerEpoch = this.#mintEpoch();
		this.status = { state: 'rebuilding', ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('rebuilding');
		backend.reset!(this.#ownerEpoch);
		if (backend.getDurableCursor() !== undefined) throw new Error('backend kept a durable cursor after reset');
		const boundary = this.#captureBoundary();
		const options = this.#options;
		let chunk = this.#newChunk(true);
		let indexed = 0;
		for (const [tableId] of this.#registration.projections) {
			for (const record of this.#scanRecords!(tableId)) {
				this.#addScanRecord(chunk, tableId, record);
				indexed++;
				if (
					chunk.batch.records.length >= options.maxChunkRecords ||
					chunk.batch.bytes >= options.maxChunkBytes ||
					options.now() - chunk.started >= options.maxMillisecondsPerTurn
				) {
					await this.#deliverRebuildChunk(chunk, generation);
					if (!this.#live(generation)) return;
					chunk = this.#newChunk(true);
				}
			}
		}
		chunk.batch.through = boundary;
		await this.#deliverRebuildChunk(chunk, generation);
		if (!this.#live(generation)) return;
		this.#rebuiltRecords = indexed;
		if (!this.#installCursor(boundary)) return;
		this.#boundaryPending = true;
		logger.info?.(`Rebuilt derived index '${backend.id}' from ${indexed} records; replaying the retained log`);
	}

	#addScanRecord(chunk: Chunk, tableId: number, record: DerivedIndexScanRecord) {
		const key = writeKeyId(record.recordId);
		let byRecord = chunk.resolved.get(tableId);
		if (!byRecord) chunk.resolved.set(tableId, (byRecord = new Map()));
		if (byRecord.has(key)) return;
		const mutation: DerivedIndexMutation = {
			tableId,
			recordId: record.recordId,
			logVersion: record.version,
			state: this.#project(chunk, tableId, record.value, record.version, record.size),
		};
		byRecord.set(key, mutation);
		chunk.batch.records.push(mutation);
	}

	async #deliverRebuildChunk(chunk: Chunk, generation: number) {
		while (true) {
			if (!this.#live(generation)) return;
			const result = this.#deliver(chunk.batch);
			if (result === undefined) {
				if (this.#live(generation)) throw new Error('rebuild delivery was rejected');
				return;
			}
			if (result === DERIVED_INDEX_ACCEPTED) break;
			await this.#waitForBackend();
		}
		this.#noteAccepted(chunk.batch);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	#waitForBackend(): Promise<void> {
		if (this.#rebuildWakePending) {
			this.#rebuildWakePending = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.#rebuildWaiter = () => {
				this.#rebuildWaiter = undefined;
				resolve();
			};
		});
	}

	/** The oldest retained committed transaction of every log; logs with none must still retain their beginning. */
	#captureBoundary(): DerivedIndexCursor {
		const boundary: DerivedIndexCursor = { format: 1, logs: {} };
		for (const logName of this.#logStore.rootStore.listLogs()) {
			let first: number | undefined;
			const range = this.#logStore.getRange({ log: logName, start: 0 });
			for (const entry of range) {
				first = entry.txnLogKey;
				break;
			}
			if (range.corruptFrameStop.breaks > 0 || range.failedLogs.size > 0)
				throw new Error(`transaction log '${logName}' cannot be read at its retained beginning`);
			if (first === undefined) {
				if (this.#logStore.rootStore.useLog(logName).getStats().oldestSequenceNumber !== 1)
					throw new Error(`transaction log '${logName}' retains no committed transaction and has lost its beginning`);
				continue;
			}
			boundary.logs[logName] = first;
		}
		return boundary;
	}

	#rebuildFailed(reason: string, error?: unknown) {
		this.#rebuilding = false;
		this.#rebuildWaiter?.();
		this.#discardProgress();
		if (this.#rebuildAttempts >= this.#options.maxRebuildAttempts) {
			this.#becomeUnavailable(reason, error);
			return;
		}
		logger.error(
			`Derived index '${this.#registration.backend.id}' rebuild attempt ${this.#rebuildAttempts} failed: ${reason}`,
			error
		);
		this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('needs-rebuild', reason);
		this.#rebuildRequested = true;
		if (this.#owned) this.#scheduleRebuild();
	}

	#publishReadiness(state: DerivedIndexReadinessState, reason = '') {
		const words = this.#readinessWords;
		// Force the sequence odd rather than incrementing, so a publication abandoned by a dead owner is repaired.
		const sequence = Atomics.load(words, READINESS_SEQUENCE) | 1;
		Atomics.store(words, READINESS_SEQUENCE, sequence);
		const encoded = textEncoder.encodeInto(reason, this.#readinessBytes);
		Atomics.store(words, READINESS_STATE, READINESS_STATES.indexOf(state));
		Atomics.store(words, READINESS_REASON_LENGTH, encoded.written);
		Atomics.store(words, READINESS_ATTEMPTS, state === 'ready' ? 0 : this.#rebuildAttempts);
		Atomics.store(this.#readinessEpoch, 0, this.#ownerEpoch ?? 0n);
		Atomics.store(words, READINESS_SEQUENCE, sequence + 1);
	}

	#release() {
		if (!this.#owned) return;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		if (this.#rebuildTimer) {
			clearTimeout(this.#rebuildTimer);
			this.#rebuildTimer = undefined;
		}
		this.#owned = false;
		this.#rebuilding = false;
		this.#rebuildWaiter?.();
		this.#discardProgress();
		const backend = this.#registration.backend;
		const epoch = this.#ownerEpoch!;
		const unlock = () => {
			this.#releasing = undefined;
			try {
				this.#logStore.unlock(this.#lockKey);
			} catch (error) {
				logger.error(`Failed to release derived index runner '${backend.id}'`, error);
			}
		};
		// A backend that cannot prove its queued work is quiescent keeps the lock: handing the index to
		// another owner while the old epoch may still write into it is the unsafe outcome.
		const hold = (error: unknown) => {
			this.#releasing = undefined;
			const reason = `backend shutdown failed; runner lock held: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(`Derived index '${backend.id}' ${reason}`, error);
			this.status = { state: 'unavailable', reason, ownerEpoch: epoch };
			this.#publishReadiness('unavailable', reason);
		};
		let settled: void | Promise<void>;
		try {
			backend.flush?.('shutdown');
			settled = backend.shutdown?.(epoch);
		} catch (error) {
			hold(error);
			return;
		}
		if (settled && typeof settled.then === 'function') this.#releasing = settled.then(unlock, hold);
		else unlock();
	}
}

function lastOpen(collected: CollectedTransaction[]): CollectedTransaction | undefined {
	const last = collected[collected.length - 1];
	return last && !last.complete ? last : undefined;
}

function readinessBuffer(logStore: RocksTransactionLogStore, backendId: string) {
	return logStore.getUserSharedBuffer(`derived-index:${backendId}:readiness`, new ArrayBuffer(READINESS_BYTES));
}

function readReadiness(words: Int32Array, epoch: BigInt64Array, bytes: Uint8Array): DerivedIndexReadiness {
	// Bounded seqlock read: a publication abandoned mid-write by a dead owner yields `unknown`, never a spin.
	for (let spin = 0; spin < 64; spin++) {
		const before = Atomics.load(words, READINESS_SEQUENCE);
		if (before & 1) continue;
		const state = READINESS_STATES[Atomics.load(words, READINESS_STATE)] ?? 'unknown';
		const length = Atomics.load(words, READINESS_REASON_LENGTH);
		const rebuildAttempts = Atomics.load(words, READINESS_ATTEMPTS);
		const ownerEpoch = Atomics.load(epoch, 0);
		const reason = length > 0 ? textDecoder.decode(bytes.slice(0, length)) : undefined;
		if (Atomics.load(words, READINESS_SEQUENCE) !== before) continue;
		return reason === undefined
			? { state, ownerEpoch, rebuildAttempts }
			: { state, reason, ownerEpoch, rebuildAttempts };
	}
	return {
		state: 'unknown',
		ownerEpoch: Atomics.load(epoch, 0),
		rebuildAttempts: Atomics.load(words, READINESS_ATTEMPTS),
	};
}

/** Read an index's shared readiness on any worker, without a registered runtime. */
export function readDerivedIndexReadiness(
	logStore: RocksTransactionLogStore,
	backendId: string
): DerivedIndexReadiness {
	const buffer = readinessBuffer(logStore, backendId);
	return readReadiness(
		new Int32Array(buffer, 0, 4),
		new BigInt64Array(buffer, 16, 1),
		new Uint8Array(buffer, READINESS_REASON_OFFSET)
	);
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

function sameCursor(left: DerivedIndexCursor | undefined, right: DerivedIndexCursor | undefined): boolean {
	if (!isValidCursor(left) || !isValidCursor(right)) return false;
	const leftNames = Object.keys(left.logs);
	const rightNames = Object.keys(right.logs);
	if (leftNames.length !== rightNames.length) return false;
	for (const name of leftNames) if (left.logs[name] !== right.logs[name]) return false;
	return true;
}
