'use strict';

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { open, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { pack as tarPack, type Pack } from 'tar-stream';
import { RocksDatabase, backups, registryStatus, type BackupInfo } from '@harperfast/rocksdb-js';
import { getDatabases, resolveDatabasePath } from '../resources/databases.ts';
import {
	type BlobCaptureDisposition,
	classifyBlobFileForCapture,
	createCaptureMarker,
	getBlobPathsForDatabaseName,
	isSystemicIoError,
} from '../resources/blob.ts';
import { getHdbBasePath } from '../utility/environment/environmentManager.ts';
import { getConfigPath } from '../config/configUtils.ts';
import { getBackupDirPath } from '../config/configHelpers.ts';
import { CONFIG_PARAMS, OPERATIONS_ENUM } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as signalling from '../utility/signalling.ts';
import { SchemaEventMsg } from '../server/threads/itc.js';
import { beginRestore, completeRestore, abandonRestore, checkRestoreState, type RestoreLock } from './restoreMarker.ts';
import {
	assertBlobSnapshotRestorable,
	blobSnapshotDir,
	blobsReadmeContent,
	deleteBlobSnapshot,
	purgeBlobSnapshots,
	restoreBlobSnapshot,
	snapshotBlobs,
} from './blobBackup.ts';
import {
	deleteBackupManifest,
	purgeBackupManifests,
	readAllManifests,
	readBackupManifest,
	writeBackupManifest,
	type BackupManifest,
} from './backupManifest.ts';
import logger from '../utility/logging/harper_logger.ts';

/**
 * Shared core for the RocksDB managed-backup operations (`create_backup`, `list_backups`,
 * `verify_backup`, `delete_backup`, `purge_backups`, `restore_backup`) and the RocksDB path of
 * `get_backup`. Used by both the operation API (running server) and the CLI (stopped server) so
 * the two behave identically.
 *
 * Directory backups are confined to `<backupsRoot>/<database>/` where the backups root comes
 * from the `storage.backupPath` config (default `<hdb_root>/backups`); operations never accept
 * arbitrary filesystem paths.
 */

export class BackupNotFoundError extends ClientError {
	constructor(message: string) {
		super(message, 404);
		this.name = 'BackupNotFoundError';
	}
}

export class BackupInProgressError extends ClientError {
	constructor(message: string) {
		super(message, 409);
		this.name = 'BackupInProgressError';
	}
}

/**
 * Enforce super_user for the managed-backup operations. These are whole-database administrative
 * operations (not table-scoped), so they must never be delegable to a non-super_user role. The
 * registered permission alone can't guarantee that: operation_authorization gate-2 authorizes any
 * `requires_su` op placed in a role's `operations` allowlist without evaluating the declared table
 * CRUD perms, so a non-SU role could otherwise reach these. Enforcing here — mirroring
 * get_deployment_payload's requireSuperUser — closes that path regardless of the allowlist. For the
 * job operations (create/verify/restore) this runs in the request-context validator, before any job
 * record is created.
 */
function requireSuperUser(request: any, operationName: string): void {
	if (!request?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError(`Operation '${operationName}' is restricted to super_user roles`, 403);
	}
}

export function getBackupsRoot(): string {
	const configured = getConfigPath(CONFIG_PARAMS.STORAGE_BACKUPPATH);
	if (configured && typeof configured === 'string') return configured;
	// same <hdb_root>/backup directory as config-file backups; databases get subdirectories
	return getBackupDirPath(getHdbBasePath());
}

function getDatabaseName(request: any): string {
	const databaseName = request.database || request.schema || 'data';
	validateDatabaseName(databaseName);
	return databaseName;
}

/**
 * The database name becomes a path segment under the backups root and the databases root —
 * reject anything that could traverse outside them.
 */
export function validateDatabaseName(databaseName: any): void {
	if (typeof databaseName !== 'string' || databaseName.length === 0) {
		throw new ClientError(`'database' must be a non-empty string`);
	}
	if (
		databaseName.includes('/') ||
		databaseName.includes('\\') ||
		databaseName.includes('\0') ||
		databaseName === '.' ||
		databaseName === '..'
	) {
		throw new ClientError(`Invalid database name '${databaseName}'`);
	}
}

export function backupDirForDatabase(databaseName: string): string {
	validateDatabaseName(databaseName);
	return join(getBackupsRoot(), databaseName);
}

/**
 * Resolve the single root store for a database. A database can span multiple root stores when a
 * table has a per-table `path` config; backing up such a database is not supported and errors
 * descriptively. Engine gating (RocksDB vs LMDB) is done inline at each call site.
 */
export function resolveSingleRootStore(databaseName: string): any {
	const database = getDatabases()[databaseName];
	if (!database) {
		throw new BackupNotFoundError(`Database '${databaseName}' does not exist`);
	}
	const rootStores = new Set<any>();
	for (const tableName in database) {
		const rootStore = database[tableName]?.primaryStore?.rootStore;
		if (rootStore) rootStores.add(rootStore);
	}
	if (rootStores.size > 1) {
		throw new ClientError(
			`Database '${databaseName}' spans multiple root stores (tables with a per-table 'path' config); backup operations only support single-root databases`
		);
	}
	if (rootStores.size === 0) {
		throw new ClientError(`Database '${databaseName}' has no tables to back up`);
	}
	return rootStores.values().next().value;
}

function requireRocksRootStore(databaseName: string, operation: string): RocksDatabase {
	const rootStore = resolveSingleRootStore(databaseName);
	if (!(rootStore instanceof RocksDatabase)) {
		throw new ClientError(
			`Operation '${operation}' requires a RocksDB database; '${databaseName}' uses the LMDB storage engine (use 'get_backup' to download an LMDB backup)`
		);
	}
	return rootStore as RocksDatabase;
}

function requireBackupId(backupId: any): number {
	if (!Number.isSafeInteger(backupId) || backupId <= 0) {
		throw new ClientError(`'backup_id' must be a positive integer`);
	}
	return backupId;
}

function requireBooleanOption(value: any, name: string): boolean {
	if (value !== undefined && typeof value !== 'boolean') {
		throw new ClientError(`'${name}' must be a boolean`);
	}
	return value === true;
}

/**
 * The binding serializes backup-directory writers with an on-disk `.backup.lock`; a concurrent
 * writer rejects with a "locked" error. Map it to a descriptive 409 — fail fast, no queueing.
 */
function mapLockedError(error: any, databaseName: string): any {
	if (typeof error?.message === 'string' && error.message.includes('is locked')) {
		return new BackupInProgressError(`Backup operation already in progress for database '${databaseName}'`);
	}
	return error;
}

// --- directory helpers (operate on a backup directory only; no open database, usable offline) ---

export async function listBackupsInDir(backupDir: string): Promise<BackupInfo[]> {
	// the backup dir doesn't exist until the first create_backup
	if (!existsSync(backupDir)) return [];
	return backups.list(backupDir);
}

async function findBackup(backupDir: string, backupId: number, databaseName: string): Promise<BackupInfo> {
	requireBackupId(backupId); // every id-taking path flows through here, including the offline CLI
	const list = await listBackupsInDir(backupDir);
	const info = list.find((backup) => backup.backupId === backupId);
	if (!info) {
		throw new BackupNotFoundError(`Backup ${backupId} not found for database '${databaseName}'`);
	}
	return info;
}

/**
 * Shape a rocksdb-js BackupInfo into the snake_case response the Operations API exposes — the
 * binding's fields are camelCase, and `appMetadata` is internal, so it is not passed through.
 * `blobs` reflects the completion manifest's recorded blob-inclusion policy.
 */
function toBackupResponse(
	info: BackupInfo,
	blobs: boolean
): {
	backup_id: number;
	timestamp: number;
	size: number;
	file_count: number;
	blobs: boolean;
} {
	return {
		backup_id: info.backupId,
		timestamp: info.timestamp,
		size: info.size,
		file_count: info.numberFiles,
		blobs,
	};
}

/**
 * The engine backups in a directory that have a completion manifest — i.e. whose creation finished
 * successfully. An engine backup without a manifest is incomplete (still being written, or a failed
 * create) and is never listed or restored, so a blob snapshot that is mid-copy or absent-after-
 * failure can't be mistaken for a healthy or intentionally-engine-only backup.
 */
async function listCompleteBackups(backupDir: string): Promise<Array<BackupInfo & { blobs: boolean }>> {
	const [engineBackups, manifests] = await Promise.all([listBackupsInDir(backupDir), readAllManifests(backupDir)]);
	const complete: Array<BackupInfo & { blobs: boolean }> = [];
	for (const info of engineBackups) {
		const manifest = manifests.get(info.backupId);
		if (manifest) complete.push({ ...info, blobs: manifest.blobs });
	}
	return complete;
}

/**
 * Load a specific backup's completion manifest, rejecting it as incomplete (409) when the engine
 * backup exists but has no manifest — its creation did not finish, or is still in progress.
 */
async function requireBackupComplete(
	backupDir: string,
	backupId: number,
	databaseName: string
): Promise<BackupManifest> {
	const manifest = await readBackupManifest(backupDir, backupId);
	if (!manifest) {
		throw new BackupInProgressError(
			`Backup ${backupId} of database '${databaseName}' is incomplete (its creation did not finish or is still in progress); it cannot be restored or verified`
		);
	}
	return manifest;
}

/**
 * Resolve which backup id a restore/verify should act on and load its completion manifest. A
 * specific id that exists in the engine but has no manifest is rejected as incomplete; without a
 * requested id, the latest *complete* backup is chosen.
 */
async function resolveCompleteBackup(
	backupDir: string,
	requestedId: number | undefined,
	databaseName: string
): Promise<{ backupId: number; manifest: BackupManifest }> {
	if (requestedId !== undefined) {
		await findBackup(backupDir, requestedId, databaseName); // validates id + engine presence
		return { backupId: requestedId, manifest: await requireBackupComplete(backupDir, requestedId, databaseName) };
	}
	const complete = await listCompleteBackups(backupDir);
	if (complete.length === 0) {
		throw new BackupNotFoundError(`No complete backups found for database '${databaseName}'`);
	}
	const latest = complete.reduce((a, b) => (b.backupId > a.backupId ? b : a));
	return { backupId: latest.backupId, manifest: { backupId: latest.backupId, blobs: latest.blobs, completedAt: 0 } };
}

/**
 * Publish a backup's completion manifest after the engine backup and (when included) blob snapshot
 * are durable. On failure, best-effort roll back the just-created engine backup, its partial blob
 * snapshot, and any manifest so an incomplete backup never lingers as usable.
 */
async function finalizeBackup(
	backupDir: string,
	backupId: number,
	databaseName: string,
	blobs: boolean
): Promise<void> {
	try {
		if (blobs) await snapshotBlobs(backupDir, backupId, getBlobPathsForDatabaseName(databaseName));
		await writeBackupManifest(backupDir, backupId, blobs);
	} catch (error) {
		await deleteBackupManifest(backupDir, backupId).catch(() => {});
		await deleteBlobSnapshot(backupDir, backupId).catch(() => {});
		await backups.delete(backupDir, backupId).catch(() => {});
		throw error;
	}
}

// --- synchronous operations ---

export async function listBackups(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.LIST_BACKUPS);
	const databaseName = getDatabaseName(request);
	logger.info(`Listing backups for database '${databaseName}'`);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.LIST_BACKUPS);
	return (await listCompleteBackups(backupDirForDatabase(databaseName))).map((backup) =>
		toBackupResponse(backup, backup.blobs)
	);
}

