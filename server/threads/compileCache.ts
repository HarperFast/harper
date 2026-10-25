import * as nodeModule from 'node:module';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import harperLogger from '../../utility/logging/harper_logger.ts';

const NODE_ARCHES = 'arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64';
// Node names its subdirectory `<version>-<arch>-<V8 cachedDataVersionTag as 8 hex digits>[-<uid>]`; group 1 is
// `<version>-<arch>`. Names in any other shape are not Node's, so pruning never touches them.
const NODE_CACHE_SUBDIRECTORY = new RegExp(`^(v\\d+\\.\\d+\\.\\d+-(?:${NODE_ARCHES}))-[0-9a-f]{8}(?:-\\d+)?$`);

let workerCacheDirectory: string | undefined;

/**
 * Enables Node's on-disk compile cache in `<rootPath>/cache/compile` for this process and the workers it starts.
 * An operator's `NODE_COMPILE_CACHE` wins, even when Node could not enable it; `NODE_DISABLE_COMPILE_CACHE` turns
 * it off. Only server starts call this: a CLI run by another uid would create the directory as that uid.
 */
export function enableCompileCache(rootPath: string | undefined): void {
	if (!rootPath || process.env.NODE_COMPILE_CACHE || typeof nodeModule.enableCompileCache !== 'function') return;
	const directory = join(rootPath, 'cache', 'compile');
	const result = nodeModule.enableCompileCache(directory);
	const { ENABLED, FAILED } = nodeModule.constants.compileCacheStatus;
	if (result?.status === ENABLED) {
		workerCacheDirectory = directory;
		void pruneStaleCompileCaches(directory);
	} else if (result?.status === FAILED) {
		harperLogger.debug(`Node compile cache could not be enabled in ${directory}: ${result.message}`);
	}
}

/** The `env` for a new worker: the caller's (or a copy of `process.env`) with Harper's cache directory as default. */
export function compileCacheWorkerEnv(
	callerEnv?: NodeJS.Dict<string> | symbol
): NodeJS.Dict<string> | symbol | undefined {
	// a symbol is SHARE_ENV: the worker shares this thread's env, where Harper leaves the cache directory unset
	if (!workerCacheDirectory || typeof callerEnv === 'symbol') return callerEnv;
	return { NODE_COMPILE_CACHE: workerCacheDirectory, ...(callerEnv ?? process.env) };
}

/**
 * Removes the subdirectories Node created for another Node version or architecture. Every subdirectory for this
 * version and architecture is kept: `threads.v8Flags` gives workers a different V8 tag than the main thread.
 */
export async function pruneStaleCompileCaches(directory: string): Promise<void> {
	const current = `${process.version}-${process.arch}`;
	try {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const versionAndArch = NODE_CACHE_SUBDIRECTORY.exec(entry.name)?.[1];
			if (!entry.isDirectory() || !versionAndArch || versionAndArch === current) continue;
			try {
				await rm(join(directory, entry.name), { recursive: true, force: true });
			} catch (error) {
				harperLogger.debug(`Could not remove stale Node compile cache ${entry.name} in ${directory}`, error);
			}
		}
	} catch (error) {
		harperLogger.debug(`Could not prune stale Node compile caches in ${directory}`, error);
	}
}
