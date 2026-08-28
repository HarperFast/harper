/**
 * Which operation a history entry should report: the originating operation when one was recorded,
 * otherwise the physical write type.
 *
 * A recorded `put` is reported as `put`, so replication catch-up replays it as a replace. Only a
 * LEGACY physical put — one with no originating operation, written before `put` was assigned an id
 * in `resources/auditStore.ts` — is still normalized to `upsert`, which is what produced a physical
 * put back then. Normalizing both would make catch-up patch the replica and retain attributes the
 * source removed.
 *
 * Standalone so the legacy fallback can be tested directly: through the operations API every write
 * now records an originating operation, so the fallback is unreachable from an integration probe and
 * a test that went via the API would assert nothing about it.
 */
export function normalizeHistoryOperation(originatingOperation?: string, physicalType?: string) {
	if (originatingOperation !== undefined) return originatingOperation;
	return physicalType === 'put' ? 'upsert' : physicalType;
}