export async function deleteBackup(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.DELETE_BACKUP);
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.DELETE_BACKUP);
	const backupId = requireBackupId(request.backup_id);
	const backupDir = backupDirForDatabase(databaseName);
	await findBackup(backupDir, backupId, databaseName);
	try {
		await backups.delete(backupDir, backupId);
	} catch (error) {
		throw mapLockedError(error, databaseName);
	}
	// the engine's delete leaves the (Harper-managed) blob snapshot + manifest behind — remove them too
	await deleteBlobSnapshot(backupDir, backupId);
	await deleteBackupManifest(backupDir, backupId);
	return { ok: true };
}

export async function purgeBackups(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.PURGE_BACKUPS);
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.PURGE_BACKUPS);
	const keepCount = request.keep_count;
	if (!Number.isSafeInteger(keepCount) || keepCount < 0) {
		throw new ClientError(`'keep_count' must be a non-negative integer`);
	}
	const backupDir = backupDirForDatabase(databaseName);
	const before = await listBackupsInDir(backupDir);
	if (before.length === 0) {
		throw new BackupNotFoundError(`No backups found for database '${databaseName}'`);
	}
	try {
		await backups.purge(backupDir, keepCount);
	} catch (error) {
		throw mapLockedError(error, databaseName);
	}
	const remainingBackups = await listBackupsInDir(backupDir);
	// drop blob snapshots + manifests for every id the engine purged (keep only the survivors')
	const keepIds = new Set(remainingBackups.map((backup) => backup.backupId));
	await purgeBlobSnapshots(backupDir, keepIds);
	await purgeBackupManifests(backupDir, keepIds);
	// clamp: a concurrent create between the two lists can otherwise make this negative
	return { deleted: Math.max(0, before.length - remainingBackups.length), remaining: remainingBackups.length };
}

