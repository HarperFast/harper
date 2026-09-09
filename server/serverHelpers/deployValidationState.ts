import { AsyncLocalStorage } from 'node:async_hooks';

import type { ComponentStatus } from '../../components/status/ComponentStatus.ts';

// Deploy pre-flight validation loads throwaway candidate component code purely to surface load-time
// errors — its top-level `server.registerOperation` / `server.setMcpQuotaHandler` calls mutate
// process-wide state (the operation map, its cross-thread announcement, the quota handler) that is
// NOT owned by a Scope, so a failed/rolled-back deploy would otherwise leak the candidate's
// registrations onto the live worker. Those registration methods no-op while this guard is active,
// and the candidate's component-status writes are diverted into the throwaway sink below.
//
// Context-scoped rather than a process-wide depth counter, because the live component KEEPS SERVING on
// this worker throughout the window and writes to both of those same places: it registers on its own
// reload, and `statusForComponent()` is a public API its runtime code may call at any time. A counter
// cannot tell the two writers apart, so it suppressed the live component's registration and reverted its
// status report. An async context can: only work descending from the validation load itself is diverted.
interface DeployValidationContext {
	// Where the candidate's own status writes land instead of the live registry. Discarded with the context.
	statusSink: Map<string, ComponentStatus>;
}

const deployValidation = new AsyncLocalStorage<DeployValidationContext>();

export function isDeployValidating(): boolean {
	return deployValidation.getStore() !== undefined;
}

/** The throwaway map a candidate's status writes belong in, or `undefined` outside a validation load. */
export function deployValidationStatusSink(): Map<string, ComponentStatus> | undefined {
	return deployValidation.getStore()?.statusSink;
}

/** Run `fn` (the throwaway validation load) with the guard raised, lowering it even if `fn` throws. */
export async function runWithDeployValidationGuard<T>(fn: () => Promise<T>): Promise<T> {
	return deployValidation.run({ statusSink: new Map() }, fn);
}
