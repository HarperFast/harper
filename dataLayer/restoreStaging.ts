import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backups, validateTransactionLogStore } from '@harperfast/rocksdb-js';
import { stampDatabaseDirectory } from '../resources/auditStore.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory, pathPresent } from '../utility/durableFile.ts';
import logger from '../utility/logging/harper_logger.ts';
import { restoreMetaDir, restoreReplacedPath, restoreStagingPath, type RestoreLock } from './restoreMarker.ts';

/**
 * Stage → prove → publish for `restore_backup` (harper#2965). The database directory is not touched
 * until this build has restored the backup into a staging directory and opened it; publication is two
 * renames, so the one-way door of the restore marker protocol is the first rename, not a purge.
 * The caller holds the restore lock (and its marker) throughout.
 */

/**
 * Clear what an earlier attempt left behind. Staging was never published, so it is always disposable.
 * `.replaced` is the database as it was before an interrupted publication — the only copy of it if
 * that publication died between its renames — so it survives every attempt that runs under a
 * preexisting marker; under a fresh marker it is debris of a restore that completed.
 */
export function prepareRestoreStaging(lock: RestoreLock): void {
	const databaseDir = lock.dbPath;
	if (isSymbolicLink(databaseDir)) {
		throw new ClientError(
			`Cannot restore into ${databaseDir}: it is a symbolic link, and a restore replaces the database directory itself. Point the configured database path at the real directory, then rerun the restore`
		);
	}
	// Staging lives beside the database, so a mount point would cost a full copy only for the rename to fail.
	if (pathPresent(databaseDir) && statSync(databaseDir).dev !== statSync(restoreMetaDir(databaseDir)).dev) {
		throw new ClientError(
			`Cannot restore into ${databaseDir}: it is a mount point, on a different filesystem from ${dirname(databaseDir)}, and a restore replaces the database directory by renaming it. Mount the volume at the parent directory instead, or restore offline into a new target_database`
		);
	}
	rmSync(restoreStagingPath(databaseDir), { recursive: true, force: true });
	if (!lock.preexisting) rmSync(restoreReplacedPath(databaseDir), { recursive: true, force: true });
}

/**
 * Restore the backup into staging and prove this build can read it: every transaction log store
 * validates, and the engine opens writably — the open is also where the new generation is stamped.
 * Readability, not completeness, is the bar: a torn log tail is something open-time recovery
 * truncates, so it is not a reason to refuse a backup the operator has no other way to restore.
 */
export async function stageRestore(backupDir: string, backupId: number, lock: RestoreLock): Promise<void> {
	const databaseDir = lock.dbPath;
	const stagingDir = restoreStagingPath(databaseDir);
	try {
		mkdirSync(stagingDir);
		// After a crash between the publication renames, `.replaced` is the only record of that access.
		const modeSource = pathPresent(databaseDir) ? databaseDir : restoreReplacedPath(databaseDir);
		if (pathPresent(modeSource)) chmodSync(stagingDir, lstatSync(modeSource).mode & 0o7777);
		await backups.restore(backupDir, stagingDir, { backupId, mode: 'purgeAllFiles' });
		const logsDir = join(stagingDir, 'transaction_logs');
		if (pathPresent(logsDir)) {
			for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const result = await validateTransactionLogStore(join(logsDir, entry.name));
				if (!result.valid) {
					const problems = [
						...result.errors,
						...result.files.flatMap((file) => file.errors.map((e) => `${file.file}: ${e}`)),
					];
					throw new Error(`transaction log '${entry.name}' is unreadable: ${problems.join('; ')}`);
				}
			}
		}
		await stampDatabaseDirectory(stagingDir, { carriesLog: true });
	} catch (error) {
		throw new Error(
			`Backup ${backupId} could not be staged and verified, so ${databaseDir} was not modified: ${error.message}`,
			{ cause: error }
		);
	}
}

export type PublishResult = { destroyed: boolean };

/**
 * Swap the staged database in. Reports through `destroyed` whether the destination may have changed,
 * which is what decides whether the caller may clear its marker; an error is rethrown either way.
 */
export function publishStagedRestore(lock: RestoreLock, state: PublishResult): void {
	const databaseDir = lock.dbPath;
	const stagingDir = restoreStagingPath(databaseDir);
	const replacedDir = restoreReplacedPath(databaseDir);
	const parentDir = dirname(databaseDir);
	const metaDir = restoreMetaDir(databaseDir);
	if (pathPresent(replacedDir)) {
		// Whatever is at the database path is a candidate an earlier attempt published and never finished.
		state.destroyed = true;
		rmSync(databaseDir, { recursive: true, force: true });
	} else if (pathPresent(databaseDir)) {
		renameSync(databaseDir, replacedDir);
		state.destroyed = true;
		fsyncDirectory(parentDir);
		fsyncDirectory(metaDir);
	}
	try {
		renameSync(stagingDir, databaseDir);
	} catch (error) {
		if (pathPresent(replacedDir)) rollBackPublication(replacedDir, databaseDir, state);
		throw error;
	}
	// Even with nothing displaced, a published engine whose blobs never landed must keep its marker.
	state.destroyed = true;
	fsyncDirectory(metaDir);
	fsyncDirectory(parentDir);
}

/**
 * Put the pre-restore database back. Only a rollback that is itself durable lets the caller clear its
 * marker; otherwise the marker stays and a rerun finds `.replaced` where this left it.
 */
function rollBackPublication(replacedDir: string, databaseDir: string, state: PublishResult): void {
	try {
		renameSync(replacedDir, databaseDir);
		fsyncDirectory(restoreMetaDir(databaseDir));
		fsyncDirectory(dirname(databaseDir));
		state.destroyed = false;
	} catch (error) {
		logger.error(`Could not move the pre-restore copy of ${databaseDir} back; it remains at ${replacedDir}`, error);
	}
}

/**
 * Drop the pre-restore copy once the restore has finished. Not fatal: with the marker gone it is
 * debris that the next restore of this database removes.
 */
export function discardReplaced(lock: RestoreLock): void {
	try {
		rmSync(restoreReplacedPath(lock.dbPath), { recursive: true, force: true });
	} catch (error) {
		logger.warn(`Could not remove the pre-restore copy of ${lock.dbPath}; the next restore removes it`, error);
	}
}

/** Staging is never published by a failed attempt, so it is always safe to drop; never fatal. */
export function discardRestoreStaging(lock: RestoreLock): void {
	const stagingDir = restoreStagingPath(lock.dbPath);
	try {
		rmSync(stagingDir, { recursive: true, force: true });
	} catch (error) {
		logger.warn(`Could not remove restore staging at ${stagingDir}; the next restore removes it`, error);
	}
}

function isSymbolicLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}
