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

/**
 * Wraps a transaction-log query iterator so a corrupt/torn frame ends that log's iteration
 * cleanly instead of escaping as an uncaughtException. rocksdb-js throws a bounded RangeError
 * when an entry's framing is broken; framing loss means the next entry can't be located, so the
 * frame marks end-of-log (entries before it were already yielded) and startup replay /
 * replication broadcast continue. `onCorruptFrame` fires once, latched — kept a callback (not a
 * direct log) so this module stays out of the Harper module graph and is unit-testable.
 */
export function endIteratorOnCorruptFrame<T>(
	iterator: Iterator<T>,
	onCorruptFrame: (error: RangeError) => void
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
				onCorruptFrame(error);
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
