'use strict';

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { RocksDatabase, backups, registryStatus, type BackupInfo } from '@harperfast/rocksdb-js';
import { getDatabases, resolveDatabasePath } from '../resources/databases.ts';
import { getHdbBasePath } from '../utility/environment/environmentManager.ts';
import { getConfigPath } from '../config/configUtils.ts';
import { getBackupDirPath } from '../config/configHelpers.ts';
import { CONFIG_PARAMS, OPERATIONS_ENUM } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as signalling from '../utility/signalling.ts';
import { SchemaEventMsg } from '../server/threads/itc.js';
import { beginRestore, completeRestore, abandonRestore, checkRestoreState } from './restoreMarker.ts';
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
 */
function toBackupResponse(info: BackupInfo): {
	backup_id: number;
	timestamp: number;
	size: number;
	file_count: number;
} {
	return { backup_id: info.backupId, timestamp: info.timestamp, size: info.size, file_count: info.numberFiles };
}

// --- synchronous operations ---

export async function listBackups(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.LIST_BACKUPS);
	const databaseName = getDatabaseName(request);
	logger.info(`Listing backups for database '${databaseName}'`);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.LIST_BACKUPS);
	return (await listBackupsInDir(backupDirForDatabase(databaseName))).map(toBackupResponse);
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
	const remaining = (await listBackupsInDir(backupDir)).length;
	// clamp: a concurrent create between the two lists can otherwise make this negative
	return { deleted: Math.max(0, before.length - remaining), remaining };
}

// --- job operations: create_backup / verify_backup / restore_backup ---
// Each has a synchronous-validation function (run by jobs.addJob before the job record is
// created) and the job function itself (run in the job worker thread).

export async function validateCreateBackup(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.CREATE_BACKUP);
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.CREATE_BACKUP);
}

export async function createBackup(request: any) {
	const databaseName = getDatabaseName(request);
	const rootStore = requireRocksRootStore(databaseName, OPERATIONS_ENUM.CREATE_BACKUP);
	const backupDir = backupDirForDatabase(databaseName);
	let backupId;
	try {
		backupId = await rootStore.backup(backupDir, { transactionLogs: true });
	} catch (error) {
		throw mapLockedError(error, databaseName);
	}
	return { database: databaseName, backup_id: backupId, ...(await describeBackup(backupDir, backupId)) };
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

export async function validateVerifyBackup(request: any) {
	requireSuperUser(request, OPERATIONS_ENUM.VERIFY_BACKUP);
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.VERIFY_BACKUP);
	requireBooleanOption(request.verify_checksum, 'verify_checksum');
	await findBackup(backupDirForDatabase(databaseName), requireBackupId(request.backup_id), databaseName);
}

export async function verifyBackup(request: any) {
	const databaseName = getDatabaseName(request);
	requireRocksRootStore(databaseName, OPERATIONS_ENUM.VERIFY_BACKUP);
	const backupId = requireBackupId(request.backup_id);
	const verifyWithChecksum = requireBooleanOption(request.verify_checksum, 'verify_checksum');
	const backupDir = backupDirForDatabase(databaseName);
	await findBackup(backupDir, backupId, databaseName);
	await backups.verify(backupDir, backupId, { verifyWithChecksum });
	return { database: databaseName, backup_id: backupId, ok: true };
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
		await findBackup(backupDir, requireBackupId(request.backup_id), databaseName);
	} else if ((await listBackupsInDir(backupDir)).length === 0) {
		throw new BackupNotFoundError(`No backups found for database '${databaseName}'`);
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
	const available = await listBackupsInDir(backupDir);
	if (available.length === 0) {
		throw new BackupNotFoundError(`No backups found for database '${databaseName}'`);
	}
	let backupId;
	if (request.backup_id !== undefined) {
		backupId = requireBackupId(request.backup_id);
		await findBackup(backupDir, backupId, databaseName);
	} else {
		backupId = available.reduce((latest, backup) => Math.max(latest, backup.backupId), 0);
	}
	// a loaded database *with tables* knows its real directory via its root store (which can differ
	// from the computed default, e.g. legacy layouts); fall back to the computed path when the
	// database is unloaded (recovering an interrupted restore) or empty (no table to resolve a root
	// store from — Object.keys skips the DEFINED_TABLES symbol)
	const loaded = getDatabases()[databaseName];
	const databaseDir =
		loaded != null && Object.keys(loaded).length > 0
			? requireRocksRootStore(databaseName, OPERATIONS_ENUM.RESTORE_BACKUP).path
			: resolveDatabasePath(databaseName);
	const lockToken = beginRestoreForDatabase(databaseDir, databaseName);
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
	} catch (error: any) {
		if (destructionStarted) {
			// leave the marker: startup/rescan detection reports the incomplete restore until a rerun succeeds
			abandonRestore(lockToken);
			// wrap rather than mutate error.message: a frozen/library error can have a non-writable
			// message (assigning it throws TypeError under 'use strict')
			throw new Error(
				`Restore of database '${databaseName}' from backup ${backupId} failed (rerun restore_backup to recover): ${error.message}`,
				{ cause: error }
			);
		}
		// nothing destructive happened — clear the marker and let every thread reload the intact database
		completeRestore(databaseDir, lockToken);
		await signalling.signalSchemaChange(new SchemaEventMsg(process.pid, OPERATIONS_ENUM.RESTORE_BACKUP, databaseName));
		throw error;
	}
	completeRestore(databaseDir, lockToken);
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
function beginRestoreForDatabase(databaseDir: string, databaseName: string): number {
	try {
		return beginRestore(databaseDir);
	} catch (error) {
		if (error.statusCode === 409) {
			throw new BackupInProgressError(`Restore already in progress for database '${databaseName}'`);
		}
		throw error;
	}
}

