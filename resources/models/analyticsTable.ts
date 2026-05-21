import { table, isReadOnlyMode } from '../databases.ts';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

const log = harperLogger.forComponent('models').conditional;

const DEFAULT_FLUSH_INTERVAL_MS = 10_000; // 10s
const DEFAULT_MAX_BUFFER_SIZE = 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
// 90-day default tuned for billing windows. Operator-tunable config key will land
// in Phase 2 alongside the YAML→registry bootstrapper (Harper's `getConfigValue`
// only reads keys registered in `CONFIG_PARAM_MAP`, so we defer config plumbing
// until the first real backend ships and the key has a documented owner).
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
	method: 'embed' | 'generate' | 'generateStream';
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
		audit: true,
		trackDeletes: false,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'tenant', type: 'string', indexed: true },
			{ name: 'app', type: 'string', indexed: true },
			{ name: 'model', type: 'string', indexed: true },
			{ name: 'backend', type: 'string', indexed: true },
			{ name: 'method', type: 'string', indexed: true },
			{ name: 'adapter', type: 'string', indexed: true },
			{ name: 'conversation_id', type: 'string', indexed: true },
			{ name: 'prompt_tokens', type: 'number' },
			{ name: 'completion_tokens', type: 'number' },
			{ name: 'embedding_tokens', type: 'number' },
			{ name: 'gpu_ms', type: 'number' },
			{ name: 'latency_ms', type: 'number', indexed: true },
			{ name: 'success', type: 'boolean', indexed: true },
			{ name: 'error_code', type: 'string' },
		],
	});
	return _table;
}

export interface ModelCallAnalyticsWriterOpts {
	/** Default 10s. Buffer is flushed at this cadence regardless of size. */
	flushIntervalMs?: number;
	/** Default 1000. Reaching this size triggers an out-of-cadence flush. */
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
 * flushed periodically (or when the buffer is full) to keep the analytics path
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

	constructor(opts: ModelCallAnalyticsWriterOpts = {}) {
		const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		const cleanupIntervalMs = opts.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
		this.#maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
		this.#retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
		this.#getTable = opts.getTable ?? getModelCallsTable;
		this.#flushTimer = setInterval(() => {
			this.flush().catch((err) => log.warn?.(`Model-call analytics flush failed: ${err?.message ?? err}`));
		}, flushIntervalMs);
		this.#flushTimer.unref?.();
		this.#cleanupTimer = setInterval(() => {
			this.cleanup().catch((err) => log.warn?.(`Model-call analytics cleanup failed: ${err?.message ?? err}`));
		}, cleanupIntervalMs);
		this.#cleanupTimer.unref?.();
	}

	write(record: ModelCallRecord): void {
		if (this.#stopped) return;
		// id last so a record that accidentally carries an `id` field can't override
		// the monotonic primary key.
		this.#buffer.push({ ...record, id: getNextMonotonicTime() });
		if (this.#buffer.length >= this.#maxBufferSize) {
			// Out-of-cadence flush; swallow errors so a failing flush doesn't escape into the caller.
			this.flush().catch((err) => log.warn?.(`Model-call analytics flush failed: ${err?.message ?? err}`));
		}
	}

	async flush(): Promise<void> {
		if (this.#buffer.length === 0) return;
		// Read-only nodes (followers, recovery mode) shouldn't accumulate doomed writes —
		// drop the buffer and skip. Matches `resources/analytics/write.ts:643-650`.
		if (isReadOnlyMode()) {
			this.#buffer = [];
			return;
		}
		const batch = this.#buffer;
		this.#buffer = [];
		const tbl = this.#getTable();
		const puts: Array<{ id: number; promise: Promise<unknown> }> = [];
		for (const record of batch) {
			try {
				const result = tbl.primaryStore.put(record.id, record);
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
