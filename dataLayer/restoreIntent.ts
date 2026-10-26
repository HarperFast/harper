/**
 * The restart route of restore_backup: a database a component holds cannot be closed online, so the
 * request records a durable intent (an `on_restart` receipt), the process drains and restarts, and the
 * startup hook — before any component, worker or plugin exists — applies, proves and publishes it
 * through the same child and receipt states every other route uses. A failed attempt never exits:
 * the database stays blocked, and the next restart (or `resume`) retries until the attempt limit
 * moves the intent to `terminal`, which starts that boot in safe mode. See dataLayer/DESIGN.md.
 */
import { loadRuntimeModule } from '../utility/packageUtils.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import logger from '../utility/logging/harper_logger.ts';
import { databaseRoots, resetDatabases } from '../resources/databases.ts';
import { getBlobPathsForDatabaseName } from '../resources/blob.ts';
import { getStorageSpaceStats } from '../server/storageReclamation.ts';
import { DeferredJobCompletion } from '../server/jobs/deferredJobCompletion.ts';
import {
	acquireMembershipFence,
	assertNoReplicationPeers,
	listReplicationPeers,
} from '../server/replicationMembership.ts';
import { pinBackup, unpinBackup, withBackupRepositoryLock } from './backupRepository.ts';
import { readAllManifests, readBackupManifest } from './backupManifest.ts';
import { assertBlobSnapshotRestorable, assertEngineOnlyRestoreAllowed } from './blobBackup.ts';
import {
	RESTORE_META_DIR,
	acquireRestoreLock,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreMarkerPresent,
	restoreSourceId,
	type RestoreLock,
} from './restoreMarker.ts';
import {
	RESTORE_RECEIPT_SUFFIX,
	newRestoreReceipt,
	readRestoreReceipt,
	readRestoreReceiptFile,
	removeRestoreReceipt,
	removeUnreadableRestoreReceipt,
	writeRestoreReceipt,
	type RestoreReceipt,
	type RestoreReceiptRead,
} from './restoreReceipt.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import type { RestoreEvidence } from './restoreChildCommands.ts';
import {
	finishCommittedRestore,
	finishOutstandingRestore,
	releaseReceiptPins,
	preRestorePinId,
	settleRestoreJob,
} from './restorePublication.ts';
import { listBackupsInDir, resolveCompleteBackup, restorePinId } from './rocksdbBackup.ts';

export const RESTORE_INTENT_OWNER = 'restore-intent';
// room beyond the live size, since a backup also writes its transaction logs and blob snapshot
const PRE_RESTORE_SPACE_MARGIN = 1.1;

export interface ScannedReceipt {
	file: string;
	read: RestoreReceiptRead;
}

/** Every restore receipt under every database root, read from the files alone. */
export function scanRestoreReceipts(roots: string[] = databaseRoots()): ScannedReceipt[] {
	const scanned: ScannedReceipt[] = [];
	for (const root of roots) {
		const metaDir = join(root, RESTORE_META_DIR);
		if (!existsSync(metaDir)) continue;
		for (const name of readdirSync(metaDir)) {
			if (!name.endsWith(RESTORE_RECEIPT_SUFFIX)) continue;
			const file = join(metaDir, name);
			scanned.push({ file, read: readRestoreReceiptFile(file) });
		}
	}
	return scanned;
}

export function terminalRestoreExists(roots?: string[]): boolean {
	return scanRestoreReceipts(roots).some(({ read }) => read.kind === 'valid' && read.receipt.state === 'terminal');
}

function directorySize(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const entryPath = join(path, entry.name);
		if (entry.isDirectory()) total += directorySize(entryPath);
		else if (entry.isFile()) total += statSync(entryPath).size;
	}
	return total;
}

