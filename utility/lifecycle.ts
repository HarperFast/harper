// Entry points await this phase after configuration initialization and before accepting requests.

type StartupCallback = () => void | Promise<void>;

let callbacks: StartupCallback[] = [];
let started = false;
let completed = false;
let runningPromise: Promise<void> | null = null;

/**
 * Register a callback to be run during the startup phase. If startup has
 * completed, the callback is invoked on the next microtask.
 */
export function onStartup(cb: StartupCallback): void {
	if (completed) {
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
	let resolveStartup: () => void;
	let rejectStartup: (error: unknown) => void;
	const startup = (runningPromise = new Promise<void>((resolve, reject) => {
		resolveStartup = resolve;
		rejectStartup = reject;
	}));
	const pending = callbacks;
	started = true;
	(async () => {
		try {
			while (callbacks === pending && pending.length) await pending.shift()!();
		} finally {
			pending.length = 0;
			if (callbacks === pending) completed = true;
		}
	})().then(resolveStartup!, rejectStartup!);
	return startup;
}

/**
 * Reset startup state. Intended for unit tests that want to re-run startup
 * (e.g. between describe blocks). Production code should never call this.
 */
export function resetStartupForTests(): void {
	callbacks = [];
	started = false;
	completed = false;
	runningPromise = null;
}

/** True once `runStartup()` has begun. */
export function hasStarted(): boolean {
	return started;
}
