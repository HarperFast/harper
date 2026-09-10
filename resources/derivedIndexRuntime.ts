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
	/**
	 * Present on a chunk of an oversized transaction that does not include its `endTxn` entry. A
	 * backend applies such chunks like any other and may expose a transaction's earlier chunks before
	 * its later ones: the runtime withholds the cursor until the closing chunk, but query-visible
	 * atomicity of one transaction is not preserved across chunks.
	 */
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
	bytes: number;
	rebuild?: true;
};

export type DerivedIndexFlushReason = 'age' | 'threshold' | 'shutdown';

export type DerivedIndexReadinessState = 'unknown' | 'ready' | 'rebuilding' | 'needs-rebuild' | 'unavailable';

export type DerivedIndexReadiness = {
	state: DerivedIndexReadinessState;
	reason?: string;
	ownerEpoch: bigint;
	rebuildAttempts: number;
};

export interface DerivedIndexBackendHost {
	/** True while `epoch` is the most recently minted owner epoch for this backend. */
	isOwnerEpoch(epoch: bigint): boolean;
	getReadiness(): DerivedIndexReadiness;
}

interface DerivedIndexBackendBase {
	readonly id: string;
	getDurableCursor(): DerivedIndexCursor | undefined;
	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult;
	onStateChange(wake: (change?: DerivedIndexBackendStateChange) => void): () => void;
	/**
	 * Destroy index state and the durable cursor; `getDurableCursor()` must return `undefined`
	 * afterwards. Crash safety is the backend's: its first durable action must invalidate the cursor
	 * (or the generation the cursor belongs to) before anything destructive, so an interrupted reset
	 * reopens as cursorless rather than as a valid cursor over partially destroyed state. Shared
	 * readiness is process memory and is no evidence after a restart.
	 */
	reset?(ownerEpoch: bigint): void | Promise<void>;
}

/**
 * A backend with no asynchronous effects: `deliver()` applies and makes the batch durable before
 * returning, `flush` (if any) completes before returning, and nothing it does survives a method
 * return, so nothing of its can publish after the runner released the lock.
 */
export interface SynchronousDerivedIndexBackend extends DerivedIndexBackendBase {
	asynchronous?: false;
	attach?(host: DerivedIndexBackendHost): void;
	flush?(reason: DerivedIndexFlushReason): void;
	shutdown?(ownerEpoch: bigint): void | Promise<void>;
}

/**
 * A backend with asynchronous effects — a queued apply, a barrier that completes later, or a
 * durable cursor that trails delivery. Work that survives a method return is the safety boundary,
 * so registration rejects it unless it provides the fence, the barrier request and the quiescence
 * handshake the handoff protocol needs.
 */
export interface AsynchronousDerivedIndexBackend extends DerivedIndexBackendBase {
	readonly asynchronous: true;
	/** Receives the epoch fence and readiness reader before any delivery. */
	attach(host: DerivedIndexBackendHost): void;
	/** Request a durability barrier; the backend runs it asynchronously and wakes through `onStateChange`. */
	flush(reason: DerivedIndexFlushReason): void | Promise<void>;
	/**
	 * Stop accepting work for `ownerEpoch`, settle or discard what is queued, and resolve once nothing
	 * further will be applied or published for it. A rejection keeps the runner lock held.
	 */
	shutdown(ownerEpoch: bigint): void | Promise<void>;
}

export type DerivedIndexBackend = SynchronousDerivedIndexBackend | AsynchronousDerivedIndexBackend;

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
	/**
	 * Opt-in writer backpressure: while the index is further behind than this, user writes to its
	 * tables fail with a retryable 503 on every worker. 0 (the default) means no policy.
	 */
	maxLagMilliseconds?: number;
};

export type DerivedIndexRegistration = {
	backend: DerivedIndexBackend;
	projections: ReadonlyMap<number, (record: unknown) => unknown>;
	options?: DerivedIndexRunnerOptions;
};

/**
 * `size` is the stored byte size of the record when known; it bounds the projection's size without
 * serializing it. Resolve a missing, deleted or evicted record as `undefined`; a present entry is
 * projected as-is, so an undecodable body fails closed instead of silently leaving the index.
 */
export type DerivedIndexRecord = { version: number; value: unknown; size?: number } | undefined;

