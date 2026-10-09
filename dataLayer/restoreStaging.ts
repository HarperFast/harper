import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backups, validateTransactionLogStore } from '@harperfast/rocksdb-js';
import { stampDatabaseDirectory } from '../resources/auditStore.ts';
import { ClientError, ServerError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory, pathPresent } from '../utility/durableFile.ts';
import logger from '../utility/logging/harper_logger.ts';
import {
	restoreDiscardedPath,
	restoreMetaDir,
	restoreReplacedPath,
	restoreStagingPath,
	type RestoreLock,
} from './restoreMarker.ts';

// Stage → prove → publish for `restore_backup` (harper#2965); the protocol is in dataLayer/DESIGN.md.
// The caller holds the restore lock (and its marker) throughout.

/**
 * Clear what an earlier attempt left behind. Staging was never published, so it is always disposable.
 * `.replaced` is the database as it was before an interrupted publication — the only copy of it if
 * that publication died between its renames — so it survives every attempt that runs under a
 * preexisting marker. It exists only while a publication is unfinished: a finished restore moves it to
 * `.discarded` while it still holds its marker (`discardReplaced`).
 */
export function prepareRestoreStaging(lock: RestoreLock, state: PublishResult): void {
	const databaseDir = lock.dbPath;
	if (isSymbolicLink(databaseDir)) {
		// Repointing moves the restore metadata with the path, so an earlier restore's marker stops
		// guarding its half-restored directory; only an offline rerun before the next start covers that.
		const remedy = lock.preexisting
			? 'An earlier restore of this database did not finish: with Harper stopped, point the configured database path at the real directory, then rerun this restore offline before starting Harper again, so the half-restored directory is never loaded'
			: 'Point the configured database path at the real directory, then rerun the restore';
		throw new ClientError(
			`Cannot restore into ${databaseDir}: it is a symbolic link, and a restore replaces the database directory itself. ${remedy}`
		);
	}
	// Staging lives beside the database, so a mount point would cost a full copy only for the rename to fail.
	if (pathPresent(databaseDir) && statSync(databaseDir).dev !== statSync(restoreMetaDir(databaseDir)).dev) {
		throw new ClientError(
			`Cannot restore into ${databaseDir}: it is a mount point, on a different filesystem from ${dirname(databaseDir)}, and a restore replaces the database directory by renaming it. Mount the volume at the parent directory instead, or restore offline into a new target_database`
		);
	}
	const replacedDir = restoreReplacedPath(databaseDir);
	// Only a marker proves `.replaced` is this database's unfinished publication; without one the
	// database path may be the live database, not a candidate.
	if (!lock.preexisting && pathPresent(replacedDir)) {
		throw new ClientError(
			`Cannot restore into ${databaseDir}: ${replacedDir} is left from an earlier restore that recorded no restore marker, so it cannot be told apart from the database. Inspect it and remove it, then rerun the restore`,
			409
		);
	}
	rmSync(restoreStagingPath(databaseDir), { recursive: true, force: true });
	rmSync(restoreDiscardedPath(databaseDir), { recursive: true, force: true });
	if (pathPresent(replacedDir)) {
		// A publication began and never finished, so the database path holds a candidate, never the
		// database; dropped now rather than at publish so the space check does not count a third copy.
		state.destroyed = true;
		rmSync(databaseDir, { recursive: true, force: true });
	}
}

/**
 * Readability, not completeness, is the bar: a torn log tail is something open-time recovery
 * truncates, so it is not a reason to refuse a backup the operator has no other way to restore.
 */
export async function stageRestore(backupDir: string, backupId: number, lock: RestoreLock): Promise<void> {
	const databaseDir = lock.dbPath;
	const stagingDir = restoreStagingPath(databaseDir);
	await assertRoomToStage(backupDir, backupId, lock);
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
			`Backup ${backupId} could not be staged and verified, so ${untouched(lock)}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			}
		);
	}
}

// Free space a restore leaves on the shared filesystem for the databases still serving there.
const STAGING_HEADROOM_BYTES = 256 * 1024 ** 2;

/**
 * Staging needs a second engine copy where the purge it replaced freed the space first, and online it
 * is written while every database on that filesystem keeps serving. Running out partway would fail
 * their writes too, so a copy that will not fit is refused before it starts.
 */
async function assertRoomToStage(backupDir: string, backupId: number, lock: RestoreLock): Promise<void> {
	const databaseDir = lock.dbPath;
	const engineBytes = (await backups.list(backupDir)).find((backup) => backup.backupId === backupId)?.size ?? 0;
	const needed = engineBytes + directoryBytes(join(backupDir, 'transaction_logs', String(backupId)));
	const headroom = Math.max(STAGING_HEADROOM_BYTES, needed / 10);
	const { bavail, bsize } = statfsSync(restoreMetaDir(databaseDir));
	const available = Number(bavail) * Number(bsize);
	if (available < needed + headroom) {
		throw new ServerError(
			`Cannot restore backup ${backupId}: staging it needs about ${formatBytes(needed)} beside ${databaseDir}, plus ${formatBytes(headroom)} left free for the databases still serving on that filesystem, but only ${formatBytes(available)} is available. Free space there and rerun the restore; ${untouched(lock)}`,
			507
		);
	}
}

/** What a refusal before publication can truthfully say about the destination. */
function untouched(lock: RestoreLock): string {
	return lock.preexisting
		? `${lock.dbPath} is still incomplete from an earlier restore; rerun restore_backup to recover`
		: `${lock.dbPath} was not modified`;
}

function directoryBytes(path: string): number {
	if (!pathPresent(path)) return 0;
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const entryPath = join(path, entry.name);
		total += entry.isDirectory() ? directoryBytes(entryPath) : statSync(entryPath).size;
	}
	return total;
}

function formatBytes(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
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
 * Retire the pre-restore copy before the marker clears. The rename is atomic, so `.replaced` can never
 * outlive its restore and later pass for an unfinished publication; it throws while the marker still
 * stands. Only removing the renamed copy may fail quietly, since the next restore removes it.
 */
export function discardReplaced(lock: RestoreLock): void {
	const replacedDir = restoreReplacedPath(lock.dbPath);
	if (!pathPresent(replacedDir)) return;
	const discardedDir = restoreDiscardedPath(lock.dbPath);
	rmSync(discardedDir, { recursive: true, force: true });
	renameSync(replacedDir, discardedDir);
	fsyncDirectory(restoreMetaDir(lock.dbPath));
	try {
		rmSync(discardedDir, { recursive: true, force: true });
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
		if ((error as any)?.code === 'ENOENT') return false;
		throw error;
	}
}
