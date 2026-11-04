import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loggerWithTag } from './logging/harper_logger.ts';

const watchPathLogger = loggerWithTag('watcher');
let canonicalizationWarned = false;

/**
 * Canonicalize an absolute path before it is handed to a native file watch (`fs.watch`, directly or
 * through chokidar).
 *
 * libuv's Windows fs-event callback rebuilds each event's absolute path, expands it with
 * `GetLongPathNameW`, and then asserts the expansion still starts with the directory it stored when
 * the watch was armed. An 8.3 short directory (`C:\Users\RUNNER~1\...`) never survives that
 * comparison, and the assertion aborts the process rather than failing the watch, so a short path
 * reaching a native watch takes down the whole server (harper#2234).
 *
 * Every Windows path is resolved rather than only the ones that look short: `GetLongPathNameW`'s
 * documentation is explicit that a short name need not contain a tilde, and NTFS allows an
 * explicitly assigned one, so any spelling test would leave the abort reachable. `realpathSync` is
 * not a substitute for the `.native` variant — it resolves symlinks but leaves 8.3 names intact.
 *
 * Returns `undefined` when the long form cannot be established, because a path we cannot prove is
 * expanded is exactly the one that must never reach a native watch.
 */
export function canonicalizeWatchPath(watchPath: string, platform: string = process.platform): string | undefined {
	if (platform !== 'win32') return watchPath;
	try {
		return realpathSync.native(watchPath);
	} catch (error) {
		if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') return undefined;
		// libuv stores only the parent directory of a file target and compares only that prefix, so a
		// leaf that does not exist yet — a config file whose watcher is armed during the install window
		// — still yields a watch path that cannot trip the assertion.
		try {
			return join(realpathSync.native(dirname(watchPath)), basename(watchPath));
		} catch {
			return undefined;
		}
	}
}

/**
 * Watch target for a chokidar/`fs.watch` call: the canonical path, or the original path with
 * `mustPoll`, which callers turn into their polling options. Polling stats the file instead of
 * arming a native watch, so it cannot reach the abort.
 */
export function resolveWatchTarget(watchPath: string): { path: string; mustPoll: boolean } {
	const canonical = canonicalizeWatchPath(watchPath);
	if (canonical !== undefined) return { path: canonical, mustPoll: false };
	if (!canonicalizationWarned) {
		canonicalizationWarned = true;
		watchPathLogger.warn?.(
			`Could not resolve the long-path form of ${watchPath}. Falling back to polling-based watching for ` +
				'affected watchers, because handing a Windows 8.3 short path to a native watch aborts the process.'
		);
	}
	return { path: watchPath, mustPoll: true };
}

export function _resetForTests(): void {
	canonicalizationWarned = false;
}