/** A scan record whose `value` is null or undefined is a tombstone, and one whose `recordId` is a symbol is a Harper-internal store entry; neither is indexed. */
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
	/** Lag between the latest transaction this runner has read and the durable cursor; blind while parked. */
	cursorLagMilliseconds: number;
	/** How long the runner has been parked on backend backpressure or the durability ceiling. */
	stalledMilliseconds: number;
	unindexableRecords: number;
	rebuildAttempts: number;
	rebuiltRecords: number;
	/** How long the current epoch's quiescence (backend shutdown, undeclared asynchronous work) has been pending. */
	quiescenceAgeMilliseconds: number;
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
const CONDEMNED_MARKER = new Uint8Array([1]);
const READINESS_WORDS = 6;
const READINESS_EPOCH_OFFSET = 24;
const READINESS_RELOADS_OFFSET = 32;
const READINESS_REASON_OFFSET = 40;
const READINESS_SEQUENCE = 0;
const READINESS_STATE = 1;
const READINESS_REASON_LENGTH = 2;
const READINESS_ATTEMPTS = 3;
const READINESS_REBUILD_REQUEST = 4;
const READINESS_LAG_EXCEEDED = 5;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class DerivedIndexRuntime {
	#logStore: RocksTransactionLogStore;
	#resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord;
	#scanRecords?: (tableId: number) => Iterable<DerivedIndexScanRecord>;
	#options: ResolvedRunnerOptions;
	#runners = new Map<string, DerivedIndexRunner>();
	#pendingStops = new Set<Promise<void>>();
	#heldRunners = new Map<string, { runner: DerivedIndexRunner; stopped: Promise<void> }>();
	#stopping?: Promise<void>;
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

	register(registration: DerivedIndexRegistration): () => Promise<void> {
		if (this.#stopped) throw new Error('Derived index runtime is stopped');
		if (!registration.backend.id) throw new Error('Derived index backend id is required');
		if (registration.backend.asynchronous === true) {
			for (const hook of ['attach', 'flush', 'shutdown'] as const) {
				if (typeof registration.backend[hook] !== 'function')
					throw new TypeError(
						`Asynchronous derived index backend '${registration.backend.id}' must implement ${hook}()`
					);
			}
		}
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
			if (this.#runners.get(registration.backend.id) === runner) {
				this.#runners.delete(registration.backend.id);
				this.#stopListeningIfIdle();
			}
			return this.#track(runner, runner.stop());
		};
	}

	#track(runner: DerivedIndexRunner, stopped: Promise<void>): Promise<void> {
		this.#pendingStops.add(stopped);
		// A failed shutdown stays pending and its runner stays reachable, so a later stop() keeps
		// reporting the held lock and requestRebuild() can retry releasing it.
		stopped.then(
			() => this.#pendingStops.delete(stopped),
			() => this.#heldRunners.set(runner.id, { runner, stopped })
		);
		return stopped;
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
		const held = this.#heldRunners.get(backendId);
		if (held) {
			const released = held.runner.retryRelease();
			this.#pendingStops.add(released);
			released.then(
				() => {
					this.#pendingStops.delete(released);
					this.#pendingStops.delete(held.stopped);
					if (this.#heldRunners.get(backendId) === held) this.#heldRunners.delete(backendId);
				},
				() => {}
			);
		}
		const runner = this.#runners.get(backendId);
		if (runner) return runner.requestRebuild();
		return held !== undefined;
	}

	/** Resolves once every runner has released ownership and its backend shutdown has settled. */
	stop(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#stopped = true;
		for (const runner of this.#runners.values()) this.#track(runner, runner.stop());
		this.#runners.clear();
		this.#stopListening();
		this.#stopping = Promise.allSettled([...this.#pendingStops]).then((results) => {
			const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
			if (failures.length === 1) throw failures[0];
			if (failures.length) throw new AggregateError(failures, 'derived index backends failed to shut down');
		});
		this.#stopping.catch(() => {});
		return this.#stopping;
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
		maxLagMilliseconds: 0,
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
		maxLagMilliseconds: Math.max(0, options.maxLagMilliseconds ?? base.maxLagMilliseconds),
	};
}

/** Catch-up is proven only at a durable barrier, so a lag budget below two flush ages would trip on cadence alone. */
function effectiveLagBudget(options: Required<DerivedIndexRunnerOptions>): number {
	return options.maxLagMilliseconds > 0 ? Math.max(options.maxLagMilliseconds, 2 * options.maxFlushAgeMilliseconds) : 0;
}

type OfferedProgress = { cursor: DerivedIndexCursor; bytes: number; mutations: number; acceptedAt: number };

type CollectedKey = { recordId: Id; logVersion: number; sizeHint: number | undefined };

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

const CONTINUE = null;

class DerivedIndexRunner {
	#logStore: RocksTransactionLogStore;
	#resolveRecord: (tableId: number, recordId: Id) => DerivedIndexRecord;
	#scanRecords?: (tableId: number) => Iterable<DerivedIndexScanRecord>;
	#registration: DerivedIndexRegistration;
	#options: ResolvedRunnerOptions;
	#lockKey: string;
	#markerKey: symbol;
	#markersSupported: boolean;
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
	#carried: CollectedTransaction[] = [];
	#latestSeen = new Map<string, number>();
	#stalledSince?: number;
	#lastCaughtUpAt?: number;
	#lagTimer?: NodeJS.Timeout;
	#lockRetryTimer?: NodeJS.Timeout;
	#lagBudget: number;
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
	#releasingSince?: number;
	#releaseFailure?: Error;
	#stopResult?: Promise<void>;
	#heldLock = false;
	#quiescing?: { epoch: bigint; promise: Promise<void>; since: number };
	#condemned = false;
	#unreadSince?: number;
	#reachedEndOfLog = false;
	#rebuilding = false;
	#rebuildRequested = false;
	#boundaryPending = false;
	#rebuildAttempts = 0;
	#rebuiltRecords = 0;
	#unindexableRecords = 0;
	#allUnindexableWarned = false;
	#rebuildWaiter?: () => void;
	#rebuildWakePending = false;
	#unsubscribeBackend: () => void;
	#unregisterTables: () => void;
	#ownerEpoch?: bigint;
	#epochView: BigInt64Array;
	#readinessBuffer: SharedReadinessBuffer;
	#sharedViews: SharedViews;
	#resetting?: Promise<void>;
	#undeclaredAsync?: Promise<void>;
	status: DerivedIndexRunnerStatus = { state: 'idle' };

	get id() {
		return this.#registration.backend.id;
	}