// --- job operations: create_backup / verify_backup / restore_backup ---
// Each has a synchronous-validation function (run by jobs.addJob before the job record is
// created) and the job function itself (run in the job worker thread).

export async function validateCreateBackup(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.CREATE_BACKUP);
	const databaseName = getDatabaseName(request);
	requireBooleanOption(request.exclude_blobs, 'exclude_blobs');
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.CREATE_BACKUP);
}

export async function createBackup(request: any) {
	const databaseName = getDatabaseName(request);
	// blobs are captured by default; exclude_blobs=true produces an engine-only backup
	const excludeBlobs = requireBooleanOption(request.exclude_blobs, 'exclude_blobs');
	const rootStore = requireRocksRootStore(databaseName, OPERATIONS_ENUM.CREATE_BACKUP);
	const backupDir = backupDirForDatabase(databaseName);
	let backupId;
	try {
		backupId = await rootStore.backup(backupDir, { transactionLogs: true });
	} catch (error) {
		throw mapLockedError(error, databaseName);
	}
	// snapshot blobs (unless excluded) then publish the completion manifest; rolls back on failure
	await finalizeBackup(backupDir, backupId, databaseName, !excludeBlobs);
	await writeBackupReadme(backupDir, databaseName);
	return {
		database: databaseName,
		backup_id: backupId,
		blobs: !excludeBlobs,
		...(await describeBackup(backupDir, backupId)),
	};
}

/**
 * db.backup() returns only the id; size/timestamp come from a list() match. A missing match
 * (e.g. a concurrent delete/purge between the two calls) is logged rather than silently
 * reported as undefined fields.
 */
async function describeBackup(backupDir: string, backupId: number): Promise<{ size?: number; timestamp?: any }> {
	const info = (await listBackupsInDir(backupDir)).find((backup) => backup.backupId === backupId);
	if (!info) {
		logger.warn(`Backup ${backupId} was created but is no longer listed in ${backupDir} (deleted concurrently?)`);
		return {};
	}
	return { size: info.size, timestamp: info.timestamp };
}

/**
 * Write a `README.md` into a database's backup directory with the commands to list, verify, and
 * restore the backup, so the repository is recoverable without reading the source. Best-effort:
 * a failure to write the doc must not fail an otherwise-successful backup. Overwritten on each
 * create so it stays current.
 */
async function writeBackupReadme(backupDir: string, databaseName: string): Promise<void> {
	const content = `# Harper backup — database "${databaseName}"

This directory is a Harper-managed backup repository for the "${databaseName}" database: one or more
RocksDB backups (engine data + transaction logs) and, unless created with \`exclude_blobs\`, a
\`blobs/\` snapshot of the database's file-backed blobs (see blobs/README.md). It lives under
\`storage.backupPath\` (default \`<rootPath>/backup\`), one directory per database. Do not edit these
files by hand.

## List / verify

    harper list_backups database=${databaseName}
    harper verify_backup database=${databaseName} backup_id=<id>

## Restore

Restore is destructive: it purges and rewrites the database directory — and every blob root — from
the backup (blobs are restored automatically). Restore the latest backup in place:

    harper restore_backup database=${databaseName}

...or a specific id:

    harper restore_backup database=${databaseName} backup_id=<id>

A database held open by a loaded component — and always the \`system\` database — cannot be restored
while Harper is running; stop the server and run the same command offline. Offline you can also
restore into a *copy*, leaving the original untouched:

    harper restore_backup database=${databaseName} target_database=${databaseName}-restore

## Prune

    harper delete_backup database=${databaseName} backup_id=<id>
    harper purge_backups database=${databaseName} keep_count=<n>

Both remove the RocksDB backup and its blob snapshot.
`;
	try {
		await writeFile(join(backupDir, 'README.md'), content);
	} catch (error) {
		logger.warn(`Failed to write backup README in ${backupDir}: ${(error as Error).message}`);
	}
}

export async function validateVerifyBackup(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.VERIFY_BACKUP);
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.VERIFY_BACKUP);
	requireBooleanOption(request.verify_checksum, 'verify_checksum');
	const backupDir = backupDirForDatabase(databaseName);
	const backupId = requireBackupId(request.backup_id);
	await findBackup(backupDir, backupId, databaseName);
	await requireBackupComplete(backupDir, backupId, databaseName);
}

