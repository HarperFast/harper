// Polling fallback for chokidar watchers.
//
// When the host system runs out of inotify watches (ENOSPC) or file descriptors
// (EMFILE), native chokidar watchers emit an error and stop firing change
// events. Polling-based watching doesn't consume inotify handles or per-watcher
// file descriptors, so we fall back to it once and warn — see harper#488.

import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import { loggerWithTag } from './logging/harper_logger.ts';

// One-time process-wide warning so a thundering herd of failing watchers doesn't
// produce hundreds of identical log lines.
let exhaustionWarned = false;
const partialReadWarned = new Set<string>();

const fallbackLogger = loggerWithTag('watcher');

/**
 * Returns `true` if the chokidar error indicates the OS-level watcher pool is
 * exhausted (inotify watches on Linux, open file descriptors on macOS/Linux).
 */
export function isWatcherExhaustionError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const code = (error as { code?: string }).code;
	return code === 'ENOSPC' || code === 'EMFILE';
}

/**
 * Polling-watch options to pass through to chokidar when falling back, for
 * watchers backed by a single file (a config.yaml etc.).
 *
 * Intervals are deliberately conservative — polling-based watching is
 * fundamentally less efficient than inotify, and once we're in this mode the
 * host is already under resource pressure. A second-scale interval keeps CPU
 * cost bounded; the alternative is to lose change events entirely.
 */
export const POLLING_FALLBACK_OPTIONS = {
	usePolling: true,
	interval: 1000,
	binaryInterval: 2000,
} as const;

/**
 * Polling-watch options for directory-tree watchers (EntryHandler). Chokidar
 * polls fs.stat on every watched file each interval, so a tree with thousands
 * of files at 1s would burn meaningful CPU; we trade responsiveness for cost
 * here on the assumption that the host is already strained.
 */
export const DIRECTORY_POLLING_FALLBACK_OPTIONS = {
	usePolling: true,
	interval: 3000,
	binaryInterval: 5000,
} as const;

/**
 * Log a one-time warning when a watcher first falls back to polling. Subsequent
 * fallbacks in the same process are silent.
 */
export function warnWatcherFallback(watchedPath: string): void {
	if (exhaustionWarned) return;
	exhaustionWarned = true;
	fallbackLogger.warn?.(
		`File watcher exhaustion (ENOSPC/EMFILE) on ${watchedPath}. ` +
			'Falling back to polling-based watching for affected watchers — ' +
			'this will increase CPU usage proportional to the size of the watched trees ' +
			'and may delay or miss rapid file changes. ' +
			'To restore native watching, raise the OS limit, for example: ' +
			'`sudo sysctl -w fs.inotify.max_user_watches=524288` ' +
			'or `sudo sysctl -w fs.inotify.max_user_instances=10000` (Linux).'
	);
}

// Test-only hook to reset the one-time warning gate between cases.
export function _resetForTests(): void {
	exhaustionWarned = false;
	lostNativeWatchCount = 0;
	lostNativeWatchWarnThreshold = 1;
}

// ---------------------------------------------------------------------------
// Lost native watch (predominantly Windows)
// ---------------------------------------------------------------------------
//
// Every Harper watcher runs chokidar with `persistent: false` so a watcher never
// holds the event loop open. That option takes chokidar down a code path that
// never attaches an 'error' listener to the underlying Node `fs.FSWatcher`
// (chokidar `handler.js`, `setFsWatchListener`):
//
//     if (!options.persistent) {
//         watcher = createFsWatchInstance(path, options, listener, errHandler, rawEmitter);
//         if (!watcher) return;
//         return watcher.close.bind(watcher);   // <-- no watcher.on('error', ...)
//     }
//
// `errHandler` is only consulted for a *synchronous* throw out of `fs.watch()`
// (which is how ENOSPC/EMFILE reach `isWatcherExhaustionError` above). An
// *asynchronous* watch failure — on Windows, deleting or replacing the watched
// directory — is delivered by `node:internal/fs/watchers` as
// `this.emit('error', err)` on an emitter with no listener, so Node turns it
// into an uncaughtException. The error never reaches chokidar's wrapper, so
// attaching `.on('error')` to the chokidar `FSWatcher` we hold does not help.
//
// chokidar's `persistent: true` branch does attach a listener and swallows this
// exact error (its node#4337 workaround), which is why only Harper's watchers
// see it. The upstream fix is one line — `watcher.on('error', errHandler)` in
// the non-persistent branch — and is still missing as of chokidar 5.0.0.
//
// Until then `installLostNativeWatchGuard()` supplies the missing listener at
// the only place the error is observable: the process. It claims *only* this
// error shape and leaves every other uncaught exception exactly as Node would
// have handled it.

