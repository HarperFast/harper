/**
 * The restart route of restore_backup: a database a component holds cannot be closed online, so the
 * request records a `pending` receipt, the process drains and restarts, and the startup hook — before
 * any component, worker or plugin exists — applies, proves and publishes it through the same steps
 * every other route uses. A failed attempt never exits: the database stays blocked, and the next
 * restart (or `resume`) retries until the attempt limit moves the receipt to `terminal`. See
 * dataLayer/DESIGN.md.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import logger from '../utility/logging/harper_logger.ts';
import { loadRuntimeModule } from '../utility/packageUtils.js';
import { getBlobPathsForDatabaseName } from '../resources/blob.ts';
import { getStorageSpaceStats } from '../server/storageReclamation.ts';
import { DeferredJobCompletion, JobCompletion } from '../server/jobs/deferredJobCompletion.ts';
import { acquireMembershipFence, assertNoReplicationPeers } from '../server/replicationMembership.ts';
import { pinBackup, readBackupPins, withBackupRepositoryLock } from './backupRepository.ts';
import { readAllManifests, readBackupManifest } from './backupManifest.ts';
import { assertBlobSnapshotRestorable, assertEngineOnlyRestoreAllowed, nearestExistingAncestor } from './blobBackup.ts';
import {
	acquireRestoreLock,
	databaseDropMarkerPresent,
	releaseRestoreLock,
	restoreMarkerPresent,
	restoreSourceId,
	type RestoreLock,
} from './restoreMarker.ts';
import {
	DEFAULT_RESTORE_MAX_ATTEMPTS,
	describeRestoreSource,
	newRestoreReceipt,
	readRestoreReceipt,
	removeRestoreReceipt,
	removeUnreadableRestoreReceipt,
	writeRestoreReceipt,
	type RestoreReceipt,
	type RestoreReceiptRead,
} from './restoreReceipt.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import {
	applyProveAndCommit,
	finishCommittedRestore,
	finishOutstandingRestore,
	releaseReceiptPins,
	restoreHeldAtBoot,
	settleRestoreJob,
} from './restorePublication.ts';
import {
	acquireRestoreLockFor,
	isRocksDbLockError,
	listBackupsInDir,
	resolveCompleteBackup,
	restorePinId,
	restoreSourceHint,
} from './rocksdbBackup.ts';

const RESTORE_INTENT_OWNER = 'restore-intent';
// room beyond the live size, since a backup also writes its transaction logs and blob snapshot
const PRE_RESTORE_SPACE_MARGIN = 1.1;
const WITHDRAW_CLAIM_TIMEOUT_MS = 10_000;
const WITHDRAW_CLAIM_POLL_MS = 100;

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

function preRestorePinId(operationId: string): string {
	return `pre-restore-${operationId}`;
}

// the database is open and written while it is measured, so an entry can vanish between listing and stat
function ignoringVanished<T>(read: () => T, vanished: T): T {
	try {
		return read();
	} catch (error: any) {
		if (error?.code === 'ENOENT') return vanished;
		throw error;
	}
}

function directorySize(path: string): number {
	let total = 0;
	for (const entry of ignoringVanished(() => readdirSync(path, { withFileTypes: true }), [])) {
		const entryPath = join(path, entry.name);
		if (entry.isDirectory()) total += directorySize(entryPath);
		else if (entry.isFile()) total += ignoringVanished(() => statSync(entryPath).size, 0);
	}
	return total;
}

function existingSelfOrAncestor(path: string): string {
	return existsSync(path) ? path : nearestExistingAncestor(path);
}

function deviceOf(path: string): number {
	return statSync(existingSelfOrAncestor(path)).dev;
}

async function assertRoomForPreRestoreBackup(databaseName: string, databaseDir: string, backupDir: string) {
	if (!existsSync(databaseDir)) return;
	// the blob snapshot hard-links on the repository's device and copies everywhere else
	const repositoryDevice = deviceOf(backupDir);
	const copiedBlobs = getBlobPathsForDatabaseName(databaseName)
		.filter((root) => existsSync(root) && deviceOf(root) !== repositoryDevice)
		.reduce((total, root) => total + directorySize(root), 0);
	const needed = Math.ceil((directorySize(databaseDir) + copiedBlobs) * PRE_RESTORE_SPACE_MARGIN);
	const { available } = await getStorageSpaceStats(existingSelfOrAncestor(backupDir));
	if (available < needed) {
		throw new ClientError(
			`Not enough space to keep a pre-restore backup of '${databaseName}' (${needed} bytes needed, ${available} available); free space or pass retain_previous=false`,
			507
		);
	}
}

function claimTarget(databaseName: string, databaseDir: string): RestoreLock {
	const lock = acquireRestoreLockFor(databaseName, databaseDir);
	// as claimRestore refuses: a drop that has begun owns the directory until it finishes
	if (databaseDropMarkerPresent(databaseDir)) {
		releaseRestoreLock(lock);
		throw new ClientError(`Database '${databaseName}' has an incomplete drop; retry drop_database first`, 409);
	}
	return lock;
}

export function requestDrainedRestart(): void {
	// required lazily: bin/restart pulls in the thread fabric, which a CLI or test caller may not have
	const { restart } = loadRuntimeModule('bin/restart');
	restart({ operation: 'restart', drain: true }).catch((error: unknown) =>
		logger.error('Could not restart Harper for the pending restore', error)
	);
}

/**
 * A receipt write takes effect at its rename, before the directory flush that can still throw, so after a throw
 * the record on disk, read under the lock the caller holds, decides whether it was written.
 */