export async function verifyBackup(request: any) {
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.VERIFY_BACKUP);
	const backupId = requireBackupId(request.backup_id);
	const verifyWithChecksum = requireBooleanOption(request.verify_checksum, 'verify_checksum');
	const backupDir = backupDirForDatabase(databaseName);
	await findBackup(backupDir, backupId, databaseName);
	const manifest = await requireBackupComplete(backupDir, backupId, databaseName);
	await backups.verify(backupDir, backupId, { verifyWithChecksum });
	// verification covers the declared blob snapshot: a backup that recorded blobs must still have its
	// snapshot directory (a manifest without its blobs is a corrupt backup)
	if (manifest.blobs && !existsSync(blobSnapshotDir(backupDir, backupId))) {
		throw new ClientError(
			`Backup ${backupId} of database '${databaseName}' declares captured blobs but its blob snapshot is missing (corrupt backup)`
		);
	}
	return { database: databaseName, backup_id: backupId, ok: true, blobs: manifest.blobs };
}

export async function validateRestoreBackup(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.RESTORE_BACKUP);
	const databaseName = getDatabaseName(request);
	if (databaseName === 'system') {
		throw new ClientError(
			`The 'system' database cannot be restored while Harper is running; stop the server and run: harper restore_backup database=system`
		);
	}
	if (request.target_database !== undefined) {
		// silently ignoring this would destructively restore over the source database instead of
		// the copy the caller asked for
		throw new ClientError(
			`'target_database' is not supported while Harper is running (restore_backup always restores in place); stop the server and run: harper restore_backup database=${databaseName} target_database=<name>`
		);
	}
	const backupDir = backupDirForDatabase(databaseName);
	if (request.backup_id !== undefined) {
		const backupId = requireBackupId(request.backup_id);
		await findBackup(backupDir, backupId, databaseName);
		await requireBackupComplete(backupDir, backupId, databaseName);
	} else if ((await listCompleteBackups(backupDir)).length === 0) {
		throw new BackupNotFoundError(`No complete backups found for database '${databaseName}'`);
	}
	// Only a loaded database that actually has tables can be validated as a single-root RocksDB
	// store here (an empty/tableless database has no table to resolve a root store from, and an
	// unloaded one recovering an interrupted restore isn't open yet); those cases are validated when
	// the restore job runs. `Object.keys` skips the DEFINED_TABLES symbol, so an empty database is 0.
	const loaded = getDatabases()[databaseName];
	if (loaded != null && Object.keys(loaded).length > 0) {
		requireRocksRootStore(databaseName, OPERATIONS_ENUM.RESTORE_BACKUP);
	}
}

/**
 * Online restore of a user database (see the design's restore lock + marker protocol):
 * take the per-database restore lock, write the restoring marker, close the database across all
 * worker threads, restore, delete the marker, release the lock, and reload everywhere.
 */
export async function restoreBackup(request: any) {
	const databaseName = getDatabaseName(request);
	if (databaseName === 'system') {
		throw new ClientError(
			`The 'system' database cannot be restored while Harper is running; stop the server and run: harper restore_backup database=system`
		);
	}
	if (request.target_database !== undefined) {
		throw new ClientError(
			`'target_database' is not supported while Harper is running (restore_backup always restores in place); stop the server and run: harper restore_backup database=${databaseName} target_database=<name>`
		);
	}
	const backupDir = backupDirForDatabase(databaseName);
	// choose the latest complete backup (or the requested id, rejected if incomplete); the manifest
	// tells us whether blobs were captured so we restore them only when they were
	const { backupId, manifest } = await resolveCompleteBackup(
		backupDir,
		request.backup_id === undefined ? undefined : requireBackupId(request.backup_id),
		databaseName
	);
	// a loaded database *with tables* knows its real directory via its root store (which can differ
	// from the computed default, e.g. legacy layouts); fall back to the computed path when the
	// database is unloaded (recovering an interrupted restore) or empty (no table to resolve a root
	// store from — Object.keys skips the DEFINED_TABLES symbol)
	const loaded = getDatabases()[databaseName];
	const databaseDir =
		loaded != null && Object.keys(loaded).length > 0
			? requireRocksRootStore(databaseName, OPERATIONS_ENUM.RESTORE_BACKUP).path
			: resolveDatabasePath(databaseName);
	// reject a backup with more blob roots than the current config *before* anything destructive —
	// restoring it would mis-address blobs (records persist their root index)
	await assertBlobSnapshotRestorable(backupDir, backupId, getBlobPathsForDatabaseName(databaseName));
	const lock = beginRestoreForDatabase(databaseDir, databaseName);
	let destructionStarted = false;
	try {
		// close the database across all worker threads (each thread also rescans, and the
		// restoring marker keeps the scan from reloading it mid-restore)
		await signalling.signalSchemaChange(new SchemaEventMsg(process.pid, OPERATIONS_ENUM.RESTORE_BACKUP, databaseName));
		// A live component (or the system database) can hold its own handle on the database that
		// Harper does not track and cannot close, so verify actual process-wide closure before
		// purging — restoring under an open instance would corrupt it. If handles remain, fail
		// with a clear pointer to the offline CLI path rather than purging.
		await verifyDatabaseClosed(databaseDir, databaseName);
		destructionStarted = true;
		await backups.restore(backupDir, databaseDir, { backupId, mode: 'purgeAllFiles' });
		// restore blobs only for a backup that captured them (an engine-only backup leaves the live
		// blob roots untouched); the manifest, not the mere presence of a snapshot dir, is the source
		// of truth so a mid-copy or absent snapshot can't be misread
		if (manifest.blobs) {
			await restoreBlobSnapshot(backupDir, backupId, databaseName, getBlobPathsForDatabaseName(databaseName));
		}
	} catch (error: any) {
		// Leave the marker (so startup/rescan detection reports an incomplete restore until a rerun
		// succeeds) when either the destructive purge has begun, OR this attempt was itself a recovery
		// over a pre-existing marker: in that case the directory may already be half-purged from an
		// earlier failed restore, so clearing the marker and reloading it as healthy would surface
		// partial/corrupt data. Only a *fresh* marker on a *previously healthy* database that failed
		// before any destruction is safe to clear.
		if (destructionStarted || lock.preexisting) {
			abandonRestore(lock);
			// wrap rather than mutate error.message: a frozen/library error can have a non-writable
			// message (assigning it throws TypeError under 'use strict')
			throw new Error(
				`Restore of database '${databaseName}' from backup ${backupId} failed (rerun restore_backup to recover): ${error.message}`,
				{ cause: error }
			);
		}
		// nothing destructive happened and the marker was fresh — clear it and let every thread reload
		// the intact database
		completeRestore(lock);
		await signalling.signalSchemaChange(new SchemaEventMsg(process.pid, OPERATIONS_ENUM.RESTORE_BACKUP, databaseName));
		throw error;
	}
	completeRestore(lock);
	// signal again: with the marker gone, every thread's rescan reloads the restored database
	await signalling.signalSchemaChange(new SchemaEventMsg(process.pid, OPERATIONS_ENUM.RESTORE_BACKUP, databaseName));
	return { database: databaseName, backup_id: backupId };
}