async function assertRoomForPreRestoreBackup(databaseName: string, databaseDir: string, backupDir: string) {
	if (!existsSync(databaseDir)) return;
	const needed = Math.ceil(directorySize(databaseDir) * PRE_RESTORE_SPACE_MARGIN);
	const { available } = await getStorageSpaceStats(existsSync(backupDir) ? backupDir : databaseDir);
	if (available < needed) {
		throw new ClientError(
			`Not enough space to keep a pre-restore backup of '${databaseName}' (${needed} bytes needed, ${available} available); free space or pass retain_previous=false`,
			507
		);
	}
}

function claimTarget(databaseName: string, databaseDir: string): RestoreLock {
	try {
		return acquireRestoreLock(databaseDir);
	} catch (error: any) {
		if (error.statusCode === 409) {
			throw new ClientError(`Cannot reserve database '${databaseName}' for a restart restore: ${error.message}`, 409);
		}
		throw error;
	}
}

function requestDrainedRestart(): void {
	// required lazily: bin/restart pulls in the thread fabric, which a CLI or test caller may not have
	const { restart } = loadRuntimeModule('bin/restart');
	restart({ operation: 'restart', drain: true }).catch((error: unknown) =>
		logger.error('Could not restart Harper for the pending restore', error)
	);
}

function deferredUntilRestart(receipt: RestoreReceipt, message: string): DeferredJobCompletion {
	return new DeferredJobCompletion(
		RESTORE_INTENT_OWNER,
		message,
		{ database: receipt.database, backup_id: receipt.backup_id, operation_id: receipt.operation_id },
		requestDrainedRestart
	);
}

export interface RestartRestoreRequest {
	databaseName: string;
	databaseDir: string;
	backupDir: string;
	requestedBackupId?: number;
	allowEngineOnly: boolean;
	acceptIncompatible: boolean;
	acceptUnverifiedBlobs: boolean;
	retainPrevious: boolean;
	jobId?: string;
	requestedBy?: string;
}

/**
 * `restore_backup on_restart=true`: records the intent and asks for a drained restart. A new
 * `backup_id` while a restart restore is still pending supersedes it — the rollback path, since a
 * blocked database cannot take a fresh pre-restore backup, so none is taken.
 */