function writeReceiptReconciled(lock: RestoreLock, receipt: RestoreReceipt): RestoreReceipt {
	try {
		return writeRestoreReceipt(lock, receipt);
	} catch (error) {
		const read = readRestoreReceipt(lock.dbPath);
		// as the write stores it: its own updated_at, and no undefined fields
		const intended = { ...JSON.parse(JSON.stringify(receipt)), updated_at: 0 };
		if (read.kind !== 'valid' || !isDeepStrictEqual({ ...read.receipt, updated_at: 0 }, intended)) throw error;
		logger.error(
			`The restore record of '${receipt.database}' was written, but could not be confirmed durable; a power loss before it is flushed can undo it`,
			error
		);
		return read.receipt;
	}
}

/**
 * A removal takes effect at its unlink, before the directory flush that can still throw: with the record gone, the
 * caller carries on as after a clean removal.
 */
function removeReceiptReconciled(lock: RestoreLock, databaseName: string, remove: () => void): void {
	try {
		remove();
	} catch (error) {
		if (readRestoreReceipt(lock.dbPath).kind !== 'absent') throw error;
		logger.error(
			`The restore record of '${databaseName}' was removed, but the removal could not be confirmed durable; if a power loss brings it back, withdraw it again with restore_backup cancel=true`,
			error
		);
	}
}

function deferredUntilRestart(receipt: RestoreReceipt, message: string): DeferredJobCompletion {
	return new DeferredJobCompletion(
		RESTORE_INTENT_OWNER,
		message,
		{ database: receipt.database, backup_id: receipt.backup_id, operation_id: receipt.operation_id },
		requestDrainedRestart,
		() => withdrawUnrecordedRestore(receipt)
	);
}

/** Opens and pin-liveness probes hold the lock shared for a moment, so a claim that must not be skipped waits. */
async function acquireRestoreLockWaiting(databaseDir: string): Promise<RestoreLock> {
	const deadline = Date.now() + WITHDRAW_CLAIM_TIMEOUT_MS;
	for (;;) {
		try {
			return acquireRestoreLock(databaseDir);
		} catch (error: any) {
			if (error.statusCode !== 409 || Date.now() >= deadline) throw error;
		}
		await delay(WITHDRAW_CLAIM_POLL_MS);
	}
}

/**
 * The job row could not record the deferral, so the job will read as failed: a receipt still pending
 * would run the restore at some later, unrelated restart. Withdrawn only while it is still this
 * operation's and this job's (a resume keeps the operation and takes the job), and nothing has started.
 */
