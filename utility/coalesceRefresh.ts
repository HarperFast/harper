/**
 * Wraps `refresh` so at most one run is in flight. Calls made while one runs share a single trailing
 * run that starts once it settles, so each caller resolves after a run that started after its call.
 * Joining the in-flight run instead could resolve a caller with state read before its own write.
 */
export function coalesceRefresh(refresh: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | undefined;
	let queued: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | undefined;
	const start = (): Promise<void> => {
		const run = (running = (async () => refresh())());
		run.then(settle, settle);
		return run;
	};
	// Hands off to the queued run in the same step that clears `running`, so no caller can start a
	// second concurrent run in between.
	const settle = () => {
		running = undefined;
		const next = queued;
		if (next) {
			queued = undefined;
			start().then(next.resolve, next.reject);
		}
	};
	return () => {
		if (!running) return start();
		if (!queued) {
			let resolve: () => void, reject: (error: unknown) => void;
			const promise = new Promise<void>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			queued = { promise, resolve, reject };
		}
		return queued.promise;
	};
}
