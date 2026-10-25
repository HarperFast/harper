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
	const statuses = nodeModule.constants?.compileCacheStatus;
	if (!rootPath || process.env.NODE_COMPILE_CACHE || typeof nodeModule.enableCompileCache !== 'function' || !statuses)
		return;
	const directory = join(rootPath, 'cache', 'compile');
	if (directory === workerCacheDirectory) return;
	const result = nodeModule.enableCompileCache(directory);
	const { ENABLED, ALREADY_ENABLED, FAILED } = statuses;
	// ALREADY_ENABLED after an earlier call: initialize() moved rootPath (a command-line or env override) after this
	// thread latched the old one, which Node cannot change; the workers still follow the final root
	if (result?.status === ENABLED || (result?.status === ALREADY_ENABLED && workerCacheDirectory)) {
		workerCacheDirectory = directory;
		void pruneStaleCompileCaches(directory);
	} else if (result?.status === FAILED) {
		harperLogger.debug(`Node compile cache could not be enabled in ${directory}: ${result.message}`);
	}
}

export function compileCacheWorkerEnv(
	callerEnv?: NodeJS.Dict<string> | symbol
): NodeJS.Dict<string> | symbol | undefined {
	// a symbol is SHARE_ENV: the worker shares this thread's env, where Harper leaves the cache directory unset
	if (!workerCacheDirectory || typeof callerEnv === 'symbol') return callerEnv;
	const env = { ...(callerEnv ?? process.env) };
	// Node treats an empty NODE_COMPILE_CACHE as unset, and so does a caller's explicit undefined
	env.NODE_COMPILE_CACHE ||= workerCacheDirectory;
	return env;
}

/**
 * Every subdirectory for this Node version and architecture is kept: `threads.v8Flags` gives workers a different V8
 * tag than the main thread.
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