async function withdrawUnrecordedRestore(receipt: RestoreReceipt): Promise<void> {
	let unblocked = false;
	try {
		const lock = await acquireRestoreLockWaiting(receipt.database_path);
		try {
			const read = readRestoreReceipt(receipt.database_path);
			if (
				read.kind !== 'valid' ||
				read.receipt.operation_id !== receipt.operation_id ||
				read.receipt.job_id !== receipt.job_id ||
				read.receipt.state === 'committed'
			)
				return;
			if (restoreMarkerPresent(receipt.database_path)) {
				// an earlier attempt already began replacing the target: it stays blocked, its pins stay with it, and
				// the terminal receipt keeps components off it until a restore succeeds
				writeReceiptReconciled(lock, {
					...read.receipt,
					state: 'terminal',
					pre_terminal_state: undefined,
					last_error: 'its job could not record the restart restore',
				});
			} else {
				removeReceiptReconciled(lock, receipt.database, () => removeRestoreReceipt(lock, receipt.operation_id));
				releaseReceiptPins(read.receipt);
				unblocked = true;
			}
			logger.error(`The restart restore of '${receipt.database}' was withdrawn: its job could not record it`);
		} finally {
			releaseRestoreLock(lock);
		}
	} catch (error) {
		logger.error(
			`Could not withdraw the restart restore of '${receipt.database}' (operation ${receipt.operation_id}, job ${receipt.job_id}) after its job failed to record it; unless a later request replaced it, it runs at the next restart. Cancel it with restore_backup cancel=true`,
			error
		);
	}
	if (unblocked && restoreHeldAtBoot(receipt.database_path)) requestDrainedRestart();
}

/** The pins an earlier receipt on this target holds, which stay until this restore commits. */
function inheritedPins(backupDir: string, databaseDir: string, earlier: RestoreReceipt | undefined): string[] {
	const ids = new Set(
		[restorePinId(databaseDir), earlier?.source_pin_id, ...(earlier?.superseded_pin_ids ?? [])].filter(Boolean)
	);
	return readBackupPins(backupDir)
		.filter((pin) => ids.has(pin.pin_id))
		.map((pin) => pin.pin_id);
}

/** Read without the lock, so only a hint, which is enough for the advisory space check. */
function inheritsRollbackCopy(databaseDir: string): boolean {
	const read = readRestoreReceipt(databaseDir);
	return (
		read.kind === 'valid' && read.receipt.route === 'on_restart' && read.receipt.pre_restore_backup_id !== undefined
	);
}

/**
 * Once its target began being replaced, a terminal placeholder replaces the unreadable record in one write, never
 * after an unlink: a bare marker blocks only its own database, and a component that opens it itself ignores that.
 */
function cancelUnreadableRestore(lock: RestoreLock, databaseName: string): void {
	if (!restoreMarkerPresent(lock.dbPath)) {
		return removeReceiptReconciled(lock, databaseName, () => removeUnreadableRestoreReceipt(lock));
	}
	writeReceiptReconciled(
		lock,
		newRestoreReceipt({
			route: 'on_restart',
			state: 'terminal',
			record_lost: true,
			database: databaseName,
			database_path: lock.dbPath,
			source_database: databaseName,
			backup_dir: '',
			backup_id: 0,
			options: {},
			last_error: 'its record could not be read, and it was cancelled after it began replacing the database',
		})
	);
}