// After the close broadcast is acknowledged, every worker thread has released its Harper-managed
// handles; a short grace period covers a just-finished job worker still draining its own close.
// Anything still open past that is a handle Harper neither tracks nor controls (a loaded component
// holding its own instance, or the system database), which will never close on its own — so fail
// fast rather than waiting out a long timeout.
const DATABASE_CLOSE_WAIT_MS = 3000;
const DATABASE_CLOSE_POLL_INTERVAL_MS = 250;

/**
 * Verify no thread in this process still has the database open (rocksdb-js's registry is
 * process-global across worker threads), polling briefly to let a just-finished job worker's own
 * close drain. Throws 409 with an actionable message if handles remain — which means a loaded
 * component is holding the database open (Harper can neither detect which component nor force its
 * handle closed), so an online in-place restore is not possible and the offline CLI is the path.
 */
async function verifyDatabaseClosed(databaseDir: string, databaseName: string): Promise<void> {
	const targetPath = resolve(databaseDir);
	const deadline = Date.now() + DATABASE_CLOSE_WAIT_MS;
	for (;;) {
		const stillOpen = registryStatus().some(
			(instance) => resolve(instance.path) === targetPath && instance.refCount > 0
		);
		if (!stillOpen) return;
		if (Date.now() >= deadline) {
			throw new BackupInProgressError(
				`Cannot restore database '${databaseName}' while Harper is running: it is held open by a loaded component (or is the system database). ` +
					`Restore it offline instead — stop the server and run: harper restore_backup database=${databaseName}` +
					(databaseName === 'system' ? '' : ` backup_id=<id>`)
			);
		}
		await delay(DATABASE_CLOSE_POLL_INTERVAL_MS);
	}
}

/**
 * beginRestore's own error message carries the filesystem path (useful in CLI/server logs);
 * client-facing operations report by database name instead.
 */
function beginRestoreForDatabase(databaseDir: string, databaseName: string): RestoreLock {
	try {
		return beginRestore(databaseDir);
	} catch (error) {
		if (error.statusCode === 409) {
			throw new BackupInProgressError(`Restore already in progress for database '${databaseName}'`);
		}
		throw error;
	}
}

/**
 * Recognize RocksDB's own on-disk `LOCK`-file contention error. The pinned rocksdb-js 2.5.0 binding
 * surfaces it as a plain `Error` with no `code` and a message like
 * `IO error: While lock file: <db>/LOCK: Resource temporarily unavailable`, so string-matching is
 * the only signal available (there is no typed error to key on — a native primitive is a rocksdb-js
 * follow-on). We match conservatively and fail *closed* on a hit so the offline restore never purges
 * a database another process still has open.
 */
function isRocksDbLockError(error: any): boolean {
	const message = typeof error?.message === 'string' ? error.message : '';
	return (
		/lock file:/i.test(message) ||
		message.includes('LOCK:') ||
		message.includes('Resource temporarily unavailable') ||
		message.includes('is locked')
	);
}

// --- get_backup (RocksDB path): stream a fresh full-snapshot tar in the HTTP response ---

/**
 * Returns a Readable (with `.headers`) streaming a full-snapshot tar (optionally gzipped) of the
 * database's current state. No scratch disk; a consumer error aborts the native backup cleanly.
 * `noCompression` opts out of serverHandlers' accept-encoding auto-gzip — this response must never
 * be compressed by the server.
 *
 * With blobs included (the default; `excludeBlobs` opts out), the database's file-backed blob roots
 * are appended to the same archive under `blobs/<rootIndex>/<relpath>` so a downloaded backup is a
 * complete Harper database. Blob capture is best-effort point-in-time (the archive contains whatever
 * files exist while it streams); a blob deleted mid-stream is skipped.
 */
export function createBackupStream(
	rootStore: RocksDatabase,
	databaseName: string,
	gzip: boolean,
	excludeBlobs = false
): PassThrough {
	const stream: any = new PassThrough();
	// database names may legally contain `"` and `\` (schemaRegex) — sanitize so the quoted
	// content-disposition filename stays parseable
	const filename = `${databaseName.replace(/["\\]/g, '_')}.tar${gzip ? '.gz' : ''}`;
	stream.headers = new Map([
		['content-type', gzip ? 'application/gzip' : 'application/x-tar'],
		['content-disposition', `attachment; filename="${filename}"`],
	]);
	stream.noCompression = true;
	if (excludeBlobs) {
		// engine-only: the binding produces (and gzips) the whole archive directly
		rootStore
			.backup(Writable.toWeb(stream) as any, { gzip, transactionLogs: true })
			.catch((error) => stream.destroy(error));
		return stream;
	}
	streamBackupWithBlobs(rootStore, databaseName, gzip, stream).catch((error) => {
		// the consumer aborting (destroying the response) is the common case, not an error to re-raise
		if (!stream.destroyed) stream.destroy(error);
	});
	return stream;
}

// The native streaming backup finalizes its tar with exactly two zero-filled 512-byte blocks (the
// USTAR end-of-archive marker). To append blob entries into the same archive we drop that trailer
// from the native tar and let tar-stream write the single real end-of-archive marker after the blob
// entries.
const TAR_TRAILER_BYTES = 1024;

