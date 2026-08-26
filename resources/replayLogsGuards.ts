// Pure helpers for replayLogs (no Harper module dependencies, so unit tests can load
// them without bootstrapping the full Resource / RocksDB / DatabaseTransaction graph).
//
// Background: a node that crashed unclean re-runs replayLogs against the unflushed audit
// log on next boot. If any audit entry is corrupt or missing its record body, the loop
// hits a TypeError inside Table.validate() ("Cannot read properties of undefined
// (reading 'cacheKey')") and the per-iteration catch swallows it — but the loop keeps
// running over potentially millions of entries, pinning CPU. These guards classify each
// entry up front so the loop can skip cleanly.

// Mirrors `HAS_RECORD` (16) | `HAS_PARTIAL_RECORD` (32) from auditStore.ts — the action
// bits the writer sets when an entry carries (or should carry) a record body. Redeclared
// here so this module stays free of the Harper module graph for unit testing; a lock
// test pins the value against auditStore so silent drift is caught.
export const RECORD_BEARING_FLAGS = 16 | 32;

/**
 * Decide whether an audit entry pulled from the unflushed log is safe to replay.
 * Returns `null` if the entry should be replayed, or a short reason string if it should
 * be skipped (the loop logs the aggregate skip count once at the end).
 *
 * Operates on the raw integer `action` field rather than the decoded type string: when
 * `readAuditEntry` catches a header decode error it returns `{}`, so both `action` and
 * `tableId` are `undefined` — the same signal — and matching the record-bearing flags
 * directly against the action mirrors how the writer set them in `auditStore.ts`.
 *
 * @param action      `auditRecord.extendedType` — the variable-length action field with
 *                    the event type in the low nibble and HAS_* flags above it
 * @param tableId     `auditRecord.tableId`
 * @param hasRecord   `true` if `auditRecord.getValue(...)` produced a non-undefined value
 */
export function classifyAuditEntryForReplay(
	action: number | undefined,
	tableId: number | undefined,
	hasRecord: boolean
): 'corrupt-header' | 'missing-record' | null {
	if (action === undefined || tableId === undefined) return 'corrupt-header';
	// If the action advertises a record body but the decoded record is undefined, the
	// downstream write path will crash inside validate() on the first attribute deref.
	if ((action & RECORD_BEARING_FLAGS) !== 0 && !hasRecord) return 'missing-record';
	return null;
}

/**
 * Whether an audit entry runs `validate()` during replay but its record body failed to decode,
 * and so must be skipped.
 *
 * `RecordEncoder.decode` returns `null` (not `undefined`, and it does not throw) when a value
 * fails to decode — e.g. structure-dictionary divergence, which surfaces as msgpackr's
 * "Data read, but end of buffer not reached". `classifyAuditEntryForReplay` only catches a
 * `undefined` body, so a `null` slips through; the replay path then calls `validate()`, which
 * dereferences the record and crashes on the missing body.
 *
 * Scoped to the actions whose replay reaches `validate()`: `put`/`patch` (via `_writeUpdate` →
 * `save()`) and `message` (via `_writePublish` → `transaction.addWrite` → `save()`; the publish
 * `validate` hook fires whenever the replay context has no `source`, which it never does). Other
 * record-bearing actions must NOT be skipped on a `null` body — notably `invalidate`, which
 * legitimately stores a `null` partial record on a table with no index fields and never reaches
 * `validate()`; `relocate`/`delete` ignore the body entirely. See harper#1255.
 */
export function isUndecodableValidatedWrite(type: string | undefined, record: unknown): boolean {
	return record == null && (type === 'put' || type === 'patch' || type === 'message');
}

// A node that crashed unclean replays its unflushed audit backlog on boot. When that backlog is
// dominated by entries that can't be written — undecodable values (the #1163 structure-dictionary
// divergence), corrupt headers, or entries for a dropped table — every iteration makes no forward
// progress. A large enough backlog then grinds the main thread for minutes with zero progress,
// blocking startup entirely (harper#1266). These bounds let replay give up on a run that is making
// no progress so boot can proceed; the operator then sheds/relocates the offending peer log (or
// re-clones). They are deliberately conservative: a healthy replay produces writes, which reset
// the progress tracking, so neither bound can trip on it.

// Max consecutive no-progress entries (since the last successful write) before the replay is
// treated as stalled. ~100k contiguous unwritable entries is unambiguously degenerate and caps the
// wasted grind well below the multi-minute hangs observed in prod.
export const REPLAY_NO_PROGRESS_COUNT_LIMIT = 100_000;

// Max wall-clock time (ms) since the last successful write before the replay is treated as stalled.
// Belt-and-suspenders for the count bound: if individual entries are slow enough that fewer than the
// count limit still burns minutes, this still bounds the hang.
export const REPLAY_NO_PROGRESS_TIME_LIMIT_MS = 60_000;

// The time bound only applies once a substantial no-progress run has built up. Without this floor a
// single skipped entry followed by an unrelated latency spike (a GC pause, disk throttling, one
// slow write) would trip the time bound and abort an otherwise-healthy replay; requiring a real run
// of no-progress entries keeps the time bound a signal of a genuine grind, not a transient stall.
export const REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR = 1_000;

