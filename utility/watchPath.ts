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
 * Returns `undefined` when the long form cannot be established, because a path we cannot prove is
 * canonical is exactly the one that must never reach a native watch. A leaf that does not exist yet
 * (a config file whose watcher is armed before it is written) resolves through its deepest existing
 * ancestor; any other failure fails closed.
 *
 * Windows-only: elsewhere `realpathSync.native` would additionally resolve symlinks, which changes
 * which tree an npm-linked component watches. Plain `realpathSync` is not a substitute — it resolves
 * symlinks but leaves 8.3 names intact.
 */
export function canonicalizeWatchPath(watchPath: string, platform: string = process.platform): string | undefined {
	if (platform !== 'win32') return watchPath;
	let unresolvedSuffix = '';
	let candidate = watchPath;
	while (true) {
		try {
			const canonical = realpathSync.native(candidate);
			return unresolvedSuffix ? join(canonical, unresolvedSuffix) : canonical;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
			const parent = dirname(candidate);
			if (parent === candidate) return undefined;
			unresolvedSuffix = unresolvedSuffix ? join(basename(candidate), unresolvedSuffix) : basename(candidate);
			candidate = parent;
		}
	}
}

/**
 * Watch target for a chokidar/`fs.watch` call: the canonical path when one could be established,
 * otherwise the original path with `mustPoll`, which callers turn into their polling options.
 * Polling never arms a native watch, so it cannot hit the abort.
 */
export function resolveWatchTarget(watchPath: string): { path: string; mustPoll: boolean } {
	const canonical = canonicalizeWatchPath(watchPath);
	if (canonical !== undefined) return { path: canonical, mustPoll: false };
	if (!canonicalizationWarned) {
		canonicalizationWarned = true;
		watchPathLogger.warn?.(
			`Could not resolve the canonical form of ${watchPath}. Falling back to polling-based watching ` +
				'for affected watchers, because a non-canonical path handed to a native Windows watch aborts the process.'
		);
	}
	return { path: watchPath, mustPoll: true };
}

// Test-only hook to reset the one-time warning gate between cases.
export function _resetForTests(): void {
	canonicalizationWarned = false;
}
