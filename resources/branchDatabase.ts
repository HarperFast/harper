import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import logger from '../utility/logging/harper_logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { commonValidators } from '../validation/common_validators.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { copyTree } from '../dataLayer/blobBackup.ts';
import { getBlobPathsForDatabaseName } from './blob.ts';
import type { RocksDatabase } from '@harperfast/rocksdb-js';
import {
	type BranchDatabase,
	database,
	databases,
	getDatabases,
	hydrateBranchRelationships,
	isReadOnlyMode,
	openBranchDatabase,
	releaseBranchIdentity,
	reserveBranchIdentity,
	resolveBranchPath,
} from './databases.ts';
import { replayLogs, replayTimeBudgetMs } from './replayLogs.ts';

/**
 * Private per-application forks of a database, for running several variants of an application against
 * isolated copies of the same data (harper#642).
 *
 * A fork is durable and its location is derived only from the application and database names, so it
 * survives restarts and every node in a cluster names it identically — the identity the data needs
 * to be addressed, and eventually replicated, cluster-wide.
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

/** How long a loser waits for the winner's checkpoint before giving up on the branch; the
 *  winner's replay budget is added on top where the deadline is built (`openOrCreate`). */
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

/**
 * The claim word is process-local shared memory (in-process only, seeded UNCLAIMED each boot) and
 * must stay that way: the winner's tail replay runs exactly once per boot because every boot starts
 * from UNCLAIMED. A durable or cross-process claim would read READY on restart and silently skip
 * recovery.
 */
function claimStateFor(baseName: string, branchPath: string): BigInt64Array {
	const baseStore = database({ database: baseName, table: undefined });
	const seed = new BigInt64Array([UNCLAIMED]);
	return new BigInt64Array(baseStore.getUserSharedBuffer(`branch-claim:${branchPath}`, seed.buffer));
}

/**
 * Take the checkpoint into a temporary sibling and rename it into place, so a crash mid-copy leaves
 * debris rather than a half-populated directory that RocksDB would then refuse to open.
 */
/**
 * Reproduce the base's blob roots as the branch's own, hard-linking each file so the OS inode
 * refcount does the reference counting: the branch and base share the bytes, each holds its own
 * directory entry, and the data is freed only when the last link to it goes. That is what lets the
 * branch keep its own ID allocator -- `getNextFileId` seeds from the highest filename already in its
 * directory, and the clone carries the base's filenames -- with no shared allocator, no high-water
 * mark, and no gated deletion (harper#644).
 *
 * A blob that is mid-write or already reclaimed is substituted with a marker rather than linked. A
 * partially-written blob would otherwise be linked as a whole one, and worse, the abort that follows
 * stamps PENDING onto that inode IN PLACE -- through the branch's link as well, since it is the same
 * inode. The marker makes that blob fail loudly in the branch instead.
 */
async function cloneBlobRoots(baseName: string, storeName: string): Promise<void> {
	const baseRoots = getBlobPathsForDatabaseName(baseName);
	const branchRoots = getBlobPathsForDatabaseName(storeName);
	let substituted = 0;
	for (let index = 0; index < baseRoots.length; index++) {
		const staging = `${branchRoots[index]}.staging`;
		await rm(staging, { recursive: true, force: true });
		// Created up front rather than left to the walk: a base with no blobs at all copies nothing, and
		// the branch still needs its own (empty) root to exist so its allocator starts where the base's
		// would have.
		await mkdir(staging, { recursive: true });
		const counts = await copyTree(baseRoots[index], staging, true, {
			gone: 'blob was already reclaimed from the base when this branch was created',
			pending: 'blob was still being written to the base when this branch was created',
		});
		substituted += counts.substituted;
		await rm(branchRoots[index], { recursive: true, force: true });
		await mkdir(dirname(branchRoots[index]), { recursive: true });
		await rename(staging, branchRoots[index]);
	}
	if (substituted > 0) {
		logger.warn?.(
			`Branch of '${baseName}' substituted ${substituted} blob file(s) with markers because they were ` +
				`mid-write or already reclaimed when it was created; reads of those blobs in the branch will fail`
		);
	}
}

/** Remove a branch's blob roots and any staging siblings left by an interrupted clone. */
async function removeBlobRootsFor(storeName: string): Promise<void> {
	for (const root of getBlobPathsForDatabaseName(storeName)) {
		for (const target of [root, `${root}.staging`]) {
			await rm(target, { recursive: true, force: true }).catch((error) =>
				logger.warn?.(`Could not remove branch blob root ${target}`, error)
			);
		}
	}
}

