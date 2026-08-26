import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { COMPONENT_PREPARATION_PROCESS_INSTANCE_ID } from '../components/componentPreparationLock.ts';
import logger from '../utility/logging/harper_logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as env from '../utility/environment/environmentManager.ts';
import {
	BRANCH_ROOT_DIR,
	type BranchDatabase,
	database,
	databases,
	getDatabases,
	openBranchDatabase,
	resolveBranchPath,
	resolveDatabaseStorageRoot,
} from './databases.ts';

/**
 * Ephemeral per-process forks of a database, for running several variants of an application against
 * isolated copies of the same data (harper#642).
 *
 * Every worker thread loads the same applications, so all of them ask for the same branch at once.
 * Only one may take the checkpoint — a second `createCheckpoint` against a populated directory fails,
 * and worse, two checkpoints would give two threads divergent private data for one application. The
 * claim is settled through a state word in a buffer the base store shares across threads, which is
 * the same mechanism the blob id allocator and the HNSW node counter already use.
 */

const UNCLAIMED = 0n;
const CREATING = 1n;
const READY = 2n;
const FAILED = 3n;

/** How long a loser waits for the winner's checkpoint before giving up on the branch. */
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

interface OpenBranch {
	branch: BranchDatabase;
	/** Reset on removal: the buffer outlives the directory, and a stale READY would make the next
	 *  caller skip materialization and then fail to open a directory that is no longer there. */
	claimState: BigInt64Array;
}

// Keyed on the in-flight open, not the finished one: within a thread the losers of the claim wake on
// READY at the same moment and would otherwise each try to open the directory the winner just opened.
const branchesByPath = new Map<string, Promise<OpenBranch>>();

function claimStateFor(baseName: string, branchPath: string): BigInt64Array {
	const baseStore = database({ database: baseName, table: undefined });
	const seed = new BigInt64Array([UNCLAIMED]);
	return new BigInt64Array(baseStore.getUserSharedBuffer(`branch-claim:${branchPath}`, seed.buffer));
}

/**
 * Take the checkpoint into a temporary sibling and rename it into place, so a crash mid-copy leaves
 * debris rather than a half-populated directory that RocksDB would then refuse to open.
 */
