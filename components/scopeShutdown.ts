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
const closing = new Set<Promise<unknown>>();

/** Track an application scope's `close()` so the worker waits for it before exiting. Never rejects. */
export function trackScopeClose(closePromise: Promise<unknown>): void {
	const settled = Promise.resolve(closePromise).catch(() => {});
	closing.add(settled);
	void settled.finally(() => closing.delete(settled));
}

/** Resolve once every tracked scope close has settled (a no-op when none are in flight). */
export function whenScopesClosed(): Promise<unknown> {
	return Promise.allSettled([...closing]);
}
