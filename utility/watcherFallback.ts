// Polling fallback for chokidar watchers.
//
// When the host system runs out of inotify watches (ENOSPC) or file descriptors
// (EMFILE), native chokidar watchers emit an error and stop firing change
// events. Polling-based watching doesn't consume inotify handles or per-watcher
// file descriptors, so we fall back to it once and warn — see harper#488.

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
}