/**
 * Whether boot replay should abort because it is making no forward progress — a backlog of
 * unwritable entries (undecodable/corrupt, or for a dropped table) that produces no writes
 * (harper#1266). Returns `true` once the contiguous run of no-progress entries since the last
 * successful write crosses the count bound, or once it has both built up past the time-skip floor
 * AND burned the time bound. All inputs are measured since the last write, so a productive replay
 * (which keeps resetting them) never trips this; only a genuinely stalled, write-free grind does.
 *
 * @param noProgressRun   consecutive entries processed without a successful write
 * @param msSinceProgress wall-clock ms elapsed since the last successful write
 */
export function shouldAbortStalledReplay(
	noProgressRun: number,
	msSinceProgress: number,
	countLimit = REPLAY_NO_PROGRESS_COUNT_LIMIT,
	timeLimitMs = REPLAY_NO_PROGRESS_TIME_LIMIT_MS,
	timeSkipFloor = REPLAY_NO_PROGRESS_TIME_SKIP_FLOOR
): boolean {
	if (noProgressRun >= countLimit) return true;
	return noProgressRun >= timeSkipFloor && msSinceProgress >= timeLimitMs;
}

// Maximum total wall-clock time (ms) that replay is allowed to run, even when individual writes
// are succeeding. A slow-but-progressing replay (issue #1316, facet a) can peg the boot thread
// for an unbounded time without tripping shouldAbortStalledReplay, which resets its counters on
// every successful write. This bound fires regardless of progress once the total elapsed time is
// hit. Ten minutes is deliberately generous — a healthy replay of a large backlog completes in
// seconds to low minutes; anything exceeding this is a pathological replay that the operator must
// resolve by re-cloning the node.
export const REPLAY_WALL_CLOCK_LIMIT_MS = 10 * 60 * 1000;

/**
 * Whether boot replay should abort because it has exceeded the total wall-clock time limit, even
 * if individual writes are succeeding (issue #1316, facet a). Unlike shouldAbortStalledReplay,
 * this fires regardless of forward progress — it is the safety net for a slow-but-progressing
 * replay (e.g. a deep out-of-order audit chain walk per entry) that would otherwise peg the boot
 * thread indefinitely.
 *
 * @param totalElapsedMs wall-clock ms elapsed since replay began
 */
export function shouldAbortSlowReplay(totalElapsedMs: number, timeLimitMs = REPLAY_WALL_CLOCK_LIMIT_MS): boolean {
	return totalElapsedMs >= timeLimitMs;
}

/**
 * A corrupt transaction-log frame from rocksdb-js. `resyncPosition` is set only when intact entries
 * follow the break, which is what distinguishes lost entries from a merely truncated tail; its
 * absence is also all that any rocksdb-js predating that field can report.
 */
export type CorruptFrameError = RangeError & {
	logId?: number | null;
	position?: number | null;
	resyncPosition?: number | null;
	unreadableBytes?: number | null;
};

/**
 * Corrupt frames hit by one `getRange` call, shared by its per-log iterators.
 *
 * `truncatedVersions` is what a consumer has to act on: a break destroys the framing after the last
 * entry the broken log yielded, and whether the entries it swallowed continued that entry's version
 * is exactly what can no longer be read. That version's transaction is therefore incomplete, and
 * replay must discard it rather than commit the part of it that was still readable. A log that
 * broke before yielding anything truncates no transaction. Only an aggregate range attributes
 * versions; a single-log range reports the count alone.
 */
export interface CorruptFrameStop {
	breaks: number;
	truncatedVersions: Set<number>;
}

/**
 * Wraps a transaction-log query iterator so a corrupt/torn frame ends that log's iteration cleanly
 * instead of escaping as an uncaughtException.
 *
 * Iteration stops at the break whether or not intact entries follow it. Resuming past a mid-log
 * break would recover those entries, but a transaction log carries no frame-level transaction
 * boundaries: replay groups equal-version entries into one source transaction, so skipping a frame
 * inside such a group applies and checkpoints the surviving subset of a transaction that never
 * committed that way at the source. Availability loss is visible and recoverable; a silently torn
 * transaction is neither. Recovery is deferred until the engine can resume at a proven boundary
 * (harper#2016, harper#2063); `resyncPosition` is used only to report the break as lost entries
 * rather than as a truncated tail.
 */
