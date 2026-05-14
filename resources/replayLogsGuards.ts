// Pure helpers for replayLogs (no Harper module dependencies, so unit tests can load
// them without bootstrapping the full Resource / RocksDB / DatabaseTransaction graph).
//
// Background: a node that crashed unclean re-runs replayLogs against the unflushed audit
// log on next boot. If any audit entry is corrupt or missing its record body, the loop
// hits a TypeError inside Table.validate() ("Cannot read properties of undefined
// (reading 'cacheKey')") and the per-iteration catch swallows it — but the loop keeps
// running over potentially millions of entries, pinning CPU. These guards classify each
// entry up front so the loop can skip cleanly.

// Types whose replay requires a decoded record value. Missing records on any of these
// crashes inside validate() on the first attribute dereference.
export const REQUIRES_RECORD = new Set(['put', 'patch', 'message', 'invalidate']);

/**
 * Returns `null` if the entry is safe to replay, or a short reason string otherwise.
 *
 * @param type        `auditRecord.type` — `undefined` when readAuditEntry caught a header decode error
 * @param tableId     `auditRecord.tableId` — `undefined` for the same reason
 * @param hasRecord   `true` if `auditRecord.getValue(...)` produced a non-undefined value
 */
export function classifyAuditEntryForReplay(
	type: string | undefined,
	tableId: number | undefined,
	hasRecord: boolean
): 'corrupt-header' | 'missing-record' | null {
	if (type === undefined || tableId === undefined) return 'corrupt-header';
	if (REQUIRES_RECORD.has(type) && !hasRecord) return 'missing-record';
	return null;
}
