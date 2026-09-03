'use strict';

import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tryFileLock, fileLockRelease } from '@harperfast/rocksdb-js';

/**
 * Lifecycle lock + marker protocol for the two operations that destroy a RocksDB database directory:
 * restore (online operation and offline CLI) and drop. Both take the same per-database lock and
 * write the same marker file, typed by its second line, so a drop and a restore can never mutate
 * the same directory concurrently, every thread's rescan skips a database while either is in
 * flight, and a crash leaves a marker that says which recovery applies: rerun the restore, or finish
 * deleting the database (`recoverInterruptedDrop`).
 *
 * Restore metadata lives in an isolated `` `restore` `` directory *beside* the database directory
 * (never inside it, since a restore purges the destination). Each database's two files are keyed by
 * a hash of the database directory name rather than being suffixed onto the name itself. That keeps
 * them out of the database-name namespace — a legal database literally named `orders.restoring`
 * would otherwise be mistaken for the restore marker of `orders`, and a 250-character name plus a
 * `.restore.lock` suffix would exceed the 255-byte `NAME_MAX` on most filesystems. The directory
 * name deliberately contains a backtick: `schemaRegex` (the database-name validator) forbids only
 * `/` and `` ` `` among filesystem-legal characters, so no legal database can ever occupy this path
 * — including a database literally named `.restore` (which *is* a legal name, so a plain `.restore`
 * directory would collide with it and land the markers inside the live database). The directory is
 * not itself a RocksDB/LMDB database (no `CURRENT`/`MANIFEST-`/`.mdb`), so the startup scan ignores
 * it, and no user can create a database that resolves to it.
 *
 * - `<meta-dir>/<key>.lock` — an OS-level exclusive file lock (via rocksdb-js `tryFileLock`),
 *   effective across processes, containers, and worker threads, auto-released on process exit.
 *   Only *held-ness* is meaningful; the file itself persists after release (harmless). Held for the
 *   duration of a restore, and briefly by `dropDatabase` so the two serialize on the same primitive.
 *   Known limitation: the lock is owned by the process, so if the restore job's worker *thread*
 *   dies without the process exiting, the lock stays held (restores 409) until Harper restarts.
 * - `<meta-dir>/<key>.restoring` — the completion marker. Written (and fsynced) after the lock is
 *   acquired and before the destructive restore begins; deleted only after the restore completes
 *   successfully, while still holding the lock. Its *existence* means "a restore started and has
 *   not finished successfully". Its first line records the database directory name so the startup
 *   scan can map a marker back to the database it blocks without decoding the hashed key.
 */

// The backtick makes this an illegal database name (schemaRegex rejects `/` and backtick only), so
// it can never collide with a real database directory — see the module header.
export const RESTORE_META_DIR = '`restore`';
export const RESTORE_LOCK_SUFFIX = '.lock';
export const RESTORING_MARKER_SUFFIX = '.restoring';

/**
 * Directory holding the restore metadata for a database — the reserved `` `restore` `` sibling of
 * the database directory (see the module header for why the name contains a backtick). Shared by
 * every database under the same parent, so a single readdir surfaces all pending restores during
 * the startup scan.
 */
export function restoreMetaDir(dbPath: string): string {
	return join(dirname(dbPath), RESTORE_META_DIR);
}

/**
 * Filesystem-safe, length-bounded key for a database's restore metadata files. Hashing the
 * database directory name (not the full path, so it is stable regardless of where the databases
 * root lives) keeps the metadata filenames short and collision-free while staying independent of
 * the database-name namespace. Database directory names are unique within a databases root, so
 * their hashes are too.
 */
function restoreMetaKey(dbPath: string): string {
	return createHash('sha256').update(basename(dbPath)).digest('hex').slice(0, 32);
}

export function restoreLockPath(dbPath: string): string {
	return join(restoreMetaDir(dbPath), restoreMetaKey(dbPath) + RESTORE_LOCK_SUFFIX);
}