/**
 * Stream a full-snapshot tar of the database followed by its blob roots as one archive. The native
 * (plain) tar is streamed with its end-of-archive trailer stripped, blob files are appended as
 * `blobs/<rootIndex>/<relpath>` entries via tar-stream, and the combined plain tar is gzipped here
 * when requested (the binding is asked for a plain tar so we can append before compressing).
 */
async function streamBackupWithBlobs(
	rootStore: RocksDatabase,
	databaseName: string,
	gzip: boolean,
	out: PassThrough
): Promise<void> {
	const plain = new PassThrough(); // the combined, uncompressed tar
	const nativeTar = new PassThrough(); // native (plain) tar, before its trailer is stripped
	// consumer side: gzip the combined archive (or pass it through) into the response stream
	const consumed = gzip ? pipeline(plain, createGzip(), out) : pipeline(plain, out);
	// producer side: native plain tar → nativeTar, copied into `plain` minus its trailer
	const nativeDone = rootStore.backup(Writable.toWeb(nativeTar) as any, { gzip: false, transactionLogs: true });
	// A consumer that aborts (destroys `out`) rejects `consumed` before we reach the `await` below, so
	// attach silent observers now to close the unhandled-rejection window; the awaits/allSettled still
	// see the rejection and drive the real teardown.
	consumed.catch(() => {});
	nativeDone.catch(() => {});
	try {
		await copyDroppingTarTrailer(nativeTar, plain);
		await nativeDone; // surface any native backup error before we append blobs

		const pack = tarPack();
		const packed = pipeline(pack, plain); // ends `plain` once the blob entries + trailer are written
		const blobRoots = getBlobPathsForDatabaseName(databaseName);
		await appendBlobEntries(pack, blobRoots);
		// generate the same self-documenting READMEs a managed backup writes to disk, on the fly
		await addTextEntry(pack, 'README.md', streamedBackupReadme(databaseName));
		await addTextEntry(pack, 'blobs/README.md', blobsReadmeContent(blobRoots, { archive: true }));
		pack.finalize();
		await packed;
		await consumed;
	} catch (error) {
		// Tear down both pipelines and observe every side promise so a consumer abort (or any mid-
		// stream failure) can never leave an unhandled rejection from `consumed`/`nativeDone`.
		if (!nativeTar.destroyed) nativeTar.destroy();
		if (!plain.destroyed) plain.destroy(error as Error);
		await Promise.allSettled([consumed, nativeDone]);
		throw error;
	}
}

/**
 * Copy `src` into `dest` (without ending `dest`) while withholding the final {@link TAR_TRAILER_BYTES}
 * bytes — the native tar's end-of-archive marker — so more entries can be appended. Verifies the
 * withheld bytes are the expected all-zero trailer so a format change in the binding fails loudly
 * rather than producing a silently-corrupt archive.
 */
async function copyDroppingTarTrailer(src: PassThrough, dest: PassThrough): Promise<void> {
	let tail: Buffer = Buffer.alloc(0);
	for await (const chunk of src) {
		tail = tail.length === 0 ? (chunk as Buffer) : Buffer.concat([tail, chunk as Buffer]);
		if (tail.length > TAR_TRAILER_BYTES) {
			const emit = tail.subarray(0, tail.length - TAR_TRAILER_BYTES);
			tail = Buffer.from(tail.subarray(tail.length - TAR_TRAILER_BYTES));
			await writeWithBackpressure(dest, emit as Buffer);
		}
	}
	if (tail.length !== TAR_TRAILER_BYTES || tail.some((byte) => byte !== 0)) {
		throw new Error(
			`Unexpected trailer from native backup stream (expected ${TAR_TRAILER_BYTES} zero bytes, got ${tail.length}); cannot append blobs`
		);
	}
}

/** Write to a stream, awaiting `drain` on backpressure and rejecting (rather than hanging) on error. */
function writeWithBackpressure(dest: PassThrough, chunk: Buffer): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		if (dest.write(chunk)) return resolvePromise();
		const cleanup = () => {
			dest.off('drain', onDrain);
			dest.off('error', onError);
		};
		const onDrain = () => {
			cleanup();
			resolvePromise();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		dest.once('drain', onDrain);
		dest.once('error', onError);
	});
}

/**
 * Append every blob file under the given blob roots to `pack` as `blobs/<rootIndex>/<relpath>`
 * entries. Size is captured at open time and exactly that many bytes are streamed; a file that
 * vanished before it could be opened (a concurrent blob delete) is skipped.
 */
async function appendBlobEntries(pack: Pack, blobRoots: string[]): Promise<void> {
	for (let index = 0; index < blobRoots.length; index++) {
		const root = blobRoots[index];
		if (!existsSync(root)) continue;
		const stack: string[] = [root];
		while (stack.length > 0) {
			const dir = stack.pop() as string;
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (error: any) {
				if (error.code === 'ENOENT') continue;
				throw error;
			}
			for (const entry of entries) {
				const filePath = join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(filePath);
				} else if (entry.isFile()) {
					// tar entry names are always POSIX-separated; relative() yields `\` on Windows, which
					// would otherwise become literal filename characters when extracted on POSIX
					const relativePath = relative(root, filePath).split(sep).join('/');
					await appendBlobEntry(pack, filePath, `blobs/${index}/${relativePath}`);
				}
			}
		}
	}
}

/**
 * Add one blob to the pack, applying the same capture rule as the managed snapshot
 * (`classifyBlobFileForCapture`): a blob still being written would otherwise be archived truncated,
 * so it is packed as a PENDING marker, which also keeps its file id reserved on extraction.
 */