async function materializeBranch(baseName: string, branchPath: string): Promise<void> {
	const staging = `${branchPath}.staging`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(dirname(branchPath), { recursive: true });
	try {
		await database({ database: baseName, table: undefined }).createCheckpoint(staging);
		await rename(staging, branchPath);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/**
 * `Atomics.wait`/`notify` need shared memory, and `getUserSharedBuffer` hands back a plain
 * `ArrayBuffer` when nothing else has asked for the key yet — a single-threaded process, or the
 * first caller in. The state word still works there (load/store/compareExchange do not require
 * sharing) and concurrent async callers within one thread still contend, so waiting falls back to
 * polling rather than throwing.
 */
function isShared(state: BigInt64Array): boolean {
	return typeof SharedArrayBuffer !== 'undefined' && state.buffer instanceof SharedArrayBuffer;
}

function wakeWaiters(state: BigInt64Array): void {
	if (isShared(state)) Atomics.notify(state, 0);
}

async function awaitClaim(state: BigInt64Array, branchPath: string): Promise<void> {
	const deadline = Date.now() + CLAIM_TIMEOUT_MS;
	for (;;) {
		const current = Atomics.load(state, 0);
		if (current === READY) return;
		if (current === FAILED) throw new Error(`Branch database at ${branchPath} failed to be created by another thread`);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`Timed out waiting for another thread to create the branch at ${branchPath}`);
		const slice = Math.min(remaining, 1000);
		if (isShared(state)) {
			const wait = (Atomics as any).waitAsync(state, 0, current, slice);
			if (wait.async) await wait.value;
		} else {
			await new Promise((resolve) => setTimeout(resolve, Math.min(slice, 5)));
		}
	}
}

/**
 * Get this process's branch of `baseName` for `appName`, creating it on first call. Concurrent
 * callers across worker threads all receive the same branch.
 */
export async function getOrCreateBranch(
	baseName: string,
	appName: string,
	instanceId: string = COMPONENT_PREPARATION_PROCESS_INSTANCE_ID
): Promise<BranchDatabase> {
	const branchPath = resolveBranchPath(baseName, appName, instanceId);
	let pending = branchesByPath.get(branchPath);
	if (!pending) {
		pending = openOrCreate(baseName, appName, branchPath);
		branchesByPath.set(branchPath, pending);
		// A failed attempt must not be cached, or the application can never load on a later retry.
		pending.catch(() => branchesByPath.delete(branchPath));
	}
	return (await pending).branch;
}

async function openOrCreate(baseName: string, appName: string, branchPath: string): Promise<OpenBranch> {
	const claimState = claimStateFor(baseName, branchPath);
	const won = Atomics.compareExchange(claimState, 0, UNCLAIMED, CREATING) === UNCLAIMED;
	if (won) {
		try {
			await materializeBranch(baseName, branchPath);
			Atomics.store(claimState, 0, READY);
		} catch (error) {
			// Publish the failure before waking anyone: a loser that sees CREATING forever is a worker
			// that never finishes loading its application.
			Atomics.store(claimState, 0, FAILED);
			throw error;
		} finally {
			wakeWaiters(claimState);
		}
	} else {
		await awaitClaim(claimState, branchPath);
	}
	return { branch: openBranchDatabase(branchPath, baseName, `${appName}__${baseName}`), claimState };
}

/**
 * Remove the now-empty `<instance>/<app>` directories a branch leaves behind. Without this every
 * process instance leaves a permanent empty directory under the branch root, and `sweepStaleBranches`
 * reports each one forever as another instance's — noise that grows without bound and drowns the
 * case the warning exists for.
 */
async function pruneEmptyParents(root: string, branchPath: string): Promise<void> {
	let dir = dirname(branchPath);
	// Stop at the branch root itself: it is shared, and `relative` going outside it means we walked past.
	while (dir !== root && !relative(root, dir).startsWith('..')) {
		try {
			await rmdir(dir); // fails with ENOTEMPTY while anything else still lives here, which is the guard
		} catch {
			return;
		}
		dir = dirname(dir);
	}
}

function branchRootOf(branchPath: string): string {
	// `<storage>/<BRANCH_ROOT_DIR>/<instance>/<app>/<db>` — the root is three levels up from the db.
	return dirname(dirname(dirname(branchPath)));
}

async function removeBranchAt(branchPath: string): Promise<void> {
	const pending = branchesByPath.get(branchPath);
	branchesByPath.delete(branchPath);
	const opened = await pending?.catch(() => null);
	if (opened) {
		opened.branch.close();
		Atomics.store(opened.claimState, 0, UNCLAIMED);
		wakeWaiters(opened.claimState);
	}
	await rm(branchPath, { recursive: true, force: true }).catch((error) =>
		logger.warn?.(`Could not remove branch directory ${branchPath}`, error)
	);
	await pruneEmptyParents(branchRootOf(branchPath), branchPath);
}

/** Close and delete every branch this process opened. Branches do not outlive the process. */
export async function removeBranches(): Promise<void> {
	for (const branchPath of [...branchesByPath.keys()]) await removeBranchAt(branchPath);
}

/**
 * Remove branch directories left by earlier runs. Only this process instance's own directory is
 * touched: another live Harper on the same storage root has its own instance directory, and a UUID
 * proves identity rather than liveness, so anything else is left alone and reported instead.
 */
export async function sweepStaleBranches(
	baseName: string,
	instanceId: string = COMPONENT_PREPARATION_PROCESS_INSTANCE_ID
): Promise<string[]> {
	const root = join(resolveDatabaseStorageRoot(baseName), BRANCH_ROOT_DIR);
	if (!existsSync(root)) return [];
	const retained: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name !== instanceId) {
			// An empty directory holds no branch — a crashed process's leftovers, not a live instance.
			// Reporting it would be the same unbounded noise `pruneEmptyParents` exists to prevent.
			if (
				await rmdir(join(root, entry.name)).then(
					() => true,
					() => false
				)
			)
				continue;
			retained.push(entry.name);
			continue;
		}
		await rm(join(root, entry.name), { recursive: true, force: true }).catch((error) =>
			logger.warn?.(`Could not sweep branch directory ${join(root, entry.name)}`, error)
		);
	}
	if (retained.length) {
		logger.warn?.(
			`Left ${retained.length} branch director(ies) under ${root} belonging to other process instances; ` +
				`they are removed by the instance that owns them, or by hand if that process is gone`
		);
	}
	return retained;
}

/**
 * Create every branch an application declared, or fail its load. These checks need the live
 * environment, so they cannot live in the static config validator: whether the database exists,
 * which storage engine is in effect, and whether the application's loader mode can carry a scoped
 * `databases` binding at all.
 *
 * Failing is always right here. Falling back to the base would hand the application the shared
 * database it explicitly asked not to have, and nothing downstream could tell the difference.
 */
export async function prepareBranches(
	appName: string,
	branchedDatabases: string[] | undefined,
	loaderMode: string | undefined
): Promise<Map<string, BranchDatabase>> {
	const branches = new Map<string, BranchDatabase>();
	if (!branchedDatabases?.length) return branches;

	// The scoped `databases` binding is delivered through the module loader. Under `native` the
	// loader hands back the process-wide exports, so a branch would be created and then never
	// reached — the application would silently write the base.
	if (loaderMode === 'native') {
		throw new Error(
			`Application '${appName}' declares branchedDatabases but runs under the 'native' module loader, ` +
				`which cannot carry a scoped databases binding; use the default loader or remove branchedDatabases`
		);
	}
	if ((process.env.HARPER_STORAGE_ENGINE || env.get(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb') {
		throw new Error(`Application '${appName}' declares branchedDatabases, which requires the RocksDB storage engine`);
	}

	getDatabases();
	for (const baseName of branchedDatabases) {
		if (!databases[baseName]) {
			throw new Error(`Application '${appName}' declares a branch of database '${baseName}', which does not exist`);
		}
	}
	try {
		for (const baseName of branchedDatabases) {
			branches.set(baseName, await getOrCreateBranch(baseName, appName));
		}
	} catch (error) {
		// A partially branched application is worse than one that failed to load: some of its names
		// would resolve to a branch and the rest to the base. Roll back only this application's own
		// branches — applications load one after another, and tearing down the whole process's
		// branches here would pull the data out from under every application already loaded.
		for (const baseName of branchedDatabases) {
			await removeBranchAt(resolveBranchPath(baseName, appName, COMPONENT_PREPARATION_PROCESS_INSTANCE_ID)).catch(
				() => {}
			);
		}
		throw error;
	}
	return branches;
}
