'use strict';

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tryFileLock, fileLockRelease } from '@harperfast/rocksdb-js';

/**
 * Restore lock + marker protocol for RocksDB database restores (online operation and offline CLI),
 * and the shared per-database exclusion used by `dropDatabase` so a drop and a restore can never
 * mutate the same directory concurrently.
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
 * - `<.restore>/<key>.lock` — an OS-level exclusive file lock (via rocksdb-js `tryFileLock`),
 *   effective across processes, containers, and worker threads, auto-released on process exit.
 *   Only *held-ness* is meaningful; the file itself persists after release (harmless). Held for the
 *   duration of a restore, and briefly by `dropDatabase` so the two serialize on the same primitive.
 *   Known limitation: the lock is owned by the process, so if the restore job's worker *thread*
 *   dies without the process exiting, the lock stays held (restores 409) until Harper restarts.
 * - `<.restore>/<key>.restoring` — the completion marker. Written (and fsynced) after the lock is
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
 * Directory holding the restore metadata for a database — a `.restore/` sibling of the database
 * directory. Shared by every database under the same parent, so a single readdir surfaces all
 * pending restores during the startup scan.
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
	const markerPath = restoringMarkerPath(dbPath);
	const preexisting = existsSync(markerPath);
	const lock = acquireRestoreLock(dbPath);
	try {
		const fd = openSync(markerPath, 'w');
		try {
			// first line is the database directory name so the startup scan can map this marker back to
			// the database it blocks without reversing the hashed key
			writeSync(fd, `${basename(dbPath)}\nrestore started ${new Date().toISOString()}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// fsync the .restore directory so the marker's directory entry is durable — without this a
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
		// fsync the .restore directory so the marker's *removal* is durable — symmetric with the
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

/**
 * Scan a databases root's `.restore/` directory and report every database currently blocked from
 * loading, mapping each surviving marker back to its database name via the marker's first line.
 * Returns `[dbName, state]` pairs for markers whose state is `in-progress` or `incomplete`
 * (a `clear` result means the marker was removed concurrently and the database is loadable).
 */
export function scanBlockedRestores(databasesRoot: string): Array<[string, RestoreState]> {
	const metaDir = join(databasesRoot, RESTORE_META_DIR);
	if (!existsSync(metaDir)) return [];
	const blocked: Array<[string, RestoreState]> = [];
	for (const entry of readdirSync(metaDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(RESTORING_MARKER_SUFFIX)) continue;
		let dbName: string;
		try {
			dbName = readFileSync(join(metaDir, entry.name), 'utf8').split('\n', 1)[0];
		} catch {
			continue; // marker removed concurrently
		}
		if (!dbName) continue;
		const state = checkRestoreState(join(databasesRoot, dbName));
		if (state !== 'clear') blocked.push([dbName, state]);
	}
	return blocked;
}
