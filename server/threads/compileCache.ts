import * as nodeModule from 'node:module';
import { statSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import harperLogger from '../../utility/logging/harper_logger.ts';
import { nodeFreesAcceptedCompileCacheEntries } from './compileCacheNodeReleases.ts';

const NODE_ARCHES = 'arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64';
// Node names its subdirectory `<version>-<arch>-<V8 cachedDataVersionTag as 8 hex digits>[-<uid>]`; group 1 is
// `<version>-<arch>`. Names in any other shape are not Node's, so pruning never touches them.
const NODE_CACHE_SUBDIRECTORY = new RegExp(`^(v\\d+\\.\\d+\\.\\d+-(?:${NODE_ARCHES}))-[0-9a-f]{8}(?:-\\d+)?$`);
// Node persists an entry to `<entry>.XXXXXX` (mkstemp) and renames it into place; a kill in between leaves the file
const NODE_PERSIST_TEMP_FILE = /^[0-9a-f]{8}\.[0-9A-Za-z]{6}$/;
// An exiting process may still be persisting: a CLI restart overlapping the old process, or old workers in a rolling
// restart. A temp file this old is no longer anyone's.
const ORPHAN_TEMP_FILE_AGE_MS = 10 * 60 * 1000;

let workerCacheDirectory: string | undefined;

/**
 * Enables Node's on-disk compile cache in `<rootPath>/cache/compile` for this process and the workers it starts.
 * An operator's `NODE_COMPILE_CACHE` wins, even when Node could not enable it; `NODE_DISABLE_COMPILE_CACHE` turns
 * it off. Only server starts call this: a CLI run by another uid would create the directory as that uid.
 */
export function enableCompileCache(rootPath: string | undefined): void {
	const statuses = nodeModule.constants?.compileCacheStatus;
	if (
		!rootPath ||
		process.env.NODE_COMPILE_CACHE ||
		typeof nodeModule.enableCompileCache !== 'function' ||
		!statuses ||
		!nodeFreesAcceptedCompileCacheEntries()
	)
		return;
	const directory = join(rootPath, 'cache', 'compile');
	if (directory === workerCacheDirectory) return;
	const result = nodeModule.enableCompileCache(directory);
	const { ENABLED, ALREADY_ENABLED, FAILED } = statuses;
	// ALREADY_ENABLED after an earlier call: initialize() moved rootPath (a command-line or env override) after this
	// thread latched the old one, which Node cannot change; the workers still follow the final root
	if (result?.status === ENABLED || (result?.status === ALREADY_ENABLED && workerCacheDirectory)) {
		const slot = nodeModule.getCompileCacheDir();
		if (result.status === ENABLED && !isDirectory(slot)) {
			// Node accepts any existing path as its directory and then fails every write
			harperLogger.warn(`The Node compile cache is off: ${slot} is not a directory. Remove it to turn the cache on.`);
			return;
		}
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
 * Removes the subdirectories for other Node versions or architectures, and orphaned persist temp files from this
 * version's. Every subdirectory for this version is kept: `threads.v8Flags` gives workers a different V8 tag than the
 * main thread.
 */
export async function pruneStaleCompileCaches(directory: string, now = Date.now()): Promise<void> {
	const current = `${process.version}-${process.arch}`;
	try {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const versionAndArch = NODE_CACHE_SUBDIRECTORY.exec(entry.name)?.[1];
			if (!entry.isDirectory() || !versionAndArch) continue;
			try {
				if (versionAndArch === current) await removeOrphanTempFiles(join(directory, entry.name), now);
				else await rm(join(directory, entry.name), { recursive: true, force: true });
			} catch (error) {
				harperLogger.debug(`Could not prune Node compile cache ${entry.name} in ${directory}`, error);
			}
		}
	} catch (error) {
		harperLogger.debug(`Could not prune stale Node compile caches in ${directory}`, error);
	}
}

async function removeOrphanTempFiles(versionDirectory: string, now: number): Promise<void> {
	for (const name of await readdir(versionDirectory)) {
		if (!NODE_PERSIST_TEMP_FILE.test(name)) continue;
		const path = join(versionDirectory, name);
		// gone already: its process renamed it into place since the readdir
		const stats = await lstat(path).catch(() => undefined);
		if (stats?.isFile() && now - stats.mtimeMs > ORPHAN_TEMP_FILE_AGE_MS) await rm(path, { force: true });
	}
}

function isDirectory(path: string | undefined): boolean {
	try {
		return path !== undefined && statSync(path).isDirectory();
	} catch {
		return false;
	}
}