export async function requestRestartRestore(request: RestartRestoreRequest): Promise<DeferredJobCompletion> {
	const { databaseName, databaseDir, backupDir } = request;
	await finishOutstandingRestore(databaseDir);
	const releaseMembership = await acquireMembershipFence();
	let receipt!: RestoreReceipt;
	let superseded: RestoreReceipt | undefined;
	try {
		assertNoReplicationPeers(databaseName);
		if (request.retainPrevious) await assertRoomForPreRestoreBackup(databaseName, databaseDir, backupDir);
		await withBackupRepositoryLock(backupDir, databaseName, async () => {
			const selected = await resolveCompleteBackup(
				backupDir,
				request.requestedBackupId,
				databaseName,
				request.acceptIncompatible
			);
			await assertBlobSnapshotRestorable(backupDir, selected.backupId, getBlobPathsForDatabaseName(databaseName));
			assertEngineOnlyRestoreAllowed(databaseName, {
				backupHasBlobs: selected.manifest.blobs,
				allowEngineOnly: request.allowEngineOnly,
			});
			const lock = claimTarget(databaseName, databaseDir);
			try {
				const existing = readRestoreReceipt(databaseDir);
				if (existing.kind === 'unreadable') {
					throw new ClientError(
						`Database '${databaseName}' has a restore record that cannot be read (${existing.reason}); remove it with cancel=true first`,
						409
					);
				}
				if (existing.kind === 'valid') {
					if (existing.receipt.state === 'committed') {
						throw new ClientError(`Database '${databaseName}' is finishing an earlier restore; retry shortly`, 409);
					}
					if (existing.receipt.route === 'on_restart') superseded = existing.receipt;
				}
				// a restore that did not finish, or no database at all, leaves no generation to keep
				const nothingToRetain = restoreMarkerPresent(databaseDir) || !existsSync(join(databaseDir, 'CURRENT'));
				const planned = newRestoreReceipt({
					route: 'on_restart',
					state: 'pending',
					database: databaseName,
					database_path: databaseDir,
					source_database: databaseName,
					backup_dir: backupDir,
					backup_id: selected.backupId,
					job_id: request.jobId,
					requested_by: request.requestedBy,
					retain_previous: superseded || nothingToRetain ? false : request.retainPrevious,
					superseded_from: superseded?.operation_id,
					pre_restore_backup_id: superseded?.pre_restore_backup_id,
					pre_restore_pin_id: superseded?.pre_restore_pin_id,
					expected_tables: selected.manifest.tables,
					options: {
						accept_unverified_blobs: request.acceptUnverifiedBlobs,
						allow_engine_only: request.allowEngineOnly,
						accept_incompatible_backup: request.acceptIncompatible,
					},
				});
				const sourcePinId = `restore-intent-${planned.operation_id}`;
				planned.source_pin_id = sourcePinId;
				// its own pin first, then the receipt that names it, and only then the superseded one's release:
				// a crash at any point leaves every receipt that exists with its source pinned
				pinBackup(
					backupDir,
					sourcePinId,
					selected.backupId,
					`restart restore of database '${databaseName}'`,
					databaseDir
				);
				receipt = writeRestoreReceipt(lock, planned);
				if (superseded) {
					const supersededPinId = superseded.source_pin_id ?? restorePinId(databaseDir);
					try {
						if (supersededPinId !== sourcePinId) unpinBackup(backupDir, supersededPinId);
					} catch (error) {
						// once no receipt or marker names the database the pin lapses on its own
						logger.warn(`Could not release the pin of superseded restore ${superseded.operation_id}`, error);
					}
				}
			} finally {
				releaseRestoreLock(lock);
			}
		});
	} finally {
		releaseMembership();
	}
	if (superseded?.job_id && superseded.job_id !== request.jobId) {
		await settleRestoreJob(
			superseded,
			hdbTerms.JOB_STATUS_ENUM.ERROR,
			`Superseded by job ${request.jobId ?? receipt.operation_id}`
		).catch((error) => logger.error(`Could not settle superseded restore job ${superseded!.job_id}`, error));
	}
	return deferredUntilRestart(
		receipt,
		`Restore of database '${databaseName}' from backup ${receipt.backup_id} runs at the next startup; restarting now`
	);
}

export async function resumeRestartRestore(
	databaseName: string,
	databaseDir: string,
	jobId?: string
): Promise<DeferredJobCompletion> {
	const lock = claimTarget(databaseName, databaseDir);
	let receipt: RestoreReceipt;
	let previous: RestoreReceipt;
	try {
		const read = readRestoreReceipt(databaseDir);
		if (read.kind !== 'valid' || read.receipt.route !== 'on_restart' || read.receipt.state === 'committed') {
			throw new ClientError(`Database '${databaseName}' has no pending restart restore to resume`, 404);
		}
		previous = read.receipt;
		receipt = writeRestoreReceipt(lock, {
			...previous,
			state: previous.state === 'terminal' ? (previous.pre_terminal_state ?? 'pending') : previous.state,
			pre_terminal_state: undefined,
			attempts: 0,
			last_error: undefined,
			job_id: jobId ?? previous.job_id,
		});
	} finally {
		releaseRestoreLock(lock);
	}
	if (previous.job_id && previous.job_id !== jobId && previous.state !== 'terminal') {
		await settleRestoreJob(previous, hdbTerms.JOB_STATUS_ENUM.ERROR, `Continued as job ${jobId}`).catch((error) =>
			logger.error(`Could not settle resumed restore job ${previous.job_id}`, error)
		);
	}
	return deferredUntilRestart(receipt, `Restore of database '${databaseName}' resumes at the next startup`);
}