	retryRelease(): Promise<void> {
		if (!this.#heldLock) return this.#stopResult ?? Promise.resolve();
		this.#heldLock = false;
		this.#releaseFailure = undefined;
		this.#owned = true;
		this.#release();
		this.#stopResult = (this.#releasing ?? Promise.resolve()).then(() => {
			if (this.#releaseFailure) throw this.#releaseFailure;
			this.#unregisterTables();
		});
		this.#stopResult.catch(() => {});
		return this.#stopResult;
	}

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
		this.#markerKey = Symbol.for(`derived-index:${registration.backend.id}:condemned`);
		const root = logStore.rootStore as { getSync?: unknown; removeSync?: unknown } | undefined;
		this.#markersSupported =
			typeof logStore.putSync === 'function' &&
			typeof root?.getSync === 'function' &&
			typeof root?.removeSync === 'function';
		this.#lagBudget = effectiveLagBudget(options);
		this.#readinessBuffer = readinessBuffer(logStore, registration.backend.id, () => {
			if (this.#owned) this.wake(true);
		});
		this.#sharedViews = sharedViewsOf(this.#readinessBuffer);
		this.#epochView = new BigInt64Array(
			logStore.getUserSharedBuffer(`derived-index:${registration.backend.id}:owner-epoch`, new ArrayBuffer(8))
		);
		try {
			registration.backend.attach?.({
				isOwnerEpoch: (epoch) => Atomics.load(this.#epochView, 0) === epoch,
				getReadiness: () => this.getReadiness(),
			});
			this.#unsubscribeBackend = registration.backend.onStateChange((change = 'changed') =>
				this.#backendStateChanged(change)
			);
		} catch (error) {
			this.#readinessBuffer.cancel?.();
			throw error;
		}
		this.#unregisterTables = registerDerivedIndexTables(
			logStore,
			registration.projections.keys(),
			this.#lagBudget > 0 ? () => this.#writeRejection() : undefined
		);
	}

	/**
	 * rocksdb-js wraps one process-wide native allocation per key in a new external ArrayBuffer on every
	 * call and never re-seeds an existing entry, so each view is fetched once and held for the runner's
	 * life; the held wrapper keeps the allocation alive.
	 */
	#shared(): SharedViews {
		return this.#sharedViews;
	}

	wake(fromBackend = false) {
		if (this.#stopped || this.#rebuilding) return;
		if (!fromBackend && this.#lagBudget > 0) this.#unreadSince ??= this.#options.now();
		if (this.status.state === 'unavailable') {
			if (
				this.#heldLock ||
				Atomics.load(this.#shared().words, READINESS_STATE) === READINESS_STATES.indexOf('unavailable')
			)
				return;
			this.status = { state: 'idle' };
		}
		// A shared rebuild request must reach an owner parked on backpressure or backoff at its next wake.
		const requested = Atomics.load(this.#shared().words, READINESS_REBUILD_REQUEST) === 1;
		if (!requested) {
			if (this.status.state === 'needs-rebuild' && (this.#rebuildTimer || !this.#rebuildRequested)) return;
			if (!fromBackend && (this.status.state === 'deferred' || this.status.state === 'waiting-durable')) return;
		}
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

	/**
	 * Rejects when the backend could not prove its queued work quiescent; the runner lock stays held
	 * then. Callers await it before closing storage: it resolves only once nothing can still write.
	 */
	stop(): Promise<void> {
		if (this.#stopResult) return this.#stopResult;
		this.#stopped = true;
		this.status = { state: 'stopped', ownerEpoch: this.#ownerEpoch };
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		if (this.#rebuildTimer) clearTimeout(this.#rebuildTimer);
		if (this.#lockRetryTimer) clearTimeout(this.#lockRetryTimer);
		this.#rebuildTimer = undefined;
		try {
			this.#unsubscribeBackend?.();
			this.#readinessBuffer.cancel?.();
		} catch (error) {
			logger.warn?.(`Derived index '${this.id}' cleanup hook threw`, error);
		}
		this.#release();
		this.#stopResult = (this.#releasing ?? Promise.resolve()).then(() => {
			if (this.#releaseFailure) throw this.#releaseFailure;
			this.#unregisterTables();
		});
		this.#stopResult.catch(() => {});
		return this.#stopResult;
	}

	getReadiness(): DerivedIndexReadiness {
		const views = this.#shared();
		return readReadiness(views.words, views.epoch, views.bytes);
	}

	getMetrics(): DerivedIndexRunnerMetrics {
		const now = this.#options.now();
		let acceptedBytes = this.#unanchoredBytes;
		let acceptedMutations = this.#unanchoredMutations;
		const oldestAcceptedAt = this.#oldestAcceptedAt();
		for (let i = 1; i < this.#offeredCursors.length; i++) {
			acceptedBytes += this.#offeredCursors[i].bytes;
			acceptedMutations += this.#offeredCursors[i].mutations;
		}
		const cursorLag = this.#cursorLag();
		return {
			readiness: this.getReadiness(),
			acceptedBatches: Math.max(0, this.#offeredCursors.length - 1),
			acceptedBytes,
			acceptedMutations,
			deferredBytes: this.#pendingBatch?.bytes ?? 0,
			oldestAcceptedAgeMilliseconds: oldestAcceptedAt === undefined ? 0 : Math.max(0, now - oldestAcceptedAt),
			cursorLagMilliseconds: cursorLag,
			stalledMilliseconds: this.#stalledSince === undefined ? 0 : Math.max(0, now - this.#stalledSince),
			unindexableRecords: this.#unindexableRecords,
			rebuildAttempts: this.#rebuildAttempts,
			rebuiltRecords: this.#rebuiltRecords,
			quiescenceAgeMilliseconds:
				this.#releasingSince === undefined && this.#quiescing === undefined
					? 0
					: Math.max(0, now - Math.min(this.#releasingSince ?? Infinity, this.#quiescing?.since ?? Infinity)),
		};
	}

	#cursorLag(): number {
		let cursorLag = 0;
		const durable = this.#offeredCursors[0]?.cursor;
		if (durable) {
			for (const [logName, latest] of this.#latestSeen) {
				const position = durable.logs[logName];
				if (position !== undefined && latest > position) cursorLag = Math.max(cursorLag, latest - position);
			}
		}
		return cursorLag;
	}

	#writeRejection(): string | undefined {
		if (Atomics.load(this.#shared().words, READINESS_LAG_EXCEEDED) !== 1) return;
		return `derived index '${this.id}' is more than ${this.#lagBudget} ms behind; retry this write`;
	}

	/**
	 * Time since the oldest commit this runner may not have read, bounded by how far the newest
	 * entry it has read trails the clock: a reader that never quite empties a steadily fed log is
	 * behind by that distance, not by the age of its first unread commit.
	 */
	#unreadAge(now: number): number {
		if (this.#unreadSince === undefined) return 0;
		let newestRead = -Infinity;
		for (const latest of this.#latestSeen.values()) if (latest > newestRead) newestRead = latest;
		return Math.max(0, Math.min(now - this.#unreadSince, now - newestRead));
	}

	#oldestAcceptedAt(): number | undefined {
		if (this.#offeredCursors.length > 1) return this.#offeredCursors[1].acceptedAt;
		return this.#unanchoredMutations > 0 ? this.#unanchoredAcceptedAt : undefined;
	}

	/**
	 * Owner-only. Lag is the longest of four terms: cursor distance behind what this runner has read,
	 * time parked on backpressure, time since the oldest commit this runner may not have read yet (a
	 * reader too slow to reach the end of the log cannot hide), and the age of the oldest accepted
	 * work not yet durable (a backend that accepts but never barriers cannot hide). All four are zero
	 * for a caught-up owner sitting idle and stay within drain latency plus flush age for a runner
	 * keeping up under sustained ingest. The trip survives discard and handoff: a successor clears it
	 * only after proving catch-up itself — a durable advance and the end of the log both reached since
	 * it acquired, so an inherited backlog cannot be cleared by one barrier — below half the budget.
	 */
	#publishLag() {
		const max = this.#lagBudget;
		if (max <= 0 || !this.#owned || this.#rebuilding) return;
		const now = this.#options.now();
		const oldestAccepted = this.#oldestAcceptedAt();
		const lag = Math.max(
			this.#cursorLag(),
			this.#stalledSince === undefined ? 0 : now - this.#stalledSince,
			this.#unreadAge(now),
			oldestAccepted === undefined ? 0 : now - oldestAccepted
		);
		const words = this.#shared().words;
		const tripped = Atomics.load(words, READINESS_LAG_EXCEEDED) === 1;
		if (!tripped && lag >= max) {
			Atomics.store(words, READINESS_LAG_EXCEEDED, 1);
			logger.warn?.(`Derived index '${this.id}' is ${Math.round(lag)} ms behind; rejecting writes until it catches up`);
		} else if (tripped && lag < max / 2 && this.#lastCaughtUpAt !== undefined && this.#reachedEndOfLog) {
			Atomics.store(words, READINESS_LAG_EXCEEDED, 0);
			logger.info?.(`Derived index '${this.id}' caught up; admitting writes again`);
		}
		if (this.#lagTimer) return;
		this.#lagTimer = setTimeout(
			() => {
				this.#lagTimer = undefined;
				if (this.#owned && !this.#stopped) this.#publishLag();
			},
			Math.min(1000, Math.max(1, max / 4))
		);
		this.#lagTimer.unref?.();
	}

	requestRebuild(): boolean {
		if (this.#stopped || !this.#canRebuild()) return false;
		if (this.#rebuilding) return true;
		this.#rebuildAttempts = 0;
		if (this.#rebuildTimer) {
			clearTimeout(this.#rebuildTimer);
			this.#rebuildTimer = undefined;
		}
		if (this.status.state === 'unavailable') {
			this.status = { state: 'needs-rebuild', reason: this.status.reason, ownerEpoch: this.#ownerEpoch };
		}
		if (this.#owned) {
			this.#startRebuild();
			return true;
		}
		if (this.#heldLock) {
			this.#rebuildRequested = true;
			this.#acquired(true);
			return true;
		}
		// The owner may be another worker that never idles: leave the request where every runner looks,
		// and notify whoever holds the buffer's callback.
		Atomics.store(this.#shared().words, READINESS_REBUILD_REQUEST, 1);
		this.#readinessBuffer.notify?.();
		this.wake(true);
		return true;
	}

	#takeSharedRebuildRequest(): boolean {
		return Atomics.exchange(this.#shared().words, READINESS_REBUILD_REQUEST, 0) === 1;
	}

	#canRebuild(): boolean {
		return typeof this.#registration.backend.reset === 'function' && this.#scanRecords !== undefined;
	}

	#acquire() {
		if (this.#waitingForLock || this.#lockRetryTimer) return;
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
		} catch (error) {
			this.#waitingForLock = false;
			logger.error(`Derived index '${this.id}' could not attempt the runner lock; retrying`, error);
			if (!this.#lockRetryTimer) {
				this.#lockRetryTimer = setTimeout(() => {
					this.#lockRetryTimer = undefined;
					this.wake(true);
				}, this.#options.rebuildBackoffMilliseconds);
				this.#lockRetryTimer.unref?.();
			}
			return;
		}
		this.#waitingForLock = false;
		this.#acquired();
	}

	#acquired(reviving = false) {
		this.#heldLock = false;
		this.#releaseFailure = undefined;
		this.#owned = true;
		this.#generation++;
		this.#lastCaughtUpAt = undefined;
		this.#unreadSince = this.#options.now();
		this.#reachedEndOfLog = false;
		try {
			if (!reviving) this.#ownerEpoch = this.#mintEpoch();
			this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			const condemned = this.#readCondemnation();
			const shared = this.getReadiness();
			const reloadsThrough = Number(Atomics.load(this.#shared().reloads, 0));
			if (reloadsThrough > 0)
				for (const logName of this.#logStore.rootStore.listLogs())
					this.#reloadsHandledThrough.set(
						logName,
						Math.max(this.#reloadsHandledThrough.get(logName) ?? 0, reloadsThrough)
					);
			if (this.#takeSharedRebuildRequest()) {
				this.#rebuildRequested = true;
				this.#rebuildAttempts = 0;
			} else if (!this.#rebuildRequested) this.#rebuildAttempts = shared.rebuildAttempts;
			if (this.#rebuildRequested && this.#canRebuild()) {
				this.#startRebuild();
				return;
			}
			if (shared.state === 'unavailable') {
				this.status = {
					state: 'unavailable',
					reason: shared.reason ?? 'index unavailable',
					ownerEpoch: this.#ownerEpoch,
				};
				this.#admitWrites();
				this.#release();
				return;
			}
			if (shared.state === 'needs-rebuild' || shared.state === 'rebuilding') {
				if (this.#canRebuild()) this.#startRebuild();
				else {
					if (this.#writeCondemnation()) this.#rebuildRequested = false;
					this.status = {
						state: 'needs-rebuild',
						reason: shared.reason ?? 'condemned by a previous owner',
						ownerEpoch: this.#ownerEpoch,
					};
					this.#release();
				}
				return;
			}
			if (condemned) {
				this.#needsRebuild('condemned before a restart; the durable cursor is not trusted');
				return;
			}
			this.#resetFromDurableCursor();
			if (this.#owned && !this.#rebuilding) this.#drain();
		} catch (error) {
			this.#fail('failed to initialize the runner', error);
		}
	}

	#mintEpoch(): bigint {
		return Atomics.add(this.#epochView, 0, 1n) + 1n;
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

	#installCursor(cursor: DerivedIndexCursor): boolean {
		this.#validateLogSet(cursor);
		if (!this.#owned || this.status.state === 'needs-rebuild' || this.status.state === 'unavailable') return false;
		this.#offered = cloneCursor(cursor);
		this.#offeredCursors = [{ cursor: cloneCursor(cursor), bytes: 0, mutations: 0, acceptedAt: this.#options.now() }];
		this.#unanchoredBytes = 0;
		this.#unanchoredMutations = 0;
		this.#unflushedBytes = 0;
		this.#unflushedMutations = 0;
		this.#pendingBatch = undefined;
		this.#carried = [];
		this.#latestSeen.clear();
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
		if (this.#canRebuild() && this.#takeSharedRebuildRequest()) {
			if (this.#rebuildTimer) {
				clearTimeout(this.#rebuildTimer);
				this.#rebuildTimer = undefined;
			}
			this.#rebuildAttempts = 0;
			this.#startRebuild();
			return;
		}
		if (this.status.state === 'needs-rebuild' || this.status.state === 'unavailable') return;
		const generation = this.#generation;
		const now = this.#options.now();
		this.#publishLag();
		try {
			if (!this.#checkNewLogs() || !this.#checkRangeHealth()) return;
			if (this.status.state === 'waiting-durable') {
				if (!this.#reconcileDurableCursor()) return;
				if (this.#offeredCursors.length - 1 >= this.#options.maxAcceptedBatchesAhead) return;
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			}
			const batch = this.#pendingBatch ?? this.#collectChunk();
			if (!this.#live(generation)) return;
			if (batch === CONTINUE) {
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
				this.wake();
				return;
			}
			if (!batch) {
				this.#finishIdlePass();
				return;
			}
			const result = this.#deliver(batch);
			if (result === undefined) return;
			if (result === DERIVED_INDEX_DEFERRED) {
				this.#pendingBatch = batch;
				this.status = { state: 'deferred', ownerEpoch: this.#ownerEpoch };
				this.#stalledSince ??= now;
				return;
			}
			this.#pendingBatch = undefined;
			this.#noteAccepted(batch);
			if (!this.#live(generation)) return;
			if (!this.#reconcileDurableCursor()) return;
			this.#publishLag();
			if (!lastOpen(this.#carried) && this.#offeredCursors.length - 1 >= this.#options.maxAcceptedBatchesAhead) {
				this.status = { state: 'waiting-durable', ownerEpoch: this.#ownerEpoch };
				this.#stalledSince ??= now;
				return;
			}
			this.#stalledSince = undefined;
			this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
			this.wake();
		} catch (error) {
			this.#fail('runner drain failed', error);
		}
	}

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
		} else this.#armFlushTimer();
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
		const generation = this.#generation;
		try {
			const result = flush.call(this.#registration.backend, reason) as void | Promise<void>;
			if (result && typeof result.then === 'function') {
				if (this.#registration.backend.asynchronous !== true) {
					this.#noteUndeclaredAsync(result);
					this.#fail(
						'backend declared no asynchronous effects but returned a promise from flush',
						new Error('undeclared asynchronous flush')
					);
					return;
				}
				result.then(undefined, (error: unknown) => {
					if (this.#live(generation)) this.#fail('backend flush request rejected', error);
				});
			}
		} catch (error) {
			this.#fail('backend flush request threw', error);
			return;
		}
		// A backend may coalesce this into a barrier already running; keep asking while work is not durable.
		if (this.#hasNonDurableWork()) this.#armFlushTimer();
	}

	#hasNonDurableWork(): boolean {
		return this.#offeredCursors.length > 1 || this.#unanchoredMutations > 0 || this.#boundaryPending;
	}

	#armFlushTimer() {
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			if (!this.#owned) return;
			this.#publishLag();
			this.#requestFlush('age');
		}, this.#options.maxFlushAgeMilliseconds);
		this.#flushTimer.unref?.();
	}

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
		let entries = 0;
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
			entries++;
			const projection = projections.get(entry.tableId);
			if (projection) {
				if (entry.type === 'reload') {
					// Markers up to a rebuild's capture point are covered by its scan; see #captureBoundary.
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
				this.#latestSeen.set(current.logName, current.timestamp);
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
			} else if ((entries & 15) === 0 && options.now() - started >= options.maxMillisecondsPerTurn) break;
		}
		return collected;
	}

	#resolveCollected(chunk: Chunk, collected: CollectedTransaction[]): DerivedIndexBatch | typeof CONTINUE {
		const options = this.#options;
		const through = cloneCursor(this.#offered!);
		let completed = 0;
		let visited = 0;
		for (let i = 0; i < collected.length; i++) {
			const transaction = collected[i];
			const mutations: DerivedIndexMutation[] = [];
			let remaining: CollectedTransaction | undefined;
			for (const [tableId, byRecord] of transaction.keys) {
				for (const [key, collectedKey] of byRecord) {
					if (
						!remaining &&
						chunk.batch.records.length > 0 &&
						(chunk.batch.bytes >= options.maxChunkBytes ||
							((++visited & 15) === 0 && options.now() - chunk.started >= options.maxMillisecondsPerTurn))
					) {
						remaining = { ...transaction, keys: new Map(), keyCount: 0 };
					}
					if (remaining) {
						let rest = remaining.keys.get(tableId);
						if (!rest) remaining.keys.set(tableId, (rest = new Map()));
						rest.set(key, collectedKey);
						remaining.keyCount++;
						continue;
					}
					const record = this.#addMutation(chunk, tableId, key, collectedKey);
					mutations.push({
						tableId,
						recordId: collectedKey.recordId,
						logVersion: collectedKey.logVersion,
						state: record.state,
					});
				}
			}
			if (remaining) {
				if (mutations.length)
					chunk.batch.transactions.push({
						logName: transaction.logName,
						timestamp: transaction.timestamp,
						mutations,
						partial: true,
					});
				this.#carried = [remaining, ...collected.slice(i + 1)];
				break;
			}
			if (transaction.complete) {
				through.logs[transaction.logName] = transaction.timestamp;
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
		this.#noteChunkProjection(chunk);
		if (completed === 0 && chunk.batch.records.length === 0) return CONTINUE;
		chunk.batch.through = through;
		return chunk.batch;
	}

	#newChunk(rebuild: boolean): Chunk {
		const batch = { ownerEpoch: this.#ownerEpoch!, transactions: [] } as unknown as DerivedIndexBatch;
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

	/** Undeclared asynchronous work may still write: the epoch's quiescence waits for it before any unlock or reset. */
	#noteUndeclaredAsync(pending: Promise<void>) {
		this.#undeclaredAsync = Promise.allSettled([this.#undeclaredAsync, pending]).then(() => undefined);
	}

	/** A chunk the projection rejected outright is worth one warning per streak, never an outage. */
	#noteChunkProjection(chunk: Chunk) {
		const records = chunk.batch.records;
		if (records.length === 0) return;
		if (records.some((record) => record.state.kind !== 'unindexable')) {
			this.#allUnindexableWarned = false;
			return;
		}
		if (this.#allUnindexableWarned) return;
		this.#allUnindexableWarned = true;
		logger.warn?.(
			`Derived index '${this.#registration.backend.id}' could not project any of the ${records.length} records in a chunk; they are counted in unindexableRecords`
		);
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
			// Validation messages can quote record values, which must not reach the backend or the log.
			const reason = `${error instanceof Error && error.name ? error.name : 'Error'} (${statusCode})`;
			if (this.#unindexableRecords++ === 0)
				logger.warn?.(`Derived index '${this.#registration.backend.id}' skipped a record it cannot project: ${reason}`);
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
		this.#stalledSince = undefined;
		this.#unreadSince = undefined;
		this.#reachedEndOfLog = true;
		if (this.#rebuilding || !this.#offered) return;
		const durable = this.#registration.backend.getDurableCursor();
		if (durable === undefined && this.#boundaryPending) {
			this.#armFlushTimer();
			return;
		}
		if (!isValidCursor(durable)) {
			this.#needsRebuild('backend lost its durable cursor');
			return;
		}
		if (!this.#reconcileDurableCursor(durable)) return;
		if (sameCursor(durable, this.#offered!)) this.#lastCaughtUpAt = this.#options.now();
		this.#publishLag();
		if (!sameCursor(durable, this.#offered!)) {
			this.#armFlushTimer();
			return;
		}
		this.#settleReady();
		if (this.#idleTimer) return;
		this.status = { state: 'idle', ownerEpoch: this.#ownerEpoch };
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (this.#stopped) return;
			try {
				if (sameCursor(this.#registration.backend.getDurableCursor(), this.#offered!)) this.#release();
			} catch (error) {
				this.#fail('backend cursor read threw at idle release', error);
			}
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
		if (offeredIndex > 0) {
			this.#offeredCursors.splice(0, offeredIndex);
			if (!this.#rebuilding && this.status.state !== 'needs-rebuild') this.#settleReady();
		}
		if (offeredIndex > 0 || sameCursor(cursor, this.#offered)) this.#lastCaughtUpAt = this.#options.now();
		return true;
	}

	#settleReady() {
		this.#rebuildAttempts = 0;
		if (this.#condemned) this.#clearCondemnation();
		if (Atomics.load(this.#shared().words, READINESS_STATE) !== READINESS_STATES.indexOf('ready'))
			this.#publishReadiness('ready');
	}

	/**
	 * Shared readiness is process memory, so a condemnation is also written to the root store under
	 * the index's marker key; a restart before the rebuild's `reset` has durably invalidated the
	 * cursor then still rebuilds instead of trusting it. Durability follows the root store's WAL
	 * setting. The marker clears only at the first durable `ready` after the rebuild, so a crash
	 * before that costs one extra rebuild, never a trusted condemned cursor. A log store without a
	 * root-store key-value surface (test fakes) keeps Stage 1's process-memory condemnation only.
	 */
	#writeCondemnation(): boolean {
		if (this.#condemned || !this.#markersSupported) return true;
		try {
			this.#logStore.putSync(this.#markerKey, CONDEMNED_MARKER, {});
			this.#condemned = true;
			return true;
		} catch (error) {
			// Without the marker a crash mid-reset would reopen on the condemned cursor, so no reset runs.
			logger.error(`Derived index '${this.id}' could not persist its condemnation`, error);
			return false;
		}
	}

	#readCondemnation(): boolean {
		if (!this.#markersSupported) return false;
		try {
			this.#condemned = this.#logStore.rootStore.getSync(this.#markerKey) !== undefined;
			return this.#condemned;
		} catch (error) {
			logger.error(`Derived index '${this.id}' could not read its condemnation marker`, error);
			return true;
		}
	}

	/** No rebuild attempt is spent on a refused marker; the next acquirer retries it before any reset. */
	#deferForCondemnation(shared: string) {
		logger.error(`Derived index '${this.id}' condemnation could not be persisted; retrying at the next wake`);
		const reason = this.status.state === 'needs-rebuild' ? this.status.reason : shared;
		this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('needs-rebuild', shared);
		this.#rebuildRequested = true;
		this.#release();
	}

	#clearCondemnation() {
		if (!this.#markersSupported) {
			this.#condemned = false;
			return;
		}
		try {
			this.#logStore.rootStore.removeSync(this.#markerKey);
			this.#condemned = false;
		} catch (error) {
			logger.error(`Derived index '${this.id}' could not clear its condemnation marker`, error);
		}
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

	/** `reason` is shareable; the error's message stays in the local status and log, since backend messages can quote record content. */
	#fail(reason: string, error: unknown) {
		const detail = error instanceof Error && error.message ? `${reason}: ${error.message}` : reason;
		this.#needsRebuild(detail, error, reason);
	}

	#needsRebuild(reason: string, error?: unknown, shared = reason) {
		if (this.#rebuilding) {
			this.#rebuildFailed(reason, error, shared);
			return;
		}
		if (this.status.state !== 'needs-rebuild')
			logger.error(`Derived index '${this.#registration.backend.id}' needs rebuild: ${reason}`, error);
		this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
		this.#discardProgress();
		if (!this.#owned) return;
		if (!this.#writeCondemnation()) {
			this.#deferForCondemnation(shared);
			return;
		}
		if (this.#canRebuild()) {
			// A failure after a rebuild but before `ready` is that rebuild failing late; it counts against the cap.
			if (this.#rebuildAttempts >= this.#options.maxRebuildAttempts) {
				this.#becomeUnavailable(reason, error, shared);
				return;
			}
			this.#publishReadiness('needs-rebuild', shared);
			this.#rebuildRequested = true;
			this.#scheduleRebuild();
			return;
		}
		this.#publishReadiness('needs-rebuild', shared);
		this.#release();
	}

	#becomeUnavailable(reason: string, error?: unknown, shared = reason) {
		logger.error(
			`Derived index '${this.#registration.backend.id}' is unavailable after ${this.#rebuildAttempts} rebuild attempts: ${reason}`,
			error
		);
		this.status = { state: 'unavailable', reason, ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('unavailable', shared);
		this.#admitWrites();
		this.#release();
	}

	/** An index no owner will catch up must not keep shedding writes. */
	#admitWrites() {
		if (this.#lagBudget > 0) Atomics.store(this.#shared().words, READINESS_LAG_EXCEEDED, 0);
	}

	#discardProgress() {
		this.#generation++;
		this.#stalledSince = undefined;
		this.#lastCaughtUpAt = undefined;
		this.#unreadSince = this.#options.now();
		this.#reachedEndOfLog = false;
		this.#offered = undefined;
		this.#pendingBatch = undefined;
		this.#carried = [];
		try {
			this.#iterator?.return?.();
		} catch (error) {
			logger.warn?.(`Derived index '${this.#registration.backend.id}' log iterator close threw`, error);
		}
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
		this.#takeSharedRebuildRequest();
		this.#rebuilding = true;
		if (this.#lagTimer) {
			clearTimeout(this.#lagTimer);
			this.#lagTimer = undefined;
		}
		this.#rebuildWakePending = false;
		if (this.#idleTimer) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		this.#discardProgress();
		if (!this.#writeCondemnation()) {
			this.#rebuilding = false;
			this.#deferForCondemnation(this.status.state === 'needs-rebuild' ? this.status.reason : 'rebuild requested');
			return;
		}
		if (this.#rebuildAttempts >= this.#options.maxRebuildAttempts) {
			this.#rebuilding = false;
			this.#becomeUnavailable('rebuild budget exhausted by a previous owner');
			return;
		}
		const generation = this.#generation;
		this.status = { state: 'rebuilding', ownerEpoch: this.#ownerEpoch };
		this.#rebuildAttempts++;
		this.#publishReadiness('rebuilding');
		this.#runRebuild(generation).then(
			() => {
				if (!this.#live(generation)) return;
				this.#rebuilding = false;
				this.#rebuildRequested = false;
				this.#takeSharedRebuildRequest();
				this.status = { state: 'running', ownerEpoch: this.#ownerEpoch };
				this.#drain();
			},
			(error) => {
				if (!this.#live(generation)) return;
				this.#rebuildFailed(
					error instanceof Error && error.message ? error.message : String(error),
					error,
					'rebuild attempt failed'
				);
			}
		);
	}

	#live(generation: number): boolean {
		return this.#owned && !this.#stopped && this.#generation === generation;
	}

	async #runRebuild(generation: number) {
		const backend = this.#registration.backend;
		await this.#quiesce(this.#ownerEpoch!);
		if (!this.#live(generation)) return;
		this.#ownerEpoch = this.#mintEpoch();
		this.status = { state: 'rebuilding', ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('rebuilding');
		this.#resetting = Promise.resolve(backend.reset!(this.#ownerEpoch));
		try {
			await this.#resetting;
		} finally {
			this.#resetting = undefined;
		}
		if (!this.#live(generation)) return;
		if (backend.getDurableCursor() !== undefined) throw new Error('backend kept a durable cursor after reset');
		const boundary = this.#captureBoundary();
		const options = this.#options;
		let chunk = this.#newChunk(true);
		let indexed = 0;
		for (const [tableId] of this.#registration.projections) {
			for (const record of this.#scanRecords!(tableId)) {
				if (this.#addScanRecord(chunk, tableId, record)) indexed++;
				// Filtered entries (tombstones, symbol keys) count against the turn too: a long run of them
				// must yield without delivering an empty chunk.
				if (
					chunk.batch.records.length >= options.maxChunkRecords ||
					chunk.batch.bytes >= options.maxChunkBytes ||
					options.now() - chunk.started >= options.maxMillisecondsPerTurn
				) {
					if (chunk.batch.records.length > 0) {
						this.#noteChunkProjection(chunk);
						await this.#deliverRebuildChunk(chunk, generation);
					} else await new Promise<void>((resolve) => setImmediate(resolve));
					if (!this.#live(generation)) return;
					chunk = this.#newChunk(true);
				}
			}
		}
		this.#noteChunkProjection(chunk);
		chunk.batch.through = boundary;
		await this.#deliverRebuildChunk(chunk, generation);
		if (!this.#live(generation)) return;
		this.#rebuiltRecords = indexed;
		if (!this.#installCursor(boundary)) return;
		this.#boundaryPending = true;
		logger.info?.(`Rebuilt derived index '${backend.id}' from ${indexed} records; replaying the retained log`);
	}

	#addScanRecord(chunk: Chunk, tableId: number, record: DerivedIndexScanRecord): DerivedIndexMutation | undefined {
		if (record.value == null || typeof record.recordId === 'symbol') return;
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
		return mutation;
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
			this.#stalledSince ??= this.#options.now();
			await this.#waitForBackend();
		}
		this.#stalledSince = undefined;
		this.#noteAccepted(chunk.batch);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	#waitForBackend(): Promise<void> {
		if (this.#rebuildWakePending) {
			this.#rebuildWakePending = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => this.#rebuildWaiter?.(), Math.max(1, this.#options.maxFlushAgeMilliseconds));
			timer.unref?.();
			this.#rebuildWaiter = () => {
				clearTimeout(timer);
				this.#rebuildWaiter = undefined;
				resolve();
			};
		});
	}

	#captureBoundary(): DerivedIndexCursor {
		const boundary: DerivedIndexCursor = { format: 1, logs: {} };
		// Every reload marker committed before this capture is reflected by the scan that follows it, so
		// the replay from the oldest retained entry must not spend a rebuild on each of them again.
		// Compared against transaction timestamps, which are wall-clock milliseconds; the injectable
		// budget clock may be monotonic and must not be used here.
		const captured = Date.now();
		Atomics.store(this.#shared().reloads, 0, BigInt(Math.floor(captured)));
		for (const logName of this.#logStore.rootStore.listLogs()) {
			this.#reloadsHandledThrough.set(logName, Math.max(this.#reloadsHandledThrough.get(logName) ?? 0, captured));
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

	#rebuildFailed(reason: string, error?: unknown, shared = reason) {
		this.#rebuilding = false;
		this.#rebuildWaiter?.();
		this.#discardProgress();
		if (this.#rebuildAttempts >= this.#options.maxRebuildAttempts) {
			this.#becomeUnavailable(reason, error, shared);
			return;
		}
		logger.error(
			`Derived index '${this.#registration.backend.id}' rebuild attempt ${this.#rebuildAttempts} failed: ${reason}`,
			error
		);
		this.status = { state: 'needs-rebuild', reason, ownerEpoch: this.#ownerEpoch };
		this.#publishReadiness('needs-rebuild', shared);
		this.#rebuildRequested = true;
		if (this.#owned) this.#scheduleRebuild();
	}

	/** One `shutdown(epoch)` per epoch, shared by a rebuild attempt and a release that overlap. */
	#quiesce(epoch: bigint): Promise<void> {
		if (this.#quiescing?.epoch === epoch) return this.#quiescing.promise;
		let promise: Promise<void>;
		const shutdown = () => this.#registration.backend.shutdown?.(epoch);
		try {
			promise = this.#undeclaredAsync ? this.#undeclaredAsync.then(shutdown) : Promise.resolve(shutdown());
		} catch (error) {
			promise = Promise.reject(error);
		}
		const quiescing = { epoch, promise, since: this.#options.now() };
		this.#quiescing = quiescing;
		const settle = () => {
			if (this.#quiescing === quiescing) this.#quiescing = undefined;
		};
		promise.then(settle, settle);
		return promise;
	}

	#publishReadiness(state: DerivedIndexReadinessState, reason = '') {
		const { words, bytes, epoch } = this.#shared();
		// Force the sequence odd rather than incrementing, so a publication abandoned by a dead owner is repaired.
		const sequence = Atomics.load(words, READINESS_SEQUENCE) | 1;
		Atomics.store(words, READINESS_SEQUENCE, sequence);
		const encoded = textEncoder.encodeInto(reason, bytes);
		Atomics.store(words, READINESS_STATE, READINESS_STATES.indexOf(state));
		Atomics.store(words, READINESS_REASON_LENGTH, encoded.written);
		Atomics.store(words, READINESS_ATTEMPTS, state === 'ready' ? 0 : this.#rebuildAttempts);
		Atomics.store(epoch, 0, this.#ownerEpoch ?? 0n);
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
		if (this.#lagTimer) {
			clearTimeout(this.#lagTimer);
			this.#lagTimer = undefined;
		}
		this.#discardProgress();
		const backend = this.#registration.backend;
		const epoch = this.#ownerEpoch;
		this.#releasingSince = this.#options.now();
		const unlock = () => {
			this.#releasing = undefined;
			this.#releasingSince = undefined;
			try {
				this.#logStore.unlock(this.#lockKey);
			} catch (error) {
				logger.error(`Failed to release derived index runner '${backend.id}'`, error);
			}
		};
		const hold = (error: unknown) => {
			this.#releasing = undefined;
			this.#releasingSince = undefined;
			this.#heldLock = true;
			const shared = 'backend shutdown failed; runner lock held';
			const reason = `${shared}: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(`Derived index '${backend.id}' ${reason}`, error);
			this.#releaseFailure = new Error(reason, { cause: error });
			this.status = { state: 'unavailable', reason, ownerEpoch: epoch };
			this.#publishReadiness('unavailable', shared);
			this.#admitWrites();
		};
		let flushed: void | Promise<void>;
		try {
			flushed = backend.flush?.('shutdown') as void | Promise<void>;
			if (flushed && typeof flushed.then === 'function' && backend.asynchronous !== true) {
				this.#noteUndeclaredAsync(flushed);
				flushed = undefined;
				logger.error(
					`Derived index '${backend.id}' declared no asynchronous effects but returned a promise from flush`
				);
			}
		} catch (error) {
			logger.warn?.(`Derived index '${backend.id}' shutdown flush request threw`, error);
		}
		const settling = Promise.allSettled([this.#resetting, flushed]).then(() => undefined);
		this.#releasing = settling.then(() => (epoch === undefined ? undefined : this.#quiesce(epoch))).then(unlock, hold);
	}
}

function lastOpen(collected: CollectedTransaction[]): CollectedTransaction | undefined {
	const last = collected[collected.length - 1];
	return last && !last.complete ? last : undefined;
}

type SharedReadinessBuffer = ArrayBufferLike & { notify?: () => void; cancel?: () => void };

function readinessBuffer(
	logStore: RocksTransactionLogStore,
	backendId: string,
	callback?: () => void
): SharedReadinessBuffer {
	return logStore.getUserSharedBuffer(
		`derived-index:${backendId}:readiness`,
		new ArrayBuffer(READINESS_BYTES),
		callback ? { callback } : undefined
	) as SharedReadinessBuffer;
}

type SharedViews = {
	words: Int32Array;
	epoch: BigInt64Array;
	reloads: BigInt64Array;
	bytes: Uint8Array;
};

function sharedViewsOf(buffer: ArrayBufferLike): SharedViews {
	return {
		words: new Int32Array(buffer, 0, READINESS_WORDS),
		epoch: new BigInt64Array(buffer, READINESS_EPOCH_OFFSET, 1),
		reloads: new BigInt64Array(buffer, READINESS_RELOADS_OFFSET, 1),
		bytes: new Uint8Array(buffer, READINESS_REASON_OFFSET),
	};
}

const readinessViews = new WeakMap<object, Map<string, SharedViews>>();

function readReadiness(words: Int32Array, epoch: BigInt64Array, bytes: Uint8Array): DerivedIndexReadiness {
	for (let spin = 0; spin < 256; spin++) {
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
	let byBackend = readinessViews.get(logStore);
	if (!byBackend) readinessViews.set(logStore, (byBackend = new Map()));
	let views = byBackend.get(backendId);
	if (!views) byBackend.set(backendId, (views = sharedViewsOf(readinessBuffer(logStore, backendId))));
	return readReadiness(views.words, views.epoch, views.bytes);
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
