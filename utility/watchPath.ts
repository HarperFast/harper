import { realpathSync } from 'node:fs';
import { loggerWithTag } from './logging/harper_logger.ts';

const watchPathLogger = loggerWithTag('watcher');
let canonicalizationWarned = false;

// An 8.3 alias component (`RUNNER~1`) — the only form GetLongPathNameW rewrites, and so the only
// one that can break the prefix comparison below. A long name that merely contains `~1` is a false
// positive that costs one realpath.
const SHORT_NAME_COMPONENT = /(?:^|[\\/])[^\\/]*~\d+[^\\/]*(?=[\\/]|$)/;

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
 * Only a path carrying an 8.3 component is touched at all: everything else is returned as given,
 * which keeps `realpathSync.native`'s symlink resolution — a behavior change of its own — off every
 * path that cannot abort. Plain `realpathSync` is not a substitute for it: that resolves symlinks
 * but leaves 8.3 names intact.
 *
 * Returns `undefined` when the long form cannot be established, including when the resolved path is
 * still short, because a path we cannot prove is expanded is exactly the one that must never reach a
 * native watch.
 */
export function canonicalizeWatchPath(watchPath: string, platform: string = process.platform): string | undefined {
	if (platform !== 'win32' || !SHORT_NAME_COMPONENT.test(watchPath)) return watchPath;
	let canonical: string;
	try {
		canonical = realpathSync.native(watchPath);
	} catch {
		return undefined;
	}
	return SHORT_NAME_COMPONENT.test(canonical) ? undefined : canonical;
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
