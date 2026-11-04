import { table, isReadOnlyMode } from '../databases.ts';
import { contextStorage, transaction } from '../transaction.ts';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

const log = harperLogger.forComponent('models').conditional;

const DEFAULT_FLUSH_INTERVAL_MS = 10_000; // 10s
const DEFAULT_MAX_BUFFER_SIZE = 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
// 90-day default tuned for billing windows.
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * One row in `hdb_model_calls`. Field names are snake_case to match the table
 * schema. Numeric token counts are optional because not every backend reports
 * every metric.
 */
export interface ModelCallRecord {
	tenant?: string;
	app?: string;
	model?: string;
	backend: string;
	method: 'embed' | 'generate' | 'generateStream' | 'decide' | 'scoreChoices';
	adapter?: string;
	conversation_id?: string;
	prompt_tokens?: number;
	completion_tokens?: number;
	embedding_tokens?: number;
	gpu_ms?: number;
	latency_ms: number;
	success: boolean;
	/** Sanitized code (e.g. 'backend_error', 'aborted', 'capability_unsupported'). Never a raw upstream message. */
	error_code?: string;
}

interface BufferedRecord extends ModelCallRecord {
	id: number;
}

let _table: any;

/**
 * Schema attributes for `hdb_model_calls`. Exported so tests can assert on
 * the structural shape (e.g. no spurious `indexed: true`) without parsing
 * TypeScript source.
 *
 * Retention cleanup removes primary rows directly, so secondary indexes would retain stale entries.
 * Match hdb_raw_analytics by keeping this local telemetry table unindexed and unaudited.
 */
export const MODEL_CALL_ATTRIBUTES = [
	{ name: 'id', isPrimaryKey: true },
	{ name: 'tenant', type: 'string' },
	{ name: 'app', type: 'string' },
	{ name: 'model', type: 'string' },
	{ name: 'backend', type: 'string' },
	{ name: 'method', type: 'string' },
	{ name: 'adapter', type: 'string' },
	{ name: 'conversation_id', type: 'string' },
	{ name: 'prompt_tokens', type: 'number' },
	{ name: 'completion_tokens', type: 'number' },
	{ name: 'embedding_tokens', type: 'number' },
	{ name: 'gpu_ms', type: 'number' },
	{ name: 'latency_ms', type: 'number' },
	{ name: 'success', type: 'boolean' },
	{ name: 'error_code', type: 'string' },
];

/**
 * Lazy-getter for `hdb_model_calls`. Matches the convention used by
 * `getRawAnalyticsTable()` / `getAnalyticsTable()` in
 * `resources/analytics/write.ts:656-700` and the system-table declarations in
 * `server/DurableSubscriptionsSession.ts:14-50`.
 */
export function getModelCallsTable(): any {
	if (_table) return _table;
	_table = table({
		table: 'hdb_model_calls',
		database: 'system',
		audit: false,
		trackDeletes: false,
		attributes: MODEL_CALL_ATTRIBUTES,
	});
	return _table;
}

export interface ModelCallAnalyticsWriterOpts {
	/** Default 10s. Buffer is flushed at this cadence regardless of size. */
	flushIntervalMs?: number;
	/** Default 1000. Batch and waiting-buffer limit; excess rows are dropped and reported. */
	maxBufferSize?: number;
	/** Default 1h. How often `cleanup()` runs to remove expired rows. */
	cleanupIntervalMs?: number;
	/** Default 90d. Rows older than this are removed by `cleanup()`. */
	retentionMs?: number;
	/** Override the table accessor. Tests inject a mock to avoid touching real LMDB. */
	getTable?: () => any;
}

/**
 * In-memory buffered writer for per-call model analytics. Rows are batched and
 * flushed periodically (or scheduled when full) to keep the analytics path
 * off the hot model-call path. Shape mirrors the pattern in
 * `resources/analytics/write.ts` but writes per-call rows rather than
 * aggregating counters.
 *
 * The intervals are `.unref()`ed so they never hold the process open during
 * shutdown; rows buffered at shutdown are dropped (best-effort, same posture
 * as the existing analytics writer).
 */
