// Startup-phase lifecycle: lets modules declare side-effectful initialization
// (server-singleton wiring, config-derived constants, listener registration)
// without running it at module-load time. The entry point invokes
// `runStartup()` after `env.initSync()` and before the server starts handling
// requests, so all hooks see a fully-linked module graph and an initialized
// environment.
//
// Usage:
//   import { onStartup } from '.../utility/lifecycle.ts';
//   onStartup(() => {
//     server.recordAnalytics = recordAction;
//   });
//
// Unit tests: any test that exercises code paths depending on these hooks must
// either call `runStartup()` itself in a `before`/`beforeEach`, or import the
// real CLI entry point. `runStartup()` is idempotent — calling it a second
// time is a no-op until `resetStartupForTests()` is called.

type StartupCallback = () => void | Promise<void>;

const callbacks: StartupCallback[] = [];
let started = false;
let runningPromise: Promise<void> | null = null;

/**
 * Register a callback to be run during the startup phase. If startup has
 * already run, the callback is invoked on the next microtask.
 */
export function onStartup(cb: StartupCallback): void {
	if (started) {
		Promise.resolve().then(cb);
		return;
	}
	callbacks.push(cb);
}

/**
 * Run all registered startup callbacks in registration order. Idempotent:
 * subsequent calls return the same promise as the first invocation.
 */
export function runStartup(): Promise<void> {
	if (runningPromise) return runningPromise;
	runningPromise = (async () => {
		started = true;
		// Snapshot in case callbacks register more callbacks (they'll run
		// immediately via the microtask path above).
		const pending = callbacks.splice(0, callbacks.length);
		for (const cb of pending) {
			await cb();
		}
	})();
	return runningPromise;
}

/**
 * Reset startup state. Intended for unit tests that want to re-run startup
 * (e.g. between describe blocks). Production code should never call this.
 */
export function resetStartupForTests(): void {
	callbacks.length = 0;
	started = false;
	runningPromise = null;
}

/** True once `runStartup()` has begun. */
export function hasStarted(): boolean {
	return started;
}