/**
 * Returns `true` for the asynchronous "the watched path went away" error raised
 * by Node's `fs.FSWatcher`: `EPERM: operation not permitted, watch` (errno
 * -4048), which fires on Windows whenever a watched directory is removed or
 * swapped out — a component redeploy, a test fixture teardown, an `npm install`
 * that replaces a tree.
 *
 * Deliberately distinct from {@link isWatcherExhaustionError}: exhaustion means
 * the host ran out of watch capacity and polling is a useful degradation; a lost
 * native watch means the thing being watched no longer exists, and polling would
 * only burn CPU on a path that isn't there.
 *
 * The three conditions are all load-bearing, because whatever this claims is
 * swallowed process-wide:
 *
 *   - `syscall === 'watch'` is only ever set by fs watch handles.
 *   - `EPERM` only. An async `ENOENT` from a watch handle has never been
 *     observed, whereas a *synchronous* one is the ordinary "watch a path that
 *     isn't there" misconfiguration, which must stay fatal.
 *   - no `path`. This is what separates the async failure from a synchronous
 *     `fs.watch()` throw: Node populates `path` on the thrown error but leaves
 *     it absent on the one delivered to the handle's 'error' event (which
 *     carries `filename: null` and nothing else locating it). Without this a
 *     raw `fs.watch(missingPath)` escaping into an uncaughtException would be
 *     mistaken for a benign lost watch and silently swallowed.
 */
export function isLostNativeWatchError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { code, syscall, path } = error as { code?: unknown; syscall?: unknown; path?: unknown };
	return syscall === 'watch' && code === 'EPERM' && path == null;
}

let lostNativeWatchCount = 0;
// Warn on occurrence 1, then 10, 100, … — see claimLostNativeWatchError().
let lostNativeWatchWarnThreshold = 1;

/**
 * If `error` is a lost native watch error, mark it handled, log it, and report
 * that it has been claimed. Exported so the per-watcher error routes can give it
 * the same benign treatment on the day chokidar does deliver it to the wrapper
 * (its polling and `persistent: true` branches already would).
 */
export function claimLostNativeWatchError(error: unknown): boolean {
	if (!isLostNativeWatchError(error)) return false;
	// server/threads/threadServer.js skips errors already marked handled, so the
	// benign case doesn't also get logged there as a worker-level uncaughtException.
	(error as { isHandled?: boolean }).isHandled = true;
	lostNativeWatchCount++;
	fallbackLogger.trace?.(`Lost native file watch handle (occurrence ${lostNativeWatchCount}):`, error);
	// Never go fully silent. Node gives this error no path, so it cannot be attributed to the
	// watcher that raised it — ours or a dependency's — and a subsystem that has quietly stopped
	// being watched is exactly what an operator needs to see. The default log level is `warn`, so
	// trace alone would make every occurrence after the first invisible. Warn on the first and
	// then at each decade, which keeps a delete storm (one error per directory in a removed tree)
	// bounded without ever suppressing the signal outright.
	if (lostNativeWatchCount >= lostNativeWatchWarnThreshold) {
		lostNativeWatchWarnThreshold *= 10;
		fallbackLogger.warn?.(
			`A native file watch handle failed asynchronously (EPERM, syscall=watch) and was suppressed to ` +
				`keep the thread alive; occurrence ${lostNativeWatchCount}. Node reports no path for this error, ` +
				`so it cannot be attributed to a specific watcher — whatever was watching that path has stopped ` +
				`reporting changes until it is re-established. On Windows this is usually a watched directory ` +
				`being deleted or replaced (a component redeploy, a package install, a test teardown). If file ` +
				`changes stop being picked up somewhere, this is why. Subsequent occurrences log at trace, with ` +
				`a warning at each tenfold increase.`
		);
	}
	return true;
}

let lostNativeWatchGuardInstalled = false;

function handleUncaughtException(error: unknown): void {
	if (claimLostNativeWatchError(error)) return;
	// Not ours. Node suppresses its default fatal handling as soon as *any*
	// 'uncaughtException' listener exists, so if this guard is the only listener
	// its mere presence would turn unrelated crashes into silent hangs. Step out
	// of the way and let the exception be fatal exactly as it would have been.
	if (process.listenerCount('uncaughtException') > 1) return;
	process.removeListener('uncaughtException', handleUncaughtException);
	// Re-raising on the next tick (rather than throwing from inside the handler)
	// keeps Node's normal report and exit code 1; a throw from within the handler
	// exits 7 instead.
	process.nextTick(() => {
		throw error;
	});
}

/**
 * Idempotently install the process-level listener that supplies the 'error'
 * handler chokidar omits for non-persistent watchers. Called by
 * {@link guardedWatch} so no watcher call site can forget it.
 */
export function installLostNativeWatchGuard(): void {
	if (lostNativeWatchGuardInstalled) return;
	lostNativeWatchGuardInstalled = true;
	// prepend, not append: threadServer.js already has an 'uncaughtException'
	// listener, and the `isHandled` mark above only suppresses its log line if
	// this guard runs first.
	process.prependListener('uncaughtException', handleUncaughtException);
}

/**
 * `chokidar.watch()` with the lost-native-watch guard installed. Every Harper
 * chokidar watcher must go through this — a raw `chokidar.watch(..., { persistent: false })`
 * can take down the thread the first time its path is deleted.
 */