const COMPLETION_MARKER = '.branch-complete';

/**
 * What materialization published, written inside the branch directory just before it is renamed into
 * place. Because that rename is a single atomic publish, a branch directory carrying this marker is
 * one whose checkpoint AND blob roots were both finished.
 */
interface BranchCompletion {
	blobRoots: string[];
}

type BranchState =
	| { state: 'absent' }
	/** No branch was ever published here -- leftovers that are not a store, safe to clear and redo. */
	| { state: 'debris' }
	/** A real store with no usable marker: pre-dates the marker, or lost it. Data-bearing either way. */
	| { state: 'unmarked'; why: string }
	| { state: 'complete' }
	/** Was published complete; part of what it recorded is gone or no longer matches the config. */
	| { state: 'damaged'; problem: string };

/**
 * Does this directory hold database data? Not "does CURRENT exist" -- a store that lost CURRENT still
 * has its MANIFEST and SSTs, and a single missing file cannot stand for "there is nothing here to
 * lose". Anything that answers yes is never deleted, only refused.
 */
function holdsStoreData(branchPath: string): boolean {
	let entries: string[];
	try {
		entries = readdirSync(branchPath);
	} catch {
		return false;
	}
	return entries.some(
		(name) => name === 'CURRENT' || /^(MANIFEST|OPTIONS)-/.test(name) || name.endsWith('.sst') || name.endsWith('.log')
	);
}

/**
 * What a branch directory on disk actually is, and in particular whether it may be destroyed.
 *
 * A branch's blob roots live on the volumes named by `storage.blobPaths`, not inside the branch
 * directory, so the two cannot be published by one atomic rename and nothing fsyncs either parent. A
 * directory alone therefore proves nothing: trusting it would adopt a branch whose allocator restarts
 * from an empty root and mints file ids its own checkpointed rows already reference. The marker,
 * written inside staging before the single rename that publishes it, is what proves both halves
 * landed -- and recording the roots keeps an operator adding a `blobPaths` entry from reading as
 * damage, since the new root was never this branch's.
 *
 * Materialization cannot leave a marker-less branch directory, so anything marker-less that still
 * looks like a store came from elsewhere -- a branch older than the marker, or one whose marker was
 * lost -- and is carrying data. It is refused, never deleted.
 */
function readBranchState(branchPath: string, storeName: string): BranchState {
	if (!existsSync(branchPath)) return { state: 'absent' };
	const looksLikeAStore = holdsStoreData(branchPath);
	let recorded: BranchCompletion;
	try {
		recorded = JSON.parse(readFileSync(join(branchPath, COMPLETION_MARKER), 'utf8'));
	} catch {
		return looksLikeAStore ? { state: 'unmarked', why: 'it has no readable completion marker' } : { state: 'debris' };
	}
	// `JSON.parse('null')` succeeds and yields null, so this cannot go straight to a property access.
	if (recorded == null || !Array.isArray(recorded.blobRoots) || recorded.blobRoots.some((r) => typeof r !== 'string')) {
		return { state: 'unmarked', why: 'its completion marker is malformed' };
	}
	const configured = getBlobPathsForDatabaseName(storeName);
	// By index, not by set: `storageIndex` on a row is a position in this list, so a reordered
	// `storage.blobPaths` would silently resolve every row through the wrong root.
	if (recorded.blobRoots.length !== configured.length || recorded.blobRoots.some((root, i) => root !== configured[i])) {
		return {
			state: 'damaged',
			problem:
				`its blob roots no longer match the configured storage.blobPaths ` +
				`(recorded ${JSON.stringify(recorded.blobRoots)}, configured ${JSON.stringify(configured)})`,
		};
	}
	const missing = recorded.blobRoots.filter((root) => !existsSync(root));
	return missing.length
		? { state: 'damaged', problem: `blob root(s) are missing: ${missing.join(', ')}` }
		: { state: 'complete' };
}

