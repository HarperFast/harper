// Deploy pre-flight validation loads throwaway candidate component code purely to surface load-time
// errors — its top-level `server.registerOperation` / `server.setMcpQuotaHandler` calls mutate
// process-wide state (the operation map, its cross-thread announcement, the quota handler) that is
// NOT owned by a Scope, so a failed/rolled-back deploy would otherwise leak the candidate's
// registrations onto the live worker. Those registration methods no-op while this guard is active.
//
// Depth-counted so overlapping validations both keep the guard raised until the last one finishes.
// Caveat: while a validation is in flight, a legitimate registration from an interleaving real load
// is also skipped (it re-registers on its next load); that window is narrow, and the alternative —
// leaking a candidate's registration live — is worse.
let validationDepth = 0;

export function isDeployValidating(): boolean {
	return validationDepth > 0;
}

/** Run `fn` (the throwaway validation load) with the guard raised, lowering it even if `fn` throws. */
export async function runWithDeployValidationGuard<T>(fn: () => Promise<T>): Promise<T> {
	validationDepth++;
	try {
		return await fn();
	} finally {
		validationDepth--;
	}
}