export function restoringMarkerPath(dbPath: string): string {
	return join(restoreMetaDir(dbPath), restoreMetaKey(dbPath) + RESTORING_MARKER_SUFFIX);
}

export type RestoreState = 'in-progress' | 'incomplete' | 'clear';
export type LifecycleKind = 'restore' | 'drop';

function markerContent(dbPath: string, kind: LifecycleKind): string {
	// first line is the database directory name so the startup scan can map this marker back to
	// the database it blocks without reversing the hashed key; the second names the operation
	return `${basename(dbPath)}\n${kind} started ${new Date().toISOString()}\n`;
}

/** Markers written before drops were typed carry only a restore line, and read as restores. */
function markerKindFromContent(content: string): LifecycleKind {
	return content.split('\n', 2)[1]?.startsWith('drop ') ? 'drop' : 'restore';
}

/** The kind of the lifecycle marker on `dbPath`, or null when there is none. */
export function lifecycleMarkerKind(dbPath: string): LifecycleKind | null {
	try {
		return markerKindFromContent(readFileSync(restoringMarkerPath(dbPath), 'utf8'));
	} catch (error: any) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * Whether a `.restoring` marker exists for a database. Cheaper than `checkRestoreState` and, unlike
 * it, safe to call while *this* thread holds the restore lock: `checkRestoreState` would re-probe
 * the lock (which reads as held from the same thread) and report 'in-progress' rather than telling
 * a caller that a *leftover* marker is present. `dropDatabase` uses this after acquiring the lock to
 * distinguish debris from a crashed restore.
 */
export function restoreMarkerPresent(dbPath: string): boolean {
	return existsSync(restoringMarkerPath(dbPath));
}

/** The lock and (optional) marker held by a begin/acquire call, threaded back to complete/abandon. */
export type RestoreLock = {
	/** rocksdb-js file-lock token; non-zero. */
	token: number;
	/** The database directory this lock guards. */
	dbPath: string;
	/**
	 * True when a `.restoring` marker already existed at `beginRestore` time — i.e. this restore is a
	 * recovery attempt over a possibly half-purged directory. A pre-existing marker must never be
	 * cleared by a *failed* recovery attempt, or the directory could be reloaded as healthy while
	 * still partial. Only set on `beginRestore`; always false for a bare `acquireRestoreLock`.
	 */
	preexisting: boolean;
};

/**
 * Determine the restore state of a database directory. Used by startup database detection and
 * the open-database guards:
 * - 'in-progress': marker present and the restore lock is held (a restore is running in some
 *   process) — do not load.
 * - 'incomplete': marker present but the lock is free (crashed mid-restore; the directory may
 *   be partial garbage) — do not load; rerun the restore.
 * - 'clear': no marker — load normally (a stale, unheld lock file alone is fine).
 *
 * The marker is checked FIRST and the lock is only probed when the marker exists. Probing takes
 * and releases the flock, and probes are mutually exclusive across threads — if every rescan on
 * every thread probed the (persistent) lock file of a long-ago-restored database, concurrent
 * rescans would collide and misclassify healthy databases as 'in-progress'. Marker-first is
 * safe: `beginRestore` writes (and fsyncs) the marker immediately after taking the lock and
 * before any destructive step, so a database without a marker has nothing to protect yet.
 */
export function checkRestoreState(dbPath: string): RestoreState {
	if (!existsSync(restoringMarkerPath(dbPath))) return 'clear';
	const lockPath = restoreLockPath(dbPath);
	if (existsSync(lockPath)) {
		const token = tryFileLock(lockPath);
		if (token === 0) return 'in-progress';
		fileLockRelease(token);
	}
	return 'incomplete';
}

/**
 * fsync a directory so a create/unlink of an entry within it is durable. Best-effort: Windows (and
 * some filesystems) reject opening a directory for fsync with EPERM/EISDIR/ENOTSUP — the durability
 * flush is a POSIX nicety, so treat those as a no-op rather than failing the restore.
 */
function fsyncDir(dir: string): void {
	let dirFd: number;
	try {
		dirFd = openSync(dir, 'r');
	} catch (error: any) {
		if (error.code === 'EPERM' || error.code === 'EISDIR' || error.code === 'ENOTSUP') return;
		throw error;
	}
	try {
		fsyncSync(dirFd);
	} catch (error: any) {
		// Windows opens the directory but refuses to flush it (EPERM); same no-op as an unopenable one
		if (error.code !== 'EPERM' && error.code !== 'EISDIR' && error.code !== 'ENOTSUP' && error.code !== 'EINVAL')
			throw error;
	} finally {
		closeSync(dirFd);
	}
}

/**
 * Take the per-database restore lock without writing a marker. Used by `dropDatabase` so a drop and
 * a restore serialize on the same primitive: whichever takes the lock first runs to completion; the
 * other gets a 409. Throws (statusCode 409) if the lock is already held.
 */
export function acquireRestoreLock(dbPath: string): RestoreLock {
	mkdirSync(restoreMetaDir(dbPath), { recursive: true });
	const token = tryFileLock(restoreLockPath(dbPath));
	if (token === 0) {
		const error: any = new Error(`Restore already in progress for database at ${dbPath}`);
		error.statusCode = 409;
		throw error;
	}
	return { token, dbPath, preexisting: false };
}

/**
 * Release a lock taken by `acquireRestoreLock` (no marker to remove).
 */
export function releaseRestoreLock(lock: RestoreLock): void {
	fileLockRelease(lock.token);
}

/**
 * Acquire the per-database restore lock and write the restoring marker. Call before any
 * destructive step. Returns the lock (with `preexisting` set when a marker was already present, so
 * a failed recovery attempt knows not to clear it). Throws (statusCode 409) if another restore
 * already holds the lock.
 */
export function beginRestore(dbPath: string): RestoreLock {
	return beginLifecycle(dbPath, 'restore');
}

/**
 * Acquire the per-database lock and write a drop marker. From here until `completeDrop`, every
 * thread's rescan skips the database and an on-demand open of it is refused; a crash leaves the
 * marker for `recoverInterruptedDrop` to finish the deletion.
 */
export function beginDrop(dbPath: string): RestoreLock {
	return beginLifecycle(dbPath, 'drop');
}

function beginLifecycle(dbPath: string, kind: LifecycleKind): RestoreLock {
	const markerPath = restoringMarkerPath(dbPath);
	const preexisting = existsSync(markerPath);
	const lock = acquireRestoreLock(dbPath);
	try {
		const fd = openSync(markerPath, 'w');
		try {
			writeSync(fd, markerContent(dbPath, kind));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// fsync the metadata directory so the marker's directory entry is durable — without this a
		// power loss can lose the entry, and a half-purged database would load as healthy
		fsyncDir(restoreMetaDir(dbPath));
	} catch (error) {
		fileLockRelease(lock.token);
		throw error;
	}
	return { ...lock, preexisting };
}

/**
 * Mark the restore successful: delete the marker (while still holding the lock), then release
 * the lock.
 */
export function completeRestore(lock: RestoreLock): void {
	try {
		unlinkSync(restoringMarkerPath(lock.dbPath));
		// fsync the metadata directory so the marker's *removal* is durable — symmetric with the
		// creation fsync in beginRestore. Without it, a power loss could resurrect the marker's
		// directory entry and misclassify a fully-restored database as incomplete.
		fsyncDir(restoreMetaDir(lock.dbPath));
	} finally {
		fileLockRelease(lock.token);
	}
}

/**
 * Release the lock after a failed restore, leaving the marker in place so the database is
 * detected as an incomplete restore (and not loaded) until a rerun succeeds.
 */
export function abandonRestore(lock: RestoreLock): void {
	fileLockRelease(lock.token);
}

/** Mark the drop complete: the marker goes only after the database and its blob roots are gone. */
export const completeDrop = completeRestore;
/** Release the lock after a failed drop; the marker stays so the next scan finishes the deletion. */
export const abandonDrop = abandonRestore;

export type DropRecoveryOutcome = 'recovered' | 'in-progress' | 'not-a-drop';

const LEGAL_DIRECTORY_NAME = /^(?!\.\.?$)[^\\/\0]+$/;

function isSymbolicLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (error: any) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * Finish a drop that was interrupted after its marker was written: delete the database directory
 * and its blob roots, then the marker, all while holding the database's lock — so two threads (or
 * processes) scanning the same root cannot both delete, and a restore or create cannot start on the
 * directory mid-deletion. The marker is untrusted input for a deletion: the name it carries must be
 * a single legal directory name whose marker key matches, and neither the database directory nor a
 * blob root may be a symbolic link. Any failure leaves the marker in place for the next scan.
 *
 * `blobRoots` come from configuration (`getBlobPathsForDatabaseName`); `remove` is injectable for
 * tests.
 */
export function recoverInterruptedDrop(
	databasesRoot: string,
	dbName: string,
	options: { blobRoots: string[]; remove?: (path: string) => void }
): DropRecoveryOutcome {
	if (!LEGAL_DIRECTORY_NAME.test(dbName)) throw new Error(`Refusing to recover a drop marker naming '${dbName}'`);
	const root = resolve(databasesRoot);
	const dbPath = resolve(root, dbName);
	if (dirname(dbPath) !== root || !dbPath.startsWith(root + sep)) {
		throw new Error(`Refusing to recover a drop of '${dbName}': it does not resolve to a database directory`);
	}
	const remove = options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
	mkdirSync(restoreMetaDir(dbPath), { recursive: true });
	const token = tryFileLock(restoreLockPath(dbPath));
	if (token === 0) return 'in-progress';
	try {
		const markerPath = restoringMarkerPath(dbPath);
		let content: string;
		try {
			content = readFileSync(markerPath, 'utf8');
		} catch (error: any) {
			if (error.code === 'ENOENT') return 'recovered'; // finished by whoever held the lock before us
			throw error;
		}
		if (markerKindFromContent(content) !== 'drop') return 'not-a-drop';
		if (content.split('\n', 1)[0] !== dbName) {
			throw new Error(`Refusing to recover a drop of '${dbName}': its marker names a different database`);
		}
		assertDropTargetsRemovable(dbPath, options.blobRoots);
		remove(dbPath);
		for (const blobRoot of options.blobRoots) remove(blobRoot);
		fsyncDropRemovals(dbPath, options.blobRoots);
		unlinkSync(markerPath);
		fsyncDir(restoreMetaDir(dbPath));
		return 'recovered';
	} finally {
		fileLockRelease(token);
	}
}

/** A database directory or blob root that is a symbolic link is not the database: refuse to delete through it. */
export function assertDropTargetsRemovable(dbPath: string, blobRoots: string[]): void {
	if (isSymbolicLink(dbPath)) throw new Error(`Refusing to delete '${dbPath}': it is a symbolic link`);
	for (const blobRoot of blobRoots) {
		if (isSymbolicLink(blobRoot)) throw new Error(`Refusing to delete blob root '${blobRoot}': it is a symbolic link`);
	}
}

/**
 * The directory removals must be durable before the marker's removal is, or a power loss can bring
 * the database entry back with no marker to finish it.
 */
export function fsyncDropRemovals(dbPath: string, blobRoots: string[]): void {
	fsyncDir(dirname(dbPath));
	for (const blobRoot of blobRoots) {
		if (existsSync(dirname(blobRoot))) fsyncDir(dirname(blobRoot));
	}
}

/**
 * The online half of what `recoverInterruptedDrop` does at boot: remove what is left of a dropped
 * database's directory and its blob roots, durably, and fail on the first removal that does not
 * succeed — the caller then keeps its marker for the next scan to finish the deletion, instead of
 * reporting a drop complete with blobs still on disk. `remove` is injectable for tests.
 */
export async function removeDroppedDatabaseFiles(
	dbPath: string,
	blobRoots: string[],
	remove: (path: string) => Promise<void> = removeSteadily
): Promise<void> {
	assertDropTargetsRemovable(dbPath, blobRoots);
	await remove(dbPath);
	for (const blobRoot of blobRoots) await remove(blobRoot);
	fsyncDropRemovals(dbPath, blobRoots);
}

/**
 * Recursively remove a directory one entry at a time, unlike a single `rm(path, {recursive:true})`:
 * that one call runs as a single task on Node's (four-thread-by-default) libuv threadpool, so a
 * database or blob root with very many files stalls every other queued fs operation in the process
 * for as long as it takes. Iterating hands the event loop back between entries. Unlike
 * `resources/blob.ts`'s `rimrafSteadily` (which logs and continues past a failed file, appropriate
 * for a best-effort sweep), this throws on the first failure — the caller (`removeDroppedDatabaseFiles`)
 * depends on that to decide whether it may clear the drop marker.
 */
async function removeSteadily(path: string): Promise<void> {
	let entries;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch (error: any) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		const entryPath = join(path, entry.name);
		try {
			if (entry.isDirectory()) await removeSteadily(entryPath);
			else await unlink(entryPath);
		} catch (error: any) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	try {
		await rmdir(path);
	} catch (error: any) {
		if (error.code !== 'ENOENT') throw error;
	}
}

/**
 * Remove a database's restore marker if one is present, then release the lock. Used by
 * `dropDatabase`: a dropped database that carried an incomplete-restore marker should not leave the
 * marker behind to block a future database of the same name. No-op on the marker if none exists.
 */
export function clearRestoreMarker(lock: RestoreLock): void {
	try {
		const markerPath = restoringMarkerPath(lock.dbPath);
		if (existsSync(markerPath)) {
			unlinkSync(markerPath);
			fsyncDir(restoreMetaDir(lock.dbPath));
		}
	} finally {
		fileLockRelease(lock.token);
	}
}

export interface LifecycleMarkerEntry {
	dbName: string;
	state: 'in-progress' | 'incomplete';
	kind: LifecycleKind;
}

/**
 * Scan a databases root's reserved `` `restore` `` metadata directory and report every database currently blocked from
 * loading, mapping each surviving marker back to its database name via the marker's first line.
 * A marker whose key does not match the name it carries is ignored: the name is what a recovery
 * would delete, so it is only trusted when the file was written for that database. Markers whose
 * state is `clear` were removed concurrently and their databases are loadable.
 */
export function scanLifecycleMarkers(databasesRoot: string): LifecycleMarkerEntry[] {
	const metaDir = join(databasesRoot, RESTORE_META_DIR);
	if (!existsSync(metaDir)) return [];
	const blocked: LifecycleMarkerEntry[] = [];
	for (const entry of readdirSync(metaDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(RESTORING_MARKER_SUFFIX)) continue;
		let content: string;
		try {
			content = readFileSync(join(metaDir, entry.name), 'utf8');
		} catch {
			continue; // marker removed concurrently
		}
		const dbName = content.split('\n', 1)[0];
		if (!dbName) continue;
		const dbPath = join(databasesRoot, dbName);
		if (entry.name !== restoreMetaKey(dbPath) + RESTORING_MARKER_SUFFIX) continue;
		const state = checkRestoreState(dbPath);
		if (state !== 'clear') blocked.push({ dbName, state, kind: markerKindFromContent(content) });
	}
	return blocked;
}

export function scanBlockedRestores(databasesRoot: string): Array<[string, RestoreState]> {
	return scanLifecycleMarkers(databasesRoot).map(({ dbName, state }) => [dbName, state]);
}
