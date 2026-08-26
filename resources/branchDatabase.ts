import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { COMPONENT_PREPARATION_PROCESS_INSTANCE_ID } from '../components/componentPreparationLock.ts';
import logger from '../utility/logging/harper_logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { commonValidators } from '../validation/common_validators.ts';
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

const MAX_NAME_LENGTH = commonValidators.schema_length.maximum;

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

/** Wait until the claim leaves CREATING, and report the state it settled on. */
async function awaitClaim(state: BigInt64Array, branchPath: string, deadline: number): Promise<bigint> {
	for (;;) {
		const current = Atomics.load(state, 0);
		if (current !== CREATING) return current;
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`Timed out waiting for another thread to create the branch at ${branchPath}`);
		const slice = Math.min(remaining, 1000);
		if (isShared(state)) {
			const wait = (Atomics as any).waitAsync(state, 0, CREATING, slice);
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

/**
 * Two (application, database) pairs must never name one store: blob file ids restart from each
 * store's own counter, so a shared identity means two branches minting identical file paths. Joining
 * with a separator is not injective -- ('a__b', 'c') and ('a', 'b__c') both give 'a__b__c' -- so the
 * application name's length goes in front, the way the directory layout keeps them separate.
 */
function branchStoreName(appName: string, baseName: string): string {
	return `${appName.length}_${appName}__${baseName}`;
}

async function openOrCreate(baseName: string, appName: string, branchPath: string): Promise<OpenBranch> {
	const claimState = claimStateFor(baseName, branchPath);
	const deadline = Date.now() + CLAIM_TIMEOUT_MS;
	for (;;) {
		// The deadline bounds the whole protocol, not just a single wait: an unexpected state word --
		// a future state, a buffer another version wrote -- must fail this load, never spin forever.
		if (Date.now() > deadline) throw new Error(`Timed out claiming the branch at ${branchPath}`);
		const previous = Atomics.compareExchange(claimState, 0, UNCLAIMED, CREATING);
		if (previous === READY) break;
		if (previous === UNCLAIMED) {
			try {
				await materializeBranch(baseName, branchPath);
				Atomics.store(claimState, 0, READY);
			} catch (error) {
				// Release rather than record the failure. A claim that stays un-releasable turns one
				// transient error -- a full disk, a rename losing a race -- into a branch that can never
				// be created again for the life of the process, because the buffer outlives every retry.
				Atomics.store(claimState, 0, UNCLAIMED);
				throw error;
			} finally {
				wakeWaiters(claimState);
			}
			break;
		}
		// Someone else holds it. A wait that settles on UNCLAIMED means they failed and released, so
		// take another turn at being the one who creates it.
		if ((await awaitClaim(claimState, branchPath, deadline)) === READY) break;
	}
	return { branch: openBranchDatabase(branchPath, baseName, branchStoreName(appName, baseName)), claimState };
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
			await rmdir(dir);
		} catch {
			return;
		}
		dir = dirname(dir);
	}
}

function branchRootOf(branchPath: string): string {
	return dirname(dirname(dirname(branchPath)));
}

/**
 * Release this thread's handle on a branch WITHOUT touching the directory. One branch directory is
 * shared by every worker thread that loaded the application, so a thread that gives up its handle --
 * a failed load, most often -- must not delete storage another thread is serving queries from.
 */
async function closeBranchAt(branchPath: string): Promise<void> {
	const pending = branchesByPath.get(branchPath);
	branchesByPath.delete(branchPath);
	const opened = await pending?.catch(() => null);
	opened?.branch.close();
}

/** Release the handle and delete the directory. Only safe once nothing is using it: teardown. */
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
		// Up front, not inside the open: two individually legal names can compose a store identity past
		// the 250-character limit, and `openBranchDatabase` only checks it after the claim is taken and
		// a potentially full-copy checkpoint is already on disk.
		const storeName = branchStoreName(appName, baseName);
		if (storeName.length > MAX_NAME_LENGTH) {
			throw new Error(
				`Application '${appName}' cannot branch '${baseName}': the branch store identity would be ` +
					`${storeName.length} characters, over the ${MAX_NAME_LENGTH} allowed`
			);
		}
	}
	// Only the branches this call actually opened are this call's to give up. A branch handle is
	// cached per path for the whole thread, so a later load of the same application -- a component
	// reload, or a second component with the same appName -- must not close the branch the load
	// already running is serving from.
	const opened: string[] = [];
	try {
		for (const baseName of branchedDatabases) {
			const branchPath = resolveBranchPath(baseName, appName, COMPONENT_PREPARATION_PROCESS_INSTANCE_ID);
			const isNew = !branchesByPath.has(branchPath);
			branches.set(baseName, await getOrCreateBranch(baseName, appName));
			if (isNew) opened.push(branchPath);
		}
	} catch (error) {
		// A partially branched application is worse than one that failed to load: some of its names
		// would resolve to a branch and the rest to the base. Only this application's handles go, and
		// only handles: another worker thread may have loaded the same application successfully and be
		// serving queries out of the very directories this thread is giving up.
		for (const branchPath of opened) await closeBranchAt(branchPath).catch(() => {});
		throw error;
	}
	return branches;
}