export async function cancelRestartRestore(databaseName: string, databaseDir: string) {
	const lock = claimTarget(databaseName, databaseDir);
	let cancelled: RestoreReceipt | undefined;
	try {
		const read = readRestoreReceipt(databaseDir);
		if (read.kind === 'absent') {
			throw new ClientError(`Database '${databaseName}' has no restore to cancel`, 404);
		}
		if (read.kind === 'unreadable') {
			removeUnreadableRestoreReceipt(lock);
		} else {
			if (read.receipt.state === 'committed') {
				throw new ClientError(
					`The restore of '${databaseName}' has already been applied and is being finished; it cannot be cancelled`,
					409
				);
			}
			cancelled = read.receipt;
			// a target this restore began replacing stays blocked by its marker, and its source and its
			// rollback copy stay pinned with it: the pins name the database, so they lapse with the marker
			if (!restoreMarkerPresent(databaseDir)) releaseReceiptPins(cancelled);
			removeRestoreReceipt(lock, cancelled.operation_id);
		}
	} finally {
		releaseRestoreLock(lock);
	}
	if (cancelled?.job_id && cancelled.state !== 'terminal') {
		await settleRestoreJob(cancelled, hdbTerms.JOB_STATUS_ENUM.ERROR, 'Cancelled').catch((error) =>
			logger.error(`Could not settle cancelled restore job ${cancelled!.job_id}`, error)
		);
	}
	const stillBlocked = restoreMarkerPresent(databaseDir);
	return {
		database: databaseName,
		cancelled: cancelled?.operation_id ?? 'unreadable restore record',
		still_blocked: stillBlocked,
		message: stillBlocked
			? `The restore was cancelled, but it had already begun replacing '${databaseName}', which stays unloadable until a restore succeeds`
			: `The restore was cancelled before anything was replaced; '${databaseName}' loads normally`,
	};
}

/**
 * Finishes committed receipts that need nothing but files — no job row to settle — before anything
 * opens a database. An offline restore of `system` that committed and then crashed would otherwise
 * leave startup refusing a `system` it cannot load.
 */
export async function finishCommittedRestoresBeforeStartup(roots?: string[]): Promise<void> {
	for (const { read } of scanRestoreReceipts(roots)) {
		if (read.kind !== 'valid') continue;
		try {
			if (read.receipt.state === 'committed' && !read.receipt.job_id) await finishWithLock(read.receipt);
			else if (claimAbandonedBeforeDestruction(read.receipt)) dropAbandonedClaim(read.receipt);
		} catch (error) {
			logger.error(`Could not settle the restore record of '${read.receipt.database}' before startup`, error);
		}
	}
}

/**
 * An online or offline restore whose process died before its child announced the purge: the marker is
 * published before anything is destroyed, so with none present the database was never touched, and its
 * receipt must not keep it reserved. A restart restore's receipt is its intent, and is never dropped.
 */
function claimAbandonedBeforeDestruction(receipt: RestoreReceipt): boolean {
	return receipt.route !== 'on_restart' && receipt.state === 'applying' && !restoreMarkerPresent(receipt.database_path);
}

function dropAbandonedClaim(receipt: RestoreReceipt): boolean {
	let lock: RestoreLock;
	try {
		lock = acquireRestoreLock(receipt.database_path);
	} catch {
		return false; // held: a restore is running, so this is not an abandoned claim
	}
	try {
		const again = readRestoreReceipt(receipt.database_path);
		if (
			again.kind !== 'valid' ||
			again.receipt.operation_id !== receipt.operation_id ||
			!claimAbandonedBeforeDestruction(again.receipt)
		)
			return false;
		removeRestoreReceipt(lock, receipt.operation_id);
		releaseReceiptPins(receipt);
		logger.warn(
			`Dropped the claim of a restore of '${receipt.database}' that stopped before replacing anything; the database loads as it was`
		);
		return true;
	} finally {
		releaseRestoreLock(lock);
	}
}

async function finishWithLock(receipt: RestoreReceipt): Promise<void> {
	const lock = acquireRestoreLock(receipt.database_path);
	try {
		const again = readRestoreReceipt(receipt.database_path);
		if (
			again.kind === 'valid' &&
			again.receipt.operation_id === receipt.operation_id &&
			again.receipt.state === 'committed'
		) {
			await finishCommittedRestore(lock, again.receipt);
		}
	} finally {
		releaseRestoreLock(lock);
	}
}

