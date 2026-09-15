import type {
	DerivedIndexBackend,
	DerivedIndexBackendHost,
	DerivedIndexBackendStateChange,
	DerivedIndexBatch,
	DerivedIndexCursor,
	DerivedIndexDeliveryResult,
	DerivedIndexFlushReason,
} from './derivedIndexRuntime.ts';
import {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DERIVED_INDEX_FAILED,
	DerivedIndexBackendRetryError,
} from './derivedIndexRuntime.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';

const logger = loggerWithTag('fulltext-derived-index');

const DEFAULT_MAX_QUEUED_BATCHES = 16;
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CURSOR_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_OPEN_ATTEMPTS = 3;
const DEFAULT_OPEN_RETRY_MILLISECONDS = 10;
const DEFAULT_CURSOR_ONLY_PUBLISH_AFTER_FLUSHES = 1;
const MAX_CURSOR_ONLY_PUBLISH_AFTER_FLUSHES = 16;
const MAX_CURSOR_ONLY_PUBLISH_DELAY_MILLISECONDS = 60_000;
const RESERVED_LOG_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export interface FullTextDerivedIndexEngine {
	readonly committedPayload?: string;
	/** Resolves to the number of mutation commands accepted; deleting an absent document still counts. */
	apply(batch: Uint8Array): Promise<number>;
	/** Success proves the cursor payload and every preceding mutation are durably ordered together. */
	publish(payload: string): Promise<bigint>;
	close(options?: { mode?: 'require-clean' | 'rollback' }): Promise<void>;
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
	encodeMutationBatch: (batch: FullTextMutationBatch) => Uint8Array;
	maxQueuedBatches?: number;
	maxQueuedBytes?: number;
	maxCursorPayloadBytes?: number;
	openAttempts?: number;
	openRetryMilliseconds?: number;
	cursorOnlyPublishAfterFlushes?: number;
	maxCursorOnlyPublishDelayMilliseconds?: number;
	now?: () => number;
};