async function appendBlobEntry(pack: Pack, filePath: string, name: string): Promise<void> {
	let disposition: BlobCaptureDisposition;
	try {
		disposition = await classifyBlobFileForCapture(filePath);
	} catch (error) {
		if (isSystemicIoError(error)) throw error;
		// As on the snapshot path: a read failure is not evidence the bytes are bad, so fall back to the
		// pre-classification behavior rather than downgrading a valid blob to a stub.
		logger.warn(`Could not verify blob ${filePath} for the backup archive; packing it unverified`, error);
		disposition = 'capture';
	}
	if (disposition === 'skip') return;
	if (disposition === 'capture') {
		if (await appendBlobFile(pack, filePath, name)) return;
		disposition = 'gone';
	}
	const marker = createCaptureMarker(
		disposition,
		disposition === 'gone'
			? 'blob was deleted while this archive was being built'
			: 'blob was not yet complete when this archive was built'
	);
	await new Promise<void>((resolvePromise, reject) => {
		const entry = pack.entry({ name, size: marker.length }, (error) => (error ? reject(error) : resolvePromise()));
		entry.end(marker);
	});
}

/**
 * Add a single file to the pack, streaming exactly the byte count captured at open time. Returns false
 * if it vanished first, so the caller can still reserve its id.
 */
async function appendBlobFile(pack: Pack, filePath: string, name: string): Promise<boolean> {
	let handle;
	try {
		handle = await open(filePath, 'r');
	} catch (error: any) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
	try {
		const { size } = await handle.stat();
		await new Promise<void>((resolvePromise, reject) => {
			const entry = pack.entry({ name, size }, (error) => (error ? reject(error) : resolvePromise()));
			if (size === 0) {
				entry.end();
				return;
			}
			// stream exactly the bytes present at open time (end is inclusive); pin the fd open
			// (autoClose:false) since the finally below closes the handle
			const source = createReadStream('', { fd: handle!.fd, autoClose: false, start: 0, end: size - 1 });
			source.on('error', (error) => entry.destroy(error));
			source.pipe(entry);
		});
	} finally {
		await handle.close();
	}
	return true;
}

/** Add an in-memory string to the pack as a single tar entry (used for the generated READMEs). */
async function addTextEntry(pack: Pack, name: string, content: string): Promise<void> {
	const buffer = Buffer.from(content, 'utf8');
	await new Promise<void>((resolvePromise, reject) => {
		const entry = pack.entry({ name, size: buffer.length }, (error) => (error ? reject(error) : resolvePromise()));
		entry.end(buffer);
	});
}

/**
 * The top-level `README.md` embedded in a downloaded `get_backup` archive. Unlike a managed backup
 * repository (which is restored in place via `restore_backup`), this is a raw snapshot tar restored
 * by extracting its files back into the database directory and blob roots.
 */
function streamedBackupReadme(databaseName: string): string {
	return `# Harper backup archive — database "${databaseName}"

A full point-in-time snapshot of the "${databaseName}" database, produced by \`get_backup\`:
  - the RocksDB data and manifest at the archive root (CURRENT, MANIFEST-*, *.sst, OPTIONS-*)
  - transaction_logs/ — the transaction log snapshot
  - blobs/ — the database's file-backed blobs, unless this archive was created with exclude_blobs
    (see blobs/README.md for the layout and the root-index mapping)

## Restoring

This is a raw snapshot archive, not a managed backup repository. To restore it, stop Harper and lay
the files back down in two places:
  1. The RocksDB files — everything except blobs/ — go into the database's directory
     (typically <rootPath>/database/${databaseName}).
  2. Each blobs/<rootIndex>/ tree goes into the matching blob root — the index maps to
     storage.blobPaths[n], or <rootPath>/blobs/${databaseName} when blobPaths is not configured
     (see blobs/README.md). Then start Harper.

For a server-managed, in-place restore instead, use the managed backup workflow (create_backup /
restore_backup): https://docs.harperdb.io/reference/v5/operations-api/operations
`;
}

// --- offline CLI paths (server stopped) ---

/**
 * Offline create: open the RocksDatabase directly, run an ordinary incremental directory backup
 * into the configured backup root, and close. RocksDB is single-writer, so this collides on the
 * database lock if the server is running — callers guard on the server being stopped.
 */
export async function createBackupOffline(databaseName: string, excludeBlobs = false) {
	validateDatabaseName(databaseName);
	const databaseDir = resolveDatabasePath(databaseName);
	if (!existsSync(join(databaseDir, 'CURRENT'))) {
		throw new BackupNotFoundError(`No RocksDB database found at ${databaseDir}`);
	}
	const restoreState = checkRestoreState(databaseDir);
	if (restoreState !== 'clear') {
		throw new BackupInProgressError(
			`Database '${databaseName}' has an ${restoreState === 'in-progress' ? 'active' : 'incomplete'} restore; rerun restore_backup before backing up`
		);
	}
	const database = RocksDatabase.open(databaseDir);
	try {
		const backupDir = backupDirForDatabase(databaseName);
		let backupId;
		try {
			backupId = await database.backup(backupDir, { transactionLogs: true });
		} catch (error) {
			throw mapLockedError(error, databaseName);
		}
		await finalizeBackup(backupDir, backupId, databaseName, !excludeBlobs);
		await writeBackupReadme(backupDir, databaseName);
		return {
			database: databaseName,
			backup_id: backupId,
			blobs: !excludeBlobs,
			...(await describeBackup(backupDir, backupId)),
		};
	} finally {
		database.close();
	}
}

/**
 * Offline restore (required for the `system` database; works for any database). Runs the same
 * lock + marker protocol as the online operation so a crashed CLI restore is detected at next
 * server start. `targetDatabase` restores into a different database directory (non-destructive
 * for the source database); the server picks it up on next start via normal engine detection.
 */
