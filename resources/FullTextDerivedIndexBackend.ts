import {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DERIVED_INDEX_FAILED,
	type DerivedIndexBackend,
	type DerivedIndexBackendHost,
	type DerivedIndexBackendStateChange,
	type DerivedIndexBatch,
	type DerivedIndexCursor,
	type DerivedIndexDeliveryResult,
} from './derivedIndexRuntime.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';

const logger = loggerWithTag('fulltext-derived-index');

const DEFAULT_MAX_QUEUED_BATCHES = 16;
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CURSOR_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_OPEN_ATTEMPTS = 3;
const DEFAULT_OPEN_RETRY_MILLISECONDS = 10;
const RESERVED_LOG_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export interface FullTextDerivedIndexEngine {
	readonly committedPayload?: string;
	apply(batch: Uint8Array): Promise<number>;
	publish(payload: string): Promise<bigint>;
	close(options?: { mode?: 'require-clean' | 'rollback' }): Promise<void>;
}

export interface FullTextDerivedIndexLifecycle {
	open(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine>;
	replace(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine>;
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
	#draining = false;
	#scheduled = false;
	#recovering = false;
	#lossPendingEpoch?: bigint;
	#failed = false;
	#capacityDeferred = false;
	#shutdown?: ShutdownRequest;

	constructor(options: FullTextDerivedIndexBackendOptions) {
		if (!options.id) throw new TypeError('Full-text derived index id is required');
		if (
			!options.lifecycle ||
			typeof options.lifecycle.open !== 'function' ||
			typeof options.lifecycle.replace !== 'function'
		)
			throw new TypeError('Full-text derived index lifecycle must implement open() and replace()');
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
	}

	attach(host: DerivedIndexBackendHost): void {
		if (this.#host && this.#host !== host && (this.#engine || this.#draining || this.#recovering || this.#wake))
			throw new Error('Full-text derived index backend is already attached');
		this.#host = host;
	}

	async acquire(ownerEpoch: bigint): Promise<DerivedIndexCursor | undefined> {
		this.#assertAttached();
		if (this.#engine && this.#activeEpoch === ownerEpoch && !this.#shutdown && !this.#failed)
			return this.#durableCursor;
		if (this.#engine || this.#draining || this.#recovering)
			throw new FullTextDerivedIndexError('Full-text derived index backend is not quiescent at acquisition');
		this.#shutdown = undefined;
		this.#failed = false;
		const engine = await this.#open(ownerEpoch);
		let cursor: DerivedIndexCursor | undefined;
		let payloadError: unknown;
		try {
			this.#assertSharedEpoch(ownerEpoch);
			try {
				cursor = decodeFullTextCursorPayload(engine.committedPayload, this.#maxCursorPayloadBytes);
			} catch (error) {
				payloadError = error;
				throw error;
			}
			this.#assertSharedEpoch(ownerEpoch);
			this.#installEngine(engine, ownerEpoch, cursor);
			return cursor;
		} catch (error) {
			try {
				await engine.close({ mode: 'rollback' });
			} catch (closeError) {
				this.#engine = engine;
				this.#activeEpoch = ownerEpoch;
				this.#failed = true;
				throw new FullTextDerivedIndexError('Full-text acquisition could not close its engine', closeError);
			}
			if (error === payloadError) {
				logger.warn?.(`Full-text derived index '${this.id}' has an invalid committed cursor; rebuilding`, error);
				return;
			}
			throw error;
		}
	}

	getDurableCursor(): DerivedIndexCursor | undefined {
		return this.#durableCursor;
	}

	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult {
		if (this.#failed) return DERIVED_INDEX_FAILED;
		if (this.#recovering || this.#lossPendingEpoch === batch.ownerEpoch) return DERIVED_INDEX_DEFERRED;
		if (!this.#engine || this.#activeEpoch !== batch.ownerEpoch || this.#shutdown) return DERIVED_INDEX_FAILED;
		let through: DerivedIndexCursor | undefined;
		try {
			through = batch.through && normalizedCursor(batch.through);
			if (through && !cursorAtOrAfter(through, this.#lastAcceptedCursor ?? this.#durableCursor))
				throw new FullTextDerivedIndexError('Full-text derived index cursor moved backward');
		} catch (error) {
			this.#fail(error);
			return DERIVED_INDEX_FAILED;
		}
		const bytes = Math.max(1, batch.bytes);
		if (!Number.isSafeInteger(bytes) || bytes > this.#maxQueuedBytes) {
			this.#fail(new FullTextDerivedIndexError('Full-text derived index batch exceeds its queue byte limit'));
			return DERIVED_INDEX_FAILED;
		}
		if (this.#retainedBatches >= this.#maxQueuedBatches || this.#retainedBytes + bytes > this.#maxQueuedBytes) {
			this.#capacityDeferred = true;
			return DERIVED_INDEX_DEFERRED;
		}
		const sequence = ++this.#lastAcceptedSequence;
		if (through) this.#lastAcceptedCursor = through;
		this.#commands.push({ type: 'apply', epoch: batch.ownerEpoch, sequence, batch, bytes });
		this.#retainedBatches++;
		this.#retainedBytes += bytes;
		this.#scheduleDrain();
		return DERIVED_INDEX_ACCEPTED;
	}

	flush(): void {
		if (!this.#engine || this.#activeEpoch === undefined || this.#failed || this.#recovering) return;
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
		if (this.#engine || this.#draining || this.#recovering)
			throw new FullTextDerivedIndexError('Full-text derived index backend is not quiescent at reset');
		this.#shutdown = undefined;
		this.#failed = false;
		await this.#invalidateOldGeneration(ownerEpoch);
		let replacement: FullTextDerivedIndexEngine | undefined;
		try {
			replacement = await this.#lifecycle.replace(ownerEpoch);
			this.#assertSharedEpoch(ownerEpoch);
			const cursor = decodeFullTextCursorPayload(replacement.committedPayload, this.#maxCursorPayloadBytes);
			if (cursor) throw new FullTextDerivedIndexError('Replacement full-text generation retained a durable cursor');
		} catch (error) {
			if (replacement) {
				try {
					await replacement.close({ mode: 'rollback' });
				} catch (closeError) {
					this.#engine = replacement;
					this.#activeEpoch = ownerEpoch;
					this.#failed = true;
					throw new FullTextDerivedIndexError('Replacement full-text generation could not close', closeError);
				}
			}
			this.#fail(error);
			throw error;
		}
		this.#installEngine(replacement, ownerEpoch, undefined);
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
			while (this.#commands.length > 0 && !this.#failed) {
				const command = this.#commands.shift()!;
				if (command.type === 'apply') {
					try {
						await this.#apply(command);
					} finally {
						this.#retainedBatches = Math.max(0, this.#retainedBatches - 1);
						this.#retainedBytes = Math.max(0, this.#retainedBytes - command.bytes);
					}
				} else {
					await this.#publish(command);
				}
			}
		} catch (error) {
			this.#fail(error);
		} finally {
			this.#draining = false;
			if (this.#shutdown && !this.#shutdown.closing) void this.#closeForShutdown(this.#shutdown);
			else {
				if (this.#capacityDeferred) this.#notify('changed');
				if (this.#commands.length > 0) this.#scheduleDrain();
			}
		}
	}

	async #apply(command: ApplyCommand): Promise<void> {
		this.#assertCommandEpoch(command.epoch);
		let packed: Uint8Array;
		try {
			packed = this.#encodeMutationBatch(toFullTextMutationBatch(command.batch));
			if (!(packed instanceof Uint8Array)) throw new TypeError('Full-text batch encoder must return a Uint8Array');
		} catch (error) {
			throw new FullTextDerivedIndexError('Failed to encode a full-text mutation batch', error);
		}
		const expected = command.batch.records.length;
		try {
			const applied = await this.#engine!.apply(packed);
			if (applied !== expected)
				throw new FullTextDerivedIndexError(`Full-text engine applied ${applied} of ${expected} mutations`);
			this.#assertCommandEpoch(command.epoch);
			this.#lastAppliedSequence = command.sequence;
		} catch (error) {
			await this.#recoverAcceptedWork(command.epoch, error);
		}
	}

	async #publish(command: BarrierCommand): Promise<void> {
		if (command.horizon <= this.#lastPublishedSequence) return;
		this.#assertCommandEpoch(command.epoch);
		if (this.#lastAppliedSequence < command.horizon)
			throw new FullTextDerivedIndexError('Full-text publication barrier passed unapplied work');
		const cursor = command.cursor ?? this.#durableCursor;
		const payload = encodeFullTextCursorPayload(cursor, this.#maxCursorPayloadBytes);
		try {
			await this.#engine!.publish(payload);
			this.#assertCommandEpoch(command.epoch);
			this.#lastPublishedSequence = command.horizon;
			if (cursor) this.#durableCursor = cloneCursor(cursor);
			if (!this.#shutdown) this.#notify('changed');
		} catch (error) {
			await this.#recoverAcceptedWork(command.epoch, error);
		}
	}

	async #recoverAcceptedWork(ownerEpoch: bigint, cause: unknown): Promise<void> {
		if (this.#recovering) return;
		this.#recovering = true;
		this.#discardCommands();
		const engine = this.#engine;
		try {
			if (!engine) throw new FullTextDerivedIndexError('Full-text engine is unavailable', cause);
			await engine.close({ mode: 'rollback' });
			this.#engine = undefined;
			this.#assertCommandEpoch(ownerEpoch);
			const reopened = await this.#open(ownerEpoch);
			try {
				this.#assertCommandEpoch(ownerEpoch);
				const cursor = decodeFullTextCursorPayload(reopened.committedPayload, this.#maxCursorPayloadBytes);
				this.#installEngine(reopened, ownerEpoch, cursor);
			} catch (error) {
				try {
					await reopened.close({ mode: 'rollback' });
				} catch (closeError) {
					this.#engine = reopened;
					this.#activeEpoch = ownerEpoch;
					throw new FullTextDerivedIndexError('Recovered full-text generation could not close', closeError);
				}
				throw error;
			}
			this.#lossPendingEpoch = ownerEpoch;
			this.#notify('accepted-work-lost');
		} catch (error) {
			this.#fail(new FullTextDerivedIndexError('Full-text engine recovery failed', error));
		} finally {
			this.#recovering = false;
		}
	}

	async #closeForShutdown(request: ShutdownRequest): Promise<void> {
		if (request !== this.#shutdown || request.closing) return;
		request.closing = true;
		const engine = this.#engine;
		this.#activeEpoch = undefined;
		try {
			if (engine) {
				const mode = this.#lastAppliedSequence > this.#lastPublishedSequence ? 'rollback' : 'require-clean';
				await engine.close({ mode });
			}
			this.#engine = undefined;
			this.#durableCursor = undefined;
			request.resolve();
		} catch (error) {
			this.#activeEpoch = request.epoch;
			this.#failed = true;
			if (this.#shutdown === request) this.#shutdown = undefined;
			request.reject(new FullTextDerivedIndexError('Full-text engine shutdown did not prove quiescence', error));
			this.#notify('failed');
		}
	}

	async #invalidateOldGeneration(ownerEpoch: bigint): Promise<void> {
		let engine: FullTextDerivedIndexEngine | undefined;
		let tombstonePublished = false;
		try {
			engine = await this.#open(ownerEpoch);
		} catch {
			this.#assertSharedEpoch(ownerEpoch);
			return;
		}
		try {
			this.#assertSharedEpoch(ownerEpoch);
			await engine.publish(encodeFullTextCursorPayload(undefined, this.#maxCursorPayloadBytes));
			tombstonePublished = true;
			this.#assertSharedEpoch(ownerEpoch);
			await engine.close({ mode: 'require-clean' });
		} catch (error) {
			try {
				await engine.close({ mode: 'rollback' });
			} catch (closeError) {
				this.#engine = engine;
				this.#activeEpoch = ownerEpoch;
				this.#failed = true;
				throw new FullTextDerivedIndexError('Old full-text generation could not close before replacement', closeError);
			}
			this.#assertSharedEpoch(ownerEpoch);
			throw new FullTextDerivedIndexError(
				tombstonePublished
					? 'Old full-text generation could not close after publishing its cursor tombstone'
					: 'Old full-text generation could not publish its cursor tombstone',
				error
			);
		}
		this.#assertSharedEpoch(ownerEpoch);
	}

	async #open(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.#openAttempts; attempt++) {
			this.#assertSharedEpoch(ownerEpoch);
			try {
				return await this.#lifecycle.open(ownerEpoch);
			} catch (error) {
				lastError = error;
				if (attempt < this.#openAttempts && this.#openRetryMilliseconds > 0) await delay(this.#openRetryMilliseconds);
			}
		}
		throw new FullTextDerivedIndexError('Full-text generation could not be opened', lastError);
	}

	#installEngine(engine: FullTextDerivedIndexEngine, ownerEpoch: bigint, cursor: DerivedIndexCursor | undefined): void {
		this.#engine = engine;
		this.#activeEpoch = ownerEpoch;
		this.#durableCursor = cursor;
		this.#commands = [];
		this.#retainedBatches = 0;
		this.#retainedBytes = 0;
		this.#lastAcceptedSequence = 0;
		this.#lastAppliedSequence = 0;
		this.#lastPublishedSequence = 0;
		this.#lastBarrierHorizon = 0;
		this.#lastAcceptedCursor = undefined;
		this.#capacityDeferred = false;
		this.#lossPendingEpoch = undefined;
		this.#failed = false;
	}

	#discardCommands(): void {
		this.#commands = [];
		this.#retainedBatches = 0;
		this.#retainedBytes = 0;
		this.#lastBarrierHorizon = this.#lastPublishedSequence;
	}

	#fail(error: unknown): void {
		this.#failed = true;
		this.#discardCommands();
		logger.error('Full-text derived index backend failed', error);
		this.#notify('failed');
	}

	#assertAttached(): void {
		if (!this.#host) throw new Error('Full-text derived index backend must be attached before acquisition');
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
			if (change === 'accepted-work-lost') this.#lossPendingEpoch = undefined;
			return;
		}
		setImmediate(() => {
			if (this.#activeEpoch !== activeEpoch) return;
			if (this.#wake !== wake || (change === 'accepted-work-lost' && this.#shutdown)) {
				if (change === 'accepted-work-lost' && this.#lossPendingEpoch === activeEpoch)
					this.#lossPendingEpoch = undefined;
				return;
			}
			try {
				wake(change);
			} catch (error) {
				logger.error('Full-text derived index state notification failed', error);
			} finally {
				if (change === 'accepted-work-lost' && this.#lossPendingEpoch === activeEpoch)
					this.#lossPendingEpoch = undefined;
			}
		});
	}
}

export function toFullTextMutationBatch(batch: DerivedIndexBatch): FullTextMutationBatch {
	const upserts: FullTextMutationBatch['upserts'] = [];
	const deletes: string[] = [];
	for (const record of batch.records) {
		const id = `${record.tableId}.${Buffer.from(record.recordKey, 'latin1').toString('base64url')}`;
		if (record.state.kind === 'record') {
			upserts.push({ id, fields: fullTextFields(record.state.projection) });
		} else {
			deletes.push(id);
		}
	}
	return { upserts, deletes };
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

function cursorAtOrAfter(cursor: DerivedIndexCursor, previous: DerivedIndexCursor | undefined): boolean {
	if (!previous) return true;
	for (const name in previous.logs) {
		if (!Object.hasOwn(previous.logs, name)) continue;
		if (!Object.hasOwn(cursor.logs, name) || cursor.logs[name] < previous.logs[name]) return false;
	}
	return true;
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
