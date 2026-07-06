/**
 * Per-worker registry of graceful "drain before shutdown" hooks.
 *
 * On a worker restart (deploy reload, `harper dev` reload, rolling restart) the worker is told to shut
 * down while it may still be doing work that is cheaper to finish than to interrupt — notably a
 * replication blob *send* streaming to a peer. Tearing that down mid-stream makes the peer receiver
 * treat the blob as diverged until it is re-requested. A registered drain lets that work reach a safe
 * point (finish, or stall) before the worker stops accepting connections and exits.
 *
 * Core stays deliberately generic here — it knows nothing about blobs or replication. A component
 * (harper-pro replication) registers a {@link ShutdownDrain}; the worker shutdown path
 * ({@link server/threads/threadServer}) awaits {@link runShutdownDrains} before `closeServers`, and
 * extends its termination backstops (see manageThreads `extendShutdownDeadline`) only while
 * {@link shutdownDrainsHaveWork} reports real in-flight work — so a worker that hangs for an unrelated
 * reason is still force-killed on the normal short timeout.
 *
 * State is module-local, so it is naturally per-worker (each worker is a fresh module realm).
 */
import harperLogger from '../utility/logging/harper_logger.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

/** Absolute cap (ms) on how long a drain may hold the worker's shutdown open. */
const DEFAULT_DRAIN_CEILING_MS = 600_000; // 10 minutes
/** Largest delay a Node timer accepts; a larger value overflows and fires ~immediately. */
const MAX_TIMER_MS = 2_147_483_647; // 2^31 - 1

/**
 * The configured drain ceiling in ms. Config values can arrive as strings from YAML / HARPER_CONFIG,
 * so coerce; but treat blank/null/empty as "unset" and fall back to the default (a blank config must
 * not read as `Number('') === 0`, which would silently disable the drain). Clamp to the max timer
 * value so a huge misconfig can't overflow setTimeout. Used both to size the drain deadline and to cap
 * the main thread's force-terminate extension. An explicit `0` still disables draining.
 */
export function getShutdownDrainCeilingMs(): number {
	const raw = env.get(CONFIG_PARAMS.REPLICATION_BLOBSENDDRAINTIMEOUT);
	if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_DRAIN_CEILING_MS;
	const ms = Number(raw);
	return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_DRAIN_CEILING_MS;
}

/**
 * Compute a force-terminate timer delay for a worker-requested drain deadline. Clamps the requested
 * absolute `deadlineMs` to `now + ceilingMs` (so a buggy/rogue worker message can't defer the kill
 * unboundedly) and to a finite value (a non-finite deadline falls back to `now`, i.e. no extension),
 * then adds `baseMs` of normal shutdown headroom. A shrink (e.g. the drain-done reset posting a
 * now-deadline) passes through untouched. Pure so the clamp/guard arithmetic is directly testable.
 */
export function boundedTerminateDelay(deadlineMs: number, now: number, baseMs: number, ceilingMs: number): number {
	const target = Number.isFinite(deadlineMs) ? deadlineMs : now;
	const bounded = Math.min(target, now + ceilingMs);
	return Math.max(0, bounded - now) + baseMs;
}

export interface ShutdownDrain {
	/** Synchronous, cheap: is there in-flight work worth draining right now? Drives deadline extension. */
	hasWork(): boolean;
	/**
	 * Resolve once this hook's in-flight work has finished, stalled, or the absolute deadline has
	 * passed. `deadlineMs` is an epoch timestamp (same clock as `Date.now()`); the hook must not run
	 * past it.
	 */
	drain(deadlineMs: number): Promise<void>;
}

const drains = new Set<ShutdownDrain>();

/** Register a drain hook. Returns an unregister function. */
export function registerShutdownDrain(drain: ShutdownDrain): () => void {
	drains.add(drain);
	return () => drains.delete(drain);
}

/** Whether any registered hook currently has in-flight work worth draining (and extending the backstops for). */
export function shutdownDrainsHaveWork(): boolean {
	for (const drain of drains) {
		try {
			if (drain.hasWork()) return true;
		} catch (error) {
			harperLogger.error('Error checking shutdown drain for work', error);
		}
	}
	return false;
}

/**
 * Run every registered drain, resolving when all have settled or the absolute deadline is reached —
 * whichever comes first. Never rejects: a drain that throws or rejects is logged and treated as
 * settled, and a drain that ignores the deadline is abandoned (the process is exiting immediately
 * after), so this can never wedge the shutdown sequence that follows.
 */
export async function runShutdownDrains(deadlineMs: number): Promise<void> {
	if (drains.size === 0) return;
	const settled = [...drains].map((drain) =>
		Promise.resolve()
			.then(() => drain.drain(deadlineMs))
			.catch((error) => harperLogger.error('Error draining before shutdown', error))
	);
	const remaining = Math.max(0, deadlineMs - Date.now());
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		Promise.all(settled),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, remaining);
			timer.unref();
		}),
	])
		.catch((error) => harperLogger.error('Error running shutdown drains', error))
		.finally(() => {
			if (timer) clearTimeout(timer);
		});
}
