import { DERIVED_INDEX_ACCEPTED, DERIVED_INDEX_DEFERRED, DERIVED_INDEX_FAILED } from '../derivedIndexRuntime.ts';
import type {
	DerivedIndexBackend,
	DerivedIndexBackendHost,
	DerivedIndexBackendStateChange,
	DerivedIndexBatch,
	DerivedIndexCursor,
	DerivedIndexDeliveryResult,
	DerivedIndexFlushReason,
	DerivedIndexPositions,
} from '../derivedIndexRuntime.ts';
import { toBufferKey } from 'ordered-binary';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const logger = loggerWithTag('fulltext-derived-index');

const DEFAULT_MAX_QUEUED_BATCHES = 16;
export const HARPER_FULLTEXT_DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
export const HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_OPEN_ATTEMPTS = 3;
const DEFAULT_OPEN_RETRY_MILLISECONDS = 10;
const DEFAULT_MAX_OPEN_RETRY_MILLISECONDS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MILLISECONDS = 35_000;
const DEFAULT_MAX_APPLY_SLICE_RECORDS = 256;
const APPLY_SLICE_MILLISECONDS = 5;
const UNKNOWN_BATCH_BYTES_PER_RECORD = 1_024;
const MAX_CONSECUTIVE_WRITER_FAILURES = 2;

export interface FullTextDerivedIndexEngine {
	readonly committedPayload?: string;
	applyMutationBatch(
		batch: FullTextMutationBatch,
		options: { assumeDistinctIds: true; rejectedUpsert: 'delete' }
	): Promise<{
		/** Counts every logical mutation handled, including rejected upserts replaced by deletes. */
		processed: number;
		rejected: Array<{ operation: 'upsert'; index: number; code: 'E_INVALID_ARGUMENT' | 'E_BATCH_TOO_LARGE' }>;
		encodedBytes: number;
		frames: number;
	}>;
	/** Success proves the cursor payload and every preceding mutation are durably ordered together. */
	publish(payload: string): Promise<bigint>;
	close(options?: { mode?: 'require-clean' | 'rollback' }): Promise<{ cleanupError?: unknown }>;
}

export type FullTextDerivedIndexInspection =
	| { state: 'missing' | 'cursorless' }
	| { state: 'checkpointed'; committedPayload: string }
	| { state: 'incompatible'; code: string };

export interface FullTextDerivedIndexLifecycle {
	inspect(): FullTextDerivedIndexInspection;
	open(): Promise<FullTextDerivedIndexEngine>;
	reset(): Promise<void>;
}

export type FullTextMutationBatch = {
	upserts: Array<{ id: string; fields: Record<string, string | string[]> }>;
	deletes: string[];
};

export type FullTextDerivedIndexBackendOptions = {
	id: string;
	lifecycle: FullTextDerivedIndexLifecycle;
	maxQueuedBatches?: number;
	maxQueuedBytes?: number;
	maxCursorPayloadBytes?: number;
	maxApplySliceRecords?: number;
	openAttempts?: number;
	openRetryMilliseconds?: number;
	maxOpenRetryMilliseconds?: number;
	closeTimeoutMilliseconds?: number;
};

type ApplyCommand = {
	type: 'apply';
	epoch: bigint;
	sequence: number;
	batch: DerivedIndexBatch;
	bytes: number;
	position: number;
};

type BarrierCommand = {
	type: 'barrier';
	epoch: bigint;
	horizon: number;
	cursor?: DerivedIndexCursor;
};

type Command = ApplyCommand | BarrierCommand;

type ShutdownRequest = {
	epoch: bigint;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	closing: boolean;
};

export class FullTextDerivedIndexError extends Error {
	statusCode = 500;

	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'FullTextDerivedIndexError';
	}
}

class FullTextDerivedIndexProtocolError extends FullTextDerivedIndexError {}
class FullTextDerivedIndexConfigurationError extends FullTextDerivedIndexError {}