let startupRecoveryRan = false;

export function resetStartupRecoveryForTesting(): void {
	startupRecoveryRan = false;
}

/**
 * Startup only, once per process: `loadRootComponents` also runs on every worker-replacing reload,
 * while the old workers still hold the databases. Returns the job ids still owned by a receipt, for
 * the interrupted-job sweep to leave alone.
 */
export async function recoverRestoresAtStartup(): Promise<Set<string>> {
	const owned = new Set<string>();
	if (startupRecoveryRan) return owned;
	startupRecoveryRan = true;
	let published = false;
	for (const { file, read } of scanRestoreReceipts()) {
		if (read.kind === 'absent') continue;
		if (read.kind === 'unreadable') {
			logger.error(`Restore record ${file} cannot be read (${read.reason}); its database stays unloaded`);
			continue;
		}
		const receipt = read.receipt;
		try {
			if (receipt.state === 'committed') {
				await finishWithLock(receipt);
				published = true;
			} else if (receipt.route === 'on_restart' && receipt.state !== 'terminal') {
				if (await runRestartAttempt(receipt)) published = true;
				else if (receipt.job_id) owned.add(receipt.job_id);
			} else if (claimAbandonedBeforeDestruction(receipt) && dropAbandonedClaim(receipt)) {
				// the pre-startup pass can find the lock still held by an exiting predecessor or orphaned child
				published = true;
			}
		} catch (error) {
			logger.error(`Could not recover the restore of '${receipt.database}'`, error);
			if (receipt.job_id && receipt.route === 'on_restart') owned.add(receipt.job_id);
			// a failure after its commit may already have published; rescanning a still-blocked name is harmless
			published = true;
		}
	}
	if (published) resetDatabases();
	return owned;
}

async function adoptOrTakePreRestoreBackup(lock: RestoreLock, receipt: RestoreReceipt): Promise<RestoreReceipt> {
	let backupId: number | undefined;
	if (receipt.pre_restore_started_at !== undefined) {
		for (const [id, manifest] of await readAllManifests(receipt.backup_dir)) {
			if (manifest.pre_restore_for === receipt.operation_id) backupId = id;
		}
	} else {
		receipt = writeRestoreReceipt(lock, { ...receipt, pre_restore_started_at: Date.now() });
	}
	if (backupId === undefined) {
		({ backupId } = await runRestoreChild<{ backupId: number }>(
			'pre-restore-backup',
			{
				databaseName: receipt.database,
				databasePath: receipt.database_path,
				backupDir: receipt.backup_dir,
				operationId: receipt.operation_id,
			},
			{
				databasePath: receipt.database_path,
				receipt: {
					databasePath: receipt.database_path,
					operationId: receipt.operation_id,
					attempt: receipt.attempts,
					state: 'pending',
				},
			}
		));
	}
	const pinId = preRestorePinId(receipt.operation_id);
	await withBackupRepositoryLock(receipt.backup_dir, receipt.database, async () => {
		// deletable until it is pinned, so the pin and the check that it still exists are one step
		const engineBackupListed = (await listBackupsInDir(receipt.backup_dir)).some(
			(backup) => backup.backupId === backupId
		);
		if (!engineBackupListed || !(await readBackupManifest(receipt.backup_dir, backupId!))) {
			throw new Error(
				`The pre-restore backup ${backupId} of '${receipt.database}' was removed before it could be pinned`
			);
		}
		pinBackup(
			receipt.backup_dir,
			pinId,
			backupId!,
			`rollback copy for the restore of '${receipt.database}'`,
			receipt.database_path
		);
	});
	return writeRestoreReceipt(lock, { ...receipt, pre_restore_backup_id: backupId, pre_restore_pin_id: pinId });
}