export class ModelCallAnalyticsWriter {
	#buffer: BufferedRecord[] = [];
	#flushTimer?: NodeJS.Timeout;
	#cleanupTimer?: NodeJS.Timeout;
	#maxBufferSize: number;
	#retentionMs: number;
	#getTable: () => any;
	#stopped = false;
	#flushPromise?: Promise<void>;
	#flushImmediate?: NodeJS.Immediate;
	#scheduledResolve?: () => void;
	#lastAdmittedId = 0;
	#attemptedThrough = 0;
	#dropped = 0;
	#runScheduled = () => {
		this.#flushImmediate = undefined;
		const resolve = this.#scheduledResolve;
		this.#scheduledResolve = undefined;
		resolve?.();
	};

	constructor(opts: ModelCallAnalyticsWriterOpts = {}) {
		const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		const cleanupIntervalMs = opts.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
		this.#maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
		this.#retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
		this.#getTable = opts.getTable ?? getModelCallsTable;
		if (!Number.isSafeInteger(this.#maxBufferSize) || this.#maxBufferSize <= 0)
			throw new RangeError('maxBufferSize must be a positive safe integer');
		contextStorage.exit(() => {
			this.#flushTimer = setInterval(() => {
				this.#reportDropped();
				this.#scheduleFlush();
			}, flushIntervalMs);
			this.#flushTimer.unref?.();
			this.#cleanupTimer = setInterval(() => {
				this.cleanup().catch((err) => log.warn?.(`Model-call analytics cleanup failed: ${err?.message ?? err}`));
			}, cleanupIntervalMs);
			this.#cleanupTimer.unref?.();
		});
	}

	write(record: ModelCallRecord): number {
		const id = getNextMonotonicTime();
		if (this.#stopped) return id;
		if (this.#buffer.length >= this.#maxBufferSize) {
			this.#dropped++;
			return id;
		}
		// id last so a record that accidentally carries an `id` field can't override
		// the monotonic primary key.
		this.#buffer.push({ ...record, id });
		this.#lastAdmittedId = id;
		if (this.#buffer.length >= this.#maxBufferSize) this.#scheduleFlush();
		return id;
	}

	async flush(): Promise<void> {
		const target = this.#lastAdmittedId;
		while (this.#attemptedThrough < target) {
			this.#flushImmediate?.ref?.();
			await (this.#flushPromise ?? this.#startBatch(false));
		}
	}

	#scheduleFlush(): void {
		if (!this.#stopped && !this.#flushPromise && this.#buffer.length) this.#startBatch(true);
	}

	#startBatch(defer: boolean): Promise<void> {
		return contextStorage.exit(() => {
			const batch = this.#buffer;
			this.#buffer = [];
			const ready = defer
				? new Promise<void>((resolve) => {
						this.#scheduledResolve = resolve;
						this.#flushImmediate = setImmediate(this.#runScheduled);
						this.#flushImmediate.unref?.();
					})
				: Promise.resolve();
			const pending = ready
				.then(() => this.#writeBatch(batch))
				.finally(() => {
					this.#attemptedThrough = batch[batch.length - 1].id;
					this.#flushPromise = undefined;
					this.#reportDropped();
					if (this.#buffer.length >= this.#maxBufferSize) this.#scheduleFlush();
				});
			this.#flushPromise = pending;
			// Automatic batches are already logged; explicit flush callers still receive the rejection.
			pending.catch(() => {});
			return pending;
		});
	}

	#reportDropped(): void {
		if (!this.#dropped) return;
		const dropped = this.#dropped;
		this.#dropped = 0;
		log.warn?.('Model-call analytics waiting buffer full; records dropped', { dropped });
	}

	async #writeBatch(batch: BufferedRecord[]): Promise<void> {
		// A flush must not join the request that filled the buffer or created the timer.
		try {
			if (isReadOnlyMode()) return;
			const tbl = this.#getTable();
			await transaction({}, async (txn) => {
				const puts: Array<{ id: number; promise: Promise<unknown> }> = [];
				for (const record of batch) {
					try {
						const result = tbl.put(record, txn);
						if (result && typeof (result as { then?: unknown }).then === 'function') {
							puts.push({ id: record.id, promise: result as Promise<unknown> });
						}
					} catch (err) {
						log.warn?.(`Model-call analytics put failed for id=${record.id}: ${(err as Error)?.message ?? err}`);
					}
				}
				if (puts.length > 0) {
					const results = await Promise.allSettled(puts.map((p) => p.promise));
					for (let i = 0; i < results.length; i++) {
						const r = results[i];
						if (r.status === 'rejected') {
							const reason = r.reason as { message?: string } | undefined;
							log.warn?.(`Model-call analytics async put failed for id=${puts[i].id}: ${reason?.message ?? r.reason}`);
						}
					}
				}
			});
		} catch (error) {
			log.warn?.(
				'Model-call analytics batch commit failed',
				{
					batchSize: batch.length,
					firstId: batch[0].id,
					lastId: batch[batch.length - 1].id,
				},
				error
			);
			throw error;
		}
	}

	async cleanup(): Promise<void> {
		if (isReadOnlyMode()) return;
		const end = Date.now() - this.#retentionMs;
		const tbl = this.#getTable();
		for (const key of tbl.primaryStore.getKeys({ start: false, end })) {
			tbl.primaryStore.remove(key);
		}
	}

	/** Stop the periodic timers. After stop, `write()` is a no-op and `flush()` still works. */
	stop(): void {
		this.#stopped = true;
		if (this.#flushTimer) clearInterval(this.#flushTimer);
		if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
	}

	/** Test-only: inspect current buffer size without flushing. */
	get bufferSize(): number {
		return this.#buffer.length;
	}
}

let _writer: ModelCallAnalyticsWriter | undefined;
/** Process-wide singleton writer. Constructed on first access. */
export function getModelCallAnalyticsWriter(): ModelCallAnalyticsWriter {
	if (!_writer) _writer = new ModelCallAnalyticsWriter();
	return _writer;
}