export class FullTextDerivedIndexBackend implements DerivedIndexBackend {
	readonly id: string;
	#lifecycle: FullTextDerivedIndexLifecycle;
	#maxQueuedBatches: number;
	#maxQueuedBytes: number;
	#maxCursorPayloadBytes: number;
	#maxApplySliceRecords: number;
	#openAttempts: number;
	#openRetryMilliseconds: number;
	#maxOpenRetryMilliseconds: number;
	#closeTimeoutMilliseconds: number;
	#host?: DerivedIndexBackendHost;
	#wake?: (change?: DerivedIndexBackendStateChange) => void;
	#engine?: FullTextDerivedIndexEngine;
	#durableCursor?: DerivedIndexCursor;
	#activeEpoch?: bigint;
	#commands: Command[] = [];
	#retainedBatches = 0;
	#retainedBytes = 0;
	#lastAcceptedSequence = 0;
	#lastAppliedSequence = 0;
	#lastPublishedSequence = 0;
	#lastBarrierHorizon = 0;
	#lastAcceptedCursor?: DerivedIndexCursor;
	#hasStagedMutations = false;
	#draining = false;
	#scheduled = false;
	#settlingWriter = false;
	#lossPendingEpoch?: bigint;
	#failed = false;
	#capacityDeferred = false;
	#shutdown?: ShutdownRequest;
	#unindexableWarned = false;
	#unindexableRecords = 0;
	#stagedUnindexableRecords = 0;
	#invalidEstimateWarned = false;
	#consecutiveWriterFailures = 0;
	#openRetryTimer?: NodeJS.Timeout;
	#openRetryDelayMilliseconds: number;
	#lockBusyWarned = false;
	#terminalFailure?: FullTextDerivedIndexConfigurationError;
	// A failed deliver() result and its delayed state callback report the same backend fault.
	#failedDeliveryObserved = false;