// --- get_backup (RocksDB path): stream a fresh full-snapshot tar in the HTTP response ---

/**
 * Returns a Readable (with `.headers`) streaming a full-snapshot tar (optionally gzipped) of the
 * database's current state. No scratch disk; a consumer error aborts the native backup cleanly.
 * `noCompression` opts out of serverHandlers' accept-encoding auto-gzip — the binding handles
 * gzip when requested, and this response must never be compressed by the server.
 */
export function createBackupStream(rootStore: RocksDatabase, databaseName: string, gzip: boolean): PassThrough {
	const stream: any = new PassThrough();
	// database names may legally contain `"` and `\` (schemaRegex) — sanitize so the quoted
	// content-disposition filename stays parseable
	const filename = `${databaseName.replace(/["\\]/g, '_')}.tar${gzip ? '.gz' : ''}`;
	stream.headers = new Map([
		['content-type', gzip ? 'application/gzip' : 'application/x-tar'],
		['content-disposition', `attachment; filename="${filename}"`],
	]);
	stream.noCompression = true;
	rootStore
		.backup(Writable.toWeb(stream) as any, { gzip, transactionLogs: true })
		.catch((error) => stream.destroy(error));
	return stream;
}

// --- offline CLI paths (server stopped) ---

/**
 * Offline create: open the RocksDatabase directly, run an ordinary incremental directory backup
 * into the configured backup root, and close. RocksDB is single-writer, so this collides on the
 * database lock if the server is running — callers guard on the server being stopped.
 */
export async function createBackupOffline(databaseName: string) {
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
		return { database: databaseName, backup_id: backupId, ...(await describeBackup(backupDir, backupId)) };
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
	const available = await listBackupsInDir(backupDir);
	if (available.length === 0) {
		throw new BackupNotFoundError(`No backups found for database '${databaseName}'`);
	}
	if (backupId !== undefined) {
		await findBackup(backupDir, backupId, databaseName);
	} else {
		backupId = available.reduce((latest, backup) => Math.max(latest, backup.backupId), 0);
	}
	if (targetDatabase !== undefined) validateDatabaseName(targetDatabase);
	const databaseDir = resolveDatabasePath(targetDatabase ?? databaseName);
	if (targetDatabase !== undefined && targetDatabase !== databaseName && !isMissingOrEmptyDir(databaseDir)) {
		// target_database is documented as non-destructive: never purge an existing database of
		// that name out from under the operator
		throw new ClientError(
			`target_database '${targetDatabase}' already exists at ${databaseDir}; restoring into it would destroy it — choose a new name, or restore in place by omitting target_database`
		);
	}
	// The offline path is entered only when the CLI sees no running server (getHdbPid), but that is
	// a heuristic: the PID file is briefly absent mid-`harper restart`, and backups.restore's
	// purgeAllFiles never takes RocksDB's own lock. Probe that lock by opening the database — a live
	// holder makes open throw "is locked" — so we refuse rather than purge a database another
	// process still has open. A directory that fails to open for any *other* reason (corrupt or
	// half-restored) is exactly what restore recovers, so only a lock conflict aborts.
	if (existsSync(join(databaseDir, 'CURRENT'))) {
		try {
			RocksDatabase.open(databaseDir).close();
		} catch (error: any) {
			if (typeof error?.message === 'string' && error.message.includes('is locked')) {
				throw new BackupInProgressError(
					`Cannot restore database '${databaseName}': it is open by a running Harper process — stop Harper before restoring offline`
				);
			}
		}
	}
	const lockToken = beginRestoreForDatabase(databaseDir, targetDatabase ?? databaseName);
	try {
		await backups.restore(backupDir, databaseDir, { backupId, mode: 'purgeAllFiles' });
	} catch (error: any) {
		abandonRestore(lockToken);
		// wrap rather than mutate error.message (a frozen/library error's message may be non-writable)
		throw new Error(
			`Restore of database '${databaseName}' from backup ${backupId} failed (rerun restore_backup to recover): ${error.message}`,
			{ cause: error }
		);
	}
	completeRestore(databaseDir, lockToken);
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
	return (await listBackupsInDir(backupDirForDatabase(databaseName))).map(toBackupResponse);
}

export async function verifyBackupOffline(databaseName: string, backupId: number, verifyChecksum?: boolean) {
	validateDatabaseName(databaseName);
	const verifyWithChecksum = requireBooleanOption(verifyChecksum, 'verify_checksum');
	const backupDir = backupDirForDatabase(databaseName);
	await findBackup(backupDir, backupId, databaseName);
	await backups.verify(backupDir, backupId, { verifyWithChecksum });
	return { database: databaseName, backup_id: backupId, ok: true };
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
	const remaining = (await listBackupsInDir(backupDir)).length;
	return { deleted: Math.max(0, before.length - remaining), remaining };
}