async function materializeBranch(baseName: string, branchPath: string, storeName: string): Promise<void> {
	const staging = `${branchPath}.staging`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(dirname(branchPath), { recursive: true });
	try {
		await database({ database: baseName, table: undefined }).createCheckpoint(staging);
		await cloneBlobRoots(baseName, storeName);
		await writeFile(
			join(staging, COMPLETION_MARKER),
			JSON.stringify({ blobRoots: getBlobPathsForDatabaseName(storeName) } satisfies BranchCompletion)
		);
		await rename(staging, branchPath);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		// The blob roots too, staging siblings included: a clone that failed partway leaves the roots it
		// already published and nothing owns them once this attempt is abandoned. Only safe because this
		// branch never became complete -- one that did is never rebuilt, so this cannot remove the last
		// copy of anything.
		await removeBlobRootsFor(storeName);
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
export async function getOrCreateBranch(baseName: string, appName: string): Promise<BranchDatabase> {
	const branchPath = resolveBranchPath(baseName, appName);
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
	const storeName = branchStoreName(appName, baseName);
	// Reserved before the claim, and so before materialization: cloning the blob tree REMOVES and
	// replaces the root this identity resolves to, while `openBranchDatabase`'s own copy of this check
	// runs only after that has happened. A database created while the checkpoint is still copying
	// cannot take the same name.
	reserveBranchIdentity(storeName);
	let handedOver = false;
	try {
		// The claim's CREATING window now covers the winner's replay as well as its checkpoint, so
		// waiters must outlast the replay budget too, or a merely slow (but live) recovery would time
		// out every other thread's application load minutes before the winner publishes READY.
		const deadline = Date.now() + CLAIM_TIMEOUT_MS + replayTimeBudgetMs();
		for (;;) {
			// The deadline bounds the whole protocol, not just a single wait: an unexpected state word --
			// a future state, a buffer another version wrote -- must fail this load, never spin forever.
			if (Date.now() > deadline) throw new Error(`Timed out claiming the branch at ${branchPath}`);
			const previous = Atomics.compareExchange(claimState, 0, UNCLAIMED, CREATING);
			if (previous === READY) break;
			if (previous === UNCLAIMED) {
				let branch: BranchDatabase | undefined;
				try {
					// Adopt rather than recreate. The branch outlives the process that first made it, so on
					// every restart after the first the directory is already here — and `materializeBranch`
					// only ever publishes by renaming a finished checkpoint into place, so a directory that
					// exists is always a complete one, never a half-copy to be distrusted.
					const existing = readBranchState(branchPath, storeName);
					if (existing.state === 'damaged' || existing.state === 'unmarked') {
						const problem = existing.state === 'damaged' ? existing.problem : existing.why;
						throw new Error(
							`Branch database at ${branchPath} cannot be trusted: ${problem}. Refusing to serve or rebuild ` +
								`it, because rebuilding re-forks from the base and would discard anything written to this ` +
								`branch. If this branch's data is not needed, delete the directory (and its blob roots) to ` +
								`have it recreated from the base on the next load.`
						);
					}
					if (existing.state !== 'complete') {
						// Absent, or leftovers that are not a store: nothing here can be lost.
						await rm(branchPath, { recursive: true, force: true });
						await materializeBranch(baseName, branchPath, storeName);
					}
					releaseBranchIdentity(storeName);
					branch = openBranchDatabase(branchPath, baseName, storeName);
					// The branch's column families write with the WAL disabled, so writes since its last
					// memtable flush exist only in its own transaction log — which a process that died
					// without the exit-time flush (a crash, a Windows hard kill) always leaves behind.
					// Replay must finish before READY, because READY is what releases the other threads to
					// serve reads. A fresh checkpoint carries no transaction_logs (verified: the native
					// checkpoint copies only RocksDB files), so replay after materialize is a no-op; the
					// read-only skip mirrors the base's boot replay.
					if (!isReadOnlyMode()) await replayLogs(branch.rootStore as RocksDatabase, branch.tables, true);
					Atomics.store(claimState, 0, READY);
				} catch (error) {
					// Release rather than record the failure. A claim that stays un-releasable turns one
					// transient error -- a full disk, a rename losing a race -- into a branch that can never
					// be created again for the life of the process, because the buffer outlives every retry.
					// The branch is closed first — it holds the path and store identity a retry needs — and
					// a close failure must not leave the claim wedged in CREATING for the whole deadline.
					try {
						branch?.close();
					} catch (closeError) {
						logger.warn(`Error closing branch at ${branchPath} after a failed open`, closeError);
					}
					Atomics.store(claimState, 0, UNCLAIMED);
					throw error;
				} finally {
					wakeWaiters(claimState);
				}
				handedOver = true;
				return { branch, claimState };
			}
			// Someone else holds it. A wait that settles on UNCLAIMED means they failed and released, so
			// take another turn at being the one who creates it.
			if ((await awaitClaim(claimState, branchPath, deadline)) === READY) break;
		}
		// Released immediately before the open, with no `await` in between, so nothing can slip into the
		// gap -- and so `openBranchDatabase`'s check stays strict rather than being taught to ignore a
		// reservation, which would also make it ignore a DIFFERENT branch holding the same name.
		releaseBranchIdentity(storeName);
		const adopted = openBranchDatabase(branchPath, baseName, storeName);
		handedOver = true;
		return { branch: adopted, claimState };
	} finally {
		// `openBranchDatabase` takes the identity over for the life of the handle; anything short of
		// that has to hand it back, or the application can never load again in this process.
		if (!handedOver) releaseBranchIdentity(storeName);
	}
}

/** Remove the now-empty `<app>` directory a removed branch leaves behind. */
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
	return dirname(dirname(branchPath));
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

/**
 * Release the handle and delete the directory. A branch is durable, so nothing calls this on
 * shutdown; it is how an application's data is discarded deliberately — undeploying it, or a test
 * cleaning up — and it is only safe once nothing else is using the directory.
 */
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
	// The clone gives a branch blob roots of its own, outside its directory, so removing only the
	// directory strands them -- and because they are hard links, the bytes survive the base deleting
	// its own copies. Only once the directory is actually gone: removing them while it survives (a
	// held handle, permissions) would leave a branch that still looks adoptable but whose allocator
	// restarts from an empty root and remints ids its own rows hold. Leaking them the other way round
	// is recoverable; that is not. Derived from the path, so a branch that never opened is cleaned up.
	if (!existsSync(branchPath)) await removeBlobRootsFor(branchStoreNameFor(branchPath));
	await pruneEmptyParents(branchRootOf(branchPath), branchPath);
}

/** `<storage>/`branches`/<app>/<db>` — the same identity `branchStoreName` composed on the way in. */
function branchStoreNameFor(branchPath: string): string {
	return branchStoreName(basename(dirname(branchPath)), basename(branchPath));
}

/**
 * Discard every branch this process has open, storage included. Deliberate removal only: a branch is
 * durable and is meant to survive restarts, so no shutdown path calls this.
 */
export async function removeBranches(): Promise<void> {
	for (const branchPath of [...branchesByPath.keys()]) await removeBranchAt(branchPath);
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
	branchedDatabases: string[] | true | undefined,
	loaderMode: string | undefined
): Promise<Map<string, BranchDatabase>> {
	const branches = new Map<string, BranchDatabase>();
	if (branchedDatabases === undefined) return branches;

	// The scoped `databases` binding is delivered through the module loader. Under `native` the
	// loader hands back the process-wide exports, so a branch would be created and then never
	// reached — the application would silently write the base.
	if (loaderMode === 'native') {
		throw new Error(
			`Application '${appName}' declares branchedDatabases but runs under the 'native' module loader, ` +
				`which cannot carry a scoped databases binding; use the default loader or remove branchedDatabases`
		);
	}
	// An explicitly empty list branches nothing, so it needs no engine capability.
	if (branchedDatabases !== true && !branchedDatabases.length) return branches;

	if ((process.env.HARPER_STORAGE_ENGINE || env.get(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb') {
		throw new Error(`Application '${appName}' declares branchedDatabases, which requires the RocksDB storage engine`);
	}

	getDatabases();
	if (branchedDatabases === true) {
		// A snapshot, not a subscription: this is every database that exists at THIS load. One created
		// afterward -- by another application, or by this one once schema declarations can target a
		// branch -- is not retroactively branched. `system` is excluded the same way an explicit
		// declaration of it is refused (assertBranchedDatabases): it carries the instance's own catalog,
		// users and jobs, not application data.
		branchedDatabases = Object.keys(databases).filter((name) => name !== 'system');
	}
	if (!branchedDatabases.length) return branches;
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
			const branchPath = resolveBranchPath(baseName, appName);
			const isNew = !branchesByPath.has(branchPath);
			branches.set(baseName, await getOrCreateBranch(baseName, appName));
			if (isNew) opened.push(branchPath);
		}
		// Only now: a relationship whose target this application also branched has to resolve to that
		// branch, and the whole set has to exist before any of them can resolve that way.
		for (const branch of branches.values()) hydrateBranchRelationships(branch, branches);
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