export function guardedWatch(paths: string | string[], options?: ChokidarOptions): FSWatcher {
	installLostNativeWatchGuard();
	return chokidar.watch(paths, options);
}

// Test-only: number of lost native watch errors claimed so far.
export function _lostNativeWatchCountForTests(): number {
	return lostNativeWatchCount;
}

/**
 * A config file replaced in place (truncate, then write) can be read back empty or
 * half-written, and chokidar may emit nothing further for that write — so a watcher that
 * simply drops the unusable read would serve stale config until something else touched the
 * file. Re-read on a later turn instead, bounded so a genuinely empty or corrupt file cannot
 * spin. Callers read synchronously, so the descriptor still never outlives a single turn.
 */
const PARTIAL_READ_REREAD_DELAY_MS = 20;
const PARTIAL_READ_MAX_REREADS = 10;

export class PartialReadRetry {
	#filePath: string;
	#timer?: ReturnType<typeof setTimeout>;
	#remaining: number = PARTIAL_READ_MAX_REREADS;
	#closed = false;

	constructor(filePath: string) {
		this.#filePath = filePath;
	}

	/** False once the budget is spent, so the caller can fall back to its own error handling. */
	schedule(reread: () => void): boolean {
		if (this.#closed) return false;
		if (this.#timer) return true;
		if (this.#remaining <= 0) return false;
		this.#remaining--;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			reread();
		}, PARTIAL_READ_REREAD_DELAY_MS);
		this.#timer.unref?.();
		return true;
	}

	/** A usable read arrived, so any re-read still armed for the previous one would duplicate it. */
	settled() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#remaining = PARTIAL_READ_MAX_REREADS;
		// The file recovered, so the next time it breaks is a new incident and has to be reported
		// again rather than silenced by the warning it emitted weeks ago.
		partialReadWarned.delete(this.#filePath);
	}

	/**
	 * The budget is spent. Distinct from `settled()` in that the report stands — the file has not
	 * recovered, and it is shared with every other watcher of it. The budget itself is restored,
	 * because the next event may be the repair, and that repair can be observed mid-write too.
	 * Returns whether this give-up was the one reported.
	 */
	gaveUp(error?: unknown): boolean {
		if (this.#closed) return false;
		this.#remaining = PARTIAL_READ_MAX_REREADS;
		return warnPartialReadGaveUp(this.#filePath, error);
	}

	/** Terminal: the watcher is closing, so nothing may re-arm the re-read or report on it. */
	cancel() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#closed = true;
	}
}

/**
 * ENOENT is excluded not because it cannot be transient, but because it already has an answer:
 * `OptionsWatcher` routes it to `remove` (env-only fallback at boot, then removal), and
 * `RootConfigWatcher` keeps its last config rather than tearing down core features on a file
 * that may just be mid-replace. Re-reading would only delay a decision already made.
 */
export function isPartialReadError(error: unknown): boolean {
	return !(typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT');
}

/**
 * A watcher that exhausts its re-read budget serves stale config from then on, so the give-up
 * has to be visible — otherwise the only symptom is a config change that silently did nothing.
 * Warned once per file: every root-config scope watches the same one and would otherwise report
 * a single bad file once each, on every event.
 */
export function warnPartialReadGaveUp(filePath: string, error?: unknown): boolean {
	if (partialReadWarned.has(filePath)) return false;
	partialReadWarned.add(filePath);
	// The cause matters to whoever has to fix it: a file that never parses is a typo to correct,
	// while one that reads empty is a writer that never finished. Report the kind and position
	// only — a YAML parse error's message quotes the offending source, and this file holds
	// credentials.
	const cause = error ? `: ${describeReadFailure(error)}` : ' that were empty or incomplete';
	fallbackLogger.warn(`Gave up re-reading ${filePath} after ${PARTIAL_READ_MAX_REREADS} unusable reads${cause}`);
	return true;
}

/**
 * The kind and position of a failed config read, never its content: a YAML parse error's message
 * quotes the offending source lines, and these files hold credentials.
 */
export function describeReadFailure(error: unknown): string {
	if (typeof error !== 'object' || error === null) return 'unusable';
	const { name, code, linePos } = error as { name?: string; code?: string; linePos?: { line: number; col: number }[] };
	const at = linePos?.[0] ? ` at line ${linePos[0].line}, column ${linePos[0].col}` : '';
	return `${code ?? name ?? 'unusable'}${at}`;
}

/** Test-only: whether a give-up warning for this file is currently suppressed as a duplicate. */
export function isPartialReadWarned(filePath: string): boolean {
	return partialReadWarned.has(filePath);
}

/** Test-only: forget that this file was reported, so a suite can start from a known state. */
export function clearPartialReadWarning(filePath: string) {
	partialReadWarned.delete(filePath);
}

/**
 * A listener that throws while applying new config is a bug in that listener, not evidence the
 * file was half-written — the watcher's own state is already updated, so it keeps going.
 */
export function warnWatcherListenerError(filePath: string, error: unknown) {
	fallbackLogger.warn(`Error applying a configuration change from ${filePath}`, error);
}
