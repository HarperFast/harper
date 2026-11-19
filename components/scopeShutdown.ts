/**
 * Per-worker registry of in-flight application-scope `close()` promises.
 *
 * On a `harper dev` reload (and any worker shutdown) the worker tears itself down. Some components
 * dispose native runtimes asynchronously — notably @harperfast/vite, whose `scope.close()` awaits
 * Vite's `server.close()` to shut down the rolldown (N-API) bundler runtime. If the worker exits or is
 * terminated while that runtime is still live, the whole process crashes (SIGSEGV/SIGABRT). The worker's
 * shutdown path (`threadServer`) awaits {@link whenScopesClosed} before calling `realExit`, so disposal
 * happens *before* exit.
 *
 * State is module-local, so it is naturally per-worker (each worker is a fresh module realm) and resets
 * with the worker — scopes are created once at load and closed once at shutdown, so nothing accumulates.
 */
import harperLogger from '../utility/logging/harper_logger.ts';
import { settleBeforeDeadline } from '../utility/when.ts';

const closing = new Set<Promise<unknown>>();

/**
 * Track an application scope's `close()` so the worker waits for it before exiting. A close that
 * rejects is logged — never silently swallowed — and treated as settled, so one component's failed
 * cleanup can't wedge shutdown: `whenScopesClosed()` still resolves and the worker exits. (This is the
 * shutdown boundary; there's nowhere useful to propagate to without preventing the exit it must allow.)
 */
export function trackScopeClose(closePromise: Promise<unknown>): void {
	const settled = Promise.resolve(closePromise).catch((error) => {
		harperLogger.error('Error closing application scope during shutdown', error);
	});
	closing.add(settled);
	void settled.finally(() => closing.delete(settled));
}

/** Resolve once every tracked scope close has settled (a no-op when none are in flight). */
export function whenScopesClosed(): Promise<unknown> {
	return Promise.all([...closing]);
}

const deferredCloses = new Set<() => Promise<unknown>>();

/**
 * Close a scope for a SHUTDOWN. A restart runs `close` at once (a caller may make it wait for the scope's load, see
 * {@link closeScopeAfterLoad}). A process exit defers the close to {@link startDeferredScopeCloses}, which the
 * shutdown sequence runs once connections have drained, so a request still in flight keeps the resources its
 * scope owns.
 */
export function closeScopeOnShutdown(close: () => Promise<unknown>, deferUntilServersClose: boolean): void {
	if (deferUntilServersClose) deferredCloses.add(close);
	else trackScopeClose(Promise.resolve().then(close));
}

export function startDeferredScopeCloses(): void {
	for (const close of deferredCloses) trackScopeClose(Promise.resolve().then(close));
	deferredCloses.clear();
}

/**
 * Close a scope once its `handleApplication` load has settled, so what the plugin registers during the load
 * is closed too. A load still pending after `maxWaitMs` is abandoned — a hung plugin must not block shutdown —
 * and anything it registers afterwards stays unclosed. A referenced handle is held until `close()` settles:
 * the load's watchdog is gone by then, and a close awaiting only unref'd native work would otherwise let the
 * worker exit mid-disposal.
 */
export async function closeScopeAfterLoad<T>(
	load: PromiseLike<unknown>,
	close: () => Promise<T>,
	maxWaitMs: number
): Promise<T> {
	const keepAlive = setInterval(() => {}, 60_000);
	try {
		await settleBeforeDeadline([load], Date.now() + maxWaitMs, () => new Error('load still pending')).catch(() =>
			harperLogger.warn?.(`Closing a component scope while its load is still pending after ${maxWaitMs}ms`)
		);
		return await close();
	} finally {
		clearInterval(keepAlive);
	}
}