export function endIteratorOnCorruptFrame<T>(
	iterator: Iterator<T>,
	onCorruptFrame: (error: CorruptFrameError) => void
): IterableIterator<T> {
	let stopped = false;
	return {
		[Symbol.iterator]() {
			return this;
		},
		next(): IteratorResult<T> {
			if (stopped) return { done: true, value: undefined };
			try {
				return iterator.next();
			} catch (error) {
				// Key on the class, not the message: the framing RangeError's wording is
				// version-dependent (1.4.2 added hex offsets). Anything else re-throws.
				if (!(error instanceof RangeError)) throw error;
				stopped = true;
				onCorruptFrame(error as CorruptFrameError);
				return { done: true, value: undefined };
			}
		},
		// Forward early termination (for-of break/return/throw) so the source's cleanup runs;
		// mark stopped first. Current rocksdb-js implements neither — hence the protocol defaults.
		return(value?: any): IteratorResult<T> {
			stopped = true;
			if (typeof iterator.return === 'function') return iterator.return(value);
			return { done: true, value };
		},
		throw(error?: any): IteratorResult<T> {
			stopped = true;
			if (typeof iterator.throw === 'function') return iterator.throw(error);
			throw error;
		},
	};
}

/**
 * A corrupt frame, accumulated for the life of the process. The same frame is re-encountered by
 * every reader until each consumer's resume cursor has passed it, so this is deduplicated by
 * location and the repeats become a count.
 */
export interface CorruptFrameReport {
	log: string;
	logId?: number;
	position?: number;
	/** Intact entries followed the break, so entries were lost rather than merely truncated. */
	midLog: boolean;
	/** Extent of the unreadable region, when the engine reports it; 0 when nothing valid follows it. */
	unreadableBytes: number;
	firstSeen: number;
	lastSeen: number;
	occurrences: number;
}

/** Distinct break sites retained. One physical corruption yields one site, so this is generous. */
export const MAX_CORRUPT_FRAME_REPORTS = 256;

// Re-encounters move a site to the end, so the first key is the least recently seen. Full means
// evicting that one rather than refusing a new site, which could not then be deduplicated.
const corruptFrameReports = new Map<string, CorruptFrameReport>();
let evictedCorruptFrameReports = 0;

/**
 * Every corrupt frame seen by this worker. This is not yet consumed by cluster/health status;
 * callers must aggregate it across worker threads before exposing a node-wide signal.
 *
 * Mid-log breaks are immediately logged at error level even without that consumer.
 */
export function getCorruptFrameReports(): CorruptFrameReport[] {
	return [...corruptFrameReports.values()];
}

/** Break sites evicted because {@link MAX_CORRUPT_FRAME_REPORTS} was reached. */
export function getEvictedCorruptFrameReportCount(): number {
	return evictedCorruptFrameReports;
}

export function clearCorruptFrameReports() {
	corruptFrameReports.clear();
	evictedCorruptFrameReports = 0;
}

// `logId`/`position` are absent on any rocksdb-js predating the resync support, and every break on
// a stream would then collapse onto one key — folding genuinely different corruptions into a single
// count that only ever logs once. The message carries the offset and file in text, so it separates
// them when the fields can't.
function corruptFrameKey(logName: string, error: CorruptFrameError): string {
	const { logId, position } = error;
	return logId != null && position != null
		? `${logName}\u0000${logId}:${position}`
		: `${logName}\u0000${error.message}`;
}

/**
 * Records a corrupt frame and logs it once per distinct break.
 *
 * A mid-log break is an `error`, not a `warn`: entries after it were acknowledged and are now
 * quarantined behind it. Severity follows the break's own shape, never this pass's outcome — every
 * pass stops, so keying on that would report the #2063 signature with the benign torn-tail `warn`.
 * A site first seen as a torn tail can escalate later, since only a rocksdb-js that reports
 * `resyncPosition` can tell the two apart.
 */
export function createCorruptFrameReporter(logger: {
	warn: (message: string, error?: unknown) => void;
	error: (message: string, error?: unknown) => void;
}) {
	return (logName: string) => (error: CorruptFrameError) => {
		const midLog = error.resyncPosition != null;
		const unreadableBytes = error.unreadableBytes ?? 0;
		const now = Date.now();
		const key = corruptFrameKey(logName, error);
		const existing = corruptFrameReports.get(key);
		if (existing) {
			corruptFrameReports.delete(key);
			corruptFrameReports.set(key, existing);
			existing.occurrences++;
			existing.lastSeen = now;
			if (!midLog || existing.midLog) return;
			existing.midLog = true;
			existing.unreadableBytes = unreadableBytes;
		} else {
			if (corruptFrameReports.size >= MAX_CORRUPT_FRAME_REPORTS) {
				corruptFrameReports.delete(corruptFrameReports.keys().next().value);
				evictedCorruptFrameReports++;
			}
			corruptFrameReports.set(key, {
				log: logName,
				logId: error.logId ?? undefined,
				position: error.position ?? undefined,
				midLog,
				unreadableBytes,
				firstSeen: now,
				lastSeen: now,
				occurrences: 1,
			});
		}
		if (midLog) {
			logger.error(
				`Corrupt entry in transaction log "${logName}"; ${unreadableBytes} byte(s) are unreadable and the entries within them are lost. ` +
					'Intact entries follow the break, but reading stops there rather than skipping the frame, which could tear a source transaction: ' +
					'they are quarantined until the log is repaired or this node is re-cloned, and they are neither replayed nor replicated meanwhile.',
				error
			);
		} else {
			logger.warn(`Stopping transaction log "${logName}" at a corrupt entry during replay`, error);
		}
	};
}