export async function requestRestartRestore(request: RestartRestoreRequest): Promise<DeferredJobCompletion> {
	const { databaseName, databaseDir, backupDir } = request;
	await finishOutstandingRestore(databaseDir);
	const releaseMembership = await acquireMembershipFence();
	let receipt!: RestoreReceipt;
	let displaced: RestoreReceipt | undefined;
	try {
		assertNoReplicationPeers(databaseName);
		if (
			request.retainPrevious &&
			!restoreMarkerPresent(databaseDir) &&
			existsSync(join(databaseDir, 'CURRENT')) &&
			!inheritsRollbackCopy(databaseDir)
		)
			await assertRoomForPreRestoreBackup(databaseName, databaseDir, backupDir);
		await withBackupRepositoryLock(backupDir, databaseName, async () => {
			let selected: Awaited<ReturnType<typeof resolveCompleteBackup>>;
			try {
				selected = await resolveCompleteBackup(
					backupDir,
					request.requestedBackupId,
					databaseName,
					request.acceptIncompatible
				);
			} catch (error) {
				throw restoreSourceHint(error, databaseName, request.requestedBackupId);
			}
			const blobRoots = getBlobPathsForDatabaseName(databaseName);
			await assertBlobSnapshotRestorable(backupDir, selected.backupId, blobRoots);
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
				if (existing.kind === 'valid' && existing.receipt.state === 'committed') {
					throw new ClientError(`Database '${databaseName}' is finishing an earlier restore; retry shortly`, 409);
				}
				displaced = existing.kind === 'valid' ? existing.receipt : undefined;
				const earlierRestart = displaced?.route === 'on_restart' ? displaced : undefined;
				// a restore that did not finish, or no database at all, leaves no generation worth keeping
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
					max_attempts: DEFAULT_RESTORE_MAX_ATTEMPTS,
					// a supersede keeps the rollback copy it inherits instead of taking a second one; with none to
					// inherit it takes its own, so the live generation is never replaced without one by accident
					retain_previous:
						nothingToRetain || earlierRestart?.pre_restore_backup_id !== undefined ? false : request.retainPrevious,
					superseded_from: displaced?.operation_id,
					// a supersede is how an operator rolls back, so it keeps the rollback copy it inherits
					pre_restore_backup_id: earlierRestart?.pre_restore_backup_id,
					pre_restore_pin_id: earlierRestart?.pre_restore_pin_id,
					options: {
						accept_unverified_blobs: request.acceptUnverifiedBlobs,
						allow_engine_only: request.allowEngineOnly,
						accept_incompatible_backup: request.acceptIncompatible,
					},
				});
				const sourcePinId = `restore-intent-${planned.operation_id}`;
				// the displaced restore's source stays pinned until this one commits: until then it may be the
				// blocked database's only usable recovery source
				const superseded = inheritedPins(backupDir, databaseDir, displaced);
				pinBackup(
					backupDir,
					sourcePinId,
					selected.backupId,
					`restart restore of database '${databaseName}'`,
					databaseDir
				);
				receipt = writeReceiptReconciled(lock, {
					...planned,
					source_pin_id: sourcePinId,
					...(superseded.length > 0 ? { superseded_pin_ids: superseded } : {}),
				});
			} finally {
				releaseRestoreLock(lock);
			}
		});
	} finally {
		releaseMembership();
	}
	if (displaced?.job_id && displaced.job_id !== request.jobId && displaced.state !== 'terminal') {
		await settleRestoreJob(
			displaced,
			hdbTerms.JOB_STATUS_ENUM.ERROR,
			`Superseded by job ${request.jobId ?? receipt.operation_id}`
		).catch((error) => logger.error(`Could not settle superseded restore job ${displaced!.job_id}`, error));
	}
	return deferredUntilRestart(
		receipt,
		`Restore of database '${databaseName}' from ${describeRestoreSource(receipt)} runs at the next startup; restarting now`
	);
}

function resumableReceipt(databaseName: string, read: RestoreReceiptRead): RestoreReceipt {
	if (
		read.kind !== 'valid' ||
		read.receipt.route !== 'on_restart' ||
		read.receipt.state === 'committed' ||
		read.receipt.record_lost
	) {
		throw new ClientError(`Database '${databaseName}' has no pending restart restore to resume`, 404);
	}
	return read.receipt;
}

/** What cancel refuses. A record that cannot be read is cancellable: removing it is what cancel is for. */
function assertCancellable(databaseName: string, read: RestoreReceiptRead): void {
	if (read.kind === 'absent') throw new ClientError(`Database '${databaseName}' has no restore to cancel`, 404);
	if (read.kind === 'valid' && read.receipt.state === 'committed') {
		throw new ClientError(
			`The restore of '${databaseName}' has already been applied and is being finished; it cannot be cancelled`,
			409
		);
	}
}