async function failAttempt(lock: RestoreLock, receipt: RestoreReceipt, reason: string, terminal: boolean) {
	const failed = writeRestoreReceipt(lock, {
		...receipt,
		last_error: reason,
		...(terminal ? { state: 'terminal' as const, pre_terminal_state: receipt.state as 'pending' | 'applying' } : {}),
	});
	if (terminal) {
		// the rest of this boot starts in safe mode, as a terminal intent found at its start would
		process.env.HARPER_SAFE_MODE ||= 'restore-terminal';
		logger.error(
			`The restart restore of '${receipt.database}' cannot finish (${reason}); starting in safe mode. Use restore_backup resume=true, a different backup_id with on_restart=true, or cancel=true.`
		);
		if (failed.job_id) await settleRestoreJob(failed, hdbTerms.JOB_STATUS_ENUM.ERROR).catch(() => {});
	} else {
		logger.error(
			`Attempt ${receipt.attempts} of ${receipt.max_attempts} to restore '${receipt.database}' failed (${reason}); it stays unloaded and retries at the next restart`
		);
	}
}

/** One attempt at a pending restart restore. Returns whether it published; never throws past a failure. */
async function runRestartAttempt(found: RestoreReceipt): Promise<boolean> {
	const lock = acquireRestoreLock(found.database_path);
	lock.source = restoreSourceId(found.backup_dir);
	let receipt: RestoreReceipt;
	try {
		receipt = writeRestoreReceipt(lock, { ...found, attempts: found.attempts + 1 });
	} catch (error) {
		releaseRestoreLock(lock);
		throw error;
	}
	let committed = false;
	try {
		const peers = listReplicationPeers();
		if (peers.length > 0) {
			await failAttempt(lock, receipt, `this node has replication peers: ${peers.join(', ')}`, true);
			return false;
		}
		if (
			receipt.state === 'pending' &&
			receipt.retain_previous &&
			!receipt.superseded_from &&
			receipt.pre_restore_backup_id === undefined
		) {
			receipt = await adoptOrTakePreRestoreBackup(lock, receipt);
		}
		const { manifest } = await resolveCompleteBackup(
			receipt.backup_dir,
			receipt.backup_id,
			receipt.source_database,
			receipt.options.accept_incompatible_backup
		);
		const interrupted = restoreMarkerPresent(receipt.database_path);
		receipt = writeRestoreReceipt(lock, { ...receipt, state: 'applying' });
		const evidence = await runRestoreChild<RestoreEvidence>(
			'apply-and-prove',
			{
				databaseName: receipt.database,
				sourceDatabase: receipt.source_database,
				databasePath: receipt.database_path,
				backupDir: receipt.backup_dir,
				backupId: receipt.backup_id,
				manifest,
				blobRoots: getBlobPathsForDatabaseName(receipt.database),
				probe: false,
				interrupted,
				expectedTables: receipt.expected_tables,
				acceptUnverifiedBlobs: receipt.options.accept_unverified_blobs,
			},
			{
				databasePath: receipt.database_path,
				receipt: { databasePath: receipt.database_path, operationId: receipt.operation_id, attempt: receipt.attempts },
				beforeDestruction: () => markRestoreDestructive(lock),
			}
		);
		receipt = writeRestoreReceipt(lock, { ...receipt, state: 'committed', evidence: { ...evidence } });
		committed = true;
		await finishCommittedRestore(lock, receipt);
		logger.notify?.(`Restored database '${receipt.database}' from backup ${receipt.backup_id} at startup`);
		return true;
	} catch (error: any) {
		// Past the commit only bookkeeping failed, which the next startup finishes: counted as an attempt, it
		// could turn a published restore terminal and fail its job.
		if (committed) {
			throw new Error(
				`Restored database '${receipt.database}' from backup ${receipt.backup_id}, but could not finish its record; the next startup finishes it`,
				{ cause: error }
			);
		}
		await failAttempt(lock, receipt, error?.message ?? String(error), receipt.attempts >= receipt.max_attempts);
		return false;
	} finally {
		releaseRestoreLock(lock);
	}
}