export async function restoreBackupOffline(databaseName: string, backupId?: number, targetDatabase?: string) {
	validateDatabaseName(databaseName);
	const backupDir = backupDirForDatabase(databaseName);
	// resolve to the latest complete backup (or the requested id, rejected if incomplete)
	const resolved = await resolveCompleteBackup(backupDir, backupId, databaseName);
	backupId = resolved.backupId;
	const manifest = resolved.manifest;
	if (targetDatabase !== undefined) validateDatabaseName(targetDatabase);
	const databaseDir = resolveDatabasePath(targetDatabase ?? databaseName);
	if (targetDatabase !== undefined && targetDatabase !== databaseName && !isMissingOrEmptyDir(databaseDir)) {
		// target_database is documented as non-destructive: never purge an existing database of
		// that name out from under the operator
		throw new ClientError(
			`target_database '${targetDatabase}' already exists at ${databaseDir}; restoring into it would destroy it — choose a new name, or restore in place by omitting target_database`
		);
	}
	// reject a backup with more blob roots than the target's current config before anything
	// destructive (records persist their root index, so collapsing would mis-address blobs)
	await assertBlobSnapshotRestorable(backupDir, backupId, getBlobPathsForDatabaseName(targetDatabase ?? databaseName));
	// Take the restore lock + marker BEFORE probing so a server that starts after this point sees the
	// marker and refuses to load the database (closing the window between the probe and the purge).
	const lock = beginRestoreForDatabase(databaseDir, targetDatabase ?? databaseName);
	let destructionStarted = false;
	try {
		// The offline path is entered only when the CLI sees no running server (getHdbPid), but that is
		// a heuristic: the PID file is briefly absent mid-`harper restart`, and backups.restore's
		// purgeAllFiles never takes RocksDB's own lock. Probe that lock by opening the database — a live
		// holder makes open throw its LOCK-file error (isRocksDbLockError) — so we fail closed rather
		// than purge a database another process still has open. A directory that fails to open for any
		// *other* reason (corrupt or half-restored) is exactly what restore recovers, so only a lock
		// conflict aborts.
		if (existsSync(join(databaseDir, 'CURRENT'))) {
			let handle: RocksDatabase | undefined;
			try {
				handle = RocksDatabase.open(databaseDir);
			} catch (error: any) {
				if (isRocksDbLockError(error)) {
					throw new BackupInProgressError(
						`Cannot restore database '${databaseName}': it is open by a running Harper process — stop Harper before restoring offline`
					);
				}
				// otherwise corrupt/half-restored — fall through and let restore recover it
			}
			handle?.close();
		}
		destructionStarted = true;
		await backups.restore(backupDir, databaseDir, { backupId, mode: 'purgeAllFiles' });
		// restore blobs only for a backup that captured them (per the manifest, not snapshot presence)
		if (manifest.blobs) {
			await restoreBlobSnapshot(
				backupDir,
				backupId,
				databaseName,
				getBlobPathsForDatabaseName(targetDatabase ?? databaseName)
			);
		}
	} catch (error: any) {
		// Preserve the marker on a destructive failure or a recovery over a pre-existing marker (see
		// the online restoreBackup for the rationale); otherwise clear the fresh marker so an intact,
		// merely-locked database is not left flagged as an incomplete restore.
		if (destructionStarted || lock.preexisting) abandonRestore(lock);
		else completeRestore(lock);
		// preserve typed client errors (e.g. the 409 lock probe) unwrapped; only wrap an opaque restore
		// failure after destruction has begun
		if (destructionStarted && !(error instanceof ClientError)) {
			throw new Error(
				`Restore of database '${databaseName}' from backup ${backupId} failed (rerun restore_backup to recover): ${error.message}`,
				{ cause: error }
			);
		}
		throw error;
	}
	completeRestore(lock);
	return { database: databaseName, backup_id: backupId, restored_to: databaseDir };
}

function isMissingOrEmptyDir(path: string): boolean {
	try {
		return readdirSync(path).length === 0;
	} catch (error) {
		if (error.code === 'ENOENT') return true;
		throw error;
	}
}

// --- offline management wrappers (no engine validation: they operate on the directory only) ---

export async function listBackupsOffline(databaseName: string) {
	validateDatabaseName(databaseName);
	// map to the same snake_case response shape as the online list_backups operation
	return (await listCompleteBackups(backupDirForDatabase(databaseName))).map((backup) =>
		toBackupResponse(backup, backup.blobs)
	);
}

export async function verifyBackupOffline(databaseName: string, backupId: number, verifyChecksum?: boolean) {
	validateDatabaseName(databaseName);
	const verifyWithChecksum = requireBooleanOption(verifyChecksum, 'verify_checksum');
	const backupDir = backupDirForDatabase(databaseName);
	await findBackup(backupDir, backupId, databaseName);
	const manifest = await requireBackupComplete(backupDir, backupId, databaseName);
	await backups.verify(backupDir, backupId, { verifyWithChecksum });
	if (manifest.blobs && !existsSync(blobSnapshotDir(backupDir, backupId))) {
		throw new ClientError(
			`Backup ${backupId} of database '${databaseName}' declares captured blobs but its blob snapshot is missing (corrupt backup)`
		);
	}
	return { database: databaseName, backup_id: backupId, ok: true, blobs: manifest.blobs };
}

export async function deleteBackupOffline(databaseName: string, backupId: number) {
	validateDatabaseName(databaseName);
	const backupDir = backupDirForDatabase(databaseName);
	await findBackup(backupDir, backupId, databaseName);
	try {
		await backups.delete(backupDir, backupId);
	} catch (error) {
		throw mapLockedError(error, databaseName);
	}
	await deleteBlobSnapshot(backupDir, backupId);
	await deleteBackupManifest(backupDir, backupId);
	return { ok: true };
}

export async function purgeBackupsOffline(databaseName: string, keepCount: number) {
	validateDatabaseName(databaseName);
	if (!Number.isSafeInteger(keepCount) || keepCount < 0) {
		throw new ClientError(`'keep_count' must be a non-negative integer`);
	}
	const backupDir = backupDirForDatabase(databaseName);
	const before = await listBackupsInDir(backupDir);
	if (before.length === 0) {
		throw new BackupNotFoundError(`No backups found for database '${databaseName}'`);
	}
	try {
		await backups.purge(backupDir, keepCount);
	} catch (error) {
		throw mapLockedError(error, databaseName);
	}
	const remainingBackups = await listBackupsInDir(backupDir);
	const keepIds = new Set(remainingBackups.map((backup) => backup.backupId));
	await purgeBlobSnapshots(backupDir, keepIds);
	await purgeBackupManifests(backupDir, keepIds);
	return { deleted: Math.max(0, before.length - remainingBackups.length), remaining: remainingBackups.length };
}
