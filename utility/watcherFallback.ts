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
	// Also drop the process listener, so a case that installed the guard can't leave one
	// attached to the test runner's process for every case that follows.
	process.removeListener('uncaughtException', handleUncaughtException);
	lostNativeWatchGuardInstalled = false;
}

// ---------------------------------------------------------------------------
// Lost native watch (predominantly Windows)
// ---------------------------------------------------------------------------
//
// Every Harper watcher runs `persistent: false`, which is the one chokidar
// branch that never attaches an 'error' listener to the underlying Node
// `fs.FSWatcher` (chokidar `handler.js`, `setFsWatchListener`; still so at
// 5.0.0). Its `errHandler` covers only a synchronous throw out of `fs.watch()`
// — the ENOSPC/EMFILE route above. An asynchronous failure is emitted on a
// handle with no listener, so Node makes it an uncaughtException without it
// ever reaching chokidar; `.on('error')` on the wrapper we hold cannot see it.
// The process is therefore the only place it is observable, which is what
// `installLostNativeWatchGuard()` uses.

/**
 * Returns `true` for the asynchronous "the watched path went away" error raised
 * by Node's `fs.FSWatcher` — on Windows, `EPERM: operation not permitted, watch`
 * (errno -4048) when a watched directory is removed or swapped out. Unlike
 * {@link isWatcherExhaustionError} there is nothing to degrade to: polling a
 * path that no longer exists only burns CPU.
 *
 * All three conditions are load-bearing, because whatever this claims is
 * swallowed process-wide:
 *
 *   - `syscall === 'watch'` is only ever set by fs watch handles.
 *   - `EPERM` only. An async `ENOENT` from a watch handle has never been
 *     observed, whereas a *synchronous* one is the ordinary "watch a path that
 *     isn't there" misconfiguration, which must stay fatal.
 *   - no `path`. Node populates `path` on the error it throws out of
 *     `fs.watch()` and leaves it absent on the one it delivers to the handle,
 *     so without this a raw `fs.watch(missingPath)` reaching the guard would be
 *     mistaken for a benign lost watch and swallowed.
 */
export function isLostNativeWatchError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { code, syscall, path } = error as { code?: unknown; syscall?: unknown; path?: unknown };
	return syscall === 'watch' && code === 'EPERM' && path == null;
}

let lostNativeWatchCount = 0;
let lostNativeWatchWarnThreshold = 1;

/**
 * If `error` is a lost native watch error, mark it handled, log it, and report
 * that it has been claimed. Exported so the per-watcher error routes can give it
 * the same benign treatment on the day chokidar does deliver it to the wrapper
 * (its polling and `persistent: true` branches already would).
 */
export function claimLostNativeWatchError(error: unknown): boolean {
	if (!isLostNativeWatchError(error)) return false;
	const claimed = error as { isHandled?: boolean };
	// Counting one instance twice would trip the warn threshold early.
	if (claimed.isHandled) return true;
	lostNativeWatchCount++;
	// The claim is the classification above; the bookkeeping that follows must not be able to
	// undo it. A frozen error (`isHandled` unassignable) or a throwing logger would otherwise
	// make a failure just classified as benign fatal — here, or in a caller's 'error' route.
	try {
		fallbackLogger.trace?.(`Lost native file watch handle (occurrence ${lostNativeWatchCount}):`, error);
		// A subsystem that has silently stopped being watched is what an operator needs to see, and
		// the default level is `warn`, so trace alone would hide every occurrence after the first.
		// Warning at each decade keeps a delete storm bounded without ever going fully silent.
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
		// Last: threadServer.js and socketRouter.ts skip errors already marked handled, so failing
		// to mark one costs only a duplicate log line.
		claimed.isHandled = true;
	} catch {
		// Marked or not, logged or not, the error stays claimed.
	}
	return true;
}

let lostNativeWatchGuardInstalled = false;

function handleUncaughtException(error: unknown): void {
	let claimed = false;
	try {
		claimed = claimLostNativeWatchError(error);
	} catch {
		// Classification is all that can still throw (a property getter that does), and a throw
		// from inside an 'uncaughtException' listener would replace Node's report with it and
		// exit 7. An error that cannot be classified is not ours to claim.
		claimed = false;
	}
	if (claimed) return;
	// Node suppresses its default fatal handling as soon as *any* 'uncaughtException' listener
	// exists, so being the only listener would turn unrelated crashes into silent hangs.
	if (process.listenerCount('uncaughtException') > 1) return;
	process.removeListener('uncaughtException', handleUncaughtException);
	// A process that somehow survives re-arms on its next guardedWatch() rather than running
	// unguarded thereafter.
	lostNativeWatchGuardInstalled = false;
	// nextTick, not a throw from inside the handler: that keeps Node's report and exit code 1.
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
	// Deliberately a property access on the default export rather than a named `watch` import:
	// unitTests/server/threads/watchDirFallback.test.js drives the reopen-on-exhaustion chain by
	// swapping `chokidar.default.watch`, and a named import binds past that seam.
	return chokidar.watch(paths, options);
}

// Test-only: number of lost native watch errors claimed so far.
export function _lostNativeWatchCountForTests(): number {
	return lostNativeWatchCount;
}
