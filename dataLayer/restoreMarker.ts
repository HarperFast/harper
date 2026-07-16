'use strict';

import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { tryFileLock, fileLockRelease } from '@harperfast/rocksdb-js';

/**
 * Restore lock + marker protocol for RocksDB database restores (online operation and offline CLI).
 *
 * Two files live *next to* the database directory (never inside it, since a restore purges the
 * destination):
 *
 * - `<dbPath>.restore.lock` — an OS-level exclusive file lock (via rocksdb-js `tryFileLock`),
 *   effective across processes, containers, and worker threads, auto-released on process exit.
 *   Only *held-ness* is meaningful; the file itself persists after release (harmless).
 *   Known limitation: the lock is owned by the process, so if the restore job's worker *thread*
 *   dies without the process exiting, the lock stays held (restores 409) until Harper restarts.
 * - `<dbPath>.restoring` — the completion marker. Written (and fsynced) after the lock is
 *   acquired and before the destructive restore begins; deleted only after the restore completes
 *   successfully, while still holding the lock. Its *existence* means "a restore started and has
 *   not finished successfully".
 */

export const RESTORE_LOCK_SUFFIX = '.restore.lock';
export const RESTORING_MARKER_SUFFIX = '.restoring';

export function restoreLockPath(dbPath: string): string {
	return dbPath + RESTORE_LOCK_SUFFIX;
}

export function restoringMarkerPath(dbPath: string): string {
	return dbPath + RESTORING_MARKER_SUFFIX;
}

export type RestoreState = 'in-progress' | 'incomplete' | 'clear';

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
 * Acquire the per-database restore lock and write the restoring marker. Call before any
 * destructive step. Returns the lock token for `completeRestore`/`abandonRestore`.
 * Throws (statusCode 409) if another restore already holds the lock.
 */
export function beginRestore(dbPath: string): number {
	const token = tryFileLock(restoreLockPath(dbPath));
	if (token === 0) {
		const error: any = new Error(`Restore already in progress for database at ${dbPath}`);
		error.statusCode = 409;
		throw error;
	}
	try {
		const fd = openSync(restoringMarkerPath(dbPath), 'w');
		try {
			writeSync(fd, `restore started ${new Date().toISOString()}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// fsync the parent directory so the marker's directory entry is durable — without this a
		// power loss can lose the entry, and a half-purged database would load as healthy
		const dirFd = openSync(dirname(dbPath), 'r');
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		fileLockRelease(token);
		throw error;
	}
	return token;
}

/**
 * Mark the restore successful: delete the marker (while still holding the lock), then release
 * the lock.
 */
export function completeRestore(dbPath: string, token: number): void {
	try {
		unlinkSync(restoringMarkerPath(dbPath));
		// fsync the parent directory so the marker's *removal* is durable — symmetric with the
		// creation fsync in beginRestore. Without it, a power loss could resurrect the marker's
		// directory entry and misclassify a fully-restored database as incomplete (blocking its
		// load until a needless rerun).
		const dirFd = openSync(dirname(dbPath), 'r');
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} finally {
		fileLockRelease(token);
	}
}

/**
 * Release the lock after a failed restore, leaving the marker in place so the database is
 * detected as an incomplete restore (and not loaded) until a rerun succeeds.
 */
export function abandonRestore(token: number): void {
	fileLockRelease(token);
}