	constructor(options: FullTextDerivedIndexBackendOptions) {
		if (!options.id) throw new TypeError('Full-text derived index id is required');
		if (
			!options.lifecycle ||
			typeof options.lifecycle.inspect !== 'function' ||
			typeof options.lifecycle.open !== 'function' ||
			typeof options.lifecycle.reset !== 'function'
		)
			throw new TypeError('Full-text derived index lifecycle must implement inspect(), open(), and reset()');
		this.id = options.id;
		this.#lifecycle = options.lifecycle;
		this.#maxQueuedBatches = positiveInteger(
			options.maxQueuedBatches ?? DEFAULT_MAX_QUEUED_BATCHES,
			'maxQueuedBatches'
		);
		this.#maxQueuedBytes = positiveInteger(
			options.maxQueuedBytes ?? HARPER_FULLTEXT_DEFAULT_MAX_QUEUED_BYTES,
			'maxQueuedBytes'
		);
		this.#maxCursorPayloadBytes = positiveInteger(
			options.maxCursorPayloadBytes ?? HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES,
			'maxCursorPayloadBytes'
		);
		this.#maxApplySliceRecords = positiveInteger(
			options.maxApplySliceRecords ?? DEFAULT_MAX_APPLY_SLICE_RECORDS,
			'maxApplySliceRecords'
		);
		this.#openAttempts = positiveInteger(options.openAttempts ?? DEFAULT_OPEN_ATTEMPTS, 'openAttempts');
		this.#openRetryMilliseconds = nonNegativeInteger(
			options.openRetryMilliseconds ?? DEFAULT_OPEN_RETRY_MILLISECONDS,
			'openRetryMilliseconds'
		);
		this.#maxOpenRetryMilliseconds = Math.max(
			Math.max(1, this.#openRetryMilliseconds),
			positiveInteger(
				options.maxOpenRetryMilliseconds ?? DEFAULT_MAX_OPEN_RETRY_MILLISECONDS,
				'maxOpenRetryMilliseconds'
			)
		);
		this.#closeTimeoutMilliseconds = positiveInteger(
			options.closeTimeoutMilliseconds ?? DEFAULT_CLOSE_TIMEOUT_MILLISECONDS,
			'closeTimeoutMilliseconds'
		);
		this.#openRetryDelayMilliseconds = Math.max(1, this.#openRetryMilliseconds);
		this.#durableCursor = this.#inspectDurableCursor();
	}

	attach(host: DerivedIndexBackendHost): void {
		if (this.#host && this.#host !== host && (this.#engine || this.#draining || this.#wake))
			throw new Error('Full-text derived index backend is already attached');
		this.#host = host;
	}

	getDurableCursor(): DerivedIndexCursor | undefined {
		this.#assertAttached();
		return this.#durableCursor;
	}

	#inspectDurableCursor(): DerivedIndexCursor | undefined {
		let inspection: FullTextDerivedIndexInspection;
		try {
			inspection = this.#lifecycle.inspect();
		} catch (error) {
			throw new FullTextDerivedIndexError('Full-text derived index state could not be inspected', error);
		}
		if (inspection.state !== 'checkpointed') {
			if (inspection.state === 'incompatible')
				logWarning(`Full-text derived index '${this.id}' is incompatible (${inspection.code}); rebuilding`);
			return;
		}
		try {
			return decodeFullTextCursorPayload(inspection.committedPayload, this.#maxCursorPayloadBytes);
		} catch {
			logWarning(`Full-text derived index '${this.id}' has an invalid committed cursor; rebuilding`);
		}
	}

	getUnindexableRecords(): number {
		return this.#unindexableRecords;
	}

	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult {
		if (this.#failed) {
			if (this.#host?.isOwnerEpoch(batch.ownerEpoch)) this.#failedDeliveryObserved = true;
			return DERIVED_INDEX_FAILED;
		}
		if (!this.#host?.isOwnerEpoch(batch.ownerEpoch)) return DERIVED_INDEX_FAILED;
		if (this.#settlingWriter || this.#lossPendingEpoch === batch.ownerEpoch) return DERIVED_INDEX_DEFERRED;
		if (this.#shutdown) {
			if (this.#shutdown.epoch === batch.ownerEpoch || this.#activeEpoch !== undefined) return DERIVED_INDEX_FAILED;
			this.#shutdown = undefined;
		}
		if (this.#activeEpoch === undefined) this.#activeEpoch = batch.ownerEpoch;
		if (this.#activeEpoch !== batch.ownerEpoch) return DERIVED_INDEX_FAILED;
		let through: DerivedIndexCursor | undefined;
		try {
			through = batch.through && normalizedCursor(batch.through);
		} catch (error) {
			this.#markFailed(error);
			return DERIVED_INDEX_FAILED;
		}
		let bytes = batch.bytes;
		if (bytes === 0)
			bytes =
				batch.records.length === 0
					? 1
					: Math.min(this.#maxQueuedBytes, Math.max(1, batch.records.length * UNKNOWN_BATCH_BYTES_PER_RECORD));
		else if (!Number.isSafeInteger(bytes) || bytes < 0) {
			bytes = this.#maxQueuedBytes;
			if (!this.#invalidEstimateWarned) {
				this.#invalidEstimateWarned = true;
				logWarning(`Full-text derived index '${this.id}' received an invalid batch byte estimate`, undefined);
			}
		}
		if (
			this.#retainedBatches >= this.#maxQueuedBatches ||
			(this.#retainedBatches > 0 && this.#retainedBytes + bytes > this.#maxQueuedBytes)
		) {
			this.#capacityDeferred = true;
			return DERIVED_INDEX_DEFERRED;
		}
		const sequence = ++this.#lastAcceptedSequence;
		if (through) this.#lastAcceptedCursor = through;
		this.#commands.push({ type: 'apply', epoch: batch.ownerEpoch, sequence, batch, bytes, position: 0 });
		this.#retainedBatches++;
		this.#retainedBytes += bytes;
		this.#scheduleDrain();
		return DERIVED_INDEX_ACCEPTED;
	}

	flush(_reason: DerivedIndexFlushReason = 'threshold'): void {
		if (this.#activeEpoch === undefined || this.#failed || this.#shutdown) return;
		this.#queueBarrier(this.#activeEpoch);
	}

	shutdown(ownerEpoch: bigint): Promise<void> {
		if (this.#shutdown?.epoch === ownerEpoch) return this.#shutdown.promise;
		if (this.#activeEpoch !== ownerEpoch) return Promise.resolve();
		this.#queueBarrier(ownerEpoch);
		let resolve: () => void;
		let reject: (error: unknown) => void;
		const promise = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		this.#shutdown = { epoch: ownerEpoch, promise, resolve: resolve!, reject: reject!, closing: false };
		this.#scheduleDrain();
		return promise;
	}

	async reset(ownerEpoch: bigint): Promise<void> {
		this.#assertAttached();
		if (
			this.#engine ||
			this.#scheduled ||
			this.#draining ||
			this.#settlingWriter ||
			this.#openRetryTimer ||
			this.#commands.length > 0 ||
			this.#shutdown?.closing
		)
			throw new FullTextDerivedIndexError('Full-text derived index backend is not quiescent at reset');
		this.#assertSharedEpoch(ownerEpoch);
		if (this.#terminalFailure)
			throw new FullTextDerivedIndexError(
				'Full-text derived index configuration must change before rebuild can succeed',
				this.#terminalFailure
			);
		this.#shutdown = undefined;
		this.#failed = false;
		await this.#lifecycle.reset();
		this.#durableCursor = undefined;
		this.#assertSharedEpoch(ownerEpoch);
		this.#activeEpoch = ownerEpoch;
		this.#resetQueueState();
		this.#terminalFailure = undefined;
		this.#unindexableRecords = 0;
		this.#unindexableWarned = false;
	}

	onStateChange(wake: (change?: DerivedIndexBackendStateChange) => void): () => void {
		if (this.#wake && this.#wake !== wake)
			throw new Error('Full-text derived index backend already has a state listener');
		this.#wake = wake;
		return () => {
			if (this.#wake === wake) this.#wake = undefined;
		};
	}

	#queueBarrier(epoch: bigint): void {
		if (this.#lossPendingEpoch === epoch) return;
		const horizon = this.#lastAcceptedSequence;
		if (horizon === 0 || horizon <= this.#lastBarrierHorizon) return;
		this.#lastBarrierHorizon = horizon;
		this.#commands.push({
			type: 'barrier',
			epoch,
			horizon,
			cursor: cloneCursor(this.#lastAcceptedCursor ?? this.#durableCursor),
		});
		this.#scheduleDrain();
	}

	#scheduleDrain(): void {
		if (this.#scheduled || this.#draining || (this.#openRetryTimer && !this.#shutdown)) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (this.#commands.length > 0 && !this.#failed) {
				const next = this.#commands[0];
				if ((next.type === 'barrier' || next.batch.records.length > 0) && !(await this.#ensureEngine())) return;
				if (this.#commands[0] !== next) continue;
				if (next.type === 'apply') {
					let complete = false;
					try {
						complete = await this.#apply(next);
					} finally {
						if (complete) {
							this.#commands.shift();
							this.#retainedBatches = Math.max(0, this.#retainedBatches - 1);
							this.#retainedBytes = Math.max(0, this.#retainedBytes - next.bytes);
							if (this.#capacityDeferred && !this.#failed) this.#notify('changed');
						}
					}
					if (!complete) break;
				} else {
					this.#commands.shift();
					if (!(await this.#publish(next))) break;
				}
			}
		} catch (error) {
			this.#failAndNotify(error);
		} finally {
			this.#draining = false;
			if (this.#shutdown && !this.#shutdown.closing) void this.#closeForShutdown(this.#shutdown);
			else if (!this.#failed && !this.#openRetryTimer && this.#commands.length > 0) this.#scheduleDrain();
		}
	}

	async #ensureEngine(): Promise<boolean> {
		if (this.#engine) return true;
		const epoch = this.#activeEpoch;
		if (epoch === undefined) throw new FullTextDerivedIndexError('Full-text owner epoch is unavailable');
		const engine = await this.#open(epoch);
		if (!engine) return false;
		let actual: DerivedIndexCursor | undefined;
		try {
			this.#assertCommandEpoch(epoch);
			actual = decodeFullTextCursorPayload(engine.committedPayload, this.#maxCursorPayloadBytes);
		} catch (error) {
			await this.#closeUninstalledEngine(engine, error);
			throw error;
		}
		if (!sameCursor(actual, this.#durableCursor)) {
			this.#lossPendingEpoch = epoch;
			await this.#closeUninstalledEngine(
				engine,
				new FullTextDerivedIndexError('Full-text cursor changed between inspection and writer open')
			);
			this.#durableCursor = actual;
			this.#consecutiveWriterFailures = 0;
			this.#discardCommands();
			this.#rewindAcceptedWork();
			this.#notify('accepted-work-lost');
			return false;
		}
		this.#engine = engine;
		return true;
	}

	async #closeUninstalledEngine(engine: FullTextDerivedIndexEngine, cause: unknown): Promise<void> {
		this.#settlingWriter = true;
		try {
			await this.#closeEngine(engine, { mode: 'rollback' });
		} catch (closeError) {
			this.#engine = engine;
			throw new FullTextDerivedIndexError(
				'Full-text writer could not close after lazy open failed',
				new AggregateError([cause, closeError])
			);
		} finally {
			this.#settlingWriter = false;
		}
	}

	async #apply(command: ApplyCommand): Promise<boolean> {
		this.#assertCommandEpoch(command.epoch);
		if (command.batch.records.length === 0) {
			this.#lastAppliedSequence = command.sequence;
			return true;
		}
		const slice = toFullTextMutationSlice(
			command.batch.records,
			command.position,
			this.#maxApplySliceRecords,
			performance.now() + APPLY_SLICE_MILLISECONDS
		);
		const { batch: logical, end } = slice;
		const mutationCount = logical.upserts.length + logical.deletes.length;
		if (mutationCount > 0) {
			this.#hasStagedMutations = true;
			try {
				const result = await this.#engine!.applyMutationBatch(logical, {
					// A resolved derived-index chunk contains at most one mutation per source record key.
					assumeDistinctIds: true,
					rejectedUpsert: 'delete',
				});
				this.#recordApplyResult(result, mutationCount);
			} catch (error) {
				const permanentFailure = error instanceof FullTextDerivedIndexProtocolError;
				await this.#loseAcceptedWork(command.epoch, error, !permanentFailure);
				if (permanentFailure) this.#failAndNotify(error);
				return false;
			}
		}
		this.#assertCommandEpoch(command.epoch);
		command.position = end;
		if (command.position < command.batch.records.length) return false;
		this.#lastAppliedSequence = command.sequence;
		return true;
	}

	#recordApplyResult(
		result: Awaited<ReturnType<FullTextDerivedIndexEngine['applyMutationBatch']>>,
		mutationCount: number
	): void {
		if (
			!result ||
			typeof result !== 'object' ||
			!Number.isSafeInteger(result.processed) ||
			result.processed !== mutationCount ||
			!Array.isArray(result.rejected)
		)
			throw new FullTextDerivedIndexProtocolError('Full-text engine returned an invalid mutation result');
		const rejected = result.rejected.length;
		if (rejected > 0 && !this.#unindexableWarned) {
			this.#unindexableWarned = true;
			logWarning(
				`Full-text derived index '${this.id}' removed ${rejected} records rejected by native record or frame limits`,
				undefined
			);
		}
		this.#stagedUnindexableRecords += rejected;
	}

	async #publish(command: BarrierCommand): Promise<boolean> {
		if (command.horizon <= this.#lastPublishedSequence) return true;
		this.#assertCommandEpoch(command.epoch);
		if (this.#lastAppliedSequence < command.horizon)
			throw new FullTextDerivedIndexError('Full-text publication barrier passed unapplied work');
		const cursor = withDurableCoverage(command.cursor ?? this.#durableCursor, this.#durableCursor);
		try {
			const payload = encodeFullTextCursorPayload(cursor, this.#maxCursorPayloadBytes);
			await this.#engine!.publish(payload);
		} catch (error) {
			const terminal = error instanceof FullTextDerivedIndexConfigurationError;
			await this.#loseAcceptedWork(command.epoch, error, !terminal);
			if (terminal) {
				this.#terminalFailure = error;
				this.#failAndNotify(error);
			}
			return false;
		}
		this.#assertCommandEpoch(command.epoch);
		this.#lastPublishedSequence = command.horizon;
		this.#hasStagedMutations = false;
		this.#unindexableRecords += this.#stagedUnindexableRecords;
		this.#stagedUnindexableRecords = 0;
		this.#durableCursor = cloneCursor(cursor);
		this.#unindexableWarned = false;
		this.#consecutiveWriterFailures = 0;
		if (!this.#shutdown) this.#notify('changed');
		return true;
	}

	async #loseAcceptedWork(ownerEpoch: bigint, cause: unknown, notify = true): Promise<void> {
		this.#lossPendingEpoch = ownerEpoch;
		this.#discardCommands();
		const engine = this.#engine;
		this.#engine = undefined;
		if (!engine) throw new FullTextDerivedIndexError('Full-text writer is unavailable', cause);
		try {
			await this.#closeEngine(engine, { mode: 'rollback' });
		} catch (error) {
			this.#engine = engine;
			throw new FullTextDerivedIndexError(
				'Full-text writer could not prove quiescence after losing accepted work',
				new AggregateError([cause, error])
			);
		}
		this.#rewindAcceptedWork();
		this.#assertCommandEpoch(ownerEpoch);
		this.#hasStagedMutations = false;
		this.#stagedUnindexableRecords = 0;
		if (!notify) {
			this.#lossPendingEpoch = undefined;
			return;
		}
		this.#consecutiveWriterFailures++;
		if (this.#consecutiveWriterFailures >= MAX_CONSECUTIVE_WRITER_FAILURES) {
			this.#lossPendingEpoch = undefined;
			this.#failAndNotify(new FullTextDerivedIndexError('Full-text writer failed repeatedly', cause));
			return;
		}
		this.#notify('accepted-work-lost');
	}

	async #closeForShutdown(request: ShutdownRequest): Promise<void> {
		if (request !== this.#shutdown || request.closing) return;
		request.closing = true;
		const engine = this.#engine;
		try {
			this.#clearOpenRetry();
			if (engine) {
				const mode =
					this.#hasStagedMutations || this.#lastAppliedSequence > this.#lastPublishedSequence
						? 'rollback'
						: 'require-clean';
				await this.#closeEngine(engine, { mode });
			}
			this.#engine = undefined;
			this.#activeEpoch = undefined;
			this.#resetQueueState();
			if (this.#shutdown === request) this.#shutdown = undefined;
			request.resolve();
		} catch (error) {
			if (this.#shutdown === request) this.#shutdown = undefined;
			const failure = new FullTextDerivedIndexError('Full-text writer shutdown did not prove quiescence', error);
			this.#markFailed(failure);
			request.reject(failure);
		}
	}

	async #closeEngine(
		engine: FullTextDerivedIndexEngine,
		options: { mode: 'require-clean' | 'rollback' }
	): Promise<void> {
		const result = await withTimeout(
			engine.close(options),
			this.#closeTimeoutMilliseconds,
			() => new FullTextDerivedIndexError('Full-text native writer close timed out')
		);
		if (result.cleanupError)
			logWarning(`Full-text derived index '${this.id}' closed with a native cleanup error`, result.cleanupError);
	}

	async #open(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine | undefined> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.#openAttempts; attempt++) {
			this.#assertSharedEpoch(ownerEpoch);
			try {
				const engine = await this.#lifecycle.open();
				this.#resetOpenRetryBackoff();
				return engine;
			} catch (error) {
				lastError = error;
				if (nativeErrorCode(error) === 'E_LOCK_BUSY') {
					this.#scheduleOpenRetry(ownerEpoch);
					return;
				}
				if (attempt < this.#openAttempts && this.#openRetryMilliseconds > 0) {
					await delay(this.#openRetryMilliseconds);
					continue;
				}
			}
		}
		throw new FullTextDerivedIndexError('Full-text writer could not be opened', lastError);
	}

	#scheduleOpenRetry(ownerEpoch: bigint): void {
		if (this.#openRetryTimer || this.#shutdown || this.#failed) return;
		const retryDelay = this.#openRetryDelayMilliseconds;
		this.#openRetryDelayMilliseconds = Math.min(this.#maxOpenRetryMilliseconds, retryDelay * 2);
		if (retryDelay >= this.#maxOpenRetryMilliseconds && !this.#lockBusyWarned) {
			this.#lockBusyWarned = true;
			logWarning(`Full-text derived index '${this.id}' is waiting for its native writer lock`);
		}
		this.#openRetryTimer = setTimeout(() => {
			this.#openRetryTimer = undefined;
			if (this.#activeEpoch === ownerEpoch && this.#host?.isOwnerEpoch(ownerEpoch)) this.#scheduleDrain();
		}, retryDelay);
		this.#openRetryTimer.unref?.();
	}

	#clearOpenRetry(): void {
		if (!this.#openRetryTimer) return;
		clearTimeout(this.#openRetryTimer);
		this.#openRetryTimer = undefined;
	}

	#resetOpenRetryBackoff(): void {
		this.#clearOpenRetry();
		this.#openRetryDelayMilliseconds = Math.max(1, this.#openRetryMilliseconds);
		this.#lockBusyWarned = false;
	}

	#discardCommands(): void {
		this.#commands = [];
		this.#retainedBatches = 0;
		this.#retainedBytes = 0;
		this.#lastBarrierHorizon = this.#lastPublishedSequence;
		this.#capacityDeferred = false;
	}

	#rewindAcceptedWork(): void {
		this.#lastAcceptedSequence = this.#lastPublishedSequence;
		this.#lastAppliedSequence = this.#lastPublishedSequence;
		this.#lastBarrierHorizon = this.#lastPublishedSequence;
		this.#lastAcceptedCursor = cloneCursor(this.#durableCursor);
		this.#hasStagedMutations = false;
		this.#stagedUnindexableRecords = 0;
	}

	#resetQueueState(): void {
		this.#resetOpenRetryBackoff();
		this.#commands = [];
		this.#retainedBatches = 0;
		this.#retainedBytes = 0;
		this.#lastAcceptedSequence = 0;
		this.#lastAppliedSequence = 0;
		this.#lastPublishedSequence = 0;
		this.#lastBarrierHorizon = 0;
		this.#lastAcceptedCursor = undefined;
		this.#hasStagedMutations = false;
		this.#stagedUnindexableRecords = 0;
		this.#capacityDeferred = false;
		this.#lossPendingEpoch = undefined;
		this.#invalidEstimateWarned = false;
		this.#consecutiveWriterFailures = 0;
		this.#failedDeliveryObserved = false;
	}

	#markFailed(error: unknown): boolean {
		if (this.#failed) return false;
		this.#failed = true;
		this.#clearOpenRetry();
		this.#failedDeliveryObserved = false;
		this.#discardCommands();
		logError('Full-text derived index backend failed', error);
		return true;
	}

	#failAndNotify(error: unknown): void {
		if (this.#markFailed(error)) this.#notify('failed');
	}

	#assertAttached(): void {
		if (!this.#host) throw new Error('Full-text derived index backend must be attached before use');
	}

	#assertSharedEpoch(ownerEpoch: bigint): void {
		if (!this.#host?.isOwnerEpoch(ownerEpoch)) throw new FullTextDerivedIndexError('Full-text owner epoch was revoked');
	}

	#assertCommandEpoch(ownerEpoch: bigint): void {
		if (this.#activeEpoch !== ownerEpoch || !this.#host?.isOwnerEpoch(ownerEpoch))
			throw new FullTextDerivedIndexError('Full-text owner epoch was revoked');
	}

	#notify(change: DerivedIndexBackendStateChange): void {
		if (change === 'changed') this.#capacityDeferred = false;
		const wake = this.#wake;
		const activeEpoch = this.#activeEpoch;
		if (!wake) {
			if (change === 'accepted-work-lost' && this.#lossPendingEpoch === activeEpoch) this.#lossPendingEpoch = undefined;
			return;
		}
		setImmediate(() => {
			if (change === 'failed' && this.#failedDeliveryObserved) return;
			if (this.#activeEpoch !== activeEpoch || this.#wake !== wake) {
				if (change === 'accepted-work-lost' && this.#lossPendingEpoch === activeEpoch)
					this.#lossPendingEpoch = undefined;
				return;
			}
			try {
				wake(change);
			} catch (error) {
				logError('Full-text derived index state notification failed', error);
			} finally {
				if (change === 'accepted-work-lost' && this.#lossPendingEpoch === activeEpoch)
					this.#lossPendingEpoch = undefined;
			}
		});
	}
}

export function toFullTextMutationBatch(batch: DerivedIndexBatch): FullTextMutationBatch {
	return toFullTextMutationRecords(batch.records);
}

function toFullTextMutationRecords(
	records: DerivedIndexBatch['records'],
	start = 0,
	end = records.length
): FullTextMutationBatch {
	return toFullTextMutationSlice(records, start, end - start, Number.POSITIVE_INFINITY).batch;
}

function toFullTextMutationSlice(
	records: DerivedIndexBatch['records'],
	start: number,
	maxRecords: number,
	deadline: number
): { batch: FullTextMutationBatch; end: number } {
	const upserts: FullTextMutationBatch['upserts'] = [];
	const deletes: string[] = [];
	const limit = Math.min(start + maxRecords, records.length);
	let index = start;
	for (; index < limit; index++) {
		const record = records[index];
		if (typeof record.recordId === 'symbol') continue;
		const id = `${record.tableId}.${toBufferKey(record.recordId).toString('base64url')}`;
		if (record.state.kind === 'record' && record.state.projection != null)
			upserts.push({ id, fields: fullTextFields(record.state.projection) });
		else deletes.push(id);
		if ((index - start + 1) % 16 === 0 && performance.now() >= deadline) {
			index++;
			break;
		}
	}
	return { batch: { upserts, deletes }, end: index };
}

function logWarning(message: string, error?: unknown): void {
	log('warn', message, error);
}

function logError(message: string, error?: unknown): void {
	log('error', message, error);
}

function log(level: 'warn' | 'error', message: string, error?: unknown): void {
	const code = nativeErrorCode(error);
	const detail = error instanceof FullTextDerivedIndexError ? error.message : code;
	const name = error instanceof Error ? error.name : undefined;
	logger[level]?.(
		`${message}${detail || name ? ` (${detail ?? name}${code && detail !== code ? `; ${code}` : ''})` : ''}`
	);
}

function nativeErrorCode(error: unknown): string | undefined {
	return findNativeErrorCode(error, new Set());
	function findNativeErrorCode(value: unknown, seen: Set<object>): string | undefined {
		if (!value || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		if ('code' in value && typeof value.code === 'string') return value.code;
		if (value instanceof AggregateError) {
			for (const nested of value.errors) {
				const code = findNativeErrorCode(nested, seen);
				if (code) return code;
			}
		}
		if ('cause' in value) return findNativeErrorCode(value.cause, seen);
	}
}

export function encodeFullTextCursorPayload(
	cursor: DerivedIndexCursor | undefined,
	maxBytes = HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES
): string {
	const normalized = cursor && normalizedCursor(cursor);
	const payload = JSON.stringify({
		format: 1,
		cursor: normalized
			? {
					format: 1,
					logs: Object.fromEntries(
						Object.entries(normalized.logs).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					),
					...(normalized.coverage ? { coverage: sortedPositions(normalized.coverage) } : null),
				}
			: null,
	});
	if (Buffer.byteLength(payload) > maxBytes)
		throw new FullTextDerivedIndexConfigurationError(
			`Full-text cursor payload exceeds the configured ${maxBytes}-byte limit`
		);
	return payload;
}

export function decodeFullTextCursorPayload(
	payload: string | null | undefined,
	maxBytes = HARPER_FULLTEXT_MAX_CURSOR_PAYLOAD_BYTES
): DerivedIndexCursor | undefined {
	if (payload == null) return;
	if (typeof payload !== 'string' || Buffer.byteLength(payload) > maxBytes)
		throw new FullTextDerivedIndexError('Full-text cursor payload is invalid or too large');
	let decoded: unknown;
	try {
		decoded = JSON.parse(payload);
	} catch (error) {
		throw new FullTextDerivedIndexError('Full-text cursor payload is not valid JSON', error);
	}
	if (
		!plainObject(decoded) ||
		decoded.format !== 1 ||
		!Object.hasOwn(decoded, 'cursor') ||
		Object.keys(decoded).some((name) => name !== 'format' && name !== 'cursor')
	)
		throw new FullTextDerivedIndexError('Full-text cursor payload has an unsupported format');
	if (decoded.cursor === null) return;
	if (
		!plainObject(decoded.cursor) ||
		decoded.cursor.format !== 1 ||
		!plainObject(decoded.cursor.logs) ||
		Object.keys(decoded.cursor).some((name) => name !== 'format' && name !== 'logs' && name !== 'coverage')
	)
		throw new FullTextDerivedIndexError('Full-text cursor payload contains an invalid cursor');
	return normalizedCursor(decoded.cursor as DerivedIndexCursor);
}

function fullTextFields(projection: unknown): Record<string, string | string[]> {
	const fields: Record<string, string | string[]> = Object.create(null);
	if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return fields;
	for (const [name, value] of Object.entries(projection)) {
		if (typeof value === 'string') fields[name] = value;
		else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) fields[name] = value;
	}
	return fields;
}

function cloneCursor(cursor: DerivedIndexCursor | undefined): DerivedIndexCursor | undefined {
	if (!cursor) return;
	const logs = Object.freeze({ ...cursor.logs });
	const coverage = cursor.coverage && clonePositions(cursor.coverage);
	return Object.freeze({ format: 1, logs, ...(coverage ? { coverage } : null) });
}

function withDurableCoverage(
	cursor: DerivedIndexCursor | undefined,
	durable: DerivedIndexCursor | undefined
): DerivedIndexCursor | undefined {
	if (!cursor || cursor.coverage || !durable?.coverage) return cursor;
	return { ...cursor, coverage: durable.coverage };
}

function sameCursor(left: DerivedIndexCursor | undefined, right: DerivedIndexCursor | undefined): boolean {
	if (!left || !right) return left === right;
	const leftLogs = Object.entries(left.logs);
	const rightLogs = Object.entries(right.logs);
	if (leftLogs.length !== rightLogs.length) return false;
	return leftLogs.every(([name, timestamp]) => Object.hasOwn(right.logs, name) && right.logs[name] === timestamp);
}

function normalizedCursor(cursor: DerivedIndexCursor): DerivedIndexCursor {
	if (!plainObject(cursor) || cursor.format !== 1 || !plainObject(cursor.logs))
		throw new FullTextDerivedIndexError('Full-text cursor payload contains an invalid cursor');
	const logs: Record<string, number> = Object.create(null);
	for (const name in cursor.logs) {
		if (!Object.hasOwn(cursor.logs, name)) continue;
		const timestamp = cursor.logs[name];
		if (!name || !Number.isFinite(timestamp) || timestamp <= 0)
			throw new FullTextDerivedIndexError('Full-text cursor payload contains an invalid log position');
		logs[name] = timestamp;
	}
	let coverage: DerivedIndexPositions | undefined;
	if (cursor.coverage !== undefined) coverage = normalizedPositions(cursor.coverage);
	Object.freeze(logs);
	return Object.freeze({ format: 1, logs, ...(coverage ? { coverage } : null) });
}

function normalizedPositions(value: unknown): DerivedIndexPositions {
	if (!plainObject(value)) throw new FullTextDerivedIndexError('Full-text cursor payload contains invalid coverage');
	const positions: DerivedIndexPositions = Object.create(null);
	for (const name in value) {
		if (!Object.hasOwn(value, name)) continue;
		if (!name) throw new FullTextDerivedIndexError('Full-text cursor payload contains invalid coverage');
		const position = value[name];
		if (position === null) positions[name] = null;
		else if (
			plainObject(position) &&
			Object.keys(position).length === 2 &&
			Object.hasOwn(position, 'sequence') &&
			Object.hasOwn(position, 'offset') &&
			Number.isSafeInteger(position.sequence) &&
			position.sequence >= 0 &&
			Number.isSafeInteger(position.offset) &&
			position.offset >= 0
		)
			positions[name] = { sequence: position.sequence, offset: position.offset };
		else throw new FullTextDerivedIndexError('Full-text cursor payload contains invalid coverage');
	}
	return Object.freeze(positions);
}

function clonePositions(positions: DerivedIndexPositions): DerivedIndexPositions {
	const clone: DerivedIndexPositions = Object.create(null);
	for (const name in positions) {
		if (!Object.hasOwn(positions, name)) continue;
		const position = positions[name];
		clone[name] = position && { sequence: position.sequence, offset: position.offset };
	}
	return Object.freeze(clone);
}

function sortedPositions(positions: DerivedIndexPositions): DerivedIndexPositions {
	return Object.fromEntries(
		Object.entries(positions)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([name, position]) => [name, position && { sequence: position.sequence, offset: position.offset }])
	);
}

function plainObject(value: unknown): value is Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
	return value;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
	return value;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, timeoutError: () => Error): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(timeoutError()), milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
}