/**
 * At submission, the refusal the job would give, read without the lock so that a name with no database
 * gets an answer and no lock file; the job checks again under the lock, since the record can change in
 * between.
 */
export function assertRestartRestoreActionable(
	databaseName: string,
	databaseDir: string,
	action: 'resume' | 'cancel'
): void {
	const read = readRestoreReceipt(databaseDir);
	if (action === 'resume') resumableReceipt(databaseName, read);
	else assertCancellable(databaseName, read);
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
		previous = resumableReceipt(databaseName, readRestoreReceipt(databaseDir));
		receipt = writeReceiptReconciled(lock, {
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

export async function cancelRestartRestore(
	databaseName: string,
	databaseDir: string,
	{ offline = false }: { offline?: boolean } = {}
) {
	const lock = claimTarget(databaseName, databaseDir);
	let cancelled: RestoreReceipt | undefined;
	let stillBlocked: boolean;
	try {
		const read = readRestoreReceipt(databaseDir);
		assertCancellable(databaseName, read);
		if (read.kind === 'valid') {
			cancelled = read.receipt;
			if (restoreMarkerPresent(databaseDir)) {
				// it began replacing the target, so the target stays blocked and its pins stay; the receipt stays
				// too, as terminal, so this boot and the next keep components off the unproved generation
				writeReceiptReconciled(lock, {
					...cancelled,
					state: 'terminal',
					pre_terminal_state: undefined,
					last_error: 'cancelled after it began replacing the database',
				});
			} else {
				// the receipt first: an unpinned source under a receipt that still schedules a restore can be purged
				removeReceiptReconciled(lock, databaseName, () => removeRestoreReceipt(lock, cancelled!.operation_id));
				releaseReceiptPins(cancelled);
			}
		} else {
			cancelUnreadableRestore(lock, databaseName);
		}
		stillBlocked = restoreMarkerPresent(databaseDir);
	} finally {
		releaseRestoreLock(lock);
	}
	if (offline) return cancelledOffline(databaseName, cancelled, stillBlocked);
	if (cancelled?.job_id && cancelled.state !== 'terminal') {
		await settleRestoreJob(cancelled, hdbTerms.JOB_STATUS_ENUM.ERROR, 'Cancelled').catch((error) =>
			logger.error(`Could not settle cancelled restore job ${cancelled!.job_id}`, error)
		);
	}
	// A boot that held the database loaded components without it, and only a restart loads them again; a
	// restore requested since this boot started was never held. An unreadable receipt cannot say.
	const restarting = !stillBlocked && (cancelled === undefined || restoreHeldAtBoot(databaseDir));
	let message: string;
	if (stillBlocked) {
		message = `The restore was cancelled, but it had already begun replacing '${databaseName}', which stays unloadable until a restore succeeds`;
	} else if (restarting) {
		message = `The restore was cancelled before anything was replaced; restarting so '${databaseName}' and the components that use it load`;
	} else {
		message = `The restore was cancelled before anything was replaced; '${databaseName}' loads normally`;
	}
	return new JobCompletion(
		{
			database: databaseName,
			cancelled: cancelled?.operation_id ?? 'unreadable restore record',
			still_blocked: stillBlocked,
			restarting,
			message,
		},
		restarting ? requestDrainedRestart : undefined
	);
}

/** With Harper stopped there is no job table to settle and nothing to restart; the next start settles the job. */
function cancelledOffline(databaseName: string, cancelled: RestoreReceipt | undefined, stillBlocked: boolean) {
	const outcome = stillBlocked
		? `The restore was cancelled, but it had already begun replacing '${databaseName}', which stays unloadable until a restore succeeds`
		: `The restore was cancelled before anything was replaced; '${databaseName}' loads when Harper starts`;
	const job =
		cancelled?.job_id && cancelled.state !== 'terminal'
			? `; its job ${cancelled.job_id} is marked failed when Harper starts`
			: '';
	return {
		database: databaseName,
		cancelled: cancelled?.operation_id ?? 'unreadable restore record',
		still_blocked: stillBlocked,
		restarting: false,
		message: outcome + job,
	};
}

/**
 * A rollback copy a child took for this operation. Its manifest is written only once the copy is durable, and
 * removed again if finishing it fails, so one the engine still lists is whole whatever the child did next.
 */
async function finishedPreRestoreBackup(receipt: RestoreReceipt): Promise<number | undefined> {
	const engineBackups = new Set((await listBackupsInDir(receipt.backup_dir)).map((backup) => backup.backupId));
	let backupId: number | undefined;
	for (const [id, manifest] of await readAllManifests(receipt.backup_dir)) {
		if (manifest.pre_restore_for === receipt.operation_id && engineBackups.has(id)) backupId = id;
	}
	return backupId;
}

async function adoptOrTakePreRestoreBackup(lock: RestoreLock, receipt: RestoreReceipt): Promise<RestoreReceipt> {
	let backupId: number | undefined;
	if (receipt.pre_restore_started_at !== undefined) {
		backupId = await finishedPreRestoreBackup(receipt);
	} else {
		receipt = writeRestoreReceipt(lock, { ...receipt, pre_restore_started_at: Date.now() });
	}
	if (backupId === undefined) {
		try {
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
		} catch (error) {
			// the runner settles only once the child has exited, so nothing still writes to a copy found here
			backupId = await finishedPreRestoreBackup(receipt).catch(() => undefined);
			if (backupId === undefined) {
				throw Object.assign(new Error(error?.message ?? String(error), { cause: error }), {
					preRestoreBackupFailed: true,
				});
			}
			logger.warn(
				`The pre-restore backup of '${receipt.database}' failed after it completed backup ${backupId}; it is kept as the rollback copy (${error?.message ?? error})`
			);
		}
	}
	const pinId = preRestorePinId(receipt.operation_id);
	await withBackupRepositoryLock(receipt.backup_dir, receipt.database, async () => {
		// deletable until it is pinned, so the pin and the check that it still exists are one step
		const listed = (await listBackupsInDir(receipt.backup_dir)).some((backup) => backup.backupId === backupId);
		if (!listed || !(await readBackupManifest(receipt.backup_dir, backupId!))) {
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
	// what this attempt already recorded (the pre-restore checkpoint) is newer than the caller's copy
	const current = readRestoreReceipt(lock.dbPath);
	if (current.kind === 'valid' && current.receipt.operation_id === receipt.operation_id) receipt = current.receipt;
	const failed = writeRestoreReceipt(lock, {
		...receipt,
		last_error: reason,
		...(terminal ? { state: 'terminal' as const, pre_terminal_state: receipt.state as 'pending' | 'applying' } : {}),
	});
	if (terminal) {
		logger.error(
			`The restart restore of '${receipt.database}' cannot finish (${reason}); starting in safe mode. Use restore_backup resume=true, a different backup_id with on_restart=true, or cancel=true.`
		);
		if (failed.job_id) {
			await settleRestoreJob(failed, hdbTerms.JOB_STATUS_ENUM.ERROR).catch((error) =>
				logger.error(`Could not settle terminal restore job ${failed.job_id}`, error)
			);
		}
	} else {
		logger.error(
			`Attempt ${receipt.attempts} of ${receipt.max_attempts ?? DEFAULT_RESTORE_MAX_ATTEMPTS} to restore '${receipt.database}' failed (${reason}); it stays unloaded and retries at the next restart`
		);
	}
}

/** One attempt at a pending restart restore, at startup. Returns whether it published; never throws past a failure. */
export async function runRestartAttempt(found: RestoreReceipt): Promise<boolean> {
	const lock = acquireRestoreLock(found.database_path);
	// the scan read the receipt before this lock, and a cancel in between (an offline one racing this
	// boot) must not be undone by writing the scanned copy back
	const current = readRestoreReceipt(found.database_path);
	if (
		current.kind !== 'valid' ||
		current.receipt.operation_id !== found.operation_id ||
		current.receipt.state === 'committed' ||
		current.receipt.state === 'terminal'
	) {
		releaseRestoreLock(lock);
		return false;
	}
	found = current.receipt;
	lock.source = restoreSourceId(found.backup_dir);
	// an attempt that killed the process never recorded its failure, so the limit is checked before
	// starting another, not only after one fails
	if (found.attempts >= (found.max_attempts ?? DEFAULT_RESTORE_MAX_ATTEMPTS)) {
		try {
			await failAttempt(lock, found, found.last_error ?? 'the previous attempt did not finish', true);
		} finally {
			releaseRestoreLock(lock);
		}
		return false;
	}
	let receipt: RestoreReceipt;
	try {
		// sampled under the lock, as claimRestore does, so a retry over a target an earlier attempt began
		// replacing is reported as such if its backup then fails verification
		lock.preexisting = restoreMarkerPresent(found.database_path);
		// counted before any native work, so an attempt that kills the process still moves toward terminal
		receipt = writeRestoreReceipt(lock, { ...found, attempts: found.attempts + 1 });
	} catch (error) {
		releaseRestoreLock(lock);
		throw error;
	}
	let releaseMembership: (() => void) | undefined;
	let committed = false;
	try {
		releaseMembership = await acquireMembershipFence();
		try {
			assertNoReplicationPeers(receipt.database);
		} catch (error: any) {
			await failAttempt(lock, receipt, error.message, true);
			return false;
		}
		if (receipt.state === 'pending' && receipt.retain_previous && receipt.pre_restore_backup_id === undefined) {
			try {
				receipt = await adoptOrTakePreRestoreBackup(lock, receipt);
			} catch (error: any) {
				// a conflict (a busy restore child slot, a held repository or engine lock) means something else holds
				// what the copy needs, which a later attempt may not find
				const cause = error?.cause ?? error;
				if (!error?.preRestoreBackupFailed || cause?.statusCode === 409 || isRocksDbLockError(cause)) throw error;
				// retrying reopens the same directory, so a database the backup cannot read stays unrestorable
				// until the operator chooses to replace it without a copy
				await failAttempt(
					lock,
					receipt,
					`could not take the pre-restore backup (${error?.message ?? error}); to replace '${receipt.database}' without a rollback copy, request it again with retain_previous=false`,
					true
				);
				return false;
			}
		}
		const blobRoots = getBlobPathsForDatabaseName(receipt.database);
		const { manifest, waived } = await resolveCompleteBackup(
			receipt.backup_dir,
			receipt.backup_id,
			receipt.source_database,
			receipt.options.accept_incompatible_backup === true
		);
		await assertBlobSnapshotRestorable(receipt.backup_dir, receipt.backup_id, blobRoots);
		receipt = writeRestoreReceipt(lock, { ...receipt, state: 'applying' });
		receipt = await applyProveAndCommit(lock, receipt, {
			manifest,
			blobRoots,
			probe: true,
			acceptUnverifiedBlobs: receipt.options.accept_unverified_blobs === true,
			waived,
			checkPeers: false,
		});
		committed = true;
		await finishCommittedRestore(lock, receipt);
		logger.notify?.(`Restored database '${receipt.database}' from ${describeRestoreSource(receipt)} at startup`);
		return true;
	} catch (error: any) {
		// past the commit only bookkeeping failed, which the next startup finishes: counted as an attempt, it
		// could turn a published restore terminal and fail its job
		if (committed) {
			throw new Error(
				`Restored database '${receipt.database}' from ${describeRestoreSource(receipt)}, but could not finish its record; the next startup finishes it`,
				{ cause: error }
			);
		}
		await failAttempt(
			lock,
			receipt,
			error?.message ?? String(error),
			receipt.attempts >= (receipt.max_attempts ?? DEFAULT_RESTORE_MAX_ATTEMPTS)
		);
		return false;
	} finally {
		releaseMembership?.();
		releaseRestoreLock(lock);
	}
}