type ApplyCommand = {
	type: 'apply';
	epoch: bigint;
	sequence: number;
	batch: DerivedIndexBatch;
	bytes: number;
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

export class FullTextDerivedIndexBackend implements DerivedIndexBackend {
	readonly id: string;
	#lifecycle: FullTextDerivedIndexLifecycle;
	#encodeMutationBatch: (batch: FullTextMutationBatch) => Uint8Array;
	#maxQueuedBatches: number;
	#maxQueuedBytes: number;
	#maxCursorPayloadBytes: number;
	#openAttempts: number;
	#openRetryMilliseconds: number;
	#cursorOnlyPublishAfterFlushes: number;
	#maxCursorOnlyPublishDelayMilliseconds: number;
	#now: () => number;
	#host?: DerivedIndexBackendHost;
	#wake?: (change?: DerivedIndexBackendStateChange) => void;
	#engine?: FullTextDerivedIndexEngine;
	#durableCursor?: DerivedIndexCursor;
	#inspected = false;
	#activeEpoch?: bigint;
	#commands: Command[] = [];
	#retainedBatches = 0;
	#retainedBytes = 0;
	#lastAcceptedSequence = 0;
	#lastAppliedSequence = 0;
	#lastPublishedSequence = 0;
	#lastBarrierHorizon = 0;
	#lastMutationSequence = 0;
	#lastAcceptedCursor?: DerivedIndexCursor;
	#hasStagedMutations = false;
	#cursorOnlyAgeFlushes = 0;
	#cursorOnlySince?: number;
	#draining = false;
	#scheduled = false;
	#settlingWriter = false;
	#lossPendingEpoch?: bigint;
	#failed = false;
	#capacityDeferred = false;
	#shutdown?: ShutdownRequest;

	constructor(options: FullTextDerivedIndexBackendOptions) {
		if (!options.id) throw new TypeError('Full-text derived index id is required');
		if (
			!options.lifecycle ||
			typeof options.lifecycle.inspect !== 'function' ||
			typeof options.lifecycle.open !== 'function' ||
			typeof options.lifecycle.reset !== 'function'
		)
			throw new TypeError('Full-text derived index lifecycle must implement inspect(), open(), and reset()');
		if (typeof options.encodeMutationBatch !== 'function')
			throw new TypeError('Full-text derived index batch encoder is required');
		this.id = options.id;
		this.#lifecycle = options.lifecycle;
		this.#encodeMutationBatch = options.encodeMutationBatch;
		this.#maxQueuedBatches = positiveInteger(
			options.maxQueuedBatches ?? DEFAULT_MAX_QUEUED_BATCHES,
			'maxQueuedBatches'
		);
		this.#maxQueuedBytes = positiveInteger(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES, 'maxQueuedBytes');
		this.#maxCursorPayloadBytes = positiveInteger(
			options.maxCursorPayloadBytes ?? DEFAULT_MAX_CURSOR_PAYLOAD_BYTES,
			'maxCursorPayloadBytes'
		);
		this.#openAttempts = positiveInteger(options.openAttempts ?? DEFAULT_OPEN_ATTEMPTS, 'openAttempts');
		this.#openRetryMilliseconds = nonNegativeInteger(
			options.openRetryMilliseconds ?? DEFAULT_OPEN_RETRY_MILLISECONDS,
			'openRetryMilliseconds'
		);
		this.#cursorOnlyPublishAfterFlushes = boundedPositiveInteger(
			options.cursorOnlyPublishAfterFlushes ?? DEFAULT_CURSOR_ONLY_PUBLISH_AFTER_FLUSHES,
			'cursorOnlyPublishAfterFlushes',
			MAX_CURSOR_ONLY_PUBLISH_AFTER_FLUSHES
		);
		this.#maxCursorOnlyPublishDelayMilliseconds = boundedNonNegativeInteger(
			options.maxCursorOnlyPublishDelayMilliseconds ?? 0,
			'maxCursorOnlyPublishDelayMilliseconds',
			MAX_CURSOR_ONLY_PUBLISH_DELAY_MILLISECONDS
		);
		if (this.#cursorOnlyPublishAfterFlushes > 1 && this.#maxCursorOnlyPublishDelayMilliseconds === 0)
			throw new TypeError(
				'maxCursorOnlyPublishDelayMilliseconds is required when cursor-only publication is coalesced'
			);
		this.#now = options.now ?? Date.now;
	}

	attach(host: DerivedIndexBackendHost): void {
		if (this.#host && this.#host !== host && (this.#engine || this.#draining || this.#wake))
			throw new Error('Full-text derived index backend is already attached');
		this.#host = host;
	}

	getDurableCursor(): DerivedIndexCursor | undefined {
		if (!this.#inspected) {
			let inspection: FullTextDerivedIndexInspection;
			try {
				inspection = this.#lifecycle.inspect();
			} catch (error) {
				throw new DerivedIndexBackendRetryError('Full-text derived index state could not be inspected', error);
			}
			this.#inspected = true;
			if (inspection.state === 'checkpointed') {
				try {
					this.#durableCursor = decodeFullTextCursorPayload(inspection.committedPayload, this.#maxCursorPayloadBytes);
				} catch (error) {
					logWarning(`Full-text derived index '${this.id}' has an invalid committed cursor; rebuilding`, error);
					this.#durableCursor = undefined;
				}
			} else {
				if (inspection.state === 'incompatible')
					logWarning(
						`Full-text derived index '${this.id}' is incompatible (${inspection.code}); rebuilding`,
						undefined
					);
				this.#durableCursor = undefined;
			}
		}
		return cloneCursor(this.#durableCursor);
	}

	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult {
		if (this.#failed || !this.#host?.isOwnerEpoch(batch.ownerEpoch)) return DERIVED_INDEX_FAILED;
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
		const bytes = Math.max(1, batch.bytes);
		if (!Number.isSafeInteger(bytes) || bytes > this.#maxQueuedBytes) {
			this.#markFailed(new FullTextDerivedIndexError('Full-text derived index batch exceeds its queue byte limit'));
			return DERIVED_INDEX_FAILED;
		}
		if (this.#retainedBatches >= this.#maxQueuedBatches || this.#retainedBytes + bytes > this.#maxQueuedBytes) {
			this.#capacityDeferred = true;
			return DERIVED_INDEX_DEFERRED;
		}
		const sequence = ++this.#lastAcceptedSequence;
		if (batch.records.length > 0) {
			this.#lastMutationSequence = sequence;
			this.#resetCursorOnlyFlushes();
		} else if (this.#cursorOnlyPublishAfterFlushes > 1 && this.#cursorOnlySince === undefined) {
			this.#cursorOnlySince = this.#now();
		}
		if (through) this.#lastAcceptedCursor = through;
		this.#commands.push({ type: 'apply', epoch: batch.ownerEpoch, sequence, batch, bytes });
		this.#retainedBatches++;
		this.#retainedBytes += bytes;
		this.#scheduleDrain();
		return DERIVED_INDEX_ACCEPTED;
	}

	flush(reason: DerivedIndexFlushReason = 'threshold'): void {
		if (this.#activeEpoch === undefined || this.#failed || this.#shutdown) return;
		this.#queueBarrier(this.#activeEpoch, reason);
	}

	shutdown(ownerEpoch: bigint): Promise<void> {
		if (this.#shutdown?.epoch === ownerEpoch) return this.#shutdown.promise;
		if (this.#activeEpoch !== ownerEpoch) return Promise.resolve();
		this.#queueBarrier(ownerEpoch, 'shutdown');
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
			this.#commands.length > 0 ||
			this.#shutdown?.closing
		)
			throw new FullTextDerivedIndexError('Full-text derived index backend is not quiescent at reset');
		this.#assertSharedEpoch(ownerEpoch);
		this.#shutdown = undefined;
		this.#failed = false;
		await this.#lifecycle.reset();
		this.#durableCursor = undefined;
		this.#inspected = true;
		this.#assertSharedEpoch(ownerEpoch);
		this.#activeEpoch = ownerEpoch;
		this.#resetQueueState();
	}

	onStateChange(wake: (change?: DerivedIndexBackendStateChange) => void): () => void {
		if (this.#wake && this.#wake !== wake)
			throw new Error('Full-text derived index backend already has a state listener');
		this.#wake = wake;
		return () => {
			if (this.#wake === wake) this.#wake = undefined;
		};
	}

	#queueBarrier(epoch: bigint, reason: DerivedIndexFlushReason): void {
		const horizon = this.#lastAcceptedSequence;
		if (horizon === 0 || horizon <= this.#lastBarrierHorizon) return;
		const hasMutations = this.#lastMutationSequence > this.#lastBarrierHorizon;
		if (reason === 'age' && !hasMutations && this.#cursorOnlyPublishAfterFlushes > 1) {
			const ageFlushes = ++this.#cursorOnlyAgeFlushes;
			const now = this.#now();
			const delayed = now - (this.#cursorOnlySince ?? now);
			if (ageFlushes < this.#cursorOnlyPublishAfterFlushes && delayed < this.#maxCursorOnlyPublishDelayMilliseconds)
				return;
		}
		this.#lastBarrierHorizon = horizon;
		this.#resetCursorOnlyFlushes();
		this.#commands.push({
			type: 'barrier',
			epoch,
			horizon,
			cursor: cloneCursor(this.#lastAcceptedCursor ?? this.#durableCursor),
		});
		this.#scheduleDrain();
	}

	#scheduleDrain(): void {
		if (this.#scheduled || this.#draining) return;
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
			if (this.#commands.length > 0 && !(await this.#ensureEngine())) return;
			while (this.#commands.length > 0 && !this.#failed && this.#engine) {
				const command = this.#commands.shift()!;
				if (command.type === 'apply') {
					try {
						if (!(await this.#apply(command))) break;
					} finally {
						this.#retainedBatches = Math.max(0, this.#retainedBatches - 1);
						this.#retainedBytes = Math.max(0, this.#retainedBytes - command.bytes);
						if (this.#capacityDeferred && !this.#failed) this.#notify('changed');
					}
				} else if (!(await this.#publish(command))) break;
			}
		} catch (error) {
			this.#failAndNotify(error);
		} finally {
			this.#draining = false;
			if (this.#shutdown && !this.#shutdown.closing) void this.#closeForShutdown(this.#shutdown);
			else if (!this.#failed && this.#commands.length > 0) this.#scheduleDrain();
		}
	}

	async #ensureEngine(): Promise<boolean> {
		if (this.#engine) return true;
		const epoch = this.#activeEpoch;
		if (epoch === undefined) throw new FullTextDerivedIndexError('Full-text owner epoch is unavailable');
		const engine = await this.#open(epoch);
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
			this.#inspected = true;
			this.#discardCommands();
			this.#notify('accepted-work-lost');
			return false;
		}
		this.#engine = engine;
		return true;
	}

	async #closeUninstalledEngine(engine: FullTextDerivedIndexEngine, cause: unknown): Promise<void> {
		this.#settlingWriter = true;
		try {
			await engine.close({ mode: 'rollback' });
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
		let packed: Uint8Array;
		try {
			packed = this.#encodeMutationBatch(toFullTextMutationRecords(command.batch.records));
			if (!(packed instanceof Uint8Array)) throw new TypeError('Full-text batch encoder must return a Uint8Array');
		} catch (error) {
			throw new FullTextDerivedIndexError('Failed to encode a full-text mutation batch', error);
		}
		this.#hasStagedMutations = true;
		try {
			const applied = await this.#engine!.apply(packed);
			if (applied !== command.batch.records.length)
				throw new FullTextDerivedIndexError(
					`Full-text engine applied ${applied} of ${command.batch.records.length} mutations`
				);
		} catch (error) {
			await this.#loseAcceptedWork(command.epoch, error);
			return false;
		}
		this.#assertCommandEpoch(command.epoch);
		this.#lastAppliedSequence = command.sequence;
		return true;
	}

	async #publish(command: BarrierCommand): Promise<boolean> {
		if (command.horizon <= this.#lastPublishedSequence) return true;
		this.#assertCommandEpoch(command.epoch);
		if (this.#lastAppliedSequence < command.horizon)
			throw new FullTextDerivedIndexError('Full-text publication barrier passed unapplied work');
		const cursor = command.cursor ?? this.#durableCursor;
		const payload = encodeFullTextCursorPayload(cursor, this.#maxCursorPayloadBytes);
		try {
			await this.#engine!.publish(payload);
		} catch (error) {
			await this.#loseAcceptedWork(command.epoch, error);
			return false;
		}
		this.#assertCommandEpoch(command.epoch);
		this.#lastPublishedSequence = command.horizon;
		this.#hasStagedMutations = false;
		this.#durableCursor = cloneCursor(cursor);
		this.#inspected = true;
		if (!this.#shutdown) this.#notify('changed');
		return true;
	}

	async #loseAcceptedWork(ownerEpoch: bigint, cause: unknown): Promise<void> {
		this.#lossPendingEpoch = ownerEpoch;
		this.#discardCommands();
		const engine = this.#engine;
		this.#engine = undefined;
		if (!engine) throw new FullTextDerivedIndexError('Full-text writer is unavailable', cause);
		try {
			await engine.close({ mode: 'rollback' });
		} catch (error) {
			this.#engine = engine;
			throw new FullTextDerivedIndexError(
				'Full-text writer could not prove quiescence after losing accepted work',
				new AggregateError([cause, error])
			);
		}
		this.#assertCommandEpoch(ownerEpoch);
		this.#hasStagedMutations = false;
		this.#notify('accepted-work-lost');
	}

	async #closeForShutdown(request: ShutdownRequest): Promise<void> {
		if (request !== this.#shutdown || request.closing) return;
		request.closing = true;
		const engine = this.#engine;
		try {
			if (engine) {
				const mode =
					this.#hasStagedMutations || this.#lastAppliedSequence > this.#lastPublishedSequence
						? 'rollback'
						: 'require-clean';
				await engine.close({ mode });
			}
			this.#engine = undefined;
			this.#activeEpoch = undefined;
			this.#inspected = false;
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

	async #open(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.#openAttempts; attempt++) {
			this.#assertSharedEpoch(ownerEpoch);
			try {
				return await this.#lifecycle.open();
			} catch (error) {
				lastError = error;
				if (attempt < this.#openAttempts && this.#openRetryMilliseconds > 0) await delay(this.#openRetryMilliseconds);
			}
		}
		throw new FullTextDerivedIndexError('Full-text writer could not be opened', lastError);
	}

	#discardCommands(): void {
		this.#commands = [];
		this.#retainedBatches = 0;
		this.#retainedBytes = 0;
		this.#lastBarrierHorizon = this.#lastPublishedSequence;
		this.#capacityDeferred = false;
		this.#resetCursorOnlyFlushes();
	}

	#resetQueueState(): void {
		this.#commands = [];
		this.#retainedBatches = 0;
		this.#retainedBytes = 0;
		this.#lastAcceptedSequence = 0;
		this.#lastAppliedSequence = 0;
		this.#lastPublishedSequence = 0;
		this.#lastBarrierHorizon = 0;
		this.#lastMutationSequence = 0;
		this.#lastAcceptedCursor = undefined;
		this.#hasStagedMutations = false;
		this.#capacityDeferred = false;
		this.#lossPendingEpoch = undefined;
		this.#resetCursorOnlyFlushes();
	}

	#markFailed(error: unknown): boolean {
		if (this.#failed) return false;
		this.#failed = true;
		this.#discardCommands();
		logError('Full-text derived index backend failed', error);
		return true;
	}

	#failAndNotify(error: unknown): void {
		if (this.#markFailed(error)) this.#notify('failed');
	}

	#resetCursorOnlyFlushes(): void {
		this.#cursorOnlyAgeFlushes = 0;
		this.#cursorOnlySince = undefined;
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

function toFullTextMutationRecords(records: DerivedIndexBatch['records']): FullTextMutationBatch {
	const upserts: FullTextMutationBatch['upserts'] = [];
	const deletes: string[] = [];
	for (const record of records) {
		const id = `${record.tableId}.${Buffer.from(record.recordKey, 'latin1').toString('base64url')}`;
		if (record.state.kind === 'record') upserts.push({ id, fields: fullTextFields(record.state.projection) });
		else deletes.push(id);
	}
	return { upserts, deletes };
}

function logWarning(message: string, error: unknown): void {
	log('warn', message, error);
}

function logError(message: string, error: unknown): void {
	log('error', message, error);
}

function log(level: 'warn' | 'error', message: string, error: unknown): void {
	logger[level]?.(message, error);
}

export function encodeFullTextCursorPayload(
	cursor: DerivedIndexCursor | undefined,
	maxBytes = DEFAULT_MAX_CURSOR_PAYLOAD_BYTES
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
				}
			: null,
	});
	if (Buffer.byteLength(payload) > maxBytes)
		throw new FullTextDerivedIndexError('Full-text cursor payload is too large');
	return payload;
}

export function decodeFullTextCursorPayload(
	payload: string | null | undefined,
	maxBytes = DEFAULT_MAX_CURSOR_PAYLOAD_BYTES
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
		Object.keys(decoded.cursor).some((name) => name !== 'format' && name !== 'logs')
	)
		throw new FullTextDerivedIndexError('Full-text cursor payload contains an invalid cursor');
	return normalizedCursor(decoded.cursor as DerivedIndexCursor);
}

function fullTextFields(projection: unknown): Record<string, string | string[]> {
	const fields: Record<string, string | string[]> = Object.create(null);
	if (!plainObject(projection)) return fields;
	for (const name in projection) {
		if (!Object.hasOwn(projection, name)) continue;
		const value = projection[name];
		if (typeof value === 'string') fields[name] = value;
		else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) fields[name] = value;
	}
	return fields;
}

function cloneCursor(cursor: DerivedIndexCursor | undefined): DerivedIndexCursor | undefined {
	if (!cursor) return;
	const logs = Object.freeze({ ...cursor.logs });
	return Object.freeze({ format: 1, logs });
}

function sameCursor(left: DerivedIndexCursor | undefined, right: DerivedIndexCursor | undefined): boolean {
	if (!left || !right) return left === right;
	const leftLogs = Object.entries(left.logs);
	const rightLogs = Object.entries(right.logs);
	if (leftLogs.length !== rightLogs.length) return false;
	return leftLogs.every(([name, timestamp]) => right.logs[name] === timestamp);
}

function normalizedCursor(cursor: DerivedIndexCursor): DerivedIndexCursor {
	if (!plainObject(cursor) || cursor.format !== 1 || !plainObject(cursor.logs))
		throw new FullTextDerivedIndexError('Full-text cursor payload contains an invalid cursor');
	const logs: Record<string, number> = Object.create(null);
	for (const name in cursor.logs) {
		if (!Object.hasOwn(cursor.logs, name)) continue;
		const timestamp = cursor.logs[name];
		if (!name || RESERVED_LOG_NAMES.has(name) || !Number.isFinite(timestamp) || timestamp <= 0)
			throw new FullTextDerivedIndexError('Full-text cursor payload contains an invalid log position');
		logs[name] = timestamp;
	}
	Object.freeze(logs);
	return Object.freeze({ format: 1, logs });
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

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	const integer = positiveInteger(value, name);
	if (integer > maximum) throw new TypeError(`${name} must not exceed ${maximum}`);
	return integer;
}

function boundedNonNegativeInteger(value: number, name: string, maximum: number): number {
	const integer = nonNegativeInteger(value, name);
	if (integer > maximum) throw new TypeError(`${name} must not exceed ${maximum}`);
	return integer;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});
}
