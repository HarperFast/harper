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
