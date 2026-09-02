import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import logger from '../utility/logging/harper_logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { commonValidators } from '../validation/common_validators.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { copyTree } from '../dataLayer/blobBackup.ts';
import { getBlobPathsForDatabaseName, getRootBlobPathsForDB } from './blob.ts';
import type { RocksDatabase } from '@harperfast/rocksdb-js';
import {
	type BranchDatabase,
	database,
	databases,
	getDatabases,
	hydrateBranchRelationships,
	isReadOnlyMode,
	openBranchDatabase,
	quarantineBranchIdentity,
	releaseBranchIdentity,
	reserveBranchIdentity,
	resolveBranchPath,
	retakeBranchIdentity,
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

const CLAIM_STATE = 0;
const CLAIM_PROGRESS = 1;

const MAX_NAME_LENGTH = commonValidators.schema_length.maximum;

/** How long a loser waits on a winner that reports NO progress before giving up on the branch; the
 *  winner's replay budget is added on top where the deadline is built (`openOrCreate`). Progress is
 *  reported per checkpoint and per cloned file, so that is the granularity this bounds: a single
 *  unit that takes longer than the budget still expires it, which needs a byte copy (no hard links)
 *  of one blob tens of gigabytes large. */
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

interface OpenBranch {
	branch: BranchDatabase;
	/** Reset on removal: the buffer outlives the directory, and a stale READY would make the next
	 *  caller skip materialization and then fail to open a directory that is no longer there. */
	claimState: BigInt64Array;
	/** What the handle resolves blobs through, so teardown deletes exactly what this branch owns. */
	blobRoots: string[];
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
	const seed = new BigInt64Array([UNCLAIMED, 0n]);
	return new BigInt64Array(baseStore.getUserSharedBuffer(`branch-claim:${branchPath}`, seed.buffer));
}

export function reportClaimProgress(state: BigInt64Array): void {
	Atomics.add(state, CLAIM_PROGRESS, 1n);
}

/**
 * A deadline that follows the winner's progress rather than the clock alone. The claim window covers a
 * hard-link clone of the base's entire blob tree, so any fixed budget is wrong for a large enough base:
 * every waiting thread's load fails while the winner is healthily copying, the winner then publishes,
 * and the next deploy succeeds -- so a real outage reads as a flap. Restarting the budget on each unit
 * of reported work bounds a winner that has STOPPED rather than one that is merely slow.
 */
export function claimDeadlineFor(state: BigInt64Array, budget: number): () => number {
	let seen = Atomics.load(state, CLAIM_PROGRESS);
	let at = Date.now() + budget;
	return () => {
		const progress = Atomics.load(state, CLAIM_PROGRESS);
		if (progress !== seen) {
			seen = progress;
			at = Date.now() + budget;
		}
		return at;
	};
}

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
async function cloneBlobRoots(
	baseName: string,
	baseRoots: string[],
	branchRoots: string[],
	progress: () => void
): Promise<void> {
	let substituted = 0;
	let copied = 0;
	// A row's `storageIndex` is a position in the branch's own list, and its marker records every entry.
	for (let index = 0; index < branchRoots.length; index++) {
		const staging = `${branchRoots[index]}.staging`;
		await rm(staging, { recursive: true, force: true });
		// Created up front rather than left to the walk: a base with no blobs at all copies nothing, and
		// the branch still needs its own (empty) root to exist so its allocator starts where the base's
		// would have.
		await mkdir(staging, { recursive: true });
		const source = baseRoots[index];
		if (source) {
			const counts = await copyTree(
				source,
				staging,
				true,
				{
					gone: 'blob was already reclaimed from the base when this branch was created',
					pending: 'blob was still being written to the base when this branch was created',
				},
				progress
			);
			substituted += counts.substituted;
			copied += counts.copied;
		}
		await rm(branchRoots[index], { recursive: true, force: true });
		await mkdir(dirname(branchRoots[index]), { recursive: true });
		await rename(staging, branchRoots[index]);
		progress();
	}
	if (substituted > 0) {
		logger.warn?.(
			`Branch of '${baseName}' substituted ${substituted} blob file(s) with markers because they were ` +
				`mid-write or already reclaimed when it was created; reads of those blobs in the branch will fail`
		);
	}
	if (copied > 0) {
		// The hard link is the whole design: without it the branch is a second full copy of the base's
		// blobs, taken while the application is loading, and nothing else in the log would say so.
		logger.warn?.(
			`Branch of '${baseName}' could not hard-link ${copied} blob file(s) and copied their bytes instead; ` +
				`on a filesystem without hard links a branch costs a full copy of the base's blobs, in disk and ` +
				`in the time every application load that creates one takes`
		);
	}
}

/**
 * Remove the given blob roots and any staging siblings left by an interrupted clone. The roots are
 * passed in rather than re-derived, because a published branch owns exactly what its completion
 * marker recorded: deriving them from current configuration would let a `storage.blobPaths` entry
 * added since -- one that may already hold a `<storeName>` directory restored from elsewhere --
 * be deleted by a branch that never wrote it.
 *
 * Reports whether every removal succeeded, because a root left behind still belongs to this
 * identity and the caller must not hand the name back while it does.
 */
async function removeBlobRoots(roots: string[]): Promise<boolean> {
	let removed = true;
	for (const root of roots) {
		for (const target of [root, `${root}.staging`]) {
			await rm(target, { recursive: true, force: true }).catch((error) => {
				removed = false;
				logger.warn?.(`Could not remove branch blob root ${target}`, error);
			});
		}
	}
	return removed;
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
	/** `blobRoots` is what was published with it, and what the branch stays pinned to while it is open. */
	| { state: 'complete'; blobRoots: string[] }
	/** Was published complete; part of what it recorded is gone or no longer matches the config.
	 *  `blobRoots` is still what it recorded, and so still the only list a removal may delete. */
	| { state: 'damaged'; problem: string; blobRoots: string[] };

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
	// An empty list would pass the prefix check below and pin the branch to no roots at all, so the
	// first blob write would fail on an undefined path instead of here, where it can say why.
	if (
		recorded == null ||
		!Array.isArray(recorded.blobRoots) ||
		recorded.blobRoots.length === 0 ||
		recorded.blobRoots.some((r) => typeof r !== 'string')
	) {
		// Same split as an unreadable marker above: refuse anything carrying store data, but a directory
		// holding nothing but a bad marker has nothing to lose and must stay clearable.
		return looksLikeAStore ? { state: 'unmarked', why: 'its completion marker is malformed' } : { state: 'debris' };
	}
	const configured = getBlobPathsForDatabaseName(storeName);
	// By index, not by set: `storageIndex` on a row is a position in this list, so a reordered
	// `storage.blobPaths` would silently resolve every row through the wrong root. A configured list
	// that only GREW leaves every recorded index exactly where it was, which is why an appended volume
	// is compatible where a removed, reordered or replaced one is not -- the branch goes on resolving
	// through what it recorded, so the appended root is simply never its.
	if (recorded.blobRoots.length > configured.length || recorded.blobRoots.some((root, i) => root !== configured[i])) {
		return {
			state: 'damaged',
			problem:
				`its blob roots no longer match the configured storage.blobPaths ` +
				`(recorded ${JSON.stringify(recorded.blobRoots)}, configured ${JSON.stringify(configured)})`,
			blobRoots: recorded.blobRoots,
		};
	}
	const missing = recorded.blobRoots.filter((root) => !existsSync(root));
	return missing.length
		? { state: 'damaged', problem: `blob root(s) are missing: ${missing.join(', ')}`, blobRoots: recorded.blobRoots }
		: { state: 'complete', blobRoots: recorded.blobRoots };
}

function warnAboutUnusedBlobRoots(branchPath: string, storeName: string, blobRoots: string[]): void {
	const configured = getBlobPathsForDatabaseName(storeName);
	if (blobRoots.length < configured.length) {
		logger.warn?.(
			`Branch database at ${branchPath} keeps the ${blobRoots.length} blob root(s) it was published ` +
				`with; the ${configured.length - blobRoots.length} storage.blobPaths entry(ies) added since are ` +
				`not used by it. Its rows address roots by position, so only a branch rebuilt from the base ` +
				`can take the added capacity.`
		);
	}
}

/**
 * Take the checkpoint into a temporary sibling and rename it into place, so a crash mid-copy leaves
 * debris rather than a half-populated directory that RocksDB would then refuse to open. Reports the
 * blob roots the marker records, which is what the branch is then pinned to.
 */
async function materializeBranch(
	baseName: string,
	branchPath: string,
	storeName: string,
	report: { progress: () => void; strandedRoots: () => void }
): Promise<string[]> {
	const staging = `${branchPath}.staging`;
	const blobRoots = getBlobPathsForDatabaseName(storeName);
	// Publishing an empty root list would record a marker no later load can accept, bricking the branch
	// on every subsequent boot instead of failing here, where the configuration is the visible problem.
	if (blobRoots.length === 0) {
		throw new Error(
			`Cannot create the branch at ${branchPath}: storage.blobPaths is configured with no entries, so ` +
				`the branch has nowhere of its own to keep blobs`
		);
	}
	const base = database({ database: baseName, table: undefined });
	// What the base's own rows resolve through, which is not the configured list if `storage.blobPaths`
	// changed while its store was open. Refuse before taking a checkpoint: the configuration already
	// proves that publishing this clone would leave rows on an omitted volume unreadable.
	const baseRoots = getRootBlobPathsForDB(base as never);
	if (baseRoots.length > blobRoots.length) {
		throw new Error(
			`Cannot create a branch of '${baseName}': the open base resolves through ${baseRoots.length} blob ` +
				`root(s), but storage.blobPaths now provides ${blobRoots.length}; publishing the branch would ` +
				`make rows on the omitted volume(s) unreadable`
		);
	}
	await rm(staging, { recursive: true, force: true });
	await mkdir(dirname(branchPath), { recursive: true });
	try {
		await base.createCheckpoint(staging);
		report.progress();
		await cloneBlobRoots(baseName, baseRoots, blobRoots, report.progress);
		await writeFile(join(staging, COMPLETION_MARKER), JSON.stringify({ blobRoots } satisfies BranchCompletion));
		await rename(staging, branchPath);
		return blobRoots;
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
		// The blob roots too, staging siblings included: a clone that failed partway leaves the roots it
		// already published and nothing owns them once this attempt is abandoned. Only safe because this
		// branch never became complete -- one that did is never rebuilt, so this cannot remove the last
		// copy of anything.
		// Surviving roots still hold this identity's files, so the caller must not release the name.
		if (!(await removeBlobRoots(blobRoots))) report.strandedRoots();
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
	if (isShared(state)) Atomics.notify(state, CLAIM_STATE);
}

/** Wait until the claim leaves CREATING, and report the state it settled on. */
async function awaitClaim(state: BigInt64Array, branchPath: string, deadline: () => number): Promise<bigint> {
	// A progress-extended deadline has no ceiling, so a wait past the original budget must say why it is
	// still waiting rather than reading as a hang with no thread to point at.
	const patience = deadline();
	let announced = false;
	for (;;) {
		const current = Atomics.load(state, CLAIM_STATE);
		if (current !== CREATING) return current;
		const remaining = deadline() - Date.now();
		if (remaining <= 0) throw new Error(`Timed out waiting for another thread to create the branch at ${branchPath}`);
		// After the timeout check, and only once the deadline itself has moved: on the clock alone this
		// would claim the winner is alive on the very turn the wait gives up on it.
		if (!announced && Date.now() > patience && deadline() > patience) {
			announced = true;
			logger.warn?.(
				`Still waiting for another thread to create the branch at ${branchPath}; it is reporting ` +
					`progress, so this wait is extended for as long as it keeps doing so`
			);
		}
		const slice = Math.min(remaining, 1000);
		if (isShared(state)) {
			const wait = (Atomics as any).waitAsync(state, CLAIM_STATE, CREATING, slice);
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
	// An abandoned attempt whose roots could not be removed does not hand the name back to a DATABASE:
	// those roots still hold this identity's files, and a database created under the name would resolve
	// its own new ids onto them. The branch may still retake it, which is what repairs the condition.
	let blobRootsStranded = false;
	try {
		// The claim's CREATING window now covers the winner's replay as well as its checkpoint, so
		// waiters must outlast the replay budget too, or a merely slow (but live) recovery would time
		// out every other thread's application load minutes before the winner publishes READY. The
		// clone in between is unbounded in the base's size, which is why the budget follows progress.
		const deadline = claimDeadlineFor(claimState, CLAIM_TIMEOUT_MS + replayTimeBudgetMs());
		for (;;) {
			// The deadline bounds the whole protocol, not just a single wait: an unexpected state word --
			// a future state, a buffer another version wrote -- must fail this load, never spin forever.
			if (Date.now() > deadline()) throw new Error(`Timed out claiming the branch at ${branchPath}`);
			const previous = Atomics.compareExchange(claimState, CLAIM_STATE, UNCLAIMED, CREATING);
			if (previous === READY) break;
			if (previous === UNCLAIMED) {
				let branch: BranchDatabase | undefined;
				let blobRoots: string[] = [];
				try {
					// Adopt rather than recreate: the branch outlives the process that first made it, so on
					// every restart after the first the directory is already here. What it is, though, is a
					// question -- the blob roots are published separately from the directory, so existence
					// alone proves nothing and the marker is what has to be read.
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
					if (existing.state === 'complete') {
						blobRoots = existing.blobRoots;
						warnAboutUnusedBlobRoots(branchPath, storeName, blobRoots);
					} else {
						// Absent, or leftovers that are not a store: nothing here can be lost.
						await rm(branchPath, { recursive: true, force: true });
						blobRoots = await materializeBranch(baseName, branchPath, storeName, {
							progress: () => reportClaimProgress(claimState),
							strandedRoots: () => (blobRootsStranded = true),
						});
					}
					releaseBranchIdentity(storeName);
					branch = openBranchDatabase(branchPath, baseName, storeName, blobRoots);
					// The branch's column families write with the WAL disabled, so writes since its last
					// memtable flush exist only in its own transaction log — which a process that died
					// without the exit-time flush (a crash, a Windows hard kill) always leaves behind.
					// Replay must finish before READY, because READY is what releases the other threads to
					// serve reads. A fresh checkpoint carries no transaction_logs (verified: the native
					// checkpoint copies only RocksDB files), so replay after materialize is a no-op; the
					// read-only skip mirrors the base's boot replay.
					if (!isReadOnlyMode()) await replayLogs(branch.rootStore as RocksDatabase, branch.tables, true);
					Atomics.store(claimState, CLAIM_STATE, READY);
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
					Atomics.store(claimState, CLAIM_STATE, UNCLAIMED);
					throw error;
				} finally {
					wakeWaiters(claimState);
				}
				handedOver = true;
				return { branch, claimState, blobRoots };
			}
			// Someone else holds it. A wait that settles on UNCLAIMED means they failed and released, so
			// take another turn at being the one who creates it.
			if ((await awaitClaim(claimState, branchPath, deadline)) === READY) break;
		}
		// This thread never read the branch it is adopting, and a branch resolves blob ids through the
		// roots its marker names, so the marker has to be read here too rather than pinned only on the
		// thread that won the claim.
		const published = readBranchState(branchPath, storeName);
		if (published.state !== 'complete') {
			throw new Error(
				`Branch database at ${branchPath} was published by another thread but no longer reads as ` +
					`complete: ${published.state === 'damaged' ? published.problem : published.state === 'unmarked' ? published.why : published.state}`
			);
		}
		warnAboutUnusedBlobRoots(branchPath, storeName, published.blobRoots);
		// Released immediately before the open, with no `await` in between, so nothing can slip into the
		// gap -- and so `openBranchDatabase`'s check stays strict rather than being taught to ignore a
		// reservation, which would also make it ignore a DIFFERENT branch holding the same name.
		releaseBranchIdentity(storeName);
		const adopted = openBranchDatabase(branchPath, baseName, storeName, published.blobRoots);
		handedOver = true;
		return { branch: adopted, claimState, blobRoots: published.blobRoots };
	} finally {
		// `openBranchDatabase` takes the identity over for the life of the handle; anything short of
		// that has to hand it back, or the application can never load again in this process.
		if (!handedOver) {
			if (blobRootsStranded) quarantineBranchIdentity(storeName);
			else releaseBranchIdentity(storeName);
		}
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
	const storeName = branchStoreNameFor(branchPath);
	// What this branch owns is what it published, not what is configured now: an entry appended to
	// `storage.blobPaths` since may already hold a `<storeName>` directory this branch never wrote.
	// The open handle is already pinned to them; otherwise the marker still on disk names them.
	const blobRoots = opened?.blobRoots ?? recordedBlobRootsAt(branchPath, storeName);
	// The identity has to be held for every deletion below, not just checked before them:
	// `isBranchIdentity` is what stops `table()` claiming this name, and once the directory is gone its
	// on-disk half sees nothing either, so the reservation is the only thing left holding the name while
	// the blob roots are still being removed.
	let holdsIdentity = true;
	let blobRootsStranded = false;
	if (opened) {
		opened.branch.close();
		// Same turn as the close that released it, so nothing can slip into the gap.
		retakeBranchIdentity(storeName);
		Atomics.store(opened.claimState, CLAIM_STATE, UNCLAIMED);
		wakeWaiters(opened.claimState);
	} else {
		// Never opened here, so the name has to be claimed outright. Failing means something else already
		// answers to it, and then the blob root it resolves to is not ours to delete.
		try {
			reserveBranchIdentity(storeName);
		} catch (error) {
			holdsIdentity = false;
			logger.warn?.(`Leaving the blob roots of the branch at ${branchPath} in place: its identity is in use`, error);
		}
	}
	try {
		await rm(branchPath, { recursive: true, force: true }).catch((error) =>
			logger.warn?.(`Could not remove branch directory ${branchPath}`, error)
		);
		// The clone gives a branch blob roots of its own, outside its directory, so removing only the
		// directory strands them -- and because they are hard links, the bytes survive the base deleting
		// its own copies. Only once the directory is actually gone: removing them while it survives (a
		// held handle, permissions) would leave a branch that still looks adoptable but whose allocator
		// restarts from an empty root and remints ids its own rows hold. Leaking them the other way round
		// is recoverable; that is not.
		if (holdsIdentity && !existsSync(branchPath)) {
			// A root that survived still holds this branch's blob files, so the name is not handed back to
			// a database: one taking it would resolve its own new file ids onto them.
			if (!(await removeBlobRoots(blobRoots))) {
				blobRootsStranded = true;
				logger.warn?.(
					`Refusing '${storeName}' to new databases on this worker for the life of the process: the ` +
						`branch at ${branchPath} left blob files behind and a database under that name would ` +
						`resolve onto them. Other workers no longer see the branch directory, so remove those ` +
						`files by hand to make the name safe again`
				);
			}
		}
		await pruneEmptyParents(branchRootOf(branchPath), branchPath);
	} finally {
		if (holdsIdentity) {
			if (blobRootsStranded) quarantineBranchIdentity(storeName);
			else releaseBranchIdentity(storeName);
		}
	}
}

/**
 * The roots a branch on disk recorded, falling back to configuration only for one that never
 * published a usable marker -- an abandoned materialization, whose roots ARE the configured ones.
 */
function recordedBlobRootsAt(branchPath: string, storeName: string): string[] {
	const published = readBranchState(branchPath, storeName);
	const configured = getBlobPathsForDatabaseName(storeName);
	// A marker that reads as damaged still names what this branch published, and only a branch with no
	// usable marker at all leaves configuration as the best answer. Nothing outside this node's
	// configured volumes is deleted either way: a branch directory carried over from a host configured
	// differently names paths this node never wrote.
	return published.state === 'complete' || published.state === 'damaged'
		? published.blobRoots.filter((root) => configured.includes(root))
		: configured;
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
