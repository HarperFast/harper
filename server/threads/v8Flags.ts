import { setFlagsFromString } from 'node:v8';
import { isMainThread } from 'node:worker_threads';

import * as envMgr from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

let applied = false;

/**
 * Applies `threads.v8Flags` to the process. V8 reads most flags when an isolate is created, so this must run before the
 * first Harper worker exists; callers are `startHTTPThreads` (before any startup work) and `startWorker` (for a process
 * whose first worker is not an HTTP thread). Only the first successful call reads the setting: V8 flags cannot be unset,
 * so a later config change takes effect on the next process start.
 */
export function applyConfiguredV8Flags(): void {
	if (applied || !isMainThread) return;
	const configured = envMgr.get(CONFIG_PARAMS.THREADS_V8FLAGS);
	const flags: unknown[] = configured == null ? [] : Array.isArray(configured) ? configured : [configured];
	// setFlagsFromString silently ignores an unrecognized flag, so this only rejects values that are not flags at all.
	const invalid = flags.filter((flag) => typeof flag !== 'string' || !flag.startsWith('--'));
	if (invalid.length > 0) {
		throw new Error(
			`threads.v8Flags entries must be V8 flags starting with "--"; invalid: ${invalid.map((flag) => JSON.stringify(flag)).join(', ')}`
		);
	}
	applied = true;
	if (flags.length === 0) return;
	if (typeof globalThis.Bun !== 'undefined') {
		harperLogger.warn('threads.v8Flags is ignored under Bun');
		return;
	}
	for (const flag of flags as string[]) setFlagsFromString(flag);
	harperLogger.info(`Applied V8 flags from threads.v8Flags: ${flags.join(' ')}`);
}
